// server/src/escrow/escrow3bReview.test.ts
//
// ==================================================================
//  ESCROW-3B: THE INDEPENDENT REVIEW'S FINDINGS, EACH PINNED AGAINST ITS FAILURE SCENARIO
// ==================================================================
//
// One test per finding the review confirmed (numbers are the review's): a restored history is never signed over (#1);
// a failed load never leaves the backend "active but blind" (#2); a store fault never yields two live attempts (#3);
// nothing unjournalled is broadcast (#4); an intent is only ever submitted to its own deployment (#5); the server
// finalizes only what it signed, and submits nothing for a held game (#6); a malformed answer is never a success (#7);
// a repeated bind is the same binding (#9); the deal re-checks the variants (#10); an endpoint on another chain is never
// used (#11); an expiry is proven only at a stated height (#13); one intent's refused query never stalls the others
// (#14); frozen rosters are known before any chain read (#8).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ALICE, BOB, quietConsole } from "../rooms/testSupport";
import { isLiveAttempt, junoInstanceOf, newChainIntent, type ChainIntentRecord, type createMemoryChainIntentStore } from "./chainIntents";
import type { MemoryFinancialGameStore } from "./financialGameStore";
import type { FinancialGameRecord } from "./moneyLifecycle";
import type { createMemorySigningJournal } from "./signingJournal";
import { parseJunoBackendConfig, verifyJunoDeployment } from "./juno/junoConfig";
import { openJunoBackend } from "./juno/junoBackend";
import { RELAYER_EXECUTE } from "./juno/junoContract";
import { createJunoRest, JunoRpcError, type HttpTransport } from "./juno/junoRest";
import { publicKeyOf } from "./juno/secp256k1";
import {
  ADMISSION_PUBKEY,
  ADMISSION_SECRET,
  CANONICAL_CHECKSUM,
  CHAIN_ID,
  CONTRACT,
  GAME_A,
  GAME_B,
  RELAYER_ADDRESS,
  RELAYER_SECRET,
  SETTLEMENT_SECRET,
  VARIANTS,
  WALLETS,
  fundedGame,
  makeWorld,
  play,
  startedGame,
  toStockRound,
  type World,
} from "./escrow3bSupport";

quietConsole();

const fin = (world: World, gameId: string = GAME_A) => world.financial.load(gameId) as Promise<FinancialGameRecord>;
const intentsOf = (world: World, gameId: string = GAME_A) => world.intents.listGame(gameId);
const liveCount = async (world: World) => {
  let n = 0;
  for (const gameId of await world.intents.games()) n += (await intentsOf(world, gameId)).flatMap((intent) => intent.attempts).filter(isLiveAttempt).length;
  return n;
};

async function startIntent(world: World, gameId: string = GAME_A): Promise<void> {
  assert.ok((await world.service.createMoneyGame(gameId)).ok);
  const chainGameId = await fundedGame(world, gameId);
  assert.ok((await world.service.bindChainGame(gameId, chainGameId, VARIANTS)).ok);
  assert.ok((await world.service.requestStart(gameId, [{ player_id: ALICE }, { player_id: BOB }])).ok);
}

async function dealt(world: World) {
  await startedGame(world, GAME_A);
  const session = play(world, GAME_A, 0);
  await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed !== null);
  return session;
}

function devConfig(dir: string) {
  fs.writeFileSync(path.join(dir, "relayer.key"), RELAYER_SECRET.toString("hex"));
  fs.writeFileSync(path.join(dir, "settlement.key"), SETTLEMENT_SECRET.toString("hex"));
  fs.writeFileSync(path.join(dir, "admission.key"), ADMISSION_SECRET.toString("hex"));
  const parsed = parseJunoBackendConfig(
    {
      format: "18COSMOS/JUNO-BACKEND/v2",
      chain_id: CHAIN_ID,
      network_class: "testnet",
      rest_endpoints: ["https://rest.example"],
      contract_address: CONTRACT,
      code_checksum: CANONICAL_CHECKSUM,
      wasm_admin: null,
      denom: "ujunox",
      asset_symbol: "JUNOX",
      relayer: { address: RELAYER_ADDRESS, signer: { kind: "development", key_file: path.join(dir, "relayer.key") } },
      settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "development", key_file: path.join(dir, "settlement.key") } },
      admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "development", key_file: path.join(dir, "admission.key") } },
      trust: { operators: [RELAYER_ADDRESS], resolvers: [RELAYER_ADDRESS], min_challenge_window_secs: "60", min_liveness_window_secs: "60", min_resolver_timeout_secs: "60" },
      journal_dir: path.join(dir, "journal"),
      dev_signer: "allow-unprotected-testnet-key",
    },
    { serverMode: "development", dataDir: path.join(dir, "data") },
  );
  return { ...parsed, trust: { ...parsed.trust, resolvers: ["juno1resolver"] } };
}

describe("ESCROW-3B review findings", () => {
  test("#1 a store restored to a SHORTER history is held at load, before anything is signed over it", async () => {
    const world = makeWorld();
    const session = await dealt(world);
    toStockRound(world, GAME_A, session);
    await world.drive(async () => BigInt((await fin(world)).chain.checkpoint_confirmed?.seq ?? "0") > BigInt(2));
    const signedAt = (await fin(world)).chain.checkpoint_confirmed!.log_len;
    assert.ok(signedAt > 1);
    world.logs.set(GAME_A, world.logs.get(GAME_A)!.slice(0, 1)); // the log store restored to just after the deal
    await world.restart();
    await world.service.idle();
    const record = await fin(world);
    assert.equal(record.phase, "held");
    assert.equal(record.hold?.code, "journal-ahead");
  });

  test("#1 a REWRITTEN history of the same length is held: the log must reproduce the journal's signed checkpoint", async () => {
    const world = makeWorld();
    await dealt(world);
    const entries = world.logs.get(GAME_A)!;
    world.logs.set(GAME_A, entries.map((entry, i) => (i === 0 ? { ...entry, at: (entry.at ?? 0) + 1 } : entry)));
    await world.restart();
    await world.service.idle();
    assert.equal((await fin(world)).hold?.code, "journal-ahead");
    assert.match((await fin(world)).hold?.detail ?? "", /does not reproduce/);
  });

  test("#2 + #8: frozen rosters are known before any chain read; a load that fails is retried -- never 'active but blind'", async () => {
    const world = makeWorld();
    await startIntent(world);
    await world.relayer.pass(); // the Start is live in a mempool
    world.relayer.stop();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow3b-backend-"));
    let lists = 0;
    const flaky: MemoryFinancialGameStore = Object.assign(Object.create(null), world.financial as MemoryFinancialGameStore, {
      list: async () => {
        lists += 1;
        if (lists === 2) throw Object.assign(new Error("EIO: the disk hiccuped"), { code: "EIO" });
        return (world.financial as MemoryFinancialGameStore).list();
      },
    });
    const warnings: string[] = [];
    world.chain.unavailable = true;
    const backend = await openJunoBackend({
      config: devConfig(dir),
      serverMode: "development",
      financial: flaky,
      intents: world.intents,
      journal: world.journal,
      tickets: world.ledger,
      readLog: async (gameId) => world.logs.get(gameId) ?? [],
      replay: world.replay,
      now: () => world.clock.now,
      warn: (line) => warnings.push(line),
      log: () => undefined,
      rest: world.chain,
      verifyEveryMs: 15,
    });
    try {
      assert.equal(backend.service.isRosterFrozen(GAME_A), true, "#8: preloaded from the store, the chain unreachable");
      assert.equal(await backend.start(), "unverified");
      world.chain.unavailable = false;
      for (let n = 0; n < 200 && lists < 2; n += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(lists >= 2, true, "the load ran and failed");
      assert.notEqual(backend.state(), "active", "a failed load leaves financial mode off");
      for (let n = 0; n < 200 && backend.state() !== "active"; n += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(backend.state(), "active", "the next verification retried the load");
      assert.ok(backend.relayer.status().open >= 1, "the relayer knows the live Start");
      assert.ok(warnings.some((line) => /could not be loaded/.test(line)));
    } finally {
      backend.stop();
    }
  });

  test("#3 an UNREADABLE intent blocks all signing (it may hold the live attempt) until it reads again", async () => {
    const world = makeWorld();
    await startIntent(world, GAME_A);
    await startIntent(world, GAME_B);
    const store = world.intents as ReturnType<typeof createMemoryChainIntentStore>;
    const [bStart] = await intentsOf(world, GAME_B);
    const key = `${GAME_B}/${bStart.intent_id}`;
    const saved = store.records.get(key)!;
    store.records.set(key, "unreadable");
    await world.relayer.pass();
    assert.equal((await intentsOf(world, GAME_A))[0].attempts.length, 0, "nothing signed for ANY game");
    assert.equal(world.chain.broadcasts.length, 0);
    assert.match(world.relayer.status().last_error ?? "", /unreadable/);
    store.records.set(key, saved);
    await world.drive(async () => (await fin(world, GAME_A)).chain.started !== null && (await fin(world, GAME_B)).chain.started !== null);
  });

  test("#3 an UNCERTAIN attempt write ends the pass: never a second live attempt at the same sequence", async () => {
    const world = makeWorld();
    await startIntent(world, GAME_A);
    await startIntent(world, GAME_B);
    (world.intents as ReturnType<typeof createMemoryChainIntentStore>).failNext.push("uncertain");
    await world.relayer.pass();
    assert.equal(await liveCount(world), 1, "the uncertain write landed one attempt; nothing else was signed");
    assert.equal(world.chain.broadcasts.length, 0, "and nothing was broadcast on an unknown write");
    let max = 0;
    await world.drive(async () => {
      max = Math.max(max, await liveCount(world));
      return (await fin(world, GAME_A)).chain.started !== null && (await fin(world, GAME_B)).chain.started !== null;
    });
    assert.ok(max <= 1);
  });

  test("#4 the journal is written BEFORE the store: a journal refusal stores and broadcasts nothing; every stored attempt is journalled", async () => {
    const world = makeWorld();
    await startIntent(world);
    (world.journal as ReturnType<typeof createMemorySigningJournal>).failNext.push("the journal disk is full");
    await world.relayer.pass();
    assert.equal((await intentsOf(world))[0].attempts.length, 0);
    assert.equal(world.chain.broadcasts.length, 0);
    await world.relayer.pass();
    await world.drive(async () => (await fin(world)).chain.started !== null);
    for (const intent of await intentsOf(world)) {
      for (const attempt of intent.attempts) assert.ok(world.journal.attemptsOf(intent.intent_id).some((entry) => entry.tx_id === attempt.tx_hash), "journalled");
    }
  });

  test("#5 an intent made for ANOTHER deployment is held by the relayer, never submitted or confirmed here", async () => {
    const world = makeWorld();
    await startIntent(world);
    const foreign = newChainIntent({
      game_id: GAME_A,
      instance: junoInstanceOf(CHAIN_ID, WALLETS[2], "1"),
      key: { op: "finalize", seq: "3" },
      subject: { kind: "digest", digests: [{ codec: "18JUNO/v1", purpose: "settle", hex: "66".repeat(32) }] },
      op: { kind: "finalize", chain_game_id: "1", seq: "3" },
      msg_json: RELAYER_EXECUTE.finalize("1"),
      now: world.clock.now - 10,
    });
    assert.equal((await world.intents.create(foreign)).kind, "created");
    world.relayer.poke(GAME_A, foreign.intent_id);
    await world.drive(async () => (await fin(world)).chain.started !== null);
    const held = (await world.intents.load(GAME_A, foreign.intent_id)) as ChainIntentRecord;
    assert.equal(held.status, "held");
    assert.equal(held.hold?.code, "binding-mismatch");
    assert.equal(held.attempts.length, 0);
  });

  test("#6 a settlement this server did not sign is never finalized automatically; the game is held", async () => {
    const world = makeWorld();
    await dealt(world);
    const game = world.chain.games.get(1)!;
    const ours = [...game.checkpoints.values()][0].payload;
    game.state = "settleable";
    game.settlement = { source: "terminal_payload", payload: { ...ours, seq: "999", kind: 1, payload_digest: "66".repeat(32) }, accepted_at: world.chain.time, window_end: world.chain.time };
    await world.service.sweepChain();
    await world.service.idle();
    assert.equal((await fin(world)).phase, "held");
    assert.equal((await fin(world)).hold?.code, "chain-inconsistent");
    world.chain.time += 3600;
    await world.relayer.pass();
    assert.equal((await intentsOf(world)).some((intent) => intent.op.kind === "finalize"), false, "no finalize intent");
    assert.equal(game.state, "settleable", "nothing finalized it");
  });

  test("#6 a held game submits nothing new (its pending intents wait for the operator)", async () => {
    const world = makeWorld();
    await startIntent(world);
    const record = await fin(world);
    await world.financial.put({ ...record, phase: "held", hold: { code: "evidence-mismatch", detail: "test", at: 1, from: "funding" }, record_version: record.record_version + 1 }, record.record_version);
    await world.relayer.pass();
    await world.relayer.pass();
    const [start] = await intentsOf(world);
    assert.equal(start.attempts.length, 0);
    assert.equal(start.status, "pending");
    assert.equal(world.chain.broadcasts.length, 0);
  });

  test("#7 + #11 the REST client: no default success, and an endpoint on another chain is never used (nor its URL path shown)", async () => {
    const H = "A".repeat(64);
    const routes: Record<string, Record<string, { status: number; text: string }>> = { "a.example": {}, "b.example": {} };
    const http: HttpTransport = async (request) => {
      const url = new URL(request.url);
      const table = routes[url.hostname];
      const found = Object.entries(table).find(([suffix]) => url.pathname.endsWith(suffix));
      if (found === undefined) throw new JunoRpcError("unavailable", "no route");
      return found[1];
    };
    const limits = { expectedChainId: CHAIN_ID, allowInsecureLocalHttp: false, timeoutMs: 1000, maxResponseBytes: 10_000, maxCodeBytes: 10_000 };
    routes["a.example"]["/node_info"] = { status: 200, text: JSON.stringify({ default_node_info: { network: CHAIN_ID } }) };
    const rest = createJunoRest({ endpoints: ["https://a.example"], ...limits }, http);
    routes["a.example"][`/txs/${H}`] = { status: 200, text: JSON.stringify({ tx_response: { txhash: H } }) };
    await assert.rejects(() => rest.tx(H), (error: unknown) => error instanceof JunoRpcError && error.kind === "malformed");
    routes["a.example"][`/txs/${H}`] = { status: 200, text: JSON.stringify({ tx_response: { txhash: H, code: 0, height: "0" } }) };
    await assert.rejects(() => rest.tx(H), (error: unknown) => error instanceof JunoRpcError && error.kind === "malformed", "an included tx at height 0 is malformed");
    routes["a.example"][`/txs/${H}`] = { status: 200, text: JSON.stringify({ tx_response: { txhash: H, code: 0, height: "12" } }) };
    assert.equal((await rest.tx(H))?.height, "12");
    routes["a.example"]["/cosmos/tx/v1beta1/txs"] = { status: 200, text: JSON.stringify({ tx_response: { txhash: H } }) };
    await assert.rejects(() => rest.broadcast(Buffer.from("00", "hex")), (error: unknown) => error instanceof JunoRpcError && error.kind === "malformed", "a broadcast answer without a code");

    /* Two endpoints: the first down, the second on ANOTHER chain (a provider key in its path). */
    routes["a.example"] = {};
    routes["b.example"]["/node_info"] = { status: 200, text: JSON.stringify({ default_node_info: { network: "juno-1" } }) };
    routes["b.example"][`/accounts/${RELAYER_ADDRESS}`] = { status: 200, text: JSON.stringify({ account: { address: RELAYER_ADDRESS, account_number: "1", sequence: "9" } }) };
    const two = createJunoRest({ endpoints: ["https://a.example", "https://b.example/SECRET-API-KEY"], ...limits }, http);
    await assert.rejects(() => two.account(RELAYER_ADDRESS), (error: unknown) => error instanceof JunoRpcError && (error.kind === "wrong-chain" || error.kind === "unavailable"));
    const chains = await two.endpointChains();
    assert.deepEqual(chains.map((entry) => [entry.endpoint, entry.chain_id]), [["https://a.example", null], ["https://b.example/…", "juno-1"]]);
    assert.equal(JSON.stringify(chains).includes("SECRET"), false);
    const verdict = await verifyJunoDeployment(devConfig(fs.mkdtempSync(path.join(os.tmpdir(), "escrow3b-cfg-"))), two);
    assert.equal(verdict.kind, "mismatch");
    assert.match((verdict as unknown as { problems: string[] }).problems.join(" "), /is on juno-1/);
  });

  test("#9 a repeated bind of the same chain game is the same binding; #10 the deal refuses variants the escrow did not commit to", async () => {
    const world = makeWorld();
    assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
    const chainGameId = await fundedGame(world, GAME_A);
    const first = await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS);
    world.clock.now += 1_000;
    const second = await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS);
    assert.ok(first.ok && second.ok);
    assert.deepEqual(second.binding, first.binding);
    assert.equal((await fin(world)).phase, "funding", "not held");
    assert.ok((await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }])).ok);
    await world.drive(async () => (await fin(world)).chain.started !== null);
    const ctx = { shuffle: <T>(items: readonly T[]) => [...items], now: 1 };
    const seats = [{ player_id: ALICE }, { player_id: BOB }];
    assert.ok(!("refusal" in (await world.service.rosterSource.plan({ game_id: GAME_A, seats, variants: VARIANTS } as never, ctx))));
    const other = await world.service.rosterSource.plan({ game_id: GAME_A, seats, variants: { ...VARIANTS, extra_variant: true } } as never, ctx);
    assert.equal("refusal" in other && other.reason, "The table's variants are not the ones the escrow committed to.");
  });

  test("#13 an expiry is proven only by an account read AT a stated height above the timeout", async () => {
    const world = makeWorld({ timeoutBlocks: 3 });
    await startIntent(world);
    await world.relayer.pass();
    world.chain.mempool.length = 0;
    world.chain.heightsHidden = true;
    for (let n = 0; n < 6; n += 1) world.chain.produceBlock();
    await world.relayer.pass();
    await world.relayer.pass();
    const [unproven] = (await intentsOf(world))[0].attempts;
    assert.ok(isLiveAttempt(unproven), "a node that does not say its height proves nothing");
    assert.ok(unproven.unknown_observations >= 2);
    assert.match(world.relayer.status().last_error ?? "", /cannot be proven dead/);
    world.chain.heightsHidden = false;
    await world.relayer.pass();
    assert.equal((await intentsOf(world))[0].attempts[0].death?.kind, "expiry-passed");
  });

  test("#14 one intent's refused query backs that intent off; the others proceed on the next pass", async () => {
    const world = makeWorld();
    await startIntent(world);
    const ghost = newChainIntent({
      game_id: GAME_B,
      instance: junoInstanceOf(CHAIN_ID, CONTRACT, "99"),
      key: { op: "finalize", seq: "3" },
      subject: { kind: "digest", digests: [{ codec: "18JUNO/v1", purpose: "settle", hex: "77".repeat(32) }] },
      op: { kind: "finalize", chain_game_id: "99", seq: "3" },
      msg_json: RELAYER_EXECUTE.finalize("99"),
      now: world.clock.now - 10,
    });
    assert.equal((await world.intents.create(ghost)).kind, "created");
    world.relayer.poke(GAME_B, ghost.intent_id);
    await world.drive(async () => (await fin(world)).chain.started !== null, 10);
    const after = (await world.intents.load(GAME_B, ghost.intent_id)) as ChainIntentRecord;
    assert.equal(after.attempts.length, 0);
    assert.ok(after.retry.failures >= 1, "counted against its own budget");
  });
});
