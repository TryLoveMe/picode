// PiCode — generate app icon (rounded square + π glyph) as PNG + ICO, pure Node.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------- minimal PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- drawing ----------
function makeIcon(size) {
  const S = 4; // supersample
  const W = size * S;
  const px = Buffer.alloc(W * W * 4);
  const bg1 = [224, 128, 82]; // top-left
  const bg2 = [172, 84, 48]; // bottom-right
  const white = [255, 255, 255];

  const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + r, Math.min(x, x1 - r));
    const cy = Math.max(y0 + r, Math.min(y, y1 - r));
    const dx = x - cx, dy = y - cy;
    if (dx === 0 && dy === 0) return true;
    return dx * dx + dy * dy <= r * r;
  };

  // π glyph geometry in unit space (icon box 0..1)
  const bar = { x0: 0.22, y0: 0.28, x1: 0.78, y1: 0.40, r: 0.045 };
  const legL = { x0: 0.315, y0: 0.40, x1: 0.44, y1: 0.76, r: 0.05 };
  const legR = { x0: 0.56, y0: 0.40, x1: 0.685, y1: 0.76, r: 0.05 };

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / W;
      // rounded-square background over full box
      const bg = inRoundedRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.21);
      if (!bg) {
        // transparent
        const i = (y * W + x) * 4;
        px[i + 3] = 0;
        continue;
      }
      // vertical gradient
      const t = v;
      const c = [
        Math.round(bg1[0] + (bg2[0] - bg1[0]) * t),
        Math.round(bg1[1] + (bg2[1] - bg1[1]) * t),
        Math.round(bg1[2] + (bg2[2] - bg1[2]) * t),
      ];
      // glyph coverage: supersample the glyph edges by drawing at this resolution directly
      let glyph = false;
      if (inRoundedRect(u, v, bar.x0, bar.y0, bar.x1, bar.y1, bar.r)) glyph = true;
      if (inRoundedRect(u, v, legL.x0, legL.y0, legL.x1, legL.y1, legL.r)) glyph = true;
      if (inRoundedRect(u, v, legR.x0, legR.y0, legR.x1, legR.y1, legR.r)) glyph = true;
      const col = glyph ? white : c;
      const i = (y * W + x) * 4;
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255;
    }
  }

  // downsample S×S → size
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * W + (x * S + sx)) * 4;
          const alpha = px[i + 3] / 255;
          r += px[i] * alpha; g += px[i + 1] * alpha; b += px[i + 2] * alpha;
          a += px[i + 3];
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      const aa = a / n / 255;
      out[o] = aa > 0 ? Math.round(r / n / aa) : 0;
      out[o + 1] = aa > 0 ? Math.round(g / n / aa) : 0;
      out[o + 2] = aa > 0 ? Math.round(b / n / aa) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, out);
}

// ---------- ICO writer (PNG-compressed entries) ----------
function makeIco(pngs) {
  // pngs: [{size, buf}]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type icon
  header.writeUInt16LE(pngs.length, 4);
  const dirSize = 16 * pngs.length;
  let offset = 6 + dirSize;
  const dirs = [];
  for (const { size, buf } of pngs) {
    const d = Buffer.alloc(16);
    d[0] = size === 256 ? 0 : size;
    d[1] = size === 256 ? 0 : size;
    d[2] = 0; d[3] = 0;
    d.writeUInt16LE(1, 4); // planes
    d.writeUInt16LE(32, 6); // bpp
    d.writeUInt32LE(buf.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += buf.length;
    dirs.push(d);
  }
  return Buffer.concat([header, ...dirs, ...pngs.map((p) => p.buf)]);
}

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const sizes = [256, 128, 64, 48, 32, 24, 16];
const pngs = sizes.map((size) => ({ size, buf: makeIcon(size) }));
fs.writeFileSync(path.join(outDir, 'icon.ico'), makeIco(pngs));
fs.writeFileSync(path.join(outDir, 'icon.png'), pngs.find((p) => p.size === 256).buf);
console.log('icons written to build/icon.ico + build/icon.png');
