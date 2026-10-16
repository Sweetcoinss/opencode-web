import crypto from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function createID(descending, t = Date.now(), counter = 1) {
  let n = BigInt(t) * 0x1000n + BigInt(counter);
  if (descending) n = ~n & 0xffffffffffffffffn;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(n);
  const hex = buf.subarray(2).toString("hex"); // 12 hex chars
  let rand = "";
  const bytes = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) rand += BASE62[bytes[i] % 62];
  return hex + rand;
}

const sessionID = "ses_" + createID(true);
const requestID = "msg_" + createID(false);
console.log("ses:", sessionID, sessionID.length);
console.log("msg:", requestID);

function eidHeaders(client = "cli", version = "2.0.30") {
  return {
    Authorization: "Bearer public",
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `opencode/${version}`,
    "x-opencode-client": client,
    "x-opencode-project": "global",
    "x-opencode-session": sessionID,
    "x-opencode-request": requestID,
  };
}

const VISIBLE_TOOLS = [
  { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } },
  { type: "function", function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
];

async function probe(label, url, init) {
  try {
    const res = await fetch(url, init);
    const ct = res.headers.get("content-type") || "";
    let body;
    if (ct.includes("event-stream")) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let out = "";
      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && out.length < 1200) {
        const { value, done } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
      }
      try { reader.cancel(); } catch {}
      body = out.slice(0, 900);
    } else {
      body = (await res.text()).slice(0, 500);
    }
    console.log(`\n=== ${label}\n  status ${res.status} ${ct}\n  ${body.replace(/\n/g, "\n  ")}`);
  } catch (err) {
    console.log(`\n=== ${label}\n  ERROR ${err.message}`);
  }
}

const MODELS = ["deepseek-v4.1-flash-free", "cat-jam-free", "big-pickle"];

for (const base of ["https://opencode.ai/inference/v1", "https://opencode.ai/zen/v1"]) {
  await probe(`GET ${base}/models`, base + "/models", { headers: eidHeaders() });
}

await probe(
  "POST inference chat.completions (stream+tools)",
  "https://opencode.ai/inference/v1/chat/completions",
  {
    method: "POST",
    headers: eidHeaders(),
    body: JSON.stringify({ model: MODELS[0], messages: [{ role: "user", content: "قل مرحبا فقط" }], stream: true, tools: VISIBLE_TOOLS }),
  }
);

await probe(
  "POST inference chat.completions (stream, NO tools)",
  "https://opencode.ai/inference/v1/chat/completions",
  {
    method: "POST",
    headers: eidHeaders(),
    body: JSON.stringify({ model: MODELS[0], messages: [{ role: "user", content: "قل مرحبا فقط" }], stream: true }),
  }
);

await probe(
  "POST inference chat.completions (no stream, no tools)",
  "https://opencode.ai/inference/v1/chat/completions",
  {
    method: "POST",
    headers: eidHeaders(),
    body: JSON.stringify({ model: MODELS[0], messages: [{ role: "user", content: "قل مرحبا فقط" }] }),
  }
);

await probe(
  "POST inference (client=web spoof test)",
  "https://opencode.ai/inference/v1/chat/completions",
  {
    method: "POST",
    headers: eidHeaders("web"),
    body: JSON.stringify({ model: MODELS[0], messages: [{ role: "user", content: "hi" }], stream: true, tools: VISIBLE_TOOLS }),
  }
);

await probe("POST zen chat.completions", "https://opencode.ai/zen/v1/chat/completions", {
  method: "POST",
  headers: eidHeaders(),
  body: JSON.stringify({ model: MODELS[0], messages: [{ role: "user", content: "hi" }], stream: true, tools: VISIBLE_TOOLS }),
});
