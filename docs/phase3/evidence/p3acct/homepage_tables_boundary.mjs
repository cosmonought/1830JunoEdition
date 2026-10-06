// P3-N028 (regression, 2026-10-06): THE HOMEPAGE TABLES BOUNDARY, IN REAL CHROMIUM.
//
// Owner report: "Your Tables" is again covering the Host / Join Game controls. The invariant this script holds:
//   the top region (account corner, title, Host / Join) owns its own height in normal flow, and EVERY table-related box
//   ("Your tables", its rows / error, the public list, its loading / empty states) begins at or below the bottom of the
//   Host / Join action region -- once the page has settled AND in every animation frame painted on the way there (the
//   load, a resize, a sign-in, a late reflow); and Host and Join are fully visible and hit-testable (elementFromPoint at
//   their centre and at the middle of each edge returns the button or a descendant).
//
// It drives the REAL app bundle (a CRA dev server or a static build) built with
//   REACT_APP_GAME_SERVER_URL=wss://game.test/gs  (and without REACT_APP_DEV_IDENTITY=1)
// and fakes the game server at the network edge: `POST https://game.test/gs/api/session` (signed out / signed in) and
// the lobby WebSocket (`rooms-watch` -> the public list; `room-op {type: "my-tables"}` -> "Your tables", answered,
// refused or held unanswered).
//
// Usage (from anywhere; node >= 18):
//   node docs/phase3/evidence/p3acct/homepage_tables_boundary.mjs --url http://127.0.0.1:3123 [--tag after] [--out DIR] [--quick]
//   (results JSON and two screenshots go to --out, default $TMPDIR/homepage_tables_boundary)
//   node docs/phase3/evidence/p3acct/homepage_tables_boundary.mjs --build frontend/build [...]
// A dev server for it:
//   cd frontend && BROWSER=none PORT=3123 REACT_APP_GAME_SERVER_URL=wss://game.test/gs REACT_APP_DEV_IDENTITY=0 \
//     DISABLE_ESLINT_PLUGIN=true npx react-app-rewired start
// playwright-core is resolved from the usual places or $PLAYWRIGHT_CORE; Chromium from $CHROMIUM_PATH, else the
// pre-installed /opt/pw-browsers build, else playwright's own. Exit code 0 iff every case passes.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* ---------------------------------------------------------------- arguments */
const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const URL_ARG = opt("url");
const BUILD = opt("build");
const TAG = opt("tag", "run");
const OUT = opt("out", path.join(os.tmpdir(), "homepage_tables_boundary"));
const QUICK = flag("quick");
if (!URL_ARG && !BUILD) {
  console.error("usage: homepage_tables_boundary.mjs (--url ORIGIN | --build DIR) [--tag NAME] [--out DIR] [--quick]");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE, "playwright-core", "playwright", "/opt/node-tools/node_modules/playwright-core", "/opt/npm-tools/node_modules/playwright-core"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright-core not found: set PLAYWRIGHT_CORE to its directory");
}
const { chromium } = loadPlaywright();
const CHROMIUM = process.env.CHROMIUM_PATH ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => fs.existsSync(p));

/* ---------------------------------------------------------------- the app's origin */
let server = null;
let origin = URL_ARG;
if (BUILD) {
  const root = path.resolve(BUILD);
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webp": "image/webp", ".mp4": "video/mp4", ".woff2": "font/woff2", ".mp3": "audio/mpeg" };
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}

/* ---------------------------------------------------------------- the fake game server */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const gameId = (n) => {
  let body = "";
  let x = n * 7919 + 13;
  for (let i = 0; i < 25; i += 1) {
    body += ALPHABET[x % 32];
    x = Math.floor(x / 3) + i * 31 + n;
  }
  return `g_${body}0`;
};
const variants = { length: "standard", expandedMap: false, levelPlayingField: false, delayedAuction: false, gentleRust: false, unpredictableRevenue: false, dynamicStockMarket: false, plusTiles: false };
const publicRooms = (count) =>
  Array.from({ length: count }, (_, i) => ({
    gameId: gameId(1000 + i),
    code: `JUNO-A${String.fromCharCode(65 + (i % 26))}A${i % 10}-BBB${Math.floor(i / 10)}`,
    status: i % 3 === 0 ? "playing" : "waiting",
    hostNickname: ["Ann", "Bea", "Cy", "Di", "Ed", "Flo"][i % 6],
    nicknames: ["Ann", "Bea", "Cy"].slice(0, (i % 3) + 1),
    readyCount: 1,
    seated: (i % 3) + 1,
    seatCap: 4,
    playerCount: null,
    variants,
    createdAtMs: Date.now() - i * 60_000,
  }));
const STATES = ["waiting", "playing", "resume", "paused", "finished"];
const myTables = (count, long = false) =>
  Array.from({ length: count }, (_, i) => ({
    gameId: gameId(i + 1),
    state: STATES[i % STATES.length],
    visibility: i % 2 === 0 ? "private" : "public",
    hostNickname: long ? `Baron_${"Vanderbilt".repeat(5)}_${i}` : ["Brad", "Ann", "Cy"][i % 3],
    nicknames: long
      ? ["Brad", `Commodore_${"Gould".repeat(9)}_${i}`, "Jay Cooke and the Northern Pacific Syndicate of Philadelphia", "Erie"]
      : ["Brad", "Ann", "Cy"].slice(0, (i % 3) + 1),
    you: i % 3 === 0 ? "host" : "player",
    createdAtMs: Date.now() - (i + 1) * 3_600_000,
    lastActivityMs: Date.now() - (i + 1) * 60_000,
    ...(long || i % 4 === 1 ? { money: { anteGross: "1250000000", symbol: "JUNOX", exponent: 6, networkClass: "testnet", status: i % 2 === 0 ? "deposit" : "linked", actionNeeded: i % 2 === 0 } } : {}),
  }));

/* What the fake server says, per scenario. `tables: null` holds the my-tables answer (loading); `rooms: null` holds the
   public list (loading). */
const SCENARIOS = {
  "signed-out": { profile: null, tables: [], rooms: publicRooms(6) },
  "signed-in-0": { profile: true, tables: [], rooms: publicRooms(6) },
  "signed-in-1": { profile: true, tables: myTables(1), rooms: publicRooms(6) },
  "signed-in-many": { profile: true, tables: myTables(14), rooms: publicRooms(24) },
  loading: { profile: true, tables: null, rooms: null },
  "tables-error": { profile: true, tables: "error", rooms: publicRooms(3) },
  "long-metadata": { profile: true, tables: myTables(4, true), rooms: publicRooms(6) },
  /* Rendered signed out, then the session becomes a signed-in one (the server closes the socket 4401, the client
     re-bootstraps and the answer now names a profile) -- "Your tables" arrives after the first layout. */
  "sign-in-after-render": { profile: null, tables: myTables(3), rooms: publicRooms(6), signInLater: true },
  /* Rendered with a larger default font (Page.setFontSizes) and then a late text reflow (a style injected after the
     first layout that makes the doors and the rows' type larger -- a web-font swap / text-size change). */
  "font-reflow": { profile: true, tables: myTables(2), rooms: publicRooms(6), fonts: true, lateReflow: true },
};

/* CSS viewports, grouped by device scale factor (a context's DPR is fixed). The zoom rows are a physical window divided
   by the browser / display zoom: 1920x1080 at 300% is a 640x360 CSS viewport at DPR 3. */
const VIEWPORTS = {
  1: [
    { name: "narrow-320", width: 320, height: 568 },
    { name: "narrow-360", width: 360, height: 740 },
    { name: "narrow-375", width: 375, height: 667 },
    { name: "tablet-768", width: 768, height: 1024 },
    { name: "laptop-1024", width: 1024, height: 768 },
    { name: "laptop-1366", width: 1366, height: 768 },
    { name: "desktop-1440", width: 1440, height: 900 },
    { name: "wide-1920", width: 1920, height: 1080 },
    { name: "wide-short-1920x600", width: 1920, height: 600 },
    { name: "wide-2560", width: 2560, height: 1440 },
  ],
  2: [
    { name: "zoom200-1920x1080", width: 960, height: 540 },
    { name: "zoom200-1366x768", width: 683, height: 384 },
  ],
  2.5: [{ name: "zoom250-1920x1080", width: 768, height: 432 }],
  3: [
    { name: "phone-390-dpr3", width: 390, height: 844 },
    { name: "zoom300-1920x1080", width: 640, height: 360 },
    { name: "zoom300-1920x1000-chrome", width: 640, height: 300 },
    { name: "zoom300-2560x1440", width: 853, height: 480 },
    { name: "zoom300-1366x768", width: 455, height: 256 },
    { name: "display300-3840x2160", width: 1280, height: 650 },
  ],
};
const UI_SCALES = [0.63, 0.75, 0.9, 1, 1.1, 1.25];

const quickPick = (list, keep) => (QUICK ? list.filter((entry) => keep.includes(entry.name ?? entry)) : list);

/* ---------------------------------------------------------------- measuring a page */
function measureInPage() {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  };
  const actions = document.querySelector('[data-testid="lobby-actions"]');
  if (!actions) return { missing: "lobby-actions" };
  const buttons = Array.from(actions.querySelectorAll("button"));
  const host = buttons.find((b) => b.textContent.trim() === "Host game") ?? null;
  const join = buttons.find((b) => b.textContent.trim() === "Join game") ?? null;
  /* The action region's foot: the region's own box and everything drawn inside it (a wrapped row, the bar's error). */
  let actionsBottom = box(actions).bottom;
  for (const el of actions.querySelectorAll("*")) {
    const r = box(el);
    if (r.width > 0 && r.height > 0) actionsBottom = Math.max(actionsBottom, r.bottom);
  }
  /* Every table-related box. */
  const TABLE_SELECTORS = [
    '[data-testid="lobby-tables"]',
    '[data-testid="my-tables"]',
    '[data-testid="my-tables"] h2',
    '[data-testid="my-tables"] p',
    '[data-testid="my-table-row"]',
    '[data-testid="my-table-money"]',
    '[data-testid="your-deposits"]',
    '[data-testid="lobby-public-games"]',
    '[data-testid="lobby-public-games"] h2',
    '[data-testid="lobby-rooms-status"]',
    '[data-testid="lobby-public-games"] li',
  ];
  const tableBoxes = [];
  for (const selector of TABLE_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      const r = box(el);
      if (r.width > 0 && r.height > 0) tableBoxes.push({ selector, ...r });
    }
  }
  const mine = document.querySelector('[data-testid="my-tables"]');
  const firstTableTop = tableBoxes.length ? Math.min(...tableBoxes.map((b) => b.top)) : null;
  const firstTable = tableBoxes.find((b) => b.top === firstTableTop) ?? null;
  return {
    actionsBottom,
    actions: box(actions),
    host: host ? box(host) : null,
    join: join ? box(join) : null,
    yourTablesTop: mine ? box(mine).top : null,
    yourTablesRows: document.querySelectorAll('[data-testid="my-table-row"]').length,
    firstTableTop,
    firstTableSelector: firstTable?.selector ?? null,
    tableCount: tableBoxes.length,
    scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

/** Host / Join: scrolled to, fully inside the window, and the top-most thing at the centre and at each edge's middle. */
function hitTestInPage(label) {
  const actions = document.querySelector('[data-testid="lobby-actions"]');
  const el = actions && Array.from(actions.querySelectorAll("button")).find((b) => b.textContent.trim() === label);
  if (!el) return { ok: false, why: `${label}: not found` };
  /* Scroll the DOCUMENT only (`scrollIntoView` would also scroll an `overflow: hidden` ancestor and so move the very
     layout being measured), so the button's centre is in the middle of the window. */
  const before = el.getBoundingClientRect();
  window.scrollTo(0, Math.max(0, window.scrollY + before.top + before.height / 2 - window.innerHeight / 2));
  const r = el.getBoundingClientRect();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const problems = [];
  if (r.width < 1 || r.height < 1) problems.push("zero size");
  if (r.left < -0.5 || r.right > W + 0.5 || r.top < -0.5 || r.bottom > H + 0.5) problems.push(`outside the window ${JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)])} in ${W}x${H}`);
  /* The centre and the middle of each edge, 3px in (the corners are rounded, and a rounded corner is not the
     button's to hit). */
  const dx = Math.min(3, r.width / 4);
  const dy = Math.min(3, r.height / 4);
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const points = [
    [cx, cy],
    [r.left + dx, cy],
    [r.right - dx, cy],
    [cx, r.top + dy],
    [cx, r.bottom - dy],
  ];
  for (const [x, y] of points) {
    const hit = document.elementFromPoint(x, y);
    if (!(hit && (hit === el || el.contains(hit)))) {
      const what = hit ? `${hit.tagName.toLowerCase()}${hit.getAttribute("data-testid") ? `[${hit.getAttribute("data-testid")}]` : ""}${hit.textContent ? ` "${hit.textContent.trim().slice(0, 24)}"` : ""}` : "nothing";
      problems.push(`covered at (${Math.round(x)},${Math.round(y)}) by ${what}`);
      break;
    }
  }
  window.scrollTo(0, 0);
  return { ok: problems.length === 0, why: problems.length ? `${label}: ${problems.join("; ")}` : null };
}


/* ---------------------------------------------------------------- every painted frame
   Installed before any page script on every navigation: on each animation frame, the doors' foot and the first
   table-related box, read through the ORIGINAL getBoundingClientRect, and a record of every frame in which the second
   is above the first. A boundary that holds only after an observer has fired and React has re-rendered fails here:
   the frames before that are painted too. Read and cleared at each check, labelled with the phase it happened in. */
function installFrameMonitor() {
  const real = Element.prototype.getBoundingClientRect;
  const TABLES = '[data-testid="lobby-tables"], [data-testid="my-tables"], [data-testid="my-table-row"], [data-testid="your-deposits"], [data-testid="lobby-public-games"], [data-testid="lobby-rooms-status"]';
  const state = { phase: "load", frames: 0, violating: 0, violations: [] };
  window.__boundary = state;
  const tick = () => {
    const actions = document.querySelector('[data-testid="lobby-actions"]');
    if (actions) {
      let doors = real.call(actions).bottom;
      for (const el of actions.querySelectorAll("*")) {
        const r = real.call(el);
        if (r.width > 0 && r.height > 0) doors = Math.max(doors, r.bottom);
      }
      let top = Infinity;
      let which = null;
      for (const el of document.querySelectorAll(TABLES)) {
        const r = real.call(el);
        if (r.width > 0 && r.height > 0 && r.top < top) {
          top = r.top;
          which = el.getAttribute("data-testid");
        }
      }
      if (top !== Infinity) {
        state.frames += 1;
        if (top < doors - 0.5) {
          state.violating += 1;
          if (state.violations.length < 20) state.violations.push({ phase: state.phase, frame: state.frames, doorsBottom: Math.round(doors), tableTop: Math.round(top), which, window: `${innerWidth}x${innerHeight}` });
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
const takeFrames = (page) => page.evaluate(() => {
  const s = window.__boundary;
  if (!s) return { frames: 0, violating: 0, violations: [] };
  const out = { frames: s.frames, violating: s.violating, violations: s.violations.splice(0) };
  s.frames = 0;
  s.violating = 0;
  return out;
});
const phase = (page, label) => page.evaluate((value) => {
  if (window.__boundary) window.__boundary.phase = value;
}, label);

const TOLERANCE = 0.5;
async function check(page, scenario, extra) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const m = await page.evaluate(measureInPage);
  const problems = [];
  if (m.missing) problems.push(`missing ${m.missing}`);
  else {
    if (!m.host) problems.push("no Host game button");
    if (!m.join) problems.push("no Join game button");
    if (m.yourTablesTop !== null && m.yourTablesTop < m.actionsBottom - TOLERANCE) problems.push(`"Your tables" top ${m.yourTablesTop.toFixed(1)} above the doors' foot ${m.actionsBottom.toFixed(1)}`);
    if (m.firstTableTop !== null && m.firstTableTop < m.actionsBottom - TOLERANCE) problems.push(`table content (${m.firstTableSelector}) top ${m.firstTableTop.toFixed(1)} above the doors' foot ${m.actionsBottom.toFixed(1)}`);
    if (m.tableCount === 0) problems.push("no table content rendered");
    for (const label of ["Host game", "Join game"]) {
      const hit = await page.evaluate(hitTestInPage, label);
      if (!hit.ok) problems.push(hit.why);
    }
  }
  const expectYourTables = scenario.expectYourTables;
  if (expectYourTables && m.yourTablesTop === null) problems.push('"Your tables" expected but not rendered');
  /* Every frame painted since the last check (the load, the resize to this size, a sign-in, a reflow). */
  const frames = await takeFrames(page);
  if (frames.violating > 0) {
    const first = frames.violations[0];
    problems.push(`${frames.violating} of ${frames.frames} painted frame(s) had table content above the doors' foot (first: ${first.phase}, frame ${first.frame}, ${first.which} top ${first.tableTop} < doors ${first.doorsBottom} at ${first.window})`);
  }
  return {
    ...extra,
    framesSampled: frames.frames,
    framesViolating: frames.violating,
    ok: problems.length === 0,
    actionsBottom: m.actionsBottom !== undefined ? Math.round(m.actionsBottom) : null,
    yourTablesTop: m.yourTablesTop !== null && m.yourTablesTop !== undefined ? Math.round(m.yourTablesTop) : null,
    firstTableTop: m.firstTableTop !== null && m.firstTableTop !== undefined ? Math.round(m.firstTableTop) : null,
    rows: m.yourTablesRows ?? 0,
    problems,
  };
}

const settle = (page, ms = 300) => page.evaluate((wait) => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, wait)))), ms);

/* ---------------------------------------------------------------- the sweep */
const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ["--no-sandbox"] });
const results = [];
let harness = SCENARIOS["signed-out"];
let signedIn = false;
const sockets = new Set();

async function newContext(dsf) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dsf });
  await context.addInitScript(installFrameMonitor);
  const cors = (req) => ({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": req.headers()["access-control-request-headers"] ?? "content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" });
  await context.route(/game\.test\/gs\/api\//, (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(req) });
    if (req.url().endsWith("/session")) {
      return route.fulfill({ status: 201, contentType: "application/json", headers: cors(req), body: JSON.stringify({ ok: true, expiresAt: Date.now() + 3_600_000, profile: signedIn ? { name: "Brad", otherSessions: 0 } : null }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors(req), body: JSON.stringify({ ok: false, code: "not-found", reason: "not here" }) });
  });
  await context.routeWebSocket(/game\.test/, (ws) => {
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
    ws.onMessage((text) => {
      let frame;
      try {
        frame = JSON.parse(String(text));
      } catch {
        return;
      }
      if (frame.kind === "rooms-watch") {
        if (harness.rooms !== null) ws.send(JSON.stringify({ kind: "rooms", rooms: harness.rooms }));
        return;
      }
      if (frame.kind === "room-op") {
        const requestId = frame.requestId;
        if (frame.op?.type === "my-tables") {
          if (!signedIn) return ws.send(JSON.stringify({ kind: "room-ack", requestId, ok: true, data: { tables: [] } }));
          if (harness.tables === null) return; /* held: loading */
          if (harness.tables === "error") return ws.send(JSON.stringify({ kind: "room-ack", requestId, ok: false, code: "internal", reason: "the store did not answer" }));
          return ws.send(JSON.stringify({ kind: "room-ack", requestId, ok: true, data: { tables: harness.tables } }));
        }
        return ws.send(JSON.stringify({ kind: "room-ack", requestId, ok: false, code: "not-found", reason: "not here" }));
      }
    });
  });
  return context;
}

async function load(page, scenarioName, uiScale) {
  harness = SCENARIOS[scenarioName];
  signedIn = harness.profile !== null;
  await page.evaluate((value) => {
    try {
      window.localStorage.setItem("1830juno.ui_scale.v1", String(value));
    } catch {
      /* the page reads the default */
    }
  }, uiScale).catch(() => undefined);
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="lobby-actions"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="lobby-public-games"]', { timeout: 10_000 }).catch(() => undefined);
  if (harness.tables !== null && harness.tables !== "error" && harness.tables.length > 0 && signedIn) await page.waitForSelector('[data-testid="my-table-row"]', { timeout: 10_000 }).catch(() => undefined);
  if (harness.tables === "error" && signedIn) await page.waitForSelector('[data-testid="my-tables"]', { timeout: 10_000 }).catch(() => undefined);
  await settle(page, 400);
}

async function signInNow(page) {
  signedIn = true;
  for (const ws of [...sockets]) ws.close({ code: 4401, reason: "session ended" });
  await page.waitForSelector('[data-testid="my-table-row"]', { timeout: 15_000 }).catch(() => undefined);
  await settle(page, 400);
}

async function lateReflow(page) {
  await page.addStyleTag({
    content: `[data-testid="lobby-actions"] button { font-size: 30px !important; padding: 22px 44px !important; line-height: 1.4 !important; }
[data-testid="my-tables"] *, [data-testid="lobby-public-games"] * { font-size: 21px !important; line-height: 1.5 !important; }`,
  });
  await settle(page, 400);
}

const scenarioNames = QUICK ? ["signed-out", "signed-in-1", "signed-in-many", "sign-in-after-render"] : Object.keys(SCENARIOS);
const scales = QUICK ? [0.63, 1, 1.25] : UI_SCALES;
for (const [dsfText, viewports] of Object.entries(VIEWPORTS)) {
  const dsf = Number(dsfText);
  const vps = QUICK ? viewports.filter((v) => ["narrow-320", "laptop-1366", "wide-1920", "zoom300-1920x1080", "zoom200-1920x1080", "zoom250-1920x1080"].includes(v.name)) : viewports;
  if (vps.length === 0) continue;
  const context = await newContext(dsf);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.warn(`[page error] ${error.message}`));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  for (const [scenarioIndex, scenarioName] of scenarioNames.entries()) {
    const scenario = { ...SCENARIOS[scenarioName], expectYourTables: false };
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.setFontSizes", { fontSizes: scenario.fonts ? { standard: 24, fixed: 20 } : { standard: 16, fixed: 13 } }).catch(() => undefined);
    for (const [scaleIndex, uiScale] of scales.entries()) {
      /* Loaded at one of the group's sizes (rotating, so every size is a load size somewhere), then resized to each
         of the others: every row after the first is "resize after render", and the monitor sees the load too. */
      const loadVp = vps[(scenarioIndex + scaleIndex) % vps.length];
      await page.setViewportSize({ width: loadVp.width, height: loadVp.height });
      await load(page, scenarioName, uiScale);
      scenario.expectYourTables = signedIn && (harness.tables === "error" || (Array.isArray(harness.tables) && harness.tables.length > 0));
      if (scenario.signInLater) {
        /* The signed-out layout first; then the session changes under the rendered page. */
        results.push(await check(page, { expectYourTables: false }, { scenario: `${scenarioName}:before`, dsf, uiScale, viewport: loadVp.name }));
        await phase(page, "sign-in");
        await signInNow(page);
        scenario.expectYourTables = true;
      }
      if (scenario.lateReflow) {
        await phase(page, "late-reflow");
        await lateReflow(page);
      }
      for (const vp of [loadVp, ...vps.filter((v) => v !== loadVp)]) {
        await phase(page, `resize->${vp.name}`);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await settle(page);
        results.push(await check(page, scenario, { scenario: scenarioName, dsf, uiScale, viewport: vp.name, loadedAt: loadVp.name }));
      }
      /* Resize cycle: very wide -> the group's first size -> short and wide, checked at the end (no hysteresis). */
      if (!QUICK && (scenarioName === "signed-in-many" || scenarioName === "long-metadata")) {
        await phase(page, "resize-cycle");
        await page.setViewportSize({ width: 2560, height: 1440 });
        await settle(page, 150);
        await page.setViewportSize({ width: vps[0].width, height: vps[0].height });
        await settle(page, 150);
        await page.setViewportSize({ width: 1920, height: 600 });
        await settle(page);
        results.push(await check(page, scenario, { scenario: `${scenarioName}:resize-cycle`, dsf, uiScale, viewport: "cycle->1920x600" }));
      }
      if (dsf === 3 && uiScale === 1.25 && (scenarioName === "signed-in-1" || scenarioName === "signed-in-many")) {
        await page.setViewportSize({ width: 640, height: 360 });
        await settle(page);
        await page.screenshot({ path: path.join(OUT, `${TAG}-${scenarioName}-zoom300-640x360-ui125.png`) });
      }
      if (dsf === 1 && uiScale === 1 && scenarioName === "signed-in-1") {
        await page.setViewportSize({ width: 1366, height: 768 });
        await settle(page);
        await page.screenshot({ path: path.join(OUT, `${TAG}-${scenarioName}-1366x768-ui100.png`) });
      }
    }
    await cdp.detach().catch(() => undefined);
  }
  /* Load at size: every size of the group at every text size, opened AT that size (signed in, one table), so the
     first painted frames of a load are judged at each geometry, not only after a resize. */
  for (const vp of vps) {
    for (const uiScale of QUICK ? [1, 1.25] : UI_SCALES) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await load(page, "signed-in-1", uiScale);
      results.push(await check(page, { expectYourTables: true }, { scenario: "load-at-size", dsf, uiScale, viewport: vp.name, loadedAt: vp.name }));
    }
  }
  await context.close();
}
await browser.close();
server?.close();

/* ---------------------------------------------------------------- the report */
const byScenario = {};
for (const r of results) {
  const key = r.scenario;
  byScenario[key] ??= { cases: 0, failing: 0 };
  byScenario[key].cases += 1;
  if (!r.ok) byScenario[key].failing += 1;
}
const failing = results.filter((r) => !r.ok);
const summary = { tag: TAG, origin, quick: QUICK, cases: results.length, failing: failing.length, byScenario, firstFailures: failing.slice(0, 40) };
fs.writeFileSync(path.join(OUT, `${TAG}-results.json`), JSON.stringify({ summary, results }, null, 1));
console.log(`cases ${results.length} failing ${failing.length}`);
for (const [key, value] of Object.entries(byScenario)) console.log(`  ${key.padEnd(34)} ${String(value.failing).padStart(4)} / ${value.cases}`);
for (const r of failing.slice(0, 12)) console.log(JSON.stringify({ scenario: r.scenario, dsf: r.dsf, uiScale: r.uiScale, viewport: r.viewport, actionsBottom: r.actionsBottom, yourTablesTop: r.yourTablesTop, firstTableTop: r.firstTableTop, problems: r.problems.slice(0, 2) }));
process.exit(failing.length === 0 ? 0 : 1);
