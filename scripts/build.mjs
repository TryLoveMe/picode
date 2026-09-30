// PiCode — build: bundle main/preload/renderer with esbuild and copy static assets.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => path.join(root, p);

fs.rmSync(r('build/renderer'), { recursive: true, force: true });
fs.mkdirSync(r('build/renderer'), { recursive: true });

await build({
  entryPoints: [r('src/main/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  outfile: r('build/main.js'),
  sourcemap: 'inline',
  logLevel: 'warning',
});

await build({
  entryPoints: [r('src/preload/preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  outfile: r('build/preload.js'),
  sourcemap: 'inline',
  logLevel: 'warning',
});

await build({
  entryPoints: [r('src/renderer/app.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  outfile: r('build/renderer/app.js'),
  sourcemap: 'inline',
  logLevel: 'warning',
});

fs.copyFileSync(r('src/renderer/index.html'), r('build/renderer/index.html'));
fs.copyFileSync(r('src/renderer/style.css'), r('build/renderer/style.css'));

// Bundled MCP extension is loaded by pi via jiti (TypeScript on disk, not bundled).
fs.rmSync(r('build/mcp-extension'), { recursive: true, force: true });
fs.mkdirSync(r('build/mcp-extension'), { recursive: true });
fs.copyFileSync(r('src/mcp-extension/index.ts'), r('build/mcp-extension/index.ts'));

console.log('build done');
