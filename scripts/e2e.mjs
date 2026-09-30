// PiCode E2E — launches the real Electron app against a scripted mock LLM,
// drives it over CDP, asserts behavior, and captures screenshots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-e2e');
const PORT = 8712;
// Escaped path of the demo MCP server, embeddable in browser-eval JS strings.
const E2E_MCP_SERVER_ESC = JSON.stringify(path.join(ROOT, 'scripts', 'demo-mcp-server.mjs')).slice(1, -1);
const CDP_PORT = 9223;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------- fixtures ----------
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picode-e2e-'));
const agentDir = path.join(workDir, 'agent');
const projectDir = path.join(workDir, 'demo-project');
const userData = path.join(workDir, 'userdata');
for (const d of [agentDir, projectDir, path.join(agentDir, 'sessions'), userData]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(path.join(projectDir, 'hello.txt'), 'hello from picode-e2e\n');
fs.writeFileSync(path.join(projectDir, 'README.md'), '# Demo Project\n\nA sample project for the PiCode E2E run.\n');
// A real pi extension: exercises get_commands (dynamic slash command) + the
// extension UI sub-protocol (confirm dialog, select dialog, notify).
fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'extensions', 'demo-dialog.js'), `export default function (pi) {
  pi.registerCommand('demo-dialog', {
    description: '演示扩展对话框与通知',
    handler: async (args, ctx) => {
      const ok = await ctx.ui.confirm('扩展确认', '这是来自 pi 扩展的确认对话框，确认后继续。');
      if (!ok) { ctx.ui.notify('已取消扩展流程', 'warning'); return; }
      const choice = await ctx.ui.select('扩展选择', ['选项 A', '选项 B']);
      ctx.ui.notify('扩展流程完成：你选择了 ' + choice, 'info');
    },
  });
}
`);
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
  providers: {
    mock: {
      baseUrl: `http://127.0.0.1:${PORT}`,
      api: 'anthropic-messages',
      apiKey: 'mock-key',
      models: [
        { id: 'mock-1', name: 'Mock Model 1', input: ['text', 'image'], reasoning: true, contextWindow: 100000, maxTokens: 8192 },
        { id: 'mock-2', name: 'Mock Model 2', input: ['text'], reasoning: false, contextWindow: 64000, maxTokens: 4096 },
      ],
    },
  },
}, null, 2));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
  defaultProvider: 'mock',
  defaultModel: 'mock-1',
  enableInstallTelemetry: false,
}, null, 2));
fs.writeFileSync(path.join(userData, 'picode-prefs.json'), JSON.stringify({ lastProject: projectDir, theme: 'dark' }));

// ---------- CDP client ----------
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
          const msg0 = JSON.parse(m.data);
          if (msg0.method === 'Runtime.consoleAPICalled') {
            const args = (msg0.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || '')).join(' ');
            if (String(args).includes('[picode]')) console.log('[console]', args);
          }
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        };
        const send = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
          });
        await send('Runtime.enable');
        await send('Page.enable');
        return { ws, send };
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('CDP 连接超时');
}

let evalSeq = 0;
async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

async function wait(cdp, expression, timeoutMs = 20000, label = expression) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v = false;
    try { v = await ev(cdp, expression); } catch { /* retry */ }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  const dump = await ev(cdp, 'document.body.innerText.slice(0, 1200)').catch(() => '(no dump)');
  throw new Error(`等待超时: ${label}\n--- 页面内容 ---\n${dump}`);
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log(`[shot] ${name}`);
}

async function typeOnly(cdp, text) {
  await ev(cdp, `(() => {
    const input = document.getElementById('composer-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

async function pressEnter(cdp) {
  await ev(cdp, `(() => {
    const input = document.getElementById('composer-input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
}

async function typeAndSend(cdp, text) {
  await typeOnly(cdp, text);
  await pressEnter(cdp);
}

async function closeAllModals(cdp) {
  await ev(cdp, `(() => {
    document.querySelectorAll('.modal-close').forEach(b => b.click());
    return document.querySelectorAll('.modal-mask').length;
  })()`);
  await new Promise((r) => setTimeout(r, 250));
}

// ---------- run ----------
const mockServer = await startMockLlm(PORT);
console.log('[mock] llm listening on', PORT);

const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const app = spawn(electronExe, [ROOT, `--remote-debugging-port=${CDP_PORT}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PICODE_USER_DATA: userData,
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appLog = '';
app.stdout.on('data', (c) => (appLog += c));
app.stderr.on('data', (c) => (appLog += c));
const appLogTail = () => appLog.split('\n').slice(-40).join('\n');

let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`[ok] ${name}`);
  } catch (e) {
    failures++;
    console.error(`[FAIL] ${name}\n${e.message}\n--- app log ---\n${appLogTail()}`);
  }
};

try {
  const cdp = await connectCdp();
  console.log('[cdp] connected');

  await step('启动后模型就绪（RPC get_state 成功）', async () => {
    await wait(cdp, `!document.getElementById('pill-model').textContent.includes('未选择模型')`, 45000, '模型 pill 出现');
  });
  await step('空状态占位可见', async () => {
    await wait(cdp, `document.getElementById('transcript').innerText.length < 400`, 15000, 'transcript 简洁');
  });
  await shot(cdp, '01-ready.png');

  await step('发送提示词 → 思考块 + 工具调用（read hello.txt）+ 流式 Markdown 回复', async () => {
    await typeAndSend(cdp, '请读取 hello.txt 并总结');
    await wait(cdp, `document.querySelector('.tool-card') !== null`, 20000, '工具卡片出现');
    await wait(cdp, `document.getElementById('transcript').innerText.includes('小结')`, 20000, '最终回复渲染');
    await wait(cdp, `!document.getElementById('stream-ind').offsetParent`, 20000, '流结束');
  });
  await step('工具卡片状态为完成', async () => {
    await wait(cdp, `[...document.querySelectorAll('.tool-card .dot')].some(d => d.className.includes('ok'))`, 10000, '工具 ok 圆点');
  });
  await ev(cdp, `window.scrollTo(0,0)`); await ev(cdp, `document.getElementById('transcript-wrap').scrollTop = document.getElementById('transcript-wrap').scrollHeight`);
  await new Promise((r) => setTimeout(r, 400));
  await shot(cdp, '02-chat.png');

  await step('输入 / 唤起指令面板（含内置与 pi 扩展指令）', async () => {
    await typeOnly(cdp, '/');
    await wait(cdp, `document.getElementById('palette').classList.contains('show')`, 8000, 'palette 显示');
    await wait(cdp, `document.querySelectorAll('#palette-list .p-item').length >= 15`, 8000, '面板条目 >= 15');
  });
  await shot(cdp, '03-palette.png');
  // clear the '/' (choose nothing)
  await typeOnly(cdp, '');

  await step('/model 打开模型选择器', async () => {
    await typeAndSend(cdp, '/model');
    await wait(cdp, `[...document.querySelectorAll('.modal .m-title')].some(n => n.textContent === '选择模型')`, 8000, '模型选择器');
    await wait(cdp, `document.querySelectorAll('.model-item').length >= 2`, 8000, '两个 mock 模型列出');
  });
  await shot(cdp, '04-model-picker.png');
  await step('切换到 mock-2 成功', async () => {
    await ev(cdp, `(() => {
      const items = [...document.querySelectorAll('.model-item')];
      const t = items.find(i => i.textContent.includes('mock-2'));
      t.click(); return 1;
    })()`);
    await wait(cdp, `document.getElementById('pill-model').textContent.includes('Mock Model 2')`, 8000, 'pill 更新');
  });
  await closeAllModals(cdp);

  await step('打开设置（左侧导航 + 右侧详情）', async () => {
    await ev(cdp, `document.getElementById('btn-settings').click(); 1`);
    await wait(cdp, `[...document.querySelectorAll('.modal .m-title')].some(n => n.textContent === '设置')`, 8000, '设置弹窗');
    await wait(cdp, `document.querySelectorAll('.st-nav-item').length >= 6`, 8000, '设置导航项');
    await wait(cdp, `!!document.querySelector('.settings-detail .st-section')`, 8000, '通用页内容');
  });
  await shot(cdp, '05-settings.png');
  await step('设置：模型页（密钥 + 模型浏览器）', async () => {
    await ev(cdp, `[...document.querySelectorAll('.st-nav-item')].find(n => n.textContent.includes('模型')).click(); 1`);
    await wait(cdp, `[...document.querySelectorAll('.settings-detail .model-item')].length > 0`, 10000, '模型列表');
    await wait(cdp, `[...document.querySelectorAll('.settings-detail .key-row')].length > 0 || document.querySelector('.settings-detail')?.innerText.includes('尚未配置')`, 8000, '密钥区');
  });
  await shot(cdp, '05b-settings-model.png');
  await step('设置：MCP 页（服务器列表 + 添加表单）', async () => {
    await ev(cdp, `[...document.querySelectorAll('.st-nav-item')].find(n => n.textContent.includes('MCP')).click(); 1`);
    await wait(cdp, `document.querySelector('.settings-detail')?.innerText.includes('MCP 扩展')`, 8000, 'MCP 页');
    await ev(cdp, `[...document.querySelectorAll('.settings-detail button')].find(b => b.textContent.includes('添加服务器')).click(); 1`);
    await wait(cdp, `!!document.querySelector('.settings-detail .st-form')`, 5000, 'MCP 表单');
    await ev(cdp, `(() => {
      const form = document.querySelector('.settings-detail .st-form');
      const inputs = form.querySelectorAll('input');
      inputs[0].value = 'demo';
      inputs[1].value = 'node';
      form.querySelector('textarea').value = '${E2E_MCP_SERVER_ESC}';
      return 1;
    })()`);
    await ev(cdp, `[...document.querySelectorAll('.settings-detail button')].find(b => b.textContent.includes('保存并重载')).click(); 1`);
    await wait(cdp, `[...document.querySelectorAll('.settings-detail .mcp-row')].some(r => r.textContent.includes('demo'))`, 8000, 'MCP 服务器行');
  });
  await shot(cdp, '05c-settings-mcp.png');
  await step('设置：技能 / 扩展 / 高级页可切换', async () => {
    for (const label of ['技能', '扩展', '高级']) {
      await ev(cdp, `[...document.querySelectorAll('.st-nav-item')].find(n => n.textContent.includes('${label}')).click(); 1`);
      await wait(cdp, `document.querySelectorAll('.settings-detail .st-section').length > 0`, 8000, label + ' 页内容');
    }
  });
  await shot(cdp, '05d-settings-skills.png');
  await closeAllModals(cdp);

  await step('! 前缀直接运行 shell 命令', async () => {
    await typeAndSend(cdp, '!echo picode-bash-ok');
    await wait(cdp, `document.getElementById('transcript').innerText.includes('picode-bash-ok')`, 25000, 'bash 输出');
    await wait(cdp, `document.getElementById('transcript').innerText.includes('exit 0')`, 15000, 'exit code');
  });
  await shot(cdp, '06-bash.png');

  await step('流式结束后运行指示消失（agent_end 空闲判定）', async () => {
    await wait(cdp, `document.getElementById('stream-ind').classList.contains('hidden')`, 15000, 'stream-ind 隐藏');
  });

  await step('思考块已渲染（可折叠）', async () => {
    await wait(cdp, `document.querySelector('.thinking') !== null`, 8000, 'thinking 块');
  });

  await step('会话用量（/session）弹窗', async () => {
    await typeAndSend(cdp, '/session');
    await wait(cdp, `[...document.querySelectorAll('.modal .m-title')].some(n => n.textContent === '会话用量')`, 8000, '用量弹窗');
  });
  await shot(cdp, '07-stats.png');
  await closeAllModals(cdp);

  await step('会话分支树（/tree）', async () => {
    await typeAndSend(cdp, '/tree');
    try {
      await wait(cdp, `[...document.querySelectorAll('.modal .m-title')].some(n => n.textContent === '会话分支树')`, 8000, '分支树弹窗');
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1200));
      const diag = await ev(cdp, `(async () => {
        const S = window.__S || {};
        const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r('TIMEOUT'), ms))]);
        let treeProbe, rpcProbe, log;
        try {
          const r = await withTimeout(window.picode.sessionsTree(S.sessionFile), 3000);
          treeProbe = typeof r === 'string' ? r : 'ok roots=' + (r.tree?.length ?? 'null') + ' leaf=' + r.leafId;
        } catch (e) { treeProbe = 'ERR ' + e.message; }
        try {
          const r = await withTimeout(window.picode.piCommand({ type: 'get_tree' }), 3000);
          rpcProbe = typeof r === 'string' ? r : 'success';
        } catch (e) { rpcProbe = 'rejected: ' + e.message; }
        try {
          log = await withTimeout(window.picode.diagLog(), 3000);
        } catch (e) { log = 'ERR ' + e.message; }
        return {
          phase: S.phase, sessionFile: S.sessionFile,
          treeProbe, rpcProbe,
          running: log?.running, stderrTail: (log?.stderr || []).slice(-3),
          statusLog: (window.__statusLog || []).slice(-6),
          toasts: [...document.querySelectorAll('.toast')].map(x => x.textContent),
          titles: [...document.querySelectorAll('.modal .m-title')].map(n => n.textContent),
        };
      })()`);
      console.log('[diag]', JSON.stringify(diag, null, 1));
      throw e;
    }
  });
  await shot(cdp, '08-tree.png');
  await closeAllModals(cdp);

  await step('pi 扩展：/demo-dialog 触发 confirm → select → notify 全链路', async () => {
    // first Enter picks the command from the palette (fills the composer),
    // second Enter executes it
    await typeOnly(cdp, '/demo-dialog');
    await pressEnter(cdp);
    await pressEnter(cdp);
    await wait(cdp, `[...document.querySelectorAll('.modal .m-title')].some(n => n.textContent === '扩展确认')`, 15000, '扩展 confirm 对话框').catch(async (e) => {
      const diag = await ev(cdp, `(async () => {
        const S = window.__S || {};
        const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r('TIMEOUT'), ms))]);
        let directProbe;
        try {
          await withTimeout(window.picode.piCommand({ type: 'prompt', message: '/demo-dialog' }), 4000);
          await new Promise(r => setTimeout(r, 1500));
          directProbe = [...document.querySelectorAll('.modal .m-title')].map(n => n.textContent);
        } catch (err) { directProbe = 'prompt ERR: ' + err.message; }
        return {
          history: S.history,
          streaming: S.streaming,
          directProbe,
          toasts: [...document.querySelectorAll('.toast')].map(x => x.textContent),
          titles: [...document.querySelectorAll('.modal .m-title')].map(n => n.textContent),
        };
      })()`);
      console.log('[ext-diag]', JSON.stringify(diag, null, 1));
      throw e;
    });
    await ev(cdp, `(() => { const btns=[...document.querySelectorAll('.modal-foot .btn')]; btns.find(b=>b.textContent==='允许').click(); return 1; })()`);
    await wait(cdp, `[...document.querySelectorAll('.modal .m-title')].some(n => n.textContent === '扩展选择')`, 8000, '扩展 select 对话框');
    await ev(cdp, `(() => { const rows=[...document.querySelectorAll('.modal .slist-item')]; rows.find(r=>r.textContent.includes('选项 A')).click(); return 1; })()`);
    await wait(cdp, `[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('扩展流程完成：你选择了 选项 A'))`, 8000, '扩展 notify toast');
  });
  await shot(cdp, '10-extension.png');
  await closeAllModals(cdp);
} catch (e) {
  failures++;
  console.error('[FATAL]', e.message, '\n--- app log ---\n' + appLogTail());
}

try { app.kill(); } catch { /* ignore */ }
mockServer.close();
for (const wait of [300, 1500, 3000]) {
  await new Promise((r) => setTimeout(r, wait));
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
    break;
  } catch { /* electron may still hold handles — retry */ }
}
console.log(failures === 0 ? '\nE2E PASS' : `\nE2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
