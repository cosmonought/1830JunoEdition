// server/playtest-proxy.js
//
// ==================================================================
//  ONE ORIGIN FOR A TUNNELLED PLAYTEST
// ==================================================================
//
// Remote players need two things from this machine: the app, and the game server's WebSocket. A tunnel
// hands out ONE origin, and a page served over https cannot open a `ws://` socket to a machine that is not
// the viewer's own -- so two tunnels would mean two URLs, a second hostname baked into `.env.local`, and a
// mixed-content rule waiting to be tripped. This puts both behind one port:
//
//    /gs  and below   ->  the game server on :8917, WebSocket upgrade and all
//    everything else  ->  the app
//
// THE APP IS SERVED FROM `frontend/build` BY DEFAULT, and the reason is the free tunnel's meter. A CRA dev
// server ships an unminified bundle and hundreds of requests per load; the production build is ~1 MB
// gzipped in a handful of files. On a plan with 1 GB of transfer and 20,000 requests a month that is the
// difference between a playtest and a playtest that stops halfway through. `--dev` proxies to the dev
// server on :3000 instead, hot reload included, for when you are fixing things between rounds.
//
// Node's standard library only -- nothing to install.
//
//   node playtest-proxy.js            # serve frontend/build   (the playtest)
//   node playtest-proxy.js --dev      # proxy to localhost:3000 (fixing things)
//
// PROXY_PORT / APP_PORT / GAME_PORT override the ports below.

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const LISTEN_PORT = Number(process.env.PROXY_PORT || 8918);
const APP_PORT = Number(process.env.APP_PORT || 3000);
const GAME_PORT = Number(process.env.GAME_PORT || 8917);
const GAME_PREFIX = "/gs";
const DEV = process.argv.includes("--dev") || process.env.APP_MODE === "dev";
const BUILD_DIR = path.resolve(__dirname, "..", "frontend", "build");

/** THE PATH DECIDES. The game server's WebSocketServer is attached with no `path`, so it accepts the
 *  upgrade whatever the URL says -- the prefix is for this file to route on, not for it to read. */
const isGame = (url) => {
  const u = String(url || "/");
  return u === GAME_PREFIX || u.startsWith(GAME_PREFIX + "/") || u.startsWith(GAME_PREFIX + "?");
};

/* ------------------------------------------------------------------ */
/*  Serving the build                                                   */
/* ------------------------------------------------------------------ */

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".ico": "image/x-icon", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;

function serveStatic(req, res) {
  const requested = decodeURIComponent(String(req.url || "/").split("?")[0]);

  /* SOURCE MAPS ARE REFUSED, and it is not squeamishness: `main.js.map` is 15 MB, which is 1.5% of a
     month's transfer for one devtools window. Debug against the dev server on this machine instead. */
  if (requested.endsWith(".map")) return end(res, 404, "source maps are not served over the tunnel -- see playtest-proxy.js");

  let file = path.resolve(BUILD_DIR, "." + requested);
  if (!file.startsWith(BUILD_DIR)) return end(res, 403, "no");

  let stat = null;
  try { stat = fs.statSync(file); } catch { stat = null; }

  /* ONE PAGE, SO EVERYTHING ELSE IS THE PAGE. A hashed asset that is missing is a real 404 -- answering it
     with index.html would hand the browser HTML where it expected JavaScript, and the error would name the
     wrong thing entirely. */
  if (!stat || stat.isDirectory()) {
    if (requested.startsWith("/static/")) return end(res, 404, "not in the build: " + requested);
    file = path.join(BUILD_DIR, "index.html");
    try { stat = fs.statSync(file); } catch {
      return end(res, 500, `no build at ${BUILD_DIR}\nrun: npm run build  (in frontend), or start this proxy with --dev`);
    }
  }

  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  /* CRA PUTS THE HASH IN THE FILENAME, so /static/ can be cached forever and a reload costs nothing. The
     page itself must never be cached, or a rebuild would be invisible. */
  const cache = file.includes(path.join(BUILD_DIR, "static"))
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  const headers = { "content-type": type, "cache-control": cache };

  const gzip = COMPRESSIBLE.test(type) && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  if (gzip) {
    headers["content-encoding"] = "gzip";
    headers.vary = "Accept-Encoding";
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);
  } else {
    headers["content-length"] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }
}

const end = (res, code, text) => {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(text + "\n");
};

/* ------------------------------------------------------------------ */
/*  Forwarding                                                          */
/* ------------------------------------------------------------------ */

function forward(req, res, port, what) {
  const upstream = http.request(
    { host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers },
    (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`playtest-proxy: nothing answered on 127.0.0.1:${port} (${what}) -- ${err.message}\n`);
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (isGame(req.url)) return forward(req, res, GAME_PORT, "game server");
  if (DEV) return forward(req, res, APP_PORT, "app (CRA dev server)");
  return serveStatic(req, res);
});

/* THE UPGRADE IS FORWARDED BYTE FOR BYTE. `http.request` cannot carry a WebSocket handshake through, so the
   handshake is re-sent down a raw socket and the two are piped together. Both directions matter: the game's
   frames go up, the server's log entries come back. In --dev this also carries the dev server's own
   hot-reload socket, which is why that mode routes upgrades at all. */
server.on("upgrade", (req, socket, head) => {
  const port = isGame(req.url) ? GAME_PORT : APP_PORT;
  if (!isGame(req.url) && !DEV) return socket.destroy();
  const upstream = net.connect(port, "127.0.0.1", () => {
    const headers = Object.entries(req.headers)
      .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]))
      .join("\r\n");
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

/* 127.0.0.1 ONLY. The tunnel agent runs on this machine and reaches this from localhost; binding wider
   would put the game on the local network as well, which nobody asked for. */
server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(
    `playtest proxy on http://127.0.0.1:${LISTEN_PORT}\n` +
      `  ${GAME_PREFIX}            -> 127.0.0.1:${GAME_PORT}   game server\n` +
      `  everything else -> ${DEV ? `127.0.0.1:${APP_PORT}   app (CRA dev server, hot reload)` : BUILD_DIR + "  (production build, gzipped)"}\n` +
      `  point the tunnel at ${LISTEN_PORT}; .env.local needs REACT_APP_GAME_SERVER_URL=wss://<tunnel-host>${GAME_PREFIX}`,
  );
});
