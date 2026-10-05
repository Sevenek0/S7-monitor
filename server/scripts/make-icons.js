/**
 * Generuje ikony PNG/ICO bez zewnętrznych narzędzi (własny rasteryzator + enkoder PNG).
 *   node scripts/make-icons.js
 * Wynik: server/public/icons/*  oraz  desktop/build/* (icon.ico, icon.png, tray-*.png)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_WEB = path.join(ROOT, 'server', 'public', 'icons');
const OUT_DESK = path.join(ROOT, 'desktop', 'build');
const OUT_TRAY = path.join(ROOT, 'desktop', 'assets');

// ---------- PNG ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function encodeIco(pngs) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

// ---------- rasteryzacja (współrzędne 0..1, supersampling 4×4) ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function sdRoundRect(x, y, half, r) { const qx = Math.abs(x - 0.5) - half + r; const qy = Math.abs(y - 0.5) - half + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; }
function distSeg(px, py, ax, ay, bx, by) { const dx = bx - ax; const dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - ax - t * dx, py - ay - t * dy); }
const ECG = [[0.14, 0.54], [0.34, 0.54], [0.42, 0.34], [0.51, 0.72], [0.60, 0.26], [0.68, 0.54], [0.86, 0.54]];
function distEcg(x, y, scale = 1) {
  let d = Infinity;
  for (let i = 0; i < ECG.length - 1; i++) {
    const [ax, ay] = ECG[i].map((v) => 0.5 + (v - 0.5) * scale); const [bx, by] = ECG[i + 1].map((v) => 0.5 + (v - 0.5) * scale);
    d = Math.min(d, distSeg(x, y, ax, ay, bx, by));
  }
  return d;
}

/** layers(x, y) → [r,g,b,a] (0..255, a 0..1) dla punktu; renderowane z supersamplingiem. */
function render(size, shade) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const [cr, cg, cb, ca] = shade((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size);
      r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
    }
    const o = (py * size + px) * 4;
    buf[o] = a ? Math.round(r / a) : 0; buf[o + 1] = a ? Math.round(g / a) : 0; buf[o + 2] = a ? Math.round(b / a) : 0; buf[o + 3] = Math.round((a / (S * S)) * 255);
  }
  return encodePng(size, buf);
}

const TOP = hex('#3987e5'); const BOTTOM = hex('#184f95'); const WHITE = [255, 255, 255];
const lerp = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * t);
const over = (base, top, alpha) => (alpha <= 0 ? base : [...lerp(base.slice(0, 3), top, alpha), Math.max(base[3], alpha)]);

function appShade({ rounded = true, content = 1, line = 0.075 } = {}) {
  return (x, y) => {
    const inside = rounded ? sdRoundRect(x, y, 0.5, 0.22) <= 0 : true;
    if (!inside) return [0, 0, 0, 0];
    let c = [...lerp(TOP, BOTTOM, y), 1];
    if (distEcg(x, y, content) <= line * content) c = over(c, WHITE, 1);
    return c;
  };
}
const badgeShade = (x, y) => (distEcg(x, y, 1.05) <= 0.09 ? [255, 255, 255, 1] : [0, 0, 0, 0]);
const trayShade = (color) => (x, y) => {
  const d = Math.hypot(x - 0.5, y - 0.5);
  if (d > 0.48) return [0, 0, 0, 0];
  let c = [...hex(color), 1];
  if (distEcg(x, y, 0.95) <= 0.085) c = over(c, WHITE, 1);
  return c;
};

fs.mkdirSync(OUT_WEB, { recursive: true });
const web = {
  'icon-192.png': render(192, appShade()),
  'icon-512.png': render(512, appShade()),
  'maskable-512.png': render(512, appShade({ rounded: false, content: 0.72 })),
  'apple-touch-icon.png': render(180, appShade({ rounded: false, content: 0.86 })),
  'favicon-32.png': render(32, appShade({ line: 0.09 })),
  'badge-72.png': render(72, badgeShade),
};
for (const [n, d] of Object.entries(web)) fs.writeFileSync(path.join(OUT_WEB, n), d);

if (fs.existsSync(path.dirname(OUT_DESK))) {
  fs.mkdirSync(OUT_DESK, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => ({ size: s, data: render(s, appShade({ line: s <= 32 ? 0.1 : 0.075 })) }));
  fs.writeFileSync(path.join(OUT_DESK, 'icon.ico'), encodeIco(pngs));
  fs.writeFileSync(path.join(OUT_DESK, 'icon.png'), render(512, appShade()));
  fs.mkdirSync(OUT_TRAY, { recursive: true });
  fs.writeFileSync(path.join(OUT_TRAY, 'icon.png'), render(256, appShade()));
  for (const [name, color] of [['green', '#0ca30c'], ['red', '#d03b3b'], ['gray', '#6b6c72']]) {
    fs.mkdirSync(OUT_TRAY, { recursive: true });
    fs.writeFileSync(path.join(OUT_TRAY, `tray-${name}.png`), render(16, trayShade(color)));
    fs.writeFileSync(path.join(OUT_TRAY, `tray-${name}@2x.png`), render(32, trayShade(color)));
  }
}
console.log('Ikony wygenerowane.');
