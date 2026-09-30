// server/src/escrow/l5_6RelayerRole.test.ts
//
// ==================================================================
//  LIVE-5 L5-6: THE RELAYER'S SIDE-EFFECT GATES -- A STALE TASK NEVER ACTS MERELY BECAUSE ITS WORKER IS ALIVE
// ==================================================================
//
// The relayer (ESCROW-3B) over the offline chain, with the L5-6 seam: a relayer role (`RelayerAuthority`) the worker asks
// (1) before every pass -- a task that does not hold the role runs none -- and (2) at the LAST responsible moment before
// each external side effect: the KMS Sign of a new attempt, its first broadcast, and every rebroadcast. A refusal writes
// nothing and spends no failure budget; a stored attempt stays live for the next pass or the next relayer, which observes
// it before it signs anything. The role here is scripted (memory stores, no fences): this file pins the WORKER's
// behaviour. The durable half -- the ledger's relayer fence and the intent writes' ROLE_RL, evaluated by DynamoDB -- is
// `persistence/conformance/relayerRole.dynamoLocal.test.ts`.
//
// Also here: F-L5-2 (the L5-5 handoff) -- a KMS `unavailable` answer is not the intent's failure: it backs off and never
// holds an intent (a Settle held for a key-service brownout would hold the game).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ALICE, BOB, quietConsole } from "../rooms/testSupport";
import { isLiveAttempt, type ChainIntentRecord } from "./chainIntents";
import type { RelayerAuthority, RelayerSideEffect } from "./juno/relayer";
import { SignerError, type DigestSigner } from "./juno/signer";
import { fundedGame, GAME_A, makeWorld, RELAYER_ADDRESS, VARIANTS, type World, type WorldOptions } from "./escrow3bSupport";

quietConsole();

/** A scripted relayer role: `current` and the refusals are the test's; every question is recorded. */
function scriptedRole() {
  const state = {
    current: true,
    refuse: new Set<RelayerSideEffect>(),
    asked: [] as RelayerSideEffect[],
    /** Runs when a side effect is asked about, BEFORE the answer (a takeover landing at that very moment). */
    onAsk: null as ((what: RelayerSideEffect) => void) | null,
  };
  const authority: RelayerAuthority = {
    current: () => state.current,
    async beforeSideEffect(what) {
      state.asked.push(what);
      state.onAsk?.(what);
      if (!state.current) throw new Error(`not the relayer (${what})`);
      if (state.refuse.has(what)) throw new Error(`could not be shown current just now (${what})`);
    },
  };
  return { state, authority };
}

/** Counts every digest the relayer key is asked to sign (and can make it fail). */
function countingKey() {
  const counter = { signed: 0, unavailable: 0, refused: false, onSign: null as (() => void) | null };
  const wrap = (inner: DigestSigner): DigestSigner => ({
    ...inner,
    async sign(bytes) {
      counter.onSign?.();
      if (counter.refused) throw new SignerError("refused", "the key is disabled");
      if (counter.unavailable > 0) {
        counter.unavailable -= 1;
        throw new SignerError("unavailable", "KMS Sign: no answer within 3 s", { signatureMayExist: true });
      }
      counter.signed += 1;
      return inner.sign(bytes);
    },
  });
  return { counter, wrap };
}

/** A money game whose Start intent is pending (created, funded, bound, frozen): nothing signed yet. */
async function pendingStart(world: World): Promise<ChainIntentRecord> {
  assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
  const chainGameId = await fundedGame(world, GAME_A);
  assert.ok((await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok);
  assert.ok((await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }])).ok);
  const intents = await world.intents.listGame(GAME_A);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].op.kind, "start");
  assert.equal(intents[0].attempts.length, 0);
  return intents[0];
}

const startOf = async (world: World): Promise<ChainIntentRecord> => (await world.intents.listGame(GAME_A)).find((intent) => intent.op.kind === "start") as ChainIntentRecord;
const journalled = async (world: World) => (await world.journal.allAttempts?.(RELAYER_ADDRESS)) ?? [];

function worldWith(role: ReturnType<typeof scriptedRole>, key: ReturnType<typeof countingKey>, over: Partial<WorldOptions> = {}): World {
  return makeWorld({ wrapRelayerKey: key.wrap, relayerSeam: () => ({ authority: role.authority }), ...over });
}

describe("L5-6: a task that does not hold the relayer role runs no pass", () => {
  test("not current: no verdict, no write, no signature, no broadcast -- the intent is untouched; current again: the Start lands", async () => {
    const role = scriptedRole();
    const key = countingKey();
    const world = worldWith(role, key);
    const before = await pendingStart(world);
    role.state.current = false;
    await world.relayer.pass();
    await world.relayer.pass();
    const after = await startOf(world);
    assert.equal(after.record_version, before.record_version, "nothing was written for it");
    assert.equal(key.counter.signed, 0);
    assert.deepEqual(world.chain.broadcasts, []);
    assert.deepEqual(role.state.asked, [], "no side effect was even asked about");
    assert.match(world.relayer.status().last_error ?? "", /does not hold the relayer role/);
    role.state.current = true;
    await world.drive(async () => (await world.financial.load(GAME_A))?.chain.started !== null);
    assert.equal(key.counter.signed, 1);
    assert.deepEqual(role.state.asked.slice(0, 2), ["sign", "broadcast"], "the sign, then the broadcast, each asked at its own moment");
  });
});

describe("L5-6: a task that does not hold the relayer role runs no pass (a live attempt)", () => {
  test("not current while an attempt is live: not even an observation is written, nothing is rebroadcast", async () => {
    const role = scriptedRole();
    const key = countingKey();
    const world = worldWith(role, key);
    await pendingStart(world);
    await world.relayer.pass(); // live in a mempool
    const live = await startOf(world);
    assert.equal(live.attempts[0].phase, "broadcast");
    role.state.current = false;
    world.clock.now += 500; // an observation the relayer would record (inside the rebroadcast spacing)
    await world.relayer.pass();
    assert.equal((await startOf(world)).record_version, live.record_version, "nothing written");
    world.clock.now += 5_000;
    await world.relayer.pass();
    assert.equal((await startOf(world)).record_version, live.record_version);
    assert.equal(world.chain.broadcasts.length, 1, "nothing rebroadcast");
  });
});

describe("L5-6: the side-effect gates", () => {
  test("SIGN withheld: the key is never asked, nothing is journalled or stored, no failure is counted; the next pass shown current signs", async () => {
    const role = scriptedRole();
    const key = countingKey();
    const world = worldWith(role, key);
    const before = await pendingStart(world);
    role.state.refuse.add("sign");
    await world.relayer.pass();
    await world.relayer.pass();
    const after = await startOf(world);
    assert.equal(key.counter.signed, 0, "no KMS Sign");
    assert.deepEqual(await journalled(world), [], "nothing journalled");
    assert.equal(after.record_version, before.record_version, "nothing stored");
    assert.equal(after.retry.failures, 0, "no failure counted");
    assert.equal(after.status, "pending");
    assert.deepEqual(world.chain.broadcasts, []);
    assert.match(world.relayer.status().last_error ?? "", /sign withheld/);
    assert.ok(world.ops.lines.some((event) => event.event === "chain.side-effect-withheld"));
    role.state.refuse.delete("sign");
    await world.drive(async () => (await world.financial.load(GAME_A))?.chain.started !== null);
    assert.equal(key.counter.signed, 1);
  });

  test("THE ADMIT -> BROADCAST RECHECK: the role is lost after the admission said ok and the attempt was signed and stored -- its bytes are never broadcast by this task; the successor broadcasts THE SAME bytes and signs nothing new", async () => {
    const role = scriptedRole();
    const key = countingKey();
    const world = worldWith(role, key);
    await pendingStart(world);
    /* The admission says ok; the sign gate passes; then (during the signature) a newer task takes the role. */
    key.counter.onSign = () => {
      role.state.current = false;
    };
    await world.relayer.pass();
    key.counter.onSign = null;
    const stored = await startOf(world);
    assert.equal(stored.attempts.length, 1, "the attempt was journalled and stored before the broadcast gate");
    const attempt = stored.attempts[0];
    assert.equal(attempt.phase, "signed", "and never handed to a node");
    assert.ok(isLiveAttempt(attempt));
    assert.deepEqual(world.chain.broadcasts, [], "the demoted task broadcast nothing");
    assert.equal(stored.retry.failures, 0);
    assert.deepEqual(role.state.asked, ["sign"], "the role, known lost, is not even asked: the broadcast is withheld outright");
    assert.ok(world.ops.lines.some((line) => line.event === "chain.side-effect-withheld" && line.what === "broadcast"));
    const old = world.relayer;
    await old.pass();
    assert.deepEqual(world.chain.broadcasts, [], "and it never will: it runs no pass");
    /* The successor (a new task over the same durable intents; the seam hands it the scripted role, current again for
       it): it observes the live attempt before it signs anything. */
    await world.restart();
    role.state.current = true;
    await world.relayer.pass();
    assert.deepEqual(world.chain.broadcasts, [attempt.tx_hash], "the SAME bytes, broadcast by the relayer that holds the role");
    assert.equal(key.counter.signed, 1, "no new signature, no new sequence");
    await world.drive(async () => (await world.financial.load(GAME_A))?.chain.started !== null);
    assert.equal(key.counter.signed, 1);
    const final = await startOf(world);
    assert.equal(final.status, "confirmed");
    assert.equal(final.confirmation?.tx_hash, attempt.tx_hash);
  });

  test("REBROADCAST withheld: a live attempt's same bytes are not handed to a node again by a task not shown current; nothing is written for it; shown current, it rebroadcasts", async () => {
    const role = scriptedRole();
    const key = countingKey();
    const world = worldWith(role, key);
    await pendingStart(world);
    await world.relayer.pass(); // signed, stored, broadcast (in the mempool; no block yet)
    const first = await startOf(world);
    assert.equal(world.chain.broadcasts.length, 1);
    assert.equal(first.attempts[0].phase, "broadcast");
    world.clock.now += 5_000; // past the rebroadcast spacing
    role.state.refuse.add("rebroadcast");
    await world.relayer.pass();
    const held = await startOf(world);
    assert.equal(world.chain.broadcasts.length, 1, "no rebroadcast");
    assert.equal(held.record_version, first.record_version, "nothing written for the withheld side effect");
    assert.equal(held.retry.failures, 0);
    assert.equal(role.state.asked.at(-1), "rebroadcast");
    role.state.refuse.delete("rebroadcast");
    await world.relayer.pass();
    assert.deepEqual(world.chain.broadcasts, [first.attempts[0].tx_hash, first.attempts[0].tx_hash], "the same bytes again");
    assert.equal(key.counter.signed, 1);
  });

  test("a withheld first broadcast (the attempt stored, phase `signed`) is broadcast by the next pass shown current -- asked as a broadcast", async () => {
    const role = scriptedRole();
    const key = countingKey();
    const world = worldWith(role, key);
    await pendingStart(world);
    role.state.refuse.add("broadcast");
    await world.relayer.pass();
    assert.equal((await startOf(world)).attempts[0].phase, "signed");
    assert.deepEqual(world.chain.broadcasts, []);
    await world.relayer.pass();
    assert.deepEqual(world.chain.broadcasts, [], "still withheld");
    role.state.refuse.delete("broadcast");
    await world.relayer.pass();
    assert.equal(world.chain.broadcasts.length, 1);
    assert.deepEqual(role.state.asked, ["sign", "broadcast", "broadcast", "broadcast"]);
    assert.equal(key.counter.signed, 1);
  });

  /* The role lost at each boundary of a pass: whatever the admission said, the demoted task broadcasts no new bytes. */
  for (const boundary of ["classify", "admit", "sign", "journal", "store"] as const) {
    test(`a takeover during ${boundary.toUpperCase()}: this task broadcasts nothing (an earlier "ok" is not a licence)`, async () => {
      const role = scriptedRole();
      const key = countingKey();
      const world = worldWith(role, key);
      await pendingStart(world);
      let fired = false;
      const takeover = () => {
        fired = true;
        role.state.current = false;
      };
      const service = world.service as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const journal = world.journal as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const store = world.intents as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const wrapOnce = (target: Record<string, (...args: unknown[]) => Promise<unknown>>, name: string, when: "before" | "after") => {
        const original = target[name].bind(target);
        target[name] = async (...args: unknown[]) => {
          if (!fired && when === "before") takeover();
          const answer = await original(...args);
          if (!fired && when === "after") takeover();
          return answer;
        };
      };
      if (boundary === "classify") wrapOnce(service, "classifyIntent", "after");
      if (boundary === "admit") wrapOnce(service, "admit", "after");
      if (boundary === "sign") key.counter.onSign = takeover;
      if (boundary === "journal") wrapOnce(journal, "recordAttempt", "after");
      if (boundary === "store") {
        const original = store.put.bind(store);
        store.put = async (...args: unknown[]) => {
          const answer = await original(...args);
          if (!fired && ((args[0] as ChainIntentRecord).attempts.length > 0)) takeover();
          return answer;
        };
      }
      await world.relayer.pass();
      assert.ok(fired, "the takeover landed at that boundary");
      assert.deepEqual(world.chain.broadcasts, [], "no broadcast");
      assert.ok(key.counter.signed <= 1);
      if (boundary === "classify" || boundary === "admit") assert.equal(key.counter.signed, 0, "a role lost before the sign gate: no signature either");
      const intent = await startOf(world);
      assert.equal(intent.retry.failures, 0, "no failure counted");
      assert.notEqual(intent.status, "held");
    });
  }
});

describe("L5-6: a takeover while the previous worker has a live attempt", () => {
  test("the new relayer observes the live attempt before it signs anything: no new sequence, no new signature -- the same bytes land", async () => {
    const role = scriptedRole();
    const key = countingKey();
    const world = worldWith(role, key);
    await pendingStart(world);
    await world.relayer.pass(); // the old worker's attempt is live in a mempool
    const live = (await startOf(world)).attempts[0];
    assert.ok(isLiveAttempt(live));
    /* The old task loses the role; a new task takes it (a new process over the same durable intents). */
    role.state.current = false;
    const old = world.relayer;
    await world.restart();
    role.state.current = true; // the same scripted object serves the new relayer (makeWorld's seam): it is the successor now
    const signedBefore = key.counter.signed;
    world.clock.now += 5_000;
    await world.relayer.pass();
    assert.equal(key.counter.signed, signedBefore, "nothing new signed while the attempt is live");
    const observed = await startOf(world);
    assert.equal(observed.attempts.length, 1, "no second attempt");
    assert.ok(world.chain.broadcasts.every((hash) => hash === live.tx_hash), "only the live attempt's bytes were ever broadcast");
    await world.drive(async () => (await world.financial.load(GAME_A))?.chain.started !== null);
    assert.equal((await startOf(world)).confirmation?.tx_hash, live.tx_hash);
    assert.equal(key.counter.signed, signedBefore);
    void old;
  });
});

describe("L5-6 (F-L5-2): a KMS outage is not the intent's failure", () => {
  test("`unavailable` answers back off and count nothing -- more of them than the failure budget never hold the Start; the key back, it lands", async () => {
    const role = scriptedRole();
    const key = countingKey();
    const world = worldWith(role, key);
    await pendingStart(world);
    key.counter.unavailable = 8; // more than the default failure budget (6)
    await world.drive(async () => key.counter.unavailable === 0, 200);
    const during = await startOf(world);
    assert.equal(during.retry.failures, 0, "no failure counted");
    assert.notEqual(during.status, "held");
    assert.equal(during.attempts.length, 0, "a signature lost in the answer never became an attempt");
    assert.deepEqual(await journalled(world), []);
    assert.ok(world.ops.lines.filter((event) => event.event === "chain.signer-unavailable").length >= 8);
    assert.ok(world.warnings.some((line) => /relayer key is UNAVAILABLE/.test(line)));
    await world.drive(async () => (await world.financial.load(GAME_A))?.chain.started !== null, 200);
    assert.equal(key.counter.signed, 1);
  });

  test("a key the service REFUSES (disabled, deleted) still holds the intent for an operator -- unchanged", async () => {
    const role = scriptedRole();
    const key = countingKey();
    const world = worldWith(role, key);
    await pendingStart(world);
    key.counter.refused = true;
    await world.relayer.pass();
    const intent = await startOf(world);
    assert.equal(intent.status, "held");
    assert.match(intent.hold?.detail ?? "", /relayer key refused/);
  });
});
