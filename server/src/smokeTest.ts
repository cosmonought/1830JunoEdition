// server/src/smokeTest.ts
//
// Two principals, one table, real sockets, the real process. Proves the loop end to end.
//
// ==================================================================
//  DESIGN NOTE 1210: THE THING THE UNIT TESTS CANNOT SAY
// ==================================================================
//
// The `node --test` suites (`npm test`) prove the actor, the room authority, the identity gate and the reducer --
// each against a server built inside the test's own process. None of them says a byte about whether THE PROGRAM AN
// OPERATOR RUNS -- `start.ts`, its environment, its data directory, its lock -- carries a real frame from a real
// socket to a real table and back. That gap is exactly where a cutover goes wrong, and writing a browser client
// against an unproven server is how the gap gets discovered from inside `App.tsx`, which is the one place this
// project cannot debug cheaply.
//
// SO THIS RUNS FIRST. It spawns `dist/server/src/start.js` as a child process -- never `createGameServer` in this
// process -- and walks a table the way two browsers walk it: nothing is seeded, nothing is reached around.
//
// ==================================================================
//  LIVE-2D: THE CLIENT CUTOVER, SMOKED THROUGH THE ONE ROOM PROTOCOL
// ==================================================================
//
// HALF A -- PRODUCTION (GS_MODE=production, an https origin, no proxy hops, a fresh data directory). Two guests are
//   bootstrapped at `POST /gs/api/session` (the `__Host-gs_session` cookie); their sockets open on `/gs` carrying that
//   cookie and the allowed Origin. Create (no stake) -> join by the JUNO-XXXX-XXXX code -> both seated -> both ready
//   -> start -> the SERVER's SetupGame on both logs -> legal moves and an out-of-turn refusal -> a legal undo and two
//   illegal ones -> reconnect -> the process KILLED (SIGKILL) and started again on the same directory -> the same log,
//   the same seats, and a further move. No `?dev_claim=` anywhere in this half, except to prove it is refused.
// HALF B -- DEVELOPMENT (GS_MODE=development). Two `?dev_claim=` tabs are two principals; the same table is walked from
//   both, each acts only when the board says it may, and a "reload" -- a brand-new socket with the same claim -- keeps
//   its seat, before the deal and after it.
//
// Usage (in server/, after `npm run build`):   npm run smoke          (node dist/server/src/smokeTest.js)
// SMOKE_VERBOSE=1 echoes both servers' windows. The last line is exactly `SMOKE PASSED`; otherwise the run exits 1
// with the tail of each server's window and `SMOKE FAILED: <why>`. It never hangs: every wait has a deadline, and the
// whole run has one of 120 s.

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import { WebSocket } from "ws";

import { SESSION_COOKIE_NAME } from "./identity/cookies";
import { HEALTH_PATH, SESSION_PATH } from "./identity/httpApi";
import { LOCK_DIRECTORY, LOCK_STALE_AFTER_MS } from "./persistence/processLock";
import { GAME_ID_PATTERN, PLAYER_ID_PATTERN, parseJoinCode } from "./rooms/gameRecord";
/* The engine's own undo sentences, so the harness cannot drift from what the Undo button and the server both say. */
import { REVERT_DEAL_FLOOR, REVERT_NOT_YOURS } from "../../frontend/src/gameEngine/logRevert";
/* The client's own room projection, so the checks below read the view exactly as a browser reads it. */
import type { RoomChatEntry, RoomView } from "../../frontend/src/utils/roomProtocol";

/* ==================================================================
    SETTINGS
   ================================================================== */

/** MUST MATCH the `BUILD_ID` the spawned servers are given (#1206): a mismatch is `build-skew`, not a move. */
const BUILD = "smoke-live2d";
/** Production takes https origins only, exactly as listed (`identity/mode.ts`); `.invalid` never resolves. */
const PRODUCTION_ORIGIN = "https://smoke.invalid";
const FOREIGN_ORIGIN = "https://elsewhere.invalid";
/** The CRA dev server's origin -- one of the two development defaults when GS_ALLOWED_ORIGINS is absent. */
const DEVELOPMENT_ORIGIN = "http://localhost:3000";

const OVERALL_TIMEOUT_MS = 120_000;
/** Every frame, ack and answer is owed within this. Generous: the machine running this may be busy. */
const WAIT_MS = 15_000;
/** A cold start loads the whole engine before the first byte is served. */
const START_TIMEOUT_MS = 40_000;
const VERBOSE = process.env.SMOKE_VERBOSE === "1";

/** `dist/server/src/start.js`, beside this file once compiled; spawned from `server/` as `npm start` runs it. */
const START_JS = path.join(__dirname, "start.js");
const SERVER_DIR = path.resolve(__dirname, "..", "..", "..");
/** Settings this run decides for itself: whatever the invoking shell has set for them is not inherited, so a stray
 *  `LEGACY_LOGS` or `EXPLAIN_DIVERGENCE` cannot make production refuse (or development differ) for a reason the
 *  smoke did not choose. */
const OWNED_SETTINGS = [
  "GS_MODE",
  "GS_ALLOWED_ORIGINS",
  "GS_TRUSTED_PROXY_HOPS",
  "DATA_DIR",
  "PORT",
  "BUILD_ID",
  "LEGACY_LOGS",
  "INSECURE_LOCAL_IDENTITY",
  "EXPLAIN_DIVERGENCE",
];

/** The seat on turn buys the cheapest private: legal for the first seat of the deal, then the other, alternately. */
const BUY = { WaterfallBuyLowest: { game_id: 0 } };
/** `turnAuthority`'s sentence for a move made out of turn. */
const NOT_YOUR_TURN = "It is not your turn.";
/** LIVE-2 §3.2: no principal id -- a guest's `pr_…` or a development `pr_dev_…` -- ever goes on the wire. */
const PRINCIPAL_ON_WIRE = /\bpr_[0-9a-z]{26}\b|pr_dev_/;

/* ==================================================================
    THE WINDOW: A STEP LINE, THEN ONE `ok` PER CLAIM
   ================================================================== */

class SmokeFailure extends Error {}

const say = (line: string): void => {
  // eslint-disable-next-line no-console
  console.log(line);
};
const step = (id: string, text: string): void => say(`\n[${id}] ${text}`);

const excerptOf = (value: unknown, max = 900): string => {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** A claim that is false STOPS the run. Every step below builds on the one before it, so carrying on past a failure
 *  would only report its echoes -- the first false claim is the finding. */
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    say(`  ok  ${label}`);
    return;
  }
  throw new SmokeFailure(detail === undefined ? label : `${label}\n        got: ${excerptOf(detail)}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A frame that never arrives must FAIL, not hang. A harness that waits forever tells you nothing and costs whoever
 *  ran it several minutes before they think to kill it; every wait here is a claim that something is owed. */
async function until<T>(probe: () => T | null | undefined | false, label: string | (() => string), timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) {
      throw new SmokeFailure(`timed out after ${timeoutMs} ms waiting for ${typeof label === "string" ? label : label()}`);
    }
    await sleep(10);
  }
}

/* ==================================================================
    THE SERVERS: REAL PROCESSES, REAL DATA DIRECTORIES
   ================================================================== */

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ServerProcess {
  label: string;
  port: number;
  child: ChildProcess;
  /** Every line of its window, kept for the report a failure prints. */
  output: string[];
  exited: Exit | null;
  exit: Promise<Exit>;
}

const servers: ServerProcess[] = [];
const tempDirs = new Set<string>();

function makeTempDir(tag: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `1830-smoke-${tag}-`));
  tempDirs.add(directory);
  return directory;
}

function removeTempDir(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
  tempDirs.delete(directory);
}

/* ==================================================================
    A PORT THE OPERATING SYSTEM CHOOSES, AND WHY IT IS NOT 8917
   ==================================================================
   THIS TEST IS MEANT TO BE RUNNABLE WHILE THE REAL SERVER IS UP. It is the first thing to reach for when the browser
   is misbehaving, and that is precisely the moment when 8917 is already taken -- so a fixed port would make the check
   unavailable exactly when it is wanted, and the failure (`EADDRINUSE`) looks like a fault in the thing being
   diagnosed rather than in the diagnosis. `start.ts` takes a PORT, not port 0, so the OS is asked here and the answer
   handed over. */
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

const describeExit = (exit: Exit) => (exit.signal !== null ? `signal ${exit.signal}` : `exit ${exit.code}`);

/** `node dist/server/src/start.js` with the given settings, answered once `/gs/healthz` says so. */
async function startServer(label: string, port: number, dataDir: string, settings: Record<string, string>): Promise<ServerProcess> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of OWNED_SETTINGS) delete env[name];
  Object.assign(env, { PORT: String(port), DATA_DIR: dataDir, BUILD_ID: BUILD }, settings);
  const child = spawn(process.execPath, [START_JS], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise<Exit>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const server: ServerProcess = { label, port, child, output: [], exited: null, exit };
  void exit.then((value) => {
    server.exited = value;
  });
  const record = (chunk: Buffer) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === "") continue;
      server.output.push(line);
      if (VERBOSE) say(`      [${label}] ${line}`);
    }
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  child.on("error", (error) => server.output.push(`(spawn error) ${error.message}`));
  servers.push(server);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await healthy(port))) {
    if (server.exited !== null) throw new SmokeFailure(`${label} exited while starting (${describeExit(server.exited)})`);
    if (Date.now() > deadline) throw new SmokeFailure(`${label} did not answer ${HEALTH_PATH} within ${START_TIMEOUT_MS} ms`);
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

const sawLine = (server: ServerProcess, text: string) => server.output.some((line) => line.includes(text));

/* ==================================================================
    LIVE-2B: THE SESSION BOOTSTRAP, THROUGH THE ACTUAL HTTP ENDPOINT
   ================================================================== */

interface Bootstrap {
  status: number;
  setCookie: string[];
  body: Record<string, unknown> | null;
  text: string;
}

function postSession(port: number, headers: Record<string, string>): Promise<Bootstrap> {
  const body = "{}";
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: SESSION_PATH,
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...headers },
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
    request.setTimeout(WAIT_MS, () => request.destroy(new Error(`${SESSION_PATH} did not answer`)));
    request.end(body);
  });
}

/** The one `__Host-gs_session` cookie a bootstrap set, as a browser sends it back (`name=value`) -- every attribute
 *  LIVE-2B promises checked on the way. The secret itself is never printed. */
function sessionCookieOf(boot: Bootstrap, who: string): string {
  const lines = boot.setCookie.filter((line) => line.startsWith(`${SESSION_COOKIE_NAME}=`));
  check(`${who}: exactly one ${SESSION_COOKIE_NAME} cookie is set`, lines.length === 1, boot.setCookie.length);
  const [pair, ...attributes] = lines[0].split(";").map((part) => part.trim());
  const has = (attribute: RegExp) => attributes.some((part) => attribute.test(part));
  check(
    `${who}: Secure; HttpOnly; SameSite=Strict; Path=/; no Domain`,
    has(/^Secure$/i) && has(/^HttpOnly$/i) && has(/^SameSite=Strict$/i) && has(/^Path=\/$/) && !has(/^Domain=/i),
    attributes,
  );
  check(`${who}: and it carries a value`, pair.length > SESSION_COOKIE_NAME.length + 1);
  return pair;
}

/* ==================================================================
    THE CLIENT: ONE SOCKET PER TAB, EVERY FRAME RECORDED IN ORDER
   ==================================================================
   One socket carries everything a tab says, exactly as the browser's does: room operations, the room view
   (`room-hello`), the log (`hello`) and moves (`submit`), each addressed by `gameId`. Every frame is kept, in arrival
   order, and every check reads from that record -- by the id that names it (`requestId`, `inReplyTo`, an entry's id)
   or, for the room view, as it stands NOW (the latest `room` frame), which is what a screen shows. */

interface Frame {
  kind: string;
  [field: string]: unknown;
}

/** A log entry as the wire carries it (`ServerLogEntry`). */
interface Entry {
  index: number;
  id: string;
  actor: string;
  payload: string;
  derived?: boolean;
  submission_id?: string;
}

const entriesOf = (frame: Frame): Entry[] => {
  if (frame.kind === "applied" || frame.kind === "catch-up") return (frame.entries as Entry[] | undefined) ?? [];
  if (frame.kind === "refused" && typeof frame.catchUp === "object" && frame.catchUp !== null) {
    return ((frame.catchUp as { entries?: Entry[] }).entries as Entry[] | undefined) ?? [];
  }
  return [];
};

const payloadOf = (entry: Entry): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(entry.payload) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const isDeal = (entry: Entry) => "SetupGame" in payloadOf(entry);

/** The entry a submit appended for its own sender: the one non-derived entry carrying its submission id. */
const ownEntry = (answer: Frame): Entry | undefined =>
  entriesOf(answer).find((entry) => entry.submission_id === answer.inReplyTo && entry.derived !== true);

/** A fan-out copy -- the news another socket's move sends everyone else -- carrying `entryId`. */
const fanoutOf = (entryId: string) => (frame: Frame) =>
  frame.kind === "applied" && frame.inReplyTo === undefined && entriesOf(frame).some((entry) => entry.id === entryId);

const sameLog = (a: readonly Entry[], b: readonly Entry[]) =>
  a.length === b.length && a.every((entry, at) => entry.index === b[at].index && entry.id === b[at].id && entry.actor === b[at].actor);

const logSummary = (log: readonly Entry[]) => {
  const tip = log[log.length - 1];
  return tip === undefined ? "empty" : `${log.length} entries, tip #${tip.index} ${tip.id}`;
};

const openClients = new Set<WireClient>();
let requests = 0;
let submissions = 0;

class WireClient {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  /** Entries this tab already held before this socket (a dropped socket's resume): what a browser keeps in memory. */
  private readonly carried = new Map<number, Entry>();

  private constructor(
    readonly name: string,
    readonly socket: WebSocket,
  ) {}

  static open(name: string, url: string, origin: string, headers: Record<string, string> = {}): Promise<WireClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { origin, headers });
      const client = new WireClient(name, socket);
      openClients.add(client);
      socket.on("message", (raw) => client.frames.push(JSON.parse(String(raw)) as Frame));
      socket.on("close", (code, reason) => {
        client.closed = { code, reason: String(reason) };
        openClients.delete(client);
      });
      socket.on("unexpected-response", (request, response) => {
        response.resume();
        request.destroy();
        reject(new SmokeFailure(`${name}: the server refused the socket's upgrade (${response.statusCode})`));
      });
      socket.on("error", (error) => reject(new SmokeFailure(`${name}: socket error -- ${error.message}`)));
      socket.once("open", () => resolve(client));
    });
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  kinds(): string {
    return this.frames.map((frame) => frame.kind).join(",") || "nothing";
  }

  send(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** The first recorded frame that matches -- waiting for it if it has not arrived; failing if the socket closes. */
  waitFor(predicate: (frame: Frame) => boolean, label: string, timeoutMs = WAIT_MS): Promise<Frame> {
    return until(
      () => {
        const found = this.frames.find(predicate);
        if (found !== undefined) return found;
        if (this.closed !== null) {
          throw new SmokeFailure(`${this.name}'s socket closed (${this.closed.code} ${this.closed.reason}) before ${label}; it saw ${this.kinds()}`);
        }
        return undefined;
      },
      () => `${label} on ${this.name}'s socket (it saw ${this.kinds()})`,
      timeoutMs,
    );
  }

  /** The room view AS IT STANDS -- the latest `room` frame -- once it satisfies `predicate`. */
  view(predicate: (view: RoomView) => boolean = () => true, label = "a room view"): Promise<RoomView> {
    return until(
      () => {
        for (let at = this.frames.length - 1; at >= 0; at -= 1) {
          if (this.frames[at].kind !== "room") continue;
          const view = this.frames[at].view as RoomView;
          return predicate(view) ? view : undefined;
        }
        return undefined;
      },
      () => `${label} on ${this.name}'s socket (it saw ${this.kinds()})`,
    );
  }

  /** One room operation, answered by the `room-ack` that names it. */
  op(body: Record<string, unknown>, gameId?: string): Promise<Frame> {
    requests += 1;
    const requestId = `smoke-rq-${requests}`;
    this.send({ kind: "room-op", requestId, ...(gameId !== undefined ? { gameId } : {}), op: body });
    return this.waitFor((frame) => frame.kind === "room-ack" && frame.requestId === requestId, `the ack of ${String(body.type)}`);
  }

  /** The log subscription (`baseIndex` -1: a fresh page; otherwise the anchor a dropped socket resumes from). */
  hello(gameId: string, baseIndex = -1, baseId?: string): void {
    this.send({ kind: "hello", gameId, build: BUILD, baseIndex, ...(baseId !== undefined ? { baseId } : {}) });
  }

  /** The room view, chat and presence. */
  roomHello(gameId: string): void {
    this.send({ kind: "room-hello", gameId, build: BUILD });
  }

  carry(entries: readonly Entry[]): void {
    for (const entry of entries) this.carried.set(entry.index, entry);
  }

  /** Every entry this tab holds, in index order. */
  entries(): Entry[] {
    const all = new Map(this.carried);
    for (const frame of this.frames) for (const entry of entriesOf(frame)) all.set(entry.index, entry);
    return [...all.values()].sort((a, b) => a.index - b.index);
  }

  tip(): Entry | null {
    const all = this.entries();
    return all.length === 0 ? null : all[all.length - 1];
  }

  /** The board digest this tab last heard (its own answer, a fan-out, or a catch-up). */
  lastDigest(): string | undefined {
    for (let at = this.frames.length - 1; at >= 0; at -= 1) {
      const frame = this.frames[at];
      if ((frame.kind === "applied" || frame.kind === "catch-up") && typeof frame.digest === "string") return frame.digest;
    }
    return undefined;
  }

  /** One gameplay message, built on this tab's tip (index and anchor id) as the client builds it, and the answer
   *  that names its submission (L3-3). The frame never names an actor: the server reads it from the seat. */
  act(msg: object, tag: string): Promise<Frame> {
    const tip = this.tip();
    submissions += 1;
    const submissionId = `${tag}-${submissions}`;
    this.send({
      kind: "submit",
      build: BUILD,
      msg,
      baseIndex: tip === null ? -1 : tip.index,
      ...(tip === null ? {} : { baseId: tip.id }),
      submissionId,
    });
    return this.waitFor((frame) => frame.inReplyTo === submissionId, `the answer to ${tag}`);
  }

  close(): Promise<void> {
    if (this.closed !== null) return Promise.resolve();
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

/** The HTTP status an upgrade is answered with: 101 if it opened (and is closed again at once), the refusal's status
 *  otherwise. For the sockets that MUST be refused. */
function upgradeStatus(url: string, origin: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const timer = setTimeout(() => finish(-1), WAIT_MS);
    const socket = new WebSocket(url, { origin, headers });
    socket.on("unexpected-response", (request, response) => {
      finish(response.statusCode ?? 0);
      response.resume();
      request.destroy();
    });
    socket.on("error", (error) => {
      const status = /Unexpected server response: (\d+)/.exec(error.message);
      finish(status ? Number(status[1]) : 0);
    });
    socket.on("open", () => {
      finish(101);
      socket.close();
    });
  });
}

/* ==================================================================
    A SEAT AT THE TABLE, AND THE MOVES IT MAKES
   ================================================================== */

interface Seat {
  who: string;
  /** A new socket for this principal: the same cookie, or the same dev claim. */
  connect: (label: string) => Promise<WireClient>;
  client: WireClient;
  playerId: string;
}

/** A move the board allows: applied, logged as the sender's SEAT, and heard unasked by the other seat. */
async function legalMove(mover: Seat, watcher: Seat, msg: object, tag: string, what: string): Promise<Entry> {
  const answer = await mover.client.act(msg, tag);
  check(`${what} -- applied`, answer.kind === "applied", answer);
  const own = ownEntry(answer);
  check(`  logged at #${own?.index} as ${mover.who}'s seat (${mover.playerId}) -- the seat, never a frame's claim`, own !== undefined && own.actor === mover.playerId, answer);
  const heard = await watcher.client.waitFor(fanoutOf((own as Entry).id), `${watcher.who} hearing ${tag}`);
  check(
    `  ${watcher.who} is told unasked, with the same entries and the same digest`,
    JSON.stringify(entriesOf(heard)) === JSON.stringify(entriesOf(answer)) && typeof heard.digest === "string" && heard.digest === answer.digest,
    { heard, answer },
  );
  return own as Entry;
}

/** A move the server must refuse -- over the wire, with the sentence a player reads, appending nothing. */
async function refusedMove(mover: Seat, msg: object, tag: string, reason: string | RegExp, what: string, code?: string): Promise<Frame> {
  const answer = await mover.client.act(msg, tag);
  const said = String(answer.reason);
  const matches = typeof reason === "string" ? said === reason : reason.test(said);
  check(
    `${what} -- refused${code ? ` ${code}` : ""}: "${typeof reason === "string" ? reason : said}"`,
    answer.kind === "refused" && matches && (code === undefined || answer.code === code) && entriesOf(answer).length === 0,
    answer,
  );
  return answer;
}

/** What a seat's RoomView says about the table and about the reader -- everything but who is online right now. */
const seatingOf = (view: RoomView) => ({
  gameId: view.gameId,
  code: view.code,
  visibility: view.visibility,
  lifecycle: view.lifecycle,
  status: view.status,
  hostId: view.hostId,
  undoPolicy: view.undoPolicy,
  players: view.players.map((player) => ({ id: player.id, nickname: player.nickname, isReady: player.isReady })),
  you: { role: view.you.role, playerId: view.you.playerId },
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The deal's seat order (`SetupGame.players`): the first is on turn when the auction opens. */
function dealOrder(deal: Entry): { order: string[]; rulesVersion: unknown } {
  const setup = payloadOf(deal).SetupGame as { players?: Array<{ id?: unknown }>; rules_engine_version?: unknown } | undefined;
  return { order: (setup?.players ?? []).map((player) => String(player.id)), rulesVersion: setup?.rules_engine_version };
}

const noPrincipalOnWire = (...clients: WireClient[]) => !clients.some((client) => PRINCIPAL_ON_WIRE.test(JSON.stringify(client.frames)));

/* ==================================================================
    HALF A: PRODUCTION
   ================================================================== */

async function productionHalf(): Promise<void> {
  say("\n==== A. PRODUCTION -- the real entry point, session cookies, no dev_claim ====");
  const dataDir = makeTempDir("production");
  const port = await freePort();
  const settings = { GS_MODE: "production", GS_ALLOWED_ORIGINS: PRODUCTION_ORIGIN, GS_TRUSTED_PROXY_HOPS: "0" };
  const socketUrl = `ws://127.0.0.1:${port}/gs`;

  step("A0", `spawn node dist/server/src/start.js -- GS_MODE=production GS_ALLOWED_ORIGINS=${PRODUCTION_ORIGIN} GS_TRUSTED_PROXY_HOPS=0 PORT=${port} DATA_DIR=${dataDir}`);
  let server = await startServer("production #1", port, dataDir, settings);
  check(`the process answers GET ${HEALTH_PATH} on 127.0.0.1:${port}`, true);
  await until(() => sawLine(server, "PRODUCTION IDENTITY"), "the production banner");
  check("its banner says GS_MODE=production and names the cookie posture", sawLine(server, "GS_MODE=production"), server.output);

  /* ---- 1 and 2: two browsers, two sessions ---- */
  step("A1", `bootstrap cookie A: POST ${SESSION_PATH} from ${PRODUCTION_ORIGIN}`);
  const foreign = await postSession(port, { Origin: FOREIGN_ORIGIN });
  check("a bootstrap from an origin not on the list is refused 403, and sets no cookie", foreign.status === 403 && foreign.setCookie.length === 0, foreign);
  const bootA = await postSession(port, { Origin: PRODUCTION_ORIGIN });
  check("a first visit mints a guest: 201 {ok: true}", bootA.status === 201 && bootA.body?.ok === true, bootA.text);
  const cookieA = sessionCookieOf(bootA, "A");

  step("A2", "bootstrap cookie B: the second browser");
  const bootB = await postSession(port, { Origin: PRODUCTION_ORIGIN });
  check("201 {ok: true}", bootB.status === 201 && bootB.body?.ok === true, bootB.text);
  const cookieB = sessionCookieOf(bootB, "B");
  check("two browsers, two different sessions", cookieA !== cookieB);
  check("and neither answer carries a principal id", !PRINCIPAL_ON_WIRE.test(bootA.text + bootB.text));

  step("A2+", "the production socket gate refuses ?dev_claim=, a missing cookie and a foreign Origin at the upgrade");
  check(
    "a socket on /gs?dev_claim= (no cookie) is refused 401 -- production has no development authenticator",
    (await upgradeStatus(`${socketUrl}?dev_claim=smoke-alice`, PRODUCTION_ORIGIN)) === 401,
  );
  check(
    "a socket on /?dev_claim= is refused 404 -- development's second path does not exist here",
    (await upgradeStatus(`ws://127.0.0.1:${port}/?dev_claim=smoke-alice`, PRODUCTION_ORIGIN)) === 404,
  );
  check("cookie A from a foreign Origin is refused 403", (await upgradeStatus(socketUrl, FOREIGN_ORIGIN, { Cookie: cookieA })) === 403);

  const principal = (cookie: string) => (label: string) => WireClient.open(label, socketUrl, PRODUCTION_ORIGIN, { Cookie: cookie });
  const connectA = principal(cookieA);
  const connectB = principal(cookieB);
  let alice = await connectA("Alice");
  let bob = await connectB("Bob");
  check("cookie A and cookie B each open a socket on /gs from the allowed Origin", alice.isOpen && bob.isOpen);

  /* ---- 3: create ---- */
  step("A3", "A creates a table: room-op create, no stake");
  const staked = await alice.op({ type: "create", visibility: "private", exactPlayers: null, variants: {}, nickname: "Alice", stake: "1000000" });
  check("a create WITH a stake is refused money-games-disabled -- LIVE-2 opens no money games", staked.ok === false && staked.code === "money-games-disabled", staked);
  const created = await alice.op({ type: "create", visibility: "private", exactPlayers: null, variants: {}, nickname: "Alice" });
  check("create (private, no stake) is acked ok", created.ok === true, created);
  const { gameId, code, playerId: alicePid } = created.data as { gameId: string; code: string; playerId: string };
  check(`the game id is server-minted (${gameId})`, GAME_ID_PATTERN.test(gameId));
  check(`the join code is JUNO-XXXX-XXXX (${code})`, /^JUNO-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) && parseJoinCode(code) === code);
  check(`A's seat is server-minted (${alicePid})`, PLAYER_ID_PATTERN.test(alicePid));

  /* ---- 4: join ---- */
  step("A4", `B joins with ${code}, taking a seat`);
  const joined = await bob.op({ type: "join", code, takeSeat: true });
  const joinedData = (joined.data ?? {}) as { gameId?: string; playerId?: string };
  check("join (takeSeat: true) is acked ok, for this game", joined.ok === true && joinedData.gameId === gameId, joined);
  const bobPid = String(joinedData.playerId);
  check(`B's seat is server-minted (${bobPid}), and not A's`, PLAYER_ID_PATTERN.test(bobPid) && bobPid !== alicePid);

  /* ---- 5: both seated ---- */
  step("A5", "both hold seats: room-hello {gameId} -> each socket's own RoomView");
  alice.roomHello(gameId);
  bob.roomHello(gameId);
  const twoSeats = (view: RoomView) => view.players.length === 2;
  const viewA = await alice.view(twoSeats, "a two-seat view");
  const viewB = await bob.view(twoSeats, "a two-seat view");
  check(`A's view: you.role "host", you.playerId ${alicePid}`, viewA.you.role === "host" && viewA.you.playerId === alicePid, viewA.you);
  check(`B's view: you.role "player", you.playerId ${bobPid}`, viewB.you.role === "player" && viewB.you.playerId === bobPid, viewB.you);
  check(
    "both views list the same two seats, the host's first, and name A as host",
    same(viewA.players.map((p) => p.id), [alicePid, bobPid]) && same(viewB.players.map((p) => p.id), [alicePid, bobPid]) && viewA.hostId === alicePid && viewB.hostId === alicePid,
    { a: viewA.players, b: viewB.players },
  );
  check("the table is private and waiting, and its code is shown to both seats", viewA.visibility === "private" && viewB.lifecycle === "waiting" && viewA.code === code && viewB.code === code, viewB);
  check(`the room's undo policy is projected: ${JSON.stringify(viewA.undoPolicy)}`, viewA.undoPolicy?.host_undo === "last-action" && same(viewA.undoPolicy, viewB.undoPolicy), viewA.undoPolicy);

  /* S10-5: the chat frame the old harness tripped over, exercised on purpose: stamped with the seat, never a name. */
  alice.send({ kind: "chat-send", gameId, text: "  good luck  " });
  const heardChat = await bob.waitFor(
    (frame) => frame.kind === "chat" && frame.gameId === gameId && ((frame.messages as RoomChatEntry[]) ?? []).length > 0,
    "A's chat line",
  );
  const line = (heardChat.messages as RoomChatEntry[]).slice(-1)[0];
  check("a chat line reaches the other seat, trimmed and stamped with the sender's seat", line.author === alicePid && line.text === "good luck", line);
  check("and no principal id is on either socket", noPrincipalOnWire(alice, bob));

  /* ---- 6: ready ---- */
  step("A6", "both mark ready");
  const readyA = await alice.op({ type: "set-ready", ready: true }, gameId);
  const readyB = await bob.op({ type: "set-ready", ready: true }, gameId);
  check("set-ready is acked ok for both", readyA.ok === true && readyB.ok === true, { readyA, readyB });
  const startable = await alice.view((view) => view.players.every((p) => p.isReady) && view.you.canStart, "an all-ready view with Start");
  check("A's view: every seat ready, and you.canStart", startable.players.length === 2);
  const bobReady = await bob.view((view) => view.players.every((p) => p.isReady), "an all-ready view");
  check("B's view: every seat ready, and B may not start", bobReady.you.canStart === false);

  /* ---- 7: start ---- */
  step("A7", "A starts: room-op start-game (both logs subscribed first: hello {gameId})");
  alice.hello(gameId);
  bob.hello(gameId);
  const emptyA = await alice.waitFor((frame) => frame.kind === "catch-up", "the hello's catch-up");
  const emptyB = await bob.waitFor((frame) => frame.kind === "catch-up", "the hello's catch-up");
  check("both hellos are answered with an empty catch-up: nothing is dealt yet", entriesOf(emptyA).length === 0 && entriesOf(emptyB).length === 0, { emptyA, emptyB });
  const bobStart = await bob.op({ type: "start-game" }, gameId);
  check("B's start-game is refused forbidden -- starting is the host's", bobStart.ok === false && bobStart.code === "forbidden", bobStart);
  const started = await alice.op({ type: "start-game" }, gameId);
  check("A's start-game is acked ok", started.ok === true, started);

  /* ---- 8: the server deals ---- */
  step("A8", "the server commits SetupGame -- observed on both clients' logs");
  const dealtA = await alice.waitFor((frame) => frame.kind === "applied" && entriesOf(frame).some(isDeal), "the deal");
  const dealtB = await bob.waitFor((frame) => frame.kind === "applied" && entriesOf(frame).some(isDeal), "the deal");
  const deal = entriesOf(dealtA).find(isDeal) as Entry;
  const { order, rulesVersion } = dealOrder(deal);
  check(
    "SetupGame is entry #0, committed as the host's seat, and arrives as news -- in reply to nobody's submit",
    deal.index === 0 && deal.actor === alicePid && dealtA.inReplyTo === undefined && dealtB.inReplyTo === undefined,
    deal,
  );
  check("both clients were handed the same entries and the same digest", same(entriesOf(dealtA), entriesOf(dealtB)) && dealtA.digest === dealtB.digest);
  check(`the deal seats exactly the two server-minted ids (turn order ${order.join(" then ")})`, same([...order].sort(), [alicePid, bobPid].sort()), order);
  check(`and pins a rules-engine version (${String(rulesVersion)})`, typeof rulesVersion === "number");
  await alice.view((view) => view.lifecycle === "active" && view.status === "playing", "the playing view");
  await bob.view((view) => view.lifecycle === "active" && view.status === "playing", "the playing view");
  check("both room views follow: lifecycle active, status playing", true);

  const seats: Record<string, Seat> = {
    [alicePid]: { who: "Alice", connect: connectA, client: alice, playerId: alicePid },
    [bobPid]: { who: "Bob", connect: connectB, client: bob, playerId: bobPid },
  };
  const host = seats[alicePid];
  const guest = seats[bobPid];
  const first = seats[order[0]];
  const second = seats[order[1]];
  await refusedMove(
    guest,
    { SetupGame: { players: [{ id: alicePid, nickname: "Alice" }, { id: bobPid, nickname: "Bob" }], variants: {} } },
    "client-deal",
    /press Start/,
    "a SetupGame sent by a client",
    "bad-frame",
  );

  /* ---- 9: moves, and one out of turn ---- */
  step("A9", `gameplay: ${first.who} is on turn (the deal's first seat); ${second.who} tries first`);
  await refusedMove(second, BUY, "early-buy", NOT_YOUR_TURN, `${second.who}'s WaterfallBuyLowest, out of turn`);
  const firstBuy = await legalMove(first, second, BUY, "first-buy", `${first.who}'s WaterfallBuyLowest`);
  const secondBuy = await legalMove(second, first, BUY, "second-buy", `${second.who}'s WaterfallBuyLowest, now on turn`);

  /* ---- 10: undo ---- */
  step("A10", "undo: the room's undoPolicy, then RevertTo through the same submit path -- two illegal, one legal");
  check(
    `RoomView.undoPolicy is host_undo "last-action": the host may take back the LAST action, whoever made it; a player only their own`,
    viewA.undoPolicy.host_undo === "last-action",
  );
  const revertTo = (index: number, by: Seat) => ({ RevertTo: { index, player: by.playerId, summary: "smoke undo" } });
  const hostsLatest = [firstBuy, secondBuy].filter((entry) => entry.actor === alicePid).slice(-1)[0];
  await refusedMove(host, revertTo(deal.index, host), "undo-deal", REVERT_DEAL_FLOOR, "the HOST's RevertTo aimed at the deal (#0)");
  await refusedMove(guest, revertTo(hostsLatest.index, guest), "undo-not-mine", REVERT_NOT_YOURS, `${guest.who} (not the host) undoing ${host.who}'s move #${hostsLatest.index}`);
  const undone = await legalMove(
    host,
    guest,
    revertTo(secondBuy.index, host),
    "undo-last",
    `${host.who}'s RevertTo of the last action (${second.who}'s buy, #${secondBuy.index})`,
  );
  const undoBody = payloadOf(undone).RevertTo as { index?: unknown; player?: unknown } | undefined;
  check("  the revert names its target and the seat that pressed it", undoBody?.index === secondBuy.index && undoBody?.player === host.playerId, undoBody);
  const rebuy = await legalMove(second, first, BUY, "rebuy", `${second.who}, on turn again after the undo, buys again`);
  check("  the replacement is new history, not the undone entry revived", rebuy.index > undone.index && rebuy.id !== secondBuy.id);

  /* ---- 11: disconnect and reconnect ---- */
  step("A11", "disconnect / reconnect: a new socket on the same cookie, hello + room-hello sent back to back");
  const aliceLog = alice.entries();
  const aliceSeating = seatingOf(await alice.view());
  await alice.close();
  alice = await connectA("Alice (reconnected)");
  host.client = alice;
  /* #1216: the pair goes out the instant the socket opens, exactly as the browser sends it -- a harness that waits
     where the product does not is a harness that proves the wrong thing. */
  alice.hello(gameId);
  alice.roomHello(gameId);
  const reloaded = await alice.waitFor((frame) => frame.kind === "catch-up", "the reconnect's catch-up");
  check(`A (a fresh page, baseIndex -1) is handed the whole log again: ${logSummary(aliceLog)}`, sameLog(entriesOf(reloaded), aliceLog), entriesOf(reloaded).length);
  const aliceBack = seatingOf(await alice.view());
  check(`and the same seat: role ${aliceBack.you.role}, playerId ${String(aliceBack.you.playerId)}`, same(aliceBack, aliceSeating), { before: aliceSeating, after: aliceBack });

  const bobLog = bob.entries();
  const bobTip = bob.tip() as Entry;
  const bobDigest = bob.lastDigest();
  const bobSeating = seatingOf(await bob.view());
  await bob.close();
  bob = await connectB("Bob (reconnected)");
  guest.client = bob;
  bob.carry(bobLog);
  bob.hello(gameId, bobTip.index, bobTip.id);
  bob.roomHello(gameId);
  const resumed = await bob.waitFor((frame) => frame.kind === "catch-up", "the resume's catch-up");
  check(
    `B (a dropped socket, resuming from its own tip #${bobTip.index} by index and anchor id) is owed nothing, and agrees on the digest`,
    entriesOf(resumed).length === 0 && typeof bobDigest === "string" && resumed.digest === bobDigest,
    { resumed, bobDigest },
  );
  const bobBack = seatingOf(await bob.view());
  check(`and the same seat: role ${bobBack.you.role}, playerId ${String(bobBack.you.playerId)}`, same(bobBack, bobSeating), { before: bobSeating, after: bobBack });
  await legalMove(first, second, BUY, "after-reconnect", `${first.who} moves on the reconnected socket`);

  /* ---- 12: the process dies; the game does not ---- */
  step("A12", "resume from the durable log: SIGKILL the server, start it again on the same data directory");
  const storedLog = alice.entries();
  check(`both clients hold the same log before the kill (${logSummary(storedLog)})`, sameLog(storedLog, bob.entries()));
  const storedDigest = alice.lastDigest();
  const storedA = seatingOf(await alice.view());
  const storedB = seatingOf(await bob.view());
  const killed = await stopServer(server, "SIGKILL");
  check("the server died by SIGKILL -- no shutdown hook ran, no flush, no lock release", killed.signal === "SIGKILL", killed);
  await until(() => alice.closed !== null && bob.closed !== null, "both sockets to see the server go");
  check("both sockets saw it go", true);
  const lockDir = path.join(dataDir, LOCK_DIRECTORY);
  check("its data-directory lock is still there, as a crash leaves it", fs.existsSync(lockDir));
  /* LIVE-3B: a dead server's lock is honoured until its heartbeat is LOCK_STALE_AFTER_MS old, and then taken over.
     Rather than sit out that wait, the smoke ages the dead lock's signs of life exactly as the wait would have --
     the restart below still has to judge it stale, take it over, and say so. */
  const aged = new Date(Date.now() - 2 * LOCK_STALE_AFTER_MS);
  for (const name of fs.readdirSync(lockDir)) fs.utimesSync(path.join(lockDir, name), aged, aged);
  fs.utimesSync(lockDir, aged, aged);
  server = await startServer("production #2", port, dataDir, settings);
  await until(() => sawLine(server, "took over a stale data-directory lock"), "the lock takeover line");
  check(`the restart took over the dead server's lock (aged past its ${LOCK_STALE_AFTER_MS / 1000} s heartbeat window)`, true);

  const againA = await postSession(port, { Origin: PRODUCTION_ORIGIN, Cookie: cookieA });
  const againB = await postSession(port, { Origin: PRODUCTION_ORIGIN, Cookie: cookieB });
  check(
    "both cookies still name their sessions after the crash: 200, no new cookie (activated guests are durable)",
    againA.status === 200 && againA.setCookie.length === 0 && againB.status === 200 && againB.setCookie.length === 0,
    { a: againA.status, b: againB.status },
  );
  alice = await connectA("Alice (after restart)");
  bob = await connectB("Bob (after restart)");
  host.client = alice;
  guest.client = bob;
  for (const client of [alice, bob]) {
    client.hello(gameId);
    client.roomHello(gameId);
  }
  const restoredA = await alice.waitFor((frame) => frame.kind === "catch-up", "the restored catch-up");
  const restoredB = await bob.waitFor((frame) => frame.kind === "catch-up", "the restored catch-up");
  await until(() => sawLine(server, `restored ${gameId}: ${storedLog.length} entries`), "the server's restore line");
  check(`the server restored the game from its store (${storedLog.length} entries)`, true);
  check(`A's log after the restart is the stored one: ${logSummary(entriesOf(restoredA))}`, sameLog(entriesOf(restoredA), storedLog));
  check("and so is B's", sameLog(entriesOf(restoredB), storedLog));
  check("the replayed board's digest is the one both clients last held", restoredA.digest === storedDigest && restoredB.digest === storedDigest, {
    before: storedDigest,
    a: restoredA.digest,
    b: restoredB.digest,
  });
  const afterA = seatingOf(await alice.view());
  const afterB = seatingOf(await bob.view());
  check("A's RoomView after the restart: the same seats, the same host, the same you", same(afterA, storedA), { before: storedA, after: afterA });
  check("B's too", same(afterB, storedB), { before: storedB, after: afterB });
  const further = await legalMove(second, first, BUY, "after-restart", `${second.who}, on turn, moves on the restarted server`);
  check(
    `  it extends the stored log (#${further.index}), with an id the stored log does not hold`,
    further.index > storedLog[storedLog.length - 1].index && !storedLog.some((entry) => entry.id === further.id),
    further,
  );

  /* ---- 13: cleanup ---- */
  step("A13", "cleanup: close the sockets, stop the server, remove the data directory");
  await Promise.all([alice.close(), bob.close()]);
  const stopped = await stopServer(server, "SIGTERM");
  check("SIGTERM stops the server cleanly (exit 0)", stopped.code === 0, stopped);
  check("and it released the data-directory lock", !fs.existsSync(lockDir));
  removeTempDir(dataDir);
  check("the temp data directory is gone", !fs.existsSync(dataDir));
}

/* ==================================================================
    HALF B: DEVELOPMENT -- TWO TABS, TWO PRINCIPALS
   ================================================================== */

async function developmentHalf(): Promise<void> {
  say("\n==== B. DEVELOPMENT -- two ?dev_claim= tabs, two principals ====");
  const dataDir = makeTempDir("development");
  const port = await freePort();
  const tabUrl = (claim: string) => `ws://127.0.0.1:${port}/gs?dev_claim=${encodeURIComponent(claim)}`;

  step("B0", `spawn node dist/server/src/start.js -- GS_MODE=development PORT=${port} DATA_DIR=${dataDir}`);
  const server = await startServer("development", port, dataDir, { GS_MODE: "development" });
  await until(() => sawLine(server, "DEVELOPMENT IDENTITY"), "the development banner");
  check("the development server is up, and its banner says the identity is ?dev_claim=, loopback only", sawLine(server, "GS_MODE=development"));
  check("a socket with no dev_claim is refused 401", (await upgradeStatus(`ws://127.0.0.1:${port}/gs`, DEVELOPMENT_ORIGIN)) === 401);
  check("a dev_claim from a non-loopback Origin is refused 403", (await upgradeStatus(tabUrl("smoke-host"), PRODUCTION_ORIGIN)) === 403);
  check(
    "a dev_claim that came through a forwarding header is refused 403 -- never behind a tunnel",
    (await upgradeStatus(tabUrl("smoke-host"), DEVELOPMENT_ORIGIN, { "X-Forwarded-For": "203.0.113.9" })) === 403,
  );

  const tab = (claim: string) => (label: string) => WireClient.open(label, tabUrl(claim), DEVELOPMENT_ORIGIN);
  const connectHost = tab("smoke-host");
  const connectGuest = tab("smoke-guest");

  step("B1", "tab 1 (dev_claim=smoke-host) creates a public table");
  let hostTab = await connectHost("tab 1");
  const created = await hostTab.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "Hosty" });
  check("create is acked ok", created.ok === true, created);
  const { gameId, code, playerId: hostPid } = created.data as { gameId: string; code: string; playerId: string };
  check(`game ${gameId}, code ${code}, host seat ${hostPid}`, GAME_ID_PATTERN.test(gameId) && parseJoinCode(code) === code && PLAYER_ID_PATTERN.test(hostPid));

  step("B2", "tab 2 (dev_claim=smoke-guest) joins by code, taking a seat");
  let guestTab = await connectGuest("tab 2");
  const joined = await guestTab.op({ type: "join", code, takeSeat: true });
  const guestPid = String((joined.data as { playerId?: string } | undefined)?.playerId);
  check(`join is acked ok: seat ${guestPid}`, joined.ok === true && PLAYER_ID_PATTERN.test(guestPid), joined);

  step("B3", "two claims are two principals: two seats, two roles");
  hostTab.roomHello(gameId);
  guestTab.roomHello(gameId);
  const hostView = await hostTab.view((view) => view.players.length === 2, "a two-seat view");
  const guestView = await guestTab.view((view) => view.players.length === 2, "a two-seat view");
  check("tab 1: host, its own seat", hostView.you.role === "host" && hostView.you.playerId === hostPid, hostView.you);
  check("tab 2: player, its own seat", guestView.you.role === "player" && guestView.you.playerId === guestPid, guestView.you);
  check("two distinct server-minted seats", hostPid !== guestPid && same(hostView.players.map((p) => p.id), [hostPid, guestPid]));
  check("no principal id (pr_dev_…) on either socket", noPrincipalOnWire(hostTab, guestTab));

  step("B4", "tab 2 reloads in the waiting room: a brand-new socket, the same dev_claim");
  await guestTab.close();
  guestTab = await connectGuest("tab 2 (reloaded)");
  guestTab.roomHello(gameId);
  const guestAgain = await guestTab.view((view) => view.players.length === 2, "the reloaded view");
  check(`same seat after the reload: role ${guestAgain.you.role}, playerId ${String(guestAgain.you.playerId)}`, same(seatingOf(guestAgain), seatingOf(guestView)), {
    before: seatingOf(guestView),
    after: seatingOf(guestAgain),
  });

  step("B5", "both ready; tab 1 starts; the server deals");
  const readyHost = await hostTab.op({ type: "set-ready", ready: true }, gameId);
  const readyGuest = await guestTab.op({ type: "set-ready", ready: true }, gameId);
  check("set-ready is acked ok on both tabs (tab 2 from its reloaded socket)", readyHost.ok === true && readyGuest.ok === true, { readyHost, readyGuest });
  await hostTab.view((view) => view.you.canStart && view.players.every((p) => p.isReady), "Start");
  hostTab.hello(gameId);
  guestTab.hello(gameId);
  await hostTab.waitFor((frame) => frame.kind === "catch-up", "the hello's catch-up");
  await guestTab.waitFor((frame) => frame.kind === "catch-up", "the hello's catch-up");
  const started = await hostTab.op({ type: "start-game" }, gameId);
  check("start-game is acked ok", started.ok === true, started);
  const dealtHost = await hostTab.waitFor((frame) => frame.kind === "applied" && entriesOf(frame).some(isDeal), "the deal");
  const dealtGuest = await guestTab.waitFor((frame) => frame.kind === "applied" && entriesOf(frame).some(isDeal), "the deal");
  const deal = entriesOf(dealtHost).find(isDeal) as Entry;
  const { order } = dealOrder(deal);
  check(
    `the server's SetupGame reaches both tabs (#${deal.index}, turn order ${order.join(" then ")})`,
    deal.index === 0 && deal.actor === hostPid && same(entriesOf(dealtHost), entriesOf(dealtGuest)) && same([...order].sort(), [hostPid, guestPid].sort()),
    deal,
  );

  const seats: Record<string, Seat> = {
    [hostPid]: { who: "tab 1", connect: connectHost, client: hostTab, playerId: hostPid },
    [guestPid]: { who: "tab 2", connect: connectGuest, client: guestTab, playerId: guestPid },
  };
  const first = seats[order[0]];
  const second = seats[order[1]];

  step("B6", "each tab acts when -- and only when -- the board says it may");
  await refusedMove(second, BUY, "dev-early", NOT_YOUR_TURN, `${second.who}, out of turn`);
  await legalMove(first, second, BUY, "dev-buy-1", `${first.who}, on turn`);
  await refusedMove(first, BUY, "dev-twice", NOT_YOUR_TURN, `${first.who} again, now out of turn`);
  await legalMove(second, first, BUY, "dev-buy-2", `${second.who}, on turn`);
  await legalMove(first, second, BUY, "dev-buy-3", `${first.who}, on turn`);

  step("B7", "both tabs reload mid-game: brand-new sockets, the same claims -- the same seats, the same log");
  for (const seat of [first, second]) {
    const log = seat.client.entries();
    const seating = seatingOf(await seat.client.view());
    await seat.client.close();
    seat.client = await seat.connect(`${seat.who} (reloaded)`);
    seat.client.hello(gameId);
    seat.client.roomHello(gameId);
    const caught = await seat.client.waitFor((frame) => frame.kind === "catch-up", "the reload's catch-up");
    const back = seatingOf(await seat.client.view());
    check(
      `${seat.who}: same seat (role ${back.you.role}, playerId ${String(back.you.playerId)}) and same log (${logSummary(entriesOf(caught))})`,
      same(back, seating) && back.you.playerId === seat.playerId && sameLog(entriesOf(caught), log),
      { before: seating, after: back },
    );
  }
  await refusedMove(first, BUY, "dev-reload-early", NOT_YOUR_TURN, `${first.who}'s reloaded socket, out of turn`);
  await legalMove(second, first, BUY, "dev-reload-buy", `${second.who}'s reloaded socket, on turn`);
  check("no principal id on any reloaded socket", noPrincipalOnWire(first.client, second.client));

  step("B8", "cleanup: close the tabs, stop the server, remove the data directory");
  await Promise.all([first.client.close(), second.client.close()]);
  const stopped = await stopServer(server, "SIGTERM");
  check("SIGTERM stops the server cleanly (exit 0)", stopped.code === 0, stopped);
  removeTempDir(dataDir);
  check("the temp data directory is gone", !fs.existsSync(dataDir));
}

/* ==================================================================
    THE RUN: BOTH HALVES, ONE DEADLINE, AND NOTHING LEFT BEHIND
   ================================================================== */

/** Whatever a failure or the deadline left running: sockets terminated, servers killed, temp directories removed. */
async function cleanup(): Promise<void> {
  for (const client of [...openClients]) client.socket.terminate();
  await Promise.all(servers.filter((server) => server.exited === null).map((server) => stopServer(server, "SIGKILL")));
  for (const directory of [...tempDirs]) {
    try {
      removeTempDir(directory);
    } catch {
      /* reported below by its absence from nothing; a temp directory is not worth a second failure */
    }
  }
}

/* A last guard: a child this process started never outlives it, whatever ends it. */
process.on("exit", () => {
  for (const server of servers) if (server.exited === null) server.child.kill("SIGKILL");
});

async function main(): Promise<void> {
  say(`LIVE-2D smoke: ${START_JS}`);
  let failure: unknown = null;
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await productionHalf();
        await developmentHalf();
      })(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new SmokeFailure(`the smoke did not finish within ${OVERALL_TIMEOUT_MS / 1000} s`)), OVERALL_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    failure = error;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
  await cleanup();
  if (failure !== null) {
    for (const server of servers) {
      // eslint-disable-next-line no-console
      console.error(`\n---- the last lines of ${server.label}'s window ----\n${server.output.slice(-30).join("\n")}`);
    }
    if (!(failure instanceof SmokeFailure) && failure instanceof Error && failure.stack) {
      // eslint-disable-next-line no-console
      console.error(`\n${failure.stack}`);
    }
    // eslint-disable-next-line no-console
    console.error(`\nSMOKE FAILED: ${failure instanceof Error ? failure.message : String(failure)}`);
    process.exit(1);
  }
  say("\nSMOKE PASSED");
  process.exit(0);
}

void main();
