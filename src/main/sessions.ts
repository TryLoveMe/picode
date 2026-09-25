// PiCode — index pi session files (<agent-dir>/sessions/<escaped-cwd>/<ts>_<uuid>.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import { agentDir } from './config';

export interface SessionMeta {
  file: string;
  id: string;
  cwd: string;
  name: string | null;
  timestamp: string;
  mtime: number;
  size: number;
  preview: string;
}

function walkJsonl(dir: string, depth: number, out: string[]): void {
  if (depth > 3) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

function norm(p: string): string {
  return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
}

// Fallback tree builder for pi versions whose RPC lacks get_tree: parse the
// session JSONL directly and assemble the entry tree.
export function buildSessionTree(file: string): { tree: any[]; leafId: string | null } {
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const nodes = new Map<string, any>();
  const order: any[] = [];
  let leafId: string | null = null;
  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.type === 'session' || !rec.id) continue;
    const node = { entry: rec, children: [] as any[] };
    nodes.set(rec.id, node);
    order.push(node);
    leafId = rec.id;
  }
  const roots: any[] = [];
  for (const node of order) {
    const parent = node.entry.parentId ? nodes.get(node.entry.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return { tree: roots, leafId };
}

function textFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join(' ');
  }
  return '';
}

export function listSessions(filterCwd?: string): SessionMeta[] {
  const root = path.join(agentDir(), 'sessions');
  const files: string[] = [];
  walkJsonl(root, 0, files);

  const metas: SessionMeta[] = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      // Read the head of the file only: header line + a few entries for a preview.
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(64 * 1024, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const lines = buf.toString('utf-8').split('\n').filter((l) => l.trim());
      let header: any = null;
      let preview = '';
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (rec?.type === 'session') { header = rec; continue; }
          if (!preview && rec?.type === 'message' && rec?.message?.role === 'user') {
            preview = textFromContent(rec.message.content).slice(0, 160);
          }
        } catch {
          /* partial line at chunk end — ignore */
        }
        if (header && preview) break;
      }
      if (!header) continue;
      metas.push({
        file,
        id: String(header.id || path.basename(file, '.jsonl')),
        cwd: String(header.cwd || ''),
        name: header.name ?? null,
        timestamp: String(header.timestamp || ''),
        mtime: stat.mtimeMs,
        size: stat.size,
        preview,
      });
    } catch {
      /* unreadable session — skip */
    }
  }

  let result = metas;
  if (filterCwd) {
    const want = norm(filterCwd);
    result = result.filter((m) => m.cwd && norm(m.cwd) === want);
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result.slice(0, 500);
}
