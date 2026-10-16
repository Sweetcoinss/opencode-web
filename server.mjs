#!/usr/bin/env node
/**
 * opencode-web
 * ------------------------------------------------------------------
 * خادم محلي صغير (بدون أي مكتبات خارجية) يفتح واجهة ويب بالعربية
 * للمحادثة مع النماذج المجانية في OpenCode.
 *
 * الفكرة: برنامج OpenCode يشغّل خدمة خلفية (background service) عند
 * أول تشغيل، وهذه الخدمة تعرض HTTP API على المنفذ المحلي. النماذج
 * المجانية (مزوّد `opencode`) تعمل بدون تسجيل دخول لأنها تستعمل
 * مفتاحًا عامًا (apiKey = "public")، والخدمة نفسها تتكفّل بترويسة
 * تعريف العميل المطلوبة من البوابة.
 *
 * هذا الخادم يعمل فقط كوسيط (proxy) بين المتصفح وتلك الخدمة، ويضيف
 * المصادقة (Basic) ويحوّل بثّ الأحداث (SSE) إلى المتصفح.
 * ------------------------------------------------------------------
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CONFIG as DIRECT,
  gatewayVersion,
  listModels as directListModels,
  runAgent as directRunAgent,
} from "./direct.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const WEB_HOST = process.env.WEB_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const WEB_PORT = Number(process.env.WEB_PORT || process.env.PORT || 8790);

let serverUrl = (process.env.OPENCODE_URL || "").replace(/\/+$/, "") || null;
let password = process.env.OPENCODE_PASSWORD || null;

const log = (...a) => console.log("[opencode-web]", ...a);

function prettyModelName(id) {
  const name = String(id)
    .replace(/-free$/, "")
    .split("-")
    .map((w) => {
      if (/^v\d/.test(w)) return w;
      if (w.length <= 2) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ")
    .trim();
  return name;
}

// ------------------------------------------------------------------
// حماية اختيارية بكلمة سر (للنشر العمومي)
// ------------------------------------------------------------------

const APP_PASSWORD = process.env.APP_PASSWORD || null;
const AUTH_TOKEN = APP_PASSWORD
  ? crypto.createHash("sha256").update("opencode-web:" + APP_PASSWORD).digest("hex")
  : null;

// ------------------------------------------------------------------
// حماية الوضع المحلي
// الوضع المحلي كيدوز على خدمة OpenCode ديال الحاسوب (ملفات + أوامر)،
// علاش ما خاصوش يكون متاح لأي واحد عندو الرابط (نفق ولا نشر).
// ------------------------------------------------------------------

/** طلب جاي من نفس الحاسوب — بلا نفق ولا بروكسي */
function isLocalRequest(req) {
  const host = String(req.headers.host || "")
    .split(":")[0]
    .toLowerCase();
  const isLocalHost = ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"].includes(host);
  const proxied =
    req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["x-real-ip"];
  return isLocalHost && !proxied;
}

/** مطفي الوضع المحلي بالكامل (للنشر على سيرفر) */
const DISABLE_LOCAL = process.env.DISABLE_LOCAL === "1";

/** المسارات العمومية الوحيدة: الحالة + تسجيل الدخول + الوضع المباشر */
function isPublicApi(p) {
  return p === "/api/health" || p === "/api/login" || p.startsWith("/api/direct/");
}

function cookieToken(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "ocw_auth") return v.join("=");
  }
  return null;
}

function isAuthorized(req) {
  if (!AUTH_TOKEN) return true;
  const token = cookieToken(req);
  if (!token || token.length !== AUTH_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// اكتشاف خدمة OpenCode (العنوان + كلمة السر)
// ------------------------------------------------------------------

function readPasswordFromDisk() {
  const file = path.join(os.homedir(), ".config", "opencode", "service.json");
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    if (json && typeof json.password === "string") return json.password;
  } catch {
    /* تجاهل */
  }
  return null;
}

function discoverServerUrl() {
  if (serverUrl) return serverUrl;
  if (process.env.OPENCODE_URL) {
    serverUrl = process.env.OPENCODE_URL.replace(/\/+$/, "");
    return serverUrl;
  }
  try {
    const out = execSync("opencode service status", {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
    });
    const m = out.match(/https?:\/\/[^\s"']+/);
    if (m) serverUrl = m[0].replace(/\/+$/, "");
  } catch {
    /* تجاهل: قد لا يكون الأمر في PATH */
  }
  return serverUrl;
}

function authHeader() {
  if (!password) return null;
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

function refreshCredentials() {
  password = process.env.OPENCODE_PASSWORD || readPasswordFromDisk();
}

async function callOnce(target, p, opts) {
  const headers = { Accept: "application/json" };
  const auth = authHeader();
  if (auth) headers.Authorization = auth;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, opts.headers || {});
  return fetch(target + p, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** نداء إلى خدمة OpenCode مع إعادة محاولة واحدة عند 401. */
async function oc(p, opts = {}) {
  if (!discoverServerUrl()) {
    const err = new Error(
      "لم يتم العثور على خدمة OpenCode الخلفية. افتح OpenCode مرة واحدة (أو نفّذ: opencode service start) ثم أعد تحديث الصفحة."
    );
    err.status = 503;
    throw err;
  }
  let res = await callOnce(serverUrl, p, opts);
  if (res.status === 401) {
    refreshCredentials();
    serverUrl = null;
    discoverServerUrl();
    res = await callOnce(serverUrl, p, opts);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const message =
      (data && (data.message || data.error?.message || data.raw)) || `HTTP ${res.status}`;
    const err = new Error(typeof message === "string" ? message : JSON.stringify(message));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------
// أدوات HTTP صغيرة
// ------------------------------------------------------------------

function sendJson(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function sendError(res, err) {
  const status = err && err.status && err.status >= 400 ? err.status : 500;
  sendJson(res, status, { error: err?.message || String(err) });
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("الطلب أكبر من الحد المسموح"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("JSON غير صالح"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("غير موجود");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  });
}

// ------------------------------------------------------------------
// بثّ الأحداث (SSE) من خدمة OpenCode إلى كل المتصفحات المفتوحة
// ------------------------------------------------------------------

const sseClients = new Set();
let sseConnecting = false;
let lastSseError = null;

function broadcast(chunk) {
  for (const client of sseClients) {
    try {
      client.write(chunk);
    } catch {
      sseClients.delete(client);
    }
  }
}

async function connectUpstream() {
  if (sseConnecting) return;
  if (!discoverServerUrl()) {
    setTimeout(connectUpstream, 3000);
    return;
  }
  sseConnecting = true;
  try {
    const auth = authHeader();
    const res = await fetch(serverUrl + "/api/event", {
      headers: {
        Accept: "text/event-stream",
        ...(auth ? { Authorization: auth } : {}),
      },
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    lastSseError = null;
    log("تم الاتصال ببثّ أحداث OpenCode");
    broadcast(`data: ${JSON.stringify({ type: "gateway.connected", data: {} })}\n\n`);
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) broadcast(Buffer.from(value));
    }
    throw new Error("انتهى البثّ");
  } catch (err) {
    lastSseError = err?.message || String(err);
    log("انقطع بثّ الأحداث:", lastSseError);
  } finally {
    sseConnecting = false;
    setTimeout(connectUpstream, 2000);
  }
}

// ------------------------------------------------------------------
// المسارات
// ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const q = url.searchParams;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  try {
    // ---------------- تسجيل الدخول (اختياري) ----------------
    if (p === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      if (!AUTH_TOKEN) return sendJson(res, 200, { ok: true, protected: false });
      if (String(body.password ?? "") === APP_PASSWORD) {
        res.setHeader(
          "Set-Cookie",
          `ocw_auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
        );
        return sendJson(res, 200, { ok: true, protected: true });
      }
      return sendJson(res, 401, { error: "كلمة السر غير صحيحة" });
    }
    if (AUTH_TOKEN && p.startsWith("/api/") && !isAuthorized(req)) {
      return sendJson(res, 401, { error: "خاصك تسجل الدخول بكلمة السر", needPassword: true });
    }

    // ---------------- حماية الوضع المحلي ----------------
    // مسموح إلا من نفس الحاسوب، ولا من برّا إلا إلا كان السيرفر محمي بكلمة سر
    // ونتا مسجّل الدخول. DISABLE_LOCAL=1 كيطفي الوضع المحلي نهائيًا.
    const localAllowed =
      !DISABLE_LOCAL && (isLocalRequest(req) || (!!AUTH_TOKEN && isAuthorized(req)));

    if (p.startsWith("/api/") && !isPublicApi(p) && !localAllowed) {
      return sendJson(res, 403, {
        localDisabled: true,
        error: DISABLE_LOCAL
          ? "الوضع المحلي مطفي فهاد السيرفر (DISABLE_LOCAL=1). استعمل الوضع «مباشر»."
          : "الوضع المحلي مسموح غير من نفس الحاسوب — حيت كيوصل لملفات وأوامر حاسوبك. استعمل الوضع «مباشر»، ولا زيد APP_PASSWORD باش تحمي السيرفر.",
      });
    }

    // ---------------- معلومات الحالة ----------------
    if (p === "/api/health" && req.method === "GET") {
      let info = null;
      let location = null;
      let ready = false;
      try {
        info = await oc("/api/info");
        location = await oc("/api/location");
        ready = true;
      } catch (err) {
        lastSseError = err?.message || String(err);
      }
      return sendJson(res, 200, {
        ready,
        version: info?.version || null,
        server: localAllowed ? serverUrl : "محجوب",
        location: localAllowed ? location?.directory || null : null,
        streaming: sseClients.size > 0 ? "متصل" : lastSseError,
        needPassword: !!AUTH_TOKEN ? !isAuthorized(req) : false,
        localAvailable: localAllowed,
        direct: {
          base: DIRECT.base,
          version: gatewayVersion(),
          tools: DIRECT.enableTools ? ["read", "write", "bash"] : [],
          workspace: localAllowed ? DIRECT.workspace : null,
        },
        hint:
          "النماذج المجانية من مزوّد opencode تعمل بدون تسجيل دخول، أما بقية المزوّدات فتحتاج مفتاح API.",
      });
    }

    // ---------------- النماذج ----------------
    if (p === "/api/models" && req.method === "GET") {
      const directory = q.get("directory") || undefined;
      const query = directory
        ? "?" + new URLSearchParams({ "location[directory]": directory }).toString()
        : "";
      const result = await oc("/api/model" + query);
      const models = (result?.data || []).map((m) => {
        const cost = Array.isArray(m.cost) ? m.cost : [];
        const free = cost.length > 0 && cost.every((c) => !c.input && !c.output);
        return {
          id: m.modelID || m.id,
          providerID: m.providerID,
          name: m.name || m.modelID || m.id,
          free,
          enabled: m.enabled !== false,
          status: m.status || "active",
          family: m.family || null,
          context: m.limit?.context ?? null,
          output: m.limit?.output ?? null,
          input: m.capabilities?.input || ["text"],
          tools: !!m.capabilities?.tools,
          reasoning: (m.variants || []).length > 0,
          released: m.time?.released || 0,
        };
      });
      models.sort((a, b) => Number(b.free) - Number(a.free) || b.released - a.released);
      return sendJson(res, 200, { models });
    }

    // ---------------- الوكلاء ----------------
    if (p === "/api/agents" && req.method === "GET") {
      const result = await oc("/api/agent");
      const agents = (result?.data || [])
        .filter((a) => !a.hidden && (a.mode === "primary" || !a.mode))
        .map((a) => ({ id: a.id, name: a.name || a.id, description: a.description || "" }));
      return sendJson(res, 200, { agents });
    }

    // ---------------- الجلسات ----------------
    if (p === "/api/sessions" && req.method === "GET") {
      const params = new URLSearchParams();
      params.set("limit", q.get("limit") || "60");
      params.set("order", "desc");
      if (q.get("search")) params.set("search", q.get("search"));
      if (q.get("directory")) params.set("directory", q.get("directory"));
      const result = await oc("/api/session?" + params.toString());
      const sessions = (result?.data || []).map((s) => ({
        id: s.id,
        title: s.title || "بدون عنوان",
        parentID: s.parentID || null,
        agent: s.agent || null,
        model: s.model || null,
        cost: s.cost ?? 0,
        tokens: s.tokens || null,
        outcome: s.outcome || null,
        running: !s.time?.idle,
        directory: s.location?.directory || null,
        created: s.time?.created || 0,
        updated: s.time?.updated || 0,
      }));
      return sendJson(res, 200, { sessions });
    }

    if (p === "/api/sessions" && req.method === "POST") {
      const body = await readBody(req);
      const payload = { title: body.title || null, agent: body.agent || null };
      if (body.model) payload.model = body.model;
      if (body.directory) payload.location = { directory: body.directory };
      const result = await oc("/api/session", { method: "POST", body: payload });
      return sendJson(res, 200, { session: result?.data || null });
    }

    const sessionMatch = p.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    if (sessionMatch) {
      const sid = decodeURIComponent(sessionMatch[1]);
      const rest = sessionMatch[2] || "";
      const base = `/api/session/${encodeURIComponent(sid)}`;

      if (!rest && req.method === "GET") {
        const result = await oc(base);
        return sendJson(res, 200, { session: result?.data || null });
      }
      if (!rest && req.method === "DELETE") {
        await oc(base, { method: "DELETE" });
        return sendJson(res, 200, { ok: true });
      }
      if (!rest && req.method === "PATCH") {
        const body = await readBody(req);
        await oc(base, { method: "PATCH", body: { title: body.title ?? null } });
        return sendJson(res, 200, { ok: true });
      }
      if (rest === "/messages" && req.method === "GET") {
        const params = new URLSearchParams({ order: "asc", limit: q.get("limit") || "200" });
        const result = await oc(`${base}/message?${params.toString()}`);
        const messages = (result?.data || []).filter((m) => m.type === "user" || m.type === "assistant");
        return sendJson(res, 200, { messages });
      }
      if (rest === "/prompt" && req.method === "POST") {
        const body = await readBody(req);
        const result = await oc(`${base}/prompt`, {
          method: "POST",
          body: { text: String(body.text ?? "") },
        });
        return sendJson(res, 200, { ok: true, data: result?.data || null });
      }
      if (rest === "/interrupt" && req.method === "POST") {
        await oc(`${base}/interrupt?resume=false`, { method: "POST", body: {} });
        return sendJson(res, 200, { ok: true });
      }
      if (rest === "/model" && req.method === "POST") {
        const body = await readBody(req);
        await oc(`${base}/model`, { method: "POST", body: { model: body.model } });
        return sendJson(res, 200, { ok: true });
      }
      if (rest === "/permissions" && req.method === "GET") {
        const result = await oc(`${base}/permission`);
        return sendJson(res, 200, { permissions: result?.data || [] });
      }
      const permMatch = rest.match(/^\/permissions\/([^/]+)\/reply$/);
      if (permMatch && req.method === "POST") {
        const body = await readBody(req);
        const rid = encodeURIComponent(decodeURIComponent(permMatch[1]));
        await oc(`${base}/permission/${rid}/reply`, {
          method: "POST",
          body: { decision: body.decision || "once", message: body.message ?? null },
        });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: "مسار غير معروف" });
    }

    // ---------------- الوضع المباشر (بدون خدمة opencode) ----------------
    if (p === "/api/direct/status" && req.method === "GET") {
      let models = [];
      let error = null;
      try {
        models = await directListModels();
      } catch (err) {
        error = err.message;
      }
      return sendJson(res, 200, {
        enabled: true,
        reachable: !error,
        error,
        base: DIRECT.base,
        version: gatewayVersion(),
        client: DIRECT.client,
        tools: DIRECT.enableTools ? ["read", "write", "bash"] : [],
        maxSteps: DIRECT.maxSteps,
        workspace: localAllowed ? DIRECT.workspace : null,
        localAvailable: localAllowed,
        models: models.map((m) => m.id),
      });
    }

    if (p === "/api/direct/models" && req.method === "GET") {
      const models = await directListModels();
      return sendJson(res, 200, {
        models: models.map((m) => ({
          id: m.id,
          providerID: "opencode",
          name: prettyModelName(m.id),
          free: true,
          enabled: true,
          status: "active",
          context: null,
          input: ["text"],
          tools: DIRECT.enableTools,
        })),
      });
    }

    if (p === "/api/direct/chat" && req.method === "POST") {
      const body = await readBody(req);
      const model = String(body.model || "").trim();
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!model) return sendJson(res, 400, { error: "حدد النموذج" });
      if (!messages.length) return sendJson(res, 400, { error: "لا توجد رسائل" });

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      const send = (obj) => {
        try {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch {
          /* العميل قطع الاتصال */
        }
      };
      try {
        for await (const ev of directRunAgent({
          model,
          messages,
          workspace: body.workspace || DIRECT.workspace,
          signal: controller.signal,
        })) {
          send(ev);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          send({
            type: "error",
            message: err?.message || String(err),
            status: err?.status || null,
          });
        }
      }
      try {
        res.end();
      } catch {
        /* تم */
      }
      return;
    }

    // ---------------- بثّ الأحداث ----------------
    if (p === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ type: "gateway.hello", data: {} })}\n\n`);
      sseClients.add(res);
      if (!sseConnecting && sseClients.size === 1) connectUpstream();
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // ---------------- ملفات الواجهة ----------------
    if (req.method === "GET") return serveStatic(res, p);

    res.writeHead(405).end("method not allowed");
  } catch (err) {
    log("خطأ:", err?.message || err);
    sendError(res, err);
  }
});

// نبضة دورية لإبقاء اتصالات SSE حيّة
setInterval(() => {
  if (sseClients.size) broadcast(": ping\n\n");
}, 15000).unref?.();

refreshCredentials();
const found = discoverServerUrl();
if (!found) {
  log("تنبيه: لم أجد خدمة OpenCode. شغّل `opencode` مرة على الأقل ثم أعد تشغيل هذا الخادم.");
} else {
  log("خدمة OpenCode:", found, password ? "(مع مصادقة)" : "(بدون مصادقة)");
}

server.listen(WEB_PORT, WEB_HOST, () => {
  const url = `http://${WEB_HOST}:${WEB_PORT}`;
  log(`الموقع يعمل على: ${url}`);
  if (DISABLE_LOCAL) {
    log("الوضع المحلي: مطفي (DISABLE_LOCAL=1) — غير الوضع المباشر");
  } else if (!APP_PASSWORD && WEB_HOST !== "127.0.0.1") {
    log("⚠️  تنبيه أمني: الوضع المحلي كيبان للشبكة. من برّا كيتسدّ تلقائيًا،");
    log("   ولكن الأفضل تزيد APP_PASSWORD ولا DISABLE_LOCAL=1.");
  } else if (!APP_PASSWORD) {
    log("الوضع المحلي: متاح من هاد الحاسوب برك (كيتسدّ على النفق/الشبكة)");
  }
  log("أوقف التشغيل بـ Ctrl+C");
  connectUpstream();
});
