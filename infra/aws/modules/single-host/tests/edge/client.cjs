// COST-1 edge smoke: the client side, as CloudFront would reach Caddy (TLS to the origin name, on 127.0.0.1).
"use strict";
const tls = require("tls");
const http = require("http");
const HOST = "gs-origin.test";
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };
function https(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port: 443, servername: HOST, rejectUnauthorized: false }, () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: ${HOST}`, "Connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""];
      socket.write(lines.join("\r\n"));
    });
    let data = "";
    socket.on("data", (d) => (data += d.toString("latin1")));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(8000, () => { socket.destroy(); reject(new Error("timeout")); });
  });
}
const status = (raw) => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]);
const bodyOf = (raw) => raw.slice(raw.indexOf("\r\n\r\n") + 4);
const decodeChunked = (b) => { let out = "", rest = b; for (;;) { const i = rest.indexOf("\r\n"); const n = parseInt(rest.slice(0, i), 16); if (!n) return out; out += rest.slice(i + 2, i + 2 + n); rest = rest.slice(i + 4 + n); } };
const json = (raw) => { const b = bodyOf(raw); try { return JSON.parse(b); } catch { return JSON.parse(decodeChunked(b)); } };
const control = (code) => new Promise((r) => http.request({ host: "127.0.0.1", port: 8918, path: `/ready/${code}`, method: "POST" }, (res) => { res.resume(); res.on("end", r); }).end());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const q = "/gs/api/session?cp=7&cr=11,3&cb=l6cert-x&x=%2F%20a&x=b";
  const r1 = await https(q, { Origin: "https://play.example.org", Cookie: "__Host-gs_session=abc123", "X-Forwarded-For": "198.51.100.7" });
  const e1 = json(r1);
  check("proxied 200", status(r1) === 200, status(r1));
  check("path and query unchanged (cp/cr/cb, encoded, repeated)", e1.url === q, e1.url);
  check("Origin preserved", e1.origin === "https://play.example.org", e1.origin);
  check("Cookie preserved", e1.cookie === "__Host-gs_session=abc123", e1.cookie);
  check("X-Forwarded-For APPENDED: client, edge (2 hops)", e1.xff === "198.51.100.7, 127.0.0.1", e1.xff);
  const r2 = await https("/gs");
  check("/gs itself proxied", status(r2) === 200 && json(r2).url === "/gs", status(r2));
  const r3 = await https("/not-gs/x");
  check("a non-/gs path is 404 (never proxied)", status(r3) === 404, status(r3));
  const r4 = await https("/gsx");
  check("/gsx is not /gs/* (404)", status(r4) === 404, status(r4));
  // WebSocket upgrade through Caddy
  const ws = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port: 443, servername: HOST, rejectUnauthorized: false }, () => {
      socket.write([`GET /gs?cp=1 HTTP/1.1`, `Host: ${HOST}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Origin: https://play.example.org", "", ""].join("\r\n"));
    });
    let data = Buffer.alloc(0);
    socket.on("data", (d) => { data = Buffer.concat([data, d]); const t = data.toString("latin1"); if (t.includes("hello")) { socket.destroy(); resolve(t); } });
    socket.on("error", reject);
    socket.setTimeout(8000, () => { socket.destroy(); reject(new Error("ws timeout")); });
  });
  check("WebSocket upgrade: 101 through Caddy", /^HTTP\/1\.1 101/.test(ws), ws.split("\r\n")[0]);
  check("WebSocket query preserved", /X-Echo-Url: \/gs\?cp=1/i.test(ws), (/X-Echo-Url: [^\r]*/i.exec(ws) || [""])[0]);
  check("WebSocket server frame delivered", ws.includes("hello"), "");
  // readiness drives traffic (the ALB's target health, kept)
  await control(503);
  await sleep(12000);
  const r5 = await https("/gs/api/x");
  check("not ready -> Caddy answers 503 (no traffic to an unready server)", status(r5) === 503, status(r5));
  await control(200);
  await sleep(12000);
  const r6 = await https("/gs/api/x");
  check("ready again -> traffic resumes", status(r6) === 200, status(r6));
  // port 80 never proxies
  const r7 = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: 80, path: "/gs/api/x", headers: { Host: HOST } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", () => resolve(0)));
  check("port 80 never proxies (ACME and 404 only)", r7 === 404, r7);
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` -- ${JSON.stringify(r.detail)}`}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
