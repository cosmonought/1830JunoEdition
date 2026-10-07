// P3-ACCT homepage overlap check: the production bundle in real Chromium, signed out, with a public list served by a
// mocked game server (HTTP bootstrap + WebSocket), at constrained widths, heights and text sizes. For every case:
//   the doors' row (Host / Join) never intersects the list below it, the account corner (Rules / Log in /
//   Create account) or the title; and nothing scrolls sideways.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BUILD = process.argv[2];
const OUT = process.argv[3];
const SIGNED_IN = process.argv[4] === "signed-in";
const TAG = process.argv[5] ?? "run";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webp": "image/webp", ".mp4": "video/mp4", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let file = path.join(BUILD, decodeURIComponent(url.pathname));
  if (!file.startsWith(BUILD) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(BUILD, "index.html");
  res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const variants = { length: "standard", expandedMap: false, levelPlayingField: false, delayedAuction: false, gentleRust: false, unpredictableRevenue: false, dynamicStockMarket: false, plusTiles: false };
const rooms = Array.from({ length: 6 }, (_, i) => ({
  gameId: `g_room${i}`,
  code: `JUNO-AAA${i}-BBB${i}`,
  status: i % 3 === 0 ? "playing" : "waiting",
  hostNickname: ["Ann", "Bea", "Cy", "Di", "Ed", "Flo"][i],
  nicknames: ["Ann", "Bea", "Cy"].slice(0, (i % 3) + 1),
  readyCount: 1,
  seated: (i % 3) + 1,
  seatCap: 4,
  playerCount: null,
  variants,
  createdAtMs: Date.now() - i * 60_000,
  ...(i === 1 ? { stake: { symbol: "JUNOX", anteGross: "1000000", exponent: 6, networkClass: "testnet", funded: 1, seats: 4 } } : {}),
}));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const widths = [1920, 1440, 1366, 1280, 1024, 900, 820, 768, 600, 430, 375, 320];
const heights = [1080, 900, 768, 700, 600, 500];
const scales = [0.63, 1, 1.25];
const results = [];
let failures = 0;
for (const scale of scales) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((value) => {
    try {
      window.localStorage.setItem("1830juno.ui_scale.v1", String(value));
    } catch {}
  }, scale);
  const page = await context.newPage();
  await page.route("**/gs/api/session", (route) =>
    route.fulfill({ status: 201, contentType: "application/json", headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" }, body: JSON.stringify({ ok: true, expiresAt: Date.now() + 3600_000, profile: SIGNED_IN ? { name: "Brad", otherSessions: 0 } : null }) }),
  );
  await page.routeWebSocket(/game\.test/, (ws) => {
    ws.onMessage((text) => {
      let frame;
      try {
        frame = JSON.parse(String(text));
      } catch {
        return;
      }
      if (frame.kind === "rooms-watch") ws.send(JSON.stringify({ kind: "rooms", rooms }));
    });
  });
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForSelector(".lobby-table-anchor", { timeout: 20_000 });
  for (const width of widths) {
    for (const height of heights) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const box = await page.evaluate(() => {
        const rect = (el) => (el ? (({ top, bottom, left, right }) => ({ top, bottom, left, right }))(el.getBoundingClientRect()) : null);
        const actions = document.querySelector(".lobby-table-anchor");
        const buttons = Array.from(actions?.querySelectorAll("button") ?? []).map((b) => rect(b));
        const corner = Array.from(document.querySelectorAll('[data-testid="lobby-rules"], [data-testid="account-login"], [data-testid="account-create"], [data-testid="profile-chip"]')).map((b) => rect(b));
        const title = rect(document.querySelector(".lobby-wordmark"));
        const list = Array.from(document.querySelectorAll("li, [data-testid^='lobby-room'], section, p[role='alert']")).filter((el) => !actions?.contains(el)).map((el) => rect(el)).filter((r) => r.bottom > r.top);
        const scrollX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const rows = document.querySelectorAll("li").length;
        return { buttons, corner, title, list, scrollX, rows };
      });
      const hit = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const problems = [];
      for (const button of box.buttons) {
        for (const item of box.list) if (hit(button, item)) problems.push(`door overlaps list item ${JSON.stringify(item)}`);
        for (const c of box.corner) if (hit(button, c)) problems.push(`door overlaps account corner ${JSON.stringify(c)}`);
        if (hit(button, box.title)) problems.push("door overlaps title");
      }
      if (box.scrollX > 1) problems.push(`horizontal scroll ${box.scrollX}px`);
      if (box.buttons.length === 0) problems.push("no doors found");
      const firstList = Math.min(...box.list.map((r) => r.top).filter((t) => t > 0), Infinity);
      const doorsBottom = Math.max(...box.buttons.map((b) => b.bottom));
      results.push({ scale, width, height, rows: box.rows, doorsBottom: Math.round(doorsBottom), firstListTop: Math.round(firstList), ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 3) });
      if (problems.length > 0) failures += 1;
      if (scale === 1 && width === 1366 && height === 700) await page.screenshot({ path: path.join(OUT, `${TAG}-lobby-${width}x${height}-s${scale}.png`) });
      if (scale === 1.25 && width === 430 && height === 900) await page.screenshot({ path: path.join(OUT, `${TAG}-lobby-${width}x${height}-s${scale}.png`) });
    }
  }
  await context.close();
}
await browser.close();
server.close();
fs.writeFileSync(path.join(OUT, `${TAG}-layout-results.json`), JSON.stringify(results, null, 1));
console.log(`cases ${results.length} failures ${failures}`);
for (const r of results.filter((r) => !r.ok).slice(0, 20)) console.log(JSON.stringify(r));
process.exit(failures === 0 ? 0 : 1);
