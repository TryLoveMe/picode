// End-to-end test for the bundled MCP extension: boots the real pi CLI in RPC
// mode with the extension and a demo MCP server, then asserts that the tools
// got registered and the status file is written.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'cli.js');
const EXT = path.join(ROOT, 'build', 'mcp-extension', 'index.ts');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'picode-mcp-'));
const agentDir = path.join(work, 'agent');
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({
  mcpServers: {
    demo: { command: process.execPath, args: [path.join(ROOT, 'scripts', 'demo-mcp-server.mjs')] },
    broken: { command: process.execPath, args: ['-e', 'process.exit(1)'], enabled: true },
    off: { command: 'whatever', enabled: false },
  },
}, null, 2));

const proc = spawn(process.execPath, [CLI, '--mode', 'rpc', '--extension', EXT], {
  cwd: work,
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const decoder = new StringDecoder('utf-8');
let buf = '';
const events = [];
let stderr = '';
proc.stdout.on('data', (chunk) => {
  buf += decoder.write(chunk);
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { /* ignore */ }
  }
});
proc.stderr.on('data', (c) => (stderr += c.toString()));
proc.on('exit', (code) => {
  if (!finished) fail(`pi exited early (code ${code})\n${stderr.slice(-2000)}`);
});

function waitEvents() {
  return new Promise((r) => setTimeout(r, 250));
}

const send = (cmd) => proc.stdin.write(JSON.stringify(cmd) + '\n');
const cmd = (record, timeoutMs = 20000) =>
  new Promise((resolve, reject) => {
    const id = 't' + Math.random().toString(36).slice(2, 8);
    const timer = setTimeout(() => reject(new Error('timeout: ' + record.type)), timeoutMs);
    send({ id, ...record });
    const check = setInterval(() => {
      const found = events.find((e) => e.type === 'response' && e.id === id);
      if (found) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(found);
      }
    }, 100);
  });

let finished = false;
function fail(message) {
  console.error('FAIL:', message);
  proc.kill();
  process.exit(1);
}

async function main() {
  // The extension pushes setStatus during session_start — that's our readiness
  // signal (RPC event stream does not carry session_start).
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (events.some((e) => e.type === 'extension_ui_request' && e.method === 'setStatus' && e.statusKey === 'mcp')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!events.some((e) => e.type === 'extension_ui_request' && e.method === 'setStatus' && e.statusKey === 'mcp')) {
    fail('extension setStatus never observed\n' + stderr.slice(-2000));
  }
  await new Promise((r) => setTimeout(r, 1500));

  const cmds = await cmd({ type: 'get_commands' });
  const names = (cmds.data?.commands || []).map((c) => c.name);
  if (!names.includes('mcp')) fail('extension command /mcp not registered; got: ' + names.join(', '));
  if (!names.includes('mcp-reload')) fail('extension command /mcp-reload not registered');
  console.log('OK extension commands registered:', names.filter((n) => n.startsWith('mcp')).join(', '));

  const status = JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp-status.json'), 'utf-8'));
  console.log('status file:', JSON.stringify(status.servers.demo));
  if (status.servers.demo?.state !== 'connected') fail('demo server not connected: ' + JSON.stringify(status.servers.demo));
  if (status.servers.demo?.toolCount !== 2) fail('demo server should expose 2 tools');
  if (status.servers.off?.state !== 'disabled') fail('disabled server should show as disabled');
  if (!status.servers.broken?.error) fail('broken server should carry an error');
  console.log('OK status file correct (demo connected, off disabled, broken error)');

  const state = await cmd({ type: 'get_state' });
  console.log('OK pi is up, model:', state.data?.model?.id ?? 'unknown (no key configured, expected)');

  // Trigger extension command via RPC prompt (executes immediately, no LLM call)
  await cmd({ type: 'prompt', message: '/mcp' });
  await new Promise((r) => setTimeout(r, 800));
  const notified = events.some((e) => e.type === 'extension_ui_request' && e.method === 'notify' && String(e.message || '').includes('MCP 状态'));
  if (!notified) fail('extension notify for /mcp not observed');
  console.log('OK /mcp via RPC prompt executed and notified');

  finished = true;
  proc.kill();
  console.log('\nALL MCP EXTENSION CHECKS PASSED');
  process.exit(0);
}

main().catch((e) => fail(e.stack || String(e)));
