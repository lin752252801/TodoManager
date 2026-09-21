// 生成 build/icon.ico 与 resources/icons/tray.png（无外部依赖，手写 PNG 编码器）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const px = Buffer.alloc(SIZE * SIZE * 4, 0);

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return;
  const i = (y * SIZE + x) * 4;
  const sa = Math.min(1, a / 255);
  const da = px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

function coverage(d) {
  // d 为到形状边缘的像素距离，负值在内部
  return Math.max(0, Math.min(1, 0.5 - d));
}

function distToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

const RADIUS = 56;
const INSET = 24;
const box = { x0: INSET, y0: INSET, x1: SIZE - INSET, y1: SIZE - INSET };

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.max(box.x0 + RADIUS, Math.min(x, box.x1 - RADIUS));
    const cy = Math.max(box.y0 + RADIUS, Math.min(y, box.y1 - RADIUS));
    const d = Math.hypot(x - cx, y - cy) - RADIUS;
    const a = coverage(d);
    if (a <= 0) continue;
    const t = (y - box.y0) / (box.y1 - box.y0);
    set(x, y, Math.round(0x2f + 0x12 * t), Math.round(0x6e + 0x14 * t), Math.round(0xf0 + 0x06 * t), a * 255);
  }
}

// 白色对勾
const stroke = 22;
const seg = [
  [86, 132, 118, 164],
  [118, 164, 176, 104]
];
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let d = Infinity;
    for (const [ax, ay, bx, by] of seg) d = Math.min(d, distToSegment(x + 0.5, y + 0.5, ax, ay, bx, by));
    const a = coverage(d - stroke / 2);
    if (a > 0) set(x, y, 255, 255, 255, a * 255);
  }
}

const CRC_TABLE = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const png = encodePNG(SIZE, SIZE, px);

const outPng = path.join(__dirname, '..', 'resources', 'icons', 'tray.png');
fs.mkdirSync(path.dirname(outPng), { recursive: true });
fs.writeFileSync(outPng, png);

const dir = Buffer.alloc(16);
dir.writeUInt16LE(SIZE === 256 ? 0 : SIZE, 0);
dir.writeUInt16LE(SIZE === 256 ? 0 : SIZE, 2);
dir.writeUInt16LE(1, 4);
dir.writeUInt16LE(32, 6);
dir.writeUInt32LE(png.length, 8);
dir.writeUInt32LE(22, 12);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const outIco = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(outIco), { recursive: true });
fs.writeFileSync(outIco, Buffer.concat([header, dir, png]));

console.log('icon written:', outPng, png.length, 'bytes /', outIco);
