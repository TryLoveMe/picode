// Smoke-test the bundled pi CLI in RPC mode (protocol-level, no GUI).
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../node_modules/@mariozechner/pi-coding-agent/dist/cli.js', import.meta.url));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'picode-smoke-'));

function run(args, opts = {}) {
  const proc = spawn(process.execPath, [CLI, ...args], {
    cwd: opts.cwd || WORK,
    env: { ...process.env, PI_CODING_AGENT_DIR: opts.agentDir || path.join(WORK, 'agent') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return proc;
}

function rpcSession(proc) {
  const decoder = new StringDecoder('utf-8');
  let buf = '';
  const waiters = [];
  const events = [];
  let settled;
  proc.stdout.on('data', (chunk) => {
    buf += decoder.write(chunk);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      events.push(rec);
      if (rec.type === 'agent_settled') settled = true;
      waiters.forEach((w) => w());
    }
  });
  let stderr = '';
  proc.stderr.on('data', (c) => (stderr += c.toString()));
  const send = (cmd) => proc.stdin.write(JSON.stringify(cmd) + '\n');
  const cmd = (cmd, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const id = 'r' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => reject(new Error('timeout: ' + cmd.type)), timeoutMs);
      send({ id, ...cmd });
      const check = () => {
        const found = events.find((e) => e.type === 'response' && e.id === id);
        if (found) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(found);
        }
      };
      check();
      waiters.push(check);
    });
  const waitEvent = (type, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('event timeout: ' + type)), timeoutMs);
      const check = () => {
        const found = events.find((e) => e.type === type);
        if (found) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(found);
        }
      };
      check();
      waiters.push(check);
    });
  return { send, cmd, events, waitEvent, get stderr() { return stderr; } };
}

const results = [];
const log = (k, v) => { results.push({ k, v }); console.log(`\n=== ${k} ===`); console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2).slice(0, 4000)); };

// ---- Part 1: --no-session protocol checks ----
{
  const proc = run(['--mode', 'rpc', '--no-session']);
  const rpc = rpcSession(proc);
  try {
    const st = await rpc.cmd({ type: 'get_state' });
    log('get_state (no-session)', st.data);
    const models = await rpc.cmd({ type: 'get_available_models' });
    const list = models.data?.models || [];
    const byProvider = {};
    for (const m of list) (byProvider[m.provider] ||= []).push(m.id);
    log('get_available_models providers', { count: list.length, providers: Object.keys(byProvider).sort() });
    const cmds = await rpc.cmd({ type: 'get_commands' });
    log('get_commands', cmds.data);
    const lv = await rpc.cmd({ type: 'get_available_thinking_levels' });
    log('thinking levels', lv.data);
    const bash = await rpc.cmd({ type: 'bash', command: 'echo hello-from-pi && node -v' }, 20000);
    log('bash', bash.data?.output?.slice(0, 300));
    const err = await rpc.cmd({ type: 'set_model', provider: 'nope', modelId: 'nope' });
    log('set_model error response', err);
    const stats = await rpc.cmd({ type: 'get_session_stats' });
    log('get_session_stats', stats.data);
    // Attempt a prompt without credentials: observe the failure mode.
    rpc.send({ id: 'p1', type: 'prompt', message: 'hi' });
    await new Promise((r) => setTimeout(r, 6000));
    const seen = rpc.events.filter((e) => !['response'].includes(e.type)).map((e) => e.type);
    log('events after cred-less prompt', { types: [...new Set(seen)] });
    const lastMsg = rpc.events.filter((e) => e.type === 'message_end').at(-1);
    log('last message_end (error shape)', lastMsg?.message ? { role: lastMsg.message.role, stopReason: lastMsg.message.stopReason, errorMessage: lastMsg.message.errorMessage } : null);
  } catch (e) {
    log('PART1 ERROR', String(e.message || e) + '\nSTDERR: ' + rpc.stderr.slice(-800));
  }
  proc.kill();
}

// ---- Part 2: with session persistence — where do session files land? ----
{
  const agentDir = path.join(WORK, 'agent2');
  const proc = run(['--mode', 'rpc'], { agentDir });
  const rpc = rpcSession(proc);
  try {
    const st = await rpc.cmd({ type: 'get_state' });
    log('get_state (session) file', { sessionFile: st.data?.sessionFile, sessionId: st.data?.sessionId, name: st.data?.sessionName, model: st.data?.model ? { id: st.data.model.id, provider: st.data.model.provider } : null });
    const named = await rpc.cmd({ type: 'set_session_name', name: 'smoke-test' });
    log('set_session_name', { success: named.success });
  } catch (e) {
    log('PART2 ERROR', String(e.message || e) + '\nSTDERR: ' + rpc.stderr.slice(-800));
  }
  await new Promise((r) => setTimeout(r, 800));
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  const sessRoot = path.join(agentDir, 'sessions');
  const walk = (d, depth = 0, out = []) => {
    if (depth > 3 || !fs.existsSync(d)) return out;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1, out);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  };
  const files = walk(sessRoot);
  log('session files under agent2/sessions', files);
  if (files[0]) {
    log('session file head', fs.readFileSync(files[0], 'utf-8').split('\n').slice(0, 3).join('\n').slice(0, 1200));
  }
  log('agent dir listing', fs.existsSync(agentDir) ? fs.readdirSync(agentDir) : []);
}

// ---- Part 3: pi --list-models (provider ids) ----
{
  const proc = run(['--list-models'], { agentDir: path.join(WORK, 'agent3') });
  let out = '';
  proc.stdout.on('data', (c) => (out += c.toString()));
  await new Promise((r) => setTimeout(r, 12000));
  log('--list-models (head)', out.split('\n').slice(0, 60).join('\n'));
  try { proc.kill(); } catch {}
}

fs.rmSync(WORK, { recursive: true, force: true });
console.log('\nSMOKE DONE');
