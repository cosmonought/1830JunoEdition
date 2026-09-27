// server/src/rooms/live3cProcess.test.ts
//
// LIVE-3C: THE PROGRAM AN OPERATOR RUNS, KILLED AND STARTED AGAIN. `dist/server/src/start.js` is spawned in production
// mode (session cookies, mandatory profiles) over one data directory, filled the way browsers fill it -- two profiles,
// a host on two devices, a linked device, a signed-out device, a rotated recovery key, an outstanding and a consumed
// link code, a waiting room and dealt games -- then KILLED (SIGKILL: no shutdown hook, no flush, no lock release).
// While it is down the directory is given a record that disagrees with its log and a game pinned to a rules engine
// this build does not carry. Then it is started again, twice, and every one of those things is asked about through
// the real endpoints and sockets:
//
//   * discovery finds every game at startup (its one window line), holds the disagreeing one DURABLY (a hold file,
//     one audit line, across both restarts), derives the incompatible one (no hold file) and serves the rest;
//   * ops/status.json and ops/audit.jsonl say what an operator needs -- and never a principal, profile or session id;
//   * every identity fact survives both kills (the journal store): both devices' cookies, the signed-out device still
//     ended, the old recovery key refused and the new one working, the consumed code refused and the outstanding one
//     redeemable;
//   * the dealt game carries on from the same log on both of the host's devices; the waiting room is still waiting;
//   * the held game answers the one held sentence and a "maintenance" view; the incompatible one its own;
//   * no recovery key, link code or cookie secret appears in the server's window or in ANY file in the directory;
//   * `gamesDoctor status` reads the live status, `inspect` refuses while the server runs and reports after a clean
//     SIGTERM (which releases the lock).
//
// Run in server/ after `npm run build`: node --test dist/server/src/rooms/live3cProcess.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import { WebSocket } from "ws";

import { createFileLogStore } from "../fileLogStore";
import { SESSION_COOKIE_NAME } from "../identity/cookies";
import { HEALTH_PATH, LINK_CODE_PATH, LINK_PATH, PROFILE_PATH, RECOVER_PATH, RECOVERY_KEY_PATH, REVOKE_PATH, SESSION_PATH } from "../identity/httpApi";
import { serializeBatch } from "../persistence/logFormat";
import { AUDIT_FILE, OPS_DIRECTORY, STATUS_FILE } from "../persistence/opsRecorder";
import { LOCK_DIRECTORY, LOCK_STALE_AFTER_MS } from "../persistence/processLock";
import type { GameRecord } from "./gameRecord";
import { HELD_PLAYER_SENTENCE } from "./lifecycle";

const BUILD = "live3c-process";
const ORIGIN = "https://live3c.invalid";
const START_JS = path.join(__dirname, "..", "start.js");
const DOCTOR_JS = path.join(__dirname, "..", "tools", "gamesDoctor.js");
const SERVER_DIR = path.resolve(__dirname, "..", "..", "..", "..");
const WAIT_MS = 15_000;
const START_TIMEOUT_MS = 40_000;
const OWNED_SETTINGS = ["GS_MODE", "GS_ALLOWED_ORIGINS", "GS_TRUSTED_PROXY_HOPS", "DATA_DIR", "PORT", "BUILD_ID", "LEGACY_LOGS", "INSECURE_LOCAL_IDENTITY", "EXPLAIN_DIVERGENCE"];
const BUY = { WaterfallBuyLowest: { game_id: 0 } };
/** Identity ids (principal, profile, session, recovery selector) -- never in an ops file. */
const IDENTITY_ID = /\b(?:pr|pf|se|rk)_[0-9a-hjkmnp-tv-z]{20,}\b|pr_dev_/i;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until<T>(probe: () => T | null | undefined | false, label: string | (() => string), timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof label === "string" ? label : label()}`);
    await sleep(10);
  }
}

/* ==================================================================
    THE PROCESS
   ================================================================== */

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ServerProcess {
  child: ChildProcess;
  output: string[];
  exited: Exit | null;
  exit: Promise<Exit>;
}

const running = new Set<ServerProcess>();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: HEALTH_PATH, timeout: 1_000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function startServer(port: number, dataDir: string): Promise<ServerProcess> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of OWNED_SETTINGS) delete env[name];
  Object.assign(env, { PORT: String(port), DATA_DIR: dataDir, BUILD_ID: BUILD, GS_MODE: "production", GS_ALLOWED_ORIGINS: ORIGIN, GS_TRUSTED_PROXY_HOPS: "0" });
  const child = spawn(process.execPath, [START_JS], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise<Exit>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const server: ServerProcess = { child, output: [], exited: null, exit };
  running.add(server);
  void exit.then((value) => {
    server.exited = value;
    running.delete(server);
  });
  const record = (chunk: Buffer) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim() !== "") server.output.push(line);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await healthy(port))) {
    if (server.exited !== null) throw new Error(`the server exited while starting:\n${server.output.slice(-30).join("\n")}`);
    if (Date.now() > deadline) throw new Error(`the server did not answer within ${START_TIMEOUT_MS} ms:\n${server.output.slice(-30).join("\n")}`);
    await sleep(100);
  }
  return server;
}

async function stopServer(server: ServerProcess, signal: NodeJS.Signals): Promise<Exit> {
  if (server.exited !== null) return server.exited;
  server.child.kill(signal);
  const backstop = setTimeout(() => server.child.kill("SIGKILL"), 10_000);
  const exited = await server.exit;
  clearTimeout(backstop);
  return exited;
}

/** A dead server's lock, aged past its heartbeat window exactly as waiting would have aged it (as the smoke's A13). */
function ageLock(dataDir: string): void {
  const lockDir = path.join(dataDir, LOCK_DIRECTORY);
  assert.ok(fs.existsSync(lockDir), "a SIGKILL leaves the lock behind");
  const aged = new Date(Date.now() - 2 * LOCK_STALE_AFTER_MS);
  for (const name of fs.readdirSync(lockDir)) fs.utimesSync(path.join(lockDir, name), aged, aged);
  fs.utimesSync(lockDir, aged, aged);
}

/* ==================================================================
    HTTP AND SOCKETS, AS A BROWSER USES THEM
   ================================================================== */

interface Answer {
  status: number;
  setCookie: string[];
  body: Record<string, unknown> | null;
  text: string;
}

function post(port: number, pathname: string, payload: object, cookie?: string): Promise<Answer> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: pathname,
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
          } catch {
            parsed = null;
          }
          resolve({ status: response.statusCode ?? 0, setCookie: response.headers["set-cookie"] ?? [], body: parsed, text });
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(WAIT_MS, () => request.destroy(new Error(`${pathname} did not answer`)));
    request.end(body);
  });
}

function cookieOf(answer: Answer): string {
  const line = answer.setCookie.find((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`) && !entry.startsWith(`${SESSION_COOKIE_NAME}=;`));
  assert.ok(line, `a session cookie is set (${answer.status} ${answer.text})`);
  return (line as string).split(";")[0].trim();
}

interface Frame {
  kind: string;
  [field: string]: unknown;
}

let requests = 0;
let submissions = 0;
const sockets = new Set<Tab>();

class Tab {
  readonly frames: Frame[] = [];
  closed = false;
  private constructor(readonly socket: WebSocket) {}

  static open(port: number, cookie: string): Promise<Tab> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/gs`, { origin: ORIGIN, headers: { Cookie: cookie } });
      const tab = new Tab(socket);
      sockets.add(tab);
      socket.on("message", (raw) => tab.frames.push(JSON.parse(String(raw)) as Frame));
      socket.on("close", () => {
        tab.closed = true;
        sockets.delete(tab);
      });
      socket.on("unexpected-response", (request, response) => {
        response.resume();
        request.destroy();
        reject(new Error(`the upgrade was refused ${response.statusCode}`));
      });
      socket.on("error", (error) => reject(error));
      socket.once("open", () => resolve(tab));
    });
  }

  send(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }

  waitFor(predicate: (frame: Frame) => boolean, label: string): Promise<Frame> {
    return until(() => this.frames.find(predicate), () => `${label} (saw ${this.frames.map((frame) => frame.kind).join(",")})`);
  }

  op(body: Record<string, unknown>, gameId?: string): Promise<Frame> {
    requests += 1;
    const requestId = `p-rq-${requests}`;
    this.send({ kind: "room-op", requestId, ...(gameId !== undefined ? { gameId } : {}), op: body });
    return this.waitFor((frame) => frame.kind === "room-ack" && frame.requestId === requestId, `the ack of ${String(body.type)}`);
  }

  hello(gameId: string): void {
    this.send({ kind: "hello", gameId, build: BUILD, baseIndex: -1 });
  }

  roomHello(gameId: string): void {
    this.send({ kind: "room-hello", gameId, build: BUILD });
  }

  /** The latest room view for `gameId` that satisfies `predicate`. */
  view(gameId: string, predicate: (view: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
    return until(
      () => {
        for (let at = this.frames.length - 1; at >= 0; at -= 1) {
          const frame = this.frames[at];
          if (frame.kind !== "room" || (frame.view as { gameId?: string }).gameId !== gameId) continue;
          return predicate(frame.view as Record<string, unknown>) ? (frame.view as Record<string, unknown>) : undefined;
        }
        return undefined;
      },
      `a room view of ${gameId}`,
    );
  }

  entries(): Array<{ index: number; id: string; actor: string; payload: string }> {
    const all = new Map<number, { index: number; id: string; actor: string; payload: string }>();
    for (const frame of this.frames) {
      if (frame.kind !== "applied" && frame.kind !== "catch-up") continue;
      for (const entry of (frame.entries as Array<{ index: number; id: string; actor: string; payload: string }>) ?? []) all.set(entry.index, entry);
    }
    return [...all.values()].sort((a, b) => a.index - b.index);
  }

  act(msg: object): Promise<Frame> {
    const all = this.entries();
    const tip = all[all.length - 1];
    submissions += 1;
    const submissionId = `p-sub-${submissions}`;
    this.send({ kind: "submit", build: BUILD, msg, baseIndex: tip === undefined ? -1 : tip.index, ...(tip ? { baseId: tip.id } : {}), submissionId });
    return this.waitFor((frame) => frame.inReplyTo === submissionId, `the answer to ${submissionId}`);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const backstop = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 3_000);
      this.socket.once("close", () => {
        clearTimeout(backstop);
        resolve();
      });
      this.socket.close();
    });
  }
}

const dealOf = (tab: Tab) => {
  const deal = tab.entries().find((entry) => "SetupGame" in (JSON.parse(entry.payload) as object));
  const setup = deal ? (JSON.parse(deal.payload) as { SetupGame: { players: Array<{ id: string }> } }).SetupGame : null;
  return setup;
};

/** Every file under `dir`, recursively, as text. */
function everyFile(dir: string): Array<{ file: string; text: string }> {
  const found: Array<{ file: string; text: string }> = [];
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push({ file: path.relative(dir, full), text: fs.readFileSync(full, "latin1") });
    }
  };
  walk(dir);
  return found;
}

function doctor(dataDir: string, ...args: string[]): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of OWNED_SETTINGS) delete env[name];
  const result = spawnSync(process.execPath, [DOCTOR_JS, ...args, "--data", dataDir], { cwd: SERVER_DIR, env, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/* ==================================================================
    THE RUN
   ================================================================== */

test("LIVE-3C, the real process: SIGKILL twice over a full data directory -- discovery, durable holds, identity, games and ops all come back exactly", { timeout: 170_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "live3c-process-"));
  const secrets: Array<{ what: string; value: string }> = [];
  const keep = (what: string, value: string) => {
    assert.ok(value.length >= 8, `${what} is a real secret`);
    secrets.push({ what, value });
  };
  const cookieSecret = (cookie: string) => cookie.slice(cookie.lastIndexOf(".") + 1);
  let server: ServerProcess | null = null;
  try {
    const port = await freePort();
    server = await startServer(port, dataDir);

    /* ---- the people: Alice (two devices, a rotated key, a spare link code), Bob (a signed-out second device) ---- */
    const browser = async (): Promise<string> => {
      const boot = await post(port, SESSION_PATH, {});
      assert.equal(boot.status, 201, boot.text);
      const cookie = cookieOf(boot);
      keep("a cookie secret", cookieSecret(cookie));
      return cookie;
    };
    const profile = async (cookie: string, name: string): Promise<string> => {
      const made = await post(port, PROFILE_PATH, { name }, cookie);
      assert.equal(made.status, 201, made.text);
      const key = String(made.body?.recoveryKey);
      keep(`${name}'s recovery key`, key);
      return key;
    };
    const redeem = async (pathname: string, body: object): Promise<{ answer: Answer; cookie: string | null }> => {
      const fresh = await browser();
      const answer = await post(port, pathname, body, fresh);
      if (answer.status !== 200) return { answer, cookie: null };
      const cookie = cookieOf(answer);
      keep("a redeemed cookie secret", cookieSecret(cookie));
      return { answer, cookie };
    };
    const mintCode = async (cookie: string): Promise<string> => {
      const minted = await post(port, LINK_CODE_PATH, {}, cookie);
      assert.equal(minted.status, 201, minted.text);
      const code = String(minted.body?.code);
      keep("a link code", code);
      keep("a link code (canonical)", code.replace(/-/g, ""));
      return code;
    };

    const aliceA = await browser();
    const aliceOldKey = await profile(aliceA, "Alice");
    const bobB = await browser();
    await profile(bobB, "Bob");
    const consumedCode = await mintCode(aliceA);
    const linked = await redeem(LINK_PATH, { code: consumedCode });
    assert.equal(linked.answer.status, 200, linked.answer.text);
    const aliceC = linked.cookie as string;
    const rotated = await post(port, RECOVERY_KEY_PATH, {}, aliceC);
    assert.equal(rotated.status, 200, rotated.text);
    const aliceNewKey = String(rotated.body?.recoveryKey);
    keep("Alice's rotated recovery key", aliceNewKey);
    assert.notEqual(aliceNewKey, aliceOldKey);
    /* Minted after the rotation (a rotation drops every outstanding code of the profile, LIVE-2E). */
    const outstandingCode = await mintCode(aliceA);
    const bobCode = await mintCode(bobB);
    const bobLinked = await redeem(LINK_PATH, { code: bobCode });
    const bobD = bobLinked.cookie as string;
    const revoked = await post(port, REVOKE_PATH, {}, bobD);
    assert.equal(revoked.status, 204, "Bob's second device signs itself out");

    /* ---- the games: a waiting room, a dealt game played on both of Alice's devices, and two more dealt games ---- */
    const alice = await Tab.open(port, aliceA);
    const aliceOther = await Tab.open(port, aliceC);
    const bob = await Tab.open(port, bobB);
    const waiting = await alice.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
    assert.equal(waiting.ok, true, JSON.stringify(waiting));
    const waitingId = (waiting.data as { gameId: string }).gameId;

    /* A host may keep three open tables: Alice hosts the waiting room and two dealt games, Bob the fourth. */
    const dealtGame = async (host: Tab, guest: Tab): Promise<string> => {
      const created = await host.op({ type: "create", visibility: "private", exactPlayers: null, variants: {}, nickname: "" });
      assert.equal(created.ok, true, JSON.stringify(created));
      const { gameId, code } = created.data as { gameId: string; code: string };
      assert.equal((await guest.op({ type: "join", code, takeSeat: true })).ok, true);
      assert.equal((await host.op({ type: "set-ready", ready: true }, gameId)).ok, true);
      assert.equal((await guest.op({ type: "set-ready", ready: true }, gameId)).ok, true);
      const started = await host.op({ type: "start-game" }, gameId);
      assert.equal(started.ok, true, JSON.stringify(started));
      return gameId;
    };
    const activeId = await dealtGame(alice, bob);
    const heldId = await dealtGame(alice, bob);
    const incompatibleId = await dealtGame(bob, alice);

    const playerIdOf = async (tab: Tab, gameId: string) => {
      tab.roomHello(gameId);
      return String(((await tab.view(gameId)).you as { playerId: string }).playerId);
    };
    for (const tab of [alice, aliceOther, bob]) tab.hello(activeId);
    await Promise.all([alice, aliceOther, bob].map((tab) => tab.waitFor((frame) => frame.kind === "catch-up", "the active game's catch-up")));
    const alicePid = await playerIdOf(alice, activeId);
    assert.equal(await playerIdOf(aliceOther, activeId), alicePid, "Alice's second device is her seat");
    const bobPid = await playerIdOf(bob, activeId);
    await until(() => dealOf(alice) !== null, "the deal on Alice's socket");
    const first = (dealOf(alice) as { players: Array<{ id: string }> }).players[0].id;
    const [onTurn, next] = first === alicePid ? [alice, bob] : [bob, alice];
    const moved = await onTurn.act(BUY);
    assert.equal(moved.kind, "applied", JSON.stringify(moved));
    const logBefore = alice.entries().length;
    await until(() => aliceOther.entries().length === logBefore, "Alice's other device hearing the move");

    /* ---- KILL #1, then the directory is given two things to find ---- */
    const killed = await stopServer(server, "SIGKILL");
    assert.equal(killed.signal, "SIGKILL");
    await Promise.all([...sockets].map((tab) => tab.close()));
    ageLock(dataDir);
    const recordFile = (gameId: string) => path.join(dataDir, "games", `${gameId}.json`);
    const heldRecord = JSON.parse(fs.readFileSync(recordFile(heldId), "utf8")) as GameRecord;
    fs.writeFileSync(recordFile(heldId), `${JSON.stringify({ ...heldRecord, host_player_id: "p-0123456789abcdef" })}\n`); // a host nobody seats
    const logStore = createFileLogStore(dataDir, { warn: () => undefined });
    const incompatibleLog = await logStore.loadLog(incompatibleId);
    const setup = JSON.parse(incompatibleLog[0].payload) as { SetupGame: Record<string, unknown> };
    setup.SetupGame.rules_engine_version = 99;
    const repinned = [{ ...incompatibleLog[0], payload: JSON.stringify(setup) }, ...incompatibleLog.slice(1)];
    fs.writeFileSync(path.join(dataDir, `${incompatibleId}.log.jsonl`), repinned.map((entry) => serializeBatch([entry])).join(""));
    const incompatibleRecord = JSON.parse(fs.readFileSync(recordFile(incompatibleId), "utf8")) as GameRecord;
    fs.writeFileSync(recordFile(incompatibleId), `${JSON.stringify({ ...incompatibleRecord, rules_engine_version: 99 })}\n`);
    const heldLogBytes = fs.readFileSync(path.join(dataDir, `${heldId}.log.jsonl`));

    /* ---- RESTART #1 ---- */
    server = await startServer(port, dataDir);
    const window1 = server;
    await until(() => window1.output.some((line) => line.includes("took over a stale data-directory lock")), "the lock takeover line");
    const discoveryLine = await until(() => window1.output.find((line) => /discovery: \d+ games found/.test(line)), "the discovery line");
    assert.match(discoveryLine, /4 games found/, discoveryLine);
    assert.match(discoveryLine, /1 held/, discoveryLine);
    assert.match(discoveryLine, /1 incompatible/, discoveryLine);
    assert.match(discoveryLine, /1 unreconciled/, `the dealt game is stage one until it is loaded: ${discoveryLine}`);
    assert.match(discoveryLine, /1 waiting/, discoveryLine);
    assert.ok(window1.output.some((line) => line.includes(`${heldId} HELD (host-not-seated)`)), "the held game is named with its reason");
    const holdFile = path.join(dataDir, "games", "holds", `${heldId}.json`);
    assert.ok(fs.existsSync(holdFile), "the hold is written down");
    assert.ok(!fs.existsSync(path.join(dataDir, "games", "holds", `${incompatibleId}.json`)), "incompatible is derived, never a hold file");

    // Identity: every fact survived the kill.
    const accountOf = async (cookie: string) => post(port, SESSION_PATH, {}, cookie);
    for (const [cookie, name] of [[aliceA, "Alice"], [aliceC, "Alice"], [bobB, "Bob"]] as const) {
      const again = await accountOf(cookie);
      assert.deepEqual([again.status, (again.body?.profile as { name?: string } | null)?.name, again.setCookie.length], [200, name, 0], again.text);
    }
    const bobEnded = await accountOf(bobD);
    assert.deepEqual([bobEnded.status, bobEnded.body?.error, bobEnded.body?.reason], [401, "session-ended", "logout"], "the signed-out device stays signed out");
    assert.equal((await redeem(LINK_PATH, { code: consumedCode })).answer.status, 403, "the consumed link code stays consumed");
    const outstanding = await redeem(LINK_PATH, { code: outstandingCode });
    assert.deepEqual([outstanding.answer.status, (outstanding.answer.body?.profile as { name?: string })?.name], [200, "Alice"], "the outstanding link code still works");
    assert.equal((await redeem(RECOVER_PATH, { recoveryKey: aliceOldKey })).answer.status, 403, "the rotated-out key stays refused");
    const recovered = await redeem(RECOVER_PATH, { recoveryKey: aliceNewKey });
    assert.deepEqual([recovered.answer.status, (recovered.answer.body?.profile as { name?: string })?.name], [200, "Alice"], "the new key recovers Alice");

    // Games: the active one carries on from the same log on both of Alice's devices.
    const alice2 = await Tab.open(port, aliceA);
    const aliceOther2 = await Tab.open(port, aliceC);
    const bob2 = await Tab.open(port, bobB);
    for (const tab of [alice2, aliceOther2, bob2]) tab.hello(activeId);
    await Promise.all([alice2, aliceOther2, bob2].map((tab) => tab.waitFor((frame) => frame.kind === "catch-up", "the restored catch-up")));
    assert.deepEqual([alice2.entries().length, aliceOther2.entries().length, bob2.entries().length], [logBefore, logBefore, logBefore]);
    assert.equal(await playerIdOf(aliceOther2, activeId), alicePid, "Alice's second device is still her seat");
    const nextTab = next === alice ? alice2 : bob2;
    const movedAgain = await nextTab.act(BUY);
    assert.equal(movedAgain.kind, "applied", JSON.stringify(movedAgain));
    assert.equal(await playerIdOf(bob2, activeId), bobPid);
    // The waiting room is still waiting.
    const waitingView = await (async () => {
      alice2.roomHello(waitingId);
      return alice2.view(waitingId);
    })();
    assert.deepEqual([waitingView.lifecycle, waitingView.holdKind ?? null], ["waiting", null]);
    // The held game: the one held sentence, a maintenance view, nothing served, nothing changed.
    alice2.hello(heldId);
    const heldAnswer = await alice2.waitFor((frame) => frame.kind === "error" && frame.code === "held", "the held answer");
    assert.equal(heldAnswer.reason, HELD_PLAYER_SENTENCE);
    alice2.roomHello(heldId);
    const heldView = await alice2.view(heldId);
    assert.deepEqual([heldView.held, heldView.holdKind], [true, "maintenance"]);
    assert.equal((await alice2.op({ type: "cancel-room" }, heldId)).code, "held");
    // The incompatible game: its own answer and view.
    bob2.hello(incompatibleId);
    await bob2.waitFor((frame) => frame.kind === "incompatible", "the incompatible answer");
    bob2.roomHello(incompatibleId);
    assert.equal((await bob2.view(incompatibleId)).holdKind, "incompatible");

    // Ops: the status file and the audit say what an operator needs, and never an identity id.
    const statusPath = path.join(dataDir, OPS_DIRECTORY, STATUS_FILE);
    const status = await until(() => {
      if (!fs.existsSync(statusPath)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as { games?: { by_class?: Record<string, number> }; held?: Array<{ game_id: string; code: string }> };
      return parsed.games?.by_class?.held === 1 ? parsed : undefined;
    }, "ops/status.json with the held game");
    assert.equal(status.games?.by_class?.incompatible, 1, JSON.stringify(status));
    assert.deepEqual(status.held?.map((game) => [game.game_id, game.code]), [[heldId, "host-not-seated"]]);
    const doctorStatus = doctor(dataDir, "status");
    assert.equal(doctorStatus.status, 0, doctorStatus.out);
    assert.ok(doctorStatus.out.includes(heldId), "gamesDoctor status names the held game");
    const refusedInspect = doctor(dataDir, "inspect");
    assert.equal(refusedInspect.status, 2, "inspect refuses while a server holds the directory");
    assert.match(refusedInspect.out, /Refusing: a game server holds/);
    await Promise.all([...sockets].map((tab) => tab.close()));

    /* ---- KILL #2, RESTART #2: the hold is found again (not created again); everything else as before ---- */
    assert.equal((await stopServer(server, "SIGKILL")).signal, "SIGKILL");
    ageLock(dataDir);
    server = await startServer(port, dataDir);
    const window2 = server;
    const discoveryLine2 = await until(() => window2.output.find((line) => /discovery: \d+ games found/.test(line)), "the second discovery line");
    assert.match(discoveryLine2, /1 held/, discoveryLine2);
    assert.ok(fs.readFileSync(path.join(dataDir, `${heldId}.log.jsonl`)).equals(heldLogBytes), "the held game's log is exactly as found");
    const alice3 = await Tab.open(port, aliceC);
    alice3.hello(activeId);
    await alice3.waitFor((frame) => frame.kind === "catch-up", "the active game after the second kill");
    assert.equal(alice3.entries().length, logBefore + 1, "the move made after the first restart is durable");
    alice3.hello(heldId);
    await alice3.waitFor((frame) => frame.kind === "error" && frame.code === "held", "still held");
    await alice3.close();
    assert.equal((await accountOf(aliceC)).status, 200, "Alice's second device survives the second kill too");

    /* ---- A CLEAN STOP: the lock is released, the audit is complete, the tool reports ---- */
    const stopped = await stopServer(server, "SIGTERM");
    assert.equal(stopped.code, 0, `a clean stop exits 0:\n${window2.output.slice(-20).join("\n")}`);
    assert.ok(!fs.existsSync(path.join(dataDir, LOCK_DIRECTORY)), "a clean stop releases the lock");
    const audit = fs.readFileSync(path.join(dataDir, OPS_DIRECTORY, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; game_id?: string });
    assert.equal(audit.filter((line) => line.event === "hold.created" && line.game_id === heldId).length, 1, "one hold, created once, across two restarts");
    const inspected = doctor(dataDir, "inspect", "--deep");
    assert.equal(inspected.status, 1, `inspect reports a held game:\n${inspected.out}`);
    assert.ok(inspected.out.includes(`${heldId}  held`) && inspected.out.includes("host-not-seated"), inspected.out);
    assert.match(inspected.out, /identity: OK/);

    /* ---- NO SECRET ANYWHERE: not in any window, not in any file; no identity id in any ops file ---- */
    const windows = [...window1.output, ...window2.output].join("\n");
    const files = everyFile(dataDir);
    for (const { what, value } of secrets) {
      assert.ok(!windows.includes(value), `${what} is not in the server's window`);
      for (const { file, text } of files) assert.ok(!text.includes(value), `${what} is not in ${file}`);
    }
    for (const { file, text } of files.filter(({ file }) => file.startsWith(OPS_DIRECTORY) || file.startsWith(path.join("games", "holds")))) {
      assert.ok(!IDENTITY_ID.test(text), `no identity id in ${file}`);
    }
  } finally {
    await Promise.all([...sockets].map((tab) => tab.close()));
    for (const child of running) child.child.kill("SIGKILL");
    await Promise.all([...running].map((child) => child.exit));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
