// server/src/rooms/live2cRooms.test.ts
//
// LIVE-2C: the server-owned GameRecord and everything that reads it -- the identifiers, the record and its stores
// (memory and the interim file adapter), the pure authorization table (every op x role x stage), the named room ops,
// the server-built deal, the submit seat gate, the undo policy, read gating and per-push re-authorization, the
// resource bounds, the §14.3 races, the production fail-closed invariant, and the ordinary local flow
// host -> join -> ready -> start -> move -> undo -> close. Real server, real WebSockets, development authenticator
// (`?dev_claim=`) except where a case needs cookie principals and a real activation.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { WebSocket } from "ws";

import { createGameServer, LEGACY_ROOM_HANDLERS, type GameServerOptions } from "../gameServer";
import { nodeStoreFs } from "../fileLogStore";
import { IdentityService } from "../identity/sessions";
import { createMemoryIdentityStore } from "../identity/store";
import type { RoomLimits } from "../ingress/limits";
import { stateDigest } from "../../../frontend/src/gameEngine";
import { CURRENT_RULES_REVISION, resolveVariants } from "../../../frontend/src/gameEngine/gameVariants";
import {
  NO_MONEY_UNDO_POLICY,
  REVERT_DEAL_FLOOR,
  REVERT_GAME_ENDED,
  REVERT_NOTHING_DEALT,
  REVERT_NOT_YOURS,
  REVERT_NO_TARGET,
  REVERT_ONE_STEP,
  revertRefusal,
  undoReachFor,
  type RevertableAction,
  type UndoPolicy,
} from "../../../frontend/src/gameEngine/logRevert";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { parseClientFrame } from "../../../frontend/src/gameEngine/messageSchema";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { BUILD, BUY, Client, controlledStore, devIdentity, probeSession, quietConsole, sleep, startServer, stopServer, until, type Frame } from "./testSupport";
import {
  GAME_ID_PATTERN,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_PATTERN,
  NO_FACTS,
  PLAYER_ID_PATTERN,
  WAITING_TTL_MS,
  isGameRecord,
  mintGameId,
  mintJoinCode,
  mintPlayerId,
  parseJoinCode,
  roomSummaryOf,
  roomViewFor,
  type GameRecord,
  type LogFacts,
} from "./gameRecord";
import { createFileRecordStore, createMemoryRecordStore, type MemoryRecordStore } from "./recordStore";
import { AUTHZ_TABLE, authorize, type Role, type RoomOp, type Stage } from "./roomAuthz";
import { buildSetupGame, createRecord, cryptoShuffle, setProfile, setReady, takeSeat, type OpEnv } from "./roomService";
import { SEAT_COLORS } from "../../../frontend/src/utils/playerLabels";
import { sanitizeName } from "../../../frontend/src/gameEngine/messageSchema";

quietConsole();

/* ==================================================================
    FIXTURES
   ================================================================== */

const T0 = 1_750_000_000_000;
const PROD_ORIGIN = "https://play.example";
const P = { host: "pr_hosthosthosthosthosthost01", seat: "pr_seatseatseatseatseatseat01", member: "pr_membermembermembermember1", viewer: "pr_viewerviewerviewerviewer1", kicked: "pr_kickedkickedkickedkicked1" };

/** A record with a host (P.host), one more seat (P.seat), a kicked principal, and -- private -- an admitted member. */
function baseRecord(visibility: "public" | "private", over: Partial<GameRecord> = {}): GameRecord {
  const made = createRecord({
    gameId: mintGameId(),
    joinCode: mintJoinCode(),
    principalId: P.host,
    now: T0,
    visibility,
    exactPlayers: null,
    variants: resolveVariants({}),
    nickname: "Hana",
    color: null,
    hostPlayerId: mintPlayerId(),
  });
  assert.ok(made.ok && made.record !== null);
  const record = made.record as GameRecord;
  record.seats.push({ player_id: mintPlayerId(), principal_id: P.seat, binding_epoch: 0, joined_at: T0 + 1, bound_at: T0 + 1, ready: false, nickname: "Sam", color: null, payout_address: null, chain_seat_index: null });
  if (visibility === "private") {
    record.admitted.push({ principal_id: P.seat, admitted_at: T0 + 1, via: "join-code" }, { principal_id: P.member, admitted_at: T0 + 2, via: "join-code" });
  }
  record.kicked_principals.push(P.kicked);
  return { ...record, ...over };
}

const DEALT: LogFacts = { dealt: true, dealAt: T0 + 10, turnOrder: null, rulesEngineVersion: RULES_ENGINE_VERSION, ended: false, closed: false };
const ENDED: LogFacts = { ...DEALT, ended: true };

const envFor = (record: GameRecord, principalId: string, facts: LogFacts = NO_FACTS): OpEnv => ({ record, facts, principalId, now: T0 + 100, held: false, mintPlayerId: () => mintPlayerId() });

/* ---- the wire ---- */

/** Wide room limits for suites that are not about them (every test socket is 127.0.0.1). */
const ROOMY_ROOMS: Partial<RoomLimits> = {
  createsPerPrincipal: { capacity: 1_000, refillPerSecond: 1_000 },
  createsPerIp: { capacity: 1_000, refillPerSecond: 1_000 },
  createsGlobal: { capacity: 1_000, refillPerSecond: 1_000 },
  membershipOpsPerPrincipal: { capacity: 1_000, refillPerSecond: 1_000 },
  joinFailuresPerIp: { capacity: 1_000, refillPerSecond: 1_000 },
  submitsPerSeat: { capacity: 1_000, refillPerSecond: 1_000 },
  submitsPerGame: { capacity: 1_000, refillPerSecond: 1_000 },
};
/** The deal in seat order (host first): turn order is then the join order. */
const IN_SEAT_ORDER = <T>(items: readonly T[]): T[] => [...items];

/** The per-socket buckets LIVE-2A tests on its own; opened wide here so a scenario's op count cannot trip them. */
const WIDE = { capacity: 1_000, refillPerSecond: 1_000 };

async function serve(over: Partial<GameServerOptions> & { rooms?: Partial<RoomLimits> } = {}) {
  const { rooms, ...rest } = over;
  return startServer({
    shuffle: IN_SEAT_ORDER,
    ...rest,
    limits: {
      ...(rest.limits ?? {}),
      buckets: { hello: WIDE, control: WIDE, roomOps: WIDE, ...(rest.limits?.buckets ?? {}) },
      rooms: { ...ROOMY_ROOMS, ...(rooms ?? {}) },
    },
  });
}

let requests = 0;
function sendOp(client: Client, body: Record<string, unknown>, gameId?: string): string {
  requests += 1;
  const requestId = `rq-${requests}`;
  client.send({ kind: "room-op", requestId, ...(gameId !== undefined ? { gameId } : {}), op: body });
  return requestId;
}

async function frameWhere(client: Client, predicate: (frame: Frame) => boolean, label: string, timeoutMs = 4000): Promise<Frame> {
  await until(() => client.frames.some(predicate), `${label} (${client.claim} saw ${client.frames.map((f) => `${f.kind}${f.code ? `:${String(f.code)}` : ""}`).join(",")})`, timeoutMs);
  return client.frames.find(predicate) as Frame;
}

const ackOf = (client: Client, requestId: string) => frameWhere(client, (f) => f.kind === "room-ack" && f.requestId === requestId, `the ack ${requestId}`);
const op = async (client: Client, body: Record<string, unknown>, gameId?: string) => ackOf(client, sendOp(client, body, gameId));
const dataOf = (ack: Frame) => (ack.data ?? {}) as Record<string, unknown>;

interface WireView {
  gameId: string;
  code: string | null;
  lifecycle: string;
  status: string;
  hostId: string;
  players: Array<{ id: string; nickname: string; isReady: boolean; online: boolean }>;
  you: { role: string; playerId: string | null; kicked: boolean; canStart: boolean };
}

function viewOf(client: Client, gameId: string): WireView | undefined {
  for (let at = client.frames.length - 1; at >= 0; at -= 1) {
    const frame = client.frames[at];
    if (frame.kind === "room" && frame.gameId === gameId) return frame.view as WireView;
  }
  return undefined;
}

const CREATE = (over: Record<string, unknown> = {}) => ({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "Hana", ...over });

interface Table {
  host: Client;
  hostPlayerId: string;
  gameId: string;
  code: string;
  guests: Array<{ client: Client; playerId: string }>;
}

let tables = 0;
async function openTable(port: number, seats: number, over: { visibility?: "public" | "private"; exactPlayers?: number | null } = {}): Promise<Table> {
  tables += 1;
  const prefix = `t${tables}`;
  const host = await Client.open(port, `${prefix}-host`);
  const created = await op(host, CREATE({ visibility: over.visibility ?? "public", exactPlayers: over.exactPlayers ?? null }));
  assert.equal(created.ok, true, JSON.stringify(created));
  const { gameId, code, playerId } = dataOf(created) as { gameId: string; code: string; playerId: string };
  const guests: Table["guests"] = [];
  for (let n = 1; n < seats; n += 1) {
    const client = await Client.open(port, `${prefix}-guest${n}`);
    const joined = await op(client, { type: "join", code, takeSeat: true });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    guests.push({ client, playerId: dataOf(joined).playerId as string });
  }
  return { host, hostPlayerId: playerId, gameId, code, guests };
}

const everyone = (table: Table) => [table.host, ...table.guests.map((guest) => guest.client)];

async function readyAll(table: Table): Promise<void> {
  for (const who of everyone(table)) {
    const ready = await op(who, { type: "set-ready", ready: true }, table.gameId);
    assert.equal(ready.ok, true, JSON.stringify(ready));
  }
}

function logHello(client: Client, gameId: string, baseIndex = -1): void {
  client.send({ kind: "hello", gameId, build: BUILD, baseIndex });
}

const lastIndexSeen = (client: Client): number => client.seen().reduce((max, entry) => Math.max(max, entry.index), -1);

/** Every entry of the committed log whose payload is a deal. */
const dealsIn = (log: readonly ServerLogEntry[]) => log.filter((entry) => !entry.derived && "SetupGame" in (JSON.parse(entry.payload) as object));

/** A started table: everyone seated and ready, the deal made by the server, every seat subscribed to the log. */
async function startedTable(port: number, seats: number, over: { visibility?: "public" | "private" } = {}) {
  const table = await openTable(port, seats, over);
  await readyAll(table);
  const started = await op(table.host, { type: "start-game" }, table.gameId);
  assert.equal(started.ok, true, JSON.stringify(started));
  for (const who of everyone(table)) logHello(who, table.gameId);
  for (const who of everyone(table)) await until(() => who.seen().length > 0, `${who.claim}'s catch-up`);
  return table;
}

/** Submit and wait for the direct answer. */
async function play(client: Client, msg: object, submissionId: string): Promise<Frame> {
  client.submit(msg, { baseIndex: lastIndexSeen(client), submissionId });
  return client.answerTo(submissionId);
}

/** No frame any client received names a principal id (LIVE-2 §3.1: private, never projected). */
function assertNoPrincipalIds(clients: readonly Client[]): void {
  for (const client of clients) {
    const text = JSON.stringify(client.frames);
    assert.equal(/pr_[0-9a-z_]/i.test(text), false, `${client.claim} received a principal id: ${text.match(/.{0,40}pr_[0-9a-z_]{4}.{0,20}/i)?.[0]}`);
  }
}

/* ==================================================================
    GAME RECORD: identifiers, shape, stores
   ================================================================== */

describe("LIVE-2C game record", () => {
  test("identifiers: g_ + 128 random bits, p- + 80, JUNO-XXXX-XXXX from crypto; forgiving join-code input", () => {
    const games = new Set<string>();
    const players = new Set<string>();
    const codes = new Set<string>();
    for (let n = 0; n < 2_000; n += 1) {
      const gameId = mintGameId();
      const playerId = mintPlayerId();
      const code = mintJoinCode();
      assert.match(gameId, GAME_ID_PATTERN);
      assert.match(playerId, PLAYER_ID_PATTERN);
      assert.match(code, JOIN_CODE_PATTERN);
      games.add(gameId);
      players.add(playerId);
      codes.add(code);
    }
    assert.equal(games.size, 2_000);
    assert.equal(players.size, 2_000);
    assert.equal(codes.size, 2_000);
    assert.equal(mintGameId().length, 2 + 26, "26 base32 symbols carry 128 bits");
    assert.equal(mintPlayerId().length, 2 + 16, "16 base32 symbols carry 80 bits");
    assert.equal(JOIN_CODE_ALPHABET.length, 29);
    for (const confusable of "015ILOS") assert.equal(JOIN_CODE_ALPHABET.includes(confusable), false, confusable);
    // The injected byte source is what mints: an all-zero source mints the all-zero id.
    assert.equal(mintGameId((size) => Buffer.alloc(size)), `g_${"0".repeat(26)}`);
    const code = mintJoinCode(() => 0);
    assert.equal(code, "JUNO-AAAA-AAAA");
    // Forgiving on input: case, spaces, hyphens, the prefix optional.
    for (const typed of ["juno-aaaa-aaaa", "JUNO AAAA AAAA", "aaaaaaaa", "  Aaaa-aaaa ", "JUNOAAAAAAAA"]) assert.equal(parseJoinCode(typed), code, typed);
    for (const bad of ["ABC", "JUNO-ABC", "JUNO-AAAA-AAA0", "JUNO-AAAA-AAAAA", "", 42, null, "x".repeat(33)]) assert.equal(parseJoinCode(bad), null, String(bad));
  });

  test("the record is exactly the frozen fields: a create is waiting 24 h, no money, seams empty; anything else is not a record", () => {
    const record = baseRecord("private");
    assert.ok(isGameRecord(record));
    assert.equal(record.record_version, 1);
    assert.equal(record.status, "waiting");
    assert.equal(record.expires_at, T0 + WAITING_TTL_MS);
    assert.equal(record.money, null);
    assert.equal(record.protocol_version, null);
    assert.deepEqual(record.policy, { host_undo: "last-action", private_spectators: false, spectator_chat: false, max_viewers: 50 });
    assert.equal(record.host_player_id, record.seats[0].player_id);
    for (const seat of record.seats) {
      assert.equal(seat.payout_address, null);
      assert.equal(seat.chain_seat_index, null);
      assert.equal(seat.binding_epoch, 0);
    }
    assert.deepEqual(record.admitted[0], { principal_id: P.host, admitted_at: T0, via: "creator" });
    for (const broken of [
      { ...record, extra: 1 },
      { ...record, money: { ante: "1" } },
      { ...record, record_version: 0 },
      { ...record, game_id: "JUNO-ABC" },
      { ...record, policy: { ...record.policy, host_undo: "anyone" } },
      { ...record, seats: [{ ...record.seats[0], payout_address: "juno1abc" }] },
      { ...record, seats: [{ ...record.seats[0], owner: P.host }] },
    ]) {
      assert.equal(isGameRecord(broken), false, JSON.stringify(broken).slice(0, 80));
    }
    const { status: _status, ...missing } = record;
    assert.equal(isGameRecord(missing), false);
  });

  test("cosmetic writes cannot move authority: a profile is a nickname and a colour, and a nickname grants nothing", () => {
    const record = baseRecord("public");
    const seat = record.seats[1];
    const host = record.seats[0];
    const renamed = setProfile(envFor(record, P.seat), { nickname: host.nickname, color: SEAT_COLORS[0] });
    assert.ok(renamed.ok && renamed.record !== null);
    const next = renamed.record as GameRecord;
    assert.equal(next.record_version, record.record_version + 1);
    assert.equal(next.host_player_id, record.host_player_id, "a nickname equal to the host's makes nobody host");
    assert.deepEqual(
      next.seats.map((entry) => [entry.player_id, entry.principal_id, entry.ready]),
      record.seats.map((entry) => [entry.player_id, entry.principal_id, entry.ready]),
    );
    assert.equal(next.seats[1].nickname, host.nickname);
    // Sanitised, bounded, and never empty.
    const odd = setProfile(envFor(record, P.seat), { nickname: `  ${"é".repeat(40)}\u0000 ` });
    assert.ok(odd.ok && odd.record !== null);
    assert.ok((odd.record as GameRecord).seats[1].nickname.length <= 24);
    assert.equal(setProfile(envFor(record, P.seat), { nickname: "   " }).ok, false);
    // First colour wins; an unknown colour is refused.
    const red = (renamed.record as GameRecord);
    const clash = setProfile(envFor(red, P.host), { color: SEAT_COLORS[0] });
    assert.equal(clash.ok, false);
    assert.equal((clash as { code: string }).code, "color-taken");
    assert.equal(setProfile(envFor(record, P.seat), { color: "ultraviolet" }).ok, false);
    // Readiness is the seat's own, and a viewer has no seat to change.
    assert.equal(setReady(envFor(record, P.viewer), true).ok, false);
    const ready = setReady(envFor(record, P.seat), true);
    assert.ok(ready.ok && ready.record !== null);
    assert.deepEqual((ready.record as GameRecord).seats.map((entry) => entry.ready), [false, true]);
    assert.equal(seat.ready, false, "the committed record is never mutated in place");
  });

  test("record_version is optimistic concurrency: the store takes exactly the next version or nothing", async () => {
    const store = createMemoryRecordStore();
    const record = baseRecord("public");
    assert.equal((await store.put(record, null)).kind, "committed");
    assert.equal((await store.put(record, null)).kind, "definite", "a create over an existing game");
    const v2 = { ...record, record_version: 2 };
    assert.equal((await store.put({ ...record, record_version: 3 }, 1)).kind, "definite", "a skipped version");
    assert.equal((await store.put(v2, 2)).kind, "definite", "the wrong expectation");
    assert.equal((await store.put(v2, 1)).kind, "committed");
    assert.equal((await store.put(v2, 1)).kind, "definite", "a stale writer");
    assert.equal((await store.put({ ...v2, record_version: 3, money: 5 } as never, 2)).kind, "definite", "not a record");
    assert.equal((await store.load(record.game_id))?.record_version, 2);
  });

  test("the file adapter: durable, versioned across a restart, a checked join index, surfaced failures, and a damaged record refuses to load", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live2c-records-"));
    const quiet = { warn: () => undefined };
    try {
      const first = createFileRecordStore(dir, quiet);
      const record = baseRecord("private");
      const code = record.join_code as string;
      assert.equal(await first.claimCode(code, record.game_id), "claimed");
      assert.equal(await first.claimCode(code, record.game_id), "claimed", "idempotent for the holder");
      assert.equal(await first.claimCode(code, mintGameId()), "taken", "unique: another game cannot take it");
      assert.equal((await first.put(record, null)).kind, "committed");

      const second = createFileRecordStore(dir, quiet); // a restart
      assert.deepEqual(await second.list(), [record.game_id]);
      assert.deepEqual(await second.load(record.game_id), record);
      assert.equal(await second.lookupCode(code), record.game_id);
      assert.equal((await second.put({ ...record, record_version: 2 }, null)).kind, "definite");
      assert.equal((await second.put({ ...record, record_version: 2 }, 1)).kind, "committed");
      await second.releaseCode(code, mintGameId());
      assert.equal(await second.lookupCode(code), record.game_id, "only the holder releases a code");
      await second.releaseCode(code, record.game_id);
      assert.equal(await second.lookupCode(code), null);
      assert.deepEqual(fs.readdirSync(path.join(dir, "games")).filter((name) => name.endsWith(".tmp")), [], "no temporary left behind");

      // A server that lost the directory's lock writes nothing.
      const fenced = createFileRecordStore(dir, { ...quiet, writerCheck: async () => false });
      const other = baseRecord("public");
      assert.equal((await fenced.put(other, null)).kind, "definite");
      assert.equal(fs.existsSync(path.join(dir, "games", `${other.game_id}.json`)), false);

      // A rename that fails twice is UNKNOWN: surfaced, the file held, a restart asked for -- never swallowed.
      const restarts: string[] = [];
      const failing = { ...nodeStoreFs, rename: async () => Promise.reject(Object.assign(new Error("injected rename failure"), { code: "EIO" })) };
      const shaky = createFileRecordStore(dir, { ...quiet, fs: failing, onRestartRequired: (key) => restarts.push(key) });
      const third = baseRecord("public");
      assert.equal((await shaky.put(third, null)).kind, "uncertain");
      assert.deepEqual(restarts, [third.game_id]);
      const held = await shaky.put(third, null);
      assert.equal(held.kind, "definite");
      assert.match((held as { detail: string }).detail, /held/);
      await assert.rejects(shaky.claimCode(mintJoinCode(), third.game_id), /unresolved|held/);

      // A damaged record is never guessed at.
      fs.writeFileSync(path.join(dir, "games", `${record.game_id}.json`), JSON.stringify({ ...record, record_version: 2, extra: 1 }));
      await assert.rejects(createFileRecordStore(dir, quiet).load(record.game_id), /not a game record/);
      fs.writeFileSync(path.join(dir, "games", "join-codes.json"), "{not json");
      await assert.rejects(createFileRecordStore(dir, quiet).lookupCode(code), /not JSON/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ==================================================================
    AUTHORIZATION: every 2C op x role x stage, against an oracle written from LIVE-2 §6.3
   ================================================================== */

/** The oracle -- written again here from §6.3, independently of `AUTHZ_TABLE` -- op -> stage -> the roles allowed. */
const ORACLE: Record<RoomOp, Partial<Record<Stage, string>>> = {
  "read-view": { W: "VMSH", A: "VSH", C: "VSH", Hd: "VSH" },
  "read-log": { W: "VMSH", A: "VSH", C: "VSH", Hd: "VSH" },
  join: { W: "VOMSH", A: "VSH", Hd: "VSH" },
  "take-seat": { W: "VMSH" },
  "release-seat": { W: "SH" },
  leave: { W: "VMSH", A: "VSH", C: "VSH", Hd: "VSH" },
  "set-ready": { W: "SH" },
  "set-profile": { W: "SH" },
  "set-visibility": { W: "H" },
  "rotate-code": { W: "H" },
  "cancel-room": { W: "H" },
  "start-game": { W: "H" },
  submit: { A: "SH", C: "SH", Hd: "SH" },
  chat: { W: "SH", A: "SH", C: "SH", Hd: "SH" },
  presence: { W: "SH", A: "SH" },
  kick: { W: "H" },
  "transfer-host": { W: "H", A: "H", Hd: "H" },
};

function expected(op: RoomOp, role: Role, stage: Stage): string {
  let effective = role;
  if (effective === "M" && stage !== "W") effective = "O";
  if (effective === "O" && !(op === "join" && stage === "W")) return "not-found";
  if (stage === "Z") return "gone";
  if (effective === "U") return "forbidden";
  const row = ORACLE[op];
  const anywhere = Object.values(row).some((roles) => (roles ?? "").includes(effective));
  if (!anywhere) return op === "submit" ? "not-seated" : "forbidden";
  return (row[stage] ?? "").includes(effective) ? "ok" : "wrong-state";
}

describe("LIVE-2C authorization matrix", () => {
  const STAGES: Stage[] = ["W", "A", "C", "Hd", "Z"];
  const situations: Array<{ role: Role; label: string; visibility: "public" | "private"; principal: string | null }> = [
    { role: "U", label: "unauthenticated", visibility: "public", principal: null },
    { role: "V", label: "viewer (public)", visibility: "public", principal: P.viewer },
    { role: "V", label: "kicked (public: still a viewer)", visibility: "public", principal: P.kicked },
    { role: "O", label: "outsider (private)", visibility: "private", principal: P.viewer },
    { role: "O", label: "kicked (private: an outsider)", visibility: "private", principal: P.kicked },
    { role: "M", label: "admitted member (private)", visibility: "private", principal: P.member },
    { role: "S", label: "seated (public)", visibility: "public", principal: P.seat },
    { role: "S", label: "seated (private)", visibility: "private", principal: P.seat },
    { role: "H", label: "host (public)", visibility: "public", principal: P.host },
    { role: "H", label: "host (private)", visibility: "private", principal: P.host },
  ];

  test("the oracle and the table cover exactly the same 2C ops (no transfer code, reclaim or rebind: LIVE-2E)", () => {
    assert.deepEqual(Object.keys(AUTHZ_TABLE).sort(), Object.keys(ORACLE).sort());
    for (const absent of ["transfer-seat", "reclaim", "rebind", "set-host", "write-doc"]) assert.equal(absent in AUTHZ_TABLE, false, absent);
  });

  test("every op x role x stage answers exactly what §6.3 says", () => {
    let checked = 0;
    for (const situation of situations) {
      for (const stage of STAGES) {
        const record = baseRecord(situation.visibility, stage === "Z" ? { status: "cancelled", cancelled_at: T0 + 5, join_code: null, expires_at: null } : {});
        const facts = stage === "W" || stage === "Z" ? NO_FACTS : stage === "C" ? ENDED : DEALT;
        for (const op of Object.keys(ORACLE) as RoomOp[]) {
          const verdict = authorize(op, { record, facts, principalId: situation.principal, now: T0 + 100, held: stage === "Hd" });
          const want = expected(op, situation.role, stage);
          assert.equal(verdict.ok ? "ok" : verdict.code, want, `${op} by ${situation.label} in ${stage}`);
          assert.equal(verdict.stage, stage, `${op} by ${situation.label}: stage ${stage}`);
          checked += 1;
        }
      }
    }
    assert.equal(checked, situations.length * STAGES.length * Object.keys(ORACLE).length);
  });

  test("a private room's outsider is told exactly what a nonexistent game tells anyone; expired and archived are gone", () => {
    const record = baseRecord("private");
    for (const op of Object.keys(ORACLE) as RoomOp[]) {
      if (op === "join") continue;
      const outsider = authorize(op, { record, facts: NO_FACTS, principalId: P.viewer, now: T0, held: false });
      const nothing = authorize(op, { record: null, facts: NO_FACTS, principalId: P.viewer, now: T0, held: false });
      assert.equal(outsider.ok, false);
      assert.deepEqual([(outsider as { code: string }).code, (outsider as { reason: string }).reason], [(nothing as { code: string }).code, (nothing as { reason: string }).reason], op);
    }
    const lapsed = authorize("read-view", { record: baseRecord("public"), facts: NO_FACTS, principalId: P.host, now: T0 + WAITING_TTL_MS, held: false });
    assert.equal((lapsed as { code: string }).code, "gone", "the 24 h waiting TTL");
    const archived = authorize("read-view", { record: baseRecord("public", { archived_at: T0 + 1 }), facts: DEALT, principalId: P.host, now: T0, held: false });
    assert.equal((archived as { code: string }).code, "gone");
    // The log wins: a dealt game is active whatever the record's cached status or its TTL says.
    const dealtLate = authorize("submit", { record: baseRecord("public"), facts: DEALT, principalId: P.seat, now: T0 + 2 * WAITING_TTL_MS, held: false });
    assert.equal(dealtLate.ok, true);
  });

  test("no authorization reads a nickname, a presence hint or a client-sent id: renaming yourself the host grants nothing", () => {
    const record = baseRecord("public");
    const impostor = { ...record, seats: record.seats.map((seat) => (seat.principal_id === P.seat ? { ...seat, nickname: record.seats[0].nickname } : seat)) };
    for (const op of ["start-game", "kick", "cancel-room", "transfer-host", "set-visibility", "rotate-code"] as RoomOp[]) {
      assert.equal((authorize(op, { record: impostor, facts: NO_FACTS, principalId: P.seat, now: T0, held: false }) as { code: string }).code, "forbidden", op);
    }
  });
});

/* ==================================================================
    SEATS, THE DEAL AND THE SHUFFLE (pure)
   ================================================================== */

describe("LIVE-2C seats and the server-built deal (pure)", () => {
  test("a seat's player_id is minted by the server, unique in the record; taking a seat twice is the same seat", () => {
    const record = baseRecord("public");
    const first = takeSeat(envFor(record, P.viewer));
    assert.ok(first.ok && first.record !== null);
    const seat = (first.record as GameRecord).seats.find((entry) => entry.principal_id === P.viewer);
    assert.match(seat?.player_id ?? "", PLAYER_ID_PATTERN);
    const again = takeSeat(envFor(first.record as GameRecord, P.viewer));
    assert.ok(again.ok);
    assert.equal(again.record, null, "no second seat");
    assert.equal((again.data as { playerId: string }).playerId, seat?.player_id);
    // A colliding mint is retried, never reused.
    const taken = record.seats[0].player_id;
    let calls = 0;
    const retried = takeSeat({ ...envFor(record, P.viewer), mintPlayerId: () => (calls++ === 0 ? taken : "p-0000000000000001") });
    assert.equal((retried as unknown as { data: { playerId: string } }).data.playerId, "p-0000000000000001");
    // Kicked: never seated again at this table.
    assert.equal((takeSeat(envFor(record, P.kicked)) as { code: string }).code, "kicked");
  });

  test("cryptoShuffle is Fisher-Yates over an injected source; buildSetupGame is today's SetupGame shape with the seats' ids", () => {
    const items = ["a", "b", "c", "d"];
    assert.deepEqual(cryptoShuffle(items, (max) => max - 1), items, "always the last index: the identity");
    assert.deepEqual(cryptoShuffle(["h", "g1", "g2"], () => 0), ["g1", "g2", "h"]);
    const draws: number[] = [];
    cryptoShuffle(items, (max) => {
      draws.push(max);
      return 0;
    });
    assert.deepEqual(draws, [4, 3, 2], "one draw per position, bounded by the unshuffled prefix");
    const seen = new Set<string>();
    for (let n = 0; n < 400; n += 1) seen.add(cryptoShuffle(["x", "y", "z"]).join(""));
    assert.equal(seen.size, 6, "the crypto default reaches every permutation");

    const record = baseRecord("public");
    record.seats[1].color = SEAT_COLORS[2];
    const deal = buildSetupGame({ turnOrder: [record.seats[1], record.seats[0]], variants: record.variants }, BUILD);
    assert.deepEqual(Object.keys(deal), ["SetupGame"]);
    assert.deepEqual(Object.keys(deal.SetupGame).sort(), ["build", "players", "variants"]);
    assert.deepEqual(deal.SetupGame.players, [
      { id: record.seats[1].player_id, nickname: "Sam", color: SEAT_COLORS[2] },
      { id: record.seats[0].player_id, nickname: "Hana" },
    ]);
    assert.equal((deal.SetupGame.variants as { rules?: number }).rules, CURRENT_RULES_REVISION);
    assert.equal(deal.SetupGame.build, BUILD);
  });
});

/* ==================================================================
    UNDO: the frozen RV rules, the policy, and the button agreeing with the server
   ================================================================== */

describe("LIVE-2C undo policy (RV-2 .. RV-7) and button/server parity", () => {
  const entry = (index: number, actor: string, payload: object, derived = false): RevertableAction =>
    ({ index, id: `e${index}`, actor, payload: JSON.stringify(payload), derived }) as unknown as RevertableAction;
  const deal = entry(0, "p-host", { SetupGame: { players: [{ id: "p-host", nickname: "H" }, { id: "p-guest", nickname: "G" }], variants: {} } });
  const hostBuy = entry(1, "p-host", BUY);
  const guestBuy = entry(2, "p-guest", BUY);
  const log = [deal, hostBuy, guestBuy];
  const NONE: UndoPolicy = { host_undo: "none" };

  test("the full matrix, both policies", () => {
    const rows: Array<[string, readonly RevertableAction[], number, string, boolean, UndoPolicy | undefined, object | undefined, string | null]> = [
      ["RV-2 nothing dealt", [], 0, "p-host", true, undefined, undefined, REVERT_NOTHING_DEALT],
      ["RV-3 game ended", log, 2, "p-host", true, undefined, { current_round_type: "GameEnd" }, REVERT_GAME_ENDED],
      ["RV-3 room closed", log, 2, "p-guest", false, undefined, { room_closed: true }, REVERT_GAME_ENDED],
      ["RV-4 no target", log, 9, "p-host", true, undefined, undefined, REVERT_NO_TARGET],
      ["RV-5 the deal floor", log, 0, "p-host", true, undefined, undefined, REVERT_DEAL_FLOOR],
      ["RV-6 host, not the last action", log, 1, "p-host", true, undefined, undefined, REVERT_ONE_STEP],
      ["RV-6 seat, not the last action", log, 1, "p-host", false, undefined, undefined, REVERT_NOT_YOURS],
      ["RV-7 own last action", log, 2, "p-guest", false, undefined, undefined, null],
      ["RV-7 host takes back another's last action (no-money)", log, 2, "p-host", true, NO_MONEY_UNDO_POLICY, undefined, null],
      ["RV-7 a seat cannot take back another's", log, 2, "p-host", false, NO_MONEY_UNDO_POLICY, undefined, REVERT_NOT_YOURS],
      ["RV-7 money policy: the host is a seat like any other", log, 2, "p-host", true, NONE, undefined, REVERT_NOT_YOURS],
      ["RV-6 money policy: the host is worded as a seat", log, 1, "p-host", true, NONE, undefined, REVERT_NOT_YOURS],
      ["money policy: own last action still allowed", log, 2, "p-guest", true, NONE, undefined, null],
    ];
    for (const [label, entries, index, actor, isHost, policy, board, want] of rows) {
      assert.equal(revertRefusal({ log: entries, index, actor, isHost, policy, board: board as never }), want, label);
    }
  });

  test("the button's reach is the server's predicate under the same policy", () => {
    for (const policy of [NO_MONEY_UNDO_POLICY, NONE]) {
      for (const [actor, isHost] of [["p-host", true], ["p-guest", false], ["p-host", false]] as Array<[string, boolean]>) {
        const reach = undoReachFor(log, actor, isHost, () => "undo", undefined, policy);
        const server = revertRefusal({ log, index: guestBuy.index, actor, isHost, policy });
        if (server === null) assert.equal(reach.index, guestBuy.index, `${actor} ${policy.host_undo}`);
        else assert.equal(reach.index, null, `${actor} ${policy.host_undo}`);
      }
    }
    // The money policy withdraws exactly the host's reach over another's action, and nothing else.
    assert.equal(undoReachFor(log, "p-host", true, () => "undo", undefined, NONE).index, null);
    assert.equal(undoReachFor(log, "p-host", true, () => "undo").index, guestBuy.index, "absent is the no-money policy");
  });
});

/* ==================================================================
    CREATE / JOIN / SEATS over the wire
   ================================================================== */

describe("LIVE-2C create, join and seats", () => {
  test("create answers the game id, the join code and the host's player id -- and the record is the server's", async () => {
    const { server, port } = await serve();
    try {
      const table = await openTable(port, 2);
      assert.match(table.gameId, GAME_ID_PATTERN);
      assert.match(table.code, JOIN_CODE_PATTERN);
      assert.match(table.hostPlayerId, PLAYER_ID_PATTERN);
      const record = (await server.records.load(table.gameId)) as GameRecord;
      assert.ok(isGameRecord(record));
      assert.equal(record.host_player_id, table.hostPlayerId);
      assert.equal(record.created_by_principal, "pr_dev_t1-host");
      assert.deepEqual(record.seats.map((seat) => seat.player_id), [table.hostPlayerId, table.guests[0].playerId]);
      assert.notEqual(table.guests[0].playerId, "t1-guest1", "the seat id is minted, not the claim");
      assert.equal(await server.records.lookupCode(table.code), table.gameId);
      // Both see the room, with ids that are player ids and roles derived from the record.
      for (const who of everyone(table)) who.send({ kind: "room-hello", gameId: table.gameId, build: BUILD });
      await until(() => everyone(table).every((who) => viewOf(who, table.gameId)?.players.length === 2), "both views");
      assert.equal(viewOf(table.host, table.gameId)?.you.role, "host");
      assert.equal(viewOf(table.guests[0].client, table.gameId)?.you.role, "player");
      assert.equal(viewOf(table.guests[0].client, table.gameId)?.you.playerId, table.guests[0].playerId);
      assertNoPrincipalIds(everyone(table));
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("join by code: forgiving input, idempotent, one seat per principal, full tables seat nobody, money refused", async () => {
    const { server, port } = await serve();
    try {
      const table = await openTable(port, 1, { exactPlayers: 2 });
      const guest = await Client.open(port, "join-guest");
      const typed = table.code.toLowerCase().replace(/-/g, " ");
      const first = await op(guest, { type: "join", code: typed, takeSeat: true });
      assert.equal(first.ok, true, JSON.stringify(first));
      const again = await op(guest, { type: "join", code: table.code, takeSeat: true });
      assert.equal(dataOf(again).playerId, dataOf(first).playerId, "a duplicate join is the same seat");
      const twin = await Client.open(port, "join-guest"); // the same principal, a second tab
      const fromTwin = await op(twin, { type: "take-seat" }, table.gameId);
      assert.equal(dataOf(fromTwin).playerId, dataOf(first).playerId, "the same principal holds one seat");
      const late = await Client.open(port, "join-late");
      const full = await op(late, { type: "join", code: table.code, takeSeat: true });
      assert.equal(full.ok, true);
      assert.equal(dataOf(full).playerId, null, "a full table admits a public watcher and seats nobody");
      assert.equal((await op(late, { type: "take-seat" }, table.gameId)).code, "room-full");
      assert.equal(((await server.records.load(table.gameId)) as GameRecord).seats.length, 2);
      const money = await op(late, CREATE({ stake: "1000000" }));
      assert.equal(money.code, "money-games-disabled");
      const free = await op(late, CREATE({ stake: "0" }));
      assert.equal(free.ok, true, "a zero stake is a no-money table");
      await Promise.all([table.host.close(), guest.close(), twin.close(), late.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("a code that opens nothing -- malformed, legacy, unknown, orphaned, cancelled, expired -- is one answer, and failures are budgeted", async () => {
    const clock = { now: T0 };
    const { server, port } = await serve({
      identity: devIdentity({ now: () => clock.now }),
      rooms: { joinFailuresPerPrincipal: { capacity: 7, refillPerSecond: 0.0001 } },
    });
    const store = server.records as MemoryRecordStore;
    try {
      const cancelled = await openTable(port, 1);
      assert.equal((await op(cancelled.host, { type: "cancel-room" }, cancelled.gameId)).ok, true);
      const lapsed = await openTable(port, 1);
      const orphan = mintJoinCode();
      store.codes.set(orphan, mintGameId()); // a claim whose record never landed (§14.5)
      clock.now += WAITING_TTL_MS + 1;
      const prober = await Client.open(port, "prober");
      const answers: Frame[] = [];
      for (const code of ["JUNO-AAAA-AAA0", "ABC", mintJoinCode(), orphan, cancelled.code, lapsed.code, "x".repeat(40)]) {
        answers.push(await op(prober, { type: "join", code: code.slice(0, 32), takeSeat: true }));
      }
      for (const answer of answers) {
        assert.equal(answer.ok, false);
        assert.deepEqual([answer.code, answer.reason], ["invalid-or-expired", "That code does not open a table right now."]);
      }
      // The eighth attempt -- even with a good code -- is over the budget.
      const good = await openTable(port, 1);
      const limited = await op(prober, { type: "join", code: good.code, takeSeat: true });
      assert.equal(limited.code, "rate-limited");
      assert.equal(server.rooms.denied["join-failures"], 1);
      assert.equal(server.residentGames() <= 3, true, "the orphan and the unknown codes allocated no game");
      await Promise.all([cancelled.host.close(), lapsed.host.close(), good.host.close(), prober.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("caps: tables hosted, tables seated, and creates per principal -- a create in flight counts", async () => {
    const { server, port } = await serve({ rooms: { maxHostedRooms: 2, maxSeatedGames: 3 } });
    try {
      /* One principal, three tabs, three creates in one tick: the tabs' frames run concurrently, and a create still in
         flight counts against the cap before its record exists. */
      const tabs = await Promise.all([0, 1, 2].map(() => Client.open(port, "capper")));
      const host = tabs[0];
      const racing = await Promise.all(tabs.map((tab) => ackOf(tab, sendOp(tab, CREATE()))));
      assert.deepEqual(racing.map((answer) => answer.ok).sort(), [false, true, true], "three creates in one tick: two tables");
      assert.equal(racing.find((answer) => !answer.ok)?.code, "limit-reached");
      const guest = await Client.open(port, "sitter");
      const seats: Frame[] = [];
      for (let n = 0; n < 2; n += 1) {
        const other = await Client.open(port, `other-host-${n}`);
        const made = await op(other, CREATE());
        seats.push(await op(guest, { type: "join", code: dataOf(made).code as string, takeSeat: true }));
      }
      const own = await op(guest, CREATE());
      assert.equal(own.ok, true, "hosting a table is sitting at it: three");
      const fourth = await op(guest, { type: "join", code: dataOf(racing.find((answer) => answer.ok) as Frame).code as string, takeSeat: true });
      assert.equal(fourth.code, "limit-reached");
      const watch = await op(guest, { type: "join", code: dataOf(racing.find((answer) => answer.ok) as Frame).code as string, takeSeat: false });
      assert.equal(watch.ok, true, "watching is not sitting");
      const limited = await serve({ rooms: { createsPerPrincipal: { capacity: 1, refillPerSecond: 0.0001 } } });
      try {
        const eager = await Client.open(limited.port, "eager");
        assert.equal((await op(eager, CREATE())).ok, true);
        assert.equal((await op(eager, CREATE())).code, "rate-limited");
        assert.equal(limited.server.rooms.denied["room-create"], 1);
        await eager.close();
      } finally {
        await stopServer(limited.server);
      }
      await Promise.all([...tabs.map((tab) => tab.close()), guest.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("activation before reference: a cookie guest is made durable before any record names it, and a failure writes no record", async () => {
    const identityStore = createMemoryIdentityStore();
    const service = IdentityService.fromSnapshot(identityStore, { principals: [], sessions: [] });
    const records = createMemoryRecordStore();
    const { server, port } = await serve({ records, identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, service } });
    try {
      assert.equal(server.legacyRoomProtocol, false);
      const cookie = await prodCookie(port);
      const socket = await prodSocket(port, cookie);
      assert.equal(identityStore.snapshot().principals.length, 0, "a fresh guest is provisional: nothing durable yet");
      identityStore.failNext.push("definite");
      const refused = await socket.op(CREATE());
      assert.equal(refused.code, "unavailable");
      assert.equal(records.records.size, 0, "activation failed: no record names the guest");
      assert.equal(identityStore.snapshot().principals.length, 0);
      records.failPuts.push("definite");
      const lost = await socket.op(CREATE());
      assert.equal(lost.code, "unavailable");
      assert.equal(records.records.size, 0, "the record write failed after activation");
      assert.equal(identityStore.snapshot().principals.length, 1, "a harmless durable guest with no seat -- the only possible remainder");
      const made = await socket.op(CREATE());
      assert.equal(made.ok, true, JSON.stringify(made));
      const record = records.records.get(dataOf(made).gameId as string) as GameRecord;
      const durable = identityStore.snapshot().principals.map((principal) => (principal as { principal_id: string }).principal_id);
      assert.ok(durable.includes(record.created_by_principal) && durable.includes(record.seats[0].principal_id));
      assert.equal(JSON.stringify(socket.frames).includes(record.created_by_principal), false, "the principal id never reaches the wire");
      socket.close();
    } finally {
      await stopServer(server);
    }
  });
});

/* ---- a production (cookie) client, for the cases that need a real, activatable principal ---- */

function prodCookie(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/gs/api/session", method: "POST", headers: { Origin: PROD_ORIGIN, "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        const set = res.headers["set-cookie"];
        if (!set || set.length !== 1) reject(new Error(`no cookie (status ${res.statusCode})`));
        else resolve(set[0].split(";")[0]);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

async function prodSocket(port: number, cookie: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/gs`, { headers: { Cookie: cookie }, origin: PROD_ORIGIN });
  const frames: Frame[] = [];
  socket.on("message", (raw) => frames.push(JSON.parse(String(raw)) as Frame));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return {
    frames,
    async op(body: Record<string, unknown>, gameId?: string): Promise<Frame> {
      requests += 1;
      const requestId = `prod-${requests}`;
      socket.send(JSON.stringify({ kind: "room-op", requestId, ...(gameId ? { gameId } : {}), op: body }));
      await until(() => frames.some((f) => f.kind === "room-ack" && f.requestId === requestId), `the ack ${requestId}`);
      return frames.find((f) => f.kind === "room-ack" && f.requestId === requestId) as Frame;
    },
    close: () => socket.terminate(),
  };
}

/* ==================================================================
    READS, MEMBERSHIP AND PER-PUSH RE-AUTHORIZATION
   ================================================================== */

const closedWith = (client: Client): Promise<number> =>
  client.socket.readyState === WebSocket.CLOSED ? Promise.resolve(-1) : new Promise((resolve) => client.socket.once("close", (code) => resolve(code)));

describe("LIVE-2C reads and access loss", () => {
  test("a private room: an outsider learns nothing (the nonexistent answer), a member reads while it waits, and loses it at the deal", async () => {
    const { server, port } = await serve();
    try {
      const table = await openTable(port, 2, { visibility: "private" });
      const outsider = await Client.open(port, "outsider");
      const ghost = mintGameId();
      outsider.send({ kind: "room-hello", gameId: table.gameId, build: BUILD });
      outsider.send({ kind: "room-hello", gameId: ghost, build: BUILD });
      logHello(outsider, table.gameId);
      await until(() => outsider.of("error").length === 3, "three refusals");
      const [privateView, ghostView, privateLog] = outsider.of("error");
      assert.deepEqual([privateView.code, privateView.reason], [ghostView.code, ghostView.reason], "indistinguishable from a game that does not exist");
      assert.deepEqual([privateLog.code, privateLog.reason], [ghostView.code, ghostView.reason]);
      assert.equal((await op(outsider, { type: "set-ready", ready: true }, table.gameId)).code, "not-found");
      assert.equal((await op(outsider, { type: "take-seat" }, table.gameId)).code, "not-found");
      assert.equal(outsider.frames.some((frame) => frame.kind === "room"), false);

      // The code is the invitation: a member, admitted without a seat, reads the waiting room and its (empty) log.
      const member = await Client.open(port, "member");
      const admitted = await op(member, { type: "join", code: table.code, takeSeat: false });
      assert.equal(admitted.ok, true);
      member.send({ kind: "room-hello", gameId: table.gameId, build: BUILD });
      logHello(member, table.gameId);
      await until(() => viewOf(member, table.gameId)?.you.role === "member", "the member's view");
      assert.equal(viewOf(member, table.gameId)?.code, table.code);
      await until(() => member.of("catch-up").length === 1, "the member's (empty) catch-up");
      assert.equal(member.frames.some((frame) => frame.kind === "chat"), true);
      await until(() => (member.of("chat")[0].messages as unknown[]).length === 0, "chat");

      // The deal: the member's view and log are refused at the very push that would have carried it -- 4410.
      const closed = closedWith(member);
      await readyAll(table);
      assert.equal((await op(table.host, { type: "start-game" }, table.gameId)).ok, true);
      assert.equal(await closed, 4410);
      assert.equal(member.seen().length, 0, "the member never received the deal");
      assert.equal(member.frames.some((frame) => frame.kind === "applied"), false);
      const after = await Client.open(port, "member");
      after.send({ kind: "room-hello", gameId: table.gameId, build: BUILD });
      assert.equal((await frameWhere(after, (frame) => frame.kind === "error", "the refusal")).code, "not-found");
      // The private code died at the deal.
      await until(() => server.rooms.counters.created === 1 && (server.records as MemoryRecordStore).codes.get(table.code) === undefined, "the code released");
      assert.equal((await op(after, { type: "join", code: table.code, takeSeat: true })).code, "invalid-or-expired");
      await Promise.all([...everyone(table), outsider, after].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("kick: the kicked socket is closed before any later push, and the principal can never sit here again", async () => {
    const { server, port } = await serve();
    try {
      const table = await openTable(port, 3);
      const [kept, gone] = table.guests;
      for (const who of everyone(table)) who.send({ kind: "room-hello", gameId: table.gameId, build: BUILD });
      logHello(gone.client, table.gameId);
      await until(() => viewOf(gone.client, table.gameId)?.players.length === 3, "the kicked guest's view");
      const closed = closedWith(gone.client);
      const kicked = await op(table.host, { type: "kick", playerId: gone.playerId }, table.gameId);
      assert.equal(kicked.ok, true);
      assert.equal(await closed, 4410);
      const lastRoomFrame = gone.client.frames.filter((frame) => frame.kind === "room").pop();
      assert.equal((lastRoomFrame?.view as WireView).players.length, 3, "no view after the kick reached the kicked socket");
      // Later activity is never delivered to it.
      await op(kept.client, { type: "set-profile", nickname: "Kept" }, table.gameId);
      await until(() => viewOf(table.host, table.gameId)?.players.some((player) => player.nickname === "Kept") === true, "the rename");
      const back = await Client.open(port, gone.client.claim);
      assert.equal((await op(back, { type: "join", code: table.code, takeSeat: true })).code, "kicked");
      assert.equal((await op(back, { type: "take-seat" }, table.gameId)).code, "kicked");
      // Not the host's own seat, and not by anybody but the host.
      assert.equal((await op(table.host, { type: "kick", playerId: table.hostPlayerId }, table.gameId)).code, "forbidden");
      assert.equal((await op(kept.client, { type: "kick", playerId: table.hostPlayerId }, table.gameId)).code, "forbidden");
      await Promise.all([...everyone(table), back].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("host policy: the host role moves only by transfer or succession; nobody overwrites it; cancel is the host's", async () => {
    const { server, port } = await serve();
    try {
      const table = await openTable(port, 3);
      const [next, third] = table.guests;
      assert.equal((await op(next.client, { type: "transfer-host", toPlayerId: next.playerId }, table.gameId)).code, "forbidden", "no self-promotion");
      assert.equal((await op(table.host, { type: "transfer-host", toPlayerId: mintPlayerId() }, table.gameId)).code, "not-found");
      assert.equal((await op(table.host, { type: "transfer-host", toPlayerId: next.playerId }, table.gameId)).ok, true);
      assert.equal(((await server.records.load(table.gameId)) as GameRecord).host_player_id, next.playerId);
      assert.equal((await op(table.host, { type: "cancel-room" }, table.gameId)).code, "forbidden", "the old host is a seat now");
      assert.equal((await op(table.host, { type: "rotate-code" }, table.gameId)).code, "forbidden");
      // Succession: the host leaves; the earliest remaining seat inherits.
      assert.equal((await op(next.client, { type: "leave" }, table.gameId)).ok, true);
      assert.equal(((await server.records.load(table.gameId)) as GameRecord).host_player_id, table.hostPlayerId, "the creator joined first");
      // The last seat leaving cancels the table and releases its code.
      assert.equal((await op(third.client, { type: "leave" }, table.gameId)).ok, true);
      assert.equal((await op(table.host, { type: "release-seat" }, table.gameId)).ok, true);
      const record = (await server.records.load(table.gameId)) as GameRecord;
      assert.deepEqual([record.status, record.join_code, record.seats.length], ["cancelled", null, 0]);
      await until(() => (server.records as MemoryRecordStore).codes.get(table.code) === undefined, "the code released");
      assert.equal((await op(third.client, { type: "join", code: table.code, takeSeat: true })).code, "invalid-or-expired");
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("visibility and codes: going private rotates the code and drops every watcher; rotation kills the old code at once", async () => {
    const { server, port } = await serve();
    try {
      const table = await openTable(port, 2);
      const watcher = await Client.open(port, "watcher");
      watcher.send({ kind: "room-hello", gameId: table.gameId, build: BUILD });
      await until(() => viewOf(watcher, table.gameId)?.you.role === "viewer", "the watcher's view");
      const closed = closedWith(watcher);
      const privately = await op(table.host, { type: "set-visibility", visibility: "private" }, table.gameId);
      assert.equal(privately.ok, true);
      assert.equal(await closed, 4410, "a public watcher is an outsider of a private room");
      const record = (await server.records.load(table.gameId)) as GameRecord;
      assert.notEqual(record.join_code, table.code);
      assert.deepEqual(record.admitted.map((entry) => entry.principal_id).sort(), record.seats.map((seat) => seat.principal_id).sort());
      const stranger = await Client.open(port, "stranger");
      assert.equal((await op(stranger, { type: "join", code: table.code, takeSeat: true })).code, "invalid-or-expired", "the published code died");
      const rotated = await op(table.host, { type: "rotate-code" }, table.gameId);
      const fresh = dataOf(rotated).code as string;
      assert.match(fresh, JOIN_CODE_PATTERN);
      assert.equal((await op(stranger, { type: "join", code: record.join_code as string, takeSeat: true })).code, "invalid-or-expired");
      assert.equal((await op(stranger, { type: "join", code: fresh, takeSeat: true })).ok, true);
      await Promise.all([...everyone(table), stranger].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("the public list: public waiting and playing tables only, nicknames and no ids beyond the game's, coalesced", async () => {
    const { server, port } = await serve({ rooms: { listCoalesceMs: 200 } });
    try {
      const open = await openTable(port, 1);
      const hidden = await openTable(port, 1, { visibility: "private" });
      const lister = await Client.open(port, "lister");
      lister.send({ kind: "rooms-watch", on: true });
      const first = await frameWhere(lister, (frame) => frame.kind === "rooms", "the list");
      const rooms = first.rooms as Array<Record<string, unknown>>;
      assert.deepEqual(rooms.map((room) => room.gameId), [open.gameId]);
      assert.deepEqual(Object.keys(rooms[0]).sort(), ["code", "createdAtMs", "gameId", "hostNickname", "nicknames", "playerCount", "readyCount", "seatCap", "seated", "status", "variants"]);
      for (let n = 0; n < 5; n += 1) await op(open.host, { type: "set-profile", nickname: `Hana${n}` }, open.gameId);
      await sleep(450);
      assert.ok(lister.of("rooms").length <= 4, `five changes, coalesced (${lister.of("rooms").length} lists)`);
      assert.equal((lister.of("rooms").pop()?.rooms as Array<{ hostNickname: string }>)[0].hostNickname, "Hana4");
      assertNoPrincipalIds([lister, open.host, hidden.host]);
      await Promise.all([open.host, hidden.host, lister].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("the viewer cap: a record's max_viewers bounds its non-seated readers", async () => {
    const records = createMemoryRecordStore();
    const record = baseRecord("public");
    const capped = { ...record, created_at: Date.now(), expires_at: Date.now() + WAITING_TTL_MS, policy: { ...record.policy, max_viewers: 2 } };
    assert.equal((await records.put(capped, null)).kind, "committed");
    const { server, port } = await serve({ records });
    try {
      const viewers = await Promise.all([0, 1, 2].map((n) => Client.open(port, `viewer-${n}`)));
      for (const viewer of viewers.slice(0, 2)) {
        viewer.send({ kind: "room-hello", gameId: capped.game_id, build: BUILD });
        await until(() => viewOf(viewer, capped.game_id) !== undefined, "a watcher's view");
      }
      viewers[2].send({ kind: "room-hello", gameId: capped.game_id, build: BUILD });
      assert.equal((await frameWhere(viewers[2], (frame) => frame.kind === "error", "the cap")).code, "room-full");
      await Promise.all(viewers.map((viewer) => viewer.close()));
    } finally {
      await stopServer(server);
    }
  });
});

describe("LIVE-2C chat, presence and the waiting-room clock", () => {
  test("chat and presence are the seats': a watcher reads them and cannot speak; lines carry the seat's id and name", async () => {
    const { server, port } = await serve();
    try {
      const table = await openTable(port, 2);
      const watcher = await Client.open(port, "chat-watcher");
      for (const who of [...everyone(table), watcher]) who.send({ kind: "room-hello", gameId: table.gameId, build: BUILD });
      await until(() => [...everyone(table), watcher].every((who) => viewOf(who, table.gameId) !== undefined), "every view");
      watcher.send({ kind: "chat-send", gameId: table.gameId, text: "let me in" });
      assert.equal((await frameWhere(watcher, (frame) => frame.kind === "error", "the refusal")).code, "forbidden");
      watcher.send({ kind: "presence-set", gameId: table.gameId, state: { status: "active" } });
      await until(() => watcher.of("error").length === 2, "the presence refusal");
      table.guests[0].client.send({ kind: "chat-send", gameId: table.gameId, text: "  hello table  " });
      await until(() => watcher.of("chat").some((frame) => (frame.messages as unknown[]).length === 1), "the line, delivered to readers");
      const line = (watcher.of("chat").pop()?.messages as Array<{ author: string; displayName: string; text: string }>)[0];
      assert.deepEqual([line.author, line.displayName, line.text], [table.guests[0].playerId, "Player", "hello table"]);
      assertNoPrincipalIds([watcher, ...everyone(table)]);
      // Chat before joining the room's view is refused: membership is checked per frame, never cached.
      const cold = await Client.open(port, table.guests[0].client.claim);
      cold.send({ kind: "chat-send", gameId: table.gameId, text: "hi" });
      assert.equal((await frameWhere(cold, (frame) => frame.kind === "error", "the refusal")).code, "forbidden");
      await Promise.all([...everyone(table), watcher, cold].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("the 24 h waiting TTL: reads answer gone at once; the first op, or the sweep, makes it durable and frees the code", async () => {
    const clock = { now: Date.now() };
    const records = createMemoryRecordStore();
    const { server, port } = await serve({ records, identity: devIdentity({ now: () => clock.now }) });
    try {
      const touched = await openTable(port, 2);
      const swept = await openTable(port, 1);
      clock.now += WAITING_TTL_MS + 1;
      const late = await Client.open(port, touched.guests[0].client.claim);
      late.send({ kind: "room-hello", gameId: touched.gameId, build: BUILD });
      assert.equal((await frameWhere(late, (frame) => frame.kind === "error", "the refusal")).code, "gone");
      assert.equal(records.records.get(touched.gameId)?.status, "waiting", "a read changes nothing");
      const expired = await op(late, { type: "set-ready", ready: true }, touched.gameId);
      assert.equal(expired.code, "gone");
      await until(() => records.records.get(touched.gameId)?.status === "expired" && !records.codes.has(touched.code), "expired, durably, and its code freed");
      assert.equal((await op(late, { type: "join", code: touched.code, takeSeat: true })).code, "invalid-or-expired");
      server.rooms.sweepExpired();
      await until(() => records.records.get(swept.gameId)?.status === "expired" && !records.codes.has(swept.code), "the sweep expired the untouched table");
      // A host of lapsed tables is not held at the cap by them.
      const again = await op(swept.host, CREATE());
      assert.equal(again.ok, true);
      await Promise.all([...everyone(touched), ...everyone(swept), late].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    RESOURCE BOUNDS
   ================================================================== */

describe("LIVE-2C resource bounds", () => {
  test("an unknown game id never allocates a game; repeated lookups are answered from the 60 s negative cache", async () => {
    const records = createMemoryRecordStore();
    const { server, port } = await serve({ records, rooms: { unknownGameTtlMs: 300 } });
    try {
      assert.equal(server.limits.rooms.unknownGameTtlMs, 300);
      const flood = await Client.open(port, "flooder");
      const ids = Array.from({ length: 15 }, () => mintGameId()); // 45 frames: inside LIVE-2A's 64 in flight
      for (const id of ids) {
        flood.send({ kind: "room-hello", gameId: id, build: BUILD });
        logHello(flood, id);
        flood.send({ kind: "room-op", requestId: `u-${id.slice(2, 10)}`, gameId: id, op: { type: "set-ready", ready: true } });
      }
      await until(() => flood.of("error").length === 30 && flood.of("room-ack").length === 15, "every probe answered");
      assert.ok(flood.of("error").every((frame) => frame.code === "not-found"));
      assert.ok(flood.of("room-ack").every((frame) => frame.code === "not-found"));
      assert.equal(server.residentGames(), 0, "no RoomSession for a game that does not exist");
      assert.equal(server.rooms.counters.sessionsAllocated, 0);
      assert.equal(records.stats.loads, 15, "one store read per distinct id");
      assert.equal(server.rooms.counters.negativeCacheHits, 30);
      await sleep(350);
      flood.send({ kind: "room-hello", gameId: ids[0], build: BUILD });
      await until(() => flood.of("error").length === 31, "the probe after the ttl");
      assert.equal(records.stats.loads, 16, "the cache entry lapsed: one more read");
      await flood.close();
    } finally {
      await stopServer(server);
    }
  });

  test("a socket that authenticates and subscribes to nothing is closed after the reap window; a subscribed one is not", async () => {
    const { server, port } = await serve({ rooms: { unsubscribedReapMs: 400 } });
    try {
      const table = await openTable(port, 1);
      table.host.send({ kind: "room-hello", gameId: table.gameId, build: BUILD });
      const idle = await Client.open(port, "idle");
      const lister = await Client.open(port, "lister");
      lister.send({ kind: "rooms-watch", on: true });
      assert.equal(await closedWith(idle), 1000);
      await sleep(450);
      assert.equal(lister.open, true);
      assert.equal(table.host.open, true);
      assert.equal(server.upgrades.reaped, 1);
      await Promise.all([lister.close(), table.host.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("per-seat and per-game submit budgets, keyed by the seat's player id", async () => {
    const { server, port } = await serve({ rooms: { submitsPerSeat: { capacity: 2, refillPerSecond: 0.0001 } } });
    try {
      const table = await startedTable(port, 2);
      table.host.submit(BUY, { baseIndex: lastIndexSeen(table.host), submissionId: "b1" });
      const first = await table.host.answerTo("b1");
      assert.equal(first.kind, "applied");
      table.host.submit(BUY, { baseIndex: lastIndexSeen(table.host), submissionId: "b2" });
      assert.notEqual((await table.host.answerTo("b2")).code, "rate-limited");
      table.host.submit(BUY, { baseIndex: lastIndexSeen(table.host), submissionId: "b3" });
      const third = await table.host.answerTo("b3");
      assert.equal(third.code, "rate-limited");
      assert.equal(typeof third.retryAfterMs, "number");
      assert.equal(server.rooms.denied["submits-seat"], 1);
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    START: the server's deal
   ================================================================== */

describe("LIVE-2C start", () => {
  test("only the host, only when every seat is ready, exactly once -- and the deal is today's SetupGame, dealt by crypto", async () => {
    const records = createMemoryRecordStore();
    const { server, port } = await serve({ records, shuffle: (items) => cryptoShuffle(items, () => 0) });
    try {
      const table = await openTable(port, 3);
      const [g1, g2] = table.guests;
      assert.equal((await op(g1.client, { type: "start-game" }, table.gameId)).code, "forbidden", "a seat is not the host");
      const unready = await op(table.host, { type: "start-game" }, table.gameId);
      assert.deepEqual([unready.code, unready.reason], ["not-ready", "Waiting for the other players to mark themselves ready."]);
      await readyAll(table);
      const originalRandom = Math.random;
      let randomCalls = 0;
      Math.random = () => {
        randomCalls += 1;
        return originalRandom();
      };
      let started: Frame;
      try {
        started = await op(table.host, { type: "start-game" }, table.gameId);
      } finally {
        Math.random = originalRandom;
      }
      assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(randomCalls, 0, "no Math.random anywhere in a start");
      const again = await op(table.host, { type: "start-game" }, table.gameId);
      assert.deepEqual([again.ok, dataOf(again).alreadyStarted], [true, true], "a second press is told it already started");
      logHello(table.host, table.gameId);
      const catchUp = await frameWhere(table.host, (frame) => frame.kind === "catch-up", "the catch-up");
      const deals = dealsIn(catchUp.entries as ServerLogEntry[]);
      assert.equal(deals.length, 1, "one deal");
      const deal = JSON.parse(deals[0].payload).SetupGame as { players: Array<{ id: string; nickname: string }>; variants: Record<string, unknown>; build: string; rules_engine_version: number };
      assert.deepEqual(deal.players.map((player) => player.id), [g1.playerId, g2.playerId, table.hostPlayerId], "Fisher-Yates over the injected source");
      assert.deepEqual(deal.players.map((player) => player.nickname), ["Player", "Player", "Hana"]);
      assert.equal(deal.variants.rules, CURRENT_RULES_REVISION);
      assert.equal(deal.build, BUILD);
      assert.equal(deal.rules_engine_version, RULES_ENGINE_VERSION);
      assert.equal(RULES_ENGINE_VERSION, 10);
      assert.equal(deals[0].actor, table.hostPlayerId, "the deal's actor is the host's seat");
      // The equality fixture: the client-shaped deal (App.tsx) with the same roster reaches the same board.
      const probe = probeSession("fixture");
      const replayed = probe.submit({
        actor: table.hostPlayerId,
        build: BUILD,
        msg: { SetupGame: { players: deal.players, variants: { ...deal.variants }, build: BUILD } } as never,
        baseIndex: -1,
        submissionId: "fixture-deal",
      });
      assert.equal(replayed.kind, "applied");
      assert.equal(stateDigest(probe.state), catchUp.digest, "server-built and client-shaped deals are the same board");
      // The record follows the log: active, the turn order and the rules pin cached.
      await until(() => records.records.get(table.gameId)?.status === "active", "the record synced");
      const record = records.records.get(table.gameId) as GameRecord;
      assert.deepEqual(record.turn_order, deal.players.map((player) => player.id));
      assert.equal(record.rules_engine_version, RULES_ENGINE_VERSION);
      assert.equal(record.expires_at, null);
      assert.ok(record.started_at !== null);
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("an invalid roster never deals: too few for the table, or a roster source that names a stranger", async () => {
    const { server, port } = await serve();
    try {
      const table = await openTable(port, 2, { exactPlayers: 3 });
      await readyAll(table);
      const short = await op(table.host, { type: "start-game" }, table.gameId);
      assert.equal(short.code, "not-ready");
      assert.match(String(short.reason), /exactly 3/);
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
    const control = controlledStore();
    const rogue = await serve({
      store: control.store,
      rosterSource: {
        plan: async (record) => ({ turnOrder: [...record.seats, { ...record.seats[0], player_id: "p-zzzzzzzzzzzzzzzz" }], variants: record.variants }),
      },
    });
    try {
      const table = await openTable(rogue.port, 2);
      await readyAll(table);
      const refused = await op(table.host, { type: "start-game" }, table.gameId);
      assert.equal(refused.ok, false, "assertDeal: a deal naming a player who holds no seat is a server bug, never dealt");
      assert.equal(control.log(table.gameId).length, 0);
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(rogue.server);
    }
  });

  test("durable before visible around the deal: a held append shows nothing, a failed one deals nothing, and a restart never re-deals", async () => {
    const control = controlledStore();
    const records = createMemoryRecordStore();
    const first = await serve({ store: control.store, records });
    let digestBefore = "";
    let gameId = "";
    try {
      const table = await openTable(first.port, 2);
      gameId = table.gameId;
      await readyAll(table);
      const waitingRecord = JSON.parse(JSON.stringify(records.records.get(gameId))) as GameRecord;
      control.control.holdAppends = true;
      const pending = sendOp(table.host, { type: "start-game" }, gameId);
      const held = await control.nextHeldAppend();
      logHello(table.guests[0].client, gameId);
      const early = await frameWhere(table.guests[0].client, (frame) => frame.kind === "catch-up", "a catch-up while the deal is held");
      assert.equal((early.entries as unknown[]).length, 0, "nothing is visible before the store has it");
      held.fail();
      const failed = await ackOf(table.host, pending);
      assert.equal(failed.code, "unavailable");
      assert.equal(control.log(gameId).length, 0);
      assert.equal(records.records.get(gameId)?.status, "waiting");
      control.control.holdAppends = false;
      const dealt = await op(table.host, { type: "start-game" }, gameId);
      assert.equal(dealt.ok, true);
      assert.equal(dealsIn(control.log(gameId)).length, 1);
      await until(() => records.records.get(gameId)?.status === "active", "the record synced");
      logHello(table.host, gameId);
      digestBefore = String((await frameWhere(table.host, (frame) => frame.kind === "catch-up", "the host's catch-up")).digest);
      // A crash between the deal's append and the record's update: the store holds the deal and a waiting record.
      records.records.set(gameId, waitingRecord);
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(first.server);
    }
    const second = await serve({ store: control.store, records });
    try {
      const host = await Client.open(second.port, "t" + String(tables) + "-host");
      host.send({ kind: "room-hello", gameId, build: BUILD });
      logHello(host, gameId);
      const catchUp = await frameWhere(host, (frame) => frame.kind === "catch-up", "the catch-up after the restart");
      assert.equal(catchUp.digest, digestBefore, "the stored deal replays to the same board: nothing is re-shuffled");
      await until(() => viewOf(host, gameId)?.lifecycle === "active", "the log wins over the lagging record");
      await until(() => records.records.get(gameId)?.status === "active", "the record repaired at load");
      const again = await op(host, { type: "start-game" }, gameId);
      assert.equal(dataOf(again).alreadyStarted, true);
      assert.equal(dealsIn(control.log(gameId)).length, 1, "one deal, ever");
      await host.close();
    } finally {
      await stopServer(second.server);
    }
  });
});

/* ==================================================================
    SUBMIT: the seat gate; the actor is the seat's player id
   ================================================================== */

describe("LIVE-2C submit", () => {
  test("a non-seated sender is refused for every message family, and nothing is appended or remembered", async () => {
    const control = controlledStore();
    const { server, port } = await serve({ store: control.store });
    try {
      const table = await startedTable(port, 2);
      const watcher = await Client.open(port, "watcher");
      logHello(watcher, table.gameId);
      await until(() => watcher.seen().length > 0, "the watcher's catch-up");
      const before = control.log(table.gameId).length;
      const families: Array<[string, object, string]> = [
        ["waterfall", BUY, "not-seated"],
        ["pass", { PassTurn: { game_id: 0 } }, "not-seated"],
        ["undo", { RevertTo: { index: 1, player: "x", summary: "undo" } }, "not-seated"],
        ["close", { CloseRoom: {} }, "not-seated"],
        ["deal", { SetupGame: { players: [{ id: "p-x", nickname: "X" }, { id: "p-y", nickname: "Y" }], variants: {} } }, "bad-frame"],
      ];
      for (const [label, msg] of families) watcher.submit(msg, { baseIndex: lastIndexSeen(watcher), submissionId: `w-${label}` });
      for (const [label, , code] of families) assert.equal((await watcher.answerTo(`w-${label}`)).code, code, label);
      assert.equal(control.log(table.gameId).length, before, "nothing appended");
      // A frame cannot name its actor: the field is not in the schema.
      assert.equal(parseClientFrame({ kind: "submit", build: BUILD, msg: BUY, baseIndex: 0, submissionId: "a", actor: table.hostPlayerId }).ok, false);
      watcher.send({ kind: "submit", build: BUILD, msg: BUY, baseIndex: lastIndexSeen(watcher), submissionId: "w-actor", actor: table.hostPlayerId });
      assert.equal((await watcher.answerTo("w-actor")).code, "bad-frame");
      // A seat's move is logged as its player id -- never the principal, never the development claim.
      const bought = await play(table.host, BUY, "h-buy");
      assert.equal(bought.kind, "applied");
      const actors = new Set(control.log(table.gameId).filter((entry) => !entry.derived).map((entry) => entry.actor));
      assert.deepEqual([...actors].sort(), [table.hostPlayerId].sort());
      assert.equal(JSON.stringify(control.log(table.gameId)).includes("pr_"), false, "no principal id in the log");
      assert.equal(JSON.stringify(control.log(table.gameId)).includes(table.host.claim), false, "no claim in the log");
      // A seat cannot deal either: the deal is the server's.
      assert.equal((await play(table.host, { SetupGame: { players: [{ id: table.hostPlayerId, nickname: "H" }, { id: table.guests[0].playerId, nickname: "G" }], variants: {} } }, "h-deal")).code, "bad-frame");
      await Promise.all([...everyone(table), watcher].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("a stale binding is refused: a released seat before the deal, and a host's reach after the host moved on", async () => {
    const control = controlledStore();
    const { server, port } = await serve({ store: control.store });
    try {
      const waiting = await openTable(port, 3);
      const leaver = waiting.guests[1];
      logHello(leaver.client, waiting.gameId);
      await until(() => leaver.client.of("catch-up").length === 1, "the leaver's catch-up");
      assert.equal((await op(leaver.client, { type: "release-seat" }, waiting.gameId)).ok, true);
      assert.equal((await play(leaver.client, BUY, "stale-1")).code, "not-seated");

      const table = await startedTable(port, 2);
      const guest = table.guests[0];
      const hostBuy = await play(table.host, BUY, "h1");
      assert.equal(hostBuy.kind, "applied");
      await until(() => lastIndexSeen(guest.client) >= lastIndexSeen(table.host), "the guest sees the host's move");
      const guestBuy = await play(guest.client, BUY, "g1");
      assert.equal(guestBuy.kind, "applied");
      const guestIndex = (guestBuy.entries as ServerLogEntry[]).find((entry) => entry.actor === guest.playerId)?.index as number;
      assert.equal((await op(table.host, { type: "transfer-host", toPlayerId: guest.playerId }, table.gameId)).ok, true, "host transfer works while playing");
      await until(() => lastIndexSeen(table.host) >= guestIndex, "the host sees the guest's move");
      const revert = { RevertTo: { index: guestIndex, player: "anyone", summary: "undo" } };
      const stale = await play(table.host, revert, "old-host-undo");
      assert.equal(stale.kind, "refused");
      assert.equal(stale.reason, REVERT_NOT_YOURS, "the old host's reach went with the role, at once");
      await Promise.all([...everyone(waiting), ...everyone(table)].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    UNDO over the wire
   ================================================================== */

describe("LIVE-2C undo in a server-owned game", () => {
  test("the host takes back anyone's last action, a seat only its own, the deal never, and the budget is the seat's", async () => {
    const control = controlledStore();
    const { server, port } = await serve({ store: control.store, limits: { selfRevertsPerHour: 1 } });
    try {
      const table = await startedTable(port, 2);
      const guest = table.guests[0];
      const dealIndex = dealsIn(control.log(table.gameId))[0].index;
      const hostBuy = await play(table.host, BUY, "h1");
      const hostIndex = (hostBuy.entries as ServerLogEntry[]).find((entry) => entry.actor === table.hostPlayerId)?.index as number;
      await until(() => lastIndexSeen(guest.client) >= hostIndex, "the guest sees it");
      const guestBuy = await play(guest.client, BUY, "g1");
      const guestIndex = (guestBuy.entries as ServerLogEntry[]).find((entry) => entry.actor === guest.playerId)?.index as number;
      await until(() => lastIndexSeen(table.host) >= guestIndex, "the host sees it");
      const undo = (index: number) => ({ RevertTo: { index, player: "whoever", summary: "undo" } });
      assert.equal((await play(guest.client, undo(hostIndex), "g-undo-host")).reason, REVERT_NOT_YOURS);
      assert.equal((await play(table.host, undo(dealIndex), "h-undo-deal")).reason, REVERT_DEAL_FLOOR);
      const taken = await play(table.host, undo(guestIndex), "h-undo-guest");
      assert.equal(taken.kind, "applied", "the no-money host takes back another seat's last action");
      const committed = JSON.parse(control.log(table.gameId).find((entry) => entry.submission_id === "h-undo-guest")?.payload ?? "{}");
      assert.equal(committed.RevertTo.player, table.hostPlayerId, "the committed revert names the seat that pressed it");
      // The seat's own budget: one self-revert an hour here.
      await until(() => lastIndexSeen(guest.client) >= lastIndexSeen(table.host), "the guest caught up");
      const again = await play(guest.client, BUY, "g2");
      const againIndex = (again.entries as ServerLogEntry[]).find((entry) => entry.actor === guest.playerId)?.index as number;
      assert.equal((await play(guest.client, undo(againIndex), "g-undo-1")).kind, "applied");
      const redo = await play(guest.client, BUY, "g3");
      const redoIndex = (redo.entries as ServerLogEntry[]).find((entry) => entry.actor === guest.playerId)?.index as number;
      const limited = await play(guest.client, undo(redoIndex), "g-undo-2");
      assert.equal(limited.code, "rate-limited");
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    RACES (LIVE-2 §14.3): each game's ops are one queue; every op is judged on the record committed when it runs
   ================================================================== */

describe("LIVE-2C races", () => {
  test("two joins for the last seat, and one principal claiming a seat from two tabs: one seat each, never two", async () => {
    const { server, port } = await serve();
    try {
      for (let round = 0; round < 3; round += 1) {
        const table = await openTable(port, 1, { exactPlayers: 2 });
        const [a, b] = await Promise.all([Client.open(port, `racer-a${round}`), Client.open(port, `racer-b${round}`)]);
        const [ja, jb] = await Promise.all([a, b].map((who) => ackOf(who, sendOp(who, { type: "join", code: table.code, takeSeat: true }))));
        const seated = [ja, jb].filter((answer) => dataOf(answer).playerId !== null);
        assert.equal(seated.length, 1, "exactly one of two racers took the last seat");
        const record = (await server.records.load(table.gameId)) as GameRecord;
        assert.equal(record.seats.length, 2);
        const tabs = await Promise.all([0, 1].map(() => Client.open(port, `twin-${round}`)));
        const third = await openTable(port, 1);
        const claims = await Promise.all(tabs.map((tab) => ackOf(tab, sendOp(tab, { type: "join", code: third.code, takeSeat: true }))));
        assert.equal(dataOf(claims[0]).playerId, dataOf(claims[1]).playerId, "one principal, one seat");
        assert.equal(((await server.records.load(third.gameId)) as GameRecord).seats.length, 2);
        await Promise.all([table.host, a, b, third.host, ...tabs].map((who) => who.close()));
      }
    } finally {
      await stopServer(server);
    }
  });

  test("start against the final ready, a leave and a release: the deal names exactly the seats that were there and ready", async () => {
    const control = controlledStore();
    const records = createMemoryRecordStore();
    const { server, port } = await serve({ store: control.store, records });
    try {
      for (let round = 0; round < 4; round += 1) {
        const table = await openTable(port, 3);
        const [g1, g2] = table.guests;
        await op(table.host, { type: "set-ready", ready: true }, table.gameId);
        await op(g1.client, { type: "set-ready", ready: true }, table.gameId);
        const racingReady = sendOp(g2.client, { type: "set-ready", ready: true }, table.gameId);
        const racingStart = sendOp(table.host, { type: "start-game" }, table.gameId);
        const [ready, start] = await Promise.all([ackOf(g2.client, racingReady), ackOf(table.host, racingStart)]);
        assert.equal(ready.ok, true);
        if (!start.ok) {
          assert.equal(start.code, "not-ready", "start ran first and saw an unready seat");
          assert.equal(dealsIn(control.log(table.gameId)).length, 0);
          assert.equal((await op(table.host, { type: "start-game" }, table.gameId)).ok, true);
        }
        assert.equal(dealsIn(control.log(table.gameId)).length, 1);

        // Start against a leave (and against a release) on a fresh table: one or the other happened first, never both halfway.
        const other = await openTable(port, 3);
        await readyAll(other);
        const [o1, o2] = other.guests;
        const leaving = sendOp(o2.client, { type: round % 2 === 0 ? "leave" : "release-seat" }, other.gameId);
        const starting = sendOp(other.host, { type: "start-game" }, other.gameId);
        const [left, began] = await Promise.all([ackOf(o2.client, leaving), ackOf(other.host, starting)]);
        assert.equal(began.ok, true, JSON.stringify(began));
        const deal = JSON.parse(dealsIn(control.log(other.gameId))[0].payload).SetupGame as { players: Array<{ id: string }> };
        await until(() => records.records.get(other.gameId)?.status === "active", "synced");
        const seats = (records.records.get(other.gameId) as GameRecord).seats.map((seat) => seat.player_id);
        assert.deepEqual(deal.players.map((player) => player.id).sort(), [...seats].sort(), "the deal is the record's seats");
        if (seats.includes(o2.playerId)) assert.ok(!left.ok || dataOf(left).gameId === undefined, "the leave came after the deal: a dealt seat is never abandoned");
        else assert.equal(left.ok, true);
        assert.ok(deal.players.some((player) => player.id === o1.playerId));
        await Promise.all([...everyone(table), ...everyone(other)].map((who) => who.close()));
      }
    } finally {
      await stopServer(server);
    }
  });

  test("two starts at once, start against a host transfer, and cancel against start: at most one deal, and only by a host", async () => {
    const control = controlledStore();
    const { server, port } = await serve({ store: control.store });
    try {
      for (let round = 0; round < 3; round += 1) {
        const table = await openTable(port, 2);
        await readyAll(table);
        const twin = await Client.open(port, table.host.claim); // the host's second tab
        const [s1, s2] = await Promise.all([table.host, twin].map((tab) => ackOf(tab, sendOp(tab, { type: "start-game" }, table.gameId))));
        assert.deepEqual([s1.ok, s2.ok], [true, true]);
        assert.equal([s1, s2].filter((answer) => dataOf(answer).alreadyStarted === true).length, 1, "one dealt, one told it already had");
        assert.equal(dealsIn(control.log(table.gameId)).length, 1);

        const moving = await openTable(port, 2);
        await readyAll(moving);
        const movingTwin = await Client.open(port, moving.host.claim);
        const transfer = sendOp(movingTwin, { type: "transfer-host", toPlayerId: moving.guests[0].playerId }, moving.gameId);
        const start = sendOp(moving.host, { type: "start-game" }, moving.gameId);
        const [moved, began] = await Promise.all([ackOf(movingTwin, transfer), ackOf(moving.host, start)]);
        assert.equal(moved.ok, true, "a transfer is legal before and after the deal");
        if (began.ok) assert.equal(dealsIn(control.log(moving.gameId)).length, 1);
        else {
          assert.equal(began.code, "forbidden", "the transfer ran first: the old host cannot start");
          assert.equal(dealsIn(control.log(moving.gameId)).length, 0);
        }

        const ending = await openTable(port, 2);
        await readyAll(ending);
        const endingTwin = await Client.open(port, ending.host.claim);
        const cancel = sendOp(endingTwin, { type: "cancel-room" }, ending.gameId);
        const go = sendOp(ending.host, { type: "start-game" }, ending.gameId);
        const [cancelled, went] = await Promise.all([ackOf(endingTwin, cancel), ackOf(ending.host, go)]);
        assert.equal([cancelled.ok, went.ok].filter(Boolean).length, 1, "exactly one of cancel and start");
        assert.equal(dealsIn(control.log(ending.gameId)).length, went.ok ? 1 : 0);
        if (!went.ok) assert.equal(went.code, "gone");
        else assert.equal(cancelled.code, "wrong-state");
        await Promise.all([...everyone(table), twin, ...everyone(moving), movingTwin, ...everyone(ending), endingTwin].map((who) => who.close()));
      }
    } finally {
      await stopServer(server);
    }
  });

  test("a host op racing the host's own transfer is judged on the record committed when it runs", async () => {
    const { server, port } = await serve();
    try {
      for (let round = 0; round < 3; round += 1) {
        const table = await openTable(port, 3);
        const [heir, target] = table.guests;
        const twin = await Client.open(port, table.host.claim);
        const handover = sendOp(twin, { type: "transfer-host", toPlayerId: heir.playerId }, table.gameId);
        const removal = sendOp(table.host, { type: "kick", playerId: target.playerId }, table.gameId);
        const [moved, kicked] = await Promise.all([ackOf(twin, handover), ackOf(table.host, removal)]);
        assert.equal(moved.ok, true);
        const record = (await server.records.load(table.gameId)) as GameRecord;
        assert.equal(record.host_player_id, heir.playerId);
        if (kicked.ok) assert.equal(record.seats.some((seat) => seat.player_id === target.playerId), false);
        else {
          assert.equal(kicked.code, "forbidden");
          assert.equal(record.seats.some((seat) => seat.player_id === target.playerId), true);
        }
        await Promise.all([...everyone(table), twin].map((who) => who.close()));
      }
    } finally {
      await stopServer(server);
    }
  });

  test("a record write that fails is invisible and the previous record stands; an unknown outcome holds the game for a restart", async () => {
    const records = createMemoryRecordStore();
    const restarts: string[] = [];
    const { server, port } = await serve({ records, onRestartRequired: (room) => restarts.push(room) });
    try {
      const table = await openTable(port, 2);
      const guest = table.guests[0];
      table.host.send({ kind: "room-hello", gameId: table.gameId, build: BUILD });
      await until(() => viewOf(table.host, table.gameId) !== undefined, "the host's view");
      const viewsBefore = table.host.of("room").length;
      records.failPuts.push("definite");
      const refused = await op(guest.client, { type: "set-ready", ready: true }, table.gameId);
      assert.equal(refused.code, "unavailable");
      assert.equal(records.records.get(table.gameId)?.seats[1].ready, false, "the previous record stands");
      await sleep(30);
      assert.equal(table.host.of("room").length, viewsBefore, "nothing was published");
      assert.equal((await op(guest.client, { type: "set-ready", ready: true }, table.gameId)).ok, true, "the next write lands");
      await until(() => viewOf(table.host, table.gameId)?.players[1].isReady === true, "the ready, published");

      records.failPuts.push("uncertain");
      assert.equal((await op(guest.client, { type: "set-profile", nickname: "Maybe" }, table.gameId)).code, "unavailable");
      assert.deepEqual(restarts, [table.gameId], "only a restart resolves an unknown outcome");
      assert.equal((await op(table.host, { type: "set-ready", ready: true }, table.gameId)).code, "unavailable", "the game is held");
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("the join-code index: a failed claim creates nothing; a failed record leaves only an orphan that opens nothing", async () => {
    const records = createMemoryRecordStore();
    const { server, port } = await serve({ records });
    try {
      const host = await Client.open(port, "indexer");
      records.failClaims.push(1);
      const noCode = await op(host, CREATE());
      assert.equal(noCode.code, "unavailable");
      assert.equal(records.records.size, 0);
      assert.equal(records.codes.size, 0);
      records.failPuts.push("definite");
      const noRecord = await op(host, CREATE());
      assert.equal(noRecord.code, "unavailable");
      assert.equal(records.records.size, 0);
      await until(() => records.codes.size === 0, "the claimed code released after the failed record");
      const made = await op(host, CREATE());
      assert.equal(made.ok, true);
      assert.deepEqual([...records.codes.entries()], [[dataOf(made).code, dataOf(made).gameId]]);
      await host.close();
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    THE INDEPENDENT REVIEW'S FINDINGS, PINNED (H1, M1-M4, L2-L7, I1)
   ================================================================== */

describe("LIVE-2C review fixes", () => {
  test("H1: a game still loading is not resident to any read -- the list timer and a closing socket never meet it", async () => {
    const control = controlledStore();
    const records = createMemoryRecordStore();
    const first = await serve({ store: control.store, records });
    let gameId = "";
    try {
      const table = await openTable(first.port, 2);
      gameId = table.gameId;
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(first.server);
    }
    const second = await serve({ store: control.store, records, rooms: { listCoalesceMs: 20 } });
    try {
      const lister = await Client.open(second.port, "lister");
      lister.send({ kind: "rooms-watch", on: true });
      await frameWhere(lister, (frame) => frame.kind === "rooms", "the first list");
      control.control.loadDelayMs = 300; // the restart's first load of the game takes a while
      const viewer = await Client.open(second.port, "slow-viewer");
      viewer.send({ kind: "room-hello", gameId, build: BUILD });
      await sleep(30);
      const other = await openTable(second.port, 1); // a publish: the list timer fires while the game loads
      await until(() => lister.of("rooms").length >= 2, "a list built while a game was loading");
      await viewer.close(); // a socket closing while its game loads
      control.control.loadDelayMs = 0;
      const again = await Client.open(second.port, "viewer-again");
      again.send({ kind: "room-hello", gameId, build: BUILD });
      await until(() => viewOf(again, gameId) !== undefined, "the game, loaded");
      assert.equal(second.server.socketCounts().total >= 2, true, "the server is still up and serving");
      await Promise.all([lister, other.host, again].map((who) => who.close()));
    } finally {
      await stopServer(second.server);
    }
  });

  test("M1: the file record store remembers nothing about game ids that do not exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live2c-m1-"));
    try {
      const store = createFileRecordStore(dir, { warn: () => undefined });
      await Promise.all(Array.from({ length: 300 }, () => store.load(mintGameId())));
      await sleep(10);
      assert.deepEqual(store.sizes(), { chains: 0, versions: 0 });
      const record = baseRecord("public");
      assert.equal((await store.put(record, null)).kind, "committed");
      await sleep(10);
      assert.deepEqual(store.sizes(), { chains: 0, versions: 1 }, "only a game that exists is remembered");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("M2: a name the shared sanitizer is not idempotent on is stored as its fixpoint, and the table still deals", async () => {
    const { server, port } = await serve();
    try {
      const table = await openTable(port, 2);
      const guest = table.guests[0];
      for (const odd of ["a \u200b b", "e\u200d\u0301", "x\u00ady", "p\u2060 \u2060q"]) {
        const renamed = await op(guest.client, { type: "set-profile", nickname: odd }, table.gameId);
        if (!renamed.ok) continue;
        const stored = ((await server.records.load(table.gameId)) as GameRecord).seats[1].nickname;
        assert.equal(sanitizeName(stored, 24), stored, `a stored name is a fixpoint (${JSON.stringify(odd)})`);
      }
      await readyAll(table);
      const started = await op(table.host, { type: "start-game" }, table.gameId);
      assert.equal(started.ok, true, JSON.stringify(started));
      await Promise.all(everyone(table).map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("L2: seats being claimed at once across tables count against the seated cap", async () => {
    const { server, port } = await serve({ rooms: { maxSeatedGames: 2 } });
    try {
      const tablesOpen = await Promise.all([0, 1, 2, 3].map(() => openTable(port, 1)));
      const tabs = await Promise.all(tablesOpen.map(() => Client.open(port, "greedy")));
      const answers = await Promise.all(tabs.map((tab, n) => ackOf(tab, sendOp(tab, { type: "join", code: tablesOpen[n].code, takeSeat: true }))));
      const seated = answers.filter((answer) => answer.ok && dataOf(answer).playerId !== null).length;
      assert.ok(seated <= 2, `${seated} seats for a cap of 2`);
      assert.ok(answers.some((answer) => answer.code === "limit-reached"));
      await Promise.all([...tabs, ...tablesOpen.map((table) => table.host)].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("L4: an outsider's op on a private table is not-found before anything else -- not gone, not unavailable, not the cap", async () => {
    const clock = { now: Date.now() };
    const records = createMemoryRecordStore();
    const { server, port } = await serve({ records, identity: devIdentity({ now: () => clock.now }), rooms: { maxSeatedGames: 1 } });
    try {
      const secret = await openTable(port, 1, { visibility: "private" });
      const outsider = await Client.open(port, "nosy");
      const mine = await op(outsider, CREATE()); // the outsider is at the seated cap now
      assert.equal(mine.ok, true);
      assert.equal((await op(outsider, { type: "take-seat" }, secret.gameId)).code, "not-found", "the cap does not answer first");
      clock.now += WAITING_TTL_MS + 1;
      assert.equal((await op(outsider, { type: "leave" }, secret.gameId)).code, "not-found", "nor does the TTL");
      assert.equal(records.records.get(secret.gameId)?.status, "waiting", "and an outsider's op never commits the expiry");
      await Promise.all([secret.host, outsider].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("L5, L6, L7, I1: the viewer cap counts log readers; code rotations are budgeted; an unknown create keeps its claim; going private twice is calm", async () => {
    const records = createMemoryRecordStore();
    const record = baseRecord("public");
    const capped = { ...record, created_at: Date.now(), expires_at: Date.now() + WAITING_TTL_MS, policy: { ...record.policy, max_viewers: 1 } };
    assert.equal((await records.put(capped, null)).kind, "committed");
    const { server, port } = await serve({ records, rooms: { codeRotationsPerGame: { capacity: 2, refillPerSecond: 0.0001 } } });
    try {
      const reader = await Client.open(port, "log-reader");
      logHello(reader, capped.game_id);
      await until(() => reader.of("catch-up").length === 1, "the first watcher's catch-up");
      const second = await Client.open(port, "second-reader");
      logHello(second, capped.game_id);
      assert.equal((await frameWhere(second, (frame) => frame.kind === "error", "the cap")).code, "room-full");

      const table = await openTable(port, 1);
      const [a, b] = [sendOp(table.host, { type: "set-visibility", visibility: "private" }, table.gameId), sendOp(table.host, { type: "set-visibility", visibility: "private" }, table.gameId)];
      assert.deepEqual([(await ackOf(table.host, a)).ok, (await ackOf(table.host, b)).ok], [true, true]);
      assert.equal((await op(table.host, { type: "rotate-code" }, table.gameId)).code, "rate-limited", "two rotations a while: the third waits");
      assert.equal(server.rooms.denied["code-rotations"], 1);

      records.failPuts.push("uncertain");
      const unknown = await op(table.host, CREATE());
      assert.equal(unknown.code, "unavailable");
      const landed = [...records.records.values()].find((entry) => entry.game_id !== capped.game_id && entry.game_id !== table.gameId) as GameRecord;
      assert.ok(landed !== undefined, "the uncertain write landed");
      assert.equal(records.codes.get(landed.join_code as string), landed.game_id, "its claim is kept: the record may name it");
      await Promise.all([reader, second, table.host].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    MODE: the legacy room protocol is development-only; production fails closed
   ================================================================== */

describe("LIVE-2C mode", () => {
  test("a production server refuses to exist with any legacy handler; development registers them beside the new protocol", async () => {
    assert.ok(LEGACY_ROOM_HANDLERS.length > 0, "this build still carries the legacy handlers (LIVE-2D deletes them)");
    for (const kind of ["room-write", "seat-pin", "claim-seat", "lobby-hello", "lobby-watch", "lobby-write", "hello {room}", "room-hello {room}", "chat-send {room}", "presence-set {room}"]) {
      assert.ok(LEGACY_ROOM_HANDLERS.includes(kind), kind);
    }
    assert.throws(
      () => createGameServer({ port: 0, build: BUILD, identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0 }, legacyRoomProtocol: true }),
      /production mode refuses the legacy room protocol/,
    );
    const { server } = await serve();
    try {
      assert.equal(server.legacyRoomProtocol, true);
    } finally {
      await stopServer(server);
    }
    const off = await serve({ legacyRoomProtocol: false });
    try {
      assert.equal(off.server.legacyRoomProtocol, false);
      const client = await Client.open(off.port, "no-legacy");
      client.roomHello("JUNO-OLD");
      client.send({ kind: "lobby-hello" });
      await until(() => client.of("error").length === 2, "two refusals");
      assert.ok(client.of("error").every((frame) => frame.code === "bad-frame"));
      await client.close();
    } finally {
      await stopServer(off.server);
    }
  });

  test("development: the legacy protocol can never touch a server-owned game (any case of its id)", async () => {
    const control = controlledStore();
    const { server, port } = await serve({ store: control.store });
    try {
      const table = await startedTable(port, 2);
      /* Every spelling that reaches the same storage key: the case (a case-insensitive disk), and any character the
         file store maps to `_` (review M3). */
      const ids = [table.gameId, table.gameId.toUpperCase(), `G_${table.gameId.slice(2)}`, `g.${table.gameId.slice(2)}`, `g~${table.gameId.slice(2)}`];
      const intruders: Client[] = [];
      for (const room of ids) {
        const intruder = await Client.open(port, "intruder"); // one socket each: inside LIVE-2A's malformed budget
        intruders.push(intruder);
        intruder.hello(room);
        intruder.roomHello(room);
        intruder.roomWrite(room, { op: "host", hostId: "intruder", nickname: "I", variants: {} });
        intruder.send({ kind: "chat-send", room, text: "hi" });
        await until(() => intruder.of("error").length === 4, "every legacy frame refused");
        assert.ok(intruder.of("error").every((frame) => frame.code === "bad-frame"));
        intruder.submit(BUY, { baseIndex: 5, submissionId: "sneak" });
        assert.notEqual((await intruder.answerTo("sneak")).kind, "applied", "never attached, so nothing to submit into");
      }
      assert.equal(control.doc(table.gameId), null, "no legacy room document was written for the game");
      assert.equal(control.log(table.gameId).filter((entry) => entry.actor === "intruder").length, 0);
      await Promise.all([...everyone(table), ...intruders].map((who) => who.close()));
    } finally {
      await stopServer(server);
    }
  });

  test("spawned: GS_MODE=production exits 2 while the build carries the legacy protocol; development starts and says so", async () => {
    const start = path.join(__dirname, "..", "start.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live2c-start-"));
    const run = (env: Record<string, string>) => {
      const clean: NodeJS.ProcessEnv = { ...process.env };
      for (const name of ["GS_MODE", "GS_ALLOWED_ORIGINS", "GS_TRUSTED_PROXY_HOPS", "INSECURE_LOCAL_IDENTITY", "LEGACY_LOGS", "EXPLAIN_DIVERGENCE"]) delete clean[name];
      const child = spawn(process.execPath, [start, "--port", "0", "--data", path.join(dir, env.GS_MODE)], { env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += String(chunk)));
      child.stderr.on("data", (chunk) => (out += String(chunk)));
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      return { child, output: () => out, exited };
    };
    try {
      const prod = run({ GS_MODE: "production", GS_ALLOWED_ORIGINS: PROD_ORIGIN, GS_TRUSTED_PROXY_HOPS: "1" });
      assert.equal(await prod.exited, 2, prod.output());
      assert.match(prod.output(), /Refusing to start: GS_MODE=production is not available in this build/);
      assert.match(prod.output(), /room-write/);
      assert.equal(fs.existsSync(path.join(dir, "production")), false, "refused before the data directory was touched");
      const dev = run({ GS_MODE: "development" });
      const deadline = Date.now() + 20_000;
      while (!/GS_MODE=development/.test(dev.output()) && Date.now() < deadline) await sleep(20);
      assert.match(dev.output(), /the server-owned protocol \(room-op, GameRecords in games\/\)/);
      assert.ok(fs.existsSync(path.join(dir, "development")));
      dev.child.kill("SIGTERM");
      await dev.exited;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ==================================================================
    REGRESSION: the ordinary local development flow on the server-owned protocol
   ================================================================== */

describe("LIVE-2C local flow", () => {
  test("host -> join -> ready -> start -> move -> undo -> close, then back -- and no principal id anywhere", async () => {
    const control = controlledStore();
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message}` : String(arg))).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    const { server, port } = await serve({ store: control.store, shuffle: undefined });
    try {
      const alice = await Client.open(port, "alice");
      const created = await op(alice, CREATE({ nickname: "Alice" }));
      const { gameId, code } = dataOf(created) as { gameId: string; code: string };
      alice.send({ kind: "room-hello", gameId, build: BUILD });
      const bob = await Client.open(port, "bob");
      const joined = await op(bob, { type: "join", code, takeSeat: true });
      assert.equal(joined.ok, true);
      assert.equal((await op(bob, { type: "set-profile", nickname: "Bob", color: SEAT_COLORS[1] }, gameId)).ok, true);
      bob.send({ kind: "room-hello", gameId, build: BUILD });
      await until(() => viewOf(alice, gameId)?.players.length === 2 && viewOf(alice, gameId)?.players[1].nickname === "Bob", "Bob at the table");
      for (const who of [alice, bob]) await op(who, { type: "set-ready", ready: true }, gameId);
      await until(() => viewOf(alice, gameId)?.you.canStart === true, "Alice may start");
      bob.send({ kind: "chat-send", gameId, text: "ready when you are" });
      await until(() => alice.of("chat").some((frame) => (frame.messages as unknown[]).length === 1), "the chat line");
      assert.equal((await op(alice, { type: "start-game" }, gameId)).ok, true);
      await until(() => viewOf(bob, gameId)?.status === "playing", "the room playing");
      for (const who of [alice, bob]) logHello(who, gameId);
      await until(() => alice.seen().length > 0 && bob.seen().length > 0, "both caught up");
      const deal = JSON.parse(dealsIn(control.log(gameId))[0].payload).SetupGame as { players: Array<{ id: string }> };
      const seats = new Map([[dataOf(created).playerId as string, alice], [dataOf(joined).playerId as string, bob]]);
      const first = seats.get(deal.players[0].id) as Client;
      const moved = await play(first, BUY, "move");
      assert.equal(moved.kind, "applied");
      const movedIndex = (moved.entries as ServerLogEntry[]).find((entry) => entry.actor === deal.players[0].id)?.index as number;
      const undone = await play(first, { RevertTo: { index: movedIndex, player: "me", summary: "undo" } }, "undo");
      assert.equal(undone.kind, "applied", "one-step undo of one's own move");
      assert.equal((await play(alice, { CloseRoom: {} }, "close-early")).reason, "The game is not over yet.", "the rules still decide CloseRoom");
      for (const who of [alice, bob]) await who.close();
      await until(() => server.socketCounts().total === 0, "every socket closed");
      const again = await Client.open(port, "bob");
      logHello(again, gameId);
      const catchUp = await frameWhere(again, (frame) => frame.kind === "catch-up", "the catch-up");
      assert.equal((catchUp.entries as unknown[]).length, control.log(gameId).length, "back: caught up from the durable log");
      again.send({ kind: "room-hello", gameId, build: BUILD });
      await until(() => viewOf(again, gameId)?.you.role === "player", "still Bob's seat");
      assertNoPrincipalIds([alice, bob, again]);
      assert.equal(JSON.stringify(control.log(gameId)).includes("pr_"), false, "the log names seats, never principals");
      assert.equal(lines.some((line) => /pr_dev_/.test(line)), false, `no principal id in the server's window: ${lines.find((line) => /pr_dev_/.test(line))}`);
      await again.close();
    } finally {
      console.log = saved.log;
      console.warn = saved.warn;
      console.error = saved.error;
      await stopServer(server);
    }
  });
});
