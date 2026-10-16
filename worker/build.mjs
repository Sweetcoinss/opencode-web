/**
 * build.mjs — كيدمج public/* + handler.js فملف واحد: dist/worker.js
 *
 * هاد الملف الواحد هو اللي كيتنشر على Cloudflare Workers
 * (كيصلح حتى للّصق المباشر فلوحة Cloudflare).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pubDir = path.join(here, "..", "public");
const outDir = path.join(here, "dist");

const assets = {};
let total = 0;
for (const name of fs.readdirSync(pubDir).sort()) {
  const full = path.join(pubDir, name);
  if (!fs.statSync(full).isFile()) continue;
  const text = fs.readFileSync(full, "utf8");
  assets[name] = text;
  total += Buffer.byteLength(text);
}

const handler = fs.readFileSync(path.join(here, "handler.js"), "utf8");

const out = `/* ⚠️ ملف مولّد أوتوماتيكيًا — ما تعدّلوش باليد.
 * المصدر: worker/handler.js  +  public/*
 * التوليد: node worker/build.mjs
 * التاريخ: ${new Date().toISOString()}
 * الملفات: ${Object.keys(assets).join(", ")}
 */

const ASSETS = ${JSON.stringify(assets)};

${handler}`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "worker.js"), out, "utf8");

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(`✅ تولّد: worker/dist/worker.js  (${kb(Buffer.byteLength(out))})`);
console.log(`   الملفات المدمجة: ${Object.keys(assets).length}  (${kb(total)})`);
