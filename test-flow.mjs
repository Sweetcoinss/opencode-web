const WEB = "http://127.0.0.1:8790";

async function api(method, p, body) {
  const res = await fetch(WEB + p, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const health = await api("GET", "/api/health");
console.log("HEALTH:", JSON.stringify(health));

const { models } = await api("GET", "/api/models");
const free = models.filter((m) => m.free);
console.log("MODELS:", models.length, "FREE:", free.length);
console.log("FREE LIST:", free.map((m) => `${m.id}(${Math.round((m.context || 0) / 1000)}K)`).join(", "));

const { agents } = await api("GET", "/api/agents");
console.log("AGENTS:", agents.map((a) => a.id).join(", "));

// SSE
const events = [];
const esRes = await fetch(WEB + "/api/events", { headers: { Accept: "text/event-stream" } });
console.log("SSE status:", esRes.status, esRes.headers.get("content-type"));
const reader = esRes.body.getReader();
const dec = new TextDecoder();
let buf = "";
const pump = (async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(chunk.replace(/^data:\s*/, "")));
      } catch {}
    }
  }
})();

const { session } = await api("POST", "/api/sessions", {
  model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
  agent: "build",
  title: "اختبار الواجهة",
});
console.log("SESSION:", session.id, JSON.stringify(session.model));

await api("POST", `/api/sessions/${session.id}/prompt`, { text: "اكتب جملة قصيرة بالعربية ثم نفّذ الأمر echo arabic-test عبر bash." });
console.log("prompt sent");

const types = new Map();
const started = Date.now();
let done = false;
const watcher = (async () => {
  while (!done) {
    await new Promise((r) => setTimeout(r, 500));
    for (const ev of events) {
      const sid = ev.data?.sessionID;
      if (sid && sid !== session.id) continue;
      if (ev.type === "session.text.delta" || ev.type === "session.reasoning.delta") {
        types.set(ev.type, (types.get(ev.type) || 0) + 1);
      }
    }
  }
})();

while (Date.now() - started < 120000) {
  await new Promise((r) => setTimeout(r, 2000));
  const { messages } = await api("GET", `/api/sessions/${session.id}/messages`);
  const last = messages.filter((m) => m.type === "assistant").pop();
  if (last && last.time?.completed) {
    console.log("ASSISTANT PARTS:", (last.content || []).map((p) => p.type + (p.type === "tool" ? `:${p.name}:${p.state?.status}` : "")).join(" | "));
    const text = (last.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
    console.log("TEXT:", text);
    const tools = (last.content || []).filter((p) => p.type === "tool");
    for (const t of tools) {
      console.log("TOOL", t.name, JSON.stringify(t.state?.input), "=>", JSON.stringify(t.state?.content || t.state?.error).slice(0, 200));
    }
    console.log("TOKENS:", JSON.stringify(last.tokens), "COST:", last.cost);
    break;
  }
}
done = true;
await watcher;
console.log("DELTA EVENT COUNTS:", JSON.stringify([...types.entries()]));
console.log("TOTAL EVENTS RECEIVED:", events.length);
console.log("EVENT TYPES:", [...new Set(events.map((e) => e.type))].join(", "));

await api("DELETE", `/api/sessions/${session.id}`);
console.log("session deleted: OK");
process.exit(0);
