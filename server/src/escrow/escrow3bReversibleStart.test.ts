// server/src/escrow/escrow3bReversibleStart.test.ts
//
// ==================================================================
//  ESCROW-3B (owner ruling, 3B -> 4 preflight): THE ROSTER FREEZE IS REVERSIBLE UNTIL THE CHAIN CONFIRMS START
// ==================================================================
//
// Before Start the funding bindings are frozen against mutation; while the Start's outcome is unknown nothing is
// unfrozen (an RPC failure, a lost answer and a crash decide nothing); once the chain shows Start the freeze is
// permanent; when the chain PROVES this freeze's Start can never happen, the table returns to its pre-Start funded
// state (players may withdraw on chain or freeze again). A restart reaches the same answer from the chain.
//
// And the contract-level junk-Join limitation (a production real-money BLOCKER, pinned here against the canonical
// contract source): any wallet paying the ante can occupy a chain seat with an arbitrary 32-byte ticket. The server's
// ticket binding never STARTS such a roster -- it cannot prevent the seat being taken.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { ALICE, BOB, quietConsole } from "../rooms/testSupport";
import { isLiveAttempt, startEpochOf, startInstanceOf, junoInstanceOf, type ChainIntentRecord, type createMemoryChainIntentStore } from "./chainIntents";
import type { MemoryFinancialGameStore } from "./financialGameStore";
import { transitionFinancial, type FinancialGameRecord } from "./moneyLifecycle";
import { escrowInstanceKey } from "../../../frontend/src/gameEngine/escrow/escrowModel";
import { CHAIN_ID, CONSENT_KEYS, CONTRACT, GAME_A, VARIANTS, WALLETS, fundedGame, makeWorld, type World } from "./escrow3bSupport";

quietConsole();

const fin = (world: World, gameId: string = GAME_A) => world.financial.load(gameId) as Promise<FinancialGameRecord>;
const startsOf = async (world: World, gameId: string = GAME_A): Promise<ChainIntentRecord[]> => (await world.intents.listGame(gameId)).filter((intent) => intent.op.kind === "start");
const audited = (world: World, event: string) => world.ops.lines.filter((line) => line.event === event);

/** Created, bound, frozen (epoch 1) and its Start intent written -- nothing submitted yet. Chain game "1". */
async function frozenGame(world: World): Promise<void> {
  assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
  const chainGameId = await fundedGame(world, GAME_A);
  assert.equal(chainGameId, "1");
  assert.ok((await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok);
  const started = await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }]);
  assert.ok(started.ok, JSON.stringify(started));
  assert.equal(world.service.isRosterFrozen(GAME_A), true);
  assert.notEqual(await world.ledger.frozenAt(GAME_A), null);
}

async function assertReleased(world: World, epoch: number): Promise<void> {
  const record = await fin(world);
  assert.equal(record.phase, "funding");
  assert.equal(record.roster, null, "the financial roster is released");
  assert.equal(record.roster_epoch, epoch);
  assert.equal(record.chain.started, null);
  assert.equal(record.hold, null);
  assert.equal(await world.ledger.frozenAt(GAME_A), null, "the ticket ledger is released with it");
  assert.equal(world.service.isRosterFrozen(GAME_A), false, "the table's seats can move again");
  assert.ok(audited(world, "money.roster-released").length >= 1);
}

async function assertPermanent(world: World): Promise<void> {
  const record = await fin(world);
  assert.notEqual(record.chain.started, null, "the chain's Start is recorded");
  assert.notEqual(record.roster, null);
  assert.notEqual(await world.ledger.frozenAt(GAME_A), null);
  assert.equal(world.service.isRosterFrozen(GAME_A), true);
  assert.equal(transitionFinancial(record, { kind: "roster-released", at: 1, epoch: record.roster_epoch, roster_hash: record.roster!.roster_hash, why: "x" }).kind, "refused", "a confirmed Start is never released");
}

describe("the reversible roster freeze: permanent only when the chain confirms Start", () => {
  test("Start definitively rejected ON CHAIN (a seat withdrew under it): proven, released -- then a retry freezes a new epoch and starts", async () => {
    const world = makeWorld();
    await frozenGame(world);
    await world.relayer.pass(); // the Start is signed and in a mempool
    assert.equal(world.chain.mempool.length, 1);
    assert.ok(world.chain.withdraw("1", WALLETS[1]).ok, "BOB's wallet withdraws before the Start lands (the contract allows it)");
    world.chain.produceBlock(); // included -- and refused: the escrow is FUNDING, not FUNDED
    const [failed] = (await startsOf(world))[0].attempts;
    assert.equal(world.chain.txIndex.get(failed.tx_hash)?.code, 5, "the Start failed on chain");
    await world.drive(async () => (await fin(world)).roster === null, 10);
    const [first] = await startsOf(world);
    assert.equal(first.status, "superseded");
    assert.equal(first.attempts.length, 1, "never re-signed: the frozen roster can never start");
    assert.equal(first.attempts[0].phase, "included-failure");
    await assertReleased(world, 1);

    /* The retry: issuing is open again; BOB's wallet rejoins with a NEW ticket; the table freezes a new epoch. */
    const reissued = await world.ledger.issue({ binding: { backend: "juno-cosmwasm", chain_id: CHAIN_ID, deployment_id: CONTRACT }, gameId: GAME_A, playerId: BOB, wallet: WALLETS[1], context: { principalId: "pr_1", familyId: "sf_1", recoverySelector: "rk_1" }, reauthorized: true });
    assert.ok(reissued.ok, "a released ledger issues again");
    assert.ok(world.chain.join("1", { wallet: WALLETS[1], consent_pubkey: CONSENT_KEYS[1], join_ticket: (reissued as { ticket: string }).ticket }).ok);
    const again = await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }]);
    assert.ok(again.ok, JSON.stringify(again));
    assert.equal((await fin(world)).roster_epoch, 2);
    await world.drive(async () => (await fin(world)).chain.started !== null);
    await assertPermanent(world);
    const starts = await startsOf(world);
    assert.equal(starts.length, 2, "one Start slot per freeze");
    assert.notEqual(starts[0].intent_id, starts[1].intent_id);
    const epochTwo = starts.find((intent) => intent.status === "confirmed")!;
    const base = junoInstanceOf(CHAIN_ID, CONTRACT, "1");
    assert.equal(epochTwo.instance, startInstanceOf(base, 2));
    assert.equal(startEpochOf(epochTwo.instance, base), 2);
    assert.equal(world.chain.games.get(1)!.state, "in_progress");
  });

  test("broadcast outcome UNKNOWN: nothing is released while it may land -- later it lands and fails, and only then is the freeze released", async () => {
    const world = makeWorld();
    await frozenGame(world);
    world.chain.loseNextBroadcastAnswer = 1;
    await world.relayer.pass(); // reached a mempool; the answer never came back
    const [attempt] = (await startsOf(world))[0].attempts;
    assert.ok(isLiveAttempt(attempt));
    assert.ok(world.chain.withdraw("1", WALLETS[1]).ok); // the Start can no longer succeed -- but its outcome is unknown
    assert.equal(await world.service.reconcileStart(GAME_A), "pending", "an unknown outcome never releases");
    await world.relayer.pass(); // not found, sequence unspent, below its timeout: still live
    assert.equal(await world.service.reconcileStart(GAME_A), "pending");
    assert.notEqual((await fin(world)).roster, null);
    assert.equal(world.service.isRosterFrozen(GAME_A), true);
    world.chain.produceBlock(); // it lands, and fails
    await world.drive(async () => (await fin(world)).roster === null, 10);
    assert.equal((await startsOf(world))[0].attempts[0].phase, "included-failure");
    await assertReleased(world, 1);
  });

  test("broadcast outcome UNKNOWN, later proven ABSENT (expired, never included): released only after the death proof", async () => {
    const world = makeWorld({ timeoutBlocks: 3 });
    await frozenGame(world);
    world.chain.loseNextBroadcastAnswer = 1;
    await world.relayer.pass();
    world.chain.mempool.length = 0; // it never reaches a block
    assert.ok(world.chain.withdraw("1", WALLETS[1]).ok);
    world.chain.produceBlock();
    await world.relayer.pass(); // below its timeout: rebroadcast, never dead
    assert.ok(isLiveAttempt((await startsOf(world))[0].attempts[0]));
    assert.equal(await world.service.reconcileStart(GAME_A), "pending");
    world.chain.mempool.length = 0;
    for (let n = 0; n < 5; n += 1) world.chain.produceBlock();
    world.chain.mempool.length = 0;
    await world.drive(async () => (await fin(world)).roster === null, 10, false);
    const [start] = await startsOf(world);
    assert.equal(start.attempts.length, 1);
    assert.equal(start.attempts[0].death?.kind, "expiry-passed");
    assert.ok(BigInt(start.attempts[0].resolved_height ?? "0") > BigInt(start.attempts[0].timeout_height));
    await assertReleased(world, 1);
  });

  test("Start CONFIRMED but every answer lost (no index either): the chain's truth makes the freeze permanent; a restart agrees; nothing re-signed", async () => {
    const world = makeWorld();
    await frozenGame(world);
    world.chain.loseNextBroadcastAnswer = 1;
    world.chain.indexDisabled = true;
    world.chain.sequenceIndexDisabled = true;
    await world.relayer.pass();
    world.chain.produceBlock(); // it landed: IN_PROGRESS with exactly this roster
    assert.equal(await world.service.reconcileStart(GAME_A), "started");
    await assertPermanent(world);
    await world.restart();
    assert.equal(world.service.isRosterFrozen(GAME_A), true, "preloaded from the durable store");
    assert.equal(await world.service.reconcileStart(GAME_A), "started");
    await world.drive(async () => (await startsOf(world))[0].status === "confirmed", 6, false);
    const [start] = await startsOf(world);
    assert.equal(start.attempts.length, 1);
    assert.equal(start.confirmation?.how, "chain-state");
    await assertPermanent(world);
  });

  test("crash DURING Start, at each boundary: the restart repairs from durable state and the chain (never a stranded table)", async () => {
    /* (a) The ledger froze; the process died before the financial roster was written. */
    {
      const world = makeWorld();
      assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
      const chainGameId = await fundedGame(world, GAME_A);
      assert.ok((await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok);
      assert.equal(await world.ledger.freeze(GAME_A, 4242), "committed");
      await world.restart();
      await world.service.idle();
      assert.equal(await world.ledger.frozenAt(GAME_A), null, "a ledger freeze without its roster is released at load");
      assert.equal((await startsOf(world)).length, 0);
      assert.ok((await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }])).ok, "the table can freeze and start");
      await world.drive(async () => (await fin(world)).chain.started !== null);
      await assertPermanent(world);
    }
    /* (b) The roster froze; the Start intent was never written. */
    {
      const world = makeWorld();
      assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
      const chainGameId = await fundedGame(world, GAME_A);
      assert.ok((await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok);
      (world.intents as ReturnType<typeof createMemoryChainIntentStore>).failNext.push("definite");
      const refused = await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }]);
      assert.equal(refused.ok, false);
      assert.notEqual((await fin(world)).roster, null, "the freeze stands");
      assert.equal((await startsOf(world)).length, 0);
      await world.restart();
      await world.drive(async () => (await fin(world)).chain.started !== null);
      assert.equal((await startsOf(world)).length, 1, "the same slot, written once");
      await assertPermanent(world);
    }
    /* (c) The chain proved the Start moot; the process died in the middle of the release (ledger released, roster not). */
    {
      const world = makeWorld();
      await frozenGame(world);
      assert.ok(world.chain.withdraw("1", WALLETS[1]).ok);
      (world.financial as MemoryFinancialGameStore).failNext.push("definite");
      await world.relayer.pass(); // the Start is superseded (moot); the release's record write fails
      await world.service.idle();
      assert.equal((await startsOf(world))[0].status, "superseded");
      assert.notEqual((await fin(world)).roster, null, "the release did not finish");
      await world.restart();
      await world.service.idle();
      await assertReleased(world, 1);
    }
  });

  test("a HELD Start (a contract refusal no retry fixes), with nothing ever signed and no Start on chain, is released", async () => {
    const world = makeWorld();
    await frozenGame(world);
    (world.chain.options as { operator: string }).operator = WALLETS[2]; // the relayer is no longer the contract's operator
    await world.relayer.pass(); // simulation: Unauthorized (never retried) -> held
    await world.service.idle();
    const [start] = await startsOf(world);
    assert.equal(start.attempts.length, 0);
    assert.equal(start.status, "superseded", "released: nothing was ever signed and the escrow shows no Start");
    await assertReleased(world, 1);
  });
});

describe("the second review's strandings, each closed", () => {
  test("a Start attempt JOURNALLED but never stored (a failed store write): released once the chain proves it expired", async () => {
    const world = makeWorld({ timeoutBlocks: 3 });
    await frozenGame(world);
    const [start] = await startsOf(world);
    (world.intents as ReturnType<typeof createMemoryChainIntentStore>).failNext.push("definite");
    await world.relayer.pass(); // journalled, then the store refused it: never broadcast
    assert.equal(world.journal.attemptsOf(start.intent_id).length, 1);
    assert.equal((await startsOf(world))[0].attempts.length, 0);
    assert.equal(world.chain.broadcasts.length, 0);
    assert.ok(world.chain.withdraw("1", WALLETS[1]).ok);
    await world.relayer.pass(); // the Start is moot now
    await world.service.idle();
    assert.equal((await startsOf(world))[0].status, "superseded");
    assert.notEqual((await fin(world)).roster, null, "the journalled attempt might still land: not released yet");
    for (let n = 0; n < 5; n += 1) world.chain.produceBlock();
    assert.equal(await world.service.reconcileStart(GAME_A), "released", "a height above its journalled expiry proves it never will");
    await assertReleased(world, 1);
  });

  test("an attempt resolved by a node that did not say its height is proven later from a fresh read", async () => {
    const world = makeWorld();
    await frozenGame(world);
    world.chain.loseNextBroadcastAnswer = 1;
    world.chain.indexDisabled = true;
    world.chain.sequenceIndexDisabled = true;
    await world.relayer.pass();
    assert.ok(world.chain.withdraw("1", WALLETS[1]).ok);
    world.chain.produceBlock(); // lands and fails; its sequence is spent
    world.chain.heightsHidden = true;
    await world.relayer.pass();
    const [attempt] = (await startsOf(world))[0].attempts;
    assert.equal(attempt.phase, "consumed");
    assert.equal(attempt.resolved_height, null);
    await world.relayer.pass();
    await world.service.idle();
    assert.notEqual((await fin(world)).roster, null, "no height, no proof");
    world.chain.heightsHidden = false;
    assert.equal(await world.service.reconcileStart(GAME_A), "released");
    await assertReleased(world, 1);
  });

  test("a seat's own wallet re-joining with another ticket never blocks the deal; an escrow the chain closes before the deal closes the table", async () => {
    const world = makeWorld();
    await frozenGame(world);
    assert.ok(world.chain.withdraw("1", WALLETS[1]).ok);
    assert.ok(world.chain.join("1", { wallet: WALLETS[1], consent_pubkey: CONSENT_KEYS[1], join_ticket: "cd".repeat(32) }).ok);
    await world.drive(async () => (await fin(world)).chain.started !== null);
    const plan = await world.service.rosterSource.plan({ game_id: GAME_A, seats: [{ player_id: ALICE }, { player_id: BOB }], variants: VARIANTS } as never, { shuffle: <T>(items: readonly T[]) => [...items], now: 1 });
    assert.ok(!("refusal" in plan), JSON.stringify(plan));
    assert.ok(audited(world, "money.seat-ticket-changed").length >= 1);
    world.chain.forceState("1", { state: "annulled", outcome: { route: "annul_by_consent", at: world.chain.time, amounts: ["1000000", "1000000"], dust: "0" } });
    await world.service.sweepChain();
    await world.service.idle();
    assert.equal((await fin(world)).phase, "closed");
    await world.restart();
    assert.equal(world.service.isRosterFrozen(GAME_A), false, "a closed escrow freezes nothing");
  });

  test("a financial record RESTORED to before its freeze is held, never released under a Start that exists", async () => {
    const world = makeWorld();
    assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
    const chainGameId = await fundedGame(world, GAME_A);
    assert.ok((await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok);
    const before = await fin(world);
    assert.ok((await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }])).ok);
    await world.relayer.pass(); // the Start is in flight
    (world.financial as MemoryFinancialGameStore).records.set(GAME_A, before); // the record store restored
    await world.restart();
    await world.service.idle();
    const record = await fin(world);
    assert.equal(record.phase, "held");
    assert.equal(record.hold?.code, "journal-ahead");
    assert.notEqual(await world.ledger.frozenAt(GAME_A), null, "the ledger freeze is kept");
    assert.equal(world.service.isRosterFrozen(GAME_A), true, "a held money table moves no seat");
  });
});

describe("the contract-level junk-Join limitation (a production real-money blocker; pinned, not fixed here)", () => {
  test("the canonical contract's Join checks the ticket's LENGTH only (source pin: a contract fix must update this test and the blocker)", () => {
    let repo = __dirname;
    while (!fs.existsSync(path.join(repo, "contracts", "escrow", "src", "execute", "funding.rs"))) {
      const up = path.dirname(repo);
      if (up === repo) throw new Error("the contract source was not found");
      repo = up;
    }
    const source = fs.readFileSync(path.join(repo, "contracts", "escrow", "src", "execute", "funding.rs"), "utf8");
    const join = source.slice(source.indexOf("pub fn join("), source.indexOf("pub fn withdraw("));
    assert.ok(join.length > 200, "Join found");
    assert.match(join, /fixed_bytes::<32>\("join_ticket", &join_ticket\)\?;/, "the ticket's only check is its 32-byte shape");
    assert.doesNotMatch(join, /verify|signature|secp256k1|allowlist|admission|authoriz|operator/i, "no authorization of the joining wallet or its seat");
    const play = fs.readFileSync(path.join(repo, "contracts", "escrow", "src", "execute", "play.rs"), "utf8");
    const start = play.slice(play.indexOf("pub fn start("), play.indexOf("pub(crate) fn accept_signed_payload"));
    assert.match(start, /roster_hash\(&wallets\)/, "Start commits to the seats' WALLETS (the operator decides which roster it starts)");
    assert.doesNotMatch(start, /join_ticket/, "Start never looks at a ticket");
  });

  test("a junk seat (any wallet, any 32-byte ticket, or a COPIED ticket) is never adopted: no freeze, no Start -- but the seat IS taken", async () => {
    for (const ticket of ["ab".repeat(32), "copied"]) {
      const world = makeWorld();
      assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
      const chainGameId = await fundedGame(world, GAME_A);
      const bobTicket = world.chain.games.get(1)!.seats[1].join_ticket; // public on chain once BOB joined
      assert.ok(world.chain.withdraw(chainGameId, WALLETS[1]).ok); // BOB steps out; one seat is open
      const junk = world.chain.join(chainGameId, { wallet: WALLETS[2], consent_pubkey: CONSENT_KEYS[2], join_ticket: ticket === "copied" ? bobTicket : ticket });
      assert.ok(junk.ok, "the contract accepts it: THE LIMITATION");
      assert.equal(world.chain.games.get(1)!.state, "funded", "the junk seat filled the table on chain");
      assert.ok((await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok);
      const start = await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }]);
      assert.equal(start.ok, false);
      assert.equal((start as { code: string }).code, "unbound-seat", `${ticket}: a seat no standing grant claims is never frozen`);
      assert.equal((await fin(world)).roster, null);
      assert.equal(await world.ledger.frozenAt(GAME_A), null);
      assert.equal(world.service.isRosterFrozen(GAME_A), false, "the table is not frozen: its players can leave (and withdraw on chain)");
      assert.equal((await startsOf(world)).length, 0, "no Start is ever prepared for it");
      assert.ok(world.chain.withdraw(chainGameId, WALLETS[0]).ok, "the honest seat's own pre-Start withdraw still works");
    }
  });
});

describe("the Start slot per freeze", () => {
  test("the Juno instance from configuration is GNOLAND-1's instance key; epoch 1 is the instance itself, later epochs are distinct and parse back", async () => {
    const world = makeWorld();
    await frozenGame(world);
    const binding = (await fin(world)).binding!.escrow!;
    const base = escrowInstanceKey(binding);
    assert.equal(junoInstanceOf(CHAIN_ID, CONTRACT, "1"), base);
    assert.equal(startInstanceOf(base, 1), base);
    assert.equal((await startsOf(world))[0].instance, base);
    assert.equal(startEpochOf(startInstanceOf(base, 12), base), 12);
    assert.equal(startEpochOf(`${base}|11:start-epoch|1:1`, base), null, "epoch 1 has one spelling");
    assert.equal(startEpochOf(junoInstanceOf(CHAIN_ID, CONTRACT, "2"), base), null);
    assert.throws(() => startInstanceOf(base, 0));
  });
});
