// PiCode — renderer application. Talks to the pi RPC subprocess through the
// preload bridge and renders a Codex-style chat surface.
import { renderMarkdown, escapeText } from './markdown';

const api = (window as any).picode;

// ============================== state ==============================
const S = {
  phase: 'boot' as 'boot' | 'welcome' | 'starting' | 'ready' | 'dead',
  project: null as string | null,
  model: null as any,
  thinkingLevel: 'off' as string,
  thinkingLevels: [] as string[],
  models: [] as any[],
  defaults: {} as any,
  sessionFile: null as string | null,
  sessionName: null as string | null,
  streaming: false,
  isCompacting: false,
  autoCompaction: true,
  queue: { steering: [] as string[], followUp: [] as string[] },
  commands: [] as any[],
  stats: null as any,
  attachments: [] as { data: string; mimeType: string }[],
  history: [] as string[],
  historyIdx: -1,
  prefs: {} as any,
  appInfo: {} as any,
  extStatuses: new Map<string, string>(),
  intentionalStop: false,
  sessionItems: [] as any[],
};

// ============================== tiny dom ==============================
function el(tag: string, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) (node as any)[k.slice(2).toLowerCase()] = v;
    else if (k === 'style') node.setAttribute('style', v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return node;
}

const $ = (id: string) => document.getElementById(id)!;

function toast(message: string, type: 'info' | 'warning' | 'error' | 'success' = 'info', ms = 4200): void {
  const t = el('div', { class: `toast ${type}` }, message);
  $('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtCost(n: number | undefined): string {
  if (!n || n <= 0) return '';
  return `$${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
}

function fmtBytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function baseName(p: string | null): string {
  if (!p) return '';
  const norm = p.replace(/[\\/]+$/, '');
  const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

// ============================== rpc helpers ==============================
// Safety timeout: no UI path may wait on pi forever. compact/bash override it.
async function cmd(record: any, timeoutMs = 120000): Promise<any> {
  return (await api.piCommand({ $timeout: timeoutMs, ...record })).data;
}

async function refreshModels(): Promise<void> {
  try {
    const data = await cmd({ type: 'get_available_models' });
    S.models = data?.models || [];
  } catch {
    S.models = [];
  }
  renderModelPill();
}

async function refreshCommands(): Promise<void> {
  try {
    const data = await cmd({ type: 'get_commands' });
    S.commands = data?.commands || [];
  } catch {
    S.commands = [];
  }
}

async function refreshThinking(): Promise<void> {
  if (!S.model || S.model.id === 'unknown') {
    S.thinkingLevels = [];
    return;
  }
  try {
    const data = await cmd({ type: 'get_available_thinking_levels' });
    S.thinkingLevels = data?.levels || [];
  } catch {
    // Older pi builds lack get_available_thinking_levels; derive from model capability.
    S.thinkingLevels = S.model?.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off'];
  }
}

async function refreshStats(): Promise<void> {
  if (S.phase !== 'ready') return;
  try {
    const data = await cmd({ type: 'get_session_stats' });
    S.stats = data;
  } catch {
    /* ignore */
  }
  renderStatusbar();
}

async function refreshAll(): Promise<void> {
  await Promise.all([renderHistory(), refreshModels(), refreshCommands(), refreshThinking(), refreshStats(), refreshSessions()]);
}

async function refreshSessions(): Promise<void> {
  try {
    S.sessionItems = (await api.sessionsList(S.project || undefined)) || [];
  } catch {
    S.sessionItems = [];
  }
  renderSessionList();
}

// ============================== transcript ==============================
type ToolCard = {
  toolCallId: string;
  toolName: string;
  args: any;
  argsStr: string;
  status: 'pending' | 'running' | 'ok' | 'err';
  result: any;
  partialText: string;
  el: HTMLElement;
  bodyEl: HTMLElement | null;
  headArgsEl: HTMLElement | null;
  statusEl: HTMLElement | null;
};

const transcriptEl = () => $('transcript');
let items: any[] = [];
const toolCards = new Map<string, ToolCard>();
let autoStick = true;

function transcriptClear(): void {
  items = [];
  toolCards.clear();
  transcriptEl().innerHTML = '';
}

function nearBottom(): boolean {
  const w = $('transcript-wrap');
  return w.scrollHeight - w.scrollTop - w.clientHeight < 140;
}

function scrollBottom(force = false): void {
  if (!autoStick && !force) return;
  const w = $('transcript-wrap');
  w.scrollTop = w.scrollHeight;
}

$('transcript-wrap')?.addEventListener('scroll', () => {
  autoStick = nearBottom();
});

function pushItem(item: any): void {
  item.el ||= el('div', { class: 'msg' });
  transcriptEl().append(item.el);
  items.push(item);
  renderTranscriptItem(item);
  scrollBottom();
}

function renderTranscriptItem(item: any): void {
  const v = item.el;
  v.innerHTML = '';
  v.className = 'msg';
  switch (item.kind) {
    case 'user': return renderUserItem(item, v);
    case 'assistant': return renderAssistantItem(item, v);
    case 'bash': return renderBashItem(item, v);
    case 'notice': return renderNoticeItem(item, v);
    case 'custom': return renderCustomItem(item, v);
  }
}

function renderUserItem(item: any, v: HTMLElement): void {
  v.classList.add('msg-user');
  const bubble = el('div', { class: 'bubble', text: item.text || '' });
  const wrap = el('div', {}, bubble);
  if (item.images?.length) {
    const imgs = el('div', { class: 'images' });
    for (const im of item.images) {
      imgs.append(el('img', { src: `data:${im.mimeType};base64,${im.data}` }));
    }
    wrap.append(imgs);
  }
  v.append(wrap);
}

function textFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
  return '';
}

function imagesFromContent(content: any): any[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b: any) => b?.type === 'image');
}

// ---------- assistant ----------
type Block = { type: 'text' | 'thinking' | 'toolcall'; text: string; done: boolean; toolCallId?: string; toolName?: string; card?: ToolCard };

function renderAssistantItem(item: any, v: HTMLElement): void {
  v.classList.add('msg-assistant');
  const head = el('div', { class: 'msg-role' }, el('span', { class: 'm-name', text: 'pi' }));
  if (item.model && item.model !== 'unknown') {
    head.append(el('span', { text: item.model }));
  }
  v.append(head);
  const body = el('div', { class: 'body' });
  v.append(body);
  item.bodyEl = body;
  renderAssistantBlocks(item);
}

function renderAssistantBlocks(item: any): void {
  const body: HTMLElement = item.bodyEl;
  if (!body) return;
  body.innerHTML = '';
  const blocks: Block[] = item.blocks || [];
  let sawVisible = false;
  for (const b of blocks) {
    if (b.type === 'thinking') {
      const details = el('details', { class: 'thinking' });
      const summary = el('summary', {}, el('span', { class: 'chev', text: '▸' }), el('span', { text: b.done ? '思考过程' : '思考中…' }));
      details.append(summary);
      const tBody = el('div', { class: 't-body', text: b.text || ' ' });
      details.append(tBody);
      if (b.done && item.collapsedThinking) details.removeAttribute('open'); else if (!b.done) details.open = true;
      body.append(details);
      sawVisible = true;
    } else if (b.type === 'text') {
      if (!b.text) continue;
      const container = el('div');
      container.innerHTML = renderMarkdown(b.text);
      decorateCodeCopies(container);
      if (!b.done) container.append(el('span', { class: 'caret' }));
      body.append(container);
      sawVisible = true;
    } else if (b.type === 'toolcall') {
      if (b.card) body.append(b.card.el);
      sawVisible = true;
    }
  }
  if (!sawVisible && item.streaming) {
    body.append(el('div', { class: 'dim', text: '…' }));
  }
}

function decorateCodeCopies(root: HTMLElement): void {
  root.querySelectorAll('.code-copy').forEach((btn) => {
    (btn as HTMLElement).onclick = () => {
      const code = (btn as HTMLElement).getAttribute('data-code') || '';
      navigator.clipboard.writeText(code);
      btn.textContent = '已复制';
      setTimeout(() => (btn.textContent = '复制'), 1500);
    };
  });
}

function newAssistantItem(): any {
  const item = { kind: 'assistant', blocks: [] as Block[], streaming: true, el: null, bodyEl: null, model: null, collapsedThinking: true };
  pushItem(item);
  return item;
}

function blockAt(item: any, contentIndex: number): Block | null {
  const blocks: Block[] = item.blocks;
  if (contentIndex >= 0 && contentIndex < blocks.length) return blocks[contentIndex];
  return null;
}

let assistantRaf = 0;
function scheduleAssistantRender(item: any): void {
  item.dirty = true;
  if (assistantRaf) return;
  assistantRaf = requestAnimationFrame(() => {
    assistantRaf = 0;
    for (const it of items) {
      if (it.dirty && it.kind === 'assistant') {
        it.dirty = false;
        renderAssistantBlocks(it);
      }
    }
    scrollBottom();
  });
}

// ---------- tool cards ----------
const TOOL_ICONS: Record<string, string> = {
  read: '📄', bash: '❯', edit: '✏️', write: '📝', grep: '🔍', find: '🗂', ls: '📂', powershell: '❯',
};

function makeToolCard(toolCallId: string, toolName: string, args: any): ToolCard {
  const card: ToolCard = {
    toolCallId, toolName,
    args: args && typeof args === 'object' ? args : (argsStrToArgs(args as any)),
    argsStr: typeof args === 'string' ? args : '',
    status: 'pending', result: null, partialText: '',
    el: el('div', { class: 'tool-card' }), bodyEl: null, headArgsEl: null, statusEl: null,
  };
  card.el.innerHTML = '';
  const icon = TOOL_ICONS[toolName] || '🛠';
  const head = el('div', { class: 'tool-head', onclick: () => card.el.classList.toggle('open') },
    el('span', { class: 't-icon', text: icon }),
    el('span', { class: 't-title' }),
    card.headArgsEl = el('span', { class: 't-arg' }),
    el('span', { class: 'tool-status' }, card.statusEl = el('span', { class: 'dot run' })),
    el('span', { class: 'chev', text: '▸' }),
  );
  card.el.append(head);
  card.bodyEl = el('div', { class: 'tool-body' });
  card.el.append(card.bodyEl);
  toolCards.set(toolCallId, card);
  renderToolCard(card);
  return card;
}

function argsStrToArgs(s: string): any {
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

function toolTitle(card: ToolCard): string {
  const a = card.args || {};
  switch (card.toolName) {
    case 'read': return a.path || a.file_path || '';
    case 'bash': case 'powershell': return a.command || '';
    case 'edit': return a.path || a.file_path || '';
    case 'write': return a.path || a.file_path || '';
    case 'grep': return a.pattern || '';
    case 'find': return a.pattern || a.glob || '';
    case 'ls': return a.path || '.';
    default: return Object.keys(a).length ? JSON.stringify(a).slice(0, 80) : '';
  }
}

function renderToolCard(card: ToolCard): void {
  if (card.headArgsEl) card.headArgsEl.textContent = toolTitle(card);
  if (card.statusEl) {
    card.statusEl.className = `dot ${card.status === 'ok' ? 'ok' : card.status === 'err' ? 'err' : 'run'}`;
  }
  card.el.classList.toggle('running', card.status === 'running' || card.status === 'pending');
  card.el.classList.toggle('error', card.status === 'err');
  if (!card.bodyEl) return;
  const body = card.bodyEl;
  body.innerHTML = '';

  // diff view for edit with old/new text available
  if (card.toolName === 'edit' && card.args && card.args.oldText !== undefined && card.args.newText !== undefined) {
    for (const line of String(card.args.oldText).split('\n').slice(0, 200)) {
      body.append(el('span', { class: 'diff-line del', text: `- ${line}` }));
    }
    for (const line of String(card.args.newText).split('\n').slice(0, 200)) {
      body.append(el('span', { class: 'diff-line add', text: `+ ${line}` }));
    }
    return;
  }
  if (card.toolName === 'write' && card.args && card.args.content) {
    const lines = String(card.args.content).split('\n');
    for (const line of lines.slice(0, 200)) body.append(el('span', { class: 'diff-line add', text: `+ ${line}` }));
    if (lines.length > 200) body.append(el('span', { class: 'diff-line', text: `… 共 ${lines.length} 行` }));
    return;
  }

  // result content
  const resultObj = card.status === 'running' || card.status === 'pending' ? null : card.result;
  const partial = card.partialText;
  let contentBlocks: any[] = [];
  if (resultObj) contentBlocks = Array.isArray(resultObj.content) ? resultObj.content : (typeof resultObj === 'string' ? [{ type: 'text', text: resultObj }] : []);
  if (!contentBlocks.length && partial) contentBlocks = [{ type: 'text', text: partial }];
  if (!contentBlocks.length && card.args?._raw) contentBlocks = [{ type: 'text', text: card.args._raw }];
  if (!contentBlocks.length) {
    body.append(el('pre', { text: card.status === 'running' ? '运行中…' : '（无输出）' }));
    return;
  }
  for (const b of contentBlocks) {
    if (b.type === 'image' && b.data) {
      body.append(el('img', { src: `data:${b.mimeType || 'image/png'};base64,${b.data}` }));
    } else if (b.type === 'text') {
      const pre = el('pre', { text: b.text || '' });
      body.append(pre);
    }
  }
  if (resultObj && card.toolName === 'bash' && typeof resultObj.exitCode === 'number') {
    body.append(el('div', { class: 'tool-exit', text: `exit ${resultObj.exitCode}${resultObj.cancelled ? ' · 已取消' : ''}${resultObj.truncated ? ' · 输出被截断' : ''}` }));
  }
}

function ensureToolCard(id: string, name: string, args: any): ToolCard {
  let card = toolCards.get(id);
  if (!card) {
    card = makeToolCard(id, name, args);
    // attach to the most recent assistant item, or a fresh one
    let host = [...items].reverse().find((it) => it.kind === 'assistant');
    if (!host) host = newAssistantItem();
    host.blocks.push({ type: 'toolcall', text: '', done: true, toolCallId: id, toolName: name, card });
    scheduleAssistantRender(host);
  }
  return card;
}

function updateToolFromExecution(ev: any): void {
  const card = toolCards.get(ev.toolCallId);
  if (!card) return;
  if (ev.args !== undefined && (card.argsStr || !card.args || Object.keys(card.args).length === 0)) {
    card.args = ev.args;
  }
  if (ev.type === 'tool_execution_start') card.status = 'running';
  if (ev.type === 'tool_execution_update') {
    const pr = ev.partialResult;
    if (pr) {
      const text = textFromContent(pr.content);
      if (text) card.partialText = text;
    }
  }
  if (ev.type === 'tool_execution_end') {
    card.status = ev.isError ? 'err' : 'ok';
    card.result = ev.result;
  }
  renderToolCard(card);
  card.el.classList.add('open');
}

// ---------- bash item (RPC ! commands) ----------
function newBashItem(command: string): any {
  const item = { kind: 'bash', command, output: '', running: true, exitCode: undefined as number | undefined, cancelled: false, truncated: false, el: null };
  pushItem(item);
  return item;
}

function renderBashItem(item: any, v: HTMLElement): void {
  v.classList.add('msg-assistant');
  const card = el('div', { class: `tool-card ${item.running ? 'running' : ''} open` });
  const head = el('div', { class: 'tool-head' },
    el('span', { class: 't-icon', text: '❯' }),
    el('span', { class: 't-title', text: 'bash' }),
    el('span', { class: 'tool-status' }, el('span', { class: `dot ${item.running ? 'run' : item.cancelled || (item.exitCode && item.exitCode !== 0) ? 'err' : 'ok'}` })),
  );
  card.append(head);
  const body = el('div', { class: 'tool-body', style: 'display:block' });
  body.append(el('div', { class: 'bash-cmd' }, el('span', { class: 'p', text: '$' }), el('span', { text: item.command })));
  if (item.output) body.append(el('pre', { text: item.output }));
  if (!item.running) {
    const note = item.cancelled ? '已取消' : `exit ${item.exitCode ?? '?'}`;
    body.append(el('div', { class: 'tool-exit', text: note }));
  }
  card.append(body);
  v.append(card);
}

function appendBashOutput(item: any, delta: string): void {
  item.output += delta;
  // live update only the <pre>
  const pre = item.el.querySelector('.tool-body pre');
  if (pre) pre.textContent = item.output;
  else renderTranscriptItem(item);
  scrollBottom();
}

// ---------- notice / custom ----------
function newNotice(text: string, warn = false): any {
  const item = { kind: 'notice', text, warn, el: null };
  pushItem(item);
  return item;
}

function renderNoticeItem(item: any, v: HTMLElement): void {
  v.append(el('div', { class: `notice ${item.warn ? 'warn' : ''}` }, el('span', { class: 'n-text' })));
  const span = v.querySelector('.n-text') as HTMLElement;
  span.innerHTML = item.html || escapeText(item.text);
}

function newCustom(item0: any): void {
  const item = { kind: 'custom', customType: item0.customType, content: item0.content, el: null };
  pushItem(item);
}

function renderCustomItem(item: any, v: HTMLElement): void {
  const text = textFromContent(item.content);
  v.append(el('div', { class: 'notice' }, el('span', { class: 'n-text' }, `[${item.customType}] ${text.slice(0, 200)}`)));
}

// ---------- history render ----------
async function renderHistory(): Promise<void> {
  transcriptClear();
  let messages: any[] = [];
  try {
    const data = await cmd({ type: 'get_messages' });
    messages = data?.messages || [];
  } catch {
    return;
  }
  for (const m of messages) renderHistoricalMessage(m);
  scrollBottom(true);
}

function renderHistoricalMessage(m: any): void {
  switch (m.role) {
    case 'user': {
      pushItem({ kind: 'user', text: textFromContent(m.content), images: imagesFromContent(m.content) });
      break;
    }
    case 'assistant': {
      const item: any = { kind: 'assistant', blocks: [], streaming: false, model: m.model, el: null, bodyEl: null };
      for (const b of m.content || []) {
        if (b.type === 'thinking') item.blocks.push({ type: 'thinking', text: b.thinking || '', done: true });
        else if (b.type === 'text') item.blocks.push({ type: 'text', text: b.text || '', done: true });
        else if (b.type === 'toolCall') {
          const card = makeToolCard(b.id, b.name, b.arguments);
          card.status = 'ok';
          item.blocks.push({ type: 'toolcall', text: '', done: true, toolCallId: b.id, toolName: b.name, card });
        }
      }
      pushItem(item);
      break;
    }
    case 'toolResult': {
      const card = toolCards.get(m.toolCallId);
      if (card) {
        card.status = m.isError ? 'err' : 'ok';
        card.result = { content: m.content, details: m.details };
        renderToolCard(card);
      }
      break;
    }
    case 'bashExecution': {
      pushItem({ kind: 'bash', command: m.command, output: m.output || '', running: false, exitCode: m.exitCode, cancelled: m.cancelled, truncated: m.truncated });
      break;
    }
    case 'custom': {
      if (m.display !== false) newCustom(m);
      break;
    }
    case 'branchSummary': {
      newNotice(`<b>分支摘要</b> ${escapeText((m.summary || '').slice(0, 300))}`);
      break;
    }
    case 'compactionSummary': {
      newNotice(`<b>已压缩上下文</b>（此前约 ${m.tokensBefore ?? '?'} tokens）`);
      break;
    }
    case 'system': {
      newNotice('会话开始（系统提示与工具配置）');
      break;
    }
    default: {
      newNotice(`未知消息类型: ${m.role}`);
    }
  }
}

// ============================== statusbar / pills ==============================
function renderModelPill(): void {
  const pill = $('pill-model');
  const txt = S.model && S.model.id && S.model.id !== 'unknown'
    ? `${S.model.name || S.model.id}`
    : '未选择模型';
  (pill.querySelector('.p-txt') as HTMLElement).textContent = txt;
}

function renderThinkingPill(): void {
  const pill = $('pill-thinking');
  if (!S.model || S.model.id === 'unknown' || S.thinkingLevels.length <= 1) {
    pill.classList.add('hidden');
    return;
  }
  pill.classList.remove('hidden');
  (pill.querySelector('.p-txt') as HTMLElement).textContent = `思考: ${thinkingLabel(S.thinkingLevel)}`;
}

function thinkingLabel(l: string): string {
  const map: Record<string, string> = { off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };
  return map[l] || l;
}

function renderStatusbar(): void {
  renderModelPill();
  renderThinkingPill();
  const usage = S.stats?.contextUsage;
  const pillCtx = $('pill-ctx');
  if (usage && usage.contextWindow) {
    pillCtx.classList.remove('hidden');
    const pct = Math.max(0, Math.min(100, usage.percent ?? 0));
    const fill = $('ctx-fill');
    fill.style.width = `${pct}%`;
    fill.className = `fill ${pct > 90 ? 'danger' : pct > 70 ? 'warn' : ''}`;
    $('ctx-text').textContent = `${Math.round(pct)}%`;
  } else {
    pillCtx.classList.add('hidden');
  }
  const cost = S.stats?.cost;
  $('status-cost').textContent = cost ? fmtCost(cost) : '';
  // queue
  const q = S.queue;
  const qn = (q.steering?.length || 0) + (q.followUp?.length || 0);
  const qEl = $('status-queue');
  if (qn > 0) {
    qEl.classList.remove('hidden');
    qEl.textContent = `排队 ${qn}`;
  } else qEl.classList.add('hidden');
  // streaming indicator
  const ind = $('stream-ind');
  if (S.streaming) {
    ind.classList.remove('hidden');
    $('stream-label').textContent = S.isCompacting ? '压缩中' : '运行中';
  } else ind.classList.add('hidden');
  // stop button == send button while streaming
  const send = $('btn-send');
  send.classList.toggle('stop', S.streaming);
  send.title = S.streaming ? '停止 (Esc)' : '发送 (Enter)';
  send.innerHTML = S.streaming
    ? '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3 8h9M8.5 3.5L13 8l-4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // ext statuses
  const st = $('ext-status');
  const parts = [...S.extStatuses.entries()].map(([k, v]) => `${v}`).filter(Boolean);
  st.textContent = parts.join(' · ');
  st.classList.toggle('hidden', parts.length === 0);
}

function setStreaming(v: boolean): void {
  if (S.streaming === v) return;
  S.streaming = v;
  renderStatusbar();
  if (!v) {
    refreshStats();
    refreshSessions();
    refreshCommands();
  }
}

// ============================== session list ==============================
async function renderSessionList(): Promise<void> {
  const list = $('session-list');
  list.innerHTML = '';
  const items0 = S.sessionItems.slice(0, 40);
  if (!items0.length) {
    list.append(el('div', { class: 'dim', style: 'padding:8px 10px;font-size:12px', text: '本项目暂无历史会话' }));
    return;
  }
  for (const s of items0) {
    const active = S.sessionFile && normPath(S.sessionFile) === normPath(s.file);
    const title = s.name || s.preview || '未命名会话';
    const row = el('div', { class: `session-item ${active ? 'active' : ''}`, onclick: () => openSession(s) },
      el('div', { class: 's-name', text: title, title }),
      el('div', { class: 's-meta', text: `${fmtTime(s.mtime)} · ${fmtBytes(s.size)}` }),
      el('button', { class: 's-del', title: '删除会话', text: '✕', onclick: (e: Event) => { e.stopPropagation(); deleteSession(s); } }),
    );
    list.append(row);
  }
}

function normPath(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase();
}

async function openSession(s: any): Promise<void> {
  if (S.sessionFile && normPath(S.sessionFile) === normPath(s.file)) return;
  if (S.streaming && !confirmModal('切换会话', 'pi 正在运行，切换会话会中断当前任务。继续？')) return;
  if (S.streaming) await cmd({ type: 'abort' }).catch(() => {});
  try {
    await cmd({ type: 'switch_session', sessionPath: s.file });
    await syncFromState();
    toast('已切换会话', 'success');
  } catch (e: any) {
    toast(`切换失败: ${e.message || e}`, 'error');
  }
}

async function deleteSession(s: any): Promise<void> {
  if (!(await confirmModal('删除会话', `确定删除「${s.name || s.preview || '未命名会话'}」吗？此操作不可恢复。`, true))) return;
  await api.sessionsDelete(s.file);
  await refreshSessions();
  toast('会话已删除', 'success');
}

// ============================== state sync ==============================
async function syncFromState(): Promise<void> {
  try {
    const data = await cmd({ type: 'get_state' });
    applyState(data);
  } catch {
    /* ignore */
  }
  await refreshAll();
}

function applyState(data: any): void {
  if (!data) return;
  S.model = data.model && data.model.id !== 'unknown' ? data.model : null;
  S.thinkingLevel = data.thinkingLevel ?? 'off';
  S.sessionFile = data.sessionFile || null;
  S.sessionName = data.sessionName || null;
  S.autoCompaction = data.autoCompactionEnabled ?? true;
  S.isCompacting = data.isCompacting ?? false;
  renderStatusbar();
  updateWindowTitle();
}

function updateWindowTitle(): void {
  const proj = S.project ? baseName(S.project) : '';
  const name = S.sessionName || '新会话';
  document.title = `${name} · ${proj} — PiCode`;
}

// ============================== pi lifecycle ==============================
async function startPi(cwd: string, sessionPath?: string | null): Promise<void> {
  if (S.phase === 'starting') return;
  S.intentionalStop = false;
  S.project = cwd;
  S.phase = 'starting';
  S.model = null; S.stats = null; S.queue = { steering: [], followUp: [] };
  transcriptClear();
  renderBanner(null);
  $('project-name').textContent = cwd;
  setStreaming(false);
  transcriptEl().append(el('div', { class: 'notice' }, el('span', { class: 'n-text', text: '正在启动 pi …' })));

  const extraArgs: string[] = [];
  if (S.prefs.trustProject) extraArgs.push('--approve');
  try {
    await api.piStart({ cwd, sessionPath: sessionPath || null, extraArgs });
  } catch (e: any) {
    S.phase = 'dead';
    renderBanner(`无法启动 pi：${e.message || e}`);
    return;
  }
  api.setPrefs({ lastProject: cwd, recentProjects: pushRecent(S.prefs.recentProjects, cwd) }).then((p: any) => (S.prefs = p));

  // wait until pi answers
  for (let i = 0; i < 120; i++) {
    if (S.phase !== 'starting') return;
    try {
      const resp = await api.piCommand({ type: 'get_state' });
      if (resp.success) {
        S.phase = 'ready';
        applyState(resp.data);
        await refreshAll();
        if (!S.models.length) {
          renderBanner('还没有可用的模型。点击右侧「设置」配置 API 密钥后，用 /model 选择模型。', true);
        }
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
}

function pushRecent(list: any, cwd: string): string[] {
  const arr: string[] = Array.isArray(list) ? list.filter((p: string) => normPath(p) !== normPath(cwd)) : [];
  arr.unshift(cwd);
  return arr.slice(0, 6);
}

function renderBanner(message: string | null, warning = false): void {
  const zone = $('banner-zone');
  zone.innerHTML = '';
  if (!message) return;
  const banner = el('div', { class: 'dead-banner' },
    el('span', { text: warning ? '⚠' : '✕' }),
    el('span', { text: message, style: 'flex:1' }),
  );
  if (!warning) {
    const btn = el('button', { class: 'btn small', text: '重启 pi', onclick: () => startPi(S.project!, S.sessionFile) });
    banner.append(btn);
  } else {
    const btn = el('button', { class: 'btn small', text: '打开设置', onclick: () => openSettings() });
    banner.append(btn);
  }
  zone.append(banner);
}

// ============================== event stream ==============================
function handleEvent(ev: any): void {
  switch (ev.type) {
    case 'message_start': return onMessageStart(ev.message);
    case 'message_update': return onMessageUpdate(ev);
    case 'message_end': return onMessageEnd(ev.message);
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end': return updateToolFromExecution(ev);
    case 'agent_start': break;
    case 'agent_end': {
      // pi 0.73.x does not emit agent_settled; agent_end + no pending work = idle.
      const pending = (S.queue.steering?.length || 0) + (S.queue.followUp?.length || 0);
      if (!ev.willRetry && pending === 0 && !S.isCompacting) setStreaming(false);
      break;
    }
    case 'agent_settled': setStreaming(false); break;
    case 'turn_start': setStreaming(true); break;
    case 'turn_end': break;
    case 'queue_update': {
      S.queue = { steering: ev.steering || [], followUp: ev.followUp || [] };
      renderQueue();
      renderStatusbar();
      break;
    }
    case 'compaction_start': {
      S.isCompacting = true;
      newNotice(`<b>正在压缩上下文</b>（${compactionReason(ev.reason)}）…`);
      renderStatusbar();
      break;
    }
    case 'compaction_end': {
      S.isCompacting = false;
      if (ev.aborted) newNotice('上下文压缩已取消', true);
      else if (ev.errorMessage) newNotice(`上下文压缩失败：${escapeText(ev.errorMessage)}`, true);
      else newNotice(`<b>上下文已压缩</b>：${ev.result?.tokensBefore ?? '?'} → 约 ${ev.result?.estimatedTokensAfter ?? '?'} tokens`);
      renderStatusbar();
      break;
    }
    case 'auto_retry_start': {
      newNotice(`请求失败（${escapeText(String(ev.errorMessage || '')).slice(0, 120)}），${(ev.delayMs / 1000).toFixed(0)}s 后自动重试（第 ${ev.attempt}/${ev.maxAttempts} 次）`, true);
      break;
    }
    case 'auto_retry_end': {
      if (!ev.success) newNotice('重试失败，已停止', true);
      break;
    }
    case 'session_info_changed': {
      S.sessionName = ev.name || null;
      updateWindowTitle();
      refreshSessions();
      break;
    }
    case 'thinking_level_changed': {
      S.thinkingLevel = ev.level;
      renderThinkingPill();
      break;
    }
    case 'bash_execution_update': {
      const item = items.filter((it) => it.kind === 'bash' && it.running).at(-1);
      if (item && ev.delta) appendBashOutput(item, ev.delta);
      break;
    }
    case 'extension_error': {
      toast(`扩展错误: ${String(ev.error || '').slice(0, 160)}`, 'error');
      break;
    }
    case 'entry_appended': break;
    default: break;
  }
}

function compactionReason(r: string): string {
  return r === 'manual' ? '手动' : r === 'threshold' ? '接近上限' : r === 'overflow' ? '上下文溢出' : r || '';
}

function onMessageStart(message: any): void {
  if (!message) return;
  if (message.role === 'user') {
    pushItem({ kind: 'user', text: textFromContent(message.content), images: imagesFromContent(message.content) });
  } else if (message.role === 'assistant') {
    setStreaming(true);
    const item = newAssistantItem();
    item.model = message.model;
    renderTranscriptItem(item);
  } else if (message.role === 'bashExecution') {
    // rendered via the RPC bash card; ignore duplicates from state
  } else {
    // system / custom / summaries arrive here live
    if (message.role === 'custom') {
      if (message.display !== false) newCustom(message);
    } else if (message.role === 'compactionSummary') {
      newNotice(`<b>已压缩上下文</b>（此前约 ${message.tokensBefore ?? '?'} tokens）`);
    } else if (message.role === 'branchSummary') {
      newNotice(`<b>分支摘要</b> ${escapeText((message.summary || '').slice(0, 300))}`);
    } else if (message.role === 'system') {
      newNotice('系统提示已更新');
    }
  }
}

let currentStream: any = null;

function onMessageUpdate(ev: any): void {
  const ae = ev.assistantMessageEvent;
  if (!ae) return;
  if (!currentStream || currentStream.kind !== 'assistant' || !currentStream.streaming) {
    currentStream = items.filter((it) => it.kind === 'assistant' && it.streaming).at(-1) || newAssistantItem();
  }
  const item = currentStream;
  if (ev.usage) {
    S.stats = { ...(S.stats || {}), tokens: ev.usage.totalTokens, cost: ev.usage.cost?.total ?? S.stats?.cost };
    renderStatusbar();
  }
  const idx = ae.contentIndex ?? 0;
  const blocks: Block[] = item.blocks;
  const ensure = (type: Block['type']) => {
    while (blocks.length <= idx) blocks.push({ type, text: '', done: false });
    if (blocks[idx].type !== type) blocks[idx] = { type, text: '', done: false };
    return blocks[idx];
  };
  switch (ae.type) {
    case 'text_start': ensure('text'); break;
    case 'text_delta': {
      const b = ensure('text');
      b.text += ae.delta || '';
      break;
    }
    case 'text_end': {
      const b = ensure('text');
      b.text = ae.content ?? b.text;
      b.done = true;
      break;
    }
    case 'thinking_start': ensure('thinking'); break;
    case 'thinking_delta': {
      const b = ensure('thinking');
      b.text += ae.delta || '';
      break;
    }
    case 'thinking_end': {
      const b = ensure('thinking');
      b.text = ae.content ?? b.text;
      b.done = true;
      break;
    }
    case 'toolcall_start': {
      while (blocks.length <= idx) blocks.push({ type: 'toolcall', text: '', done: false });
      const card = ensureToolCard(ae.id, ae.toolName, undefined);
      card.status = 'pending';
      blocks[idx] = { type: 'toolcall', text: '', done: false, toolCallId: ae.id, toolName: ae.toolName, card };
      break;
    }
    case 'toolcall_delta': {
      const card = toolCards.get(ae.id);
      if (card && ae.delta) card.argsStr += ae.delta;
      break;
    }
    case 'toolcall_end': {
      const card = toolCards.get(ae.id || ae.toolCall?.id);
      if (card && ae.toolCall) {
        card.args = ae.toolCall.arguments || {};
        renderToolCard(card);
      }
      if (blocks[idx]) blocks[idx].done = true;
      break;
    }
    default: break;
  }
  scheduleAssistantRender(item);
}

function onMessageEnd(message: any): void {
  if (!message) return;
  if (message.role === 'assistant') {
    // finalize: re-render the streaming item from the authoritative message
    let item = items.filter((it) => it.kind === 'assistant' && it.streaming).at(-1);
    if (!item) {
      item = newAssistantItem();
    }
    item.streaming = false;
    item.model = message.model;
    const blocks: Block[] = [];
    for (const b of message.content || []) {
      if (b.type === 'thinking') blocks.push({ type: 'thinking', text: b.thinking || '', done: true });
      else if (b.type === 'text') blocks.push({ type: 'text', text: b.text || '', done: true });
      else if (b.type === 'toolCall') {
        let card = toolCards.get(b.id);
        if (!card) card = makeToolCard(b.id, b.name, b.arguments);
        else card.args = b.arguments;
        card.status = card.status === 'ok' || card.status === 'err' ? card.status : 'ok';
        renderToolCard(card);
        blocks.push({ type: 'toolcall', text: '', done: true, toolCallId: b.id, toolName: b.name, card });
      }
    }
    item.blocks = blocks;
    if (message.stopReason === 'error' || message.errorMessage) {
      newNotice(`⚠ ${escapeText(message.errorMessage || '模型返回错误')}`, true);
    }
    renderTranscriptItem(item);
    currentStream = null;
    if (message.usage) {
      S.stats = { ...(S.stats || {}) };
      renderStatusbar();
    }
    scrollBottom();
  }
}

// ============================== queue ui ==============================
function renderQueue(): void {
  const row = $('queue-row');
  row.innerHTML = '';
  const mkPill = (text: string, label: string) => {
    const pill = el('div', { class: 'queue-pill', title: text },
      el('span', { text: label }),
      el('span', { class: 'q-text', text }),
      el('button', { class: 'q-x', text: '✕', title: '移出队列', onclick: () => clearQueueToComposer() }),
    );
    return pill;
  };
  for (const t of S.queue.steering) row.append(mkPill(t, '插队'));
  for (const t of S.queue.followUp) row.append(mkPill(t, '排队'));
  row.classList.toggle('hidden', row.children.length === 0);
}

async function clearQueueToComposer(): Promise<void> {
  try {
    const data = await cmd({ type: 'clear_queue' });
    const all = [...(data?.steering || []), ...(data?.followUp || [])];
    if (all.length) {
      const input = $('composer-input') as HTMLTextAreaElement;
      input.value = all.join('\n');
      autosize();
      toast(`已取回 ${all.length} 条排队消息`, 'success');
    }
  } catch (e: any) {
    toast(`无法取回排队消息（当前内置 pi 版本可能不支持 clear_queue）：${e.message || e}`, 'warning');
  }
}

// ============================== composer ==============================
function autosize(): void {
  const t = $('composer-input') as HTMLTextAreaElement;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 190)}px`;
}

async function sendCurrent(): Promise<void> {
  const input = $('composer-input') as HTMLTextAreaElement;
  const text = input.value.trim();
  if (S.phase !== 'ready') {
    toast('pi 尚未就绪', 'warning');
    return;
  }
  if (!text && !S.attachments.length) return;

  if (text.startsWith('!')) {
    const command = text.slice(1).trim();
    if (!command) return;
    input.value = ''; autosize();
    runRpcBash(command);
    return;
  }
  if (text.startsWith('/')) {
    const handled = await dispatchSlash(text);
    if (handled) { input.value = ''; autosize(); return; }
    // unknown command: send as plain message
    toast('未知指令，已作为普通消息发送', 'warning');
  }
  await sendPrompt(text, S.attachments.slice());
  input.value = ''; autosize();
  clearAttachments();
}

async function sendPrompt(text: string, images: any[] = []): Promise<void> {
  S.history.push(text);
  S.historyIdx = S.history.length;
  const record: any = { type: 'prompt', message: text };
  if (images.length) record.images = images;
  if (S.streaming) {
    record.streamingBehavior = 'steer';
    toast('pi 正在运行，消息已加入插队队列', 'info');
  }
  try {
    await cmd(record);
  } catch (e: any) {
    toast(`发送失败: ${e.message || e}`, 'error');
  }
}

async function runRpcBash(command: string): Promise<void> {
  const item = newBashItem(command);
  try {
    const resp = await api.piCommand({ type: 'bash', command });
    item.running = false;
    item.output = resp.data?.output ?? item.output;
    item.exitCode = resp.data?.exitCode;
    item.cancelled = resp.data?.cancelled;
    item.truncated = resp.data?.truncated;
    renderTranscriptItem(item);
    scrollBottom();
    refreshStats();
  } catch (e: any) {
    item.running = false;
    item.output = item.output || `错误: ${e.message || e}`;
    renderTranscriptItem(item);
  }
}

// attachments
function clearAttachments(): void {
  S.attachments = [];
  renderAttachments();
}

function addAttachment(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    S.attachments.push({ data: base64, mimeType: file.type || 'image/png' });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

function renderAttachments(): void {
  const strip = $('attach-strip');
  strip.innerHTML = '';
  S.attachments.forEach((a, i) => {
    const thumb = el('div', { class: 'attach-thumb' },
      el('img', { src: `data:${a.mimeType};base64,${a.data}` }),
      el('button', { class: 'rm', text: '✕', onclick: () => { S.attachments.splice(i, 1); renderAttachments(); } }),
    );
    strip.append(thumb);
  });
}

// ============================== slash commands ==============================
interface Builtin { name: string; desc: string; run: (arg: string) => void; argHint?: string }

const BUILTINS: Builtin[] = [
  { name: 'help', desc: '查看所有可用指令', run: () => openHelp() },
  { name: 'new', desc: '开始一个全新会话', run: () => newSession() },
  { name: 'clear', desc: '同 /new — 开始新会话', run: () => newSession() },
  { name: 'model', desc: '切换模型', run: () => openModelPicker() },
  { name: 'thinking', desc: '调整思考等级', run: () => openThinkingPicker() },
  { name: 'resume', desc: '浏览并恢复历史会话', run: () => openSessionsModal() },
  { name: 'sessions', desc: '同 /resume — 会话列表', run: () => openSessionsModal() },
  { name: 'session', desc: '当前会话信息与用量', run: () => openStatsModal() },
  { name: 'stats', desc: '同 /session — 会话统计', run: () => openStatsModal() },
  { name: 'compact', desc: '压缩上下文，可附加摘要重点', argHint: '摘要重点（可选）', run: (arg) => doCompact(arg) },
  { name: 'name', desc: '给当前会话命名', argHint: '会话名称', run: (arg) => doSetName(arg) },
  { name: 'fork', desc: '从某条历史消息分叉新会话', run: () => openForkModal() },
  { name: 'clone', desc: '复制当前会话为副本', run: () => doClone() },
  { name: 'tree', desc: '查看会话分支树', run: () => openTreeModal() },
  { name: 'export', desc: '导出会话为 HTML', run: () => doExport() },
  { name: 'extensions', desc: '查看已加载的扩展 / 模板 / 技能', run: () => openExtensionsModal() },
  { name: 'settings', desc: '打开设置（密钥 / 默认模型 / 外观）', run: () => openSettings() },
  { name: 'reload', desc: '重启 pi（重新加载配置与扩展）', run: () => doReload() },
  { name: 'quit', desc: '退出 PiCode', run: () => window.close() },
];

async function dispatchSlash(text: string): Promise<boolean> {
  const m = text.match(/^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return false;
  const name = m[1];
  const arg = (m[2] || '').trim();
  const builtin = BUILTINS.find((b) => b.name === name);
  if (builtin) {
    builtin.run(arg);
    return true;
  }
  const dynamic = S.commands.find((c: any) => c.name === name);
  if (dynamic) {
    await sendPrompt(text);
    return true;
  }
  return false;
}

async function newSession(): Promise<void> {
  if (S.streaming && !(await confirmModal('开始新会话', 'pi 正在运行，新会话将中断当前任务。继续？'))) return;
  if (S.streaming) await cmd({ type: 'abort' }).catch(() => {});
  try {
    const resp = await cmd({ type: 'new_session' });
    if (resp?.cancelled) {
      toast('扩展取消了新会话', 'warning');
      return;
    }
    transcriptClear();
    await syncFromState();
    toast('已开始新会话', 'success');
  } catch (e: any) {
    toast(e.message || String(e), 'error');
  }
}

async function doCompact(arg: string): Promise<void> {
  try {
    toast('正在压缩上下文…', 'info');
    const record: any = { type: 'compact' };
    if (arg) record.customInstructions = arg;
    const data = await cmd(record);
    newNotice(`<b>已压缩</b>：${data?.tokensBefore ?? '?'} → 约 ${data?.estimatedTokensAfter ?? '?'} tokens`);
    refreshStats();
  } catch (e: any) {
    toast(`压缩失败: ${e.message || e}`, 'error');
  }
}

async function doSetName(arg: string): Promise<void> {
  let name = arg;
  if (!name) {
    name = (await promptModal('会话名称', '给当前会话起个名字：')) || '';
    if (!name) return;
  }
  try {
    await cmd({ type: 'set_session_name', name });
    S.sessionName = name;
    updateWindowTitle();
    refreshSessions();
    toast('会话已命名', 'success');
  } catch (e: any) {
    toast(e.message || String(e), 'error');
  }
}

async function doClone(): Promise<void> {
  try {
    const resp = await cmd({ type: 'clone' });
    if (resp?.cancelled) return toast('扩展取消了复制', 'warning');
    await syncFromState();
    toast('已复制为新会话', 'success');
  } catch (e: any) {
    toast(e.message || String(e), 'error');
  }
}

async function doExport(): Promise<void> {
  try {
    const data = await cmd({ type: 'export_html' });
    if (data?.path) {
      toast(`已导出: ${data.path}`, 'success', 8000);
      await api.showItem(data.path);
    }
  } catch (e: any) {
    toast(`导出失败: ${e.message || e}`, 'error');
  }
}

async function doReload(): Promise<void> {
  toast('正在重启 pi …', 'info');
  S.intentionalStop = true;
  api.piStop();
  const sessionPath = S.sessionFile;
  const project = S.project;
  S.phase = 'welcome';
  await sleep(400);
  if (project) await startPi(project, sessionPath);
}

// ---------- slash palette ----------
const palette = {
  visible: false,
  entries: [] as any[],
  sel: 0,
  token: '',
};

function computePalette(): void {
  const input = $('composer-input') as HTMLTextAreaElement;
  const value = input.value;
  const m = value.match(/^\/([a-zA-Z0-9:_-]*)$/);
  if (!m) {
    hidePalette();
    return;
  }
  palette.token = m[1].toLowerCase();
  const q = palette.token;
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    return 3;
  };
  const match = (s: string) => rank(s) < 3;
  const builtins = BUILTINS.filter((b) => match(b.name))
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map((b) => ({ name: b.name, desc: b.desc, tag: '内置', builtin: b }));
  const dynamics = S.commands
    .filter((c: any) => match(c.name))
    .sort((a: any, b: any) => rank(a.name) - rank(b.name))
    .map((c: any) => ({
      name: c.name,
      desc: c.description || '',
      tag: c.source === 'skill' ? '技能' : c.source === 'prompt' ? '模板' : '扩展',
      builtin: null,
    }));
  palette.entries = [...builtins, ...dynamics].slice(0, 40);
  palette.sel = 0;
  if (!palette.entries.length && !q) {
    hidePalette();
    return;
  }
  renderPalette();
  palette.visible = true;
  $('palette').classList.add('show');
  $('palette-head').textContent = q ? `匹配 “/${q}”` : '输入 / 使用指令';
}

function renderPalette(): void {
  const list = $('palette-list');
  list.innerHTML = '';
  if (!palette.entries.length) {
    list.append(el('div', { class: 'p-empty', text: '没有匹配的指令 — 回车将作为普通消息发送' }));
    return;
  }
  palette.entries.forEach((entry, i) => {
    const row = el('div', { class: `p-item ${i === palette.sel ? 'sel' : ''}`, onmousedown: (e: Event) => { e.preventDefault(); choosePalette(entry); } },
      el('span', { class: 'p-name', text: `/${entry.name}` }),
      el('span', { class: 'p-desc', text: entry.desc || '' }),
      el('span', { class: 'p-tag', text: entry.tag }),
    );
    list.append(row);
  });
}

function hidePalette(): void {
  palette.visible = false;
  $('palette').classList.remove('show');
}

function choosePalette(entry: any): void {
  const input = $('composer-input') as HTMLTextAreaElement;
  hidePalette();
  if (entry.builtin) {
    input.value = `/${entry.name} `;
    input.focus();
    if (entry.builtin.argHint === undefined && !needsArg(entry.name)) {
      // argless commands run immediately
      input.value = '';
      entry.builtin.run('');
    } else {
      autosize();
    }
  } else {
    input.value = `/${entry.name} `;
    input.focus();
    autosize();
  }
}

function needsArg(name: string): boolean {
  return ['compact', 'name'].includes(name);
}

// ============================== modals ==============================
let modalStack = 0;

function baseModal(title: string, wide = false): { body: HTMLElement; close: () => void; done: Promise<void> } {
  const mask = el('div', { class: 'modal-mask' });
  const modal = el('div', { class: `modal ${wide ? 'wide' : ''}` });
  const head = el('div', { class: 'modal-head' }, el('div', { class: 'm-title', text: title }));
  const closeBtn = el('button', { class: 'modal-close', text: '✕' });
  head.append(closeBtn);
  const body = el('div', { class: 'modal-body' });
  modal.append(head, body);
  mask.append(modal);
  $('modal-root').append(mask);
  modalStack++;
  let resolveDone: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const close = () => {
    mask.remove();
    modalStack--;
    resolveDone!();
  };
  closeBtn.onclick = close;
  mask.onmousedown = (e) => {
    if (e.target === mask) close();
  };
  return { body, close, done };
}

function confirmModal(title: string, message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const { body, close } = baseModal(title);
    body.append(el('div', { style: 'font-size:13.5px;line-height:1.7;color:var(--text-dim)', text: message }));
    const foot = el('div', { class: 'modal-foot' });
    const cancel = el('button', { class: 'btn', text: '取消', onclick: () => { resolve(false); close(); } });
    const ok = el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, text: danger ? '删除' : '确定', onclick: () => { resolve(true); close(); } });
    foot.append(cancel, ok);
    body.append(foot);
  });
}

function promptModal(title: string, label: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const { body, close } = baseModal(title);
    const input = el('input', { type: 'text', class: 'grow', value: initial, style: 'width:100%' }) as HTMLInputElement;
    body.append(el('div', { style: 'font-size:12.8px;color:var(--text-dim);margin-bottom:8px', text: label }), input);
    const foot = el('div', { class: 'modal-foot' });
    foot.append(
      el('button', { class: 'btn', text: '取消', onclick: () => { resolve(null); close(); } }),
      el('button', { class: 'btn primary', text: '确定', onclick: () => { resolve(input.value.trim()); close(); } }),
    );
    body.append(foot);
    setTimeout(() => input.focus(), 50);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { resolve(input.value.trim()); close(); }
    };
  });
}

// ---------- model picker ----------
async function openModelPicker(): Promise<void> {
  await refreshModels();
  const { body, close } = baseModal('选择模型', true);
  const search = el('input', { type: 'text', class: 'search-box', placeholder: '搜索模型（名称 / 供应商）…' }) as HTMLInputElement;
  const listEl = el('div');
  body.append(search, listEl);
  const settings = await api.configRead();
  const defKey = settings?.settings?.defaultProvider && settings?.settings?.defaultModel
    ? `${settings.settings.defaultProvider}/${settings.settings.defaultModel}` : null;

  const render = () => {
    listEl.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const models = S.models.filter((m: any) =>
      !q || `${m.provider}/${m.id}`.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
    if (!S.models.length) {
      listEl.append(el('div', { class: 'p-empty' },
        el('div', { text: '没有可用模型 — 大多数供应商需要先配置 API 密钥。' }),
        el('button', { class: 'btn', style: 'margin-top:10px', text: '打开设置配置密钥', onclick: () => { close(); openSettings(); } }),
      ));
      return;
    }
    if (!models.length) listEl.append(el('div', { class: 'p-empty', text: '没有匹配的模型' }));
    const groups = new Map<string, any[]>();
    for (const m of models) {
      if (!groups.has(m.provider)) groups.set(m.provider, []);
      groups.get(m.provider)!.push(m);
    }
    for (const [provider, ms] of groups) {
      listEl.append(el('div', { class: 'model-group-label', text: provider }));
      for (const m of ms) {
        const current = S.model && S.model.provider === m.provider && S.model.id === m.id;
        const isDefault = defKey === `${m.provider}/${m.id}`;
        const row = el('div', { class: `model-item ${current ? 'current' : ''}` },
          el('span', { class: 'm-check', text: current ? '✓' : '' }),
          el('span', { class: 'm-id', text: m.id }),
          el('span', { class: 'm-meta', text: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : '' }),
          el('button', { class: `m-default ${isDefault ? 'is-default' : ''}`, text: isDefault ? '默认' : '设默认', title: '设为新会话默认模型' }),
        );
        row.onclick = async () => {
          try {
            const resp = await cmd({ type: 'set_model', provider: m.provider, modelId: m.id });
            S.model = resp?.model || resp;
            renderModelPill();
            await refreshThinking();
            toast(`已切换到 ${S.model?.name || m.id}`, 'success');
            render();
          } catch (e: any) {
            toast(`切换失败: ${e.message || e}`, 'error');
          }
        };
        (row.querySelector('.m-default') as HTMLElement).onclick = async (e) => {
          e.stopPropagation();
          try {
            await api.configWriteSettings({ defaultProvider: m.provider, defaultModel: m.id });
            toast(`已设为默认: ${m.provider}/${m.id}`, 'success');
            render();
          } catch (err: any) {
            toast(err.message || String(err), 'error');
          }
        };
        listEl.append(row);
      }
    }
  };
  search.oninput = render;
  render();
  setTimeout(() => search.focus(), 50);
}

// ---------- thinking picker ----------
async function openThinkingPicker(): Promise<void> {
  await refreshThinking();
  if (!S.thinkingLevels.length) {
    toast('当前模型不支持思考等级调节', 'info');
    return;
  }
  const { body } = baseModal('思考等级');
  const desc: Record<string, string> = {
    off: '关闭推理', minimal: '最少推理', low: '低强度推理', medium: '中等（默认）', high: '高强度推理', xhigh: '超高（部分模型）', max: '最大（部分模型）',
  };
  for (const lv of S.thinkingLevels) {
    const current = lv === S.thinkingLevel;
    const row = el('div', { class: `model-item ${current ? 'current' : ''}` },
      el('span', { class: 'm-check', text: current ? '✓' : '' }),
      el('span', { class: 'm-id', text: `${lv}（${thinkingLabel(lv)}）` }),
      el('span', { class: 'm-meta', text: desc[lv] || '' }),
    );
    row.onclick = async () => {
      try {
        await cmd({ type: 'set_thinking_level', level: lv });
        S.thinkingLevel = lv;
        renderThinkingPill();
        toast(`思考等级: ${thinkingLabel(lv)}`, 'success');
        (document.querySelector('.modal-mask .modal-close') as HTMLElement)?.click();
      } catch (e: any) {
        toast(e.message || String(e), 'error');
      }
    };
    body.append(row);
  }
  const save = el('button', { class: 'btn', style: 'margin-top:12px', text: '保存为启动默认', onclick: async () => {
    await api.configWriteSettings({ defaultThinkingLevel: S.thinkingLevel });
    toast('已保存默认思考等级', 'success');
  } });
  body.append(save);
}

// ---------- sessions modal ----------
async function openSessionsModal(allProjects = false): Promise<void> {
  const { body, close } = baseModal('会话', true);
  const search = el('input', { type: 'text', class: 'search-box', placeholder: '搜索会话…' }) as HTMLInputElement;
  const toggleRow = el('label', { class: 'toggle-row' });
  const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
  cb.checked = allProjects;
  toggleRow.append(cb, el('span', { text: '显示所有项目的会话' }));
  const listEl = el('div');
  body.append(search, toggleRow, listEl);
  let sessions = await api.sessionsList(cb.checked ? undefined : S.project || undefined);

  const render = () => {
    listEl.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const rows = sessions.filter((s: any) => !q || (s.name || '').toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q));
    if (!rows.length) {
      listEl.append(el('div', { class: 'p-empty', text: '没有会话记录' }));
      return;
    }
    for (const s of rows) {
      const active = S.sessionFile && normPath(S.sessionFile) === normPath(s.file);
      const item = el('div', { class: `slist-item ${active ? 'current' : ''}` },
        el('div', { class: 'sl-main' },
          el('div', { class: 'sl-name', text: s.name || s.preview || '未命名会话' }),
          el('div', { class: 'sl-sub', text: `${baseName(s.cwd)} · ${fmtTime(s.mtime)} · ${fmtBytes(s.size)}` }),
        ),
        el('div', { class: 'sl-actions' },
          el('button', { class: 'btn small', text: active ? '当前' : '打开', onclick: async () => { close(); if (!active) openSession(s); } }),
          el('button', { class: 'btn small danger', text: '删除', onclick: async () => { await deleteSession(s); sessions = await api.sessionsList(cb.checked ? undefined : S.project || undefined); render(); } }),
        ),
      );
      listEl.append(item);
    }
  };
  cb.onchange = async () => {
    sessions = await api.sessionsList(cb.checked ? undefined : S.project || undefined);
    render();
  };
  search.oninput = render;
  render();
}

// ---------- fork ----------
async function openForkModal(): Promise<void> {
  let messages: any[] = [];
  try {
    const data = await cmd({ type: 'get_fork_messages' });
    messages = data?.messages || [];
  } catch (e: any) {
    toast(e.message || String(e), 'error');
    return;
  }
  const { body } = baseModal('从历史消息分叉', true);
  if (!messages.length) {
    body.append(el('div', { class: 'p-empty', text: '会话中还没有用户消息，无法分叉' }));
    return;
  }
  body.append(el('div', { class: 'form-hint', text: '选择一条用户消息，将以其为终点创建一个新的分叉会话（原会话保留）。' }));
  for (const m of [...messages].reverse()) {
    const row = el('div', { class: 'slist-item' },
      el('div', { class: 'sl-main' }, el('div', { class: 'sl-name', text: (m.text || '').slice(0, 120) || '（空消息）' })),
      el('button', { class: 'btn small', text: '分叉', onclick: async () => {
        try {
          const resp = await cmd({ type: 'fork', entryId: m.entryId });
          if (resp?.cancelled) return toast('扩展取消了分叉', 'warning');
          document.querySelectorAll('.modal-mask').forEach((n) => n.remove());
          await syncFromState();
          toast('已分叉为新会话', 'success');
        } catch (e: any) {
          toast(e.message || String(e), 'error');
        }
      } }),
    );
    body.append(row);
  }
}

// ---------- tree ----------
async function openTreeModal(): Promise<void> {
  let tree: any[] = [];
  let leafId: string | null = null;
  try {
    const data = await cmd({ type: 'get_tree' });
    tree = data?.tree || [];
    leafId = data?.leafId ?? null;
    console.log('[picode] tree via get_tree', tree.length, leafId);
  } catch (err: any) {
    console.log('[picode] get_tree unavailable:', String(err?.message || err), 'sessionFile:', S.sessionFile);
    // Older pi builds: rebuild the tree from the session file itself.
    if (S.sessionFile) {
      try {
        const data = await api.sessionsTree(S.sessionFile);
        tree = data?.tree || [];
        leafId = data?.leafId ?? null;
        console.log('[picode] tree via file fallback', tree.length, leafId);
      } catch (e: any) {
        console.log('[picode] sessionsTree failed', String(e?.message || e));
        toast(e.message || String(e), 'error');
        return;
      }
    } else {
      toast('当前会话还没有内容', 'info');
      return;
    }
  }
  const { body } = baseModal('会话分支树', true);
  body.append(el('div', { class: 'form-hint', text: 'pi 的会话是分支树。可从任意用户消息重新分叉；当前活跃分支已标记。' }));
  const container = el('div', { style: 'font-family:var(--mono);font-size:12.3px;line-height:1.9' });
  body.append(container);

  const renderNode = (node: any, depth: number, onActivePath: boolean) => {
    const entry = node.entry || {};
    const msg = entry.message || {};
    const isMsg = entry.type === 'message';
    let label = '';
    let color = 'var(--text-faint)';
    if (isMsg) {
      const active = entry.id === leafId;
      const role = msg.role;
      if (role === 'user') { label = `👤 ${textFromContent(msg.content).slice(0, 70) || '（附件消息）'}`; color = 'var(--text)'; }
      else if (role === 'assistant') {
        const t = (msg.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');
        const tools = (msg.content || []).filter((b: any) => b.type === 'toolCall').map((b: any) => b.name);
        label = `🤖 ${t.slice(0, 60)}${tools.length ? ` 〔${tools.join(',')}〕` : ''}`;
      } else if (role === 'toolResult') { label = `⚙ 结果 ${msg.toolName || ''}`; }
      else if (role === 'bashExecution') { label = `❯ ${msg.command?.slice(0, 60)}`; }
      else if (role === 'compactionSummary') label = '🗜 压缩摘要';
      else if (role === 'branchSummary') label = '🌿 分支摘要';
      else if (role === 'system') label = '🔧 系统提示';
      else label = `· ${role || entry.type}`;
      if (active) label = `▶ ${label}`;
      const row = el('div', {
        style: `padding-left:${depth * 18}px;${entry.id === leafId ? 'color:var(--accent)' : `color:${color}`};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`,
        text: label, title: label,
      });
      container.append(row);
    } else {
      const row = el('div', { style: `padding-left:${depth * 18}px;color:var(--text-faint)`, text: `· ${entry.type}` });
      container.append(row);
    }
    for (const child of node.children || []) renderNode(child, depth + 1, onActivePath && (child.entry?.id === leafId || onActivePath));
  };
  for (const root of tree) renderNode(root, 0, true);
}

// ---------- stats ----------
async function openStatsModal(): Promise<void> {
  await refreshStats();
  const s = S.stats || {};
  const { body } = baseModal('会话用量');
  const row = (k: string, v: any) => el('div', { class: 'form-row' }, el('label', { text: k }), el('div', { class: 'grow', html: `<b>${v ?? '—'}</b>` }));
  const tokens = s.tokens || {};
  body.append(
    row('会话文件', el('span', { class: 'mono', style: 'font-size:11px', text: s.sessionFile || '—' })),
    row('消息数', `${s.userMessages ?? 0} 条用户 / ${s.assistantMessages ?? 0} 条回复 / ${s.toolCalls ?? 0} 次工具调用`),
    row('Tokens', `输入 ${fmtNum(tokens.input)} · 输出 ${fmtNum(tokens.output)} · 缓存读 ${fmtNum(tokens.cacheRead)}`),
    row('累计费用', fmtCost(s.cost) || '$0'),
    row('上下文', s.contextUsage ? `${fmtNum(s.contextUsage.tokens)} / ${fmtNum(s.contextUsage.contextWindow)}（${s.contextUsage.percent}%）` : '—'),
    row('自动压缩', S.autoCompaction ? '开启' : '关闭'),
  );
  const foot = el('div', { class: 'modal-foot' },
    el('button', { class: 'btn', text: S.autoCompaction ? '关闭自动压缩' : '开启自动压缩', onclick: async () => {
      await cmd({ type: 'set_auto_compaction', enabled: !S.autoCompaction });
      S.autoCompaction = !S.autoCompaction;
      toast(`自动压缩已${S.autoCompaction ? '开启' : '关闭'}`, 'success');
      (document.querySelector('.modal-mask .modal-close') as HTMLElement)?.click();
      openStatsModal();
    } }),
    el('button', { class: 'btn primary', text: '确定', onclick: () => (document.querySelector('.modal-mask .modal-close') as HTMLElement)?.click() }),
  );
  body.append(foot);
}

function fmtNum(n: any): string {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
}

// ---------- help ----------
function openHelp(): void {
  const { body } = baseModal('指令一览', true);
  body.append(el('div', { class: 'form-hint', text: '在输入框输入 / 唤起指令面板；输入 ! 前缀直接运行 shell 命令（输出进入对话上下文）。' }));
  const listEl = el('div');
  for (const b of BUILTINS) {
    listEl.append(el('div', { class: 'model-item' },
      el('span', { class: 'm-id', text: `/${b.name}` }),
      el('span', { class: 'm-meta', text: b.desc }),
    ));
  }
  const dynWrap = el('div');
  const groups = new Map<string, any[]>();
  for (const c of S.commands) {
    const tag = c.source === 'skill' ? '技能' : c.source === 'prompt' ? '模板' : '扩展';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag)!.push(c);
  }
  body.append(el('h4', { style: 'font-size:12px;color:var(--text-faint);margin:14px 0 6px', text: '内置指令' }), listEl);
  for (const [tag, cmds] of groups) {
    const wrap = el('div');
    for (const c of cmds) {
      wrap.append(el('div', { class: 'model-item' },
        el('span', { class: 'm-id', text: `/${c.name}` }),
        el('span', { class: 'm-meta', text: c.description || '' }),
      ));
    }
    body.append(el('h4', { style: 'font-size:12px;color:var(--text-faint);margin:14px 0 6px', text: `${tag}（来自 pi 项目/用户配置）` }), wrap);
  }
  if (!S.commands.length) {
    body.append(el('h4', { style: 'font-size:12px;color:var(--text-faint);margin:14px 0 6px', text: '扩展 / 模板 / 技能' }),
      el('div', { class: 'dim', style: 'font-size:12.5px', text: '当前没有加载扩展、提示模板或技能。把它们放入 ~/.pi/agent/extensions、prompts、skills 或项目 .pi/ 目录后，用 /reload 重启即可。' }));
  }
}

// ---------- extensions ----------
function openExtensionsModal(): void {
  const { body } = baseModal('扩展 / 模板 / 技能', true);
  if (!S.commands.length) {
    body.append(el('div', { class: 'form-hint', text: '当前没有加载任何扩展命令、提示模板或技能。' }));
  }
  const groups = new Map<string, any[]>();
  for (const c of S.commands) {
    const tag = c.source === 'skill' ? '技能（/skill:name）' : c.source === 'prompt' ? '提示模板' : '扩展命令';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag)!.push(c);
  }
  for (const [tag, cmds] of groups) {
    body.append(el('h4', { style: 'font-size:12px;color:var(--text-faint);margin:12px 0 6px', text: tag }));
    for (const c of cmds) {
      const src = c.sourceInfo?.path || '';
      body.append(el('div', { class: 'key-row' },
        el('span', { class: 'k-provider', text: `/${c.name}` }),
        el('span', { style: 'flex:1;font-size:12px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: c.description || src }),
        el('span', { class: 'k-ok', text: c.sourceInfo?.scope === 'project' ? '项目' : '用户' }),
      ));
    }
  }
  const foot = el('div', { class: 'modal-foot' },
    el('button', { class: 'btn', text: '打开 pi 配置目录', onclick: () => api.openPath(S.appInfo.agentDir) }),
  );
  body.append(foot);
}

// ---------- settings ----------
const KEY_PROVIDERS: [string, string][] = [
  ['anthropic', 'Anthropic（Claude）'],
  ['openai', 'OpenAI（GPT）'],
  ['google', 'Google Gemini'],
  ['zai', 'Z.ai 智谱'],
  ['deepseek', 'DeepSeek'],
  ['openrouter', 'OpenRouter（聚合）'],
  ['moonshotai', 'Moonshot AI'],
  ['kimi-coding', 'Kimi For Coding'],
  ['minimax', 'MiniMax'],
  ['groq', 'Groq'],
  ['xai', 'xAI（Grok）'],
  ['mistral', 'Mistral'],
  ['cerebras', 'Cerebras'],
  ['github-copilot', 'GitHub Copilot'],
  ['huggingface', 'Hugging Face'],
  ['fireworks', 'Fireworks'],
  ['vercel-ai-gateway', 'Vercel AI Gateway'],
  ['opencode', 'OpenCode'],
];

async function openSettings(): Promise<void> {
  const { body, close } = baseModal('设置', true);
  const cfg = await api.configRead();
  const configured = cfg.auth || {};

  // -- keys --
  const sec1 = el('div', { class: 'settings-section' }, el('h4', { text: 'API 密钥（保存到 pi 的 auth.json，与命令行版 pi 通用）' }));
  const keyList = el('div');
  const renderKeys = () => {
    keyList.innerHTML = '';
    const entries = Object.entries(configured).filter(([, v]: any) => v?.configured);
    if (!entries.length) keyList.append(el('div', { class: 'form-hint', text: '尚未配置任何密钥。' }));
    for (const [provider, v] of entries) {
      keyList.append(el('div', { class: 'key-row' },
        el('span', { class: 'k-provider', text: provider }),
        el('span', { class: 'k-ok', text: '已配置' }),
        el('button', { class: 'btn small danger', text: '删除', onclick: async () => {
          await api.configClearKey(provider);
          delete (configured as any)[provider];
          renderKeys();
          toast(`已删除 ${provider} 的密钥`, 'success');
        } }),
      ));
    }
  };
  renderKeys();
  sec1.append(keyList);

  const sel = el('select', { class: 'grow' }) as HTMLSelectElement;
  for (const [id, label] of KEY_PROVIDERS) sel.append(el('option', { value: id, text: `${label}（${id}）` }));
  const customOpt = el('option', { value: '__custom', text: '其他 / 自定义 ID…' });
  sel.append(customOpt);
  const keyInput = el('input', { type: 'password', class: 'grow', placeholder: '粘贴 API 密钥…', style: 'flex:1.5' }) as HTMLInputElement;
  const customInput = el('input', { type: 'text', class: 'hidden', placeholder: '供应商 ID（如 qwen、together…）', style: 'width:100%;margin-top:8px' }) as HTMLInputElement;
  sel.onchange = () => customInput.classList.toggle('hidden', sel.value !== '__custom');
  const saveBtn = el('button', { class: 'btn primary', text: '保存密钥', onclick: async () => {
    const key = keyInput.value.trim();
    if (!key) return toast('请输入密钥', 'warning');
    const provider = sel.value === '__custom' ? customInput.value.trim() : sel.value;
    if (!provider) return toast('请输入供应商 ID', 'warning');
    await api.configSetKey(provider, key);
    keyInput.value = '';
    (configured as any)[provider] = { configured: true, kind: 'api_key' };
    renderKeys();
    toast(`${provider} 密钥已保存`, 'success');
    await refreshModels();
  } });
  sec1.append(
    el('div', { class: 'form-row' }, sel, keyInput, saveBtn),
    customInput,
    el('div', { class: 'form-hint', text: '也可以改用环境变量（如 ANTHROPIC_API_KEY）：在此电脑的系统环境变量中设置后重启 PiCode 即可。' }),
  );

  // -- defaults --
  const sec2 = el('div', { class: 'settings-section' }, el('h4', { text: '启动默认' }));
  const defModel = el('div', { class: 'form-hint', text: cfg.settings?.defaultModel ? `当前默认：${cfg.settings.defaultProvider || ''}/${cfg.settings.defaultModel}` : '尚未设置默认模型（pi 自动选择）' });
  sec2.append(
    defModel,
    el('div', { class: 'form-row' },
      el('button', { class: 'btn', text: '把当前模型设为默认', onclick: async () => {
        if (!S.model) return toast('当前没有选择模型', 'warning');
        await api.configWriteSettings({ defaultProvider: S.model.provider, defaultModel: S.model.id });
        defModel.textContent = `当前默认：${S.model.provider}/${S.model.id}`;
        toast('已保存默认模型', 'success');
      } }),
      el('button', { class: 'btn', text: '选择默认模型…', onclick: async () => {
        close();
        await openModelPicker();
      } }),
    ),
  );

  // -- appearance --
  const sec3 = el('div', { class: 'settings-section' }, el('h4', { text: '外观' }));
  const themeSel = el('select') as HTMLSelectElement;
  themeSel.append(el('option', { value: 'dark', text: '深色' }), el('option', { value: 'light', text: '浅色' }));
  themeSel.value = S.prefs.theme || 'dark';
  themeSel.onchange = async () => {
    S.prefs = await api.setPrefs({ theme: themeSel.value });
    document.documentElement.setAttribute('data-theme', themeSel.value);
  };
  sec3.append(el('div', { class: 'form-row' }, el('label', { text: '主题' }), themeSel));

  // -- advanced --
  const sec4 = el('div', { class: 'settings-section' }, el('h4', { text: '高级' }));
  const trustCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
  trustCb.checked = !!S.prefs.trustProject;
  trustCb.onchange = async () => {
    S.prefs = await api.setPrefs({ trustProject: trustCb.checked });
    toast(trustCb.checked ? '已开启：下次启动 pi 将自动信任项目本地配置（--approve）' : '已关闭自动信任', 'info');
  };
  sec4.append(
    el('label', { class: 'toggle-row' }, trustCb, el('span', {}, el('span', { text: '自动信任项目配置 ' }), el('span', { class: 't-hint', text: '信任项目 .pi/ 目录中的扩展与设置；仅在打开可信项目时开启' }))),
    el('div', { class: 'form-row' },
      el('button', { class: 'btn', text: '打开 pi 数据目录', onclick: () => api.openPath(S.appInfo.agentDir) }),
      el('button', { class: 'btn', text: '查看运行日志', onclick: () => openLogModal() }),
      el('button', { class: 'btn', text: '重启 pi', onclick: async () => { close(); await doReload(); } }),
    ),
    el('div', { class: 'form-hint', html: `自定义模型端点（Ollama / LM Studio / vLLM / 各类兼容接口）：编辑 <span class="mono">models.json</span>（位于 pi 数据目录），或在 pi 数据目录安装扩展与技能。数据目录：<span class="mono">${escapeText(S.appInfo.agentDir || '')}</span>` }),
  );

  body.append(sec1, sec2, sec3, sec4);
}

async function openLogModal(): Promise<void> {
  const log = await api.diagLog();
  const { body } = baseModal('pi 运行日志（stderr 最近 50 行）', true);
  const pre = el('pre', { style: 'font-family:var(--mono);font-size:11.5px;line-height:1.6;color:var(--text-dim);white-space:pre-wrap;max-height:400px;overflow:auto', text: (log.stderr || []).join('\n') || '（无输出）' });
  body.append(el('div', { class: 'form-hint', text: `pi 状态：${log.running ? '运行中' : '已停止'} · 工作目录：${log.cwd || '—'}` }), pre);
}

// ============================== extension ui ==============================
const DIALOG_METHODS = ['select', 'confirm', 'input', 'editor'];
const extQueue: any[] = [];
let extBusy = false;

function handleExtUi(req: any): void {
  if (DIALOG_METHODS.includes(req.method)) {
    extQueue.push(req);
    pumpExtQueue();
  } else {
    handleFireAndForget(req);
  }
}

function pumpExtQueue(): void {
  if (extBusy) return;
  const req = extQueue.shift();
  if (!req) return;
  extBusy = true;
  showExtDialog(req).finally(() => {
    extBusy = false;
    pumpExtQueue();
  });
}

function showExtDialog(req: any): Promise<void> {
  const method = req.method;
  if (method === 'select') {
    return new Promise((resolve) => {
      const { body, close } = baseModal(req.title || '请选择', (req.options || []).length > 8);
      const options: any[] = req.options || [];
      options.forEach((opt: any, i: number) => {
        const label = typeof opt === 'string' ? opt : (opt.label ?? opt.name ?? JSON.stringify(opt));
        const value = typeof opt === 'string' ? opt : (opt.value ?? opt.name ?? label);
        const row = el('div', { class: 'slist-item' },
          el('div', { class: 'sl-main' }, el('div', { class: 'sl-name', text: String(label) })),
        );
        row.onclick = () => {
          api.piExtRespond({ type: 'extension_ui_response', id: req.id, value });
          close();
          resolve();
        };
        body.append(row);
      });
      const foot = el('div', { class: 'modal-foot' }, el('button', { class: 'btn', text: '取消', onclick: () => {
        api.piExtRespond({ type: 'extension_ui_response', id: req.id, cancelled: true });
        close();
        resolve();
      } }));
      body.append(foot);
    });
  }
  if (method === 'confirm') {
    return new Promise((resolve) => {
      const { body, close } = baseModal(req.title || '请确认');
      body.append(el('div', { style: 'font-size:13.5px;line-height:1.7;color:var(--text-dim)', text: req.message || '' }));
      const foot = el('div', { class: 'modal-foot' });
      foot.append(
        el('button', { class: 'btn', text: '拒绝', onclick: () => { api.piExtRespond({ type: 'extension_ui_response', id: req.id, confirmed: false }); close(); resolve(); } }),
        el('button', { class: 'btn primary', text: '允许', onclick: () => { api.piExtRespond({ type: 'extension_ui_response', id: req.id, confirmed: true }); close(); resolve(); } }),
      );
      body.append(foot);
    });
  }
  if (method === 'input' || method === 'editor') {
    return new Promise((resolve) => {
      const { body, close } = baseModal(req.title || (method === 'editor' ? '编辑文本' : '请输入'));
      const field = (method === 'editor'
        ? el('textarea', { class: 'field', style: 'width:100%;min-height:220px;resize:vertical;font-family:var(--mono);font-size:12.5px' })
        : el('input', { type: 'text', class: 'grow', style: 'width:100%' })) as HTMLInputElement;
      if (req.placeholder) field.placeholder = req.placeholder;
      if (req.prefill) field.value = req.prefill;
      body.append(field);
      const foot = el('div', { class: 'modal-foot' });
      foot.append(
        el('button', { class: 'btn', text: '取消', onclick: () => { api.piExtRespond({ type: 'extension_ui_response', id: req.id, cancelled: true }); close(); resolve(); } }),
        el('button', { class: 'btn primary', text: '确定', onclick: () => { api.piExtRespond({ type: 'extension_ui_response', id: req.id, value: field.value }); close(); resolve(); } }),
      );
      body.append(foot);
      setTimeout(() => field.focus(), 50);
    });
  }
  return Promise.resolve();
}

function handleFireAndForget(req: any): void {
  switch (req.method) {
    case 'notify': {
      const type = req.notifyType === 'warning' ? 'warning' : req.notifyType === 'error' ? 'error' : 'info';
      toast(req.message || '', type as any, type === 'error' ? 8000 : 5000);
      break;
    }
    case 'setStatus': {
      if (req.statusText) S.extStatuses.set(req.statusKey, req.statusText);
      else S.extStatuses.delete(req.statusKey);
      renderStatusbar();
      break;
    }
    case 'setWidget': {
      const w = $('ext-widget');
      if (req.widgetLines?.length) {
        w.classList.remove('hidden');
        w.textContent = req.widgetLines.join('\n');
      } else {
        w.classList.add('hidden');
        w.textContent = '';
      }
      break;
    }
    case 'setTitle': {
      if (req.title) document.title = req.title;
      break;
    }
    case 'set_editor_text': {
      const input = $('composer-input') as HTMLTextAreaElement;
      input.value = req.text || '';
      autosize();
      input.focus();
      break;
    }
    default: break;
  }
}

// ============================== welcome ==============================
function pushRecentChip(parent: HTMLElement, p: string): void {
  parent.append(el('button', { class: 'recent-chip', text: baseName(p), title: p, onclick: () => startPi(p) }));
}

async function showWelcome(): Promise<void> {
  S.phase = 'welcome';
  S.project = null;
  transcriptClear();
  $('project-name').textContent = '未选择项目';
  const wrap = el('div', { class: 'empty-state' });
  wrap.append(
    el('div', { class: 'empty-logo', text: 'π' }),
    el('div', { class: 'empty-title', text: 'PiCode' }),
    el('div', { class: 'empty-sub', html: `基于 <b>pi 编程助手</b>（pi 内核已内置，无需安装 Node.js 或 WSL）。<br/>选择一个项目文件夹即可开始：读写文件、运行命令、修改代码。` }),
    el('div', { class: 'welcome-box' },
      el('h3', { text: '① 选择项目' }),
      (() => {
        const row = el('div', { class: 'welcome-row' });
        row.append(el('button', { class: 'btn primary', text: '选择文件夹…', onclick: pickFolderAndStart }));
        const rec = el('div', { class: 'welcome-row' });
        for (const p of S.prefs.recentProjects || []) pushRecentChip(rec, p);
        if ((S.prefs.recentProjects || []).length) rec.prepend(el('span', { class: 'dim', style: 'font-size:12px;align-self:center', text: '最近：' }));
        row.append(rec);
        return row;
      })(),
      el('details', { class: 'welcome-details' },
        el('summary', { text: '② 配置 API 密钥（首次使用需要，之后可跳过）' }),
        (() => {
          const box = el('div', { class: 'form-row', style: 'margin-top:12px' });
          const sel = el('select', { class: 'grow' }) as HTMLSelectElement;
          for (const [id, label] of KEY_PROVIDERS.slice(0, 8)) sel.append(el('option', { value: id, text: label }));
          for (const [id, label] of KEY_PROVIDERS.slice(8)) sel.append(el('option', { value: id, text: label }));
          const input = el('input', { type: 'password', class: 'grow', placeholder: '粘贴 API 密钥…', style: 'flex:1.4' }) as HTMLInputElement;
          box.append(sel, input, el('button', { class: 'btn primary', text: '保存', onclick: async () => {
            if (!input.value.trim()) return toast('请输入密钥', 'warning');
            await api.configSetKey(sel.value, input.value.trim());
            input.value = '';
            toast(`${sel.value} 密钥已保存`, 'success');
          } }));
          const hint = el('div', { class: 'form-hint', text: '密钥保存在本机 pi 数据目录（auth.json）。也可以配置环境变量（如 ANTHROPIC_API_KEY）后重启。' });
          const box2 = el('div', {}, box, hint);
          return box2;
        })(),
      ),
      el('div', { style: 'margin-top:14px;display:flex;gap:8px;align-items:center' },
        el('button', { class: 'btn primary', text: '开始使用 →', onclick: pickFolderAndStart }),
        el('span', { class: 'dim', style: 'font-size:12px', text: `内置 pi v${S.appInfo.piVersion || '?'}` }),
      ),
    ),
  );
  transcriptEl().append(wrap);
}

async function pickFolderAndStart(): Promise<void> {
  const dir = await api.pickFolder();
  if (!dir) return;
  await startPi(dir);
}

// ============================== wiring ==============================
const statusLog: any[] = [];

async function onPiStatus(st: any): Promise<void> {
  statusLog.push({ ...st, at: Date.now(), phase: S.phase });
  if (statusLog.length > 50) statusLog.shift();
  if (st.state === 'exited') {
    setStreaming(false);
    if (S.intentionalStop) return;
    const tail = (st.error ? [st.error] : []).join('\n');
    if (S.phase === 'starting') {
      S.phase = 'dead';
      renderBanner(`pi 启动失败${st.code != null ? `（代码 ${st.code}）` : ''}。${tail}`);
    } else if (S.phase === 'ready') {
      S.phase = 'dead';
      renderBanner(`pi 已退出${st.code != null ? `（代码 ${st.code}）` : ''}`);
    }
  }
}

function wireEvents(): void {
  api.on('pi:event', handleEvent);
  api.on('pi:ext-ui', handleExtUi);
  api.on('pi:status', onPiStatus);

  const input = $('composer-input') as HTMLTextAreaElement;
  input.addEventListener('input', () => { autosize(); computePalette(); });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (palette.visible) {
      if (e.key === 'ArrowDown') { e.preventDefault(); palette.sel = Math.min(palette.sel + 1, palette.entries.length - 1); renderPalette(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); palette.sel = Math.max(palette.sel - 1, 0); renderPalette(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (palette.entries.length) choosePalette(palette.entries[palette.sel]);
        else hidePalette();
        return;
      }
      if (e.key === 'Escape') { hidePalette(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendCurrent();
      return;
    }
    if (e.key === 'Escape' && S.streaming) {
      e.preventDefault();
      cmd({ type: 'abort' }).catch(() => {});
      toast('已发送中断请求', 'info');
      return;
    }
    // prompt history
    if (e.key === 'ArrowUp' && !input.value) {
      e.preventDefault();
      if (S.history.length) {
        S.historyIdx = Math.max(0, S.historyIdx - 1);
        input.value = S.history[S.historyIdx] || '';
        autosize();
      }
      return;
    }
    if (e.key === 'ArrowDown' && !input.value && S.history.length) {
      e.preventDefault();
      S.historyIdx = Math.min(S.history.length, S.historyIdx + 1);
      input.value = S.history[S.historyIdx] || '';
      autosize();
      return;
    }
  });

  $('btn-send').onclick = () => {
    if (S.streaming) {
      cmd({ type: 'abort' }).catch(() => {});
      toast('已发送中断请求', 'info');
    } else {
      sendCurrent();
    }
  };

  $('btn-attach').onclick = () => $('file-input').click();
  $('file-input').onchange = (e: any) => {
    for (const f of e.target.files || []) addAttachment(f);
    e.target.value = '';
  };
  window.addEventListener('paste', (e: ClipboardEvent) => {
    const files = e.clipboardData?.files || [];
    let hit = false;
    for (const f of files) {
      if (f.type.startsWith('image/')) { addAttachment(f); hit = true; }
    }
    if (hit) e.preventDefault();
  });
  window.addEventListener('dragover', (e: DragEvent) => e.preventDefault());
  window.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    for (const f of e.dataTransfer?.files || []) {
      if (f.type.startsWith('image/')) addAttachment(f);
    }
  });

  $('btn-new-chat').onclick = () => {
    if (S.phase === 'ready') newSession();
    else toast('pi 尚未就绪', 'warning');
  };
  $('project-row').onclick = async () => {
    const dir = await api.pickFolder();
    if (!dir) return;
    if (normPath(dir) === normPath(S.project || '')) return;
    S.intentionalStop = true;
    api.piStop();
    await sleep(300);
    await startPi(dir);
  };
  $('btn-settings').onclick = () => openSettings();
  $('btn-stats').onclick = () => openStatsModal();
  $('btn-browse-sessions').onclick = () => openSessionsModal(true);
  $('pill-model').onclick = () => { if (S.phase === 'ready') openModelPicker(); };
  $('pill-thinking').onclick = () => { if (S.phase === 'ready') openThinkingPicker(); };

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      if (S.phase === 'ready') openModelPicker();
    }
    if (e.key === 'Escape' && modalStack > 0) {
      // close topmost modal
      const masks = document.querySelectorAll('.modal-mask');
      const last = masks[masks.length - 1];
      (last?.querySelector('.modal-close') as HTMLElement)?.click();
    }
  });
}

// ============================== boot ==============================
async function boot(): Promise<void> {
  S.appInfo = await api.appInfo();
  S.prefs = await api.getPrefs();
  document.documentElement.setAttribute('data-theme', S.prefs.theme || 'dark');
  $('brand-sub').textContent = `pi 内核 v${S.appInfo.piVersion || '?'} 已内置`;
  wireEvents();
  const last = S.prefs.lastProject;
  if (last) {
    await startPi(last);
  } else {
    await showWelcome();
  }
}

(window as any).__S = S; // debug handle for e2e diagnostics
(window as any).__statusLog = statusLog;
boot();
