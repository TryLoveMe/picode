// PiCode — RPC bridge to the bundled pi coding agent CLI.
// Strict JSONL framing per pi docs: records are split on LF only (never on
// Unicode line/paragraph separators), optional CR stripped before parsing.
import { spawn, ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface RpcRecord {
  type: string;
  [k: string]: any;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
  commandType: string;
}

export class PiRpc {
  private proc: ChildProcess | null = null;
  private stdoutBuf = '';
  private decoder = new StringDecoder('utf-8');
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stderrLines: string[] = [];
  running = false;
  cwd = '';
  cliPath = '';
  sessionPath: string | null = null;

  onEvent: (r: RpcRecord) => void = () => {};
  onExtUi: (r: RpcRecord) => void = () => {};
  onStatus: (s: { state: 'starting' | 'running' | 'exited'; code?: number | null; signal?: string | null; error?: string }) => void = () => {};

  get lastStderr(): string[] {
    return this.stderrLines.slice(-50);
  }

  start(opts: {
    nodePath: string;
    cliPath: string;
    cwd: string;
    sessionPath?: string | null;
    extraArgs?: string[];
  }): void {
    this.stop();
    this.stderrLines = [];
    this.cliPath = opts.cliPath;
    this.cwd = opts.cwd;
    this.sessionPath = opts.sessionPath || null;

    const args = [opts.cliPath, '--mode', 'rpc'];
    if (opts.sessionPath) args.push('--session', opts.sessionPath);
    if (opts.extraArgs) args.push(...opts.extraArgs);

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_OPTIONS;
    env.ELECTRON_RUN_AS_NODE = '1';

    this.onStatus({ state: 'starting' });
    let proc: ChildProcess;
    try {
      proc = spawn(opts.nodePath, args, {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err: any) {
      this.onStatus({ state: 'exited', code: -1, error: String(err?.message || err) });
      return;
    }
    this.proc = proc;
    this.running = true;

    proc.on('error', (err) => {
      this.failAllPending(new Error(`pi 进程错误: ${err.message}`));
      this.running = false;
      this.onStatus({ state: 'exited', code: -1, error: err.message });
    });

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.stdoutBuf += this.decoder.write(chunk);
      let idx: number;
      while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
        let line = this.stdoutBuf.slice(0, idx);
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let record: RpcRecord;
        try {
          record = JSON.parse(line);
        } catch (e) {
          this.pushStderr(`[unparseable stdout line] ${line.slice(0, 400)}`);
          continue;
        }
        this.handleRecord(record);
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      this.decoder; // stderr decoded separately below
      const text = chunk.toString('utf-8');
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.pushStderr(line);
      }
    });

    proc.on('exit', (code, signal) => {
      // Flush any trailing partial record.
      const rest = this.stdoutBuf + this.decoder.end();
      this.stdoutBuf = '';
      const trimmed = rest.trim();
      if (trimmed) {
        try {
          this.handleRecord(JSON.parse(trimmed));
        } catch {
          /* ignore */
        }
      }
      this.running = false;
      this.proc = null;
      this.failAllPending(new Error('pi 进程已退出'));
      this.onStatus({ state: 'exited', code, signal });
    });
  }

  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.running = false;
    try {
      proc.stdin?.end(); // orderly shutdown per protocol: close stdin
    } catch {
      /* ignore */
    }
    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, 4000);
    proc.once('exit', () => clearTimeout(killer));
    this.failAllPending(new Error('pi 已停止'));
  }

  async command(cmd: RpcRecord, timeoutMs = 0): Promise<RpcRecord> {
    if (!this.proc || !this.proc.stdin?.writable) {
      throw new Error('pi 未在运行');
    }
    const id = `c${++this.seq}`;
    const record = { id, ...cmd };
    return new Promise<RpcRecord>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`命令 ${cmd.type} 超时`));
      }, timeoutMs) : null;
      if (timer) timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, commandType: String(cmd.type || '') });
      try {
        this.proc!.stdin!.write(JSON.stringify(record) + '\n');
      } catch (err: any) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error(`写入失败: ${err?.message || err}`));
      }
    });
  }

  private handleRecord(record: RpcRecord): void {
    if (record.type === 'response') {
      const id = record.id as string | undefined;
      let pendingId: string | undefined = id && this.pending.has(id) ? id : undefined;
      if (!pendingId) {
        // pi answers unknown commands with an error record that carries the
        // command type but NO id — correlate to the oldest pending command
        // of that type so the caller's promise still settles.
        const cmdType = String(record.command || '');
        for (const [pid, p] of this.pending) {
          if (p.commandType === cmdType) {
            pendingId = pid;
            break;
          }
        }
      }
      if (pendingId) {
        const p = this.pending.get(pendingId)!;
        this.pending.delete(pendingId);
        if (p.timer) clearTimeout(p.timer);
        if (record.success) p.resolve(record);
        else p.reject(new Error(record.error || `命令 ${record.command} 失败`));
      } else {
        // Unsolicited response (e.g. parse error) — surface as event.
        this.onEvent(record);
      }
      return;
    }
    if (record.type === 'extension_ui_request') {
      this.onExtUi(record);
      return;
    }
    this.onEvent(record);
  }

  respondExtUi(record: RpcRecord): void {
    if (!this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(JSON.stringify(record) + '\n');
    } catch {
      /* ignore */
    }
  }

  private pushStderr(line: string): void {
    this.stderrLines.push(line);
    if (this.stderrLines.length > 500) this.stderrLines.splice(0, this.stderrLines.length - 500);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
