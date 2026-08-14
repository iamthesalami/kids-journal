// One-off build tool (not part of the app itself) — generates the PNG icon
// files the manifest and index.html need. Run with: node generate-icons.js
// No dependencies beyond Node's built-in zlib (used for PNG's DEFLATE stream).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [58, 44, 30, 255]; // #3a2c1e dark ink-brown, matches the diary's parchment/ink palette
const WHITE = [246, 241, 231, 255]; // #f6f1e7 parchment

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Draws a simple flat "camera" glyph (body + viewfinder bump + lens ring)
// on a solid background, using normalized 0..1 coordinates.
function pixelColor(nx, ny) {
  // Lens (two concentric circles: coral ring, white center) drawn last so
  // it sits on top of the camera body.
  if (inCircle(nx, ny, 0.5, 0.53, 0.15)) {
    if (inCircle(nx, ny, 0.5, 0.53, 0.085)) return WHITE;
    return BG;
  }
  // Viewfinder bump on top of the body.
  if (inRect(nx, ny, 0.40, 0.24, 0.60, 0.34)) return WHITE;
  // Camera body.
  if (inRect(nx, ny, 0.17, 0.32, 0.83, 0.74)) return WHITE;
  return BG;
}

// Same glyph but scaled down (bigger safe margin) for maskable icons, since
// Android/other OSes crop maskable icons to a circle and may clip content
// near the edges.
function pixelColorMaskable(nx, ny) {
  // Map the visible 0..1 canvas into a smaller centered 0.2..0.8 "safe zone"
  // and reuse the normal glyph logic there.
  const scaled = (v) => 0.2 + v * 0.6;
  const sx = (nx - 0.2) / 0.6;
  const sy = (ny - 0.2) / 0.6;
  if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return BG;
  return pixelColor(sx, sy);
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(size, colorFn) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = colorFn((x + 0.5) / size, (y + 0.5) / size);
      const off = rowStart + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  ['icon-192.png', 192, pixelColor],
  ['icon-512.png', 512, pixelColor],
  ['apple-touch-icon.png', 180, pixelColor],
  ['maskable-512.png', 512, pixelColorMaskable],
];

for (const [name, size, fn] of targets) {
  fs.writeFileSync(path.join(outDir, name), encodePNG(size, fn));
  console.log('wrote', name);
}
