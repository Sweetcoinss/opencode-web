const WEB = "http://127.0.0.1:8790";

async function json(method, p, body) {
  const res = await fetch(WEB + p, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const status = await json("GET", "/api/direct/status");
console.log("STATUS:", JSON.stringify({ reachable: status.reachable, base: status.base, version: status.version, tools: status.tools, models: status.models.length, error: status.error }));

const { models } = await json("GET", "/api/direct/models");
console.log("DIRECT MODELS:", models.map((m) => m.id).join(", "));

// ---- chat with a tool call (read + bash) ----
const model = "deepseek-v4.1-flash-free";
const messages = [
  { role: "user", content: "عطيني اسم ونسخة الملف package.json، واستعمل الأدوات. من بعد نفذ echo direct-ok." },
];

const res = await fetch(WEB + "/api/direct/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages, workspace: process.cwd() }),
});
console.log("CHAT status:", res.status, res.headers.get("content-type"));

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
    } catch {}
  }
}

const text = events.filter((e) => e.type === "text.delta").map((e) => e.delta).join("");
const reasoning = events.filter((e) => e.type === "reasoning.delta").map((e) => e.delta).join("");
const tools = events.filter((e) => e.type === "tool.start" || e.type === "tool.end");
const usage = events.filter((e) => e.type === "step.end").map((e) => e.usage);
console.log("\n--- reasoning ---\n" + reasoning.slice(0, 200));
console.log("\n--- text ---\n" + text);
console.log("\n--- tools ---");
for (const t of tools) {
  console.log(t.type, t.name, JSON.stringify(t.input || t.output || t.error || "").slice(0, 180));
}
console.log("\n--- usage ---", JSON.stringify(usage));
console.log("\nEVENT TYPES:", [...new Set(events.map((e) => e.type))].join(", "));
process.exit(0);
