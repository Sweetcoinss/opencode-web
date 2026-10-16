const WEB = "http://127.0.0.1:8790";

async function raw(method, p, body, headers = {}) {
  const res = await fetch(WEB + p, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type"), text };
}

async function json(method, p, body) {
  const r = await raw(method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r.text ? JSON.parse(r.text) : null;
}

for (const file of ["/", "/style.css", "/app.js", "/nope"]) {
  const r = await raw("GET", file);
  console.log(`GET ${file} -> ${r.status} ${r.type} (${r.text.length} bytes)`);
}

const { sessions } = await json("GET", "/api/sessions?limit=60&parentID=null");
console.log("SESSIONS:", sessions.length);
if (sessions[0]) console.log("  first:", JSON.stringify({ id: sessions[0].id, title: sessions[0].title, model: sessions[0].model?.id, dir: sessions[0].directory, cost: sessions[0].cost }));

const { session } = await json("POST", "/api/sessions", {
  model: { providerID: "opencode", id: "big-pickle" },
  agent: "build",
  title: "عنوان مؤقت",
});
console.log("created:", session.id);

const patched = await json("PATCH", `/api/sessions/${session.id}`, { title: "عنوان جديد بالعربية" });
console.log("PATCH title ->", patched.session?.title);

await json("POST", `/api/sessions/${session.id}/model`, { model: { providerID: "opencode", id: "cat-jam-free" } });
const after = await json("GET", `/api/sessions/${session.id}`);
console.log("model after switch ->", after.session.model.id);

// run then interrupt
await json("POST", `/api/sessions/${session.id}/prompt`, { text: "اكتب 300 كلمة عن البحر." });
await new Promise((r) => setTimeout(r, 2500));
const int = await json("POST", `/api/sessions/${session.id}/interrupt`);
console.log("interrupt ->", JSON.stringify(int));
await new Promise((r) => setTimeout(r, 2000));
const info = await json("GET", `/api/sessions/${session.id}`);
console.log("after interrupt outcome:", info.session.outcome, "idle:", !!info.session.time?.idle);

const perms = await json("GET", `/api/sessions/${session.id}/permissions`);
console.log("permissions ->", JSON.stringify(perms));

await json("DELETE", `/api/sessions/${session.id}`);
console.log("deleted OK");
process.exit(0);
