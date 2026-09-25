// Verify the PACKAGED PiCode.exe (what end users run after installing):
// boot against a mock LLM, send a prompt, assert the streamed reply renders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-e2e');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'PiCode.exe');
const PORT = 8716;
const CDP_PORT = 9224;

if (!fs.existsSync(EXE)) {
  console.error('找不到打包产物，请先运行 electron-builder');
  process.exit(2);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picode-pkg-'));
const agentDir = path.join(workDir, 'agent');
const projectDir = path.join(workDir, 'demo-project');
const userData = path.join(workDir, 'userdata');
for (const d of [agentDir, projectDir, userData]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'hello.txt'), 'hello from packaged picode\n');
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
  providers: { mock: { baseUrl: `http://127.0.0.1:${PORT}`, api: 'anthropic-messages', apiKey: 'mock-key', models: [{ id: 'mock-1', name: 'Mock Model 1', input: ['text'], reasoning: true, contextWindow: 100000, maxTokens: 8192 }] } },
}));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'mock', defaultModel: 'mock-1', enableInstallTelemetry: false }));
fs.writeFileSync(path.join(userData, 'picode-prefs.json'), JSON.stringify({ lastProject: projectDir, theme: 'dark' }));

await startMockLlm(PORT);
console.log('[mock] listening on', PORT);

const app = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PICODE_USER_DATA: userData },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appLog = '';
app.stdout.on('data', (c) => (appLog += c));
app.stderr.on('data', (c) => (appLog += c));

async function connectCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res2, rej2) => { ws.onopen = res2; ws.onerror = rej2; });
        let seq = 0;
        const pending = new Map();
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
          }
        };
        const send = (method, params = {}) => new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        });
        await send('Runtime.enable');
        await send('Page.enable');
        return { send };
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('CDP 连接超时');
}

const cdp = await connectCdp();
async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
async function wait(expression, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v = false;
    try { v = await ev(expression); } catch { /* retry */ }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('等待超时: ' + label);
}

let failures = 0;
const step = async (name, fn) => {
  try { await fn(); console.log('[ok] ' + name); }
  catch (e) { failures++; console.error(`[FAIL] ${name}\n${e.message}\n--- app log ---\n${appLog.split('\n').slice(-30).join('\n')}`); }
};

await step('打包版启动：模型就绪（内置 pi RPC 连通）', async () => {
  await wait(`!document.getElementById('pill-model').textContent.includes('未选择模型')`, 60000, '模型 pill');
});
await step('打包版发送提示词 → 工具调用 + 回复渲染', async () => {
  await ev(`(() => { const i = document.getElementById('composer-input'); i.value = '请读取 hello.txt 并总结'; i.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await ev(`(() => { const i = document.getElementById('composer-input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 1; })()`);
  await wait(`document.querySelector('.tool-card') !== null`, 20000, '工具卡片');
  await wait(`document.getElementById('transcript').innerText.includes('小结')`, 20000, '最终回复');
  await wait(`document.getElementById('stream-ind').classList.contains('hidden')`, 20000, '流结束');
});
await step('打包版斜杠面板可用', async () => {
  await ev(`(() => { const i = document.getElementById('composer-input'); i.value = '/'; i.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await wait(`document.getElementById('palette').classList.contains('show')`, 8000, 'palette 显示');
});
await ev(`(() => { const i = document.getElementById('composer-input'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT, '09-packaged.png'), Buffer.from(shot.data, 'base64'));
console.log('[shot] 09-packaged.png');

try { app.kill(); } catch { /* ignore */ }
for (const w of [300, 1500, 3000]) {
  await new Promise((r) => setTimeout(r, w));
  try { fs.rmSync(workDir, { recursive: true, force: true }); break; } catch { /* retry */ }
}
console.log(failures === 0 ? '\nPACKAGED APP PASS' : `\nPACKAGED APP FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
