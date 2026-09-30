// PiCode — bundled MCP (Model Context Protocol) extension for pi.
// Bridges stdio MCP servers into pi: every server tool becomes a pi tool named
// mcp__<server>__<tool>. Config lives in <agent-dir>/mcp.json and connection
// status is mirrored to <agent-dir>/mcp-status.json so PiCode's settings page
// can render it. Slash commands: /mcp (status), /mcp-reload (re-read config).
// Zero npm dependencies — speaks newline-delimited JSON-RPC 2.0 itself.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLIENT_INFO = { name: "picode-mcp", version: "1.0.0" };
const DEFAULT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 15_000;

interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	enabled?: boolean;
	timeoutMs?: number;
}

interface McpConfig {
	mcpServers?: Record<string, McpServerConfig>;
}

interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

type ServerState = "connecting" | "connected" | "error" | "disabled";

interface ServerStatus {
	state: ServerState;
	command: string;
	pid?: number;
	error?: string;
	toolCount: number;
	tools: { name: string; description?: string }[];
}

interface McpStatusFile {
	updatedAt: number;
	extension: string;
	servers: Record<string, ServerStatus>;
}

function agentDir(): string {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	return path.join(os.homedir(), ".pi", "agent");
}

const configPath = () => path.join(agentDir(), "mcp.json");
const statusPath = () => path.join(agentDir(), "mcp-status.json");

function readConfig(): McpConfig {
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function sanitizeName(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]/g, "_") || "srv";
}

// ---------------------------------------------------------------- connection
class McpClient {
	readonly name: string;
	readonly cfg: McpServerConfig;
	state: ServerState = "connecting";
	error = "";
	tools: McpToolInfo[] = [];
	private proc: ChildProcess | null = null;
	private buf = "";
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private stderrTail: string[] = [];
	private onClosed: (client: McpClient) => void;

	constructor(name: string, cfg: McpServerConfig, onClosed: (client: McpClient) => void) {
		this.name = name;
		this.cfg = cfg;
		this.onClosed = onClosed;
	}

	get timeoutMs(): number {
		return typeof this.cfg.timeoutMs === "number" && this.cfg.timeoutMs > 0 ? this.cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
	}

	status(): ServerStatus {
		return {
			state: this.state,
			command: [this.cfg.command, ...(this.cfg.args || [])].join(" "),
			pid: this.proc?.pid,
			error: this.error || undefined,
			toolCount: this.tools.length,
			tools: this.tools.map((t) => ({ name: t.name, description: t.description })),
		};
	}

	async start(): Promise<void> {
		this.state = "connecting";
		this.error = "";
		let proc: ChildProcess;
		try {
			proc = spawn(this.cfg.command, this.cfg.args || [], {
				cwd: this.cfg.cwd || undefined,
				env: { ...process.env, ...(this.cfg.env || {}) },
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (err: any) {
			this.state = "error";
			this.error = `启动失败: ${err?.message || err}`;
			throw err;
		}
		this.proc = proc;

		proc.on("error", (err) => {
			this.error = `进程错误: ${err.message}`;
			this.state = "error";
			this.failPending(new Error(this.error));
			this.onClosed(this);
		});
		proc.stderr!.on("data", (chunk: Buffer) => {
			this.stderrTail.push(chunk.toString("utf-8"));
			if (this.stderrTail.length > 20) this.stderrTail.shift();
		});
		proc.on("exit", (code, signal) => {
			if (this.state !== "error") {
				this.state = "error";
				this.error = `进程退出（${signal ?? `code ${code}`}）`;
			}
			this.proc = null;
			this.failPending(new Error(`MCP 服务器 ${this.name} 已退出`));
			this.onClosed(this);
		});
		proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));

		// MCP handshake: initialize → notifications/initialized.
		try {
			await this.request("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: CLIENT_INFO,
			}, LIST_TIMEOUT_MS);
			this.notify("notifications/initialized");
			await this.refreshTools();
			this.state = "connected";
		} catch (err: any) {
			this.state = "error";
			this.error = `初始化失败: ${err?.message || err}`;
			try { this.proc?.kill(); } catch { /* ignore */ }
			throw err;
		}
	}

	async refreshTools(): Promise<void> {
		const seen = new Set<string>();
		let cursor: string | undefined;
		const tools: McpToolInfo[] = [];
		do {
			const result = await this.request("tools/list", cursor ? { cursor } : {}, LIST_TIMEOUT_MS);
			for (const t of result?.tools || []) {
				if (t?.name && !seen.has(t.name)) {
					seen.add(t.name);
					tools.push(t);
				}
			}
			cursor = result?.nextCursor || undefined;
		} while (cursor);
		this.tools = tools;
	}

	async callTool(toolName: string, args: any): Promise<any> {
		return this.request("tools/call", { name: toolName, arguments: args ?? {} }, this.timeoutMs);
	}

	stop(): void {
		const proc = this.proc;
		this.proc = null;
		this.failPending(new Error(`MCP 服务器 ${this.name} 已断开`));
		if (!proc) return;
		try { proc.stdin?.end(); } catch { /* ignore */ }
		const killer = setTimeout(() => {
			try { proc.kill("SIGKILL"); } catch { /* ignore */ }
		}, 3000);
		proc.once("exit", () => clearTimeout(killer));
		try { proc.kill(); } catch { /* ignore */ }
	}

	private onData(chunk: Buffer): void {
		this.buf += chunk.toString("utf-8");
		let idx: number;
		while ((idx = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, idx).trim();
			this.buf = this.buf.slice(idx + 1);
			if (!line) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			this.onMessage(msg);
		}
	}

	private onMessage(msg: any): void {
		if (msg.id === undefined || msg.id === null) {
			// Server-initiated notification (e.g. tools/list_changed).
			if (msg.method === "notifications/tools/list_changed") {
				this.refreshTools().catch(() => {});
			}
			return;
		}
		const entry = this.pending.get(msg.id);
		if (!entry) return;
		this.pending.delete(msg.id);
		clearTimeout(entry.timer);
		if (msg.error) entry.reject(new Error(String(msg.error.message || msg.error.code || "MCP 请求失败")));
		else entry.resolve(msg.result);
	}

	request(method: string, params: any, timeoutMs: number): Promise<any> {
		const proc = this.proc;
		if (!proc?.stdin?.writable) return Promise.reject(new Error(`MCP 服务器 ${this.name} 未连接`));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP 请求 ${method} 超时（${timeoutMs}ms）`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
			} catch (err: any) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`写入失败: ${err?.message || err}`));
			}
		});
	}

	notify(method: string, params: any = {}): void {
		try {
			this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
		} catch { /* ignore */ }
	}

	private failPending(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}

	stderrHint(): string {
		const tail = this.stderrTail.join("").trim();
		return tail ? `\nstderr: ${tail.slice(-400)}` : "";
	}
}

// ---------------------------------------------------------------- extension
export default function picodeMcpExtension(pi: ExtensionAPI) {
	const clients = new Map<string, McpClient>();
	const registeredTools = new Map<string, string>(); // registered name → server key
	let configMtime = 0;
	let connecting = false;

	const activeServers = (): [string, McpServerConfig][] =>
		Object.entries(readConfig().mcpServers || {}).filter(([, c]) => c && c.command && c.enabled !== false);

	function writeStatus(): void {
		const servers: Record<string, ServerStatus> = {};
		for (const [name, client] of clients) servers[name] = client.status();
		const enabled = new Set(activeServers().map(([n]) => n));
		// Servers configured but not yet spawned (e.g. during startup) still show as connecting.
		for (const name of enabled) if (!servers[name]) servers[name] = { state: "connecting", command: "", toolCount: 0, tools: [] };
		for (const [name, cfg] of Object.entries(readConfig().mcpServers || {})) {
			if (!servers[name]) servers[name] = { state: cfg.enabled === false ? "disabled" : "connecting", command: cfg.command || "", toolCount: 0, tools: [] };
		}
		const payload: McpStatusFile = { updatedAt: Date.now(), extension: CLIENT_INFO.name, servers };
		try {
			fs.mkdirSync(path.dirname(statusPath()), { recursive: true });
			fs.writeFileSync(statusPath(), JSON.stringify(payload, null, 2));
		} catch { /* ignore */ }
	}

	function statusSummary(): string {
		const statuses = [...clients.values()].map((c) => c.status());
		const connected = statuses.filter((s) => s.state === "connected").length;
		const tools = statuses.reduce((n, s) => n + s.toolCount, 0);
		return `${connected}/${statuses.length} 服务器 · ${tools} 工具`;
	}

	// ExtensionAPI has no top-level UI surface; capture the freshest session
	// context so status updates survive outside event handlers (stale contexts
	// throw — swallowed by the try/catch, next session_start re-captures).
	let uiCtx: { ui: { setStatus?: (key: string, text: string) => void } } | null = null;

	function pushStatus(): void {
		writeStatus();
		try {
			uiCtx?.ui?.setStatus?.("mcp", statusSummary());
		} catch { /* ignore */ }
	}

	function registerServerTools(client: McpClient): void {
		const serverKey = sanitizeName(client.name);
		for (const tool of client.tools) {
			const toolKey = sanitizeName(tool.name);
			const fullName = `mcp__${serverKey}__${toolKey}`;
			registeredTools.set(fullName, client.name);
			pi.registerTool({
				name: fullName,
				label: `MCP ${client.name}: ${tool.name}`,
				description: tool.description || `MCP tool ${tool.name} from server ${client.name}`,
				parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as any,
				async execute(_toolCallId, params, signal) {
					try {
						const result = await client.callTool(tool.name, params);
						const content = Array.isArray(result?.content) ? result.content : [];
						const blocks = content.map((b: any) =>
							b?.type === "image" && b.data
								? { type: "image", data: b.data, mimeType: b.mimeType || "image/png" }
								: { type: "text", text: b?.type === "text" ? b.text : JSON.stringify(b) },
						);
						const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
						if (result?.isError) {
							throw new Error(text || "MCP 工具返回错误");
						}
						return {
							content: blocks.length ? blocks : [{ type: "text", text: "（MCP 工具无输出）" }],
							details: { server: client.name, tool: tool.name },
						};
					} catch (err: any) {
						signal?.throwIfAborted?.();
						throw new Error(`[${client.name}] ${err?.message || err}`);
					}
				},
			});
		}
	}

	async function connectOne(name: string, cfg: McpServerConfig): Promise<void> {
		const existing = clients.get(name);
		if (existing?.state === "connected" || existing?.state === "connecting") return;
		existing?.stop();
		const client = new McpClient(name, cfg, () => pushStatus());
		clients.set(name, client);
		try {
			await client.start();
			registerServerTools(client);
		} catch (err: any) {
			client.error = `${err?.message || err}${client.stderrHint()}`;
		}
		pushStatus();
	}

	async function connectAll(): Promise<void> {
		if (connecting) return;
		connecting = true;
		try {
			await Promise.all(activeServers().map(([name, cfg]) => connectOne(name, cfg)));
			// Drop clients whose config was removed or disabled.
			const enabled = new Set(activeServers().map(([n]) => n));
			for (const [name, client] of [...clients]) {
				if (!enabled.has(name)) {
					client.stop();
					clients.delete(name);
				}
			}
			pushStatus();
		} finally {
			connecting = false;
		}
	}

	function stopAll(): void {
		for (const [, client] of clients) client.stop();
		clients.clear();
	}

	async function reload(): Promise<void> {
		stopAll();
		await connectAll();
	}

	// ---- config file watching (light mtime poll; survives tmp+rename writes)
	function checkConfigChanged(): void {
		try {
			const mtime = fs.statSync(configPath()).mtimeMs;
			if (configMtime && Math.abs(mtime - configMtime) > 1) {
				reload().catch(() => {});
			}
			configMtime = mtime;
		} catch {
			configMtime = 0;
		}
	}
	setInterval(checkConfigChanged, 2000).unref?.();
	checkConfigChanged();

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		pushStatus();
		await connectAll();
	});

	pi.on("session_shutdown", async () => {
		stopAll();
		writeStatus();
	});

	pi.registerCommand("mcp", {
		description: "查看 MCP 服务器连接状态",
		handler: async (_args, ctx) => {
			uiCtx = ctx;
			const cfg = readConfig();
			const names = Object.keys(cfg.mcpServers || {});
			if (!names.length) {
				ctx.ui.notify("尚未配置 MCP 服务器 — 在 PiCode 设置 → MCP 中添加", "info");
				return;
			}
			const lines: string[] = [];
			for (const [name, client] of clients) {
				const s = client.status();
				const mark = s.state === "connected" ? "✓" : s.state === "connecting" ? "…" : "✕";
				lines.push(`${mark} ${name} — ${s.toolCount} 工具${s.error ? `（${s.error}）` : ""}`);
			}
			for (const name of names) {
				if (!clients.has(name)) lines.push(`· ${name} — 未连接`);
			}
			ctx.ui.notify(`MCP 状态（${statusSummary()}）\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("mcp-reload", {
		description: "重新加载 MCP 配置并重连所有服务器",
		handler: async (_args, ctx) => {
			uiCtx = ctx;
			ctx.ui.notify("正在重载 MCP …", "info");
			await reload();
			ctx.ui.notify(`MCP 已重载：${statusSummary()}`, "success");
		},
	});
}
