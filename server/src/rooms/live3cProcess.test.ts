// server/src/rooms/live3cProcess.test.ts
//
// LIVE-3C: THE PROGRAM AN OPERATOR RUNS, KILLED AND STARTED AGAIN. `dist/server/src/start.js` is spawned in production
// mode (session cookies, mandatory accounts) over one data directory. Its identity is filled the way browsers fill it
// -- PHASE 3 FINAL: two accounts (username, password, Authorization Wallet) made over HTTP, a host signed in on a second
// device, a signed-out device, an Authorization Wallet replaced -- then the process is KILLED (SIGKILL: no shutdown hook,
// no flush, no lock release). PHASE 3 FINAL: production serves no free game (every player table is anted), and this
// process has no Juno escrow, so its games -- a waiting room and dealt games seated by those accounts' principals -- are
// written into the directory while it is down, as a restart finds them; so are a record that disagrees with its log and
// a game pinned to a rules engine this build does not carry. Then it is started again, twice, and every one of those
// things is asked about through the real endpoints and sockets:
//
//   * discovery finds every game at startup (its one window line), holds the disagreeing one DURABLY (a hold file,
//     one audit line, across both restarts), derives the incompatible one (no hold file) and serves the rest;
//   * ops/status.json and ops/audit.jsonl say what an operator needs -- and never a principal, profile or session id;
//   * every identity fact survives both kills (the journal store): both devices' cookies, the signed-out device still
//     ended, the replaced Authorization Wallet refused by "Forgot password?" and the new one recovering the account
//     (which signs every earlier device out); the recovery-key and device-link routes answer 410 retired;
//   * the dealt game carries on from the same log on both of the host's devices; the waiting room is still waiting;
//   * the held game answers the one held sentence and a "maintenance" view; the incompatible one its own;
//   * no password or cookie secret appears in the server's window or in ANY file in the directory;
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

import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { createFileLogStore } from "../fileLogStore";
import { SESSION_COOKIE_NAME } from "../identity/cookies";
import { IDENTITY_FILE } from "../identity/fileStore";
import {
  ACCOUNT_AUTHORIZATION_PATH,
  ACCOUNT_CREATE_PATH,
  ACCOUNT_LOGIN_PATH,
  ACCOUNT_RECOVER_PATH,
  ACCOUNT_WALLET_CHALLENGE_PATH,
  ACCOUNT_WALLET_REPLACE_PATH,
  HEALTH_PATH,
  REAUTH_PATH,
  REVOKE_PATH,
  SESSION_PATH,
} from "../identity/httpApi";
import { IDENTITY_JOURNAL_FILE, parseSnapshotDocument, scanJournal } from "../identity/journalStore";
import { IdentityIndex } from "../identity/store";
import { keplrAccount, type KeplrAccount } from "../testSupport/authorizationWallets";
import { serializeBatch } from "../persistence/logFormat";
import { AUDIT_FILE, OPS_DIRECTORY, STATUS_FILE } from "../persistence/opsRecorder";
import { LOCK_DIRECTORY, LOCK_STALE_AFTER_MS } from "../persistence/processLock";
import type { GameRecord } from "./gameRecord";
import { HELD_PLAYER_SENTENCE } from "./lifecycle";
import { ALICE, BOB, seededRecord, storedLog } from "./testSupport";

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
  /* The IPC channel is the clean stop on Windows (`stopServer`): there, "SIGTERM" from a parent is a hard kill. */
  const child = spawn(process.execPath, [START_JS], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
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
  /* LIVE-2F/3D: on Windows a parent cannot deliver SIGTERM (Node's kill() is TerminateProcess there), so the clean
     stop is asked for over the IPC channel -- start.ts runs the same release for it as for a signal. */
  if (signal === "SIGTERM" && process.platform === "win32") server.child.send("shutdown");
  else server.child.kill(signal);
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

/** The accounts' principals, READ-ONLY from the identity store a killed server left (its snapshot and journal, applied in
 *  memory as `gamesDoctor inspect` reads them): username -> principal id. Only to seat the games written while it is
 *  down -- no id ever reaches a browser. */
function principalsOnDisk(dataDir: string): Map<string, string> {
  const parsed = parseSnapshotDocument(JSON.parse(fs.readFileSync(path.join(dataDir, IDENTITY_FILE), "utf8")), IDENTITY_FILE);
  const journalPath = path.join(dataDir, IDENTITY_JOURNAL_FILE);
  const scan = scanJournal(fs.existsSync(journalPath) ? fs.readFileSync(journalPath) : Buffer.alloc(0), parsed.seq);
  const index = IdentityIndex.from(parsed.snapshot);
  for (const { change } of scan.changes) index.apply(change);
  return new Map(index.snapshot().profiles.flatMap((profile) => (typeof profile.login_name === "string" ? [[profile.login_name, profile.principal_id] as const] : [])));
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

    /* ---- the people: Alice (two devices, a replaced Authorization Wallet), Bob (a signed-out second device) ---- */
    const browser = async (): Promise<string> => {
      const boot = await post(port, SESSION_PATH, {});
      assert.equal(boot.status, 201, boot.text);
      const cookie = cookieOf(boot);
      keep("a cookie secret", cookieSecret(cookie));
      return cookie;
    };
    /* PHASE 3 FINAL: an account is made over HTTP with its Authorization Wallet -- the CREATE text, the wallet's ADR-036
       signature (a test Keplr account), the create -- and the browser goes on with the create's FRESH cookie. */
    const account = async (name: string, wallet: KeplrAccount): Promise<{ cookie: string; username: string; password: string }> => {
      const before = await browser();
      const username = name.toLowerCase();
      const password = `${name} correct horse battery`;
      keep(`${name}'s password`, password);
      const minted = await post(port, ACCOUNT_AUTHORIZATION_PATH, { purpose: "create", username, wallet: wallet.address }, before);
      assert.equal(minted.status, 200, minted.text);
      const signed = wallet.sign((minted.body?.texts as Array<{ text: string }>)[0].text);
      const made = await post(port, ACCOUNT_CREATE_PATH, { username, password, name, operation: minted.body?.operation, pubKey: signed.pubKey, signature: signed.signature }, before);
      assert.equal(made.status, 201, made.text);
      const cookie = cookieOf(made);
      keep("an account's cookie secret", cookieSecret(cookie));
      return { cookie, username, password };
    };
    const redeem = async (pathname: string, body: object): Promise<{ answer: Answer; cookie: string | null }> => {
      const fresh = await browser();
      const answer = await post(port, pathname, body, fresh);
      if (answer.status !== 200) return { answer, cookie: null };
      const cookie = cookieOf(answer);
      keep("a signed-in cookie secret", cookieSecret(cookie));
      return { answer, cookie };
    };
    /** "Forgot password?" on a new browser: `wallet` signs a fresh RECOVER text for the username. */
    const forgot = async (username: string, wallet: KeplrAccount, newPassword: string): Promise<{ answer: Answer; cookie: string | null }> => {
      const fresh = await browser();
      const minted = await post(port, ACCOUNT_AUTHORIZATION_PATH, { purpose: "recover", username, wallet: wallet.address }, fresh);
      assert.equal(minted.status, 200, `RECOVER looks nothing up: ${minted.text}`);
      const signed = wallet.sign((minted.body?.texts as Array<{ text: string }>)[0].text);
      const answer = await post(port, ACCOUNT_RECOVER_PATH, { operation: minted.body?.operation, pubKey: signed.pubKey, signature: signed.signature, newPassword }, fresh);
      if (answer.status !== 200) return { answer, cookie: null };
      const cookie = cookieOf(answer);
      keep("a recovered cookie secret", cookieSecret(cookie));
      return { answer, cookie };
    };

    const aliceWallets = [keplrAccount("live3c/alice/0"), keplrAccount("live3c/alice/1")];
    const aliceAccount = await account("Alice", aliceWallets[0]);
    const aliceA = aliceAccount.cookie;
    const bobAccount = await account("Bob", keplrAccount("live3c/bob/0"));
    const bobB = bobAccount.cookie;
    /* Alice's second device: a sign-in with her username and password (PHASE 3 FINAL: no device-link code exists). */
    const linked = await redeem(ACCOUNT_LOGIN_PATH, { username: aliceAccount.username, password: aliceAccount.password });
    assert.equal(linked.answer.status, 200, linked.answer.text);
    const aliceC = linked.cookie as string;
    /* Alice's second device replaces her Authorization Wallet: "Confirm it's you" (the password), then the CURRENT wallet
       approves and the NEW one accepts (both sign). No session ends. */
    assert.equal((await post(port, REAUTH_PATH, { password: aliceAccount.password }, aliceC)).status, 200);
    const challenge = await post(port, ACCOUNT_WALLET_CHALLENGE_PATH, { newWallet: aliceWallets[1].address }, aliceC);
    assert.equal(challenge.status, 200, challenge.text);
    const [approveText, acceptText] = (challenge.body?.texts as Array<{ text: string }>).map((entry) => entry.text);
    const approve = aliceWallets[0].sign(approveText);
    const accept = aliceWallets[1].sign(acceptText);
    const replaced = await post(port, ACCOUNT_WALLET_REPLACE_PATH, { operation: challenge.body?.operation, approvePubKey: approve.pubKey, approveSignature: approve.signature, acceptPubKey: accept.pubKey, acceptSignature: accept.signature }, aliceC);
    assert.equal(replaced.status, 200, replaced.text);
    assert.equal((replaced.body?.authorizationWallet as { address?: string } | undefined)?.address, aliceWallets[1].address);
    const bobLinked = await redeem(ACCOUNT_LOGIN_PATH, { username: bobAccount.username, password: bobAccount.password });
    assert.equal(bobLinked.answer.status, 200, bobLinked.answer.text);
    const bobD = bobLinked.cookie as string;
    const revoked = await post(port, REVOKE_PATH, {}, bobD);
    assert.equal(revoked.status, 204, "Bob's second device signs itself out");

    /* ---- the sockets: both of Alice's devices and Bob's open (accounts are mandatory); production serves no free game ---- */
    const alice = await Tab.open(port, aliceA);
    await Tab.open(port, aliceC);
    await Tab.open(port, bobB);
    const free = await alice.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
    assert.deepEqual([free.ok, free.code], [false, "ante-required"], `PHASE 3 FINAL: every player table is anted (${JSON.stringify(free)})`);

    /* ---- KILL #1, then the directory is given its games -- and two things to find ---- */
    const killed = await stopServer(server, "SIGKILL");
    assert.equal(killed.signal, "SIGKILL");
    await Promise.all([...sockets].map((tab) => tab.close()));
    ageLock(dataDir);
    const principals = principalsOnDisk(dataDir);
    const principalOf = new Map([
      [ALICE, principals.get(aliceAccount.username) as string],
      [BOB, principals.get(bobAccount.username) as string],
    ]);
    assert.ok([...principalOf.values()].every((id) => typeof id === "string" && id.startsWith("pr_")), "both accounts' principals are on disk");
    const recordFile = (gameId: string) => path.join(dataDir, "games", `${gameId}.json`);
    const logFile = (gameId: string) => path.join(dataDir, `${gameId}.log.jsonl`);
    const writeRecord = (record: GameRecord) => {
      fs.mkdirSync(path.join(dataDir, "games"), { recursive: true });
      fs.writeFileSync(recordFile(record.game_id), `${JSON.stringify(record)}\n`);
    };
    /** A record seated by the accounts' principals (the seeded seats' player ids ALICE, BOB; Alice hosts). */
    const seatedBy = (record: GameRecord): GameRecord => ({ ...record, seats: record.seats.map((seat) => ({ ...seat, principal_id: principalOf.get(seat.player_id) as string })) });
    /** A dealt game on disk: the deal and one purchase, as a restart finds a game a SIGKILL interrupted. */
    const dealtGame = (): string => {
      const log = storedLog(1);
      const base = seededRecord([ALICE, BOB], { dealt: true });
      writeRecord(seatedBy({ ...base, rules_engine_version: RULES_ENGINE_VERSION, started_at: log[0].at ?? Date.now() } as GameRecord));
      fs.writeFileSync(logFile(base.game_id), log.map((entry) => serializeBatch([entry])).join(""));
      return base.game_id;
    };
    const waitingRecord = seatedBy(seededRecord([ALICE], { dealt: false }));
    writeRecord(waitingRecord);
    const waitingId = waitingRecord.game_id;
    const activeId = dealtGame();
    const heldId = dealtGame();
    const incompatibleId = dealtGame();
    const logBefore = storedLog(1).length;
    const heldRecord = JSON.parse(fs.readFileSync(recordFile(heldId), "utf8")) as GameRecord;
    fs.writeFileSync(recordFile(heldId), `${JSON.stringify({ ...heldRecord, host_player_id: "p-0123456789abcdef" })}\n`); // a host nobody seats
    const logStore = createFileLogStore(dataDir, { warn: () => undefined });
    const incompatibleLog = await logStore.loadLog(incompatibleId);
    const setup = JSON.parse(incompatibleLog[0].payload) as { SetupGame: Record<string, unknown> };
    setup.SetupGame.rules_engine_version = 99;
    const repinned = [{ ...incompatibleLog[0], payload: JSON.stringify(setup) }, ...incompatibleLog.slice(1)];
    fs.writeFileSync(logFile(incompatibleId), repinned.map((entry) => serializeBatch([entry])).join(""));
    const incompatibleRecord = JSON.parse(fs.readFileSync(recordFile(incompatibleId), "utf8")) as GameRecord;
    fs.writeFileSync(recordFile(incompatibleId), `${JSON.stringify({ ...incompatibleRecord, rules_engine_version: 99 })}\n`);
    const heldLogBytes = fs.readFileSync(logFile(heldId));

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
    /* PHASE 3 FINAL: the recovery-key and device-link product is retired -- its routes answer 410 and read nothing. */
    for (const retiredPath of ["/gs/api/profile", "/gs/api/profile/link-code", "/gs/api/profile/link", "/gs/api/profile/recover", "/gs/api/profile/recovery-key"]) {
      const retired = await post(port, retiredPath, {}, aliceA);
      assert.deepEqual([retired.status, retired.body?.error], [410, "retired"], retiredPath);
    }
    const oldWallet = await forgot(aliceAccount.username, aliceWallets[0], "Alice never keeps this one");
    assert.deepEqual([oldWallet.answer.status, oldWallet.answer.body?.error], [403, "invalid-credential"], "the replaced Authorization Wallet stays refused");

    // Games: the active one carries on from the same log on both of Alice's devices.
    const playerIdOf = async (tab: Tab, gameId: string) => {
      tab.roomHello(gameId);
      return String(((await tab.view(gameId)).you as { playerId: string }).playerId);
    };
    const alice2 = await Tab.open(port, aliceA);
    const aliceOther2 = await Tab.open(port, aliceC);
    const bob2 = await Tab.open(port, bobB);
    for (const tab of [alice2, aliceOther2, bob2]) tab.hello(activeId);
    await Promise.all([alice2, aliceOther2, bob2].map((tab) => tab.waitFor((frame) => frame.kind === "catch-up", "the restored catch-up")));
    assert.deepEqual([alice2.entries().length, aliceOther2.entries().length, bob2.entries().length], [logBefore, logBefore, logBefore]);
    const alicePid = await playerIdOf(alice2, activeId);
    assert.equal(alicePid, ALICE, "Alice's account holds her seat");
    assert.equal(await playerIdOf(aliceOther2, activeId), alicePid, "Alice's second device is her seat");
    await until(() => dealOf(alice2) !== null, "the deal on Alice's socket");
    const firstMover = (dealOf(alice2) as { players: Array<{ id: string }> }).players[0].id;
    const nextTab = firstMover === ALICE ? bob2 : alice2; // the stored purchase was the first mover's
    /* Phase 3 final clocks: a restart is a continuity break nobody proved -- the Live table is SYSTEM-PAUSED (its timers
       preserved as of the last proof) and takes no move until every player agrees to resume. */
    const held = await nextTab.act(BUY);
    assert.deepEqual([held.kind, held.code], ["refused", "clock-system-paused"], JSON.stringify(held));
    bob2.roomHello(activeId);
    const pausedView = await aliceOther2.view(activeId, (view) => (view.clock as { system?: unknown } | null)?.system != null);
    const since = (pausedView.clock as { system: { since: number } }).system.since;
    for (const tab of [aliceOther2, bob2]) {
      const resumed = await tab.op({ type: "clock-sysresume", since }, activeId);
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
    }
    const movedAgain = await nextTab.act(BUY);
    assert.equal(movedAgain.kind, "applied", JSON.stringify(movedAgain));
    assert.equal(await playerIdOf(bob2, activeId), BOB);
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

    /* ---- "Forgot password?" with Alice's NEW Authorization Wallet: the account is hers again, every earlier device out ---- */
    const alicePassword = "Alice after the restarts";
    keep("Alice's new password", alicePassword);
    const recovered = await forgot(aliceAccount.username, aliceWallets[1], alicePassword);
    assert.deepEqual([recovered.answer.status, (recovered.answer.body?.profile as { name?: string })?.name], [200, "Alice"], "the new Authorization Wallet recovers Alice");
    for (const cookie of [aliceA, aliceC]) {
      const ended = await accountOf(cookie);
      assert.deepEqual([ended.status, ended.body?.error], [401, "session-ended"], "every earlier device of the account is signed out");
    }
    assert.equal((await accountOf(recovered.cookie as string)).status, 200);
    assert.equal((await redeem(ACCOUNT_LOGIN_PATH, { username: aliceAccount.username, password: aliceAccount.password })).answer.status, 403, "the old password is dead");
    assert.equal((await redeem(ACCOUNT_LOGIN_PATH, { username: aliceAccount.username, password: alicePassword })).answer.status, 200, "the new one signs in");
    assert.equal((await accountOf(bobB)).status, 200, "Bob is untouched");

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
