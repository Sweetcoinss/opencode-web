const WEB = process.env.WEB || "http://127.0.0.1:8791";

async function raw(method, p, body, cookie) {
  const res = await fetch(WEB + p, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, setCookie: res.headers.get("set-cookie"), text: await res.text() };
}

const noAuth = await raw("GET", "/api/health");
console.log("1) /api/health بدون كوكي ->", noAuth.status, noAuth.text.slice(0, 90));

const wrong = await raw("POST", "/api/login", { password: "ghalat" });
console.log("2) login بكلمة غالطة ->", wrong.status, wrong.text.slice(0, 90));

const ok = await raw("POST", "/api/login", { password: "sirri123" });
console.log("3) login صحيح ->", ok.status, ok.text.slice(0, 90), "| cookie:", (ok.setCookie || "").split(";")[0]);

const cookie = (ok.setCookie || "").split(";")[0];
const auth = await raw("GET", "/api/health", undefined, cookie);
console.log("4) /api/health بالكوكي ->", auth.status, auth.text.slice(0, 140));

const direct = await raw("GET", "/api/direct/status", undefined, cookie);
console.log("5) /api/direct/status بالكوكي ->", direct.status, direct.text.slice(0, 120));
process.exit(0);
