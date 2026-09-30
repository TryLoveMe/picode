// PiCode — scans pi resource directories (skills, extensions) so the settings
// page can list what's installed without going through the pi subprocess.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentDir } from './config';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'project';
  kind: 'directory' | 'file';
}

export interface ExtensionFileInfo {
  name: string;
  path: string;
  scope: 'user' | 'project';
  kind: 'file' | 'directory';
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\r?\n([\s\S]{0,4000}?)\r?\n---/);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (kv[1] === 'name') out.name = value;
    else out.description = value;
  }
  return out;
}

function readSkillName(dir: string, file: string): { name: string; description: string } | null {
  try {
    const head = fs.readFileSync(file, 'utf-8').slice(0, 8192);
    const meta = parseFrontmatter(head);
    return {
      name: meta.name || path.basename(dir === file ? file : dir),
      description: meta.description || '',
    };
  } catch {
    return null;
  }
}

function scanSkillsDir(root: string, scope: 'user' | 'project', out: SkillInfo[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      // Root .md files are discovered as individual skills (agent/skills dirs).
      const info = readSkillName(full, full);
      if (info) out.push({ name: info.name, description: info.description, path: full, scope, kind: 'file' });
    } else if (entry.isDirectory() && entry.name !== 'node_modules') {
      const skillMd = findSkillMd(full, 0);
      if (skillMd) {
        const info = readSkillName(full, skillMd);
        if (info) out.push({ name: info.name, description: info.description, path: full, scope, kind: 'directory' });
      }
    }
  }
}

function findSkillMd(dir: string, depth: number): string | null {
  const direct = path.join(dir, 'SKILL.md');
  if (fs.existsSync(direct)) return direct;
  if (depth >= 2) return null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        const hit = findSkillMd(path.join(dir, entry.name), depth + 1);
        if (hit) return hit;
      }
    }
  } catch { /* ignore */ }
  return null;
}

export function listSkills(cwd?: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  const dirs: [string, 'user' | 'project'][] = [
    [path.join(agentDir(), 'skills'), 'user'],
    [path.join(os.homedir(), '.agents', 'skills'), 'user'],
  ];
  if (cwd) {
    dirs.push([path.join(cwd, '.pi', 'skills'), 'project']);
    dirs.push([path.join(cwd, '.agents', 'skills'), 'project']);
  }
  for (const [dir, scope] of dirs) scanSkillsDir(dir, scope, out);
  return out;
}

function scanExtensionsDir(root: string, scope: 'user' | 'project', out: ExtensionFileInfo[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isFile() && /\.(ts|js|mts|mjs)$/i.test(entry.name)) {
      out.push({ name: entry.name, path: full, scope, kind: 'file' });
    } else if (entry.isDirectory() && entry.name !== 'node_modules') {
      if (fs.existsSync(path.join(full, 'index.ts')) || fs.existsSync(path.join(full, 'index.js'))) {
        out.push({ name: entry.name, path: full, scope, kind: 'directory' });
      }
    }
  }
}

export function listExtensions(cwd?: string): ExtensionFileInfo[] {
  const out: ExtensionFileInfo[] = [];
  scanExtensionsDir(path.join(agentDir(), 'extensions'), 'user', out);
  if (cwd) scanExtensionsDir(path.join(cwd, '.pi', 'extensions'), 'project', out);
  return out;
}
