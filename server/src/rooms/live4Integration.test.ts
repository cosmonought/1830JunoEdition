// server/src/rooms/live4Integration.test.ts
//
// ==================================================================
//  LIVE-4 INTEGRATION: THE CROSS-SLICE REGRESSIONS (L4-1 .. L4-5 ON ONE TREE)
// ==================================================================
//
// Each slice pinned its own half. What only the combined tree can show is pinned here:
//
//   ONE CAPABILITY, ONE RUNTIME  the session side (L4-2's continuation wiring), the money side (L4-4's serving) and the
//                                client side (L4-3's `clientVerdict`) judge against ONE deployment capability, and the
//                                session reads the SAME verification-grade chain facts the money side records.
//   AGREEMENT (C, D, E)          for every money fact the index holds, the session's verdict and the money seams'
//                                verdict are the same answer: another deployment and a configuration typo are
//                                derived on both sides and write nothing; a verified chain contradiction is a conflict
//                                on both sides -- the owner holds it, and RoomSession refuses the game at once.
//   N-3 (F)                      a complete log line this build cannot read is a newer build's format: never
//                                truncated, rewritten or repaired; the game is not continued here (derived), on every
//                                load and across restarts. A genuinely torn tail keeps its recovery.
//   A, B                         a protocol-1 tab on another build plays a no-money game dealt on another build; the
//                                legacy wire keeps its exact-build compare and receives no LIVE-4 frame.
//   I                            the hosted revenue seed is still a cryptographic draw.
//   D (test support)             ESCROW-4's support index coordinator stays an index: it never writes.

import { strict as assert } from "assert";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, test } from "node:test";

import { createFileLogStore } from "../fileLogStore";
import { StoreCorruptError, StoreIncompatibleError } from "../persistence/storeResult";
import { scanLog, serializeBatch } from "../persistence/logFormat";
import { createMemoryOpsRecorder, type MemoryOpsRecorder } from "../persistence/opsRecorder";
import type { GameServerOptions } from "../gameServer";
import { createContinuationWiring } from "../continuationWiring";
import { thisDeploymentCapability } from "../deploymentCapability";
import { dealIdentityOfLog, logFormatOfLog } from "../escrow/dealIdentity";
import { repairBytes } from "../tools/logDoctor";
import { moneyDecisionOnDisk } from "../tools/gamesDoctor";
import { createFileFinancialGameStore } from "../escrow/financialGameStore";
import { createMemoryFinancialGameStore, type MemoryFinancialGameStore } from "../escrow/financialGameStore";
import { currentMoneyContinuation } from "../escrow/moneyContinuation";
import { newFinancialRecord, transitionFinancial, type FinancialDeploymentPin, type FinancialGameRecord } from "../escrow/moneyLifecycle";
import { createMoneyServing, type MoneyServing } from "../escrow/moneyServing";
import { createSettlementCoordinator } from "../escrow/settlementCoordinator";
import { serverPrefixReplay } from "../escrow/settlementEvidence";
import { CANONICAL_CHECKSUM, PIN, T0, WALLETS } from "../escrow/escrow3bSupport";
import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, testConsentKey, testWallet } from "../escrow/escrow4Support";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/settlementAppraisal";
import {
  ACCEPTED_CLIENT_PROTOCOLS,
  CLIENT_PROTOCOL_VERSION,
  FINANCIAL_PROTOCOL_VERSION,
  HOSTED_PROTOCOL_VERSION,
} from "../../../frontend/src/gameEngine/protocolVersions";
import { GAME_CONTINUATION_FORMAT, gameIdentityOfEntries, type GameIdentityFacts } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import type { ContinuationVerdict, FormatFact } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { compatibilityKey, deploymentKey } from "../../../frontend/src/gameEngine/compat/deploymentCapability";
import { MONEY_TABLE_FORMAT, mintGameId, type GameRecord } from "./gameRecord";
import { sealOf, type TerminalSeal } from "./lifecycle";
import { createFileHoldStore } from "./holdStore";
import { createFileRecordStore } from "./recordStore";
import { ALICE, BOB, BUILD, BUY, Client, probeSession, quietConsole, seededRecord, startServer, stopServer, storedLog, until, type Frame, type SeenEntry } from "./testSupport";

quietConsole();

const quiet = { warn: () => undefined };
const REPO = path.resolve(__dirname, "..", "..", "..", "..", "..");
const source = (relative: string) => fs.readFileSync(path.join(REPO, relative), "utf8");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Code only: comments may describe the retired model; code may not use it. (Line comments are dropped only where
 *  `//` starts a comment -- not inside a URL-like string, which these files do not carry.) */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const why = (verdict: ContinuationVerdict): string => (verdict.kind === "continues" ? "continues" : `${verdict.kind}/${verdict.why}`);

/* ================================================================================================= */
/* Fixtures                                                                                          */
/* ================================================================================================= */

const GAME = "g_1111111111111111111111111w";
const OTHER_CHECKSUM = "ab".repeat(32);
/** Contract B: another escrow deployment on the same chain. */
const PIN_B: FinancialDeploymentPin = Object.freeze({ ...PIN, contract_address: WALLETS[2] });
/** Contract A configured with a mistyped denom: the same deployment key, another configured fact. */
const PIN_TYPO: FinancialDeploymentPin = Object.freeze({ ...PIN, denom: "ujunoy" });
const KEY_A = deploymentKey(PIN);
const DEALT: GameIdentityFacts = { kind: "dealt", gci: { format: GAME_CONTINUATION_FORMAT, rules_engine_version: RULES_ENGINE_VERSION, hosted_protocol: HOSTED_PROTOCOL_VERSION } };

function termsOf(pin: FinancialDeploymentPin) {
  return { format: MONEY_TABLE_FORMAT, backend: pin.backend, chain_id: pin.chain_id, network_class: pin.network_class, contract_address: pin.contract_address, code_checksum: pin.code_checksum, denom: pin.denom, symbol: "JUNOX", exponent: 6, ante_gross: "1010000", mode: "live" };
}

/** A money GameRecord (dealt) whose terms name `pin`. */
function moneyRecord(gameId: string, pin: FinancialDeploymentPin): GameRecord {
  return { ...seededRecord([ALICE, BOB], { dealt: true, gameId, now: T0 }), money: termsOf(pin) } as unknown as GameRecord;
}

function dealtFin(gameId: string, pin: FinancialDeploymentPin): FinancialGameRecord {
  const moved = transitionFinancial(newFinancialRecord(gameId, currentMoneyContinuation(), T0, pin), { kind: "dealt", at: T0 + 1 });
  assert.equal(moved.kind, "moved");
  return (moved as { next: FinancialGameRecord }).next;
}

/** One pool as `start.ts` assembles it: the money serving (its capability and runtime), the settlement coordinator
 *  over the financial store (the money facts' index AND the verdict-before-write seam), and the session wiring built
 *  from the SAME capability and runtime. */
function poolOver(store: MemoryFinancialGameStore, serving: MoneyServing, record: GameRecord, log: FormatFact = "current", artifacts: { tickets?: FormatFact; intents?: FormatFact } = {}) {
  const coordinator = createSettlementCoordinator({
    store,
    replay: serverPrefixReplay(BUILD),
    now: () => T0 + 10,
    warn: () => undefined,
    serving,
    readDeal: async () => DEALT,
    readLogFormat: async () => log,
    /* The escrow service's `artifactFormatsOf` (read-only), as `start.ts` wires it. */
    artifactFormats: async () => artifacts,
    schedule: () => ({ cancel: () => undefined }),
  });
  const wiring = createContinuationWiring({
    capability: serving.capability,
    runtime: serving.runtime(),
    policy: { legacyLogs: "refuse" },
    moneyFacts: coordinator,
    recordOf: (gameId) => (gameId === record.game_id ? record : null),
    now: () => T0 + 10,
  });
  return { coordinator, wiring };
}

const chainRead = (checksum: string, denom: string) => ({ kind: "read" as const, key: KEY_A, facts: { code_checksum: checksum, denom }, read_at: T0 });

function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `live4-int-${tag}-`));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/* ================================================================================================= */
/* 1. One capability, one runtime                                                                     */
/* ================================================================================================= */

describe("LIVE-4 integration: one deployment capability and one chain-facts runtime per process", () => {
  test("start.ts builds the capability once, from the money serving, and hands the sessions that serving's runtime -- no second descriptor anywhere", () => {
    const start = source("server/src/start.ts");
    assert.match(start, /capability = serving\.capability;/, "the capability is the money serving's");
    assert.match(start, /runtime: serving\.runtime\(\),/, "the sessions read the money side's chain facts");
    assert.match(start, /serving\.onChainFacts\(/, "a change in the chain facts re-asks every resident verdict");
    assert.equal(/thisDeploymentCapability\(/.test(start), false, "start.ts constructs no capability of its own");
    /* L4-3's client verdict is judged against the wiring's (validated) capability -- the one passed in. */
    const server = source("server/src/gameServer.ts");
    assert.match(server, /clientVerdict\(client, continuation\.capability, null\)/);
    assert.match(server, /clientVerdict\(client\.announcement, continuation\.capability, pin\)/);
    /* The escrow service's serving is built from this build's constants over the configured pin. */
    const serving = source("server/src/escrow/escrowService.ts");
    assert.match(serving, /servingCapability\(\[backend\.pin\]/);
  });

  test("a running money server: the game server's capability key (the sessions' and the client verdict's) is the escrow service's", async () => {
    const world = await moneyServer();
    try {
      const ofServer = compatibilityKey(world.server.lifecycle.capability);
      assert.equal(ofServer, compatibilityKey(world.service.serving.capability), "one capability");
      assert.equal(ofServer, compatibilityKey(thisDeploymentCapability([PIN])), "this build, serving the fixture pin");
    } finally {
      await world.close();
    }
  });
});

/* ================================================================================================= */
/* 2. The session and the money seams agree (C, D, E)                                                */
/* ================================================================================================= */

describe("LIVE-4 integration: the session's money verdict and the money seams' verdict are the same answer", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly serves: FinancialDeploymentPin;
    readonly fin: FinancialGameRecord | "newer" | "unreadable";
    readonly read: ReturnType<typeof chainRead> | null;
    /** The log's format class as its reader (the session) and the money side's read-only reader both classify it. */
    readonly log?: FormatFact;
    /** The ticket ledger's / chain intents' classes (the escrow service's `artifactFormatsOf`). */
    readonly artifacts?: { tickets?: FormatFact; intents?: FormatFact };
    readonly expected: string;
    /** The owner's durable write for a verified conflict (only then). */
    readonly holds: string | null;
  }> = [
    { name: "its escrow is served and the chain agrees", serves: PIN, fin: dealtFin(GAME, PIN), read: chainRead(CANONICAL_CHECKSUM, PIN.denom), expected: "continues", holds: null },
    { name: "C: money on another deployment", serves: PIN_B, fin: dealtFin(GAME, PIN), read: null, expected: "not-continued/deployment-unavailable", holds: null },
    { name: "D: a configuration typo, the chain unread", serves: PIN_TYPO, fin: dealtFin(GAME, PIN), read: null, expected: "not-continued/deployment-unverified", holds: null },
    { name: "D: a configuration typo, the chain agreeing with the GAME", serves: PIN_TYPO, fin: dealtFin(GAME, PIN), read: chainRead(CANONICAL_CHECKSUM, PIN.denom), expected: "not-continued/deployment-unverified", holds: null },
    { name: "E: a verified contradiction (the contract reports other code)", serves: PIN, fin: dealtFin(GAME, PIN), read: chainRead(OTHER_CHECKSUM, PIN.denom), expected: "conflict/deployment-conflict", holds: "binding-mismatch" },
    { name: "E: a verified contradiction (the contract reports another denom)", serves: PIN, fin: dealtFin(GAME, PIN), read: chainRead(CANONICAL_CHECKSUM, "uother"), expected: "conflict/deployment-conflict", holds: "binding-mismatch" },
    { name: "a newer build's financial record", serves: PIN, fin: "newer", read: chainRead(CANONICAL_CHECKSUM, PIN.denom), expected: "not-continued/newer-format", holds: null },
    { name: "a damaged financial record", serves: PIN, fin: "unreadable", read: chainRead(CANONICAL_CHECKSUM, PIN.denom), expected: "not-continued/malformed", holds: null },
    { name: "a newer build's chain intents beside a readable record", serves: PIN, fin: dealtFin(GAME, PIN), read: chainRead(CANONICAL_CHECKSUM, PIN.denom), artifacts: { intents: "newer" }, expected: "not-continued/newer-format", holds: null },
    { name: "a log a newer build wrote (T-25's unknown kind, or N-3's unreadable line)", serves: PIN, fin: dealtFin(GAME, PIN), read: chainRead(CANONICAL_CHECKSUM, PIN.denom), log: "newer", expected: "not-continued/newer-format", holds: null },
  ];

  for (const c of cases) {
    test(`${c.name}: session and money say ${c.expected}; ${c.holds === null ? "nothing is written, by any seam" : `only the owner writes, under ${c.holds}`}`, async () => {
      const store = createMemoryFinancialGameStore();
      if (typeof c.fin === "string") store.records.set(GAME, c.fin);
      else store.records.set(GAME, c.fin);
      const writesBefore = store.writes.count;
      const serving = createMoneyServing({ capability: thisDeploymentCapability([c.serves]) });
      if (c.read !== null) serving.recordChainFacts(c.read);
      const record = moneyRecord(GAME, PIN);
      const log = c.log ?? "current";
      const { coordinator, wiring } = poolOver(store, serving, record, log, c.artifacts ?? {});
      await coordinator.load();

      /* The two sides, over the same facts. */
      const money = serving.decide({ fin: typeof c.fin === "string" ? (c.fin === "newer" ? "newer" : "corrupt") : "current", record: typeof c.fin === "string" ? null : c.fin, identity: DEALT, log, ...(c.artifacts ?? {}) });
      assert.equal(why(money.verdict), c.expected, "the money seam");
      assert.equal(why(wiring.verdictOf(GAME, DEALT, log)), c.expected, "the session's verdict");

      if (c.expected === "continues") {
        assert.equal(why(coordinator.moneyServingOf(GAME, DEALT)?.verdict as ContinuationVerdict), c.expected, "the coordinator's own synchronous decision");
        return;
      }
      /* Every writing seam of the coordinator: a liveness sweep (which reads the log's class from disk) and a sealed
         game's job. */
      const entries = storedLog(3);
      await coordinator.sweepLiveness([record]);
      assert.equal(why(coordinator.moneyServingOf(GAME, DEALT)?.verdict as ContinuationVerdict), c.expected, "the coordinator's own synchronous decision");
      coordinator.onGameplayClosed({ gameId: GAME, record, seal: sealOf(entries, true) as TerminalSeal, recovered: false, entries });
      await coordinator.drain();
      const after = typeof c.fin === "string" ? null : await store.load(GAME);
      if (c.holds === null) {
        assert.equal(store.writes.count, writesBefore, "not one write: derived");
        if (after !== null) assert.equal(after.phase, "in-progress", "never held");
      } else {
        assert.ok(after !== null);
        assert.deepEqual([after.phase, after.hold?.code], ["held", c.holds], "the owner holds it under its canonical code");
      }
      /* And the session refuses it -- derived there, whatever the money side wrote. (A newer build's log is the session's
         own reading: pinned by the T-25 and N-3 suites.) */
      if (c.log !== undefined) return;
      const session = probeSession(`agree-${c.name}`, wiring.sessionFor(GAME));
      session.restore(storedLog(1));
      const seat = session.state.player_addresses[1];
      const answer = session.submit({ actor: seat, build: BUILD, msg: BUY as never, baseIndex: session.nextIndex - 1, submissionId: "agree" });
      assert.equal(answer.kind, "incompatible", "gameplay may not continue");
      assert.equal((answer as { why?: string }).why, c.expected.startsWith("conflict/") ? c.expected : c.expected.replace("not-continued/", ""));
      assert.equal(session.entries.length, 2, "nothing appended");
    });
  }

  test("E, while resident: a session playing a served game is stopped by the continuation review the room host runs when a verified contradiction is recorded -- no rebuild -- and refuses every later move", async () => {
    const store = createMemoryFinancialGameStore();
    store.records.set(GAME, dealtFin(GAME, PIN));
    const serving = createMoneyServing({ capability: thisDeploymentCapability([PIN]) });
    serving.recordChainFacts(chainRead(CANONICAL_CHECKSUM, PIN.denom));
    const { coordinator, wiring } = poolOver(store, serving, moneyRecord(GAME, PIN));
    await coordinator.load();
    const session = probeSession("resident", wiring.sessionFor(GAME));
    session.restore(storedLog(1));
    const seats = session.state.player_addresses;
    assert.equal(session.submit({ actor: seats[1], build: BUILD, msg: BUY as never, baseIndex: session.nextIndex - 1, submissionId: "before" }).kind, "applied", "served and continued: it plays");
    const told: string[] = [];
    serving.onChainFacts((key) => told.push(key));
    serving.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
    assert.deepEqual(told, [KEY_A], "the change is announced (the room host re-asks every resident verdict)");
    serving.recordChainFacts(chainRead(OTHER_CHECKSUM, PIN.denom));
    assert.deepEqual(told, [KEY_A], "the same facts again are no change");
    const length = session.entries.length;
    assert.equal(session.reviewServing(), false, "the drain timer's review asks only the serving decision (L4-2, unchanged)");
    assert.equal(session.reviewContinuation(), true, "the continuation review (what the room host runs on the change) stops it");
    assert.equal(session.incompatible?.why, "conflict/deployment-conflict");
    const refused = session.submit({ actor: seats[0], build: BUILD, msg: BUY as never, baseIndex: session.nextIndex - 1, submissionId: "after" });
    assert.deepEqual([refused.kind, (refused as { why?: string }).why], ["incompatible", "conflict/deployment-conflict"]);
    assert.equal(session.entries.length, length, "nothing appended");
    assert.equal(session.reviewContinuation(), false, "one way");
  });

  test("E, end to end (ESCROW-4 world): a dealt money table is played until the chain contradicts its binding at verification grade; then the owner holds it AND the room refuses it -- hello, move and room view", async () => {
    const world = await moneyServer();
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
      assert.equal((await host.client.op({ type: "start-game" }, table.gameId)).ok, true);
      await world.drive(async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active");

      const actor = await world.server.rooms.actorFor(table.gameId);
      assert.ok(actor !== null);
      const identity = gameIdentityOfEntries(actor.view.entries);
      assert.equal(why(world.server.lifecycle.continuation.verdictOf(table.gameId, identity)), "continues");
      assert.equal(actor.view.incompatible, null, "played");
      /* A move is made, so the session holds its verdict (the one a rebuild concluded) -- what follows must be the
         continuation review asking it again, not a first lazy ask. */
      let moved = false;
      for (const who of [host, jo]) {
        who.client.hello(table.gameId);
        const seen = (await who.client.next((f: Frame) => f.kind === "catch-up", "a catch-up")).entries as SeenEntry[];
        const tag = `money-move-${who.name}`;
        who.client.submit(BUY, { baseIndex: seen[seen.length - 1].index, submissionId: tag });
        if ((await who.client.answerTo(tag)).kind === "applied") {
          moved = true;
          break;
        }
      }
      assert.ok(moved, "the seat on turn moves: the money game is being played");

      /* The contract now reports other code, read at verification grade. */
      world.chain.reportedChecksum = OTHER_CHECKSUM;
      assert.equal((await world.service.refreshChainFacts()).kind, "read");
      /* The money serving announced the change and the room host's continuation review ran (awaited here). */
      await world.server.lifecycle.reviewContinuation();
      assert.notEqual(actor.view.incompatible, null, "stopped by the continuation review itself, before anything else runs");
      const decided = await world.service.servingDecision(table.gameId);
      assert.deepEqual([why(decided.verdict), decided.owner], ["conflict/deployment-conflict", true], "the money side");
      assert.equal(why(world.server.lifecycle.continuation.verdictOf(table.gameId, identity)), "conflict/deployment-conflict", "the session side: the same runtime");
      await until(() => actor.view.incompatible !== null, "the resident session stops serving it (no reload)");
      assert.equal(await world.server.rooms.actorFor(table.gameId), actor, "the same actor");

      /* The owner writes the canonical hold; the session side writes nothing of its own. */
      await world.service.sweepChain();
      await world.service.idle();
      const fin = await world.financial.load(table.gameId);
      assert.deepEqual([fin?.phase, fin?.hold?.code], ["held", "binding-mismatch"]);

      /* The room refuses it. */
      const mark = host.client.frames.length;
      host.client.hello(table.gameId);
      const answer = await host.client.next((f: Frame) => host.client.frames.indexOf(f) >= mark && (f.kind === "catch-up" || f.kind === "incompatible"), "the hello's answer after the contradiction");
      assert.deepEqual([answer.kind, answer.why], ["incompatible", "conflict/deployment-conflict"]);
    } finally {
      await world.close();
    }
  });
});

/* ================================================================================================= */
/* 3. D (test support): ESCROW-4's support index coordinator never writes                             */
/* ================================================================================================= */

describe("LIVE-4 integration: ESCROW-4's test-support money index stays an index", () => {
  test("its coordinator is given no serving (so step -1 continues and owns nothing) and is never the server's settlement lifecycle", () => {
    const support = source("server/src/escrow/escrow4Support.ts");
    const made = /const moneyFacts = createSettlementCoordinator\(\{([^\n]*)\}\);/.exec(support);
    assert.ok(made !== null, "the index coordinator");
    assert.equal(/serving|onIntentPrepared|artifactFormats/.test(made[1]), false, "no serving, no prepared hook: it cannot write");
    assert.equal(/settlement:\s*moneyFacts/.test(support), false, "never the lifecycle: no seal is ever announced to it");
  });

  test("a noMoneyServing coordinator asked to seal and sweep a served money game writes nothing (the default the support index runs on)", async () => {
    const store = createMemoryFinancialGameStore();
    store.records.set(GAME, dealtFin(GAME, PIN));
    const before = store.writes.count;
    const index = createSettlementCoordinator({ store, replay: () => ({ ok: false, reason: "not used" }), now: () => T0, warn: () => undefined, schedule: () => ({ cancel: () => undefined }) });
    await index.load();
    const entries = storedLog(3);
    const record = moneyRecord(GAME, PIN);
    await index.sweepLiveness([record]);
    index.onGameplayClosed({ gameId: GAME, record, seal: sealOf(entries, true) as TerminalSeal, recovered: false, entries });
    await index.drain();
    assert.equal(store.writes.count, before, "not one write");
    assert.deepEqual(index.factsOf(GAME), { kind: "record", mci: currentMoneyContinuation(), deployment: PIN }, "and it still indexes (L4-2's facts)");
  });
});

/* ================================================================================================= */
/* 4. N-3: a complete newer-format log line is never a torn tail                                     */
/* ================================================================================================= */

/** A complete line of a format this build does not write: a whole JSON object, not one of this build's entries. */
const NEWER_LINES: ReadonlyArray<readonly [string, string]> = [
  ["another record schema", `${JSON.stringify({ format: "gs-log", schema: 2, index: 1, entry: { id: "n1", payload: "{}" } })}\n`],
  ["another batch stamp shape", `${JSON.stringify({ index: 1, id: "n1", actor: ALICE, payload: JSON.stringify({ PassTurn: { game_id: 0 } }), at: T0, batch: { first: 1, last: 1 } })}\n`],
];

function storeBytes(entries: readonly ServerLogEntry[]): Buffer {
  return Buffer.from(entries.map((entry) => serializeBatch([entry])).join(""), "utf8");
}

describe("LIVE-4 integration N-3: a complete newer-format log line is never truncated, rewritten or repaired", () => {
  const deal = storedLog(0);

  test("1: a complete supported log reads normally (clean, synced, not one byte changed)", () =>
    withDir("n3-clean", async (dir) => {
      const file = path.join(dir, `${GAME}.log.jsonl`);
      const bytes = storeBytes(storedLog(2));
      fs.writeFileSync(file, bytes);
      assert.equal(scanLog(bytes).classification, "clean");
      const store = createFileLogStore(dir, quiet);
      assert.equal((await store.loadLog(GAME)).length, 3);
      assert.equal(sha(fs.readFileSync(file)), sha(bytes));
      assert.equal(store.stats.tornTailsRepaired, 0);
    }));

  test("2: a genuinely torn tail keeps its recovery (truncated to the last complete batch)", () =>
    withDir("n3-torn", async (dir) => {
      const file = path.join(dir, `${GAME}.log.jsonl`);
      const whole = storeBytes(deal);
      const torn = Buffer.from(serializeBatch([storedLog(1)[1]]).slice(0, 30), "utf8"); // no newline: the crash
      fs.writeFileSync(file, Buffer.concat([whole, torn]));
      assert.equal(scanLog(fs.readFileSync(file)).classification, "torn-tail");
      const store = createFileLogStore(dir, quiet);
      assert.equal((await store.loadLog(GAME)).length, 1);
      assert.equal(sha(fs.readFileSync(file)), sha(whole), "cut back to the complete batch");
      assert.equal(store.stats.tornTailsRepaired, 1);
    }));

  for (const [label, line] of NEWER_LINES) {
    for (const where of ["after the deal", "as the whole file", "unterminated, after the deal"] as const) {
      test(`3, 4: ${label}, ${where}: newer-format -- zero byte mutation, refused as incompatible, on every load and after a restart`, () =>
        withDir("n3-newer", async (dir) => {
          const file = path.join(dir, `${GAME}.log.jsonl`);
          const body = where === "unterminated, after the deal" ? line.slice(0, -1) : line;
          const bytes = where === "as the whole file" ? Buffer.from(body, "utf8") : Buffer.concat([storeBytes(deal), Buffer.from(body, "utf8")]);
          fs.writeFileSync(file, bytes);
          const scan = scanLog(bytes);
          assert.equal(scan.classification, "newer-format", scan.detail);
          assert.equal(dealIdentityOfLog(bytes).kind, "malformed", "the money side does not judge a deal from a log it cannot read");
          for (let restart = 0; restart < 2; restart += 1) {
            const store = createFileLogStore(dir, quiet);
            for (let load = 0; load < 2; load += 1) {
              await assert.rejects(store.loadLog(GAME), (error: unknown) => error instanceof StoreIncompatibleError && /newer build/.test(error.message));
              assert.equal(sha(fs.readFileSync(file)), sha(bytes), `restart ${restart} load ${load}: not one byte`);
            }
            assert.deepEqual([store.stats.tornTailsRepaired, store.stats.tornBytesRepaired], [0, 0], "never 'repaired'");
          }
        }));
    }
  }

  test("the review's M-2: valid-JSON damage to an entry of this build, with its later entries after it, is CORRUPT (held, never repaired) -- not a newer format", () =>
    withDir("n3-damage", async (dir) => {
      const file = path.join(dir, `${GAME}.log.jsonl`);
      const lines = storeBytes(storedLog(3)).toString("utf8").split("\n");
      lines[1] = lines[1].replace('"id":', '"ie":'); // index 1 no longer parses; entries 2 and 3 follow
      const bytes = Buffer.from(lines.join("\n"), "utf8");
      fs.writeFileSync(file, bytes);
      assert.equal(scanLog(bytes).classification, "corrupt", scanLog(bytes).detail);
      const store = createFileLogStore(dir, quiet);
      await assert.rejects(store.loadLog(GAME), (error: unknown) => error instanceof StoreCorruptError);
      assert.equal(sha(fs.readFileSync(file)), sha(bytes), "held, untouched");
    }));

  test("the review's M-2: a record-shaped stale page INSIDE this build's in-flight batch is still a torn tail (recovered)", () =>
    withDir("n3-stale", async (dir) => {
      const file = path.join(dir, `${GAME}.log.jsonl`);
      const log = storedLog(2);
      const whole = storeBytes([log[0]]);
      const inFlight = serializeBatch([log[1], log[2]]).split("\n")[0] + "\n"; // the batch's first line only
      const bytes = Buffer.concat([whole, Buffer.from(inFlight + `${JSON.stringify({ at: 1, stale: true })}\n`, "utf8")]);
      fs.writeFileSync(file, bytes);
      assert.equal(scanLog(bytes).classification, "torn-tail");
      const store = createFileLogStore(dir, quiet);
      assert.equal((await store.loadLog(GAME)).length, 1);
      assert.equal(sha(fs.readFileSync(file)), sha(whole), "cut back to the complete batch, as before");
    }));

  test("the review's L-1: a complete JSON array at the end of the prefix is a newer build's record too; a bare scalar is not", () => {
    const whole = storeBytes(deal);
    assert.equal(scanLog(Buffer.concat([whole, Buffer.from("[1,2]\n")])).classification, "newer-format");
    assert.equal(scanLog(Buffer.concat([whole, Buffer.from("12345\n")])).classification, "torn-tail");
  });

  test("the money side reads the log's class exactly as the session does (review M-1): N-3 lines and T-25 kinds are newer; a clean log is current", () => {
    const clean = storeBytes(storedLog(2));
    assert.equal(logFormatOfLog(clean), "current");
    assert.equal(logFormatOfLog(Buffer.concat([clean, Buffer.from(NEWER_LINES[0][1], "utf8")])), "newer", "N-3");
    const log = storedLog(1);
    const pinned = log.map((entry, at) => {
      if (at !== 0) return entry;
      const payload = JSON.parse(entry.payload) as { SetupGame: Record<string, unknown> };
      return { ...entry, payload: JSON.stringify({ SetupGame: { ...payload.SetupGame, rules_engine_version: RULES_ENGINE_VERSION } }) };
    });
    const unknownKind = [...pinned, { ...pinned[1], index: pinned.length, id: "from-a-newer-build", payload: JSON.stringify({ FutureMove: { game_id: 0 } }) }];
    assert.equal(logFormatOfLog(storeBytes(pinned)), "current", "a pinned log of known kinds");
    assert.equal(logFormatOfLog(storeBytes(unknownKind)), "newer", "T-25: a kind this build cannot have written");
    /* And every money seam passes it: the escrow service and the coordinator both hand `log` to the serving decision. */
    assert.match(source("server/src/escrow/escrowService.ts"), /serving\.decide\(\{ fin, record, identity, log,/);
    assert.match(source("server/src/escrow/settlementCoordinator.ts"), /const facts: MoneyGameFacts = \{ fin, record, identity, log,/);
    assert.match(source("server/src/start.ts"), /readLogFormat: \(gameId\) => logFormatOnDisk\(dataDir, gameId\),[\s\S]*readLogFormat: \(gameId\) => logFormatOnDisk\(dataDir, gameId\),/);
  });

  test("the operator's offline money decision reads the log's class too (review N-1): a T-25 log is newer-format there, a clean one continues", () =>
    withDir("n1", async (dir) => {
      const pinned = storedLog(1).map((entry, at) => {
        if (at !== 0) return entry;
        const payload = JSON.parse(entry.payload) as { SetupGame: Record<string, unknown> };
        return { ...entry, payload: JSON.stringify({ SetupGame: { ...payload.SetupGame, rules_engine_version: RULES_ENGINE_VERSION } }) };
      });
      assert.equal((await createFileFinancialGameStore(dir, quiet).create(newFinancialRecord(GAME, currentMoneyContinuation(), T0, PIN))).outcome.kind, "committed");
      const serving = createMoneyServing({ capability: thisDeploymentCapability([PIN]) });
      serving.recordChainFacts(chainRead(CANONICAL_CHECKSUM, PIN.denom));
      const file = path.join(dir, `${GAME}.log.jsonl`);
      fs.writeFileSync(file, storeBytes(pinned));
      assert.equal(why((await moneyDecisionOnDisk(dir, GAME, serving)).decision.verdict), "continues");
      fs.writeFileSync(file, storeBytes([...pinned, { ...pinned[1], index: pinned.length, id: "from-a-newer-build", payload: JSON.stringify({ FutureMove: { game_id: 0 } }) }]));
      assert.equal(why((await moneyDecisionOnDisk(dir, GAME, serving)).decision.verdict), "not-continued/newer-format");
      assert.match(source("server/src/tools/gamesDoctor.ts"), /if \(verification\.cls === "incompatible"\) return \{ ok: false/, "and a release refuses a game this build does not continue");
    }));

  test("an operator who knows a newer-format file is damage repairs a COPY only on --newer-is-damage; without it, nothing", () => {
    const whole = storeBytes(deal);
    const bytes = Buffer.concat([whole, Buffer.from(NEWER_LINES[1][1], "utf8")]);
    const refused = repairBytes(bytes);
    assert.equal(refused.ok, false);
    assert.match((refused as { reason: string }).reason, /newer build's format.*--newer-is-damage/);
    const repaired = repairBytes(bytes, { newerIsDamage: true });
    assert.equal(repaired.ok, true);
    assert.ok((repaired as { bytes: Buffer }).bytes.equals(whole), "the copy ends at the durable prefix");
  });

  test("3, 4 (through the server): a game whose log carries a newer build's complete line is not continued here (newer-format, derived) -- hello answered incompatible (newer-format), a move refused, no hold file, not one byte of its record or log changed, across restarts", () =>
    withDir("n3-server", async (dir) => {
      const gameId = mintGameId();
      const log = storedLog(1);
      const record: GameRecord = { ...seededRecord([ALICE, BOB], { dealt: true, gameId }), rules_engine_version: RULES_ENGINE_VERSION, started_at: log[0].at ?? Date.now() };
      fs.mkdirSync(path.join(dir, "games"), { recursive: true });
      const recordFile = path.join(dir, "games", `${gameId}.json`);
      const logFile = path.join(dir, `${gameId}.log.jsonl`);
      fs.writeFileSync(recordFile, `${JSON.stringify(record)}\n`);
      fs.writeFileSync(logFile, Buffer.concat([storeBytes(log), Buffer.from(NEWER_LINES[0][1].replace('"index":1', `"index":${log.length}`), "utf8")]));
      const before = [fs.readFileSync(recordFile), fs.readFileSync(logFile)];
      for (let restart = 0; restart < 2; restart += 1) {
        const ops: MemoryOpsRecorder = createMemoryOpsRecorder();
        const { server, port } = await startServer({ store: createFileLogStore(dir, quiet), records: createFileRecordStore(dir, quiet), holds: createFileHoldStore(dir, quiet), ops } as Partial<GameServerOptions>);
        try {
          await server.lifecycle.ready;
          const client = await Client.open(port, ALICE);
          client.hello(gameId);
          const answer = await client.next((f) => f.kind === "catch-up" || f.kind === "incompatible" || f.kind === "error", "the hello's answer");
          assert.deepEqual([answer.kind, answer.why], ["incompatible", "newer-format"], "the hello");
          client.submit(BUY, { baseIndex: 1, submissionId: `n3-${restart}` });
          const refused = await client.answerTo(`n3-${restart}`);
          /* Nothing of the log reached the session, so the seat check sees an undealt board and answers the table's own
             `wrong-state` before the session's `incompatible` (a client told `incompatible` at its hello has already
             closed its link and sends no move): either way the move is refused and nothing is appended. */
          assert.ok(refused.kind === "incompatible" || (refused.kind === "refused" && refused.code === "wrong-state"), `a move is refused: ${JSON.stringify(refused)}`);
          await client.close();
          await until(() => server.lifecycle.inventory().games.find((game) => game.gameId === gameId)?.cls === "incompatible", "concluded not continued");
        } finally {
          await stopServer(server);
        }
        assert.ok(!fs.existsSync(path.join(dir, "games", "holds", `${gameId}.json`)), "no hold file");
        assert.ok(fs.readFileSync(recordFile).equals(before[0]), "the record is exactly as it was");
        assert.ok(fs.readFileSync(logFile).equals(before[1]), "the log is exactly as it was");
      }
    }));
});

/* ================================================================================================= */
/* 5. A, B: a build change with the same semantics; the legacy wire                                    */
/* ================================================================================================= */

describe("LIVE-4 integration A/B: a build change alone never refuses; the legacy wire keeps its exact-build compare", () => {
  test("A: a protocol-1 tab on another build hellos and moves in a no-money game dealt on another build; B: a legacy tab with the same build difference is refused build-skew and is sent no LIVE-4 frame", () =>
    withDir("ab", async (dir) => {
      const gameId = mintGameId();
      const log = storedLog(1).map((entry, at) => {
        if (at !== 0) return entry;
        const payload = JSON.parse(entry.payload) as { SetupGame: Record<string, unknown> };
        return { ...entry, payload: JSON.stringify({ SetupGame: { ...payload.SetupGame, build: "a-much-older-build" } }) };
      });
      const record: GameRecord = { ...seededRecord([ALICE, BOB], { dealt: true, gameId }), rules_engine_version: RULES_ENGINE_VERSION, started_at: log[0].at ?? Date.now() };
      fs.mkdirSync(path.join(dir, "games"), { recursive: true });
      fs.writeFileSync(path.join(dir, "games", `${gameId}.json`), `${JSON.stringify(record)}\n`);
      fs.writeFileSync(path.join(dir, `${gameId}.log.jsonl`), storeBytes(log));
      const { server, port } = await startServer({ store: createFileLogStore(dir, quiet), records: createFileRecordStore(dir, quiet), holds: createFileHoldStore(dir, quiet) } as Partial<GameServerOptions>);
      try {
        await server.lifecycle.ready;
        const TAB_BUILD = "tab-build-b";
        assert.notEqual(TAB_BUILD, BUILD);
        /* A: protocol 1, another cb, another dealing build. */
        const modern = await Client.open(port, BOB, `cp=1&cr=${RULES_ENGINE_VERSION}&cb=${TAB_BUILD}`);
        modern.hello(gameId);
        const caught = await modern.next((f) => f.kind === "catch-up" || f.kind === "incompatible" || f.kind === "reload", "the modern hello");
        assert.equal(caught.kind, "catch-up");
        const seen = caught.entries as SeenEntry[];
        modern.submit(BUY, { baseIndex: seen[seen.length - 1].index, submissionId: "modern", build: TAB_BUILD });
        assert.equal((await modern.answerTo("modern")).kind, "applied", "played across builds");
        await modern.close();
        /* B: the legacy wire (no announcement), the same build difference. */
        const legacy = await Client.open(port, ALICE);
        legacy.hello(gameId);
        const legacySeen = (await legacy.next((f) => f.kind === "catch-up", "the legacy hello")).entries as SeenEntry[];
        legacy.submit(BUY, { baseIndex: legacySeen[legacySeen.length - 1].index, submissionId: "legacy", build: TAB_BUILD });
        const skew = await legacy.answerTo("legacy");
        assert.equal(skew.kind, "build-skew", "protocol 0 keeps the exact-build compare");
        assert.equal(legacy.frames.some((f) => f.kind === "reload" || f.kind === "route"), false, "no LIVE-4 frame on the legacy wire");
        await legacy.close();
      } finally {
        await stopServer(server);
      }
    }));
});

/* ================================================================================================= */
/* 6. Versions, I (RNG), and the drift sweep's runtime pins                                           */
/* ================================================================================================= */

describe("LIVE-4 integration: versions unchanged, the seed still cryptographic, no stale continuation model at runtime", () => {
  test("the version table: rules 12 (11 through LIVE-4; Route v12 R12-2), certified [10, 11, 12] (12 by R12-3), hosted 1, financial 3, client 1, accepted [0, 1], money GameRecord schema 2", () => {
    assert.equal(RULES_ENGINE_VERSION, 12);
    assert.deepEqual([...SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS], [10, 11, 12]);
    assert.equal(HOSTED_PROTOCOL_VERSION, 1);
    assert.equal(FINANCIAL_PROTOCOL_VERSION, 3);
    assert.equal(CLIENT_PROTOCOL_VERSION, 1);
    assert.deepEqual([...ACCEPTED_CLIENT_PROTOCOLS], [0, 1]);
    assert.match(source("server/src/rooms/gameRecord.ts"), /record_schema: 1 \| 2;/, "a money table's GameRecord is record_schema 2 (no-money stays 1)");
  });

  test("I: the room seed is a crypto.randomInt draw; no Math.random in the server's session factory", () => {
    const server = code(source("server/src/gameServer.ts"));
    assert.match(server, /export const mintHostedRevenueSeed = \(\): number => randomInt\(0, 2 \*\* 32\);/);
    assert.equal(/Math\.random/.test(server), false);
  });

  test("the retired build-keyed model is gone from runtime code (continuesDealtBuild, MoneyContinuationPolicy, continuationPolicyOf, pinMismatch)", () => {
    const runtime = [
      "server/src/start.ts",
      "server/src/gameServer.ts",
      "server/src/continuationWiring.ts",
      "server/src/rooms/roomHost.ts",
      "server/src/rooms/gameActor.ts",
      "server/src/escrow/escrowService.ts",
      "server/src/escrow/settlementCoordinator.ts",
      "server/src/escrow/moneyServing.ts",
      "server/src/escrow/juno/relayer.ts",
    ];
    for (const file of runtime) {
      const text = code(source(file));
      for (const stale of [/continuesDealtBuild/, /MoneyContinuationPolicy/, /continuationPolicyOf/, /pinMismatch\(/, /NO_MONEY_CONTINUATION\b/]) {
        assert.equal(stale.test(text), false, `${file}: ${stale}`);
      }
    }
  });
});
