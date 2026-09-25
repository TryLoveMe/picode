// Probe: run a full prompt against the mock LLM and print the RPC event sequence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'cli.js');
const PORT = 8714;

await startMockLlm(PORT);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'picode-probe-'));
const agentDir = path.join(work, 'agent');
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
  providers: { mock: { baseUrl: `http://127.0.0.1:${PORT}`, api: 'anthropic-messages', apiKey: 'mock-key', models: [{ id: 'mock-1', name: 'Mock Model 1', input: ['text'], reasoning: true, contextWindow: 100000, maxTokens: 8192 }] } },
}));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', enableInstallTelemetry: false }));

const proc = spawn(process.execPath, [CLI, '--mode', 'rpc'], { cwd: work, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'] });
const dec = new StringDecoder('utf-8');
let buf = '';
const types = [];
proc.stdout.on('data', (c) => {
  buf += dec.write(c);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'response') { console.log('RESPONSE', rec.command, rec.success, rec.error || ''); continue; }
    let detail = '';
    if (rec.type === 'message_update') detail = rec.assistantMessageEvent?.type || '';
    if (rec.type === 'message_end') detail = rec.message?.role + '/' + rec.message?.stopReason;
    if (rec.type === 'tool_execution_start') detail = rec.toolName;
    if (rec.type === 'tool_execution_end') detail = rec.toolName + ' err=' + rec.isError;
    console.log('EVENT', rec.type, detail);
    types.push(rec.type);
    if (rec.type === 'agent_settled') {
      console.log('\nGOT agent_settled ✓ — total events:', types.length);
      proc.kill();
      setTimeout(() => { fs.rmSync(work, { recursive: true, force: true }); process.exit(0); }, 300);
    }
  }
});
proc.stderr.on('data', (c) => console.error('STDERR', c.toString().trim().slice(0, 200)));
proc.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: '请读取 hello.txt 并总结' }) + '\n');
setTimeout(() => {
  console.log('\nTIMEOUT — no agent_settled. Events seen:', [...new Set(types)].join(','));
  proc.kill();
  setTimeout(() => process.exit(1), 300);
}, 25000);
