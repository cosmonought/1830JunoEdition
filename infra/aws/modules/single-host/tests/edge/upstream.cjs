// COST-1 edge smoke: a stand-in for the game server on 127.0.0.1:8917. It echoes what reached it (path with query,
// Origin, Cookie, X-Forwarded-For, Host) as JSON, answers /gs/readyz with a switchable status, and completes a WebSocket
// upgrade on /gs (then sends one text frame "hello"). Control: POST http://127.0.0.1:8918/ready/<code>.
"use strict";
const http = require("http");
const crypto = require("crypto");
let ready = 200;
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/gs/readyz")) {
    res.writeHead(ready, { "content-type": "text/plain" });
    return res.end(String(ready));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url, origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? null, xff: req.headers["x-forwarded-for"] ?? null, host: req.headers.host }));
});
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Echo-Url: ${req.url}\r\n\r\n`);
  socket.write(Buffer.from([0x81, 5, ...Buffer.from("hello")]));
});
server.listen(8917, "127.0.0.1");
http.createServer((req, res) => {
  const m = /^\/ready\/(\d{3})$/.exec(req.url);
  if (m) ready = Number(m[1]);
  res.end(String(ready));
}).listen(8918, "127.0.0.1");
