/**
 * direct.mjs — عميل مباشر لبوابة OpenCode المجانية (بدون خدمة opencode المحلية)
 *
 * نفس الحاجة اللي كيديرها opencode:
 *   POST {BASE}/chat/completions
 *   Authorization: Bearer public
 *   User-Agent: opencode/<version>
 *   x-opencode-client / x-opencode-project / x-opencode-session / x-opencode-request
 *   stream: true  +  tools فيها بالضبط "read" و "bash"
 *
 * ملاحظة صريحة: هادا عميل غير رسمي. البوابة كتشيك بلي الطلب جاي من عميل
 * OpenCode، وحنا كنقلدو نفس الطلب. يمكن OpenCode يقفل هادشي فأي وقت،
 * وكاينة حصة استعمال مجانية محدودة.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, execSync } from "node:child_process";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const CONFIG = {
  base: (process.env.DIRECT_BASE_URL || "https://opencode.ai/inference/v1").replace(/\/+$/, ""),
  client: process.env.DIRECT_CLIENT || "cli",
  projectID: process.env.DIRECT_PROJECT_ID || "global",
  workspace: process.env.WORKSPACE || process.cwd(),
  enableTools: process.env.ENABLE_TOOLS === "1",
  showAll: process.env.DIRECT_SHOW_ALL === "1",
  maxSteps: Number(process.env.MAX_STEPS || 8),
  toolTimeout: Number(process.env.TOOL_TIMEOUT_MS || 30000),
};

// ------------------------------------------------------------------ معرّفات OpenCode

const MASK = 0xffffffffffffffffn;

export function createId(descending, time = Date.now(), counter = 1) {
  let n = BigInt(time) * 0x1000n + BigInt(counter);
  if (descending) n = ~n & MASK;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(n);
  const bytes = crypto.randomBytes(14);
  let rand = "";
  for (let i = 0; i < 14; i++) rand += BASE62[bytes[i] % 62];
  return buf.subarray(2).toString("hex") + rand; // 12 hex + 14 base62
}

export const newSessionId = () => "ses_" + createId(true);
export const newRequestId = () => "msg_" + createId(false);

let cachedVersion = process.env.DIRECT_VERSION || null;
export function gatewayVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const out = execSync("opencode --version", {
      encoding: "utf8",
      timeout: 20000,
      shell: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    if (m) cachedVersion = m[1];
  } catch {
    /* غير مثبت */
  }
  if (!cachedVersion) cachedVersion = "2.0.30";
  return cachedVersion;
}

function fingerprintHeaders(sessionID, requestID) {
  return {
    Authorization: "Bearer public",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": `opencode/${gatewayVersion()}`,
    "x-opencode-client": CONFIG.client,
    "x-opencode-project": CONFIG.projectID,
    "x-opencode-session": sessionID,
    "x-opencode-request": requestID,
  };
}

// ------------------------------------------------------------------ الأدوات

export const TOOLS = [
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
  {
    type: "function",
    function: {
      name: "write",
      description: "Write (create or overwrite) a file inside the workspace. Creates parent directories.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path of the file to write." },
          content: { type: "string", description: "Full content of the file." },
        },
        required: ["filePath", "content"],
      },
    },
  },
];

// ⚠️ حقيقة مهمة: بوابة المجانية ما كتقبلش الطلب إلا كان فالمتن `tools` فيها
// الأداتين بالضبط "read" و "bash" (وإلا: 403 FreeTierError).
// علاش كنصيفطوهم دايما — حتى فوضع "دردشة فقط" — ولكن غير كأسماء، ما كيتنفذ والو.
const GATE_TOOL_NAMES = ["read", "bash"];
export const gateTools = () => TOOLS.filter((t) => GATE_TOOL_NAMES.includes(t.function.name));

function insideRoot(root, p) {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  return !rel.startsWith("..") && !path.isAbsolute(rel) ? abs : null;
}

function clip(text, max = 20000) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) + `\n… [تم قطع ${s.length - max} حرف]` : s;
}

function runShell(command, cwd, timeout) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const file = isWin ? "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
    execFile(
      file,
      args,
      { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout || ""}${stderr || ""}`.trim();
        if (err && err.killed) resolve({ error: `انتهت المهلة (${timeout}ms)` });
        else if (err && !out) resolve({ error: err.message });
        else resolve({ output: clip(out || "(بدون مخرجات)") });
      }
    );
  });
}

export async function runTool(name, input, ctx = {}) {
  const root = ctx.cwd || CONFIG.workspace;
  try {
    if (name === "read") {
      const target = insideRoot(root, String(input.filePath || input.path || ""));
      if (!target) return { error: "المسار خارج مجلد العمل" };
      const raw = await fsp.readFile(target, "utf8");
      const lines = raw.split(/\r?\n/);
      const offset = Math.max(1, Number(input.offset) || 1);
      const limit = Number(input.limit) || lines.length;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      return { output: clip(slice.map((l, i) => `${offset + i}: ${l}`).join("\n")) };
    }
    if (name === "write") {
      const target = insideRoot(root, String(input.filePath || input.path || ""));
      if (!target) return { error: "المسار خارج مجلد العمل" };
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, String(input.content ?? ""), "utf8");
      return { output: `تمت الكتابة: ${target}` };
    }
    if (name === "bash") {
      return await runShell(String(input.command ?? ""), root, CONFIG.toolTimeout);
    }
    return { error: `أداة غير معروفة: ${name}` };
  } catch (err) {
    return { error: `خطأ: ${err.message}` };
  }
}

// ------------------------------------------------------------------ الشبكة

export async function listModels() {
  const res = await fetch(`${CONFIG.base}/models`, {
    headers: fingerprintHeaders(newSessionId(), newRequestId()),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const all = (json.data || []).map((m) => ({
    id: m.id,
    name: m.id,
    free: m.id === "big-pickle" || m.id.endsWith("-free"),
    owned_by: m.owned_by || "opencode",
  }));
  // المفتاح "public" كيسمح غير بالنماذج المجانية
  return CONFIG.showAll ? all : all.filter((m) => m.free);
}

async function* streamTurn({ model, messages, sessionID, tools, signal }) {
  const res = await fetch(`${CONFIG.base}/chat/completions`, {
    method: "POST",
    headers: fingerprintHeaders(sessionID, newRequestId()),
    signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      tools,
      tool_choice: "auto",
    }),
  });

  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => "");
    let message = raw;
    try {
      const j = JSON.parse(raw);
      message = j?.error?.message || j?.message || raw;
    } catch {
      /* نص عادي */
    }
    throw Object.assign(new Error(message || `HTTP ${res.status}`), { status: res.status });
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let reasoning = "";
  const calls = [];
  let finish = null;
  let usage = null;
  let modelID = model;

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
      if (delta.content) {
        text += delta.content;
        yield { type: "text.delta", delta: delta.content };
      }
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        yield { type: "reasoning.delta", delta: delta.reasoning_content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          calls[i] = calls[i] || { id: "", name: "", arguments: "" };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }

  yield { type: "turn.end", text, reasoning, toolCalls: calls.filter(Boolean), finish, usage, model: modelID };
}

// ------------------------------------------------------------------ حلقة الوكيل

function systemPrompt(workspace, toolsEnabled) {
  if (!toolsEnabled) {
    return [
      "You are a language model: you can only talk. Nothing more.",
      "You have no tools, no files, no internet, no accounts and no system access. You cannot create, edit, run, download, save or execute anything,",
      "and you cannot perform any action on the user's behalf — you can only produce text.",
      "Never claim you did, made, built, searched, opened, downloaded or executed something. Never output fake tool calls, fake file contents,",
      "fake links to generated files, or fake confirmations that an action was completed. If you are unsure, say so honestly.",
      "If the user asks you to do or make something that needs an action, say clearly and briefly that you are a language model that only answers with text,",
      "then help as much as you can with words: explain, write, summarize, translate, compare, brainstorm, correct, draft text.",
      "Answer directly and conversationally, in the same language the user used. Be clear, natural and well formatted.",
    ].join("\n");
  }
  return [
    "You are OpenCode, an AI coding agent running inside a web chat.",
    `Workspace: ${workspace}`,
    `Platform: ${process.platform}`,
    "You can use the read, write and bash tools to inspect and modify files inside the workspace.",
    "Use tools when they help. Prefer short, direct answers. Answer in the same language as the user.",
  ].join("\n");
}

export async function* runAgent({ model, messages, workspace, signal }) {
  const cwd = workspace || CONFIG.workspace;
  const sessionID = newSessionId();
  const tools = CONFIG.enableTools ? TOOLS : gateTools();
  const history = [{ role: "system", content: systemPrompt(cwd, CONFIG.enableTools) }, ...messages];

  yield {
    type: "session",
    sessionID,
    workspace: cwd,
    chatOnly: !CONFIG.enableTools,
    tools: CONFIG.enableTools ? ["read", "write", "bash"] : [],
  };

  for (let step = 0; step < CONFIG.maxSteps; step++) {
    yield { type: "step.start", step };
    let turn = null;
    for await (const ev of streamTurn({ model, messages: history, sessionID, tools, signal })) {
      if (ev.type === "turn.end") turn = ev;
      else yield ev;
    }
    if (!turn) break;

    yield {
      type: "step.end",
      step,
      finish: turn.finish,
      usage: turn.usage,
      model: turn.model,
    };

    const assistant = {
      role: "assistant",
      content: turn.text || null,
    };
    if (turn.toolCalls.length) {
      assistant.tool_calls = turn.toolCalls.map((c) => ({
        id: c.id || "call_" + createId(false).slice(0, 12),
        type: "function",
        function: { name: c.name, arguments: c.arguments || "{}" },
      }));
    }
    history.push(assistant);

    if (!turn.toolCalls.length) break;

    for (const call of turn.toolCalls) {
      const id = call.id || call.name + "-" + Math.random().toString(36).slice(2, 8);
      let input = {};
      try {
        input = JSON.parse(call.arguments || "{}");
      } catch {
        /* نتركه فارغًا */
      }
      // فوضع الدردشة فقط: ما كنعرضو حتى شي بطاقة أداة — كنرجعو للموديل جوابًا قصيرًا وكنكملو
      if (CONFIG.enableTools) yield { type: "tool.start", id, name: call.name, input };
      const result = CONFIG.enableTools
        ? await runTool(call.name, input, { cwd })
        : { error: "الأدوات معطّلة. جاوب مباشرة بلا أدوات." };
      const status = result.error ? "error" : "completed";
      if (CONFIG.enableTools) {
        yield {
          type: "tool.end",
          id,
          name: call.name,
          status,
          output: result.output || "",
          error: result.error || null,
        };
      }
      history.push({
        role: "tool",
        tool_call_id: id,
        content: result.output || result.error || "(بدون نتيجة)",
      });
    }
  }

  yield { type: "done" };
}
