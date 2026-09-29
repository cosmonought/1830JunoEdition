// server/src/escrow/live4MoneyContinuation.test.ts
//
// ==================================================================
//  LIVE-4 (L4-4): MONEY CONTINUATION -- THE CANONICAL VERDICT BEFORE EVERY MONEY WRITE
// ==================================================================
//
// The money half of the LIVE-4 test matrix (claude/LIVE4_COMPATIBILITY_CONTINUATION_PREFLIGHT_2026-09-28.md §14):
//   T-7   money creation is the canonical creation verdict, and a refusal leaves zero artifacts;
//   T-8   a game pinned to another contract is not continued here -- never held (F-L4-2);
//   T-9   the relayer skips what it does not continue IN MEMORY, and keeps the account's sequence while doing so;
//   T-10  a pool that serves the game's escrow continues it ({A}, {A, B}); one that does not, does not ({B});
//   T-11  only a chain-attested contradiction, read at verification grade, holds -- and only on the owning pool;
//   T-12  the settlement coordinator writes nothing it does not continue (step -1, F-L4-3);
//   T-13  newer / older / corrupt financial artifacts (record, intents, tickets) are classified, never overwritten;
//   T-22  a configuration typo before verification is derived (`deployment-unverified`), never a hold;
//   T-23  a money table with no financial record: only the owner writes the held placeholder, once;
// plus the checkpoint path behind `onGameplayCommitted` (F-L4-3: the verdict before `dealt`), the verification-grade
// chain-fact contract, the operator's read-only classification and verdict-gated release, and the pins this pass must
// not move (no protocol bump, no build equality).
//
// Wherever "nothing is written" is the invariant, it is asserted on BYTES: every file and directory under the data
// directory -- the financial records, the chain intents, the ticket ledgers and the signing journal are all file stores
// here -- hashed before and after.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ALICE, BOB, BUILD, quietConsole, seededRecord, storedLog } from "../rooms/testSupport";
import { sealOf, type TerminalSeal } from "../rooms/lifecycle";
import { MONEY_TABLE_FORMAT, mintGameId, type GameRecord } from "../rooms/gameRecord";
import { serializeBatch } from "../persistence/logFormat";
import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { FINANCIAL_PROTOCOL_CHANGELOG, FINANCIAL_PROTOCOL_VERSION, HOSTED_PROTOCOL_CHANGELOG, HOSTED_PROTOCOL_VERSION } from "../../../frontend/src/gameEngine/protocolVersions";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/settlementAppraisal";
import { CONFLICT_HOLD_CODES, type ContinuationVerdict } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { GAME_CONTINUATION_FORMAT, gameIdentityOfEntries, type GameIdentityFacts } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import { deploymentCapability, deploymentKey, type DeploymentCapability } from "../../../frontend/src/gameEngine/compat/deploymentCapability";
import { thisDeploymentCapability } from "../deploymentCapability";
import { chainIntentDirectory, createFileChainIntentStore, isLiveAttempt, ChainIntentUnreadableError } from "./chainIntents";
import { createFileFinancialGameStore, financialDirectory, FinancialRecordUnreadableError, type FinancialGameStore, type MemoryFinancialGameStore } from "./financialGameStore";
import { currentMoneyContinuation, THIS_DEPLOYMENT, type MoneyContinuationIdentity } from "./moneyContinuation";
import { FINANCIAL_VERSION, missingRecordPlaceholder, newFinancialRecord, transitionFinancial, type FinancialDeploymentPin, type FinancialGameRecord, type FinancialHoldCode } from "./moneyLifecycle";
import { createMoneyServing, noMoneyServing, type MoneyServing } from "./moneyServing";
import { createSettlementCoordinator, type SettlementCoordinator, type SettlementCoordinatorDeps } from "./settlementCoordinator";
import { serverPrefixReplay, type PrefixReplay } from "./settlementEvidence";
import { openFileSigningJournal } from "./signingJournal";
import { createFileWalletTicketStore, walletTicketDirectory, WalletTicketStoreUnreadableError } from "./walletTicketFileStore";
import { readVerifiedChainFacts } from "./juno/chainFacts";
import { QUERY } from "./juno/junoContract";
import { createJunoRest, JunoRpcError, type HttpTransport, type JunoRest } from "./juno/junoRest";
import { inspectMoney, releaseMoneyHold, withLock } from "../tools/gamesDoctor";
import {
  CANONICAL_CHECKSUM,
  CHAIN_ID,
  CONTRACT,
  GAME_A,
  GAME_B,
  PIN,
  T0,
  VARIANTS,
  WALLETS,
  commit,
  fundedGame,
  makeWorld,
  passRound,
  play,
  startedGame,
  toStockRound,
  type World,
  type WorldOptions,
} from "./escrow3bSupport";
import { hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, STAKE, testConsentKey, testWallet, viewOf } from "./escrow4Support";

quietConsole();

/* ================================================================================================= */
/* Fixtures                                                                                          */
/* ================================================================================================= */

const quiet = { warn: () => undefined };
/** Contract B: another escrow deployment on the same chain (a server re-pointed at it serves A's games no longer). */
const PIN_B: FinancialDeploymentPin = Object.freeze({ ...PIN, contract_address: WALLETS[2] });
/** Contract A configured with a mistyped denom (the same deployment KEY, another configured fact). */
const PIN_TYPO: FinancialDeploymentPin = Object.freeze({ ...PIN, denom: "ujunoy" });
const KEY_A = deploymentKey(PIN);
const OTHER_CHECKSUM = "ab".repeat(32);
const DEALT: GameIdentityFacts = { kind: "dealt", gci: { format: GAME_CONTINUATION_FORMAT, rules_engine_version: RULES_ENGINE_VERSION, hosted_protocol: HOSTED_PROTOCOL_VERSION } };
const REPO = path.resolve(__dirname, "..", "..", "..", "..", "..");
const source = (relative: string) => fs.readFileSync(path.join(REPO, relative), "utf8");

const why = (verdict: ContinuationVerdict): string => (verdict.kind === "continues" ? "continues" : `${verdict.kind}/${verdict.why}`);

/** A pool's serving over `pins` (this build's capability), optionally widened (another hosted protocol, say). */
function servingOver(pins: readonly FinancialDeploymentPin[], widen: Partial<DeploymentCapability> = {}): MoneyServing {
  return createMoneyServing({ capability: deploymentCapability({ ...thisDeploymentCapability(pins), ...widen }) });
}

function termsOf(pin: FinancialDeploymentPin) {
  return { format: MONEY_TABLE_FORMAT, backend: pin.backend, chain_id: pin.chain_id, network_class: pin.network_class, contract_address: pin.contract_address, code_checksum: pin.code_checksum, denom: pin.denom, symbol: "JUNOX", exponent: 6, ante_gross: "1010000", mode: "live" };
}

function dealtRecord(gameId: string, pin: FinancialDeploymentPin, continuation: MoneyContinuationIdentity = currentMoneyContinuation()): FinancialGameRecord {
  const moved = transitionFinancial(newFinancialRecord(gameId, continuation, T0, pin), { kind: "dealt", at: T0 + 1 });
  assert.equal(moved.kind, "moved");
  return (moved as { next: FinancialGameRecord }).next;
}

async function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `l4-4-${tag}-`));
  try {
    return await body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every file (its SHA-256) and every directory under `dir`: the data directory's bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(at, entry.name);
      const relative = path.relative(dir, full);
      if (entry.isDirectory()) {
        out[`${relative}/`] = "directory";
        walk(full);
      } else {
        out[relative] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** ESCROW-3B's world with every durable store a FILE store under `dir`, the signing journal included. */
async function fileWorld(dir: string, options: WorldOptions = {}): Promise<World> {
  return makeWorld({
    financial: createFileFinancialGameStore(dir, quiet),
    intents: createFileChainIntentStore(dir, quiet),
    tickets: createFileWalletTicketStore(dir, quiet),
    journal: await openFileSigningJournal(path.join(dir, "journal")),
    ...options,
  });
}

const fin = (world: World, gameId: string = GAME_A) => world.financial.load(gameId) as Promise<FinancialGameRecord>;
const intentsOf = (world: World, gameId: string = GAME_A) => world.intents.listGame(gameId);
const opsOf = (world: World, event: string, gameId: string = GAME_A) => world.ops.lines.filter((line) => line.event === event && line.game_id === gameId);

/** Started on chain, dealt, and the deal's checkpoint confirmed. */
async function dealt(world: World, gameId: string = GAME_A) {
  await startedGame(world, gameId);
  const session = play(world, gameId, 0);
  await world.drive(async () => (await fin(world, gameId)).chain.checkpoint_confirmed !== null);
  return session;
}

/** The server's replay of a sealed prefix with the terminal fields grafted on (a whole game is not a fixture). */
const endedReplay: PrefixReplay = (prefix) => {
  const real = serverPrefixReplay(BUILD)(prefix);
  if (!real.ok) return real;
  return { ok: true, board: { ...real.board, current_round_type: "GameEnd", bank_broken: true } as GameStateResponse };
};

const gameRecordOf = (gameId: string, pin: FinancialDeploymentPin | null) => ({ game_id: gameId, money: pin === null ? null : termsOf(pin), started_at: T0 + 1, last_activity_at: T0 + 2 }) as never;

function coordinatorWith(store: FinancialGameStore, serving: MoneyServing, extra: Partial<SettlementCoordinatorDeps> = {}): SettlementCoordinator {
  return createSettlementCoordinator({ store, replay: endedReplay, isFinancial: () => true, now: () => T0 + 10_000, warn: () => undefined, schedule: () => ({ cancel: () => undefined }), serving, ...extra });
}

function announce(coordinator: SettlementCoordinator, gameId: string, entries: readonly ServerLogEntry[], pin: FinancialDeploymentPin | null = PIN): void {
  coordinator.onGameplayClosed({ gameId, record: gameRecordOf(gameId, pin), seal: sealOf(entries, true) as TerminalSeal, recovered: false, entries });
}

/** The settlement coordinator of the world's own process (the same serving, the same artifact classes), announcing a
 *  seal of `entries` and draining. */
async function sealThrough(world: World, gameId: string, entries: readonly ServerLogEntry[]): Promise<SettlementCoordinator> {
  const coordinator = createSettlementCoordinator({
    store: world.financial,
    replay: world.replay,
    isFinancial: () => true,
    serving: world.service.serving,
    artifactFormats: (id, record) => world.service.artifactFormatsOf(id, record),
    readDeal: async (id) => gameIdentityOfEntries(world.logs.get(id) ?? []),
    now: () => world.clock.now,
    warn: (line) => world.warnings.push(line),
    schedule: () => ({ cancel: () => undefined }),
    onIntentPrepared: (id) => world.service.onIntentPrepared(id),
  });
  announce(coordinator, gameId, entries);
  await coordinator.drain();
  await coordinator.sweepLiveness([gameRecordOf(gameId, PIN)]);
  await world.service.idle();
  return coordinator;
}

/* ================================================================================================= */
/* The pins                                                                                          */
/* ================================================================================================= */

describe("LIVE-4 L4-4: what this pass must not move", () => {
  test("no hidden protocol bump: financial protocol 3, hosted 1, rules 11 (settlement [10, 11]), record file v2, money GameRecord schema 2", () => {
    assert.equal(FINANCIAL_PROTOCOL_VERSION, 3);
    assert.deepEqual(
      FINANCIAL_PROTOCOL_CHANGELOG.map((row) => row.version),
      [1, 2, 3],
    );
    assert.equal(HOSTED_PROTOCOL_VERSION, 1);
    assert.deepEqual(
      HOSTED_PROTOCOL_CHANGELOG.map((row) => row.version),
      [1],
    );
    assert.equal(RULES_ENGINE_VERSION, 11);
    assert.deepEqual([...SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS], [10, 11]);
    assert.equal(FINANCIAL_VERSION, 2, "the financial record's own file format");
    assert.deepEqual(currentMoneyContinuation(), { format: "18COSMOS/MONEY-CONTINUATION/v1", rules_engine_version: 11, hosted_protocol: 1, financial_protocol: 3, settlement_codec: "18JUNO/v1" });
    const capability = thisDeploymentCapability([PIN]);
    assert.deepEqual(
      [capability.rules.current, [...capability.rules.supported], [...capability.rules.certified], [...capability.hosted_protocols], [...capability.financial_protocols], [...capability.settlement_codecs]],
      [11, [11], [10, 11], [1], [3], ["18JUNO/v1"]],
    );
    assert.match(source("server/src/rooms/gameRecord.ts"), /value\.record_schema === 2 && isGameMoneyTerms\(value\.money\)/, "a money table is record_schema 2");
  });

  test("no build equality in any money continuation seam, and the all-fields pin comparison that held foreign games (F-L4-2) is gone", () => {
    const seams = [
      "server/src/escrow/moneyServing.ts",
      "server/src/escrow/juno/chainFacts.ts",
      "server/src/escrow/escrowService.ts",
      "server/src/escrow/settlementCoordinator.ts",
      "server/src/escrow/juno/relayer.ts",
      "server/src/escrow/juno/junoBackend.ts",
      "server/src/escrow/moneyTables.ts",
      "server/src/tools/gamesDoctor.ts",
      "server/src/escrow/financialGameStore.ts",
      "server/src/escrow/chainIntents.ts",
      "server/src/escrow/walletTicketFileStore.ts",
    ];
    const BUILD_EQUALITY = /\b\w*build\w*\s*[!=]==|[!=]==\s*\w*build\w*\b|buildsAgree|continuesDealtBuild|dealtBuild|BUILD_ID/i;
    for (const file of seams) assert.equal(BUILD_EQUALITY.test(source(file)), false, `${file} compares a build`);
    assert.equal(/\bpinMismatch\s*\(/.test(source("server/src/escrow/escrowService.ts")), false, "no `pinMismatch(...)` is defined or called");
  });
});

/* ================================================================================================= */
/* T-7: creation                                                                                     */
/* ================================================================================================= */

describe("LIVE-4 T-7 / D4-14: money creation is the canonical creation verdict, and a refusal writes nothing", () => {
  test("each reason this pool could not continue what it would create is refused by `createMoneyGame` itself, with zero artifacts", async () => {
    const next = RULES_ENGINE_VERSION + 1;
    const cases: ReadonlyArray<{ readonly name: string; readonly code: string; readonly options?: WorldOptions; readonly prepare?: (world: World) => void }> = [
      {
        name: "an uncertified rules bump (current 12, certified [10, 11])",
        code: "rules-not-certified",
        options: { continuation: { current: (codec) => ({ ...currentMoneyContinuation(codec), rules_engine_version: next }), deployment: { ...THIS_DEPLOYMENT, supportedRules: [next], certifiedRules: [10, 11] } } },
      },
      { name: "a financial protocol this pool does not speak", code: "financial-protocol", options: { continuation: { current: (codec) => ({ ...currentMoneyContinuation(codec), financial_protocol: FINANCIAL_PROTOCOL_VERSION + 1 }), deployment: THIS_DEPLOYMENT } } },
      { name: "a hosted protocol this pool does not read", code: "hosted-protocol", options: { continuation: { current: (codec) => ({ ...currentMoneyContinuation(codec), hosted_protocol: HOSTED_PROTOCOL_VERSION + 1 }), deployment: THIS_DEPLOYMENT } } },
      { name: "a settlement codec this pool does not carry", code: "settlement-codec", options: { continuation: { current: (codec) => ({ ...currentMoneyContinuation(codec), settlement_codec: "18GNO/v1" }), deployment: THIS_DEPLOYMENT } } },
      { name: "the deployment unverified (the chain unreachable: no verification-grade read this run)", code: "deployment-unverified", prepare: (world) => void (world.chain.unavailable = true) },
      { name: "the deployment unverified (a node still syncing)", code: "deployment-unverified", prepare: (world) => void (world.chain.syncingNow = true) },
      { name: "the deployment unverified (the endpoints disagree)", code: "deployment-unverified", prepare: (world) => void (world.chain.quorumDisagrees = true) },
      { name: "the chain contradicting the pin (the contract reports other code)", code: "deployment-conflict", prepare: (world) => void (world.chain.reportedChecksum = OTHER_CHECKSUM) },
      { name: "the chain contradicting the pin (the contract reports another denom)", code: "deployment-conflict", prepare: (world) => void (world.chain.reportedDenom = "uother") },
    ];
    for (const c of cases) {
      await withDir("t7", async (dir) => {
        const world = await fileWorld(dir, c.options ?? {});
        c.prepare?.(world);
        const before = snapshot(dir);
        const refused = await world.service.createMoneyGame(GAME_A);
        assert.equal(refused.ok ? "created" : refused.code, c.code, c.name);
        assert.deepEqual(snapshot(dir), before, `${c.name}: zero artifacts`);
        assert.deepEqual(await world.financial.list(), [], c.name);
        assert.equal(world.service.creationVerdict().kind, c.code === "deployment-conflict" ? "conflict" : "not-continued", c.name);
        assert.equal(opsOf(world, "money.created").length, 0, c.name);
      });
    }
    /* The positive control: the same fresh world creates exactly one artifact, the financial record. */
    await withDir("t7-ok", async (dir) => {
      const world = await fileWorld(dir);
      const before = snapshot(dir);
      const created = await world.service.createMoneyGame(GAME_A);
      assert.ok(created.ok);
      const added = Object.keys(snapshot(dir)).filter((name) => !(name in before));
      assert.deepEqual(added.sort(), ["games/", `${path.join("games", "money")}/`, path.join("games", "money", `${GAME_A}.json`)].sort());
      assert.deepEqual((await fin(world)).continuation, currentMoneyContinuation());
    });
  });

  test("a repeated creation over a record this pool does not continue refuses it unchanged", () =>
    withDir("t7-existing", async (dir) => {
      const store = createFileFinancialGameStore(dir, quiet);
      assert.equal((await store.create(newFinancialRecord(GAME_A, currentMoneyContinuation(), T0, PIN_B))).outcome.kind, "committed");
      const world = await fileWorld(dir);
      const before = snapshot(dir);
      const refused = await world.service.createMoneyGame(GAME_A);
      assert.equal(refused.ok ? "created" : refused.code, "deployment-unavailable");
      assert.deepEqual(snapshot(dir), before);
    }));

  test("the create route asks the same verdict: a configured pin the chain contradicts opens no money table (no GameRecord, no financial record)", async () => {
    const world = await moneyServer({ pin: PIN_TYPO });
    try {
      const host = await player(world, "Typo");
      const refused = await host.client.op({ type: "create", visibility: "public", exactPlayers: 2, variants: {}, nickname: "Typo", stake: STAKE });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "deployment-conflict");
      assert.deepEqual(await world.financial.list(), []);
      assert.deepEqual(world.server.rooms.moneyPort.moneyRecords(), []);
      const config = await host.api("config");
      assert.equal(config.body?.enabled, false);
      assert.equal(config.body?.why, "deployment-conflict");
      assert.equal(world.financial.writes.count, 0);
    } finally {
      await world.close();
    }
  });
});

/* ================================================================================================= */
/* T-8, T-10: another contract                                                                        */
/* ================================================================================================= */

describe("LIVE-4 T-8 / F-L4-2: a game pinned to another contract is not continued here -- never held", () => {
  test("a restart configured for contract B leaves A's game byte-identical through the load, the relayer, commits, the sweep and a seal; A's own pool then continues it", () =>
    withDir("t8", async (dir) => {
      const world = await fileWorld(dir);
      const session = await dealt(world);
      toStockRound(world, GAME_A, session);
      await world.service.idle();
      const prepared = (await fin(world)).chain.checkpoint_prepared;
      assert.ok(prepared !== null && prepared.log_len > 1, "an open checkpoint intent of A's, not yet relayed");
      const before = snapshot(dir);

      world.pin = PIN_B;
      const loaded = await world.restart();
      assert.deepEqual(loaded, { games: 1, held: 0, resumed: 0, skipped: 1 });
      await world.relayer.pass();
      passRound(world, GAME_A, session);
      await world.service.idle();
      await world.service.sweepChain();
      await world.service.idle();
      await world.relayer.pass();
      await sealThrough(world, GAME_A, session.entries);
      assert.deepEqual(snapshot(dir), before, "not one byte: no hold, no defer, no intent, no journal line");

      const decision = await world.service.servingDecision(GAME_A);
      assert.deepEqual([why(decision.verdict), decision.owner, decision.holdCode], ["not-continued/deployment-unavailable", false, null]);
      assert.equal(world.relayer.status().skipped, 1, "A's open intent is skipped in memory");
      assert.equal(opsOf(world, "money.not-continued").length, 1, "one page for the game, whichever seams met it");
      assert.equal(opsOf(world, "settlement.held").length, 0);
      assert.equal(world.service.stats.holds, 0);

      /* A's own pool: the game continues exactly where it was (nothing was moved or lost while B ran). */
      world.pin = PIN;
      const back = await world.restart();
      assert.deepEqual([back.games, back.held, back.skipped], [1, 0, 0]);
      await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed?.log_len === prepared.log_len);
      assert.equal((await world.service.servingDecision(GAME_A)).verdict.kind, "continues");
    }));

  test("T-10: the same game under {A} continues, under {B} is deployment-unavailable, under {A, B} continues -- and a pool serving nothing continues nothing", () => {
    const record = dealtRecord(GAME_A, PIN);
    const decide = (serving: MoneyServing) => serving.decide({ fin: "current", record, identity: DEALT });
    const onA = decide(servingOver([PIN]));
    const onB = decide(servingOver([PIN_B]));
    const onBoth = decide(servingOver([PIN, PIN_B]));
    assert.deepEqual([why(onA.verdict), onA.owner, onA.key], ["continues", true, KEY_A]);
    assert.deepEqual([why(onB.verdict), onB.owner, onB.holdCode], ["not-continued/deployment-unavailable", false, null]);
    assert.deepEqual([why(onBoth.verdict), onBoth.owner], ["continues", true]);
    const none = decide(noMoneyServing());
    assert.deepEqual([none.verdict.kind, none.owner, none.holdCode], ["not-continued", false, null], "fail closed, never 'continue everything'");
  });
});

/* ================================================================================================= */
/* F-L4-3: the checkpoint path                                                                       */
/* ================================================================================================= */

describe("LIVE-4 F-L4-3: `onGameplayCommitted`'s checkpoint path asks the verdict BEFORE `dealt`", () => {
  test("a process configured for contract B, handed the deal's commit of A's started game, writes nothing; A's pool writes the deal and its checkpoint", () =>
    withDir("fl43", async (dir) => {
      const world = await fileWorld(dir);
      await startedGame(world, GAME_A);
      assert.equal((await fin(world)).phase, "funding", "started on chain; the deal not yet committed");
      /* Another process over the same data directory, configured for contract B: preloaded (its frozen rosters known, as
         at every startup before any chain read) and never loaded -- so no decision is cached anywhere, and the checkpoint
         job itself must ask before it writes. Before L4-4 it wrote `dealt` first and checked the pin after. */
      const other = await fileWorld(dir, { pin: PIN_B });
      await other.service.preload();
      const before = snapshot(dir);
      const session = play(other, GAME_A, 0);
      await other.service.idle();
      assert.deepEqual(snapshot(dir), before, "no `dealt`, no checkpoint intent, no journal line");
      assert.equal((await fin(world)).phase, "funding");
      assert.equal(opsOf(other, "money.not-continued").filter((line) => line.why === "deployment-unavailable" && line.where === "checkpoint").length, 1);
      /* The pool that serves contract A. */
      commit(world, GAME_A, session);
      await world.service.idle();
      assert.equal((await fin(world)).phase, "in-progress");
      assert.equal((await intentsOf(world)).filter((intent) => intent.op.kind === "checkpoint").length, 1);
    }));
});

/* ================================================================================================= */
/* T-9: the relayer                                                                                   */
/* ================================================================================================= */

describe("LIVE-4 T-9: the relayer skips what it does not continue in memory -- and keeps the account's sequence", () => {
  test("a skipped intent's LIVE attempt on this account blocks new signing until the chain spends its sequence; the skipped record is never written", async () => {
    const world = makeWorld();
    await startedGame(world, GAME_A);
    play(world, GAME_A, 0);
    await world.service.idle();
    await world.relayer.pass(); // the deal's checkpoint is broadcast: one live attempt, not yet included
    const checkpoint = (await intentsOf(world)).find((intent) => intent.op.kind === "checkpoint");
    const live = checkpoint?.attempts.filter(isLiveAttempt) ?? [];
    assert.equal(live.length, 1);
    /* This pool's own work on the same account: another game's Start, ready to sign. */
    assert.ok((await world.service.createMoneyGame(GAME_B)).ok);
    const chainB = await fundedGame(world, GAME_B);
    assert.ok((await world.service.bindChainGame(GAME_B, chainB, VARIANTS)).ok);
    assert.ok((await world.service.requestStart(GAME_B, [{ player_id: ALICE }, { player_id: BOB }])).ok);
    /* Game A is no longer this pool's (its financial record is now another build's format): its intents are skipped. */
    (world.financial as MemoryFinancialGameStore).records.set(GAME_A, "newer");
    const storedA = JSON.stringify(await intentsOf(world));
    await world.relayer.pass();
    const startB = async () => (await intentsOf(world, GAME_B)).find((intent) => intent.op.kind === "start");
    assert.equal((await startB())?.attempts.length, 0, "never signed at a sequence the skipped attempt may still take");
    assert.match(world.relayer.status().last_error ?? "", /may still land/);
    assert.equal(JSON.stringify(await intentsOf(world)), storedA, "the skipped intent: no defer, no hold, no observation write");
    /* The chain includes the skipped attempt (its sequence spent): signing resumes, at the next sequence. */
    world.chain.produceBlock();
    await world.relayer.pass();
    const signed = await startB();
    assert.equal(signed?.attempts.length, 1);
    assert.equal(BigInt(signed?.attempts[0].sequence ?? "0"), BigInt(live[0].sequence) + BigInt(1));
    assert.equal(JSON.stringify(await intentsOf(world)), storedA, "still untouched: the pool that continues it observes it");
    assert.equal(opsOf(world, "chain.intent-skipped").length, 1, "one alarm");
    /* Review R-7: a restart that skips the same intent knows its attempts (they are in the store): no false "restored
       store" guard or alarm. */
    await world.restart();
    assert.equal(world.relayer.status().forgotten_guard, null);
    assert.equal(world.ops.lines.filter((line) => line.event === "chain.forgotten-attempts").length, 0);
  });
});

/* ================================================================================================= */
/* T-11: a verified contradiction                                                                     */
/* ================================================================================================= */

describe("LIVE-4 T-11: only a verification-grade chain contradiction holds, and only on the owning pool", () => {
  test("another code checksum at the contract: a syncing node or a disagreeing quorum concludes nothing; a verification-grade read holds binding-mismatch", () =>
    withDir("t11", async (dir) => {
      const world = await fileWorld(dir);
      await dealt(world);
      world.chain.reportedChecksum = OTHER_CHECKSUM;
      world.chain.syncingNow = true;
      const loaded = await world.restart();
      assert.equal(loaded.held, 0);
      assert.equal((await fin(world)).phase, "in-progress", "a syncing node is no fact");
      world.chain.syncingNow = false;
      world.chain.quorumDisagrees = true;
      assert.equal((await world.service.refreshChainFacts()).kind, "unavailable");
      await world.service.sweepChain();
      await world.service.idle();
      assert.equal((await fin(world)).phase, "in-progress", "a disagreeing quorum is no fact either");
      world.chain.quorumDisagrees = false;
      assert.equal((await world.service.refreshChainFacts()).kind, "read");
      await world.service.sweepChain();
      await world.service.idle();
      const held = await fin(world);
      assert.deepEqual([held.phase, held.hold?.code], ["held", CONFLICT_HOLD_CODES["deployment-conflict"]]);
      assert.match(held.hold?.detail ?? "", /deployment-conflict: .*code_checksum/);
      assert.deepEqual(
        world.ops.lines.filter((line) => line.event === "escrow.chain-facts").map((line) => line.code_checksum),
        [CANONICAL_CHECKSUM, OTHER_CHECKSUM],
        "what the chain reports is audited when it changes (and only verification-grade reads count)",
      );
    }));

  test("another denom at the contract: the first verification-grade read of a new process holds the game at its load", () =>
    withDir("t11-denom", async (dir) => {
      const world = await fileWorld(dir);
      await dealt(world);
      world.chain.reportedDenom = "uother";
      const loaded = await world.restart();
      assert.deepEqual([loaded.held, loaded.skipped], [1, 0]);
      const held = await fin(world);
      assert.deepEqual([held.phase, held.hold?.code], ["held", "binding-mismatch"]);
      assert.match(held.hold?.detail ?? "", /denom=uother/);
    }));

  test("a pool that does not serve the game's escrow never concludes its deployment conflict, whatever it read", () => {
    const record = dealtRecord(GAME_A, PIN);
    const read = { kind: "read" as const, key: KEY_A, facts: { code_checksum: OTHER_CHECKSUM, denom: PIN.denom }, read_at: T0 };
    const elsewhere = servingOver([PIN_B]);
    elsewhere.recordChainFacts(read);
    const other = elsewhere.decide({ fin: "current", record, identity: DEALT });
    assert.deepEqual([why(other.verdict), other.owner, other.holdCode], ["not-continued/deployment-unavailable", false, null]);
    const owner = servingOver([PIN]);
    owner.recordChainFacts(read);
    const mine = owner.decide({ fin: "current", record, identity: DEALT });
    assert.deepEqual([why(mine.verdict), mine.owner, mine.holdCode], ["conflict/deployment-conflict", true, "binding-mismatch"]);
  });
});

/* ================================================================================================= */
/* T-12: the settlement coordinator                                                                   */
/* ================================================================================================= */

describe("LIVE-4 T-12: the settlement coordinator writes nothing it does not continue (step -1)", () => {
  const entries = storedLog(3);

  test("no deployment served, another deployment, another financial protocol: no `dealt`, no seal, no hold -- the job is not this pool's", async () => {
    const cases: ReadonlyArray<{ readonly name: string; readonly serving: () => MoneyServing; readonly record: FinancialGameRecord; readonly why: string }> = [
      { name: "a pool serving no escrow", serving: () => noMoneyServing(), record: newFinancialRecord(GAME_A, currentMoneyContinuation(), T0, PIN), why: "financial-protocol" },
      { name: "a pool serving contract B", serving: () => servingOver([PIN_B]), record: newFinancialRecord(GAME_A, currentMoneyContinuation(), T0, PIN), why: "deployment-unavailable" },
      { name: "a game of financial protocol 2", serving: () => servingOver([PIN]), record: newFinancialRecord(GAME_A, { ...currentMoneyContinuation(), financial_protocol: 2 }, T0, PIN), why: "financial-protocol" },
    ];
    for (const c of cases) {
      await withDir("t12", async (dir) => {
        const store = createFileFinancialGameStore(dir, quiet);
        assert.equal((await store.create(c.record)).outcome.kind, "committed");
        const ops = createMemoryOpsRecorder();
        const coordinator = coordinatorWith(store, createMoneyServing({ capability: c.serving().capability, ops }), { ops });
        const before = snapshot(dir);
        announce(coordinator, GAME_A, entries);
        await coordinator.drain();
        await coordinator.sweepLiveness([gameRecordOf(GAME_A, PIN)]);
        assert.deepEqual(snapshot(dir), before, c.name);
        assert.equal(coordinator.pending(), 0, `${c.name}: dropped here, never retried (the pool that continues it seals it)`);
        assert.deepEqual([coordinator.stats.sealed, coordinator.stats.prepared, coordinator.stats.held], [0, 0, 0], c.name);
        assert.deepEqual(
          ops.lines.filter((line) => line.event === "money.not-continued").map((line) => [line.game_id, line.why]),
          [[GAME_A, c.why]],
          c.name,
        );
      });
    }
  });

  test("the pool that continues it seals and prepares from `funding` (dealt -> sealed -> prepared)", () =>
    withDir("t12-ok", async (dir) => {
      const store = createFileFinancialGameStore(dir, quiet);
      assert.equal((await store.create(newFinancialRecord(GAME_A, currentMoneyContinuation(), T0, PIN))).outcome.kind, "committed");
      const coordinator = coordinatorWith(store, servingOver([PIN]));
      announce(coordinator, GAME_A, entries);
      await coordinator.drain();
      const record = (await store.load(GAME_A)) as FinancialGameRecord;
      assert.deepEqual([record.phase, record.terminal?.log_len], ["intent-prepared", entries.length]);
    }));

  test("a money identity that contradicts its own deal is the OWNER's hold (continuation-incompatible), once; any other pool writes nothing", () =>
    withDir("t12-identity", async (dir) => {
      /* Hosted protocols [1, 2] (a pool that reads both), a money identity of hosted 2, a deal of hosted 1 (absent). */
      const WIDE: Partial<DeploymentCapability> = { hosted_protocols: [1, 2] };
      const store = createFileFinancialGameStore(dir, quiet);
      assert.equal((await store.create(newFinancialRecord(GAME_A, { ...currentMoneyContinuation(), hosted_protocol: 2 }, T0, PIN))).outcome.kind, "committed");
      const before = snapshot(dir);
      const ops = createMemoryOpsRecorder();
      const elsewhere = coordinatorWith(store, createMoneyServing({ capability: servingOver([PIN_B], WIDE).capability, ops }), { ops });
      announce(elsewhere, GAME_A, entries);
      await elsewhere.drain();
      assert.deepEqual(snapshot(dir), before, "not the owner: nothing");
      assert.deepEqual(
        ops.lines.filter((line) => line.event === "money.conflict-elsewhere").map((line) => line.why),
        ["identity-conflict"],
      );
      const owner = coordinatorWith(store, servingOver([PIN], WIDE));
      announce(owner, GAME_A, entries);
      await owner.drain();
      const held = (await store.load(GAME_A)) as FinancialGameRecord;
      assert.deepEqual([held.phase, held.hold?.code, held.terminal], ["held", CONFLICT_HOLD_CODES["identity-conflict"], null], "held BEFORE any deal or seal was written");
      const once = snapshot(dir);
      announce(owner, GAME_A, entries);
      await owner.drain();
      await owner.sweepLiveness([gameRecordOf(GAME_A, PIN)]);
      assert.deepEqual(snapshot(dir), once, "once");
    }));
});

/* ================================================================================================= */
/* T-13: artifact formats                                                                             */
/* ================================================================================================= */

describe("LIVE-4 T-13 / D4-15: financial artifacts of another build's format are not continued -- never held, never overwritten", () => {
  const moneyFile = (dir: string, gameId: string) => path.join(financialDirectory(dir), `${gameId}.json`);
  const writeMoney = (dir: string, gameId: string, text: string) => {
    fs.mkdirSync(financialDirectory(dir), { recursive: true });
    fs.writeFileSync(moneyFile(dir, gameId), text);
  };

  test("a financial record that is newer (v3), older (v1) or corrupt: its class travels with the store's refusal; the load, the coordinator and the operator write nothing", async () => {
    const record = dealtRecord(GAME_A, PIN);
    const cases: ReadonlyArray<readonly [string, string, "newer" | "older-unread" | "corrupt", string]> = [
      ["newer", `${JSON.stringify({ ...record, version: FINANCIAL_VERSION + 1, settlement_route: { next: true } })}\n`, "newer", "newer-format"],
      ["older", `${JSON.stringify({ ...record, version: FINANCIAL_VERSION - 1 })}\n`, "older-unread", "older-format"],
      ["torn", `${JSON.stringify(record).slice(0, 80)}`, "corrupt", "malformed"],
      ["damaged current", `${JSON.stringify({ ...record, phase: "sideways" })}\n`, "corrupt", "malformed"],
    ];
    for (const [name, text, format, klass] of cases) {
      await withDir("t13-fin", async (dir) => {
        writeMoney(dir, GAME_A, text);
        const world = await fileWorld(dir);
        const before = snapshot(dir);
        const store = createFileFinancialGameStore(dir, quiet);
        await assert.rejects(() => store.load(GAME_A), (error: unknown) => error instanceof FinancialRecordUnreadableError && error.format === format, name);
        assert.notEqual((await store.create(newFinancialRecord(GAME_A, currentMoneyContinuation(), T0, PIN))).outcome.kind, "committed", `${name}: never overwritten by a create`);
        assert.notEqual((await store.put({ ...record, record_version: 3 }, 2)).kind, "committed", `${name}: never overwritten by a put`);
        /* The service's load (a new process), its jobs, and the coordinator of the same process. */
        const loaded = await world.restart();
        assert.deepEqual([loaded.games, loaded.held, loaded.skipped], [0, 0, 1], name);
        await world.service.sweepChain();
        await world.service.idle();
        await world.relayer.pass();
        await sealThrough(world, GAME_A, storedLog(2));
        assert.deepEqual(snapshot(dir), before, `${name}: not one byte (and never repaired into this build's format)`);
        assert.deepEqual(
          opsOf(world, "money.not-continued").map((line) => line.why),
          [klass],
          name,
        );
        /* The operator's read-only view names the class. */
        const seen = await inspectMoney(dir, undefined, { serving: servingOver([PIN]) });
        assert.deepEqual(
          seen.games.map((game) => [game.gameId, game.readable, game.class, game.formats.fin]),
          [[GAME_A, false, klass, format]],
          name,
        );
      });
    }
  });

  test("chain intents in a NEWER schema: the relayer never parses the game, the service does not continue it, nothing is written", () =>
    withDir("t13-intents", async (dir) => {
      const world = await fileWorld(dir);
      const session = await dealt(world);
      const later = path.join(chainIntentDirectory(dir), GAME_A, `${"f".repeat(64)}.json`);
      fs.writeFileSync(later, `${JSON.stringify({ format: "gs-chain-intent", schema: 2, game_id: GAME_A, intent_id: "f".repeat(64), route: "a later build's" })}\n`);
      assert.equal(await createFileChainIntentStore(dir, quiet).formatOf(GAME_A), "newer");
      await assert.rejects(() => createFileChainIntentStore(dir, quiet).listGame(GAME_A), (error: unknown) => error instanceof ChainIntentUnreadableError && error.format === "newer");
      const before = snapshot(dir);
      const loaded = await world.restart();
      assert.deepEqual([loaded.games, loaded.held, loaded.skipped], [1, 0, 1]);
      assert.equal(world.relayer.status().skipped_games, 1);
      await world.relayer.pass();
      play(world, GAME_A, 1, session);
      await world.service.idle();
      await world.service.sweepChain();
      await world.service.idle();
      await sealThrough(world, GAME_A, session.entries);
      assert.deepEqual(snapshot(dir), before, "not one byte");
      assert.deepEqual(
        opsOf(world, "money.not-continued").map((line) => line.why),
        ["newer-format"],
      );
      const seen = await inspectMoney(dir, GAME_A, { serving: servingOver([PIN]) });
      assert.deepEqual([seen.games[0].class, seen.games[0].formats.intents, seen.games[0].intents_unreadable], ["newer-format", "newer", true]);
    }));

  test("a ticket ledger of financial protocol 2 is older-unread (never upgraded); a damaged one is corrupt; neither game is continued or written", async () => {
    for (const [name, rewrite, format, klass] of [
      [
        "protocol-2 grants",
        (text: string) => {
          const stored = JSON.parse(text) as { document: { grants: Array<Record<string, unknown>> } };
          for (const grant of stored.document.grants) for (const key of ["proof", "consent_keys", "relinked_from", "create_floor"]) delete grant[key];
          return `${JSON.stringify(stored)}\n`;
        },
        "older-unread",
        "older-format",
      ],
      ["torn", (text: string) => text.slice(0, 40), "corrupt", "malformed"],
    ] as const) {
      await withDir("t13-tickets", async (dir) => {
        const world = await fileWorld(dir);
        const session = await dealt(world);
        const file = path.join(walletTicketDirectory(dir), `${GAME_A}.json`);
        fs.writeFileSync(file, rewrite(fs.readFileSync(file, "utf8")));
        assert.equal(await createFileWalletTicketStore(dir, quiet).formatOf(GAME_A), format, name);
        await assert.rejects(() => createFileWalletTicketStore(dir, quiet).load(GAME_A), (error: unknown) => error instanceof WalletTicketStoreUnreadableError && error.format === format, name);
        const before = snapshot(dir);
        const loaded = await world.restart();
        assert.deepEqual([loaded.games, loaded.held, loaded.skipped], [1, 0, 1], name);
        await world.relayer.pass();
        play(world, GAME_A, 1, session);
        await world.service.idle();
        await world.service.sweepChain();
        await world.service.idle();
        await sealThrough(world, GAME_A, session.entries);
        assert.deepEqual(snapshot(dir), before, `${name}: not one byte`);
        assert.deepEqual(
          opsOf(world, "money.not-continued").map((line) => line.why),
          [klass],
          name,
        );
        const seen = await inspectMoney(dir, GAME_A, { serving: servingOver([PIN]) });
        assert.deepEqual([seen.games[0].class, seen.games[0].formats.tickets], [klass, format], name);
      });
    }
  });
});

/* ================================================================================================= */
/* T-22: a configuration typo                                                                         */
/* ================================================================================================= */

describe("LIVE-4 T-22: a configuration typo before verification is derived -- never a hold", () => {
  test("a mistyped denom while the chain is unreachable: every money game is deployment-unverified and nothing is written; the chain's true facts do not make it a conflict; the fixed configuration continues it", () =>
    withDir("t22", async (dir) => {
      const world = await fileWorld(dir);
      const session = await dealt(world);
      toStockRound(world, GAME_A, session);
      await world.service.idle();
      const prepared = (await fin(world)).chain.checkpoint_prepared;
      assert.ok(prepared !== null);
      assert.ok((await world.service.createMoneyGame(GAME_B)).ok, "a second money game, still funding");
      const before = snapshot(dir);

      world.pin = PIN_TYPO;
      world.chain.unavailable = true;
      const loaded = await world.restart();
      assert.deepEqual(loaded, { games: 2, held: 0, resumed: 0, skipped: 2 });
      for (const gameId of [GAME_A, GAME_B]) {
        assert.equal(why((await world.service.servingDecision(gameId)).verdict), "not-continued/deployment-unverified", gameId);
      }
      await world.relayer.pass();
      passRound(world, GAME_A, session);
      await world.service.idle();
      await sealThrough(world, GAME_A, session.entries);
      assert.deepEqual(snapshot(dir), before, "not one byte");

      /* The chain answers again, at verification grade: it agrees with the GAMES (ujunox), so the configuration is what
         is wrong -- still derived, never a conflict. */
      world.chain.unavailable = false;
      assert.equal((await world.service.refreshChainFacts()).kind, "read");
      const still = (await world.service.servingDecision(GAME_A)).verdict;
      assert.equal(why(still), "not-continued/deployment-unverified");
      assert.match(still.kind === "continues" ? "" : still.detail, /the configuration is what is wrong/);
      await world.service.sweepChain();
      await world.service.idle();
      await world.relayer.pass();
      assert.deepEqual(snapshot(dir), before, "still not one byte");
      assert.equal(opsOf(world, "settlement.held").length, 0);

      /* The operator fixes the configuration: both games continue, and A's open checkpoint lands. */
      world.pin = PIN;
      const fixed = await world.restart();
      assert.deepEqual([fixed.games, fixed.held, fixed.skipped], [2, 0, 0]);
      for (const gameId of [GAME_A, GAME_B]) assert.equal((await world.service.servingDecision(gameId)).verdict.kind, "continues", gameId);
      await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed?.log_len === prepared.log_len);
    }));
});

/* ================================================================================================= */
/* T-23: a missing financial record                                                                   */
/* ================================================================================================= */

describe("LIVE-4 T-23: a money table with no financial record -- only its owner writes, once", () => {
  test("pools that do not serve the table's escrow write nothing; the owner writes ESCROW-3A's held placeholder once, and never seals onto it", () =>
    withDir("t23", async (dir) => {
      const store = createFileFinancialGameStore(dir, quiet);
      const entries = storedLog(3);
      for (const [name, serving] of [
        ["serving no escrow", noMoneyServing()],
        ["serving contract B", servingOver([PIN_B])],
      ] as const) {
        const ops = createMemoryOpsRecorder();
        const coordinator = coordinatorWith(store, createMoneyServing({ capability: serving.capability, ops }), { ops });
        announce(coordinator, GAME_A, entries);
        await coordinator.drain();
        await coordinator.sweepLiveness([gameRecordOf(GAME_A, PIN)]);
        assert.deepEqual(snapshot(dir), {}, `${name}: nothing -- the pool that serves the table's escrow writes its placeholder`);
        assert.equal(coordinator.pending(), 0, name);
        assert.deepEqual(
          ops.lines.filter((line) => line.event === "money.conflict-elsewhere").map((line) => line.why),
          ["financial-record-missing"],
          name,
        );
      }
      /* Money terms that name no deployment at all: nobody owns it, nobody writes. */
      const orphan = coordinatorWith(store, servingOver([PIN]));
      orphan.onGameplayClosed({ gameId: GAME_B, record: gameRecordOf(GAME_B, null), seal: sealOf(entries, true) as TerminalSeal, recovered: false, entries });
      await orphan.drain();
      assert.deepEqual(snapshot(dir), {});

      const owner = coordinatorWith(store, servingOver([PIN]));
      announce(owner, GAME_A, entries);
      await owner.drain();
      const placeholder = (await store.load(GAME_A)) as FinancialGameRecord;
      assert.deepEqual(
        [placeholder.record_version, placeholder.phase, placeholder.hold?.code, placeholder.continuation, placeholder.terminal],
        [1, "held", CONFLICT_HOLD_CODES["financial-record-missing"], null, null],
      );
      const once = snapshot(dir);
      announce(owner, GAME_A, entries);
      await owner.drain();
      await owner.sweepLiveness([gameRecordOf(GAME_A, PIN)]);
      const restarted = coordinatorWith(store, servingOver([PIN]));
      await restarted.load();
      announce(restarted, GAME_A, entries);
      await restarted.drain();
      await restarted.sweepLiveness([gameRecordOf(GAME_A, PIN)]);
      assert.deepEqual(snapshot(dir), once, "once: never re-created, never rewritten, never sealed onto");
      assert.deepEqual(placeholder, missingRecordPlaceholder(GAME_A, T0 + 10_000, placeholder.hold?.detail ?? ""), "exactly ESCROW-3A's placeholder");
    }));
});

/* ================================================================================================= */
/* The verification-grade chain-fact contract                                                        */
/* ================================================================================================= */

describe("LIVE-4 L4-4: `runtime.chainFacts` come only from verification-grade reads", () => {
  /** A ConfigResponse (the contract's `config` query answer) whose contract config names `denom`. */
  const withDenom = (config: unknown, denom: string) => {
    const response = config as { readonly config: Record<string, unknown> };
    return { ...response, config: { ...response.config, denom } };
  };

  /** Two (or more) nodes, each answering the five reads a verification-grade read makes. */
  function nodes(config: unknown, answers: Record<string, { chain?: string; syncing?: boolean; checksum?: string; denom?: string; down?: boolean }>): HttpTransport {
    return async (request) => {
      const base = Object.keys(answers).find((prefix) => request.url.startsWith(prefix));
      if (base === undefined) throw new JunoRpcError("unavailable", "no such node");
      const node = answers[base];
      if (node.down === true) throw new JunoRpcError("unavailable", "the node is down");
      const route = request.url.slice(base.length);
      const ok = (json: unknown) => ({ status: 200, text: JSON.stringify(json) });
      if (route === "/cosmos/base/tendermint/v1beta1/node_info") return ok({ default_node_info: { network: node.chain ?? CHAIN_ID } });
      if (route === "/cosmos/base/tendermint/v1beta1/syncing") return ok({ syncing: node.syncing ?? false });
      if (route === `/cosmwasm/wasm/v1/contract/${CONTRACT}`) return ok({ address: CONTRACT, contract_info: { code_id: "4242" } });
      if (route === "/cosmwasm/wasm/v1/code-info/4242") return ok({ checksum: node.checksum ?? CANONICAL_CHECKSUM });
      if (route.startsWith(`/cosmwasm/wasm/v1/contract/${CONTRACT}/smart/`)) return ok({ data: withDenom(config, node.denom ?? PIN.denom) });
      return { status: 404, text: JSON.stringify({ code: 5, message: "not found" }) };
    };
  }
  const restOver = (http: HttpTransport, endpoints: readonly string[], expectedChainId: string = CHAIN_ID): JunoRest =>
    createJunoRest({ endpoints: [...endpoints], expectedChainId, allowInsecureLocalHttp: false, timeoutMs: 1_000, maxResponseBytes: 64 * 1024, maxCodeBytes: 1024 }, http);
  const A = "https://a.example";
  const B = "https://b.example";

  test("every endpoint on the configured chain, not syncing, agreeing: a fact; one down, syncing, on another chain or disagreeing: none", async () => {
    const config = await makeWorld().chain.smart(CONTRACT, QUERY.config());
    const read = (answers: Parameters<typeof nodes>[1], endpoints = [A, B]) => readVerifiedChainFacts(PIN, restOver(nodes(config, answers), endpoints), () => T0);
    assert.deepEqual(await read({ [A]: {}, [B]: {} }), { kind: "read", key: KEY_A, facts: { code_checksum: CANONICAL_CHECKSUM, denom: PIN.denom }, read_at: T0 });
    assert.equal((await read({ [A]: {} }, [A])).kind, "read", "one configured endpoint: its own answer, on the chain and not syncing");
    for (const [name, answers] of [
      ["one endpoint down (never one failover answer)", { [A]: {}, [B]: { down: true } }],
      ["one endpoint syncing", { [A]: {}, [B]: { syncing: true } }],
      ["one endpoint on another chain", { [A]: {}, [B]: { chain: "juno-1" } }],
      ["the endpoints disagree about the code", { [A]: {}, [B]: { checksum: OTHER_CHECKSUM } }],
      ["the endpoints disagree about the denom", { [A]: {}, [B]: { denom: "uother" } }],
    ] as const) {
      const answer = await read(answers);
      assert.equal(answer.kind, "unavailable", name);
    }
    /* A transport configured for another chain than the pin's is never asked. */
    assert.equal((await readVerifiedChainFacts(PIN, restOver(nodes(config, { [A]: {} }), [A], "juno-1"))).kind, "unavailable");
  });

  test("malformed facts are no facts; a transport that cannot make a verification-grade read makes none", async () => {
    const config = await makeWorld().chain.smart(CONTRACT, QUERY.config());
    const stub = (code_checksum: string, denom: string): JunoRest => ({ chainId: CHAIN_ID, verifiedContractFacts: async () => ({ code_checksum, config: withDenom(config, denom) }) }) as unknown as JunoRest;
    assert.equal((await readVerifiedChainFacts(PIN, stub(CANONICAL_CHECKSUM.toUpperCase(), PIN.denom))).kind, "unavailable", "not 64 lowercase hex");
    assert.equal((await readVerifiedChainFacts(PIN, stub(CANONICAL_CHECKSUM, "u junox"))).kind, "unavailable", "not a printable token");
    assert.equal((await readVerifiedChainFacts(PIN, { chainId: CHAIN_ID } as unknown as JunoRest)).kind, "unavailable");
  });

  test("the serving records only reads: never configuration; a failed read keeps what was read; a later read replaces it", () => {
    const serving = servingOver([PIN]);
    assert.equal(serving.runtime().chainFacts?.size ?? 0, 0, "configuration is never a chain fact");
    assert.equal(serving.chainFactsReadAt(KEY_A), null);
    serving.recordChainFacts({ kind: "read", key: KEY_A, facts: { code_checksum: CANONICAL_CHECKSUM, denom: PIN.denom }, read_at: T0 });
    serving.recordChainFacts({ kind: "unavailable", key: KEY_A, detail: "the node is down" });
    assert.deepEqual([serving.runtime().chainFacts?.get(KEY_A), serving.chainFactsReadAt(KEY_A)], [{ code_checksum: CANONICAL_CHECKSUM, denom: PIN.denom }, T0]);
    serving.recordChainFacts({ kind: "read", key: KEY_A, facts: { code_checksum: OTHER_CHECKSUM, denom: PIN.denom }, read_at: T0 + 1 });
    assert.deepEqual([serving.runtime().chainFacts?.get(KEY_A)?.code_checksum, serving.chainFactsReadAt(KEY_A)], [OTHER_CHECKSUM, T0 + 1]);
    assert.equal(servingOver([PIN]).runtime().chainFacts?.size ?? 0, 0, "per process: a new serving remembers nothing");
  });
});

/* ================================================================================================= */
/* The operator                                                                                       */
/* ================================================================================================= */

describe("LIVE-4 L4-4: the operator's money view is the canonical verdict -- read-only -- and a release obeys it", () => {
  function dealtOnDisk(dir: string, gameId: string): void {
    const entries = storedLog(1);
    const record: GameRecord = { ...seededRecord([ALICE, BOB], { dealt: true, gameId }), rules_engine_version: RULES_ENGINE_VERSION, started_at: entries[0].at ?? T0 };
    fs.mkdirSync(path.join(dir, "games"), { recursive: true });
    fs.writeFileSync(path.join(dir, "games", `${gameId}.json`), `${JSON.stringify(record)}\n`);
    fs.writeFileSync(path.join(dir, `${gameId}.log.jsonl`), entries.map((entry) => serializeBatch([entry])).join(""));
  }

  async function heldMoneyOnDisk(dir: string, gameId: string, code: FinancialHoldCode): Promise<void> {
    const store = createFileFinancialGameStore(dir, quiet);
    let record = newFinancialRecord(gameId, currentMoneyContinuation(), T0, PIN);
    assert.equal((await store.create(record)).outcome.kind, "committed");
    for (const event of [
      { kind: "dealt", at: T0 + 1 },
      { kind: "hold", at: T0 + 2, code, detail: "held by a server configured for another contract (before LIVE-4)" },
    ] as const) {
      const moved = transitionFinancial(record, event);
      assert.equal(moved.kind, "moved");
      const next = (moved as { next: FinancialGameRecord }).next;
      assert.equal((await store.put(next, record.record_version)).kind, "committed");
      record = next;
    }
  }

  test("inspect names every class -- continued, unavailable, unverified, another protocol, newer, older, malformed, conflict -- and writes nothing", () =>
    withDir("operator", async (dir) => {
      const store = createFileFinancialGameStore(dir, quiet);
      const ids = Array.from({ length: 9 }, () => mintGameId());
      const [continued, unavailable, unverified, protocol, newer, older, corrupt, missing, placeholder] = ids;
      const create = async (gameId: string, pin: FinancialDeploymentPin, continuation: MoneyContinuationIdentity = currentMoneyContinuation()) =>
        assert.equal((await store.create(newFinancialRecord(gameId, continuation, T0, pin))).outcome.kind, "committed");
      await create(continued, PIN);
      await create(unavailable, PIN_B);
      await create(unverified, PIN_TYPO);
      await create(protocol, PIN, { ...currentMoneyContinuation(), financial_protocol: 2 });
      fs.writeFileSync(path.join(financialDirectory(dir), `${newer}.json`), `${JSON.stringify({ ...newFinancialRecord(newer, currentMoneyContinuation(), T0, PIN), version: FINANCIAL_VERSION + 1 })}\n`);
      fs.writeFileSync(path.join(financialDirectory(dir), `${older}.json`), `${JSON.stringify({ ...newFinancialRecord(older, currentMoneyContinuation(), T0, PIN), version: FINANCIAL_VERSION - 1 })}\n`);
      fs.writeFileSync(path.join(financialDirectory(dir), `${corrupt}.json`), "{");
      fs.mkdirSync(path.join(dir, "games"), { recursive: true });
      fs.writeFileSync(path.join(dir, "games", `${missing}.json`), `${JSON.stringify({ record_schema: 2, money: termsOf(PIN) })}\n`);
      assert.equal((await store.create(missingRecordPlaceholder(placeholder, T0, "test"))).outcome.kind, "committed");
      const before = snapshot(dir);
      const seen = await inspectMoney(dir, undefined, { serving: servingOver([PIN]) });
      const classes = Object.fromEntries(seen.games.map((game) => [game.gameId, [game.class, game.owner]]));
      assert.deepEqual(classes, {
        [continued]: ["continued", true],
        [unavailable]: ["deployment-unavailable", false],
        [unverified]: ["deployment-unverified", true],
        [protocol]: ["financial-protocol", true],
        [newer]: ["newer-format", false],
        [older]: ["older-format", false],
        [corrupt]: ["malformed", false],
        [missing]: ["conflict", true],
        [placeholder]: ["malformed", false],
      });
      assert.deepEqual(seen.against.deployments, [KEY_A]);
      /* Against a verification-grade read that contradicts contract A, the same game is the owner's conflict -- shown,
         never written by an inspection. */
      const contradicted = servingOver([PIN]);
      contradicted.recordChainFacts({ kind: "read", key: KEY_A, facts: { code_checksum: OTHER_CHECKSUM, denom: PIN.denom }, read_at: T0 });
      const conflict = await inspectMoney(dir, continued, { serving: contradicted });
      assert.deepEqual([conflict.games[0].class, conflict.games[0].verdict.why], ["conflict", "deployment-conflict"]);
      assert.deepEqual(snapshot(dir), before, "inspection is read-only: no hold, no placeholder, nothing");
    }));

  test("a pre-LIVE-4 binding-mismatch hold is released only by the pool that serves the game, against a verification-grade read that agrees", () =>
    withDir("operator-release", async (dir) => {
      const gameId = mintGameId();
      dealtOnDisk(dir, gameId);
      await heldMoneyOnDisk(dir, gameId, "binding-mismatch");
      const ops = createMemoryOpsRecorder();
      const release = (serving: MoneyServing) => withLock(dir, (lock) => releaseMoneyHold(dir, gameId, "the escrow at A is served and verified again", { lock, ops, serving }));
      const before = snapshot(dir);
      const refusals: string[] = [];
      for (const serving of [
        servingOver([PIN_B]),
        servingOver([PIN]),
        (() => {
          const contradicted = servingOver([PIN]);
          contradicted.recordChainFacts({ kind: "read", key: KEY_A, facts: { code_checksum: OTHER_CHECKSUM, denom: PIN.denom }, read_at: T0 });
          return contradicted;
        })(),
      ]) {
        const refused = (await release(serving)) as { readonly ok?: boolean; readonly reason?: string };
        assert.equal(refused.ok, false);
        refusals.push(refused.reason ?? "");
      }
      assert.match(refusals[0], /may not continue .*deployment-unavailable/);
      assert.match(refusals[1], /released only against a verification-grade chain read/);
      assert.match(refusals[2], /conflict: deployment-conflict/);
      assert.deepEqual(snapshot(dir), before, "a refused release writes nothing (the lock it took is gone again)");
      const agreeing = servingOver([PIN]);
      agreeing.recordChainFacts({ kind: "read", key: KEY_A, facts: { code_checksum: PIN.code_checksum, denom: PIN.denom }, read_at: T0 });
      assert.deepEqual(await release(agreeing), { ok: true, to: "in-progress" });
      assert.equal(((await createFileFinancialGameStore(dir, quiet).load(gameId)) as FinancialGameRecord).phase, "in-progress");
    }));
});

/* ================================================================================================= */
/* The independent review's findings (claude/LIVE4_L4_4_MONEY_CONTINUATION_2026-09-28.md, "Review")    */
/* ================================================================================================= */

describe("LIVE-4 L4-4 review: one game's unreadable facts are undecided -- never an outage, never a write", () => {
  test("R-1: a log that cannot be read right now never fails the load or a pass for other games; the intent is undecided, untouched, its live attempt guarding the sequence, and proceeds once the log reads", async () => {
    const world = makeWorld();
    await startedGame(world, GAME_A);
    play(world, GAME_A, 0);
    await world.service.idle();
    await world.relayer.pass(); // A's deal checkpoint is broadcast: a live attempt
    const live = (await intentsOf(world)).flatMap((intent) => intent.attempts).filter(isLiveAttempt);
    assert.equal(live.length, 1);
    assert.ok((await world.service.createMoneyGame(GAME_B)).ok);
    const chainB = await fundedGame(world, GAME_B);
    assert.ok((await world.service.bindChainGame(GAME_B, chainB, VARIANTS)).ok);
    assert.ok((await world.service.requestStart(GAME_B, [{ player_id: ALICE }, { player_id: BOB }])).ok);
    const storedA = JSON.stringify(await intentsOf(world));
    world.logFaults.add(GAME_A);
    const loaded = await world.restart(); // before L4-4's review: this threw, and the backend never became active
    assert.deepEqual([loaded.games, loaded.held, loaded.skipped], [2, 0, 1]);
    assert.equal(world.relayer.status().undecided, 1);
    assert.equal(opsOf(world, "chain.intent-undecided").length, 1, "the operator sees it (once per reason)");
    const startB = async () => (await intentsOf(world, GAME_B)).find((intent) => intent.op.kind === "start");
    await world.relayer.pass();
    assert.equal((await startB())?.attempts.length, 0, "A's live attempt may still take this sequence");
    world.chain.produceBlock();
    await world.relayer.pass();
    assert.equal((await startB())?.attempts.length, 1, "B's own work goes on");
    assert.equal(JSON.stringify(await intentsOf(world)), storedA, "A's intent: never observed, deferred or held while undecided");
    world.logFaults.delete(GAME_A);
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed !== null);
    assert.equal(world.relayer.status().undecided, 0);
  });

  test("R-1: another build's game (a newer financial record) costs no log read at all -- it is decided newer-format even while its log cannot be read", async () => {
    const world = makeWorld();
    await startedGame(world, GAME_A);
    play(world, GAME_A, 0);
    await world.service.idle(); // an open checkpoint intent of A's
    (world.financial as MemoryFinancialGameStore).records.set(GAME_A, "newer");
    world.logFaults.add(GAME_A);
    const loaded = await world.restart();
    assert.deepEqual([loaded.games, loaded.held, loaded.skipped], [0, 0, 1]);
    assert.equal(why((await world.service.servingDecision(GAME_A)).verdict), "not-continued/newer-format");
    assert.deepEqual([world.relayer.status().skipped, world.relayer.status().undecided], [1, 0], "decided (skipped), not undecided");
  });

  test("N-2: an undecided intent poked meanwhile is decided ONCE per pass (its owner-conflict hold is one clean write)", async () => {
    const world = makeWorld();
    await startedGame(world, GAME_A);
    play(world, GAME_A, 0);
    await world.service.idle(); // A's deal checkpoint, pending
    const checkpoint = (await intentsOf(world)).find((intent) => intent.op.kind === "checkpoint")!;
    world.logFaults.add(GAME_A);
    await world.restart();
    assert.equal(world.relayer.status().undecided, 1);
    world.logFaults.delete(GAME_A);
    world.chain.reportedChecksum = OTHER_CHECKSUM;
    await world.service.refreshChainFacts();
    world.relayer.poke(GAME_A, checkpoint.intent_id); // now in the open work AND still undecided
    await world.relayer.pass();
    assert.doesNotMatch(world.relayer.status().last_error ?? "", /changed under/);
    const held = (await intentsOf(world)).find((intent) => intent.intent_id === checkpoint.intent_id)!;
    assert.deepEqual([held.status, held.hold?.code, held.record_version], ["held", "binding-mismatch", checkpoint.record_version + 1]);
  });

  test("R-2: an admission whose verdict cannot be computed is undecided -- no retry budget spent, never held -- and signs once it can be", async () => {
    const world = makeWorld();
    assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
    const chainA = await fundedGame(world, GAME_A);
    assert.ok((await world.service.bindChainGame(GAME_A, chainA, VARIANTS)).ok);
    assert.ok((await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }])).ok);
    const start = async () => (await intentsOf(world)).find((intent) => intent.op.kind === "start");
    const stored = JSON.stringify(await start());
    /* The service itself: a fresh process whose log read fails answers `undecided`, never throws into the relayer. */
    world.logFaults.add(GAME_A);
    await world.restart();
    assert.equal((await world.service.admit((await start()) as never)).kind, "undecided");
    world.logFaults.delete(GAME_A);
    /* The relayer: the pass's own classification succeeded, the admission's did not -- eight times over. */
    const admit = world.service.admit;
    world.service.admit = async () => ({ kind: "undecided", why: "the log could not be read (test)" });
    for (let n = 0; n < 8; n += 1) await world.relayer.pass();
    assert.equal(JSON.stringify(await start()), stored, "no CAS write: no failure counted, no retry scheduled, no hold");
    assert.equal(world.relayer.status().undecided, 1);
    world.service.admit = admit;
    await world.relayer.pass();
    assert.equal((await start())?.attempts.length, 1);
    assert.equal(world.relayer.status().undecided, 0);
  });

  test("R-3: the money observer neither reads this server's contract for a table whose escrow is elsewhere nor changes its room", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Elsewhere");
      const table = await openMoneyTable(host);
      const wallet = testWallet("elsewhere-host");
      const key = testConsentKey("elsewhere-host");
      const linked = await linkWallet(host, table.gameId, wallet, key);
      assert.equal(linked.status, 200, linked.text);
      const chainGameId = await hostCreates(world, host, table.gameId, wallet, key, linked.body?.ticket as string);
      await world.observe();
      const bound = (await world.financial.load(table.gameId)) as FinancialGameRecord;
      assert.equal(bound.binding?.escrow?.chain_game_id, chainGameId);
      /* The table's money is (as far as this server can tell) another deployment's: this server does not continue it. */
      const elsewhere = { ...bound, binding: { ...bound.binding!, deployment: PIN_B }, record_version: bound.record_version + 1 };
      assert.equal((await world.financial.put(elsewhere, bound.record_version)).kind, "committed");
      /* THIS server's contract has a chain game of the same number, and it is cancelled. */
      assert.ok(world.chain.cancel(chainGameId, wallet.address).ok);
      await world.observe();
      await world.observe();
      assert.equal(world.server.rooms.moneyPort.recordOf(table.gameId)?.status, "waiting", "never mirrored from another deployment's chain game");
      const shown = ((await viewOf(host.client, table.gameId)).money as { readonly escrow?: { readonly state?: string } }).escrow?.state;
      assert.notEqual(shown, "CANCELLED", "another deployment's chain game of the same number is never shown as this table's");
      assert.equal(JSON.stringify(await world.financial.load(table.gameId)), JSON.stringify(elsewhere));
      assert.ok(world.ops.lines.some((line) => line.event === "money.not-continued" && line.game_id === table.gameId && line.why === "deployment-unavailable"));
    } finally {
      await world.close();
    }
  });

  test("N-1: on this server's OWN contract, a table it does not continue still shows its players their chain state and exits -- only acting on it waits", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Own");
      const table = await openMoneyTable(host);
      const hostWallet = testWallet("own-host");
      const hostKey = testConsentKey("own-host");
      const linked = await linkWallet(host, table.gameId, hostWallet, hostKey);
      assert.equal(linked.status, 200, linked.text);
      const chainGameId = await hostCreates(world, host, table.gameId, hostWallet, hostKey, linked.body?.ticket as string);
      await world.observe();
      const joiner = await player(world, "Joan");
      assert.equal((await joiner.client.op({ type: "join", code: table.code, takeSeat: true })).ok, true);
      const joinerWallet = testWallet("own-joiner");
      const joinerKey = testConsentKey("own-joiner");
      const linkedJoiner = await linkWallet(joiner, table.gameId, joinerWallet, joinerKey);
      assert.equal(linkedJoiner.status, 200, linkedJoiner.text);
      await joinerFunds(world, joiner, table.gameId, joinerWallet, joinerKey, linkedJoiner.body?.ticket as string);
      /* Before any observation of that deposit, the contract at this server's address reports other code (a
         verification-grade read): the table is the owner's conflict -- not continued here. */
      world.chain.reportedChecksum = OTHER_CHECKSUM;
      await world.service.refreshChainFacts();
      assert.equal(why((await world.service.servingDecision(table.gameId)).verdict), "conflict/deployment-conflict");
      const stored = JSON.stringify(await world.financial.load(table.gameId));
      type MoneyView = { readonly escrow?: { readonly state?: string }; readonly you?: { readonly funding?: string; readonly actions?: readonly string[] } };
      const joinerView = async () => (await viewOf(joiner.client, table.gameId)).money as MoneyView;
      world.advance(6_000);
      await world.observe();
      const funded = await joinerView();
      assert.deepEqual([funded.escrow?.state, funded.you?.funding], ["FUNDED", "funded"], "the chain is still READ for the players: it is their own contract");
      assert.ok(funded.you?.actions?.includes("withdraw"), "their own exit on their own contract stays offered");
      /* The creator cancels on chain: the players see it at once -- and nothing is DONE about it by a server that does
         not continue the table (no mirrored room, no record change). */
      assert.ok(world.chain.cancel(chainGameId, hostWallet.address).ok);
      world.advance(6_000);
      await world.observe();
      assert.equal((await joinerView()).escrow?.state, "CANCELLED");
      assert.equal(world.server.rooms.moneyPort.recordOf(table.gameId)?.status, "waiting");
      assert.equal(JSON.stringify(await world.financial.load(table.gameId)), stored, "the observer acted on nothing");
    } finally {
      await world.close();
    }
  });

  test("R-4: the operator's money view LISTS a game whose files cannot be read at all (a store fault), and its exit code counts it", () =>
    withDir("r4", async (dir) => {
      fs.mkdirSync(path.join(financialDirectory(dir), `${GAME_A}.json`), { recursive: true }); // EISDIR on every read
      const seen = await inspectMoney(dir, undefined, { serving: servingOver([PIN]) });
      assert.deepEqual(
        seen.games.map((game) => [game.gameId, game.readable, game.class, game.verdict.why]),
        [[GAME_A, false, "store-fault", "store-fault"]],
      );
    }));

  test("R-5: a missing financial record judged with its table's terms is the OWNER's conflict -- never announced as someone else's", async () => {
    const world = makeWorld();
    const withTerms = await world.service.servingDecision(GAME_B, { ownerKey: KEY_A });
    assert.deepEqual([why(withTerms.verdict), withTerms.owner, withTerms.holdCode], ["conflict/financial-record-missing", true, "financial-record-missing"]);
    assert.equal(opsOf(world, "money.conflict-elsewhere", GAME_B).length, 0, "the owner's conflict is its placeholder, not a page about another pool");
    const unnamed = await world.service.servingDecision(GAME_B);
    assert.deepEqual([unnamed.owner, unnamed.holdCode], [false, null]);
    assert.ok(world.warnings.some((line) => line.includes(GAME_B) && line.includes("nothing this server holds names its escrow")));
  });

  test("R-6: chain facts are read one at a time (a slow older read never lands over a newer one)", async () => {
    const world = makeWorld();
    let reads = 0;
    const read = world.chain.verifiedContractFacts.bind(world.chain);
    world.chain.verifiedContractFacts = async (contract, query) => {
      reads += 1;
      return read(contract, query);
    };
    const [first, second] = await Promise.all([world.service.refreshChainFacts(), world.service.refreshChainFacts()]);
    assert.equal(reads, 1);
    assert.equal(first, second);
    await world.service.refreshChainFacts();
    assert.equal(reads, 2, "the next read after it is a new read");
  });

  test("R-8: on a pool whose backend verification failed (never loaded), the settlement coordinator's step -1 still holds a chain-attested contradiction -- and only then", () =>
    withDir("r8", async (dir) => {
      const store = createFileFinancialGameStore(dir, quiet);
      assert.equal((await store.create(newFinancialRecord(GAME_A, currentMoneyContinuation(), T0, PIN))).outcome.kind, "committed");
      const serving = servingOver([PIN]);
      const coordinator = coordinatorWith(store, serving);
      await coordinator.sweepLiveness([gameRecordOf(GAME_A, PIN)]);
      assert.equal(((await store.load(GAME_A)) as FinancialGameRecord).phase, "in-progress", "no fact read: it continues (the deal derived)");
      serving.recordChainFacts({ kind: "read", key: KEY_A, facts: { code_checksum: PIN.code_checksum, denom: "uother" }, read_at: T0 });
      await coordinator.sweepLiveness([gameRecordOf(GAME_A, PIN)]);
      const held = (await store.load(GAME_A)) as FinancialGameRecord;
      assert.deepEqual([held.phase, held.hold?.code], ["held", "binding-mismatch"]);
    }));
});
