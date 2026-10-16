/**
 * make-icons.mjs — كيولّد أيقونات PNG احتياطية (بلا أي مكتبة خارجية)
 *
 *   node tools/make-icons.mjs
 *
 * ⚠️ هاذي النسخة الاحتياطية: كترسم شعارًا هندسيًا (نجمة/دائرة) بلا صورة.
 *    الأيقونات الرسمية كتجي من شعار حقيقي عبر `tools/make-icons.ps1`.
 *
 * كيخرج: public/icon-192.png  public/icon-512.png
 *        public/icon-maskable-512.png  public/apple-touch-icon.png
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");

// ---------------------------------------------------------------- PNG

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
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- الرسم

const STOPS = [
  [0x42, 0x85, 0xf4],
  [0x9b, 0x72, 0xcb],
  [0xd9, 0x65, 0x70],
];

const lerp = (a, b, t) => a + (b - a) * t;

function gradient(t) {
  t = Math.max(0, Math.min(1, t));
  const [a, b, c] = STOPS;
  if (t < 0.5) {
    const k = t * 2;
    return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  }
  const k = (t - 0.5) * 2;
  return [lerp(b[0], c[0], k), lerp(b[1], c[1], k), lerp(b[2], c[2], k)];
}

// شكل فقاعة محادثة فوسط المربع
const SHAPE = { w: 0.60, h: 0.44, cy: 0.46, r: 0.14, tailW: 0.17, tailH: 0.15 };

function inTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function insideShape(x, y) {
  const { w, h, cy, r, tailW, tailH } = SHAPE;
  const left = 0.5 - w / 2;
  const right = 0.5 + w / 2;
  const top = cy - h / 2;
  const bottom = cy + h / 2;

  // مستطيل بحواف مدوّرة
  if (x >= left + r && x <= right - r && y >= top && y <= bottom) return true;
  if (y >= top + r && y <= bottom - r && x >= left && x <= right) return true;
  const corners = [
    [left + r, top + r],
    [right - r, top + r],
    [left + r, bottom - r],
    [right - r, bottom - r],
  ];
  for (const [cx, cyy] of corners) {
    if ((x - cx) ** 2 + (y - cyy) ** 2 <= r * r) return true;
  }

  // الديل (مثلث) تحت يسار
  const tx = left + 0.05;
  const ty = bottom - 0.08;
  if (
    inTriangle(
      x,
      y,
      [tx, ty],
      [tx, ty + tailH],
      [tx + tailW, ty - 0.01]
    )
  ) {
    return true;
  }
  return false;
}

function render(size, scale) {
  const SS = 3; // supersampling
  const S = size * SS;
  const acc = new Float64Array(S * S * 4);

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const x = (px + 0.5) / S;
      const y = (py + 0.5) / S;

      const g = gradient((x + y) / 2);
      const sx = 0.5 + (x - 0.5) / scale;
      const sy = 0.47 + (y - 0.47) / scale;
      const cover = insideShape(sx, sy) ? 1 : 0;

      const i = (py * S + px) * 4;
      acc[i] = lerp(g[0], 255, cover);
      acc[i + 1] = lerp(g[1], 255, cover);
      acc[i + 2] = lerp(g[2], 255, cover);
      acc[i + 3] = 255;
    }
  }

  // تصغير
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * S + (x * SS + dx)) * 4;
          r += acc[i];
          g += acc[i + 1];
          b += acc[i + 2];
          a += acc[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---------------------------------------------------------------- التشغيل

const jobs = [
  ["icon-192.png", 192, 1],
  ["icon-512.png", 512, 1],
  // maskable: خاص الشكل يبقى داخل الدايرة الآمنة (80%)
  ["icon-maskable-512.png", 512, 0.74],
  ["apple-touch-icon.png", 180, 1],
];

for (const [name, size, scale] of jobs) {
  const png = encodePng(size, size, render(size, scale));
  fs.writeFileSync(path.join(pub, name), png);
  console.log(`  ✅ ${name.padEnd(26)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log("\nتولّدو الأيقونات فـ public/");
