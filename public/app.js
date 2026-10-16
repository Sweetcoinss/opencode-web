/* ====================== Rtl AI — منطق الواجهة ======================
   وضعان:
     local  → عبر خدمة opencode المحلية (جلسات + أدوات + أذونات)
     direct → مباشرة مع بوابة OpenCode المجانية (دردشة، والمحادثات فالمتصفح)
   ================================================================== */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const LS = {
  model: "ocw.model",
  directModel: "ocw.directModel",
  agent: "ocw.agent",
  dir: "ocw.dir",
  showAll: "ocw.showAll",
  mode: "ocw.mode",
  theme: "ocw.theme",
  chats: "ocw.chats",
  favs: "ocw.favs",
};

const state = {
  mode: localStorage.getItem(LS.mode) === "direct" ? "direct" : "local",
  theme: localStorage.getItem(LS.theme) || "system",
  health: null,
  models: [],
  agents: [],
  sessions: [],
  session: null,
  messages: [],
  deltas: new Map(),
  permissions: [],
  running: false,
  sending: false,
  usage: null,
  toolsEnabled: false,
  localAvailable: true,
  modelFilter: "free",
  favs: new Set(),
  direct: { chats: [], current: null },
};

const dom = {};
let renderQueued = false;
let refreshTimer = null;
let es = null;
let directAbort = null;
let toastTimer = null;
let recognizer = null;

/* ------------------------------------------------------------------ أدوات */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderMarkdown(text) {
  const blocks = [];
  let s = escapeHtml(text || "").replace(/\r\n/g, "\n");
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => {
    blocks.push(code.replace(/\n$/, ""));
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|\n)[-*] /g, "$1• ");
  s = s.replace(/(^|\n)#{1,5} (.+)/g, "$1<strong>$2</strong>");
  const html = s
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return html.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<pre><code>${blocks[Number(i)]}</code></pre>`);
}

function mdNode(text) {
  const d = el("div", "md");
  d.innerHTML = renderMarkdown(text);
  return d;
}

function sparkIcon() {
  const d = el("div", "aispark");
  d.innerHTML =
    '<svg viewBox="0 0 24 24"><defs><linearGradient id="sp-g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#4285F4"/><stop offset=".55" stop-color="#9B72CB"/><stop offset="1" stop-color="#D96570"/>' +
    '</linearGradient></defs><path fill="url(#sp-g)" d="M12 2l1.9 7.1L21 11l-7.1 1.9L12 20l-1.9-7.1L3 11l7.1-1.9z"/></svg>';
  return d;
}

function toast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.add("hidden"), 2600);
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "الآن";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `قبل ${m} د`;
  const h = Math.floor(m / 60);
  if (h < 24) return `قبل ${h} س`;
  const d = Math.floor(h / 24);
  if (d < 30) return `قبل ${d} ي`;
  return new Date(ts).toLocaleDateString("ar");
}

function baseName(p) {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function modelKey(m) {
  return m ? `${m.providerID}/${m.id || m.modelID}` : "";
}

function currentModel() {
  const v = dom.modelSelect.value;
  if (!v) return null;
  const i = v.indexOf("/");
  return { providerID: v.slice(0, i), id: v.slice(i + 1) };
}

const isDirect = () => state.mode === "direct";

function prettyCurrentModelName() {
  const v = dom.modelSelect.value;
  if (!v) return "—";
  if (isDirect()) {
    const f = state.models.find((m) => m.id === v);
    return f ? f.name || f.id : v;
  }
  const found = state.models.find((m) => modelKey(m) === v);
  return found ? found.name : v.slice(v.indexOf("/") + 1);
}

/* قيمة النموذج داخل <select> (مختلفة بين الوضعين) */
const modelValue = (m) => (isDirect() ? m.id : modelKey(m));

/* وسوم النموذج */
function modelTags(m) {
  const t = [];
  if (m.free) t.push("مجاني");
  if (m.tools) t.push("أدوات");
  if (!isDirect()) {
    if (m.reasoning) t.push("تفكير");
    if ((m.input || []).includes("image")) t.push("صور");
    if (m.context) t.push(Math.round(m.context / 1000) + "K سياق");
  }
  if (m.status && m.status !== "active") t.push(m.status);
  return t;
}

/* ------------------------------------------------------------------ الشبكة */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }
  if (res.status === 401) {
    showLogin();
    throw new Error((data && data.error) || "خاصك تسجل الدخول");
  }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  return data;
}

function showLogin() {
  dom.login.classList.remove("hidden");
}

/* ------------------------------------------------------------------ المظهر */

function resolveTheme(pref) {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(pref, save = true) {
  state.theme = pref;
  if (save) localStorage.setItem(LS.theme, pref);
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;

  dom.themeIcon.innerHTML =
    resolved === "dark"
      ? '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>'
      : '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/>';

  $$("[data-theme]").forEach((b) => {
    if (b.tagName === "BUTTON" && b.classList.contains("preset")) b.classList.toggle("on", b.dataset.theme === pref);
  });

  // لون شريط النظام فالتطبيق المثبّت
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#0c0d12" : "#f6f7fb");
}

/* ------------------------------------------------------------------ التثبيت كتطبيق (PWA) */

let installPrompt = null;

function setupPwa() {
  // تسجيل عامل الخدمة (خاص HTTPS ولا localhost)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  // أندرويد/كروم: كيبدا الحدث ملي الموقع يقدر يتثبّت
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    dom.btnInstall.classList.remove("hidden");
  });

  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    dom.btnInstall.classList.add("hidden");
    toast("تثبّت التطبيق ✅");
  });

  dom.btnInstall.addEventListener("click", async () => {
    closeDrawer();
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === "accepted") dom.btnInstall.classList.add("hidden");
      installPrompt = null;
      return;
    }
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    toast(
      isIos
        ? "فـ iPhone: زر المشاركة ⬆️ ← «إضافة إلى الشاشة الرئيسية»"
        : "افتح قائمة المتصفح (⋮) ← «تثبيت التطبيق» ولا «إضافة إلى الشاشة الرئيسية»"
    );
  });

  // اختصار «محادثة جديدة» من أيقونة التطبيق
  if (new URLSearchParams(location.search).has("new")) {
    history.replaceState(null, "", location.pathname);
    setTimeout(() => (isDirect() ? newDirectChat() : createSession()), 300);
  }
}

/* ------------------------------------------------------------------ الحالة */

async function loadHealth() {
  try {
    const h = await api("/api/health");
    state.health = h;
    state.localAvailable = h.localAvailable !== false;
    state.toolsEnabled = false;
    if (h.ready) {
      dom.statusPill.textContent = `متصل • v${h.version}`;
      dom.statusPill.className = "pill ok";
      dom.statusDetail.textContent = "خدمة opencode المحلية";
    } else {
      dom.statusPill.textContent = "تعذّر الاتصال";
      dom.statusPill.className = "pill bad";
      dom.statusDetail.textContent = h.server ? `المنفذ ${h.server}` : "شغّل opencode";
    }
    if (!dom.dirInput.value) dom.dirInput.value = localStorage.getItem(LS.dir) || h.location || "";
    renderStatusBadge();
  } catch (err) {
    dom.statusPill.textContent = "خطأ: " + err.message;
    dom.statusPill.className = "pill bad";
  }
}

async function loadDirectStatus() {
  try {
    const st = await api("/api/direct/status");
    state.toolsEnabled = (st.tools || []).length > 0;
    dom.statusPill.textContent = st.reachable ? "بوابة مجانية ✅" : "البوابة ما رجعتش";
    dom.statusPill.className = "pill " + (st.reachable ? "ok" : "bad");
    dom.statusDetail.textContent = st.base.replace("https://", "");
    if (st.base) dom.gatewayUrl.textContent = st.base;
    renderDirectNote(st.tools || []);
    renderStatusBadge();
    renderFieldVisibility();
    return st;
  } catch (err) {
    dom.statusPill.textContent = "خطأ: " + err.message;
    dom.statusPill.className = "pill bad";
    return null;
  }
}

function renderDirectNote(tools) {
  dom.directNote.classList.remove("hidden");
  if (tools.length) {
    dom.directNote.innerHTML =
      "وضع <b>مباشر + أدوات</b>: كيهدر مباشرة مع بوابة OpenCode المجانية. " +
      "الأدوات (<code>read/write/bash</code>) كتنفذ على <b>السيرفر</b>، ماشي على الحاسوب ديالك.";
    return;
  }
  dom.directNote.innerHTML =
    "وضع <b>مباشر — دردشة فقط</b>: كيهدر مباشرة مع بوابة OpenCode المجانية، بلا حاجة للحاسوب ديالك وبلا أي وصول للملفات.<br>" +
    "ملاحظة: عميل غير رسمي، يمكن يتحجب فأي وقت، وعندو حصة مجانية محدودة.";
}

function renderStatusBadge() {
  const badge = dom.wsBadge;
  if (isDirect()) {
    badge.textContent = state.toolsEnabled ? "مباشر • أدوات" : "مباشر • دردشة فقط";
    badge.className = "pill ok";
    dom.wsDetail.textContent = "بوابة OpenCode المجانية — ما كيحتاجش الحاسوب ديالك.";
    return;
  }
  if (state.health?.ready) {
    badge.textContent = "متصل بخدمة opencode";
    badge.className = "pill ok";
    dom.wsDetail.textContent = state.health.location || "";
  } else {
    badge.textContent = "غير متصل";
    badge.className = "pill bad";
    dom.wsDetail.textContent = "شغّل opencode من بعد حدّث الصفحة.";
  }
}

function renderFieldVisibility() {
  dom.agentField.classList.toggle("hidden", isDirect());
  dom.dirField.classList.toggle("hidden", isDirect() && !state.toolsEnabled);
  dom.showAll.closest(".check").classList.toggle("hidden", isDirect());
}

/* ------------------------------------------------------------------ النماذج */

async function loadModels() {
  if (isDirect()) {
    try {
      const { models } = await api("/api/direct/models");
      state.models = models;
    } catch (err) {
      console.error(err);
      state.models = [];
    }
  } else {
    const dir = dom.dirInput.value.trim();
    try {
      const { models } = await api("/api/models" + (dir ? `?directory=${encodeURIComponent(dir)}` : ""));
      state.models = models;
    } catch (err) {
      console.error(err);
      state.models = [];
    }
  }
  renderModelSelect();
}

function renderModelSelect() {
  const previous = dom.modelSelect.value || localStorage.getItem(isDirect() ? LS.directModel : LS.model) || "";
  const showAll = dom.showAll.checked;
  const list = isDirect() ? state.models : state.models.filter((m) => m.enabled && (showAll || m.free));

  dom.modelSelect.textContent = "";
  if (!list.length) dom.modelSelect.appendChild(new Option("لا توجد نماذج", ""));

  for (const m of list) {
    const value = isDirect() ? m.id : modelKey(m);
    const label = isDirect() ? m.id : `${m.name}${m.free ? " — مجاني ✓" : " — يحتاج مفتاح"}`;
    dom.modelSelect.appendChild(new Option(label, value));
  }
  if (previous && ![...dom.modelSelect.options].some((o) => o.value === previous)) {
    dom.modelSelect.appendChild(new Option(previous, previous));
  }
  const firstFree = state.models.find((m) => m.free) || state.models[0];
  dom.modelSelect.value = previous || (firstFree ? modelValue(firstFree) : "");
  localStorage.setItem(isDirect() ? LS.directModel : LS.model, dom.modelSelect.value);
  updateHeader();
  renderModelList();
}

/* ------------------------------------------------------------------ اختيار النموذج */

function renderModelList() {
  if (!dom.modelList) return;
  const box = dom.modelList;
  box.textContent = "";

  const q = dom.modelSearch.value.trim().toLowerCase();
  const current = dom.modelSelect.value;
  const source = state.models.filter((m) => (isDirect() ? true : m.enabled !== false));

  let list = source;
  if (state.modelFilter === "fav") list = list.filter((m) => state.favs.has(modelValue(m)));
  else if (state.modelFilter === "free") list = list.filter((m) => m.free);
  if (q) list = list.filter((m) => `${m.id} ${m.name || ""} ${m.family || ""}`.toLowerCase().includes(q));

  const favCount = source.filter((m) => state.favs.has(modelValue(m))).length;
  dom.modelCount.textContent = `${list.length} من ${source.length} نموذج${favCount ? ` • ${favCount} مفضّل` : ""}`;

  if (!list.length) {
    box.appendChild(
      el("div", "muted", source.length ? "ما كاينش نتيجة. بدّل الفلتر ولا البحث." : "ما تحمّلو حتى نموذج — دير تحديث.")
    );
    return;
  }

  for (const m of list) {
    const value = modelValue(m);
    const row = el("div", "mitem" + (value === current ? " active" : ""));

    const info = el("div", "minfo");
    info.appendChild(el("div", "mname", m.name || m.id));
    info.appendChild(el("div", "mid", m.id));
    const tags = el("div", "mtags");
    for (const t of modelTags(m)) {
      const cls = t === "مجاني" ? "mtag free" : t === "أدوات" ? "mtag tools" : "mtag";
      tags.appendChild(el("span", cls, t));
    }
    info.appendChild(tags);
    row.appendChild(info);

    const fav = state.favs.has(value);
    const star = el("button", "star" + (fav ? " on" : ""), fav ? "★" : "☆");
    star.title = fav ? "حيّد من المفضلة" : "زيد للمفضلة";
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.favs.has(value)) state.favs.delete(value);
      else state.favs.add(value);
      localStorage.setItem(LS.favs, JSON.stringify([...state.favs]));
      renderModelList();
    });
    row.appendChild(star);

    row.appendChild(el("span", "mcheck", value === current ? "✓" : ""));

    row.addEventListener("click", () => {
      dom.modelSelect.value = value;
      applyModelChange();
      closeModels();
      toast("النموذج: " + (m.name || m.id));
    });

    box.appendChild(row);
  }
}

function openModels() {
  closeDrawer();
  dom.modelSearch.value = "";
  renderModelList();
  dom.models.classList.add("open");
  setTimeout(() => dom.modelSearch.focus(), 250);
}

function closeModels() {
  dom.models.classList.remove("open");
}

async function applyModelChange() {
  const value = dom.modelSelect.value;
  localStorage.setItem(isDirect() ? LS.directModel : LS.model, value);
  updateHeader();
  dom.pickModelName.textContent = prettyCurrentModelName();

  if (isDirect()) {
    const chat = currentChat();
    if (chat) {
      chat.model = value;
      saveDirectChats();
    }
    return;
  }
  if (!state.session) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.session.id)}/model`, {
      method: "POST",
      body: { model: currentModel() },
    });
  } catch (err) {
    toast("تعذّر تغيير النموذج: " + err.message);
  }
}

async function loadAgents() {
  try {
    const { agents } = await api("/api/agents");
    state.agents = agents;
  } catch {
    state.agents = [{ id: "build", name: "Build" }];
  }
  const previous = localStorage.getItem(LS.agent) || "build";
  dom.agentSelect.textContent = "";
  for (const a of state.agents) dom.agentSelect.appendChild(new Option(a.name, a.id));
  dom.agentSelect.value = state.agents.some((a) => a.id === previous) ? previous : state.agents[0]?.id || "build";
}

/* ------------------------------------------------------------------ الوضع المباشر */

function loadDirectChats() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS.chats) || "[]");
    state.direct.chats = Array.isArray(raw) ? raw : [];
  } catch {
    state.direct.chats = [];
  }
}

function saveDirectChats() {
  try {
    const trimmed = state.direct.chats.slice(0, 80).map((c) => ({
      ...c,
      items: c.items.slice(-150).map((it) =>
        it.kind === "user"
          ? it
          : {
              ...it,
              text: (it.text || "").slice(0, 40000),
              reasoning: (it.reasoning || "").slice(0, 20000),
              tools: (it.tools || []).map((t) => ({ ...t, output: (t.output || "").slice(0, 12000) })),
            }
      ),
    }));
    localStorage.setItem(LS.chats, JSON.stringify(trimmed));
  } catch {
    /* الذاكرة ممتلئة */
  }
}

const currentChat = () => state.direct.current;

function newDirectChat() {
  const chat = {
    id: "dc_" + Date.now().toString(36),
    title: "محادثة جديدة",
    model: dom.modelSelect.value || "",
    workspace: dom.dirInput.value.trim() || "",
    created: Date.now(),
    updated: Date.now(),
    items: [],
  };
  state.direct.chats.unshift(chat);
  state.direct.current = chat;
  saveDirectChats();
  return chat;
}

function directHistory(chat) {
  const out = [];
  for (const it of chat.items) {
    if (it.kind === "user") {
      out.push({ role: "user", content: it.text });
      continue;
    }
    const msg = { role: "assistant", content: it.text || null };
    if (it.tools?.length) {
      msg.tool_calls = it.tools.map((t) => ({
        id: t.id,
        type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
      }));
    }
    if (!msg.content && !msg.tool_calls) msg.content = "";
    out.push(msg);
    for (const t of it.tools || []) {
      out.push({ role: "tool", tool_call_id: t.id, content: t.output || t.error || "(بدون نتيجة)" });
    }
  }
  return out;
}

function directToRender(chat) {
  if (!chat) return [];
  const out = [];
  chat.items.forEach((it, i) => {
    if (it.kind === "user") {
      out.push({ id: "d" + i, type: "user", text: it.text });
      return;
    }
    const content = [];
    if (it.reasoning) content.push({ type: "reasoning", text: it.reasoning });
    if (it.text) content.push({ type: "text", text: it.text });
    for (const t of it.tools || []) {
      content.push({
        type: "tool",
        id: t.id,
        name: t.name,
        state: {
          status: t.status,
          input: t.input,
          content: t.output ? [{ type: "text", text: t.output }] : undefined,
          error: t.error ? { type: "error", message: t.error } : undefined,
        },
      });
    }
    if (it.error) content.push({ type: "error", text: it.error });
    out.push({
      id: "d" + i,
      type: "assistant",
      content,
      agent: "",
      model: { id: it.model || chat.model, providerID: "opencode" },
      tokens: it.usage
        ? {
            input: it.usage.prompt_tokens ?? it.usage.input,
            output: it.usage.completion_tokens ?? it.usage.output,
            reasoning: it.usage.reasoning_tokens || 0,
          }
        : null,
      cost: 0,
    });
  });
  return out;
}

/* ------------------------------------------------------------------ القوائم */

async function loadSessions() {
  if (isDirect()) return renderDirectList();
  const search = dom.sessionSearch.value.trim();
  const params = new URLSearchParams({ limit: "60", parentID: "null" });
  if (search) params.set("search", search);
  try {
    const { sessions } = await api("/api/sessions?" + params.toString());
    state.sessions = sessions;
  } catch {
    state.sessions = [];
  }
  renderSessionList();
}

function renderSessionList() {
  if (isDirect()) return renderDirectList();
  const box = dom.sessionList;
  box.textContent = "";
  if (!state.sessions.length) {
    box.appendChild(el("div", "muted", "لا توجد محادثات بعد."));
    return;
  }
  for (const s of state.sessions) {
    const item = el("div", "session-item" + (state.session && state.session.id === s.id ? " active" : ""));
    item.appendChild(el("span", "t", s.title || "بدون عنوان"));
    const sub = el("span", "s");
    sub.appendChild(el("span", null, s.model ? s.model.id : "—"));
    if (s.directory) sub.appendChild(el("span", null, "• " + baseName(s.directory)));
    sub.appendChild(el("span", null, "• " + timeAgo(s.updated || s.created)));
    if (s.cost === 0) sub.appendChild(el("span", "tag-free", "• مجاني"));
    item.appendChild(sub);

    const del = el("button", "del", "🗑");
    del.title = "حذف";
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm("حذف هذه المحادثة؟")) return;
      await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      if (state.session && state.session.id === s.id) newChat();
      loadSessions();
      toast("تحذفات المحادثة");
    });
    item.appendChild(del);
    item.addEventListener("click", () => openSession(s.id));
    box.appendChild(item);
  }
}

function renderDirectList() {
  const box = dom.sessionList;
  box.textContent = "";
  const search = dom.sessionSearch.value.trim().toLowerCase();
  const chats = state.direct.chats.filter((c) => !search || c.title.toLowerCase().includes(search));
  if (!chats.length) {
    box.appendChild(el("div", "muted", "لا توجد محادثات بعد."));
    return;
  }
  for (const c of chats) {
    const item = el("div", "session-item" + (currentChat()?.id === c.id ? " active" : ""));
    item.appendChild(el("span", "t", c.title));
    const sub = el("span", "s");
    sub.appendChild(el("span", null, c.model || "—"));
    if (c.workspace) sub.appendChild(el("span", null, "• " + baseName(c.workspace)));
    sub.appendChild(el("span", null, "• " + timeAgo(c.updated)));
    item.appendChild(sub);

    const del = el("button", "del", "🗑");
    del.title = "حذف";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!confirm("حذف هذه المحادثة؟")) return;
      state.direct.chats = state.direct.chats.filter((x) => x.id !== c.id);
      if (currentChat()?.id === c.id) state.direct.current = null;
      saveDirectChats();
      renderMessages();
      renderDirectList();
      toast("تحذفات المحادثة");
    });
    item.appendChild(del);

    item.addEventListener("click", () => {
      state.direct.current = c;
      if (c.model && [...dom.modelSelect.options].some((o) => o.value === c.model)) dom.modelSelect.value = c.model;
      if (c.workspace) dom.dirInput.value = c.workspace;
      updateHeader();
      renderMessages();
      renderDirectList();
      closeDrawer();
    });
    box.appendChild(item);
  }
}

/* ------------------------------------------------------------------ العرض */

const currentMessages = () => (isDirect() ? directToRender(currentChat()) : state.messages);

function reasoningNode(text) {
  const d = document.createElement("details");
  d.className = "reasoning";
  const s = document.createElement("summary");
  s.textContent = "سلسلة التفكير";
  d.appendChild(s);
  d.appendChild(el("pre", null, text));
  return d;
}

const statusLabel = (st) =>
  st === "completed" ? "انتهى" : st === "error" ? "خطأ" : st === "running" ? "يعمل…" : st || "";

function toolInputSummary(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ["command", "filePath", "path", "pattern", "query", "url", "description", "prompt"]) {
    if (typeof input[k] === "string" && input[k].trim()) {
      const v = input[k].replace(/\s+/g, " ").trim();
      return v.length > 60 ? v.slice(0, 60) + "…" : v;
    }
  }
  const first = Object.values(input).find((v) => typeof v === "string" && v.trim());
  return first ? String(first).slice(0, 60) : "";
}

function toolNode(part) {
  const st = part.state || {};
  const status = st.status || "running";
  const d = document.createElement("details");
  d.className = "tool";

  const head = document.createElement("summary");
  head.className = "tool-head";
  head.appendChild(el("span", "name", part.name || "tool"));
  head.appendChild(el("span", "badge " + status, statusLabel(status)));
  const hint = toolInputSummary(st.input);
  if (hint) head.appendChild(el("span", "muted", hint));
  d.appendChild(head);

  if (st.input && Object.keys(st.input).length) d.appendChild(el("pre", null, JSON.stringify(st.input, null, 2)));
  if (Array.isArray(st.content)) {
    for (const c of st.content) {
      if (c.type === "text") d.appendChild(el("pre", null, c.text));
      else if (c.type === "file") d.appendChild(el("pre", null, `📄 ${c.name || c.uri}`));
    }
  }
  if (st.error) d.appendChild(el("pre", null, `${st.error.type || "خطأ"}: ${st.error.message || ""}`));
  if (status === "running") d.open = true;
  return d;
}

function assistantNodes(msg) {
  const nodes = [];
  const counters = { text: 0, reasoning: 0 };
  const seen = { text: new Set(), reasoning: new Set() };

  for (const part of msg.content || []) {
    if (part.type === "reasoning") {
      const i = counters.reasoning++;
      seen.reasoning.add(i);
      const delta = state.deltas.get(`${msg.id}:reasoning:${i}`);
      nodes.push(reasoningNode(delta && delta.length > (part.text || "").length ? delta : part.text || ""));
    } else if (part.type === "text") {
      const i = counters.text++;
      seen.text.add(i);
      const delta = state.deltas.get(`${msg.id}:text:${i}`);
      nodes.push(mdNode(delta && delta.length > (part.text || "").length ? delta : part.text || ""));
    } else if (part.type === "tool") {
      nodes.push(toolNode(part));
    } else if (part.type === "error") {
      nodes.push(el("div", "error-box", part.text));
    }
  }

  for (const [key, text] of state.deltas) {
    if (!key.startsWith(msg.id + ":")) continue;
    const [, type, idxRaw] = key.split(":");
    const idx = Number(idxRaw);
    if (type === "text" && !seen.text.has(idx)) nodes.push(mdNode(text));
    if (type === "reasoning" && !seen.reasoning.has(idx)) nodes.push(reasoningNode(text));
  }
  return nodes;
}

function actionBar(msg) {
  const bar = el("div", "actions");

  const copy = el("button", "a");
  copy.title = "نسخ";
  copy.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>';
  copy.addEventListener("click", async () => {
    const text = (msg.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("تنسخ");
    } catch {
      toast("تعذّر النسخ");
    }
  });
  bar.appendChild(copy);

  if (isDirect() && msg.type === "assistant") {
    const again = el("button", "a");
    again.title = "عاود";
    again.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5"/></svg>';
    again.addEventListener("click", () => regenerate());
    bar.appendChild(again);
  }
  return bar;
}

function messageNode(msg, isLast) {
  if (msg.type === "user") {
    const row = el("div", "userrow");
    row.appendChild(el("div", "bubble", msg.text || ""));
    return row;
  }

  const row = el("div", "airow");
  row.appendChild(sparkIcon());
  const wrap = el("div", "aicontent");

  const label = [msg.model?.id || "", msg.agent || ""].filter(Boolean).join(" • ");
  if (label) wrap.appendChild(el("div", "role", label));

  for (const n of assistantNodes(msg)) wrap.appendChild(n);

  if (state.running && isLast) {
    const t = el("div", "typing");
    t.append(el("span", null, "يكتب"), el("i"), el("i"), el("i"));
    wrap.appendChild(t);
  }

  if (msg.tokens) {
    const tk = msg.tokens;
    wrap.appendChild(
      el(
        "div",
        "usage muted",
        `دخل ${tk.input || 0} • خرج ${tk.output || 0}${tk.reasoning ? ` • تفكير ${tk.reasoning}` : ""} • ${msg.cost ?? 0}$`
      )
    );
  }

  wrap.appendChild(actionBar(msg));
  row.appendChild(wrap);
  return row;
}

function renderMessages() {
  renderQueued = false;
  const messages = currentMessages();
  const box = dom.messages;
  const nearBottom = isNearBottom();

  if (!messages.length) {
    dom.viewWelcome.classList.remove("hidden");
    dom.viewChat.classList.add("hidden");
    box.textContent = "";
    renderUsage();
    renderStatusBadge();
    return;
  }

  dom.viewWelcome.classList.add("hidden");
  dom.viewChat.classList.remove("hidden");

  box.textContent = "";
  const lastIdx = [...messages].reverse().findIndex((m) => m.type === "assistant");
  const lastId = lastIdx >= 0 ? messages[messages.length - 1 - lastIdx].id : null;
  for (const m of messages) box.appendChild(messageNode(m, m.type === "assistant" && m.id === lastId));

  renderUsage();
  if (nearBottom) scrollToBottom(false);
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(renderMessages);
}

function isNearBottom() {
  const b = dom.messages;
  return b.scrollHeight - b.scrollTop - b.clientHeight < 160;
}

function scrollToBottom(force) {
  const b = dom.messages;
  if (force || isNearBottom()) b.scrollTop = b.scrollHeight;
}

function renderUsage() {
  let u = state.usage;
  if (isDirect()) {
    const last = currentChat()?.items.filter((i) => i.kind === "assistant" && i.usage).pop();
    u = last?.usage
      ? {
          cost: 0,
          tokens: {
            input: last.usage.prompt_tokens ?? last.usage.input,
            output: last.usage.completion_tokens ?? last.usage.output,
            reasoning: last.usage.reasoning_tokens || 0,
          },
        }
      : null;
  }
  if (!u) {
    dom.usage.textContent = "";
    return;
  }
  const t = u.tokens || {};
  dom.usage.innerHTML =
    `<span>التكلفة <b>${u.cost ?? 0}$</b></span>` +
    `<span>دخل <b>${t.input || 0}</b></span>` +
    `<span>خرج <b>${t.output || 0}</b></span>` +
    (t.reasoning ? `<span>تفكير <b>${t.reasoning}</b></span>` : "");
}

function updateHeader() {
  const name = prettyCurrentModelName();
  dom.chipModel.textContent = name;
  if (dom.pickModelName) dom.pickModelName.textContent = name;
}

function updateRunningUi() {
  dom.btnStop.classList.toggle("hidden", !state.running);
  dom.btnSend.classList.toggle("hidden", state.running);
  dom.btnSend.disabled = state.sending;
}

/* ------------------------------------------------------------------ التنقل */

function openDrawer() {
  dom.drawer.classList.add("open");
  dom.scrim.classList.remove("hidden");
  dom.drawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  dom.drawer.classList.remove("open");
  dom.scrim.classList.add("hidden");
  dom.drawer.setAttribute("aria-hidden", "true");
}

function openSettings() {
  closeDrawer();
  dom.settings.classList.add("open");
}

function closeSettings() {
  dom.settings.classList.remove("open");
}

/* ------------------------------------------------------------------ الأذونات */

async function loadPermissions() {
  if (isDirect() || !state.session) return;
  try {
    const { permissions } = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/permissions`);
    state.permissions = permissions || [];
  } catch {
    state.permissions = [];
  }
  renderPermissions();
}

function renderPermissions() {
  const box = dom.permissions;
  box.textContent = "";
  if (isDirect() || !state.permissions.length) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  for (const perm of state.permissions) {
    const card = el("div", "permission-card");
    card.appendChild(el("span", null, "🔐 طلب إذن:"));
    card.appendChild(el("b", null, perm.action));
    const res = perm.resources?.[0] || "";
    card.appendChild(el("code", null, res.length > 60 ? res.slice(0, 60) + "…" : res));
    for (const [decision, label] of [["once", "سماح"], ["always", "دائماً"], ["reject", "رفض"]]) {
      const b = el("button", "btn" + (decision === "reject" ? " danger" : " primary"), label);
      b.addEventListener("click", async () => {
        await api(
          `/api/sessions/${encodeURIComponent(state.session.id)}/permissions/${encodeURIComponent(perm.id)}/reply`,
          { method: "POST", body: { decision } }
        );
        await loadPermissions();
      });
      card.appendChild(b);
    }
    box.appendChild(card);
  }
}

/* ------------------------------------------------------------------元神 البثّ */

function appendDelta(key, delta) {
  if (!delta) return;
  state.deltas.set(key, (state.deltas.get(key) || "") + delta);
  queueRender();
}

function scheduleRefresh(delay = 400) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshMessages, delay);
}

async function refreshMessages() {
  if (isDirect() || !state.session) return;
  try {
    const { messages } = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/messages`);
    state.messages = messages;
    for (const [key] of state.deltas) {
      const [id, type, idxRaw] = key.split(":");
      const idx = Number(idxRaw);
      const msg = messages.find((m) => m.id === id);
      let found = "";
      if (msg && Array.isArray(msg.content)) {
        let seen = 0;
        for (const part of msg.content) {
          if (part.type !== type) continue;
          if (seen === idx) {
            found = part.text || "";
            break;
          }
          seen++;
        }
      }
      if (found.length >= (state.deltas.get(key) || "").length) state.deltas.delete(key);
    }
    queueRender();
  } catch (err) {
    console.error(err);
  }
}

function handleEvent(ev) {
  const type = ev?.type || "";
  const data = ev?.data || {};
  const active = !isDirect() && state.session && data.sessionID === state.session.id;
  if (!active && !type.startsWith("server") && !type.startsWith("gateway")) return;

  switch (type) {
    case "session.text.delta":
      return appendDelta(`${data.assistantMessageID}:text:${data.ordinal}`, data.delta);
    case "session.reasoning.delta":
      return appendDelta(`${data.assistantMessageID}:reasoning:${data.ordinal}`, data.delta);
    case "session.execution.started":
      state.running = true;
      updateRunningUi();
      return queueRender();
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      state.running = false;
      updateRunningUi();
      loadSessions();
      refreshSessionMeta();
      setTimeout(refreshSessionMeta, 3000);
      return scheduleRefresh(200);
    case "session.usage.updated":
      state.usage = { cost: data.cost, tokens: data.tokens };
      return renderUsage();
    case "session.permission.created":
    case "session.permission.updated":
      return loadPermissions();
    default:
      break;
  }

  if (!active) return;
  if (type === "session.inbox.enqueued" || type.startsWith("session.tool") || type === "session.step.started") {
    scheduleRefresh(300);
  } else if (type !== "session.step.streamed") {
    scheduleRefresh(700);
  }
}

function connectEvents() {
  if (es) es.close();
  es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data));
    } catch {
      /* تجاهل */
    }
  };
}

function startPolling() {
  setInterval(() => {
    if (!isDirect() && state.running) refreshMessages();
  }, 1500);
  setInterval(() => {
    if (!isDirect() && state.running) loadPermissions();
  }, 2000);
  setInterval(() => {
    if (!isDirect() && !state.health?.ready) loadHealth();
  }, 12000);
}

async function refreshSessionMeta() {
  if (isDirect() || !state.session) return;
  try {
    const { session } = await api(`/api/sessions/${encodeURIComponent(state.session.id)}`);
    if (session && state.session && session.id === state.session.id) {
      state.session = session;
      if (session.tokens) state.usage = { cost: session.cost, tokens: session.tokens };
      renderUsage();
    }
  } catch {
    /* تجاهل */
  }
}

/* ------------------------------------------------------------------ الجلسات */

async function createSession() {
  const { session } = await api("/api/sessions", {
    method: "POST",
    body: {
      model: currentModel(),
      agent: dom.agentSelect.value,
      directory: dom.dirInput.value.trim() || undefined,
    },
  });
  state.session = session;
  state.messages = [];
  state.deltas.clear();
  state.usage = null;
  return session;
}

async function openSession(id) {
  try {
    const [{ session }, { messages }] = await Promise.all([
      api(`/api/sessions/${encodeURIComponent(id)}`),
      api(`/api/sessions/${encodeURIComponent(id)}/messages`),
    ]);
    state.session = session;
    state.messages = messages;
    state.deltas.clear();
    state.usage = session.tokens ? { cost: session.cost, tokens: session.tokens } : null;
    state.running = !session.time?.idle;
    state.permissions = [];
    if (session.model) {
      const key = modelKey(session.model);
      if (![...dom.modelSelect.options].some((o) => o.value === key)) {
        dom.modelSelect.appendChild(new Option(session.model.id, key));
      }
      dom.modelSelect.value = key;
      updateHeader();
    }
    if (session.agent && [...dom.agentSelect.options].some((o) => o.value === session.agent)) {
      dom.agentSelect.value = session.agent;
    }
    if (session.location?.directory) dom.dirInput.value = session.location.directory;
    closeDrawer();
    renderMessages();
    renderSessionList();
    updateRunningUi();
    await loadPermissions();
    scrollToBottom(true);
  } catch (err) {
    toast("تعذّر فتح المحادثة: " + err.message);
  }
}

function newChat() {
  if (isDirect()) {
    state.direct.current = null;
    renderMessages();
    renderDirectList();
    closeDrawer();
    dom.input.focus();
    return;
  }
  state.session = null;
  state.messages = [];
  state.deltas.clear();
  state.usage = null;
  state.running = false;
  state.permissions = [];
  renderPermissions();
  updateRunningUi();
  renderMessages();
  renderSessionList();
  closeDrawer();
  dom.input.focus();
}

/* ------------------------------------------------------------------ الإرسال */

function autoGrow() {
  const t = dom.input;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 180) + "px";
}

async function sendMessage() {
  const text = dom.input.value.trim();
  if (!text || state.running || state.sending) return;
  if (isDirect()) return sendDirect(text);

  state.sending = true;
  updateRunningUi();
  try {
    if (!state.session) await createSession();
    dom.input.value = "";
    autoGrow();

    state.messages.push({ id: "local-" + Date.now(), type: "user", text, time: { created: Date.now() } });
    state.running = true;
    updateRunningUi();
    renderMessages();
    scrollToBottom(true);

    await api(`/api/sessions/${encodeURIComponent(state.session.id)}/prompt`, { method: "POST", body: { text } });
    scheduleRefresh(400);
  } catch (err) {
    state.running = false;
    toast("تعذّر الإرسال: " + err.message);
  } finally {
    state.sending = false;
    updateRunningUi();
  }
}

async function sendDirect(text) {
  const chat = currentChat() || newDirectChat();
  chat.model = dom.modelSelect.value || chat.model;
  chat.workspace = dom.dirInput.value.trim() || chat.workspace;
  if (!chat.items.length) chat.title = text.slice(0, 40) || "محادثة جديدة";
  chat.updated = Date.now();
  chat.items.push({ kind: "user", text });
  saveDirectChats();

  dom.input.value = "";
  autoGrow();
  state.running = true;
  updateRunningUi();
  renderMessages();
  renderDirectList();
  scrollToBottom(true);

  let item = null;
  const ensureItem = () => {
    if (!item) {
      item = { kind: "assistant", text: "", reasoning: "", tools: [], usage: null, model: chat.model };
      chat.items.push(item);
    }
    return item;
  };

  try {
    directAbort = new AbortController();
    const res = await fetch("/api/direct/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: chat.model, messages: directHistory(chat), workspace: chat.workspace || undefined }),
      signal: directAbort.signal,
    });

    if (res.status === 401) {
      showLogin();
      throw new Error("خاصك تسجل الدخول");
    }
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      let msg = raw;
      try {
        msg = JSON.parse(raw).error || raw;
      } catch {
        /* نص */
      }
      throw new Error(msg || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
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
        if (ev.type === "step.start") item = null;
        else if (ev.type === "text.delta") {
          ensureItem().text += ev.delta;
          queueRender();
        } else if (ev.type === "reasoning.delta") {
          ensureItem().reasoning += ev.delta;
          queueRender();
        } else if (ev.type === "tool.start") {
          ensureItem().tools.push({ id: ev.id, name: ev.name, input: ev.input, status: "running", output: "" });
          queueRender();
        } else if (ev.type === "tool.end") {
          const cur = ensureItem().tools.find((t) => t.id === ev.id);
          if (cur) {
            cur.status = ev.status;
            cur.output = ev.output || "";
            cur.error = ev.error || null;
          }
          queueRender();
        } else if (ev.type === "step.end") {
          ensureItem().usage = ev.usage;
          if (ev.model) ensureItem().model = ev.model;
          queueRender();
        } else if (ev.type === "error") {
          chat.items.push({ kind: "assistant", text: "", tools: [], error: ev.message || "خطأ غير معروف" });
          queueRender();
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      const c = currentChat();
      c.items.push({ kind: "assistant", text: "", tools: [], error: err.message });
    }
  } finally {
    state.running = false;
    updateRunningUi();
    const c = currentChat();
    if (c) c.updated = Date.now();
    saveDirectChats();
    renderMessages();
    renderDirectList();
  }
}

async function regenerate() {
  if (!isDirect() || state.running) return;
  const chat = currentChat();
  if (!chat) return;
  let idx = -1;
  for (let i = chat.items.length - 1; i >= 0; i--) {
    if (chat.items[i].kind === "user") {
      idx = i;
      break;
    }
  }
  if (idx < 0) return;
  const text = chat.items[idx].text;
  chat.items = chat.items.slice(0, idx); // حيّد الرسالة القديمة وكل اللي بعدها
  saveDirectChats();
  renderMessages();
  await sendDirect(text);
}

async function stopRun() {
  if (isDirect()) {
    if (directAbort) directAbort.abort();
    state.running = false;
    updateRunningUi();
    return;
  }
  if (!state.session) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.session.id)}/interrupt`, { method: "POST" });
    state.running = false;
    updateRunningUi();
    scheduleRefresh(300);
  } catch (err) {
    toast("تعذّر الإيقاف: " + err.message);
  }
}

/* ------------------------------------------------------------------ الوضعان */

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem(LS.mode, mode);
  dom.modeLocal.classList.toggle("on", mode === "local");
  dom.modeDirect.classList.toggle("on", mode === "direct");

  // الوضع المحلي مسدود على سيرفر عمومي (نفق / نشر)
  const localOk = state.localAvailable !== false;
  dom.modeLocal.disabled = !localOk;
  dom.modeLocal.title = localOk ? "" : "الوضع المحلي مسدود فهاد السيرفر (كيوصل لملفات الحاسوب)";

  state.session = null;
  state.messages = [];
  state.deltas.clear();
  state.usage = null;
  state.permissions = [];
  state.running = false;

  if (mode === "direct") {
    loadDirectChats();
    if (!state.direct.current && state.direct.chats[0]) state.direct.current = state.direct.chats[0];
  }

  renderFieldVisibility();
  updateRunningUi();
  renderMessages();
  refreshSidebar();
  loadModels();
  if (mode === "direct") loadDirectStatus();
  else loadHealth();
}

function refreshSidebar() {
  if (isDirect()) renderDirectList();
  else loadSessions();
}

/* ------------------------------------------------------------------ التهيئة */

function bind() {
  const ids = {
    btnMenu: "#btn-menu", btnModel: "#btn-model", chipModel: "#chip-model", btnTheme: "#btn-theme",
    themeIcon: "#theme-icon", viewWelcome: "#view-welcome", viewChat: "#view-chat",
    chips: "#chips", wsBadge: "#ws-badge", wsDetail: "#ws-detail", messages: "#messages",
    permissions: "#permissions", usage: "#usage", btnPlus: "#btn-plus", input: "#input",
    btnMic: "#btn-mic", btnSend: "#btn-send", btnStop: "#btn-stop", scrim: "#scrim",
    drawer: "#drawer", btnDrawerClose: "#btn-drawer-close", btnNew: "#btn-new", btnSearch: "#btn-search",
    btnInstall: "#btn-install",
    sessionSearch: "#session-search", sessionList: "#session-list", btnRefresh: "#btn-refresh",
    btnSettings: "#btn-settings", statusPill: "#status-pill", statusDetail: "#status-detail",
    settings: "#settings", btnSettingsBack: "#btn-settings-back", modeLocal: "#mode-local",
    modeDirect: "#mode-direct", modelSelect: "#model-select", showAll: "#show-all",
    models: "#models", btnModels: "#btn-models", btnModelsBack: "#btn-models-back",
    btnModelsRefresh: "#btn-models-refresh", modelSearch: "#model-search", modelCount: "#model-count",
    modelList: "#model-list", modelFilters: "#model-filters", btnPickModel: "#btn-pick-model",
    pickModelName: "#pick-model-name",
    agentField: "#agent-field", agentSelect: "#agent-select", dirField: "#dir-field",
    dirInput: "#dir-input", gatewayUrl: "#gateway-url", directNote: "#direct-note", btnSave: "#btn-save",
    btnDelete: "#btn-delete", login: "#login", loginForm: "#login-form", loginPassword: "#login-password",
    loginError: "#login-error", toast: "#toast",
  };
  for (const [k, sel] of Object.entries(ids)) dom[k] = $(sel);

  dom.showAll.checked = localStorage.getItem(LS.showAll) === "1";
  try {
    state.favs = new Set(JSON.parse(localStorage.getItem(LS.favs) || "[]"));
  } catch {
    state.favs = new Set();
  }
  applyTheme(state.theme, false);

  // الشريط العلوي
  dom.btnMenu.addEventListener("click", openDrawer);
  dom.btnModel.addEventListener("click", openModels);
  dom.btnTheme.addEventListener("click", () => {
    const order = ["system", "light", "dark"];
    const next = order[(order.indexOf(state.theme) + 1) % order.length];
    applyTheme(next);
    toast("المظهر: " + (next === "system" ? "حسب النظام" : next === "light" ? "فاتح" : "غامق"));
  });

  // الترحيب
  dom.chips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    dom.input.value = chip.dataset.prompt || "";
    autoGrow();
    sendMessage();
  });

  // القائمة
  dom.btnDrawerClose.addEventListener("click", closeDrawer);
  dom.scrim.addEventListener("click", closeDrawer);
  dom.btnNew.addEventListener("click", newChat);
  dom.btnSearch.addEventListener("click", () => {
    dom.sessionSearch.classList.toggle("hidden");
    if (!dom.sessionSearch.classList.contains("hidden")) dom.sessionSearch.focus();
  });
  dom.btnSettings.addEventListener("click", openSettings);
  dom.btnRefresh.addEventListener("click", async () => {
    if (isDirect()) await loadDirectStatus();
    else await loadHealth();
    await loadModels();
    refreshSidebar();
    if (!isDirect() && state.session) await openSession(state.session.id);
    toast("تحدّث");
  });

  let searchTimer = null;
  dom.sessionSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshSidebar, 180);
  });

  // الإعدادات
  dom.btnSettingsBack.addEventListener("click", closeSettings);
  dom.btnSave.addEventListener("click", () => {
    closeSettings();
    toast("تسجّل");
  });
  dom.modeLocal.addEventListener("click", () => setMode("local"));
  dom.modeDirect.addEventListener("click", () => setMode("direct"));
  $$(".preset[data-theme]").forEach((b) =>
    b.addEventListener("click", () => applyTheme(b.dataset.theme))
  );

  dom.modelSelect.addEventListener("change", applyModelChange);

  // شاشة اختيار النموذج
  dom.btnModels.addEventListener("click", openModels);
  dom.btnModelsBack.addEventListener("click", closeModels);
  dom.btnPickModel.addEventListener("click", openModels);
  dom.btnModelsRefresh.addEventListener("click", async () => {
    await loadModels();
    toast("تحدّثت قائمة النماذج");
  });
  let modelSearchTimer = null;
  dom.modelSearch.addEventListener("input", () => {
    clearTimeout(modelSearchTimer);
    modelSearchTimer = setTimeout(renderModelList, 140);
  });
  dom.modelFilters.addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    state.modelFilter = b.dataset.filter;
    $$("#model-filters .preset").forEach((x) => x.classList.toggle("on", x === b));
    renderModelList();
  });

  dom.agentSelect.addEventListener("change", () => localStorage.setItem(LS.agent, dom.agentSelect.value));
  dom.showAll.addEventListener("change", () => {
    localStorage.setItem(LS.showAll, dom.showAll.checked ? "1" : "0");
    renderModelSelect();
  });
  dom.dirInput.addEventListener("change", () => {
    localStorage.setItem(LS.dir, dom.dirInput.value.trim());
    if (isDirect()) {
      const chat = currentChat();
      if (chat) {
        chat.workspace = dom.dirInput.value.trim();
        saveDirectChats();
      }
      return;
    }
    loadModels();
  });

  dom.btnDelete.addEventListener("click", async () => {
    if (isDirect()) {
      const chat = currentChat();
      if (!chat) return toast("ما كاينة محادثة");
      if (!confirm("حذف هذه المحادثة؟")) return;
      state.direct.chats = state.direct.chats.filter((c) => c.id !== chat.id);
      state.direct.current = null;
      saveDirectChats();
      closeSettings();
      renderMessages();
      renderDirectList();
      toast("تحذفات المحادثة");
      return;
    }
    if (!state.session) return toast("ما كاينة محادثة");
    if (!confirm("حذف هذه المحادثة؟")) return;
    await api(`/api/sessions/${encodeURIComponent(state.session.id)}`, { method: "DELETE" });
    closeSettings();
    newChat();
    toast("تحذفات المحادثة");
  });

  // الإدخال
  dom.btnSend.addEventListener("click", sendMessage);
  dom.btnStop.addEventListener("click", stopRun);
  dom.btnPlus.addEventListener("click", openSettings);
  dom.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  dom.input.addEventListener("input", autoGrow);

  // الإدخال الصوتي (إن توفّر)
  dom.btnMic.addEventListener("click", () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast("الإدخال الصوتي غير مدعوم فهاد المتصفح");
    if (recognizer) {
      recognizer.stop();
      recognizer = null;
      return;
    }
    recognizer = new SR();
    recognizer.lang = "ar-SA";
    recognizer.continuous = false;
    recognizer.interimResults = true;
    recognizer.onresult = (e) => {
      let text = "";
      for (const r of e.results) text += r[0].transcript;
      dom.input.value = text;
      autoGrow();
    };
    recognizer.onend = () => {
      recognizer = null;
    };
    recognizer.onerror = () => {
      recognizer = null;
      toast("تعذّر الإدخال الصوتي");
    };
    try {
      recognizer.start();
    } catch {
      recognizer = null;
    }
  });

  // تسجيل الدخول
  dom.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    dom.loginError.classList.add("hidden");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: dom.loginPassword.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "كلمة السر غير صحيحة");
      dom.login.classList.add("hidden");
      dom.loginPassword.value = "";
      await initData();
    } catch (err) {
      dom.loginError.textContent = err.message;
      dom.loginError.classList.remove("hidden");
    }
  });

  // تغيّر مظهر النظام
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme("system", false);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModels();
      closeSettings();
      closeDrawer();
    }
  });
}

async function initData() {
  if (!isDirect()) await loadHealth();
  await loadModels();
  await loadAgents();
  if (isDirect()) {
    loadDirectChats();
    if (!state.direct.current && state.direct.chats[0]) state.direct.current = state.direct.chats[0];
    renderDirectList();
    await loadDirectStatus();
  } else {
    await loadSessions();
  }
  updateHeader();
  renderMessages();
  updateRunningUi();
}

async function init() {
  bind();
  setupPwa();
  // إلا كان الوضع المحلي مسدود على هاد السيرفر (نفق ولا نشر) → دوز مباشرة للوضع المباشر
  if (state.mode === "local") {
    try {
      const h = await api("/api/health");
      state.localAvailable = h.localAvailable !== false;
      if (!state.localAvailable) {
        state.mode = "direct";
        localStorage.setItem(LS.mode, "direct");
        setTimeout(() => toast("الوضع المحلي مسدود فهاد السيرفر — دوزنا للوضع «مباشر»"), 1000);
      }
    } catch {
      /* تجاهل */
    }
  }
  setMode(state.mode);
  renderMessages();
  updateRunningUi();
  await initData();
  connectEvents();
  startPolling();
  autoGrow();
  dom.input.focus();
}

init();
