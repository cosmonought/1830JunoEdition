// server/src/rooms/live4NoMoneyContinuation.test.ts
//
// ==================================================================
//  LIVE-4 (L4-2): NO-MONEY CONTINUATION AT THE SERVER -- THE STAMP, THE VERDICT AT EVERY LOAD, NOTHING WRITTEN, THE DRAIN
// ==================================================================
//
// The process-level half of L4-2 (the session half is `frontend/src/utils/live4NoMoneyContinuation.test.ts`). Servers
// are started, stopped and started again over the SAME file stores, as `live3cRestore.test.ts` does:
//   1. the dealing identity at the server: a table this server deals is stamped {current rules, highest hosted
//      protocol}; a deal written before LIVE-4 (no hosted field) is protocol 1 and continues; a money table is dealt
//      under its money identity, end to end through ESCROW-4 -- never the pool's current;
//   2. T-5 / T-6 across restarts: a release that keeps v11 continues v11 games and deals v12 ones; the release that
//      dropped v11 does not continue them (derived), and this one does not continue the v12 deal;
//   3. every derived "no" (T-3 hosted protocol, T-4 malformed stamp, T-25 newer format) writes NOTHING -- no hold file,
//      no record or log byte -- across restarts; each is discovered or concluded with its `why`, audited once per run,
//      listed in `not_continued`, shown "cannot continue" in Your tables; the one durable hold that stays is today's
//      (a server deal whose rules pin is not an integer: `rules-pin-mismatch`, unchanged);
//   4. the restore line names the dealing build as history only;
//   5. T-24's timer half: a draining pool's resident no-money game past flip + 7 days is refused at its next submit and
//      stopped by the serving review -- the same actor, no reload, every room subscriber told, its cap freed, nothing
//      written; a primary's review is a no-op.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createFileLogStore } from "../fileLogStore";
import type { GameServerOptions } from "../gameServer";
import { serializeBatch } from "../persistence/logFormat";
import { createMemoryOpsRecorder, type MemoryOpsRecorder } from "../persistence/opsRecorder";
import { thisDeploymentCapability } from "../deploymentCapability";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { CURRENT_RULES_REVISION } from "../../../frontend/src/gameEngine/gameVariants";
import { HOSTED_PROTOCOL_VERSION } from "../../../frontend/src/gameEngine/protocolVersions";
import { gameIdentityOfEntries } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import { NO_MONEY_DRAIN_MS, type PoolServingState } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { deploymentCapability, type DeploymentCapability } from "../../../frontend/src/gameEngine/compat/deploymentCapability";
import { mintGameId, type GameRecord } from "./gameRecord";
import { createFileHoldStore } from "./holdStore";
import { createFileRecordStore } from "./recordStore";
import {
  ALICE,
  BOB,
  BUILD,
  BUY,
  Client,
  devIdentity,
  openGame,
  quietConsole,
  seededRecord,
  startServer,
  stopServer,
  storedLog,
  until,
  type Frame,
  type SeenEntry,
} from "./testSupport";
import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet, type MoneyServer } from "../escrow/escrow4Support";
import { PIN } from "../escrow/escrow3bSupport";

quietConsole();

const quiet = { warn: () => undefined };

/* ==================================================================
    FIXTURES: a data directory, its files, and a server over them
   ================================================================== */

function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `live4-l42-${tag}-`));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const recordPath = (dir: string, gameId: string) => path.join(dir, "games", `${gameId}.json`);
const logPath = (dir: string, gameId: string) => path.join(dir, `${gameId}.log.jsonl`);
const holdPath = (dir: string, gameId: string) => path.join(dir, "games", "holds", `${gameId}.json`);
const readRecord = (dir: string, gameId: string) => JSON.parse(fs.readFileSync(recordPath(dir, gameId), "utf8")) as GameRecord;

function writeRecord(dir: string, record: GameRecord): void {
  fs.mkdirSync(path.join(dir, "games"), { recursive: true });
  fs.writeFileSync(recordPath(dir, record.game_id), `${JSON.stringify(record)}\n`);
}

function writeLog(dir: string, gameId: string, entries: readonly ServerLogEntry[]): void {
  fs.writeFileSync(logPath(dir, gameId), entries.map((entry) => serializeBatch([entry])).join(""));
}

/** A deal whose payload is rewritten. */
function withDeal(entries: readonly ServerLogEntry[], change: (setup: Record<string, unknown>) => void): ServerLogEntry[] {
  const payload = JSON.parse(entries[0].payload) as { SetupGame: Record<string, unknown> };
  change(payload.SetupGame);
  return [{ ...entries[0], payload: JSON.stringify(payload) }, ...entries.slice(1)];
}

/** A dealt game on disk, as a restarted server finds it: the seeded record (ALICE host, BOB) and a stored log with
 *  `buys` purchases -- dealt by a session with no pool, so exactly as every game before LIVE-4 was (no hosted field). */
function dealtOnDisk(dir: string, buys = 1, over: { record?: (record: GameRecord) => GameRecord; log?: (entries: ServerLogEntry[]) => ServerLogEntry[] } = {}): string {
  const gameId = mintGameId();
  const log = storedLog(buys);
  const record: GameRecord = { ...seededRecord([ALICE, BOB], { dealt: true, gameId }), rules_engine_version: RULES_ENGINE_VERSION, started_at: log[0].at ?? Date.now() };
  writeRecord(dir, over.record ? over.record(record) : record);
  writeLog(dir, gameId, over.log ? over.log(log) : log);
  return gameId;
}

interface Booted {
  server: Awaited<ReturnType<typeof startServer>>["server"];
  port: number;
  ops: MemoryOpsRecorder;
}

async function boot(dir: string, over: Partial<GameServerOptions> = {}): Promise<Booted> {
  const ops = createMemoryOpsRecorder();
  const { server, port } = await startServer({
    store: createFileLogStore(dir, quiet),
    records: createFileRecordStore(dir, quiet),
    holds: createFileHoldStore(dir, quiet),
    ops,
    ...over,
  });
  await server.lifecycle.ready;
  return { server, port, ops };
}

const classOf = (booted: Booted, gameId: string) => booted.server.lifecycle.inventory().games.find((game) => game.gameId === gameId);

/** The deal a stored log opens with. */
async function dealOf(dir: string, gameId: string): Promise<Record<string, unknown>> {
  const entries = await createFileLogStore(dir, quiet).loadLog(gameId);
  return (JSON.parse(entries[0].payload) as { SetupGame: Record<string, unknown> }).SetupGame;
}

/** A client's hello, answered (the load happens here). */
async function hello(port: number, claim: string, gameId: string): Promise<{ client: Client; answer: Frame }> {
  const client = await Client.open(port, claim);
  client.hello(gameId);
  const answer = await client.next((f) => f.kind === "catch-up" || f.kind === "incompatible" || f.kind === "error", `the hello's answer for ${gameId}`);
  return { client, answer };
}

/** A purchase by `claim`, the seat on turn (in a stored game, `dealtOnDisk`, the second seat moves after one stored
 *  purchase; then the first). `build` is the running server's -- the legacy wire's (protocol 0) stale-tab check still
 *  compares the client's with it. */
async function moveApplies(port: number, gameId: string, tag: string, claim = BOB, build = BUILD): Promise<void> {
  const { client, answer } = await hello(port, claim, gameId);
  try {
    assert.equal(answer.kind, "catch-up", `${gameId}: its history is served`);
    const seen = answer.entries as SeenEntry[];
    client.submit(BUY, { baseIndex: seen[seen.length - 1].index, submissionId: tag, build });
    assert.equal((await client.answerTo(tag)).kind, "applied", `${gameId}: the move is applied`);
  } finally {
    await client.close();
  }
}

/** A capability this build cannot be, for the release-change cases: this build's, with its rules or hosted protocols
 *  replaced (the descriptor is still canonical and validated). */
const releaseWith = (over: Partial<DeploymentCapability>): DeploymentCapability => deploymentCapability({ ...thisDeploymentCapability([]), ...over });
const V12 = RULES_ENGINE_VERSION + 1;
/** A v12 release that keeps v11 (certified dual support) and reads hosted protocols 1 and 2. */
const KEEPS_V11 = releaseWith({ rules: { current: V12, supported: [RULES_ENGINE_VERSION, V12], certified: [] }, hosted_protocols: [1, 2] });
/** A v12 release that dropped v11. */
const DROPPED_V11 = releaseWith({ rules: { current: V12, supported: [V12], certified: [] }, hosted_protocols: [1, 2] });

/* ==================================================================
    1. THE DEALING IDENTITY AT THE SERVER
   ================================================================== */

describe("LIVE-4 L4-2: the deal carries its dealing identity", () => {
  test("a table this server deals is stamped with its current rules and highest hosted protocol (the build is history); a deal written before LIVE-4 has no hosted field, is protocol 1, and continues", () =>
    withDir("stamp", async (dir) => {
      const before = dealtOnDisk(dir, 1);
      assert.equal(Object.prototype.hasOwnProperty.call(await dealOf(dir, before), "hosted_protocol"), false, "a pre-LIVE-4 deal names no hosted protocol");
      const booted = await boot(dir);
      try {
        const { gameId } = await openGame(booted.port, ALICE, [BOB]);
        const deal = await dealOf(dir, gameId);
        assert.deepEqual([deal.rules_engine_version, deal.hosted_protocol, deal.build], [RULES_ENGINE_VERSION, HOSTED_PROTOCOL_VERSION, BUILD]);
        await moveApplies(booted.port, before, "pre-live4-move");
        assert.equal(classOf(booted, before)?.cls, "active");
        assert.deepEqual(gameIdentityOfEntries(await createFileLogStore(dir, quiet).loadLog(before)), {
          kind: "dealt",
          gci: { format: "18COSMOS/GAME-CONTINUATION/v1", rules_engine_version: RULES_ENGINE_VERSION, hosted_protocol: 1 },
        });
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("T-5 (money, end to end through ESCROW-4): on a release that deals v12 under hosted protocol 2, a money table is dealt under its MONEY identity -- rules 11, hosted 1 -- and is continued, not held", async () => {
    const pinned = thisDeploymentCapability([PIN]);
    const world: MoneyServer = await moneyServer({
      capability: deploymentCapability({ ...pinned, rules: { current: V12, supported: [RULES_ENGINE_VERSION, V12], certified: pinned.rules.certified }, hosted_protocols: [1, 2] }),
    });
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const hostWallet = testWallet("host");
      const hostKey = testConsentKey("host");
      const hostLink = await linkWallet(host, table.gameId, hostWallet, hostKey);
      assert.equal(hostLink.status, 200, hostLink.text);
      await hostCreates(world, host, table.gameId, hostWallet, hostKey, hostLink.body?.ticket as string);
      await world.observe();
      const jo = await player(world, "Jo");
      assert.equal((await jo.client.op({ type: "join", code: table.code, takeSeat: true })).ok, true);
      const joWallet = testWallet("jo");
      const joKey = testConsentKey("jo");
      const joLink = await linkWallet(jo, table.gameId, joWallet, joKey);
      await joinerFunds(world, jo, table.gameId, joWallet, joKey, joLink.body?.ticket as string);
      await world.observe();
      const started = await host.client.op({ type: "start-game" }, table.gameId);
      assert.equal(started.ok, true, JSON.stringify(started));
      await world.drive(async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active");

      const dealt = await world.server.rooms.actorFor(table.gameId);
      assert.ok(dealt !== null, "the table's actor");
      const entries = dealt.view.entries;
      const deal = (JSON.parse(entries[0].payload) as { SetupGame: Record<string, unknown> }).SetupGame;
      const mci = (await world.financial.load(table.gameId))?.continuation;
      assert.ok(mci !== undefined && mci !== null, "the table froze a money identity at creation");
      assert.deepEqual([deal.rules_engine_version, deal.hosted_protocol], [mci.rules_engine_version, mci.hosted_protocol], "dealt under the money identity");
      assert.notDeepEqual([deal.rules_engine_version, deal.hosted_protocol], [V12, 2], "never under the pool's current");
      const continuation = world.server.lifecycle.continuation;
      assert.equal(continuation.isMoney(table.gameId), true);
      assert.deepEqual(continuation.verdictOf(table.gameId, gameIdentityOfEntries(entries)), { kind: "continues" }, "the deal agrees with its money identity");
    } finally {
      await world.close();
    }
  });
});

/* ==================================================================
    2. T-5 / T-6 ACROSS RESTARTS
   ================================================================== */

describe("LIVE-4 L4-2 T-5 / T-6: a game continues where its rules and hosted protocol are carried, and nowhere else", () => {
  test("a release that keeps v11 continues a v11 game and deals new ones {12, 2}; this build does not continue the v12 deal; the release that dropped v11 does not continue the v11 game -- derived, nothing written", () =>
    withDir("releases", async (dir) => {
      const v11 = dealtOnDisk(dir, 1);
      let v12 = "";
      /* A: the release that keeps v11. */
      let booted = await boot(dir, { build: "build-twelve", capability: KEEPS_V11 });
      try {
        v12 = (await openGame(booted.port, ALICE, [BOB])).gameId;
        const deal = await dealOf(dir, v12);
        assert.deepEqual([deal.rules_engine_version, deal.hosted_protocol], [V12, 2], "a new deal takes the release's dealing identity");
        await until(() => readRecord(dir, v12).rules_engine_version === V12, "the record caches the deal's pin");
        await moveApplies(booted.port, v11, "keeps-v11", BOB, "build-twelve");
      } finally {
        await stopServer(booted.server);
      }
      const bytes = (gameId: string) => [fs.readFileSync(recordPath(dir, gameId)), fs.readFileSync(logPath(dir, gameId))];
      /* B: this build (v11 only, hosted 1) -- the v12 deal is not continued. */
      const v12Bytes = bytes(v12);
      booted = await boot(dir);
      try {
        assert.equal(booted.server.lifecycle.discovery()?.games.get(v12)?.code, "rules-version-newer");
        const { client, answer } = await hello(booted.port, ALICE, v12);
        assert.deepEqual([answer.kind, answer.why], ["incompatible", "rules-not-supported"]);
        await client.close();
        assert.ok(!fs.existsSync(holdPath(dir, v12)), "derived: no hold file");
        await moveApplies(booted.port, v11, "this-build-v11", ALICE);
      } finally {
        await stopServer(booted.server);
      }
      assert.deepEqual(bytes(v12), v12Bytes, "the v12 game is kept byte for byte");
      /* C: the release that dropped v11 -- the v11 game is not continued; the v12 one is. */
      const v11Bytes = bytes(v11);
      booted = await boot(dir, { build: "build-twelve-only", capability: DROPPED_V11 });
      try {
        assert.equal(booted.server.lifecycle.discovery()?.games.get(v11)?.code, "rules-version-older");
        const { client, answer } = await hello(booted.port, BOB, v11);
        assert.deepEqual([answer.kind, answer.why], ["incompatible", "rules-not-supported"]);
        client.submit(BUY, { baseIndex: 0, submissionId: "dropped-v11", build: "build-twelve-only" });
        assert.equal((await client.answerTo("dropped-v11")).kind, "incompatible");
        await client.close();
        assert.ok(!fs.existsSync(holdPath(dir, v11)), "derived: no hold file");
        const again = await hello(booted.port, ALICE, v12);
        assert.equal(again.answer.kind, "catch-up", "the v12 game continues on the release that deals v12");
        await again.client.close();
      } finally {
        await stopServer(booted.server);
      }
      assert.deepEqual(bytes(v11), v11Bytes, "the v11 game is kept byte for byte");
    }));
});

/* ==================================================================
    3. EVERY DERIVED "NO" WRITES NOTHING
   ================================================================== */

describe("LIVE-4 L4-2: a game this pool does not continue is derived -- concluded, audited and listed, never written", () => {
  test("T-3 hosted protocol, T-4 malformed stamp, T-25 newer rules revision and unknown kind: no hold file, no byte changed, across restarts; the rules-pin-mismatch hold of a non-integer server pin is today's, unchanged", () =>
    withDir("derived", async (dir) => {
      const hostedTwo = dealtOnDisk(dir, 1, { log: (entries) => withDeal(entries, (setup) => (setup.hosted_protocol = 2)) });
      const malformed = dealtOnDisk(dir, 1, { log: (entries) => withDeal(entries, (setup) => (setup.hosted_protocol = "two")) });
      const newerRevision = dealtOnDisk(dir, 1, { log: (entries) => withDeal(entries, (setup) => (setup.variants = { ...(setup.variants as object), rules: CURRENT_RULES_REVISION + 1 })) });
      const unknownKind = dealtOnDisk(dir, 1, {
        log: (entries) => [...entries, { index: entries.length, id: "from-a-newer-build", actor: ALICE, payload: JSON.stringify({ FutureMove: { game_id: 0 } }), at: Date.now() }],
      });
      const fractionalPin = dealtOnDisk(dir, 1, { log: (entries) => withDeal(entries, (setup) => (setup.rules_engine_version = 11.5)) });
      const derived: ReadonlyArray<readonly [string, string, string | null]> = [
        // [game, why, discovery's code from the first line alone (null: only the load can tell)]
        [hostedTwo, "hosted-protocol", "hosted-protocol"],
        [malformed, "malformed", "malformed"],
        [newerRevision, "newer-format", "newer-format"],
        [unknownKind, "newer-format", null],
      ];
      const bytes = new Map(derived.map(([gameId]) => [gameId, [fs.readFileSync(recordPath(dir, gameId)), fs.readFileSync(logPath(dir, gameId))]]));
      for (let restart = 0; restart < 2; restart += 1) {
        const booted = await boot(dir);
        try {
          for (const [gameId, , code] of derived) {
            const found = booted.server.lifecycle.discovery()?.games.get(gameId);
            if (code !== null) assert.deepEqual([found?.cls, found?.code], ["incompatible", code], `${gameId}: discovered from its deal line`);
            else assert.notEqual(found?.cls, "incompatible", `${gameId}: the first line alone cannot tell`);
          }
          /* Today's durable hold for a server deal whose rules pin is not an integer (reconcile, unchanged by L4-2). */
          assert.deepEqual([classOf(booted, fractionalPin)?.cls, classOf(booted, fractionalPin)?.code], ["held", "rules-pin-mismatch"]);
          for (const [gameId, why] of derived) {
            const { client, answer } = await hello(booted.port, ALICE, gameId);
            assert.deepEqual([answer.kind, answer.why], ["incompatible", why], `${gameId}: the hello`);
            client.roomHello(gameId);
            assert.equal(((await client.next((f) => f.kind === "room")).view as { holdKind: string }).holdKind, "incompatible", `${gameId}: the view`);
            client.submit(BUY, { baseIndex: 1, submissionId: `derived-${restart}` });
            const refused = await client.answerTo(`derived-${restart}`);
            assert.deepEqual([refused.kind, refused.why], ["incompatible", why], `${gameId}: a move`);
            await client.close();
            await until(() => classOf(booted, gameId)?.cls === "incompatible", `${gameId} concluded not continued`);
            assert.equal(classOf(booted, gameId)?.code, why, `${gameId}: concluded with its why`);
          }
          /* A second load of each in the same run adds no audit line. */
          for (const [gameId] of derived) await (await hello(booted.port, BOB, gameId)).client.close();
          for (const [gameId, why] of derived) {
            const lines = booted.ops.lines.filter((line) => line.event === "game.not-continued" && line.game_id === gameId);
            assert.equal(lines.length, 1, `${gameId}: audited once in this run`);
            assert.equal(lines[0].why, why);
          }
          await until(() => {
            const status = booted.ops.snapshots.at(-1) as { not_continued?: Array<{ game_id: string; why: string }> } | undefined;
            return derived.every(([gameId, why]) => status?.not_continued?.some((row) => row.game_id === gameId && row.why === why) === true);
          }, "every derived game in the status's not_continued list");
          const status = booted.ops.snapshots.at(-1) as Record<string, unknown>;
          assert.equal("read_only" in status, false, "no build-pinned read_only list any more");
          const mine = await Client.open(booted.port, ALICE);
          const tables = ((await mine.op({ type: "my-tables" })).data as { tables: Array<{ gameId: string; state: string }> }).tables;
          await mine.close();
          for (const [gameId] of derived) assert.equal(tables.find((table) => table.gameId === gameId)?.state, "cannot-continue", `${gameId}: Your tables`);
        } finally {
          await stopServer(booted.server);
        }
        for (const [gameId] of derived) {
          assert.ok(!fs.existsSync(holdPath(dir, gameId)), `${gameId}: no hold file`);
          const [record, log] = bytes.get(gameId) as Buffer[];
          assert.ok(fs.readFileSync(recordPath(dir, gameId)).equals(record), `${gameId}: the record is exactly as it was`);
          assert.ok(fs.readFileSync(logPath(dir, gameId)).equals(log), `${gameId}: the log is exactly as it was`);
        }
        assert.ok(fs.existsSync(holdPath(dir, fractionalPin)), "the rules-pin-mismatch hold is today's durable hold");
      }
    }));

  test("a history this pool does not read is never judged by its reading: a foreign actor in a hosted-protocol-2 log writes no hold here, where the same entry in a protocol-1 log is held (today's check, unchanged)", () =>
    withDir("unread-history", async (dir) => {
      const foreign = (entries: ServerLogEntry[]) => entries.map((entry, index) => (index === 1 ? { ...entry, actor: "p-mallory" } : entry));
      const readHere = dealtOnDisk(dir, 1, { log: foreign });
      const notReadHere = dealtOnDisk(dir, 1, { log: (entries) => withDeal(foreign(entries), (setup) => (setup.hosted_protocol = 2)) });
      /* A first-line disagreement (the record caches another pin than the deal names): discovery's own record check. */
      const pinCached = (record: GameRecord) => ({ ...record, rules_engine_version: RULES_ENGINE_VERSION + 7 });
      const headReadHere = dealtOnDisk(dir, 1, { record: pinCached });
      const headNotReadHere = dealtOnDisk(dir, 1, { record: pinCached, log: (entries) => withDeal(entries, (setup) => (setup.hosted_protocol = 2)) });
      const bytes = [fs.readFileSync(recordPath(dir, notReadHere)), fs.readFileSync(logPath(dir, notReadHere))];
      const booted = await boot(dir);
      try {
        assert.deepEqual([classOf(booted, notReadHere)?.cls, classOf(booted, notReadHere)?.code], ["incompatible", "hosted-protocol"], "discovery: derived, from the deal line, before any record check");
        assert.deepEqual([classOf(booted, headReadHere)?.cls, classOf(booted, headReadHere)?.code], ["held", "rules-pin-mismatch"], "a protocol-1 deal line: today's discovery hold");
        assert.deepEqual([classOf(booted, headNotReadHere)?.cls, classOf(booted, headNotReadHere)?.code], ["incompatible", "hosted-protocol"], "a protocol-2 deal line: never judged here");
        assert.ok(!fs.existsSync(holdPath(dir, headNotReadHere)), "no discovery hold for a history this pool does not read");
        for (const gameId of [readHere, notReadHere]) await (await hello(booted.port, ALICE, gameId)).client.close();
        await until(() => classOf(booted, readHere)?.cls === "held", "the protocol-1 log's foreign actor is held (today's reconcile)");
        assert.equal(classOf(booted, readHere)?.code, "foreign-actor");
        assert.ok(fs.existsSync(holdPath(dir, readHere)), "today's durable hold, unchanged");
        assert.deepEqual([classOf(booted, notReadHere)?.cls, classOf(booted, notReadHere)?.code], ["incompatible", "hosted-protocol"], "the load: still derived");
      } finally {
        await stopServer(booted.server);
      }
      assert.ok(!fs.existsSync(holdPath(dir, notReadHere)), "no hold written for a history this pool does not read");
      assert.deepEqual([fs.readFileSync(recordPath(dir, notReadHere)), fs.readFileSync(logPath(dir, notReadHere))], bytes, "kept byte for byte");
    }));

  test("the restore line names the dealing build as history only, and a game not continued as derived", () =>
    withDir("restore-line", async (dir) => {
      const otherBuild = dealtOnDisk(dir, 1, { log: (entries) => withDeal(entries, (setup) => (setup.build = "an-older-build")) });
      const hostedTwo = dealtOnDisk(dir, 1, { log: (entries) => withDeal(entries, (setup) => (setup.hosted_protocol = 2)) });
      const booted = await boot(dir);
      const said: string[] = [];
      const [log, warn] = [console.log, console.warn];
      console.log = (...args: unknown[]) => void said.push(args.map(String).join(" "));
      console.warn = (...args: unknown[]) => void said.push(args.map(String).join(" "));
      try {
        await moveApplies(booted.port, otherBuild, "restore-line-move");
        await (await hello(booted.port, ALICE, hostedTwo)).client.close();
      } finally {
        [console.log, console.warn] = [log, warn];
        await stopServer(booted.server);
      }
      const dealt = said.filter((line) => line.includes('was dealt on build "an-older-build"'));
      assert.equal(dealt.length, 1, said.join("\n"));
      assert.match(dealt[0], /diagnostic only/);
      assert.equal(said.some((line) => /will refuse to continue|#1252/.test(line)), false);
      const held = said.find((line) => line.includes("NOT CONTINUED here (hosted-protocol)"));
      assert.ok(held !== undefined, said.join("\n"));
      assert.match(held, /Derived: nothing was written/);
    }));
});

/* ==================================================================
    4. T-24: THE SERVING REVIEW OF A RESIDENT GAME
   ================================================================== */

describe("LIVE-4 L4-2 T-24 (the timer half): a draining pool stops serving a resident no-money game at flip + 7 days -- without reloading its actor", () => {
  test("served before the deadline; after it the next submit is refused and the review stops serving it: the same actor, every room subscriber told, its cap freed, nothing written; the review is one-way", () =>
    withDir("drain", async (dir) => {
      let skew = 0;
      const flippedAt = Date.now() - NO_MONEY_DRAIN_MS + 10 * 60 * 1000; // the deadline: ten minutes from now
      const draining: PoolServingState = { role: "draining", flipped_at: flippedAt };
      const booted = await boot(dir, {
        identity: devIdentity({ now: () => Date.now() + skew }),
        pool: () => draining,
        limits: { rooms: { maxHostedRooms: 1 } },
      });
      try {
        const { gameId } = await openGame(booted.port, ALICE, [BOB]);
        const actor = await booted.server.rooms.actorFor(gameId);
        const resident = booted.server.residentGames();
        const alice = await Client.open(booted.port, ALICE);
        alice.hello(gameId);
        const history = await alice.next((f) => f.kind === "catch-up");
        alice.roomHello(gameId);
        assert.equal(((await alice.next((f) => f.kind === "room")).view as { holdKind: string | null }).holdKind, null);
        const bob = await Client.open(booted.port, BOB);
        bob.roomHello(gameId);
        await bob.next((f) => f.kind === "room");
        alice.submit(BUY, { baseIndex: (history.entries as SeenEntry[]).at(-1)?.index ?? 0, submissionId: "before" });
        const first = await alice.answerTo("before");
        assert.equal(first.kind, "applied", "served before the deadline");
        const created = await alice.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "A" });
        assert.equal(created.code, "limit-reached", "a served game holds its host's cap");
        const logBefore = fs.readFileSync(logPath(dir, gameId));

        skew = 20 * 60 * 1000; // past the deadline
        bob.hello(gameId);
        const bobHistory = await bob.next((f) => f.kind === "catch-up");
        bob.submit(BUY, { baseIndex: (bobHistory.entries as SeenEntry[]).at(-1)?.index ?? 0, submissionId: "after" });
        const refused = await bob.answerTo("after");
        assert.deepEqual([refused.kind, refused.why], ["incompatible", "drain-expired"], "refused at its next submit, before any review");
        assert.ok(fs.readFileSync(logPath(dir, gameId)).equals(logBefore), "nothing appended");

        const viewsBefore = bob.of("room").length;
        const statusBefore = alice.of("status").length;
        assert.equal(await booted.server.lifecycle.reviewServing(), 1, "the review stops serving one game");
        await until(() => bob.of("room").length > viewsBefore, "the republished view reaches a room subscriber");
        await until(() => alice.of("status").length > statusBefore, "a log subscriber is told, as a version hold is announced");
        const told = alice.of("status").at(-1) as Frame;
        assert.deepEqual([told.state, told.reason], ["held", refused.reason], "held, with the same sentence its next submit gets");
        assert.equal((bob.of("room").at(-1)?.view as { holdKind: string }).holdKind, "incompatible");
        assert.equal(await booted.server.rooms.actorFor(gameId), actor, "the same actor: nothing was reloaded");
        assert.equal(booted.server.residentGames(), resident);
        await until(() => classOf(booted, gameId)?.code === "drain-expired", "concluded drain-expired");
        assert.equal(booted.ops.lines.filter((line) => line.event === "game.not-continued" && line.game_id === gameId && line.source === "serving").length, 1);
        const again = await hello(booted.port, ALICE, gameId);
        assert.deepEqual([again.answer.kind, again.answer.why], ["incompatible", "drain-expired"], "no history is served any more");
        await again.client.close();
        assert.equal((await alice.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "A" })).ok, true, "a game no longer served holds no cap");
        assert.equal(await booted.server.lifecycle.reviewServing(), 0, "one way: nothing more to stop");
        assert.ok(fs.readFileSync(logPath(dir, gameId)).equals(logBefore), "the log is exactly as it was");
        assert.ok(!fs.existsSync(holdPath(dir, gameId)), "derived: no hold file");
        await alice.close();
        await bob.close();
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("a refused deal's rollback that concludes 'not served' is published at once: the waiting table stops being served, its view says so, its cap is freed -- no review needed, nothing written", () =>
    withDir("drain-deal", async (dir) => {
      let skew = 0;
      const flippedAt = Date.now() - NO_MONEY_DRAIN_MS + 10 * 60 * 1000;
      const booted = await boot(dir, {
        identity: devIdentity({ now: () => Date.now() + skew }),
        pool: () => ({ role: "draining", flipped_at: flippedAt }),
        limits: { rooms: { maxHostedRooms: 1 } },
      });
      try {
        const { gameId } = await openGame(booted.port, ALICE, [BOB], { start: false });
        const alice = await Client.open(booted.port, ALICE);
        alice.roomHello(gameId);
        assert.equal(((await alice.next((f) => f.kind === "room")).view as { holdKind: string | null }).holdKind, null);
        skew = 20 * 60 * 1000; // past the deadline, and no serving review has run
        const viewsBefore = alice.of("room").length;
        const started = await alice.op({ type: "start-game" }, gameId);
        assert.equal(started.ok, false, "the deal is not made on a pool that no longer serves the table");
        await until(() => alice.of("room").length > viewsBefore && (alice.of("room").at(-1)?.view as { holdKind: string | null }).holdKind === "incompatible", "the view is republished as not served");
        await until(() => classOf(booted, gameId)?.code === "drain-expired", "concluded drain-expired");
        assert.equal(booted.ops.lines.filter((line) => line.event === "game.not-continued" && line.game_id === gameId && line.source === "rebuild").length, 1);
        assert.equal((await alice.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "A" })).ok, true, "a table no longer served holds no cap");
        assert.equal(await booted.server.lifecycle.reviewServing(), 0, "the review has nothing left to stop");
        await alice.close();
        assert.equal(fs.existsSync(logPath(dir, gameId)) ? fs.readFileSync(logPath(dir, gameId)).length : 0, 0, "no deal was written");
        assert.ok(!fs.existsSync(holdPath(dir, gameId)), "derived: no hold file");
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("a primary pool's review is a no-op: it never declines a game it continues", async () => {
    const { server, port } = await startServer();
    try {
      const { gameId } = await openGame(port, ALICE, [BOB]);
      await server.rooms.actorFor(gameId);
      assert.equal(await server.lifecycle.reviewServing(), 0);
      assert.equal(server.lifecycle.continuation.hasServingPolicy(), false);
    } finally {
      await stopServer(server);
    }
  });
});
