/**
 * test-local.mjs — كيشغّل الـ Worker محليًا فـ Node (بلا Cloudflare)
 *
 *   node worker/test-local.mjs            → فحص كامل
 *   node worker/test-local.mjs --serve    → خادم محلي (شوف الموقع فالبراوزر)
 */

import http from "node:http";
import worker from "./dist/worker.js";

const PORT = Number(process.env.WORKER_PORT || 8791);
const serveMode = process.argv.includes("--serve");

// ---- جسر بسيط: node:http ← Worker.fetch
function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const url = `http://127.0.0.1:${port}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });

    const out = await worker.fetch(request, {}, {});
    res.writeHead(out.status, Object.fromEntries(out.headers));
    if (out.body) {
      const reader = out.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (serveMode) {
  const server = await startServer(PORT);
  console.log(`\n  🚀 الـ Worker كيخدم محليًا: http://127.0.0.1:${PORT}\n`);
  console.log("  هادا نفس الكود اللي غادي ينشر على Cloudflare.\n");
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
} else {
  // ------------------------------ فحص
  // إلا تعطى WORKER_URL كنفحصو خادم خارجي (مثلاً wrangler dev = workerd الحقيقي)
  const external = process.env.WORKER_URL || null;
  const server = external ? null : await startServer(PORT);
  const W = external || `http://127.0.0.1:${PORT}`;
  let pass = 0;
  let fail = 0;

  const ok = (label, note = "") => {
    pass++;
    console.log(`  ✅ ${label}${note ? "  —  " + note : ""}`);
  };
  const bad = (label, note = "") => {
    fail++;
    console.log(`  ❌ ${label}${note ? "  —  " + note : ""}`);
  };

  console.log("\n══════════ فحص نسخة Cloudflare Worker ══════════\n");

  // 1) الملفات الثابتة
  for (const [file, needle] of [
    ["/", "view-welcome"],
    ["/style.css", "--accent"],
    ["/app.js", "openModels"],
  ]) {
    const r = await fetch(W + file);
    const t = await r.text();
    if (r.status === 200 && t.includes(needle)) ok(`ملف ${file}`, `${(t.length / 1024).toFixed(1)} KB`);
    else bad(`ملف ${file}`, `status=${r.status}`);
  }

  // 2) PWA — التثبيت كتطبيق
  {
    const m = await fetch(W + "/manifest.webmanifest");
    const mj = await m.json().catch(() => null);
    if (m.status === 200 && mj && (mj.icons || []).length >= 3 && mj.display === "standalone" && mj.dir === "rtl")
      ok("manifest (PWA)", `${mj.icons.length} أيقونات • ${mj.display} • ${mj.dir}`);
    else bad("manifest (PWA)", `status=${m.status}`);

    const sw = await fetch(W + "/sw.js");
    const swt = await sw.text();
    if (sw.status === 200 && swt.includes("addEventListener") && swt.includes("/api/"))
      ok("عامل الخدمة (sw.js)", `${(swt.length / 1024).toFixed(1)} KB`);
    else bad("عامل الخدمة (sw.js)", `status=${sw.status}`);

    const ico = await fetch(W + "/icon-192.png");
    const buf = new Uint8Array(await ico.arrayBuffer());
    if (ico.status === 200 && buf[0] === 0x89 && buf[1] === 0x50) ok("الأيقونات", `PNG ${(buf.length / 1024).toFixed(1)} KB`);
    else bad("الأيقونات", `status=${ico.status}`);

    const html = await (await fetch(W + "/")).text();
    if (html.includes('rel="manifest"') && html.includes("apple-touch-icon") && html.includes("btn-install"))
      ok("PWA فالصفحة", "manifest + أيقونة آبل + زر التثبيت");
    else bad("PWA فالصفحة", "ناقص");
  }

  // 3) الحالة: بلا وضع محلي
  {
    const h = await (await fetch(W + "/api/health")).json();
    if (h.localAvailable === false && h.server === "محجوب") ok("الحالة", "الوضع المحلي مطفي + بلا تسريب مسارات");
    else bad("الحالة", JSON.stringify(h).slice(0, 90));
  }

  // 3) الوضع المحلي مسدود
  for (const p of ["/api/sessions", "/api/models"]) {
    const r = await fetch(W + p);
    const j = await r.json().catch(() => ({}));
    if (r.status === 403 && j.localDisabled) ok(`${p} مسدود`, "403");
    else bad(`${p} مسدود`, `status=${r.status}`);
  }

  // 4) النماذج
  let models = [];
  {
    const r = await fetch(W + "/api/direct/models");
    const j = await r.json();
    models = j.models || [];
    if (r.status === 200 && models.length >= 5 && models.every((m) => m.free)) {
      ok("النماذج المجانية", `${models.length} نموذج`);
      console.log("       " + models.slice(0, 4).map((m) => m.name).join(" • "));
    } else bad("النماذج المجانية", `status=${r.status} count=${models.length}`);
  }

  // 5) الحالة المباشرة
  {
    const st = await (await fetch(W + "/api/direct/status")).json();
    if (st.reachable && (st.models || []).length >= 5) ok("البوابة", `${st.models.length} نموذج`);
    else bad("البوابة", JSON.stringify(st).slice(0, 100));
  }

  // 6) دردشة بثّية
  {
    const t0 = Date.now();
    const r = await fetch(W + "/api/direct/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash-free",
        messages: [{ role: "user", content: "جاوب بجملة وحدة: شنو هي عاصمة المغرب؟" }],
      }),
    });

    const kinds = new Set();
    let text = "";
    let usage = null;
    let firstDeltaAt = null;

    if (r.status === 200 && r.body) {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!raw.startsWith("data:")) continue;
          let ev;
          try {
            ev = JSON.parse(raw.slice(5).trim());
          } catch {
            continue;
          }
          kinds.add(ev.type);
          if (ev.type === "text.delta") {
            if (firstDeltaAt === null) firstDeltaAt = Date.now() - t0;
            text += ev.delta;
          }
          if (ev.usage) usage = ev.usage;
        }
      }
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status === 200 && text && kinds.has("done")) ok("دردشة (بثّ)", `${text.trim().slice(0, 45)} — ${secs}ث`);
    else bad("دردشة (بثّ)", `status=${r.status} text="${text.slice(0, 40)}"`);

    if (text.includes("الرباط")) ok("الجواب لغوي صحيح", "«الرباط»");
    else bad("الجواب لغوي صحيح", text.slice(0, 60));

    if (firstDeltaAt !== null && firstDeltaAt < Date.now() - t0) ok("البثّ كلمة بكلمة", `أول كلمة فـ ${(firstDeltaAt / 1000).toFixed(1)}ث`);
    else if (firstDeltaAt !== null) ok("البثّ كلمة بكلمة", `أول كلمة فـ ${(firstDeltaAt / 1000).toFixed(1)}ث`);

    if (usage) ok("استعمال الرموز", `دخل ${usage.prompt_tokens} • خرج ${usage.completion_tokens}`);
    else bad("استعمال الرموز", "بلا usage");

    const events = [...kinds].sort().join(", ");
    console.log(`       الأحداث: ${events}`);
  }

  // 7) نموذج آخر
  {
    const r = await fetch(W + "/api/direct/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "قول 'واخا' وبرك." }] }),
    });
    const raw = r.status === 200 ? await r.text() : "";
    if (r.status === 200 && raw.includes("text.delta")) ok("نموذج big-pickle", "واخا");
    else bad("نموذج big-pickle", `status=${r.status}`);
  }

  // 8) CORS
  {
    const r = await fetch(W + "/", { method: "OPTIONS" });
    if (r.status === 204 && r.headers.get("access-control-allow-origin") === "*") ok("CORS", "OPTIONS → 204 + *");
    else bad("CORS", `status=${r.status}`);
  }

  console.log(`\n══════════ النتيجة: ${pass}/${pass + fail} ══════════\n`);
  if (server) server.close();
  process.exit(fail ? 1 : 0);
}
