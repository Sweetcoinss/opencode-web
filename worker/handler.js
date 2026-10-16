/**
 * handler.js — نسخة Cloudflare Worker من الموقع
 *
 * نفس الوظيفة ديال server.mjs + direct.mjs، ولكن:
 *   • بلا خدمة opencode محلية (الوضع المحلي مطفي)
 *   • كيخدم من شبكة Cloudflare — بلا حاسوب، بلا نفق
 *   • الملفات الثابتة (index.html/style.css/app.js) كتدمج فـ build.mjs
 *
 * كيتنشر على: https://<name>.<account>.workers.dev
 */

const GATEWAY = "https://opencode.ai/inference/v1";
const VERSION = "2.0.30";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK = 0xffffffffffffffffn;

// البوابة كتشيك على شكل الطلب: خاصها stream + أدوات فيها بالضبط read و bash
const GATE_TOOLS = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read the contents of a file. Returns the file content with line numbers.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative path of the file to read." },
          offset: { type: "number", description: "1-based line to start from (optional)." },
          limit: { type: "number", description: "Maximum number of lines to read (optional)." },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command inside the workspace directory and return its output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command to execute." } },
        required: ["command"],
      },
    },
  },
];

const CHAT_ONLY_PROMPT = [
  "You are a friendly and helpful assistant.",
  "Answer the user's message directly and conversationally, in the same language they used.",
  "Do not call any tools — the user only wants a normal conversation.",
  "Be clear, natural and well formatted.",
].join("\n");

// ------------------------------------------------------------------ معرّفات OpenCode

function createId(descending, time = Date.now(), counter = 1) {
  let n = BigInt(time) * 0x1000n + BigInt(counter);
  if (descending) n = ~n & MASK;
  const timeBuf = new Uint8Array(8);
  new DataView(timeBuf.buffer).setBigUint64(0, n);
  const rand = new Uint8Array(14);
  crypto.getRandomValues(rand);
  let tail = "";
  for (let i = 0; i < 14; i++) tail += BASE62[rand[i] % 62];
  let hex = "";
  for (let i = 2; i < 8; i++) hex += timeBuf[i].toString(16).padStart(2, "0");
  return hex + tail;
}

const newSessionId = () => "ses_" + createId(true);
const newRequestId = () => "msg_" + createId(false);

function fingerprintHeaders(sessionID, requestID) {
  return {
    Authorization: "Bearer public",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": `opencode/${VERSION}`,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-session": sessionID,
    "x-opencode-request": requestID,
  };
}

// ------------------------------------------------------------------ أدوات

const prettyName = (id) =>
  String(id)
    .replace(/-free$/, "")
    .split("-")
    .map((w) => (/^v\d/.test(w) ? w : w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .trim();

const isFree = (id) => id === "big-pickle" || id.endsWith("-free");

async function listModels() {
  const res = await fetch(`${GATEWAY}/models`, {
    headers: fingerprintHeaders(newSessionId(), newRequestId()),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.data || [])
    .filter((m) => isFree(m.id))
    .map((m) => ({
      id: m.id,
      providerID: "opencode",
      name: prettyName(m.id),
      free: true,
      enabled: true,
      status: "active",
      context: null,
      input: ["text"],
      tools: false,
    }));
}

// ------------------------------------------------------------------ البثّ

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

async function chat(body) {
  const model = String(body.model || "").trim();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!model) return json({ error: "حدد النموذج" }, 400);
  if (!messages.length) return json({ error: "لا توجد رسائل" }, 400);

  const sessionID = newSessionId();
  let upstream;
  try {
    upstream = await fetch(`${GATEWAY}/chat/completions`, {
      method: "POST",
      headers: fingerprintHeaders(sessionID, newRequestId()),
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: CHAT_ONLY_PROMPT }, ...messages],
        stream: true,
        stream_options: { include_usage: true },
        tools: GATE_TOOLS,
        tool_choice: "auto",
      }),
    });
  } catch (err) {
    return json({ error: "تعذّر الوصول للبوابة: " + err.message }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    let msg = raw;
    try {
      const j = JSON.parse(raw);
      msg = j?.error?.message || j?.message || raw;
    } catch {
      /* نص عادي */
    }
    return json({ error: msg || `HTTP ${upstream.status}`, status: upstream.status }, upstream.status === 200 ? 502 : upstream.status);
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const reader = upstream.body.getReader();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (o) => {
        try {
          controller.enqueue(enc.encode(sse(o)));
        } catch {
          /* تسدّ */
        }
      };

      send({ type: "session", sessionID, workspace: null, chatOnly: true, tools: [] });
      send({ type: "step.start", step: 0 });

      let buf = "";
      let finish = null;
      let usage = null;
      let modelID = model;

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });

          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            let chunk;
            try {
              chunk = JSON.parse(payload);
            } catch {
              continue;
            }
            if (chunk.model) modelID = chunk.model;
            if (chunk.usage) usage = chunk.usage;

            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};
            if (delta.content) send({ type: "text.delta", delta: delta.content });
            if (delta.reasoning_content) send({ type: "reasoning.delta", delta: delta.reasoning_content });
            if (choice.finish_reason) finish = choice.finish_reason;
          }
        }

        send({ type: "step.end", step: 0, finish, usage, model: modelID });
        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: err?.message || String(err) });
      } finally {
        try {
          controller.close();
        } catch {
          /* تسدّ */
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

// ------------------------------------------------------------------ المساعدات

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
};

function asset(pathname) {
  const clean = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const body = ASSETS[clean];
  if (body === undefined) return null;
  const ext = clean.includes(".") ? clean.split(".").pop().toLowerCase() : "html";
  return new Response(body, {
    headers: {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function withCors(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ------------------------------------------------------------------ الموجّه

async function handle(request) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  // ---- الحالة
  if (p === "/api/health") {
    return json({
      ready: false,
      version: VERSION,
      server: "محجوب",
      location: null,
      streaming: "بلا سيرفر محلي",
      needPassword: false,
      localAvailable: false,
      direct: { base: GATEWAY, version: VERSION, tools: [], workspace: null },
      hint: "نسخة Cloudflare Worker — كتخدم بلا حاسوب.",
    });
  }

  if (p === "/api/login") return json({ ok: true, protected: false });

  // ---- الوضع المباشر
  if (p === "/api/direct/status") {
    let models = [];
    let error = null;
    try {
      models = await listModels();
    } catch (err) {
      error = err.message;
    }
    return json({
      enabled: true,
      reachable: !error,
      error,
      base: GATEWAY,
      version: VERSION,
      client: "cli",
      tools: [],
      maxSteps: 1,
      workspace: null,
      localAvailable: false,
      models: models.map((m) => m.id),
    });
  }

  if (p === "/api/direct/models") {
    try {
      return json({ models: await listModels() });
    } catch (err) {
      return json({ models: [], error: err.message }, 502);
    }
  }

  if (p === "/api/direct/chat" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "طلب غير صالح" }, 400);
    }
    return chat(body);
  }

  // ---- أي مسار محلي = مسدود (ما كاينش سيرفر محلي)
  if (p.startsWith("/api/")) {
    return json(
      {
        localDisabled: true,
        error: "هاد النسخة كتخدم من Cloudflare — الوضع المحلي ما كاينش. استعمل الوضع «مباشر».",
      },
      403
    );
  }

  // ---- الملفات الثابتة
  const a = asset(p);
  if (a) return a;
  const fallback = asset("/");
  return fallback || new Response("ما لقيتش", { status: 404 });
}

export default {
  async fetch(request) {
    try {
      return withCors(await handle(request));
    } catch (err) {
      return withCors(json({ error: err?.message || String(err) }, 500));
    }
  },
};
