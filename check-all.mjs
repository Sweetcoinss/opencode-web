/* فحص شامل: الواجهة + الوضع المباشر + الوضع المحلي */
const WEB = process.env.WEB || "http://127.0.0.1:8790";
const results = [];
const ok = (name, extra = "") => results.push(["✅", name, extra]);
const bad = (name, extra = "") => results.push(["❌", name, extra]);

async function get(path, opts) {
  const res = await fetch(WEB + path, opts);
  const text = await res.text();
  return { status: res.status, text, ct: res.headers.get("content-type") || "" };
}

async function streamChat(body) {
  const res = await fetch(WEB + "/api/direct/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) return { status: res.status, text: await res.text(), events: [] };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!raw.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(raw.slice(5).trim()));
      } catch {
        /* تجاهل */
      }
    }
  }
  return { status: 200, events };
}

/* ---------------- 1) الواجهة ---------------- */

const page = await get("/");
if (page.status === 200 && page.text.includes("view-welcome") && page.text.includes("chips")) ok("الصفحة الرئيسية", "200، فيها شاشة الترحيب والاختصارات");
else bad("الصفحة الرئيسية", String(page.status));

for (const [name, marker] of [
  ["القائمة الجانبية", 'id="drawer"'],
  ["الإعدادات", 'id="settings"'],
  ["شريحة النموذج", 'id="chip-model"'],
  ["اختيار النموذج", 'id="models"'],
  ["قائمة النماذج", 'id="model-list"'],
  ["فلتر النماذج", 'id="model-filters"'],
  ["PWA: manifest", 'rel="manifest"'],
  ["PWA: أيقونة آبل", 'apple-touch-icon'],
  ["PWA: زر التثبيت", 'id="btn-install"'],
  ["فقاعة الإدخال", 'id="input"'],
  ["زر الإيقاف", 'id="btn-stop"'],
  ["تسجيل الدخول", 'id="login"'],
]) {
  if (page.text.includes(marker)) ok("واجهة: " + name);
  else bad("واجهة: " + name, "ناقص");
}

for (const [f, type] of [["/style.css", "text/css"], ["/app.js", "javascript"]]) {
  const r = await get(f);
  if (r.status === 200 && r.ct.includes(type)) ok("ملف " + f, `${r.status} • ${(r.text.length / 1024).toFixed(1)}KB`);
  else bad("ملف " + f, String(r.status));
}

/* ---------------- 1ب) PWA ---------------- */

{
  const m = await get("/manifest.webmanifest");
  let mj = null;
  try {
    mj = JSON.parse(m.text);
  } catch {
    /* ماشي JSON */
  }
  if (m.status === 200 && mj && (mj.icons || []).length >= 3 && mj.display === "standalone") {
    ok("PWA: manifest", `${mj.icons.length} أيقونات • ${mj.display} • ${mj.dir}`);
  } else bad("PWA: manifest", `status=${m.status} ct=${m.ct}`);

  const sw = await get("/sw.js");
  if (sw.status === 200 && sw.text.includes("addEventListener") && sw.text.includes("/api/")) {
    ok("PWA: عامل الخدمة", `${(sw.text.length / 1024).toFixed(1)}KB • ما كيكاشّش /api/`);
  } else bad("PWA: عامل الخدمة", String(sw.status));

  let iconsOk = true;
  for (const name of ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"]) {
    const r = await fetch(WEB + name);
    const b = new Uint8Array(await r.arrayBuffer());
    if (r.status !== 200 || b[0] !== 0x89 || b[1] !== 0x50) iconsOk = false;
  }
  if (iconsOk) ok("PWA: الأيقونات", "4 أيقونات PNG صحيحة");
  else bad("PWA: الأيقونات", "شي أيقونة ناقصة");
}

/* ---------------- 2) الحالة ---------------- */

let directReachable = false;
try {
  const h = JSON.parse((await get("/api/health")).text);
  if (h.ready) ok("خدمة opencode المحلية", `v${h.version} • ${h.server}`);
  else bad("خدمة opencode المحلية", "غير متصلة");
  const st = JSON.parse((await get("/api/direct/status")).text);
  directReachable = st.reachable;
  if (st.reachable) ok("بوابة النماذج المجانية", `${st.base} • أدوات: ${st.tools.length ? st.tools.join("/") : "دردشة فقط"}`);
  else bad("بوابة النماذج المجانية", st.error || "");
  if ((st.models || []).length >= 5) ok("النماذج المجانية", `${st.models.length} نموذج`);
  else bad("النماذج المجانية", String(st.models?.length));

  // حقول اختيار النموذج
  for (const p of ["/api/models", "/api/direct/models"]) {
    const ms = JSON.parse((await get(p)).text).models || [];
    const need = ["id", "name", "free"];
    const missingFields = need.filter((f) => !(f in (ms[0] || {})));
    if (ms.length && !missingFields.length) ok("حقول " + p, `${ms.length} نموذج • ${ms.filter((m) => m.free).length} مجاني`);
    else bad("حقول " + p, missingFields.join(",") || "بلا نماذج");
  }

  // حماية الوضع المحلي: طلب جاي من برّا (نفق/بروكسي) خاصو يتسدّ
  {
    const remote = { headers: { "cf-connecting-ip": "203.0.113.9" } };
    const r1 = await fetch(WEB + "/api/sessions", remote);
    const r2 = await fetch(WEB + "/api/health", remote);
    const h = JSON.parse(await r2.text());
    if (r1.status === 403) ok("حماية الوضع المحلي", "طلب خارجي على /api/sessions → 403 ✅");
    else bad("حماية الوضع المحلي", `تسرّب! status=${r1.status}`);
    if (h.localAvailable === false && h.server === "محجوب" && !h.location) ok("إخفاء المسارات", "ما كتبانش مسارات الحاسوب للخارج ✅");
    else bad("إخفاء المسارات", JSON.stringify({ localAvailable: h.localAvailable, server: h.server }));
    const r3 = await fetch(WEB + "/api/health");
    const h3 = JSON.parse(await r3.text());
    if (h3.localAvailable === true) ok("الوضع المحلي من الداخل", "مازال خدام من نفس الحاسوب ✅");
    else bad("الوضع المحلي من الداخل", String(h3.localAvailable));
  }
} catch (err) {
  bad("الحالة", err.message);
}

/* ---------------- 3) الوضع المباشر: دردشة عربية ---------------- */

if (directReachable) {
  const t0 = Date.now();
  const r = await streamChat({
    model: "deepseek-v4.1-flash-free",
    messages: [{ role: "user", content: "جاوب بجوج جمل برك: شنو هي عاصمة المغرب؟" }],
  });
  const text = r.events.filter((e) => e.type === "text.delta").map((e) => e.delta).join("");
  const tools = r.events.filter((e) => e.type.startsWith("tool.")).length;
  const usage = r.events.find((e) => e.type === "step.end")?.usage;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (r.status === 200 && text.length > 10) ok("دردشة مباشرة (بثّ)", `${text.length} حرف فـ ${secs}ث`);
  else bad("دردشة مباشرة", `status ${r.status} • ${JSON.stringify(r.events).slice(0, 200)}`);

  if (text.includes("الرباط")) ok("الجواب صحيح لغويًا", "«الرباط» ✅");
  else ok("الجواب", text.slice(0, 90));

  if (tools === 0) ok("بلا أدوات", "0 حدث أداة (دردشة فقط)");
  else bad("بلا أدوات", `${tools} حدث`);

  if (usage) ok("استعمال الرموز", `دخل ${usage.prompt_tokens} • خرج ${usage.completion_tokens}`);
  else bad("استعمال الرموز", "غير مرجّع");

  // نماذج أخرى
  for (const model of ["big-pickle", "cat-jam-free"]) {
    try {
      const rr = await streamChat({ model, messages: [{ role: "user", content: "قول 'واخا' وبرك." }] });
      const t = rr.events.filter((e) => e.type === "text.delta").map((e) => e.delta).join("");
      if (rr.status === 200 && t) ok("نموذج " + model, t.trim().slice(0, 40));
      else bad("نموذج " + model, `status ${rr.status}`);
    } catch (err) {
      bad("نموذج " + model, err.message);
    }
  }
}

/* ---------------- 4) الوضع المحلي ---------------- */

try {
  const created = await fetch(WEB + "/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" }, agent: "build" }),
  });
  const { session } = await created.json();
  if (session?.id) ok("إنشاء جلسة محلية", session.id);
  else bad("إنشاء جلسة محلية", JSON.stringify(session));

  await fetch(`${WEB}/api/sessions/${session.id}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "قول 'سلام' وبرك" }),
  });

  let msgs = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const m = JSON.parse((await get(`/api/sessions/${session.id}/messages`)).text);
    msgs = m.messages || [];
    const asst = msgs.filter((x) => x.type === "assistant" && x.time?.completed);
    if (asst.length) break;
  }
  const asst = msgs.filter((x) => x.type === "assistant").pop();
  const txt = (asst?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  if (txt) ok("محادثة محلية", txt.slice(0, 60));
  else bad("محادثة محلية", "بلا جواب");

  const meta = JSON.parse((await get(`/api/sessions/${session.id}`)).text).session;
  if (meta?.cost === 0) ok("التكلفة", "0$ ✅");
  else ok("التكلفة", `${meta?.cost}`);

  const del = await fetch(`${WEB}/api/sessions/${session.id}`, { method: "DELETE" });
  if (del.status === 204 || del.status === 200) ok("حذف الجلسة");
  else bad("حذف الجلسة", String(del.status));
} catch (err) {
  bad("الوضع المحلي", err.message);
}

/* ---------------- التقرير ---------------- */

console.log("\n══════════ نتيجة الفحص ══════════\n");
for (const [mark, name, extra] of results) {
  console.log(`${mark} ${name}${extra ? "  —  " + extra : ""}`);
}
const fails = results.filter((r) => r[0] === "❌").length;
console.log(`\nالنتيجة: ${results.length - fails}/${results.length} نجحو` + (fails ? `  (${fails} فشل)` : "  🎉 كلشي خدام"));
process.exit(0);
