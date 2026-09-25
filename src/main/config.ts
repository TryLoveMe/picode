// PiCode — pi configuration (agent dir) read/write helpers.
// pi stores its own config under <agent-dir> (default ~/.pi/agent):
//   settings.json — user settings;  auth.json — API keys / OAuth tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function agentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  return path.join(os.homedir(), '.pi', 'agent');
}

export function bundledCliPath(): string {
  // build/main.js → project root → node_modules/... (real dir in dev,
  // app.asar.unpacked/... in the packaged app since node_modules is unpacked).
  const candidate = path.resolve(__dirname, '..', 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'cli.js');
  return candidate.replace('app.asar', 'app.asar.unpacked');
}

export function piVersion(): string {
  try {
    const pkg = path.resolve(__dirname, '..', 'node_modules', '@mariozechner', 'pi-coding-agent', 'package.json').replace('app.asar', 'app.asar.unpacked');
    return JSON.parse(fs.readFileSync(pkg, 'utf-8')).version || '?';
  } catch {
    return '?';
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.picode-tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

export function readSettings(): any {
  return readJson(path.join(agentDir(), 'settings.json')) || {};
}

export function writeSettings(patch: Record<string, any>): any {
  const current = readSettings();
  const merged = { ...current, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete merged[k];
  writeJson(path.join(agentDir(), 'settings.json'), merged);
  return merged;
}

export function readAuth(): any {
  return readJson(path.join(agentDir(), 'auth.json')) || {};
}

export function setProviderKey(provider: string, key: string): void {
  const auth = readAuth();
  const existing = auth[provider];
  if (existing && typeof existing === 'object' && existing.type === 'api_key') {
    existing.key = key;
  } else {
    auth[provider] = { type: 'api_key', key };
  }
  writeJson(path.join(agentDir(), 'auth.json'), auth);
}

export function clearProviderKey(provider: string): void {
  const auth = readAuth();
  delete auth[provider];
  writeJson(path.join(agentDir(), 'auth.json'), auth);
}

export function maskAuth(): Record<string, { configured: boolean; kind: string }> {
  const auth = readAuth();
  const out: Record<string, { configured: boolean; kind: string }> = {};
  for (const [provider, entry] of Object.entries(auth)) {
    const e = entry as any;
    if (e && typeof e === 'object') {
      out[provider] = { configured: Boolean(e.key || e.refresh || e.accessToken), kind: e.type || 'unknown' };
    } else if (typeof entry === 'string') {
      out[provider] = { configured: Boolean(entry), kind: 'api_key' };
    }
  }
  return out;
}
