const WEB = "http://127.0.0.1:8790";

async function json(p) {
  const res = await fetch(WEB + p);
  const t = await res.text();
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

const st = await json("/api/direct/status");
console.log("STATUS:", JSON.stringify({ reachable: st.reachable, tools: st.tools, models: st.models.length }));

const model = "deepseek-v4.1-flash-free";
const res = await fetch(WEB + "/api/direct/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "عرّف لي الصبر فـ 3 سطور." }],
  }),
});
console.log("CHAT:", res.status, res.headers.get("content-type"));
if (res.status !== 200) {
  console.log(await res.text());
  process.exit(1);
}

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
    try { events.push(JSON.parse(raw.slice(5).trim())); } catch {}
  }
}

const text = events.filter((e) => e.type === "text.delta").map((e) => e.delta).join("");
const reasoning = events.filter((e) => e.type === "reasoning.delta").map((e) => e.delta).join("");
const toolEvents = events.filter((e) => e.type.startsWith("tool."));
const usage = events.filter((e) => e.type === "step.end").map((e) => e.usage);
console.log("\n--- نص الإجابة ---\n" + text);
console.log("\n--- طول التفكير ---", reasoning.length);
console.log("--- أحداث أدوات ---", toolEvents.length);
console.log("--- usage ---", JSON.stringify(usage));
console.log("--- types ---", [...new Set(events.map((e) => e.type))].join(", "));
process.exit(0);
