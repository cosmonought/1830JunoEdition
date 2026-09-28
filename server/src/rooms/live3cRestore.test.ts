// server/src/rooms/live3cRestore.test.ts
//
// LIVE-3C: a hosted server restarted over its real file stores -- discovery of every durable game without loading
// one, the reconciliation table (the log wins; a disagreement holds), the durable hold and its only way out, the
// incompatible and read-only classes, the terminal seal and the settlement seam, waiting rooms that never start,
// archival, fencing, and the operator tool's inspect / release / gc. Restarts here are a server CLOSED and a new
// one STARTED over the same directory (the process-kill restarts are `live3cProcess.test.ts`).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createFileLogStore, type LogStore } from "../fileLogStore";
import type { GameServerOptions } from "../gameServer";
import { createJournalIdentityStore } from "../identity/journalStore";
import { serializeBatch } from "../persistence/logFormat";
import { createMemoryOpsRecorder, redactIdentity, type MemoryOpsRecorder } from "../persistence/opsRecorder";
import { acquireDataLock, LOCK_DIRECTORY, LOCK_STALE_AFTER_MS } from "../persistence/processLock";
import { StoreDefiniteError } from "../persistence/storeResult";
import { inspectData, planGc, releaseHold, runGc, verifyGame, withLock } from "../tools/gamesDoctor";
import { repairBytes } from "../tools/logDoctor";
import type { RoomSession, ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { mintGameId, type GameRecord } from "./gameRecord";
import { createFileHoldStore, createMemoryHoldStore, isGameHold, makeHold } from "./holdStore";
import {
  ARCHIVE_HOT_MS,
  COMPLETED_ARCHIVE_AFTER_MS,
  GAME_OVER_SENTENCE,
  GONE_SENTENCES,
  HELD_PLAYER_SENTENCE,
  NO_MONEY_SETTLEMENT,
  RECONCILING_SENTENCE,
  sealOf,
  type SettlementLifecycle,
  type TerminalSeal,
} from "./lifecycle";
import { createFileRecordStore, type RecordStore } from "./recordStore";
import { discoverGames } from "./discovery";
import { reconcileHead, reconcileLoaded } from "./reconcile";
import {
  ALICE,
  BOB,
  BUILD,
  BUY,
  CAROL,
  Client,
  devPrincipal,
  openGame,
  quietConsole,
  seededRecord,
  startServer,
  stopServer,
  storedLog,
  type Frame,
  type SeenEntry,
} from "./testSupport";

quietConsole();

const DAY = 24 * 60 * 60 * 1000;
const quiet = { warn: () => undefined };

/* ==================================================================
    FIXTURES: a data directory, its files, and a server over them
   ================================================================== */

function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `live3c-${tag}-`));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const recordPath = (dir: string, gameId: string) => path.join(dir, "games", `${gameId}.json`);
const logPath = (dir: string, gameId: string) => path.join(dir, `${gameId}.log.jsonl`);
const holdPath = (dir: string, gameId: string) => path.join(dir, "games", "holds", `${gameId}.json`);

function writeRecord(dir: string, record: GameRecord | string): void {
  fs.mkdirSync(path.join(dir, "games"), { recursive: true });
  const gameId = typeof record === "string" ? JSON.parse(record).game_id : record.game_id;
  fs.writeFileSync(recordPath(dir, gameId), typeof record === "string" ? record : `${JSON.stringify(record)}\n`);
}

/** Entries as the file store writes them: one stamped batch per entry. */
function writeLog(dir: string, gameId: string, entries: readonly ServerLogEntry[]): void {
  fs.writeFileSync(logPath(dir, gameId), entries.map((entry) => serializeBatch([entry])).join(""));
}

const readRecord = (dir: string, gameId: string) => JSON.parse(fs.readFileSync(recordPath(dir, gameId), "utf8")) as GameRecord;

/** A deal whose payload is rewritten (its pin, its build, its players). */
function withDeal(entries: readonly ServerLogEntry[], change: (setup: Record<string, unknown>) => void): ServerLogEntry[] {
  const payload = JSON.parse(entries[0].payload) as { SetupGame: Record<string, unknown> };
  change(payload.SetupGame);
  return [{ ...entries[0], payload: JSON.stringify(payload) }, ...entries.slice(1)];
}

/** A dealt game on disk: the seeded record (ALICE host, BOB) and a stored log with `buys` purchases. */
function dealtOnDisk(dir: string, buys = 1, over: { gameId?: string; record?: (record: GameRecord) => GameRecord; log?: (entries: ServerLogEntry[]) => ServerLogEntry[] } = {}): string {
  const gameId = over.gameId ?? mintGameId();
  const base = seededRecord([ALICE, BOB], { dealt: true, gameId });
  const log = storedLog(buys);
  // DA-8: the record caches the deal's pin, which `storedLog` deals at the current engine (was the literal 10).
  const record: GameRecord = { ...base, rules_engine_version: RULES_ENGINE_VERSION, started_at: log[0].at ?? Date.now() };
  writeRecord(dir, over.record ? over.record(record) : record);
  writeLog(dir, gameId, over.log ? over.log(log) : log);
  return gameId;
}

function waitingOnDisk(dir: string, over: (record: GameRecord) => GameRecord = (r) => r): string {
  const record = over(seededRecord([ALICE, BOB], { dealt: false }));
  writeRecord(dir, record);
  return record.game_id;
}

interface Booted {
  server: Awaited<ReturnType<typeof startServer>>["server"];
  port: number;
  ops: MemoryOpsRecorder;
}

/** A server over the file stores in `dir`, as `start.ts` wires them (identity aside), once discovery has run. */
async function boot(dir: string, over: Partial<GameServerOptions> = {}): Promise<Booted> {
  const store: LogStore = createFileLogStore(dir, quiet);
  if (store.loadChat) await store.loadChat("settle");
  const ops = createMemoryOpsRecorder();
  const { server, port } = await startServer({
    store,
    records: createFileRecordStore(dir, quiet),
    holds: createFileHoldStore(dir, quiet),
    ops,
    ...over,
  });
  await server.lifecycle.ready;
  return { server, port, ops };
}

/** An audit line, waited for: the record lands on disk first and the audit is written once its commit settles. */
async function audited(booted: Booted, match: (line: Record<string, unknown>) => boolean): Promise<boolean> {
  for (let tries = 0; tries < 400; tries += 1) {
    if (booted.ops.lines.some(match)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

const classOf = (booted: Booted, gameId: string) => booted.server.lifecycle.inventory().games.find((game) => game.gameId === gameId);

async function helloFrame(port: number, claim: string, gameId: string): Promise<Frame> {
  const client = await Client.open(port, claim);
  client.hello(gameId);
  const frame = await client.next((f) => f.kind === "catch-up" || f.kind === "error" || f.kind === "incompatible", `the hello's answer for ${gameId}`);
  await client.close();
  return frame;
}

async function roomFrame(port: number, claim: string, gameId: string): Promise<Frame> {
  const client = await Client.open(port, claim);
  client.roomHello(gameId);
  const frame = await client.next((f) => f.kind === "room" || f.kind === "error", `the room-hello's answer for ${gameId}`);
  await client.close();
  return frame;
}

/* ==================================================================
    1. DISCOVERY: every durable game, classified, before any is loaded
   ================================================================== */

describe("LIVE-3C discovery", () => {
  test("every class is found at startup from the record, the log's first line and the holds -- no actor is loaded, and each held game is written down", () =>
    withDir("discover", async (dir) => {
      const now = Date.now();
      const waiting = waitingOnDisk(dir);
      const active = dealtOnDisk(dir, 2);
      const completed = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: now - DAY }) });
      const cancelled = waitingOnDisk(dir, (r) => ({ ...r, status: "cancelled", cancelled_at: now - DAY, expires_at: null }));
      const expired = waitingOnDisk(dir, (r) => ({ ...r, expires_at: now - 1000 }));
      const archived = waitingOnDisk(dir, (r) => ({ ...r, status: "cancelled", cancelled_at: now - 20 * DAY, archived_at: now - 10 * DAY }));
      const aheadOfLog = mintGameId();
      writeRecord(dir, seededRecord([ALICE, BOB], { dealt: true, gameId: aheadOfLog })); // active, no log at all
      const roster = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, seats: [r.seats[0], { ...r.seats[1], player_id: CAROL, principal_id: "pr_dev_p-carol" }] }) });
      const newerPin = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, rules_engine_version: 99 }), log: (entries) => withDeal(entries, (setup) => (setup.rules_engine_version = 99)) });
      const olderBuild = dealtOnDisk(dir, 1, { log: (entries) => withDeal(entries, (setup) => (setup.build = "an-older-build")) });
      const unreadable = mintGameId();
      writeRecord(dir, JSON.stringify({ game_id: unreadable, record_schema: 1 }));
      const newerSchema = mintGameId();
      /* A FUTURE schema this build cannot read. Since ESCROW-4 schema 2 is current (a real-money table); a schema-1
         record merely relabelled 2 is a malformed current record, held `record-unreadable` -- not this case. */
      writeRecord(dir, JSON.stringify({ ...seededRecord([ALICE, BOB], { gameId: newerSchema }), record_schema: 3, extra: true }));
      const lagging = dealtOnDisk(dir, 0, { record: (r) => ({ ...r, status: "waiting", started_at: null, turn_order: null, rules_engine_version: null, expires_at: now + DAY }) });
      const orphan = mintGameId();
      writeLog(dir, orphan, storedLog(0));
      fs.writeFileSync(path.join(dir, "JUNO-ABC.log.jsonl"), "legacy\n");

      const booted = await boot(dir);
      try {
        assert.equal(booted.server.residentGames(), 0, "discovery loaded no actor");
        /* TWO STAGES: a started game is never called healthy (or completed) from its record and its first line. */
        const expect: Array<[string, string, string | null]> = [
          [waiting, "waiting", null],
          [active, "unreconciled", "claims-active"],
          [completed, "unreconciled", "claims-completed"],
          [cancelled, "cancelled", null],
          [expired, "expired", null],
          [archived, "archived", null],
          [aheadOfLog, "held", "record-ahead-of-log"],
          [roster, "held", "roster-mismatch"],
          [newerPin, "incompatible", "rules-version-newer"],
          [olderBuild, "unreconciled", "claims-active"],
          [unreadable, "held", "record-unreadable"],
          [newerSchema, "incompatible", "record-schema-newer"],
          [lagging, "unreconciled", "needs-repair"],
          [orphan, "attention", "orphan-log"],
        ];
        for (const [gameId, cls, code] of expect) {
          const found = booted.server.lifecycle.discovery()?.games.get(gameId);
          assert.deepEqual([found?.cls, found?.code ?? null], [cls, code], gameId);
          assert.deepEqual([classOf(booted, gameId)?.cls, classOf(booted, gameId)?.code ?? null], [cls, code], `${gameId}: the inventory says the same before any load`);
        }
        assert.match(booted.server.lifecycle.discovery()?.games.get(olderBuild)?.detail ?? "", /an-older-build/, "the build pin is noted for the operator");
        for (const gameId of [aheadOfLog, roster, unreadable]) {
          const hold = JSON.parse(fs.readFileSync(holdPath(dir, gameId), "utf8"));
          assert.ok(isGameHold(hold), `${gameId}'s hold is on disk`);
          assert.equal(hold.source, "discovery");
          assert.ok(!/pr_dev_|pr_[0-9a-z]{26}/.test(hold.detail), "no principal id in a hold's detail");
        }
        assert.ok(!fs.existsSync(holdPath(dir, newerPin)), "incompatible is derived, never a hold file");
        assert.equal(booted.ops.lines.filter((line) => line.event === "hold.created").length, 3);
        assert.ok(fs.readFileSync(path.join(dir, "JUNO-ABC.log.jsonl"), "utf8") === "legacy\n", "legacy files are never touched");
        const counts = booted.server.lifecycle.inventory().byClass;
        assert.equal(counts.held, 3);
        assert.equal(counts.unreconciled, 4);
        // STAGE TWO, lazily: each load replays the whole log and concludes.
        for (const [gameId, cls] of [[active, "active"], [olderBuild, "read-only"], [lagging, "active"]] as const) {
          await helloFrame(booted.port, ALICE, gameId);
          for (let tries = 0; tries < 400 && classOf(booted, gameId)?.cls !== cls; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
          assert.equal(classOf(booted, gameId)?.cls, cls, `${gameId} after its load`);
        }
        await booted.server.lifecycle.ops.flush();
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("one corrupt game among healthy ones: the corrupt one is held and written down, every other is served", () =>
    withDir("one-bad", async (dir) => {
      const healthy = [dealtOnDisk(dir, 1), dealtOnDisk(dir, 2)];
      const bad = dealtOnDisk(dir, 3);
      const log = storedLog(3);
      fs.writeFileSync(logPath(dir, bad), serializeBatch([log[0]]) + serializeBatch([log[1]]) + JSON.stringify(log[2]).slice(0, 40) + serializeBatch([log[2]]) + serializeBatch([log[3]]));
      const before = fs.readFileSync(logPath(dir, bad));
      const booted = await boot(dir);
      try {
        for (const gameId of healthy) assert.equal((await helloFrame(booted.port, ALICE, gameId)).kind, "catch-up", gameId);
        const held = await helloFrame(booted.port, ALICE, bad);
        assert.deepEqual([held.kind, held.code, held.reason], ["error", "held", HELD_PLAYER_SENTENCE]);
        assert.ok(fs.readFileSync(logPath(dir, bad)).equals(before), "the damaged log is untouched");
        assert.equal(JSON.parse(fs.readFileSync(holdPath(dir, bad), "utf8")).code, "log-corrupt", "the load wrote the hold down");
        assert.equal(classOf(booted, bad)?.cls, "held");
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("the join-code index is made to agree with the records: an unreadable index is rebuilt (the old one kept); two live records with one code are both held", () =>
    withDir("index", async (dir) => {
      const a = waitingOnDisk(dir, (r) => ({ ...r, join_code: "JUNO-AAAA-BBBB" }));
      const dupe1 = waitingOnDisk(dir, (r) => ({ ...r, join_code: "JUNO-CCCC-DDDD" }));
      const dupe2 = waitingOnDisk(dir, (r) => ({ ...r, join_code: "JUNO-CCCC-DDDD" }));
      fs.writeFileSync(path.join(dir, "games", "join-codes.json"), "{not json");
      const booted = await boot(dir);
      try {
        const index = JSON.parse(fs.readFileSync(path.join(dir, "games", "join-codes.json"), "utf8"));
        assert.equal(index.codes["JUNO-AAAA-BBBB"], a, "the live code resolves to its record again");
        assert.equal(index.codes["JUNO-CCCC-DDDD"], undefined, "a code two records claim is given to neither");
        assert.ok(fs.readdirSync(path.join(dir, "games")).some((name) => name.startsWith("join-codes.json.unreadable-")), "the unreadable index was kept aside");
        for (const gameId of [dupe1, dupe2]) assert.equal(classOf(booted, gameId)?.code, "duplicate-join-code");
        const client = await Client.open(booted.port, CAROL);
        const joined = await client.op({ type: "join", code: "JUNO-AAAA-BBBB", takeSeat: true });
        assert.equal(joined.ok, true, "a join by the rebuilt index works");
        await client.close();
        assert.ok(booted.ops.lines.some((line) => line.event === "index.reconciled" && line.rebuilt === true));
      } finally {
        await stopServer(booted.server);
      }
    }));
});

/* ==================================================================
    2. RECONCILIATION: the log wins; a disagreement holds
   ================================================================== */

describe("LIVE-3C reconciliation", () => {
  test("the table, pure: repairs where the record only lags, holds where it disagrees", () => {
    const base = { ...seededRecord([ALICE, BOB], { dealt: true }), rules_engine_version: RULES_ENGINE_VERSION }; // DA-8: was 10
    const log = storedLog(2);
    const board = { ended: false, closed: false };
    assert.deepEqual(reconcileLoaded(base, { entries: log, board }), { kind: "ok" });
    const lag = reconcileLoaded({ ...base, status: "waiting", started_at: null, turn_order: null }, { entries: log, board });
    assert.ok(lag.kind === "repair");
    assert.deepEqual(new Set(lag.fields), new Set(["status", "started_at", "turn_order"]));
    const lastAt = log[log.length - 1].at as number;
    const wrongEnd = reconcileLoaded({ ...base, status: "completed", completed_at: lastAt - 5_000 }, { entries: log, board: { ended: true, closed: false } });
    assert.deepEqual(wrongEnd, { kind: "repair", fields: ["completed_at"] }, "an end time other than the seal's is the log's to set");
    assert.deepEqual(reconcileLoaded({ ...base, status: "completed", completed_at: lastAt }, { entries: log, board: { ended: true, closed: false } }), { kind: "ok" });
    const ended = reconcileLoaded(base, { entries: log, board: { ended: true, closed: false } });
    assert.deepEqual(ended.kind === "repair" && ended.fields.includes("status") && ended.fields.includes("completed_at"), true, "a terminal log + an active record: repaired");
    const cases: Array<[string, GameRecord, ServerLogEntry[], { ended: boolean; closed: boolean } | null, string]> = [
      ["active, no deal", base, [], board, "record-ahead-of-log"],
      ["completed, board not ended", { ...base, status: "completed", completed_at: 1 }, log, board, "record-ahead-of-log"],
      ["closed, room not closed", { ...base, closed_at: 5 }, log, board, "record-ahead-of-log"],
      ["cancelled but dealt", { ...base, status: "cancelled" }, log, board, "lifecycle-conflict"],
      ["expired but dealt", { ...base, status: "expired" }, log, board, "lifecycle-conflict"],
      ["roster", { ...base, seats: [base.seats[0]] }, log, board, "roster-mismatch"],
      ["turn order", { ...base, turn_order: [BOB, ALICE] }, log, board, "roster-mismatch"],
      ["pin cached differently", { ...base, rules_engine_version: 9 }, log, board, "rules-pin-mismatch"],
      ["unpinned deal", base, withDeal(log, (setup) => delete setup.rules_engine_version), board, "rules-pin-mismatch"],
      ["first entry not the deal", base, [log[1], ...log.slice(2)].map((e, at) => ({ ...e, index: at })), board, "deal-misplaced"],
      ["a second deal", base, [...log, { ...log[0], index: log.length, id: "second-deal" }], board, "deal-misplaced"],
      ["foreign actor", base, [...log.slice(0, 2), { ...log[2], actor: "p-mallory" }], board, "foreign-actor"],
      ["host not seated", { ...base, host_player_id: CAROL }, log, board, "host-not-seated"],
      ["a player twice", { ...base, seats: [base.seats[0], { ...base.seats[1], player_id: ALICE }] }, log, board, "seat-binding-invalid"],
      ["a principal twice", { ...base, seats: [base.seats[0], { ...base.seats[1], principal_id: base.seats[0].principal_id }] }, log, board, "seat-binding-invalid"],
      ["a kicked principal seated", { ...base, kicked_principals: [base.seats[1].principal_id] }, log, board, "seat-binding-invalid"],
    ];
    for (const [label, record, entries, facts, code] of cases) {
      const verdict = reconcileLoaded(record, { entries, board: facts });
      assert.deepEqual([label, verdict.kind, verdict.kind === "hold" ? verdict.code : null], [label, "hold", code]);
      assert.ok(verdict.kind === "hold" && !/pr_dev_|pr_[0-9a-z]{26}/.test(verdict.detail), `${label}: no principal id in the detail`);
    }
    // The discovery tier agrees wherever it has the facts (the first line only).
    assert.equal(reconcileHead(base, { present: false, first: null }).kind, "hold");
    assert.equal(reconcileHead({ ...base, status: "waiting" }, { present: true, first: log[0] }).kind, "repair");
    assert.equal(reconcileHead(base, { present: true, first: undefined }).kind, "ok", "an unreadable first line is the load's to judge");
  });

  test("record says waiting, log holds the deal: repaired from the log at the first load (audited), and the game plays on", () =>
    withDir("lag", async (dir) => {
      const gameId = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "waiting", started_at: null, turn_order: null, rules_engine_version: null, expires_at: Date.now() + DAY }) });
      const booted = await boot(dir);
      try {
        const hello = await helloFrame(booted.port, ALICE, gameId);
        assert.equal(hello.kind, "catch-up");
        const record = await (async () => {
          for (let tries = 0; tries < 200; tries += 1) {
            const current = readRecord(dir, gameId);
            if (current.status === "active") return current;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return readRecord(dir, gameId);
        })();
        assert.deepEqual([record.status, record.turn_order, record.rules_engine_version, record.expires_at], ["active", [ALICE, BOB], RULES_ENGINE_VERSION, null]);
        assert.ok(await audited(booted, (line) => line.event === "record.repaired" && line.game_id === gameId));
        const bob = await Client.open(booted.port, BOB);
        bob.hello(gameId);
        await bob.next((f) => f.kind === "catch-up");
        bob.submit(BUY, { baseIndex: 1, submissionId: "after-repair" });
        assert.equal((await bob.answerTo("after-repair")).kind, "applied");
        await bob.close();
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("disagreements only the whole log shows -- a foreign actor, a second deal, a record completed on a board that has not ended -- are held at the load and written down", () =>
    withDir("tier2", async (dir) => {
      const foreign = dealtOnDisk(dir, 2, { log: (entries) => [...entries.slice(0, 2), { ...entries[2], actor: "p-mallory" }] });
      const secondDeal = dealtOnDisk(dir, 1, { log: (entries) => [...entries, { ...entries[0], index: entries.length, id: "deal-again", submission_id: "again" }] });
      const completed = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: Date.now() }) });
      const booted = await boot(dir);
      try {
        for (const [gameId, code] of [
          [foreign, "foreign-actor"],
          [secondDeal, "deal-misplaced"],
          [completed, "record-ahead-of-log"],
        ] as const) {
          assert.equal(booted.server.lifecycle.discovery()?.games.get(gameId)?.cls === "held", false, `${gameId}: discovery cannot see this`);
          const frame = await helloFrame(booted.port, ALICE, gameId);
          assert.deepEqual([frame.kind, frame.code], ["error", "held"], code);
          assert.equal(JSON.parse(fs.readFileSync(holdPath(dir, gameId), "utf8")).code, code);
        }
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("a torn final batch is repaired and served; a record whose file names another game is held; a duplicate index is held", () =>
    withDir("shapes", async (dir) => {
      const torn = dealtOnDisk(dir, 2);
      const log = storedLog(2);
      fs.appendFileSync(logPath(dir, torn), JSON.stringify(log[2]).slice(0, 30));
      const renamed = mintGameId();
      writeRecord(dir, seededRecord([ALICE, BOB], { dealt: true }));
      const other = fs.readdirSync(path.join(dir, "games")).find((name) => name.endsWith(".json") && !name.startsWith(torn) && name !== "join-codes.json") as string;
      fs.renameSync(path.join(dir, "games", other), recordPath(dir, renamed)); // g_A.json holding game_id g_B
      const dupe = dealtOnDisk(dir, 2, { log: (entries) => [entries[0], entries[1], { ...entries[2], index: 1 }] });
      const booted = await boot(dir);
      try {
        const served = await helloFrame(booted.port, ALICE, torn);
        assert.equal(served.kind, "catch-up");
        assert.equal((served.entries as SeenEntry[]).length, 3, "the complete batches stand");
        assert.equal(booted.server.lifecycle.discovery()?.games.get(renamed)?.code, "record-unreadable");
        assert.equal((await roomFrame(booted.port, ALICE, renamed)).code, "not-found", "a record nobody can read authorizes nobody");
        assert.deepEqual([(await helloFrame(booted.port, ALICE, dupe)).code, JSON.parse(fs.readFileSync(holdPath(dir, dupe), "utf8")).code], ["held", "log-corrupt"]);
      } finally {
        await stopServer(booted.server);
      }
    }));
});

/* ==================================================================
    2b. TWO STAGES: "NOT REPLAYED YET" NEVER MEANS "THE RECORD IS RIGHT"
   ================================================================== */

/** The latest public list a watcher holds: game id -> status. */
function listed(client: Client): Map<string, string> {
  const frames = client.of("rooms");
  const last = frames[frames.length - 1] as { rooms?: Array<{ gameId: string; status: string }> } | undefined;
  return new Map((last?.rooms ?? []).map((room) => [room.gameId, room.status]));
}

async function listSays(client: Client, check: (rooms: Map<string, string>) => boolean, label: string): Promise<Map<string, string>> {
  for (let tries = 0; tries < 400; tries += 1) {
    const rooms = listed(client);
    if (check(rooms)) return rooms;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`the public list never said ${label}: ${JSON.stringify([...listed(client)])}`);
}

describe("LIVE-3C two stages", () => {
  test("the public lobby lists no started game until its load has reconciled it -- the record's claim is never what a reader is shown", () =>
    withDir("lobby", async (dir) => {
      const pub = (code: string) => (r: GameRecord): GameRecord => ({ ...r, visibility: "public", join_code: code });
      const waitingPublic = waitingOnDisk(dir, pub("JUNO-WWWW-AAAA"));
      const claimsActive = dealtOnDisk(dir, 1, { record: pub("JUNO-WWWW-BBBB") });
      /* The record says active; the log's board has ended (the crash came between the ending batch and the record). */
      const reallyEnded = dealtOnDisk(dir, 1, { record: pub("JUNO-WWWW-CCCC") });
      /* The record says waiting (a public table anyone could join); the log holds its deal. */
      const reallyDealt = dealtOnDisk(dir, 1, { record: (r) => ({ ...pub("JUNO-WWWW-DDDD")(r), status: "waiting", started_at: null, turn_order: null, rules_engine_version: null, expires_at: Date.now() + DAY }) });
      const booted = await boot(dir, { faults: { boardEnded: (id) => id === reallyEnded } });
      try {
        const carol = await Client.open(booted.port, CAROL);
        carol.send({ kind: "rooms-watch", on: true });
        const first = await listSays(carol, (rooms) => rooms.size > 0, "anything");
        assert.deepEqual([...first], [[waitingPublic, "waiting"]], "before any load only the table with no history is listed");
        for (const gameId of [claimsActive, reallyEnded, reallyDealt]) assert.equal(classOf(booted, gameId)?.cls, "unreconciled");
        // A join by the lagging record's code does not believe it either: the load reconciles first (it was dealt).
        const dave = await Client.open(booted.port, "p-dave");
        await dave.op({ type: "join", code: "JUNO-WWWW-DDDD", takeSeat: true });
        await dave.close();
        assert.deepEqual([readRecord(dir, reallyDealt).status, readRecord(dir, reallyDealt).seats.length], ["active", 2], "the join met the reconciled table: dealt, and no new seat taken");
        for (const gameId of [claimsActive, reallyEnded]) await helloFrame(booted.port, ALICE, gameId);
        const after = await listSays(carol, (rooms) => rooms.get(claimsActive) === "playing" && rooms.get(reallyDealt) === "playing", "both reconciled tables playing");
        assert.equal(after.has(reallyEnded), false, "a game whose log has ended is never listed as playing, whatever its record said");
        assert.equal(readRecord(dir, reallyEnded).status, "completed", "and its record is repaired from the log");
        assert.equal(readRecord(dir, reallyDealt).status, "active");
        assert.deepEqual([classOf(booted, claimsActive)?.cls, classOf(booted, reallyEnded)?.cls, classOf(booted, reallyDealt)?.cls], ["active", "completed", "active"]);
        await carol.close();
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("a repair that cannot land keeps the game unreconciled: every op and move is refused (a read shows the log, not the record), the repair is retried, and once it lands the game plays on", () =>
    withDir("repair-fails", async (dir) => {
      const gameId = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "waiting", started_at: null, turn_order: null, rules_engine_version: null, expires_at: Date.now() + DAY }) });
      const initialVersion = readRecord(dir, gameId).record_version;
      const files = createFileRecordStore(dir, quiet);
      /* The load's repair fails, and so does the retry the first refusal asks for; the second refusal's lands. */
      let failPuts = 2;
      const records: RecordStore = {
        list: () => files.list(),
        load: (id) => files.load(id),
        put: async (record, expected) => {
          if (record.game_id === gameId && failPuts > 0) {
            failPuts -= 1;
            return { kind: "definite", detail: "injected: the record could not be written" };
          }
          return files.put(record, expected);
        },
        lookupCode: (code) => files.lookupCode(code),
        claimCode: (code, id) => files.claimCode(code, id),
        releaseCode: (code, id) => files.releaseCode(code, id),
        reconcileIndex: files.reconcileIndex?.bind(files),
      };
      const booted = await boot(dir, { records });
      try {
        const bob = await Client.open(booted.port, BOB);
        bob.hello(gameId);
        const caught = await bob.next((f) => f.kind === "catch-up");
        assert.equal((caught.entries as SeenEntry[]).length, 2, "the read serves the validated log");
        for (let tries = 0; tries < 400 && failPuts > 1; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.deepEqual([classOf(booted, gameId)?.cls, classOf(booted, gameId)?.code], ["unreconciled", "repair-pending"]);
        bob.roomHello(gameId);
        const view = (await bob.next((f) => f.kind === "room")).view as { lifecycle: string };
        assert.equal(view.lifecycle, "active", "the view is the log's lifecycle, never the lagging record's \"waiting\"");
        bob.submit(BUY, { baseIndex: 1, submissionId: "while-unreconciled" });
        const refusedMove = await bob.answerTo("while-unreconciled");
        /* LIVE-2F/3D (C9-05): `retry`, the never-ran answer -- an `unavailable` move is kept in flight by the client. */
        assert.deepEqual([refusedMove.kind, refusedMove.code, refusedMove.reason], ["refused", "retry", RECONCILING_SENTENCE], "said as not made -- never \"it will appear\"");
        assert.equal((await bob.op({ type: "set-ready", ready: false }, gameId)).code, "unavailable", "no op writes on an unreconciled record");
        // The refusals retried the repair (a task of its own); now it lands.
        for (let tries = 0; tries < 400 && readRecord(dir, gameId).status !== "active"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        const repaired = readRecord(dir, gameId);
        assert.equal(repaired.status, "active");
        assert.equal(repaired.record_version, initialVersion + 1, "the repair is the only write: the refused op and move wrote nothing");
        assert.equal(repaired.seats.find((seat) => seat.player_id === BOB)?.ready, true, "the refused set-ready did not land");
        for (let tries = 0; tries < 400 && classOf(booted, gameId)?.cls !== "active"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(classOf(booted, gameId)?.cls, "active");
        bob.submit(BUY, { baseIndex: 1, submissionId: "once-reconciled" });
        assert.equal((await bob.answerTo("once-reconciled")).kind, "applied");
        assert.ok(await audited(booted, (line) => line.event === "record.repaired" && line.game_id === gameId));
        await bob.close();
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("the archive sweep believes no claim: a record completed long ago on a log whose seal is recent is repaired to the seal's time, and not archived", () =>
    withDir("archive-claim", async (dir) => {
      let written: ServerLogEntry[] = [];
      const gameId = dealtOnDisk(dir, 1, {
        record: (r) => ({ ...r, status: "completed", completed_at: Date.now() - COMPLETED_ARCHIVE_AFTER_MS - DAY }),
        log: (entries) => (written = entries.map((entry) => ({ ...entry, at: Date.now() - 60_000 }))),
      });
      const booted = await boot(dir, { faults: { boardEnded: (id) => id === gameId } });
      try {
        assert.equal(classOf(booted, gameId)?.cls, "unreconciled");
        booted.server.rooms.sweepArchive();
        const seal = sealOf(written, true) as TerminalSeal;
        for (let tries = 0; tries < 400 && readRecord(dir, gameId).completed_at !== seal.at; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(readRecord(dir, gameId).completed_at, seal.at, "the end time is the log's");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(readRecord(dir, gameId).archived_at, null, "not archived on the record's word");
        assert.equal(classOf(booted, gameId)?.cls, "completed");
        assert.ok(await audited(booted, (line) => line.event === "record.repaired" && (line.fields as string[]).includes("completed_at")));
        assert.equal(booted.ops.lines.some((line) => line.event === "record.archived"), false);
      } finally {
        await stopServer(booted.server);
      }
    }));
});

/* ==================================================================
    3. THE DURABLE HOLD
   ================================================================== */

describe("LIVE-3C held games", () => {
  test("held survives every restart; every change is refused (a leave only unsubscribes); the view says so; nothing on disk moves; the player sentence never carries the detail", () =>
    withDir("held", async (dir) => {
      const gameId = dealtOnDisk(dir, 1, { log: (entries) => [...entries.slice(0, 1), { ...entries[1], actor: "p-mallory" }] });
      const waitingHeld = waitingOnDisk(dir, (r) => ({ ...r, host_player_id: CAROL }));
      for (let restart = 0; restart < 2; restart += 1) {
        const booted = await boot(dir);
        try {
          const logBefore = fs.readFileSync(logPath(dir, gameId));
          const recordBefore = fs.readFileSync(recordPath(dir, gameId));
          const alice = await Client.open(booted.port, ALICE);
          alice.hello(gameId);
          const hello = await alice.next((f) => f.kind === "error" || f.kind === "catch-up");
          assert.deepEqual([hello.code, hello.reason], ["held", HELD_PLAYER_SENTENCE], `restart ${restart}`);
          assert.equal(alice.seen().length, 0, "no history served");
          alice.roomHello(gameId);
          const room = await alice.next((f) => f.kind === "room");
          const view = room.view as { held: boolean; holdKind: string; lifecycle: string; you: { canStart: boolean } };
          assert.deepEqual([view.held, view.holdKind, view.lifecycle], [true, "maintenance", "active"]);
          for (const op of [{ type: "transfer-host", toPlayerId: "p-0123456789abcdef" }, { type: "set-ready", ready: false }, { type: "start-game" }, { type: "cancel-room" }, { type: "rotate-code" }]) {
            const answer = await alice.op(op, gameId);
            assert.equal(answer.ok, false, JSON.stringify(op));
          }
          assert.equal((await alice.op({ type: "transfer-host", toPlayerId: "p-0123456789abcdef" }, gameId)).code, "held");
          alice.submit(BUY, { baseIndex: 0, submissionId: `held-${restart}` });
          assert.equal((await alice.answerTo(`held-${restart}`)).code, "held");
          const left = await alice.op({ type: "leave" }, gameId);
          assert.equal(left.ok, true, "leave only unsubscribes");
          assert.ok(!JSON.stringify(alice.frames).includes("p-mallory"), "the operator's detail never reaches a player");
          // The held waiting room: its view, and a start refused.
          const bob = await Client.open(booted.port, BOB);
          bob.roomHello(waitingHeld);
          const waitingView = (await bob.next((f) => f.kind === "room")).view as { holdKind: string; you: { canStart: boolean }; joinable: boolean };
          assert.deepEqual([waitingView.holdKind, waitingView.you.canStart, waitingView.joinable], ["maintenance", false, false]);
          assert.equal((await bob.op({ type: "set-ready", ready: false }, waitingHeld)).code, "held");
          await Promise.all([alice.close(), bob.close()]);
          assert.ok(fs.readFileSync(logPath(dir, gameId)).equals(logBefore), "the log is byte-identical");
          assert.ok(fs.readFileSync(recordPath(dir, gameId)).equals(recordBefore), "the record is byte-identical");
          // The archive and expiry sweeps never touch a held game.
          booted.server.rooms.sweepArchive();
          booted.server.rooms.sweepExpired();
        } finally {
          await stopServer(booted.server);
        }
      }
    }));

  test("a private held game discloses nothing to an outsider: the same not-found as a game that never existed", () =>
    withDir("private", async (dir) => {
      const gameId = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, visibility: "private" }), log: (entries) => [...entries.slice(0, 1), { ...entries[1], actor: "p-mallory" }] });
      const corruptRecord = mintGameId();
      writeRecord(dir, JSON.stringify({ game_id: corruptRecord, visibility: "private" }));
      const booted = await boot(dir);
      try {
        const nowhere = mintGameId();
        const answers = async (target: string) => [(await roomFrame(booted.port, CAROL, target)).code, (await helloFrame(booted.port, CAROL, target)).code];
        const baseline = await answers(nowhere);
        assert.deepEqual(baseline, ["not-found", "not-found"]);
        assert.deepEqual(await answers(gameId), baseline, "a held private game");
        assert.deepEqual(await answers(corruptRecord), baseline, "an unreadable record");
        assert.deepEqual((await helloFrame(booted.port, ALICE, gameId)).code, "held", "a seated player is told it is held");
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("the only way out: the offline release refuses while the game does not verify, lifts the hold once it does (audited, the hold kept under released/), and the game is served", () =>
    withDir("release", async (dir) => {
      const gameId = dealtOnDisk(dir, 3);
      const log = storedLog(3);
      fs.writeFileSync(logPath(dir, gameId), serializeBatch([log[0]]) + serializeBatch([log[1]]) + JSON.stringify(log[2]).slice(0, 50) + serializeBatch([log[2]]) + serializeBatch([log[3]]));
      let booted = await boot(dir);
      assert.equal((await helloFrame(booted.port, ALICE, gameId)).code, "held");
      await stopServer(booted.server);
      // A plain restart does not lift it.
      booted = await boot(dir);
      assert.equal((await helloFrame(booted.port, ALICE, gameId)).code, "held");
      await stopServer(booted.server);
      const ops = createMemoryOpsRecorder();
      const refused = await withLock(dir, (lock) => releaseHold(dir, gameId, "the log was looked at", { lock, ops }));
      assert.ok(!("refused" in refused) && !refused.ok && /does not verify/.test(refused.reason), "a corrupt log does not verify");
      // logDoctor's verified copy is installed (LIVE-3B's workflow) ...
      const repair = repairBytes(fs.readFileSync(logPath(dir, gameId)), { split: true });
      assert.ok(repair.ok);
      if (!repair.ok) return;
      fs.renameSync(logPath(dir, gameId), `${logPath(dir, gameId)}.original`);
      fs.writeFileSync(logPath(dir, gameId), repair.bytes);
      // ... and still the game is held: the hold, not the files, decides -- until the release.
      booted = await boot(dir);
      assert.equal((await helloFrame(booted.port, ALICE, gameId)).code, "held");
      await stopServer(booted.server);
      assert.deepEqual(await withLock(dir, (lock) => releaseHold(dir, gameId, "   ", { lock, ops })), { ok: false, reason: 'a release needs --note "<why it is safe now>" (1-500 characters)' });
      const released = await withLock(dir, (lock) => releaseHold(dir, gameId, "logDoctor split the F-8 line; replay verified", { lock, ops }));
      assert.ok(!("refused" in released) && released.ok, JSON.stringify(released));
      assert.ok(!fs.existsSync(holdPath(dir, gameId)));
      const kept = fs.readdirSync(path.join(dir, "games", "holds", "released"));
      assert.equal(kept.length, 1);
      const record = JSON.parse(fs.readFileSync(path.join(dir, "games", "holds", "released", kept[0]), "utf8"));
      assert.deepEqual([record.code, record.released.note, record.released.verification.entries], ["log-corrupt", "logDoctor split the F-8 line; replay verified", 4]);
      assert.ok(ops.lines.some((line) => line.event === "hold.released" && line.game_id === gameId));
      booted = await boot(dir);
      try {
        const hello = await helloFrame(booted.port, ALICE, gameId);
        assert.equal(hello.kind, "catch-up");
        assert.equal((hello.entries as SeenEntry[]).length, 4);
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("a hold file that cannot be read holds its game; a hold is created once (the first one kept)", () =>
    withDir("unreadable-hold", async (dir) => {
      const gameId = dealtOnDisk(dir, 1);
      fs.mkdirSync(path.join(dir, "games", "holds"), { recursive: true });
      fs.writeFileSync(holdPath(dir, gameId), "{ not a hold");
      const booted = await boot(dir);
      try {
        assert.equal(classOf(booted, gameId)?.code, "hold-unreadable");
        assert.equal((await helloFrame(booted.port, ALICE, gameId)).code, "held");
      } finally {
        await stopServer(booted.server);
      }
      const holds = createFileHoldStore(dir, quiet);
      const other = dealtOnDisk(dir, 1);
      const first = await holds.create(makeHold({ gameId: other, code: "roster-mismatch", detail: "first", at: 1, source: "load", build: BUILD, rulesEngineVersion: 10 }));
      const second = await holds.create(makeHold({ gameId: other, code: "foreign-actor", detail: "second", at: 2, source: "load", build: BUILD, rulesEngineVersion: 10 }));
      assert.deepEqual([first.existing, second.existing?.detail], [null, "first"]);
      assert.equal((await holds.load(other))?.code, "roster-mismatch");
    }));
});

/* ==================================================================
    4. INCOMPATIBLE AND READ-ONLY
   ================================================================== */

describe("LIVE-3C incompatible and read-only games", () => {
  test("a pin this build does not carry is incompatible across restarts -- no history, no move, no hold file, the view says so; a game dealt on another build is read-only", () =>
    withDir("incompatible", async (dir) => {
      const newer = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, rules_engine_version: 99 }), log: (entries) => withDeal(entries, (setup) => (setup.rules_engine_version = 99)) });
      const older = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, rules_engine_version: 9 }), log: (entries) => withDeal(entries, (setup) => (setup.rules_engine_version = 9)) });
      // DA-8: the version the v11 boundary replaced -- a v10 game on disk is held exactly as any older pin is.
      const priorTen = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, rules_engine_version: 10 }), log: (entries) => withDeal(entries, (setup) => (setup.rules_engine_version = 10)) });
      const otherBuild = dealtOnDisk(dir, 1, { log: (entries) => withDeal(entries, (setup) => (setup.build = "an-older-build")) });
      for (let restart = 0; restart < 2; restart += 1) {
        const booted = await boot(dir);
        try {
          for (const [gameId, code] of [
            [newer, "rules-version-newer"],
            [older, "rules-version-older"],
            [priorTen, "rules-version-older"],
          ] as const) {
            assert.equal(booted.server.lifecycle.discovery()?.games.get(gameId)?.code, code);
            const alice = await Client.open(booted.port, ALICE);
            alice.hello(gameId);
            const answer = await alice.next((f) => f.kind === "incompatible" || f.kind === "catch-up");
            assert.equal(answer.kind, "incompatible");
            alice.roomHello(gameId);
            assert.equal(((await alice.next((f) => f.kind === "room")).view as { holdKind: string }).holdKind, "incompatible");
            alice.submit(BUY, { baseIndex: 1, submissionId: `x-${restart}` });
            assert.equal((await alice.answerTo(`x-${restart}`)).kind, "incompatible");
            await alice.close();
            assert.ok(!fs.existsSync(holdPath(dir, gameId)));
          }
          const bob = await Client.open(booted.port, BOB);
          bob.hello(otherBuild);
          const served = await bob.next((f) => f.kind === "catch-up");
          assert.equal((served.entries as SeenEntry[]).length, 2, "a read-only game's history is served");
          bob.roomHello(otherBuild);
          assert.equal(((await bob.next((f) => f.kind === "room")).view as { holdKind: string }).holdKind, "read-only");
          bob.submit(BUY, { baseIndex: 1, submissionId: `ro-${restart}` });
          assert.match(String((await bob.answerTo(`ro-${restart}`)).reason), /dealt on build "an-older-build"/);
          await bob.close();
          assert.equal(classOf(booted, otherBuild)?.cls, "read-only");
        } finally {
          await stopServer(booted.server);
        }
      }
    }));
});

/* ==================================================================
    5. THE TERMINAL SEAL
   ================================================================== */

describe("LIVE-3C terminal games", () => {
  /** The batch that takes a game to `n` entries ends it (the seam: a whole game played to GameEnd is not a fixture). */
  const endsAt = (targets: Map<string, number>) => ({ boardEnded: (gameId: string, session: RoomSession) => (targets.get(gameId) ?? Infinity) <= session.entries.length });

  test("gameplay reaches its end: the record is completed with the seal's time, the settlement seam hears it once, every later move is refused -- and after a restart the same", () =>
    withDir("terminal", async (dir) => {
      const targets = new Map<string, number>();
      const sealed: Array<{ gameId: string; seal: TerminalSeal; recovered: boolean }> = [];
      const settlement: SettlementLifecycle = { ...NO_MONEY_SETTLEMENT, onGameplayClosed: (input) => sealed.push({ gameId: input.gameId, seal: input.seal, recovered: input.recovered }) };
      let booted = await boot(dir, { faults: endsAt(targets), settlement });
      const { gameId, playerIds } = await openGame(booted.port, ALICE, [BOB]);
      targets.set(gameId, 3); // the deal (1 entry), then the second purchase ends it
      const alice = await Client.open(booted.port, ALICE);
      const bob = await Client.open(booted.port, BOB);
      alice.hello(gameId);
      bob.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      await bob.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "buy-1" });
      assert.equal((await alice.answerTo("buy-1")).kind, "applied");
      bob.submit(BUY, { baseIndex: 1, submissionId: "buy-2" });
      assert.equal((await bob.answerTo("buy-2")).kind, "applied");
      const record = await (async () => {
        for (let tries = 0; tries < 400; tries += 1) {
          const current = readRecord(dir, gameId);
          if (current.status === "completed") return current;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return readRecord(dir, gameId);
      })();
      assert.equal(record.status, "completed");
      const entries = await createFileLogStore(dir, quiet).loadLog(gameId);
      const seal = sealOf(entries, true) as TerminalSeal;
      assert.deepEqual([seal.log_len, record.completed_at], [entries.length, seal.at], "completed at the seal's time, from the log");
      assert.ok(await audited(booted, () => sealed.length > 0));
      assert.deepEqual(sealed, [{ gameId, seal, recovered: false }], "the settlement seam heard it once, from the step that completed the record");
      assert.ok(await audited(booted, (line) => line.event === "game.sealed" && line.log_len === entries.length));
      alice.submit(BUY, { baseIndex: entries.length - 1, submissionId: "after-end" });
      const refused = await alice.answerTo("after-end");
      assert.deepEqual([refused.kind, refused.code, refused.reason], ["refused", "wrong-state", GAME_OVER_SENTENCE]);
      assert.equal((await createFileLogStore(dir, quiet).loadLog(gameId)).length, entries.length, "nothing appended");
      alice.roomHello(gameId);
      assert.equal(((await alice.next((f) => f.kind === "room")).view as { lifecycle: string }).lifecycle, "completed");
      await Promise.all([alice.close(), bob.close()]);
      await stopServer(booted.server);
      void playerIds;

      booted = await boot(dir, { faults: endsAt(targets), settlement });
      try {
        const found = booted.server.lifecycle.discovery()?.games.get(gameId);
        assert.deepEqual([found?.cls, found?.code], ["unreconciled", "claims-completed"], "the record's word is noted, not believed, until the load");
        const back = await Client.open(booted.port, BOB);
        back.hello(gameId);
        const hello = await back.next((f) => f.kind === "catch-up");
        assert.equal((hello.entries as SeenEntry[]).length, entries.length, "the terminal result, restored");
        for (let tries = 0; tries < 400 && classOf(booted, gameId)?.cls !== "completed"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(classOf(booted, gameId)?.cls, "completed", "concluded by the load: the log's board has ended");
        back.submit(BUY, { baseIndex: entries.length - 1, submissionId: "after-restart" });
        assert.equal((await back.answerTo("after-restart")).reason, GAME_OVER_SENTENCE);
        await back.close();
        /* AT LEAST ONCE (review E6): a load that finds the game completed announces the SAME seal again -- a crash
           after the record's write would otherwise lose the only call. ESCROW-3's side is idempotent by the seal. */
        for (let tries = 0; tries < 400 && sealed.length < 2; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.deepEqual(sealed, [sealed[0], { ...sealed[0], recovered: true }], "the same seal, announced again as recovered");
        assert.equal(booted.ops.lines.filter((line) => line.event === "game.sealed").length, 0, "no second seal: the audit records the transition only");
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("a terminal log beside an ACTIVE record (a crash between the ending batch and the record): repaired to completed at the load", () =>
    withDir("terminal-lag", async (dir) => {
      let written: ServerLogEntry[] = [];
      const gameId = dealtOnDisk(dir, 2, { log: (entries) => (written = entries) });
      const booted = await boot(dir, { faults: { boardEnded: (id) => id === gameId } });
      try {
        await helloFrame(booted.port, ALICE, gameId);
        for (let tries = 0; tries < 400 && readRecord(dir, gameId).status !== "completed"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        const record = readRecord(dir, gameId);
        const seal = sealOf(written, true) as TerminalSeal;
        assert.deepEqual([record.status, record.completed_at], ["completed", seal.at]);
        assert.ok(await audited(booted, (line) => line.event === "record.repaired" && (line.fields as string[]).includes("completed_at")));
      } finally {
        await stopServer(booted.server);
      }
    }));
});

/* ==================================================================
    6. WAITING ROOMS THAT NEVER START, AND ARCHIVAL
   ================================================================== */

describe("LIVE-3C expiry, cancellation and archival", () => {
  test("after a restart: an expired waiting room is gone (said as expired) and made durable with its code released; a cancelled one is gone (said as cancelled)", () =>
    withDir("expiry", async (dir) => {
      const expired = waitingOnDisk(dir, (r) => ({ ...r, join_code: "JUNO-EEEE-EEEE", expires_at: Date.now() - 1_000 }));
      const cancelled = waitingOnDisk(dir, (r) => ({ ...r, status: "cancelled", cancelled_at: Date.now() - 1_000, expires_at: null }));
      const booted = await boot(dir);
      try {
        const expiredAnswer = await roomFrame(booted.port, ALICE, expired);
        assert.deepEqual([expiredAnswer.code, expiredAnswer.reason], ["gone", GONE_SENTENCES.expired]);
        const cancelledAnswer = await roomFrame(booted.port, ALICE, cancelled);
        assert.deepEqual([cancelledAnswer.code, cancelledAnswer.reason], ["gone", GONE_SENTENCES.cancelled]);
        booted.server.rooms.sweepExpired();
        for (let tries = 0; tries < 400 && readRecord(dir, expired).status !== "expired"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.deepEqual([readRecord(dir, expired).status, readRecord(dir, expired).join_code], ["expired", null]);
        const carol = await Client.open(booted.port, CAROL);
        assert.equal((await carol.op({ type: "join", code: "JUNO-EEEE-EEEE", takeSeat: true })).code, "invalid-or-expired");
        await carol.close();
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("a completed game 30 days after its seal, and a cancelled table 7 days after, are archived (marked, code released, audited) -- never a held game, never a money game", () =>
    withDir("archive", async (dir) => {
      const now = Date.now();
      /* The seal's time is the log's (the record caches it), so the old game's log is old too. */
      const sealedAt = now - COMPLETED_ARCHIVE_AFTER_MS - 1_000;
      const old = dealtOnDisk(dir, 1, {
        record: (r) => ({ ...r, status: "completed", started_at: sealedAt, completed_at: sealedAt, join_code: "JUNO-DDDD-GGGG" }),
        log: (entries) => entries.map((entry) => ({ ...entry, at: sealedAt })),
      });
      const recent = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: now - DAY }) });
      const cancelled = waitingOnDisk(dir, (r) => ({ ...r, status: "cancelled", cancelled_at: now - 8 * DAY, expires_at: null }));
      const financial = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: now - 60 * DAY }) });
      const held = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: now - 60 * DAY, host_player_id: CAROL }) });
      const settlement: SettlementLifecycle = {
        ...NO_MONEY_SETTLEMENT,
        retentionOf: (record) => (record.game_id === financial ? { kind: "financial", reason: "a stand-in money game" } : { kind: "no-money" }),
      };
      const booted = await boot(dir, { settlement, faults: { boardEnded: (id) => id !== cancelled } });
      try {
        booted.server.rooms.sweepArchive();
        for (let tries = 0; tries < 400 && (readRecord(dir, old).archived_at === null || readRecord(dir, cancelled).archived_at === null); tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(readRecord(dir, old).archived_at !== null);
        assert.equal(readRecord(dir, old).join_code, null, "its code released");
        assert.ok(readRecord(dir, cancelled).archived_at !== null);
        for (const kept of [recent, financial, held]) assert.equal(readRecord(dir, kept).archived_at, null, kept);
        /* The file is on disk a moment before the commit is published (its directory sync); the audit follows the
           publish, so a reader after it is told `gone` (a reader before it is served the game -- never anything between). */
        assert.ok(await audited(booted, () => booted.ops.lines.filter((line) => line.event === "record.archived").length === 2));
        const gone = await roomFrame(booted.port, ALICE, old);
        assert.deepEqual([gone.code, gone.reason], ["gone", GONE_SENTENCES.archived]);
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("archiving races reconnects and room reads: each reader sees the game before, or is told it is gone after -- never anything between", () =>
    withDir("archive-race", async (dir) => {
      const now = Date.now();
      const gameId = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: now - COMPLETED_ARCHIVE_AFTER_MS - 1_000 }) });
      const booted = await boot(dir, { faults: { boardEnded: () => true } });
      try {
        const clients = await Promise.all([ALICE, BOB, ALICE, BOB].map((claim) => Client.open(booted.port, claim)));
        clients.forEach((client, at) => (at % 2 === 0 ? client.hello(gameId) : client.roomHello(gameId)));
        booted.server.rooms.sweepArchive();
        clients.forEach((client, at) => (at % 2 === 0 ? client.roomHello(gameId) : client.hello(gameId)));
        for (let tries = 0; tries < 400 && readRecord(dir, gameId).archived_at === null; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (const client of clients) {
          for (const frame of client.frames) {
            assert.ok(["catch-up", "room", "chat", "presence", "error"].includes(frame.kind), frame.kind);
            if (frame.kind === "error") assert.ok(["gone", "not-found"].includes(String(frame.code)), JSON.stringify(frame));
          }
        }
        assert.equal(fs.readFileSync(logPath(dir, gameId), "utf8").trim().split("\n").length, 2, "the log never moved");
        assert.ok(await audited(booted, (line) => line.event === "record.archived"), "the archive was published");
        const after = await roomFrame(booted.port, ALICE, gameId);
        assert.equal(after.code, "gone");
      } finally {
        await stopServer(booted.server);
      }
    }));
});

/* ==================================================================
    7. FENCING: a server whose lock was taken over writes nothing
   ================================================================== */

describe("LIVE-3C fencing", () => {
  test("after a takeover the old process's hold, record, identity and ops writes are all refused; the new owner's go through", () =>
    withDir("fence", async (dir) => {
      const lost: string[] = [];
      /* LIVE-2F/3D: `beacon: false` stands for an owner the new process cannot probe (another host, or an older
         server) -- a live owner on this machine is never taken over at all (processLock.test.ts, "the beacon"). */
      const first = await acquireDataLock(dir, { heartbeatMs: 60_000, onLost: (reason) => lost.push(reason), beacon: false });
      assert.ok(first.ok);
      if (!first.ok) return;
      const aged = new Date(Date.now() - 2 * LOCK_STALE_AFTER_MS);
      const lockDir = path.join(dir, LOCK_DIRECTORY);
      for (const name of fs.readdirSync(lockDir)) fs.utimesSync(path.join(lockDir, name), aged, aged);
      fs.utimesSync(lockDir, aged, aged);
      const second = await acquireDataLock(dir, { heartbeatMs: 60_000 });
      assert.ok(second.ok && second.tookOver !== null);
      if (!second.ok) return;
      try {
        assert.equal(await first.lock.verify(), false);
        const gameId = mintGameId();
        const hold = makeHold({ gameId, code: "roster-mismatch", detail: "x", at: 1, source: "load", build: BUILD, rulesEngineVersion: 10 });
        const staleHolds = createFileHoldStore(dir, { ...quiet, writerCheck: () => first.lock.verify() });
        assert.equal((await staleHolds.create(hold)).outcome.kind, "definite");
        const staleRecords = createFileRecordStore(dir, { ...quiet, writerCheck: () => first.lock.verify() });
        assert.equal((await staleRecords.put(seededRecord([ALICE], { gameId }), null)).kind, "definite");
        const staleIdentity = createJournalIdentityStore(path.join(dir, "id-probe"), { ...quiet, writerCheck: () => first.lock.verify() });
        await assert.rejects(staleIdentity.load(), StoreDefiniteError, "not even the migration of a fresh identity directory");
        assert.equal(fs.existsSync(holdPath(dir, gameId)) || fs.existsSync(recordPath(dir, gameId)), false, "nothing written");
        /* Review E9 / E3: the old process repairs no torn tail (a write) and appends no chat line. */
        const tornGame = dealtOnDisk(dir, 1);
        fs.appendFileSync(logPath(dir, tornGame), '{"torn');
        const tornBefore = fs.readFileSync(logPath(dir, tornGame));
        const staleLogs = createFileLogStore(dir, { ...quiet, writerCheck: () => first.lock.verify() });
        await assert.rejects(staleLogs.loadLog(tornGame), /no longer owns the data directory/);
        assert.ok(fs.readFileSync(logPath(dir, tornGame)).equals(tornBefore), "the torn tail is left exactly as found");
        await assert.rejects((staleLogs.appendChat as NonNullable<LogStore["appendChat"]>)(tornGame, { id: "c1", author: ALICE, displayName: "a", text: "hi", at: 1 }), /no longer owns/);
        assert.equal(fs.existsSync(path.join(dir, `${tornGame}.chat.jsonl`)), false);
        const liveLogs = createFileLogStore(dir, { ...quiet, writerCheck: () => second.lock.verify() });
        assert.equal((await liveLogs.loadLog(tornGame)).length, 2, "the owner's load repairs it");
        const liveHolds = createFileHoldStore(dir, { ...quiet, writerCheck: () => second.lock.verify() });
        assert.equal((await liveHolds.create(hold)).outcome.kind, "committed");
        // An offline tool cannot run beside the live owner.
        const refused = await withLock(dir, async () => "ran");
        assert.ok(typeof refused === "object" && "refused" in refused);
      } finally {
        await second.lock.release();
        first.lock.releaseSync();
      }
    }));
});

/* ==================================================================
    7b. THE ADVERSARIAL REVIEW'S FINDINGS, PINNED
   ================================================================== */

describe("LIVE-3C adversarial review regressions", () => {
  test("E1: an incompatible game is never archived on its record's word, nor moved by gc -- even marked archived", () =>
    withDir("e1", async (dir) => {
      const now = Date.now();
      const pinned = (entries: ServerLogEntry[]) => withDeal(entries, (setup) => (setup.rules_engine_version = 99));
      const claimsDone = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, rules_engine_version: 99, status: "completed", completed_at: now - 60 * DAY }), log: pinned });
      const marked = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, rules_engine_version: 99, status: "completed", completed_at: now - 200 * DAY, archived_at: now - ARCHIVE_HOT_MS - DAY }), log: pinned });
      const booted = await boot(dir);
      try {
        assert.deepEqual([classOf(booted, claimsDone)?.cls, classOf(booted, marked)?.cls], ["incompatible", "incompatible"]);
        booted.server.rooms.sweepArchive();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(readRecord(dir, claimsDone).archived_at, null);
      } finally {
        await stopServer(booted.server);
      }
      const plan = await planGc(dir, { now });
      assert.deepEqual(plan.move, [], "gc moves no incompatible game");
    }));

  test("E2 / E10: a held game's torn tail is left as found; a log that frames but does not replay is HELD (replay-failed), not unavailable forever", () =>
    withDir("e2", async (dir) => {
      const held = dealtOnDisk(dir, 1);
      fs.appendFileSync(logPath(dir, held), '{"torn');
      await createFileHoldStore(dir, quiet).create(makeHold({ gameId: held, code: "roster-mismatch", detail: "x", at: 1, source: "operator", build: BUILD, rulesEngineVersion: 10 }));
      const heldBytes = fs.readFileSync(logPath(dir, held));
      const unplayable = dealtOnDisk(dir, 1, { log: (entries) => [...entries.slice(0, 2), { ...entries[1], index: 2, id: "junk", payload: '{"SetupGame":null}' }] });
      const booted = await boot(dir);
      try {
        assert.equal((await helloFrame(booted.port, ALICE, held)).code, "held");
        assert.ok(fs.readFileSync(logPath(dir, held)).equals(heldBytes), "not even a torn tail is repaired under a hold");
        const frame = await helloFrame(booted.port, ALICE, unplayable);
        assert.deepEqual([frame.kind, frame.code], ["error", "held"]);
        const hold = JSON.parse(fs.readFileSync(holdPath(dir, unplayable), "utf8"));
        assert.equal(hold.code, "replay-failed");
        assert.equal(classOf(booted, unplayable)?.cls, "held");
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("E4: a record sync that fails after the deal leaves the game unreconciled -- moves and ops refused, retried, then it plays on", () =>
    withDir("e4", async (dir) => {
      const files = createFileRecordStore(dir, quiet);
      let failActive = 1;
      const records: RecordStore = {
        list: () => files.list(),
        load: (id) => files.load(id),
        put: async (record, expected) => {
          if (record.status === "active" && failActive > 0) {
            failActive -= 1;
            return { kind: "definite", detail: "injected: the post-deal record could not be written" };
          }
          return files.put(record, expected);
        },
        lookupCode: (code) => files.lookupCode(code),
        claimCode: (code, id) => files.claimCode(code, id),
        releaseCode: (code, id) => files.releaseCode(code, id),
        reconcileIndex: files.reconcileIndex?.bind(files),
      };
      const booted = await boot(dir, { records });
      try {
        const alice = await Client.open(booted.port, ALICE);
        const bob = await Client.open(booted.port, BOB);
        const created = await alice.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
        const { gameId, code } = created.data as { gameId: string; code: string };
        assert.equal((await bob.op({ type: "join", code, takeSeat: true })).ok, true);
        for (const who of [alice, bob]) assert.equal((await who.op({ type: "set-ready", ready: true }, gameId)).ok, true);
        assert.equal((await alice.op({ type: "start-game" }, gameId)).ok, true, "the deal is committed (the log is the authority)");
        for (let tries = 0; tries < 400 && classOf(booted, gameId)?.cls !== "unreconciled"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.deepEqual([classOf(booted, gameId)?.cls, readRecord(dir, gameId).status], ["unreconciled", "waiting"]);
        alice.hello(gameId);
        const caught = await alice.next((f) => f.kind === "catch-up");
        const tip = (caught.entries as SeenEntry[]).length - 1;
        alice.submit(BUY, { baseIndex: tip, submissionId: "lagging" });
        assert.equal((await alice.answerTo("lagging")).code, "retry", "no move on a record the log contradicts (LIVE-2F/3D C9-05: the never-ran answer)");
        for (let tries = 0; tries < 400 && readRecord(dir, gameId).status !== "active"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(readRecord(dir, gameId).status, "active", "the refusal's retry landed");
        alice.submit(BUY, { baseIndex: tip, submissionId: "reconciled" });
        assert.equal((await alice.answerTo("reconciled")).kind, "applied");
        await alice.close();
        await bob.close();
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("E3 / E7 / E8: a held game takes no chat and no sweep budget; an outsider cannot tell a failing private game from none", () =>
    withDir("e378", async (dir) => {
      const now = Date.now();
      const heldIds: string[] = [];
      for (let n = 0; n < 22; n += 1) {
        const gameId = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: now - 60 * DAY }) });
        await createFileHoldStore(dir, quiet).create(makeHold({ gameId, code: "roster-mismatch", detail: "x", at: 1, source: "operator", build: BUILD, rulesEngineVersion: 10 }));
        heldIds.push(gameId);
      }
      const archivable = waitingOnDisk(dir, (r) => ({ ...r, status: "cancelled", cancelled_at: now - 8 * DAY, expires_at: null }));
      const failing = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, visibility: "private" }) });
      const logs = createFileLogStore(dir, quiet);
      const store: LogStore = { ...logs, loadLog: (room) => (room === failing ? Promise.reject(new Error("injected EIO")) : logs.loadLog(room)) };
      const booted = await boot(dir, { store });
      try {
        booted.server.rooms.sweepArchive();
        for (let tries = 0; tries < 400 && readRecord(dir, archivable).archived_at === null; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.notEqual(readRecord(dir, archivable).archived_at, null, "22 held games did not starve a 20-game budget");
        // Chat on a held game: refused, and nothing written.
        const alice = await Client.open(booted.port, ALICE);
        alice.roomHello(heldIds[0]);
        await alice.next((f) => f.kind === "room");
        alice.send({ kind: "chat-send", gameId: heldIds[0], text: "hello?" });
        const refused = await alice.next((f) => f.kind === "error");
        assert.deepEqual([refused.code, refused.reason], ["held", HELD_PLAYER_SENTENCE]);
        assert.equal(fs.existsSync(path.join(dir, `${heldIds[0]}.chat.jsonl`)), false);
        await alice.close();
        // A private game whose load fails: its own players are told "unavailable", an outsider "not-found".
        assert.equal((await helloFrame(booted.port, ALICE, failing)).code, "unavailable");
        assert.equal((await helloFrame(booted.port, CAROL, failing)).code, "not-found");
        assert.equal((await roomFrame(booted.port, CAROL, failing)).code, "not-found");
        assert.equal((await helloFrame(booted.port, CAROL, mintGameId())).code, "not-found", "the same as no game at all");
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("E11: a hold discovery could not write down still holds for the run", () =>
    withDir("e11", async (dir) => {
      const a = waitingOnDisk(dir, (r) => ({ ...r, join_code: "JUNO-EEEE-FFFF" }));
      waitingOnDisk(dir, (r) => ({ ...r, join_code: "JUNO-EEEE-FFFF" }));
      const files = createFileHoldStore(dir, quiet);
      const holds = { ...files, list: () => files.list(), load: (id: string) => files.load(id), release: files.release.bind(files), create: async () => ({ outcome: { kind: "definite" as const, detail: "injected ENOSPC" }, existing: null }) };
      const booted = await boot(dir, { holds });
      try {
        assert.equal(classOf(booted, a)?.code, "duplicate-join-code");
        assert.equal(fs.existsSync(holdPath(dir, a)), false, "the hold could not be written");
        const alice = await Client.open(booted.port, ALICE);
        assert.equal((await alice.op({ type: "set-ready", ready: false }, a)).code, "held", "held all the same");
        await alice.close();
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("E5: discovery gives one game's hung read a deadline -- that game is unavailable, the others are classified", async () => {
    const healthy = seededRecord([ALICE, BOB]);
    const hung = mintGameId();
    const report = await discoverGames({
      records: {
        list: async () => [healthy.game_id, hung],
        load: (id) => (id === hung ? new Promise<GameRecord | null>(() => undefined) : Promise.resolve(healthy)),
        put: async () => ({ kind: "definite", detail: "" }),
        lookupCode: async () => null,
        claimCode: async () => "claimed",
        releaseCode: async () => undefined,
      },
      logs: { readHead: async () => ({ present: false, size: 0, first: null }) },
      holds: createMemoryHoldStore(),
      build: BUILD,
      rulesEngineVersion: 10,
      now: () => Date.now(),
      warn: () => undefined,
      ops: createMemoryOpsRecorder(),
      perGameTimeoutMs: 50,
    });
    assert.deepEqual([report.games.get(hung)?.cls, report.games.get(healthy.game_id)?.cls], ["unavailable", "waiting"]);
  });

  test("ops redaction: a development principal id is redacted too, as every production identity id is", () => {
    const line = redactIdentity({ a: `x ${devPrincipal(ALICE)} y`, b: "pr_0123456789abcdefghjkmnpqrs", c: "se_0123456789abcdefghjkmnpqrs", keep: "g_abc p-alice" });
    assert.ok(!JSON.stringify(line).includes("pr_"), JSON.stringify(line));
    assert.ok(!JSON.stringify(line).includes("se_0"));
    assert.equal(line.keep, "g_abc p-alice", "game and player ids are kept");
  });

  test("E12: gc resumes only a move a crash interrupted -- never a stray archive directory beside a live or held game", () =>
    withDir("e12", async (dir) => {
      const now = Date.now();
      const live = dealtOnDisk(dir, 1);
      await createFileHoldStore(dir, quiet).create(makeHold({ gameId: live, code: "roster-mismatch", detail: "x", at: 1, source: "operator", build: BUILD, rulesEngineVersion: 10 }));
      fs.mkdirSync(path.join(dir, "archive", live), { recursive: true });
      const plan = await planGc(dir, { now });
      assert.deepEqual(plan.resume, []);
      const applied = await withLock(dir, (lock) => runGc(dir, { apply: true, lock, now }));
      assert.ok(!("refused" in applied));
      assert.ok(fs.existsSync(recordPath(dir, live)) && fs.existsSync(logPath(dir, live)) && fs.existsSync(holdPath(dir, live)), "nothing of it moved");
    }));
});

/* ==================================================================
    8. THE OPERATOR TOOL: inspect and gc
   ================================================================== */

describe("LIVE-3C gamesDoctor", () => {
  test("inspect --deep classifies from the files alone (writing nothing); verifyGame is the load's verdict", () =>
    withDir("inspect", async (dir) => {
      const healthy = dealtOnDisk(dir, 1);
      const foreign = dealtOnDisk(dir, 2, { log: (entries) => [...entries.slice(0, 2), { ...entries[2], actor: "p-mallory" }] });
      const before = fs.readdirSync(dir).sort();
      const inspection = await inspectData(dir, { deep: true });
      assert.deepEqual(fs.readdirSync(dir).sort(), before, "inspect wrote nothing");
      assert.ok(!fs.existsSync(path.join(dir, "games", "holds")), "no hold written by inspect");
      const byId = new Map(inspection.games.map((game) => [game.gameId, game]));
      assert.equal(byId.get(healthy)?.deep?.ok, true);
      assert.deepEqual([byId.get(foreign)?.cls, byId.get(foreign)?.code], ["unreconciled", "claims-active"], "discovery's pass cannot see the foreign actor, and so concludes nothing ...");
      assert.equal(byId.get(foreign)?.deep?.ok, false, "... the deep pass can");
      assert.match(String(byId.get(foreign)?.deep?.reason), /foreign-actor/);
      assert.equal((await verifyGame(dir, healthy)).cls, "active");
      assert.equal(inspection.identity.detail, "no identity store yet");
    }));

  test("gc: a dry run changes nothing; --apply (lock held) moves only archived no-money games past 90 days -- record first, hashed, with a manifest -- and removes only temporaries and old lock asides; an interrupted move resumes", () =>
    withDir("gc", async (dir) => {
      const now = Date.now();
      const movable = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: now - 200 * DAY, archived_at: now - ARCHIVE_HOT_MS - DAY }) });
      fs.writeFileSync(path.join(dir, `${movable}.chat.jsonl`), '{"id":"c1"}\n');
      const hot = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: now - 60 * DAY, archived_at: now - 10 * DAY }) });
      const live = dealtOnDisk(dir, 1);
      const held = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: now - 200 * DAY, archived_at: now - ARCHIVE_HOT_MS - DAY }) });
      await createFileHoldStore(dir, quiet).create(makeHold({ gameId: held, code: "roster-mismatch", detail: "x", at: 1, source: "operator", build: BUILD, rulesEngineVersion: 10 }));
      fs.writeFileSync(path.join(dir, "JUNO-ABC.log.jsonl"), "legacy\n");
      const temporary = path.join(dir, "games", `${live}.json.4242.a1b2c3d4e5f6.tmp`);
      fs.writeFileSync(temporary, "half a record");
      const aside = path.join(dir, `${LOCK_DIRECTORY}.stale.deadbeef`);
      fs.mkdirSync(aside);
      fs.writeFileSync(path.join(aside, "owner.json"), "{}");
      const old = new Date(now - 11 * 60 * 1000);
      fs.utimesSync(aside, old, old);

      const dry = await runGc(dir, { apply: false, now });
      assert.deepEqual(dry.move.map((game) => game.gameId), [movable]);
      assert.deepEqual([dry.temporaries.length, dry.lockAsides.length, dry.applied], [1, 1, false]);
      assert.ok(fs.existsSync(temporary) && fs.existsSync(recordPath(dir, movable)), "a dry run changes nothing");
      await assert.rejects(runGc(dir, { apply: true, now }), /needs the data directory's lock/);

      const ops = createMemoryOpsRecorder();
      /* Taking the lock prunes old asides itself (LIVE-3B); one that appears while the lock is held is gc's to remove. */
      const lateAside = path.join(dir, `${LOCK_DIRECTORY}.stale.feedface`);
      const applied = await withLock(dir, (lock) => {
        fs.mkdirSync(lateAside);
        fs.utimesSync(lateAside, old, old);
        return runGc(dir, { apply: true, lock, ops, now });
      });
      assert.ok(!("refused" in applied));
      if ("refused" in applied) return;
      assert.deepEqual(applied.errors, []);
      assert.deepEqual(applied.moved, [{ gameId: movable, files: 3 }]);
      const archiveDir = path.join(dir, "archive", movable);
      const manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, "manifest.json"), "utf8"));
      assert.deepEqual(manifest.files.map((file: { name: string }) => file.name).sort(), [`${movable}.chat.jsonl`, `${movable}.json`, `${movable}.log.jsonl`].sort());
      assert.equal(manifest.log.entries, 2);
      assert.ok(!fs.existsSync(recordPath(dir, movable)) && !fs.existsSync(logPath(dir, movable)));
      for (const kept of [hot, live, held]) assert.ok(fs.existsSync(recordPath(dir, kept)) && fs.existsSync(logPath(dir, kept)), kept);
      assert.ok(fs.existsSync(holdPath(dir, held)), "a held game's hold is never touched");
      assert.equal(fs.readFileSync(path.join(dir, "JUNO-ABC.log.jsonl"), "utf8"), "legacy\n");
      assert.ok(!fs.existsSync(temporary) && !fs.existsSync(aside) && !fs.existsSync(lateAside));
      assert.deepEqual(ops.lines.map((line) => line.event).sort(), ["gc.archived", "gc.lock-aside-removed", "gc.temporary-removed"]);

      // An interrupted move (the record already moved, the log not): the next run finishes it.
      const second = dealtOnDisk(dir, 1, { record: (r) => ({ ...r, status: "completed", completed_at: now - 200 * DAY, archived_at: now - ARCHIVE_HOT_MS - DAY }) });
      fs.mkdirSync(path.join(dir, "archive", second), { recursive: true });
      fs.renameSync(recordPath(dir, second), path.join(dir, "archive", second, `${second}.json`));
      const resumed = await withLock(dir, (lock) => runGc(dir, { apply: true, lock, ops, now }));
      assert.ok(!("refused" in resumed) && resumed.resume.includes(second));
      assert.ok(fs.existsSync(path.join(dir, "archive", second, "manifest.json")) && !fs.existsSync(logPath(dir, second)));

      // A server afterwards: the moved games are simply not there; nothing is flagged for them.
      const booted = await boot(dir);
      try {
        assert.equal(booted.server.lifecycle.discovery()?.games.has(movable), false);
        assert.equal((await roomFrame(booted.port, ALICE, movable)).code, "not-found");
        assert.equal(classOf(booted, live)?.cls, "unreconciled", "a started game is stage one until it is loaded");
      } finally {
        await stopServer(booted.server);
      }
      const plan = await planGc(dir, { now });
      assert.deepEqual(plan.move, []);
    }));
});
