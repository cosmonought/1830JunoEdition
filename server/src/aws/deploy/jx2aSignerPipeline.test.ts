// server/src/aws/deploy/jx2aSignerPipeline.test.ts
//
// ==================================================================
//  JX-2A: THE RELAYER'S KMS -> JUNO PIPELINE, LOCALLY -- THE REAL AWS SDK KMS BINDING, THE REAL RELAYER, AN OFFLINE CHAIN
// ==================================================================
//
// Phase 5 preparation (JX-2A). Here, under aws/deploy/, because it binds the KMS digest client and the deploy tools'
// planning cap (the L5-1 import convention: only the runtime and the deploy tools reach aws/kms). No AWS, no network beyond 127.0.0.1, no broadcast to any real chain. What it pins, in
// the relayer exactly as production builds it (`createJunoRelayer`) but signing through the PRODUCTION KMS binding
// (`createKmsClient` -> `kmsDigestClient` -> `openKmsDigestSigner`) against a loopback stand-in that speaks the AWS KMS
// JSON protocol and signs with a disposable test key:
//
//   1. a money game's every relayer transaction (Start, the checkpoints, Settle, Finalize) is a KMS DIGEST Sign of
//      exactly SHA-256(SignDoc) the chain re-derives; the TxRaw carries decideGas's fee, the policy denom, decideGas's gas
//      limit, the chain's account number and the chain's sequence, and its signature is low-s even when KMS answers high-s;
//      the journal binds intent -> attempt -> tx hash -> sequence -> expiry before anything is broadcast; KMS is asked once
//      per attempt and never otherwise;
//   2. the sequence is the chain's at signing time (a foreign transaction between two intents moves it; nothing is cached);
//   3. a CheckTx rejection (the node's minimum gas price above the policy's) never advances the sequence, rebroadcasts the
//      SAME bytes until the attempt's expiry is proven, spends the failure budget one attempt per expiry window, and HOLDS
//      at the budget -- never a second live attempt, never a re-sign before the proof (JX-2A finding O-1 documents this);
//   4. DeliverTx failures spend the budget and hold at it; each landed failure consumed one sequence and paid one fee;
//   5. gas: the max_gas boundary signs at exactly the per-transaction cap (L6-12D `perTransactionFeeCap`); one unit over
//      holds with no KMS Sign at all.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import type { AddressInfo } from "net";

import { ALICE, BOB, BUILD, PASS, quietConsole } from "../../rooms/testSupport";
import { sealOf } from "../../rooms/lifecycle";
import type { GameStateResponse } from "../../../../frontend/src/gameEngine/gameState";
import { createSettlementCoordinator } from "../../escrow/settlementCoordinator";
import { serverPrefixReplay, type PrefixReplay } from "../../escrow/settlementEvidence";
import { isLiveAttempt, type ChainAttempt, type ChainIntentRecord } from "../../escrow/chainIntents";
import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";
import { createKmsClient, LOCAL_TEST_REGION } from "../awsClients";
import { kmsDigestClient } from "../kms/kmsDigestClient";
import { openKmsDigestSigner, type DigestSigner } from "../../escrow/juno/signer";
import { bigIntTo32, bytesToBigInt, decompressPublicKey, isLowS, publicKeyOf, SECP256K1_N, signDigest, verifyDigest } from "../../escrow/juno/secp256k1";
import { decodeRelayerTx } from "../../escrow/juno/fakeJunoChain";
import { encodeSignDoc, signDocDigest } from "../../escrow/juno/cosmosTx";
import { ceilDiv, decideGas, DEFAULT_GAS_POLICY, type GasPolicy } from "../../escrow/juno/gasPolicy";
import { perTransactionFeeCap, gasDerivedMaxFee } from "./junoChain";
import { CHAIN_ID, GAME_A, RELAYER_ADDRESS, RELAYER_SECRET, fundedGame, makeWorld, move, passRound, play, startedGame, toStockRound, VARIANTS, type World } from "../../escrow/escrow3bSupport";

quietConsole();

/* ------------------------------------------------------------------ */
/* A loopback KMS that speaks the AWS JSON protocol (the real SDK talks to it) */
/* ------------------------------------------------------------------ */

const KEY_ARN = `arn:aws:kms:${LOCAL_TEST_REGION}:000000000000:key/0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a`;
const SPKI_PREFIX = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");
const HALF_N = SECP256K1_N / BigInt(2);

function spkiOf(secret: Buffer): Buffer {
  const { x, y } = decompressPublicKey(publicKeyOf(secret));
  return Buffer.concat([SPKI_PREFIX, Buffer.from([0x04]), bigIntTo32(x), bigIntTo32(y)]);
}

function derInteger(value: Buffer): Buffer {
  let body = value;
  while (body.length > 1 && body[0] === 0 && !(body[1] & 0x80)) body = body.subarray(1);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}

class LoopbackKms {
  /** Every Sign request: the exact 32 bytes asked, and the DER answered. */
  readonly signs: { readonly message: Buffer; readonly highS: boolean; readonly messageType: unknown; readonly algorithm: unknown }[] = [];
  readonly targets: string[] = [];
  private server!: http.Server;
  endpoint = "";
  constructor(private readonly secret: Buffer) {}

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => this.answer(String(request.headers["x-amz-target"] ?? ""), Buffer.concat(chunks).toString("utf8"), response));
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
  }

  private answer(target: string, text: string, response: http.ServerResponse): void {
    this.targets.push(target);
    const body = JSON.parse(text || "{}") as Record<string, unknown>;
    const send = (status: number, payload: Record<string, unknown>) => {
      response.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
      response.end(JSON.stringify(payload));
    };
    if (body.KeyId !== KEY_ARN) return send(400, { __type: "NotFoundException", message: "no such key" });
    if (target === "TrentService.GetPublicKey") {
      return send(200, { KeyId: KEY_ARN, PublicKey: spkiOf(this.secret).toString("base64"), KeySpec: "ECC_SECG_P256K1", KeyUsage: "SIGN_VERIFY", SigningAlgorithms: ["ECDSA_SHA_256"] });
    }
    if (target !== "TrentService.Sign") return send(400, { __type: "UnsupportedOperationException", message: target });
    if (body.MessageType !== "DIGEST" || body.SigningAlgorithm !== "ECDSA_SHA_256") return send(400, { __type: "ValidationException", message: "the key policy allows only ECDSA_SHA_256 over a DIGEST" });
    const message = Buffer.from(String(body.Message), "base64");
    if (message.length !== 32) return send(400, { __type: "ValidationException", message: "a digest is 32 bytes" });
    /* KMS is not deterministic and answers either s: every other answer is the high-s twin. */
    const compact = signDigest(this.secret, message);
    const highS = this.signs.length % 2 === 0;
    const s = highS ? bigIntTo32(SECP256K1_N - bytesToBigInt(compact.subarray(32))) : compact.subarray(32);
    const seq = Buffer.concat([derInteger(compact.subarray(0, 32)), derInteger(s)]);
    this.signs.push({ message, highS, messageType: body.MessageType, algorithm: body.SigningAlgorithm });
    return send(200, { KeyId: KEY_ARN, Signature: Buffer.concat([Buffer.from([0x30, seq.length]), seq]).toString("base64"), SigningAlgorithm: "ECDSA_SHA_256" });
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const endedReplay =
  (): PrefixReplay =>
  (prefix) => {
    const real = serverPrefixReplay(BUILD)(prefix);
    if (!real.ok) return real;
    return { ok: true, board: { ...real.board, current_round_type: "GameEnd", bank_broken: true } as GameStateResponse };
  };

const intentsOf = (world: World, gameId: string = GAME_A) => world.intents.listGame(gameId);
const fin = (world: World, gameId: string = GAME_A) => world.financial.load(gameId) as Promise<FinancialGameRecord>;
const POLICY: GasPolicy = { ...DEFAULT_GAS_POLICY, feeDenom: "ujunox" };

async function seal(world: World, gameId: string): Promise<void> {
  const entries = world.logs.get(gameId) ?? [];
  const coordinator = createSettlementCoordinator({
    store: world.financial,
    replay: world.replay,
    isFinancial: () => true,
    serving: world.service.serving,
    now: () => world.clock.now,
    warn: (line) => world.warnings.push(line),
    schedule: () => ({ cancel: () => undefined }),
    onIntentPrepared: (id) => world.service.onIntentPrepared(id),
  });
  coordinator.onGameplayClosed({ gameId, record: { game_id: gameId, money: null, started_at: world.clock.now } as never, seal: sealOf(entries, true)!, recovered: false, entries });
  await coordinator.drain();
}

async function startIntent(world: World, gameId: string = GAME_A): Promise<ChainIntentRecord> {
  assert.ok((await world.service.createMoneyGame(gameId)).ok);
  const chainGameId = await fundedGame(world, gameId);
  assert.ok((await world.service.bindChainGame(gameId, chainGameId, VARIANTS)).ok);
  assert.ok((await world.service.requestStart(gameId, [{ player_id: ALICE }, { player_id: BOB }])).ok);
  return (await intentsOf(world, gameId)).find((intent) => intent.op.kind === "start")!;
}

/** What the chain re-derives and checks for one stored attempt -- every field read back from the broadcast bytes. */
function checkAttemptBytes(world: World, attempt: ChainAttempt, signer: DigestSigner, expect: { readonly gas_used: string }): Buffer {
  const tx = decodeRelayerTx(Buffer.from(attempt.tx_bytes, "base64"));
  const account = world.chain.accounts.get(RELAYER_ADDRESS)!;
  assert.equal(tx.hash, attempt.tx_hash, "the stored hash is SHA-256 of the stored bytes");
  assert.equal(tx.sender, RELAYER_ADDRESS);
  assert.equal(tx.publicKey.toString("hex"), signer.publicKey.toString("hex"), "the AuthInfo carries the KMS key");
  assert.equal(tx.sequence.toString(), attempt.sequence);
  assert.equal(attempt.account_number, account.number.toString(), "the chain's account number");
  assert.equal(tx.timeoutHeight.toString(), attempt.timeout_height);
  const decision = decideGas(expect.gas_used, POLICY);
  assert.ok(decision.ok);
  assert.equal(tx.gasLimit, decision.gasLimit, "gas_limit = decideGas(simulated)");
  assert.equal(tx.fee, decision.fee, "fee = decideGas(simulated)");
  assert.equal(tx.feeDenom, "ujunox", "the fee denom is the policy's (the escrow's) denom");
  assert.equal(attempt.gas_limit, decision.gasLimit.toString());
  assert.deepEqual(attempt.fee, { denom: "ujunox", amount: decision.fee.toString() });
  assert.ok(tx.fee <= perTransactionFeeCap(POLICY));
  assert.equal(tx.signature.length, 64);
  assert.ok(isLowS(tx.signature), "low-s in the TxRaw, whatever KMS answered");
  const digest = signDocDigest(encodeSignDoc({ bodyBytes: tx.bodyBytes, authInfoBytes: tx.authInfoBytes, chainId: CHAIN_ID, accountNumber: account.number }));
  assert.ok(verifyDigest(signer.publicKey, digest, tx.signature), "verifies over the SignDoc the CHAIN re-derives");
  assert.ok(verifyDigest(publicKeyOf(RELAYER_SECRET), digest, tx.signature));
  return digest;
}

/* ================================================================================================= */

describe("JX-2A: the relayer through the production KMS binding (loopback KMS, offline chain)", () => {
  const kms = new LoopbackKms(RELAYER_SECRET);
  let signer: DigestSigner;
  before(async () => {
    await kms.start();
    signer = await openKmsDigestSigner(kmsDigestClient(createKmsClient({ kind: "kms-local", endpoint: kms.endpoint }), { region: LOCAL_TEST_REGION }), KEY_ARN);
  });
  after(async () => {
    await kms.stop();
  });

  test("a whole money game: every relayer transaction is one KMS DIGEST Sign of the chain's SignDoc hash, with decideGas's fee, the chain's sequence, low-s, journalled first", async () => {
    assert.equal(signer.kind, "kms");
    assert.equal(signer.publicKey.toString("hex"), publicKeyOf(RELAYER_SECRET).toString("hex"), "GetPublicKey -> SPKI -> the configured relayer key");
    const signsBefore = kms.signs.length;
    const world = makeWorld({ replay: endedReplay(), wrapRelayerKey: () => signer });
    await startedGame(world);
    const session = play(world, GAME_A, 0);
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed !== null);
    toStockRound(world, GAME_A, session);
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed?.log_len === session.entries.length);
    passRound(world, GAME_A, session);
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed?.log_len === session.entries.length);
    move(world, GAME_A, session, ALICE, PASS);
    await world.service.idle();
    await seal(world, GAME_A);
    await world.drive(async () => (await fin(world)).phase === "settleable");
    await world.drive(async () => (await fin(world)).phase === "closed", 60);

    const intents = await intentsOf(world);
    const kinds = new Set(intents.filter((intent) => intent.status === "confirmed").map((intent) => intent.op.kind));
    for (const kind of ["start", "checkpoint", "settle", "finalize"]) assert.ok(kinds.has(kind as never), `a confirmed ${kind}`);
    const attempts = intents.flatMap((intent) => intent.attempts.map((attempt) => ({ intent, attempt })));
    assert.ok(attempts.length >= 6);
    assert.ok(attempts.every(({ attempt }) => !isLiveAttempt(attempt)));

    /* KMS: one Sign per attempt, never otherwise; each asked exactly the digest the chain re-derives; DIGEST/ECDSA_SHA_256. */
    const signs = kms.signs.slice(signsBefore);
    assert.equal(signs.length, attempts.length, "one KMS Sign per attempt");
    assert.ok(signs.some((sign) => sign.highS) && signs.some((sign) => !sign.highS), "both KMS answer shapes were normalised/kept");
    const asked = new Set(signs.map((sign) => sign.message.toString("hex")));
    for (const sign of signs) {
      assert.equal(sign.messageType, "DIGEST");
      assert.equal(sign.algorithm, "ECDSA_SHA_256");
    }
    const sequences: number[] = [];
    for (const { intent, attempt } of attempts) {
      const digest = checkAttemptBytes(world, attempt, signer, { gas_used: "180000" });
      assert.ok(asked.has(digest.toString("hex")), `KMS was asked the SignDoc digest of ${intent.op.kind}`);
      /* The journal binds intent -> attempt -> tx hash -> sequence -> expiry. */
      const journalled = (await world.journal.attemptsOf(intent.intent_id)).find((entry) => entry.tx_id === attempt.tx_hash);
      assert.ok(journalled !== undefined, "journalled");
      assert.equal(journalled.account, RELAYER_ADDRESS);
      assert.equal(journalled.sequence, attempt.sequence);
      assert.equal(journalled.expires_after_height, attempt.timeout_height);
      assert.equal(world.chain.txIndex.get(attempt.tx_hash)?.code, 0);
      sequences.push(Number(attempt.sequence));
    }
    sequences.sort((a, b) => a - b);
    assert.deepEqual(sequences, sequences.map((_, i) => i), "sequences 0..n-1, each once");
    /* The chain recorded the KMS key as the account's key (the first transaction sets it). */
    assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.pubKey, signer.publicKey.toString("hex"));
    /* The fees paid are exactly the sum of the encoded fees. */
    const paid = attempts.reduce((sum, { attempt }) => sum + BigInt(attempt.fee.amount), BigInt(0));
    assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.balance, BigInt(10_000_000) - paid);
  });

  test("the sequence is the chain's at signing time: transactions sent elsewhere with the key between two intents move it (nothing cached)", async () => {
    const world = makeWorld({ replay: endedReplay(), wrapRelayerKey: () => signer });
    await startedGame(world);
    assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.sequence, BigInt(1));
    for (let n = 0; n < 3; n += 1) world.chain.consumeSequenceExternally(RELAYER_ADDRESS); // an operator's own tooling
    play(world, GAME_A, 0);
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed !== null);
    const checkpoint = (await intentsOf(world)).find((intent) => intent.op.kind === "checkpoint")!;
    assert.equal(checkpoint.attempts.length, 1, "no failed attempt at a stale sequence");
    assert.equal(checkpoint.attempts[0].sequence, "4", "signed at the chain's sequence (1 + 3 foreign)");
  });

  test("a CheckTx rejection (node min gas price above the policy): the SAME bytes until expiry is proven, one attempt per window at the SAME sequence, no fee; CURRENT bound = the 32-attempt cap (JX-2A D-1: the failure budget is not applied to expiry deaths)", async () => {
    const world = makeWorld({ wrapRelayerKey: () => signer, timeoutBlocks: 2, relayerTuning: { failureBudget: 2 } });
    /* The node demands 0.1 ujunox/gas; the policy pays 0.075. */
    (world.chain.options as { minGasPriceNum?: bigint }).minGasPriceNum = BigInt(100);
    const signsBefore = kms.signs.length;
    await startIntent(world);
    await world.relayer.pass();
    let start = (await intentsOf(world)).find((intent) => intent.op.kind === "start")!;
    assert.equal(start.attempts.length, 1);
    assert.equal(start.attempts[0].phase, "signed", "a CheckTx refusal is not 'broadcast'");
    assert.equal(start.attempts[0].broadcast?.code, 13);
    const firstHash = start.attempts[0].tx_hash;
    /* Before the expiry: rebroadcast of the same bytes only. */
    world.chain.produceBlock();
    world.clock.now += 1_000;
    await world.relayer.pass();
    start = (await intentsOf(world)).find((intent) => intent.op.kind === "start")!;
    assert.equal(start.attempts.length, 1, "never re-signed before the expiry is proven");
    assert.ok(start.attempts[0].broadcasts >= 2);
    assert.ok(world.chain.broadcasts.every((hash) => hash === firstHash));
    assert.equal(kms.signs.length - signsBefore, 1);
    /* Past the expiry with the sequence unchanged: dead (counted), then the next attempt at the SAME sequence ... */
    await world.drive(async () => ["held", "superseded"].includes((await intentsOf(world)).find((intent) => intent.op.kind === "start")!.status), 400);
    start = (await intentsOf(world)).find((intent) => intent.op.kind === "start")!;
    /* ... and (D-1) the hold comes from the 32-attempt cap, not from the failure budget of 2: an expiry death is counted
       (retry.failures) but `observe` never compares the count with the budget, and `advance` signs again. The proposed
       follow-up (JX-2B-D1) changes these two expectations to `failureBudget` attempts / the budget's hold detail. */
    assert.ok(world.warnings.some((line) => /HELD start .*\(chain-intent-held\) -- the attempt budget is spent/.test(line)), "held by the 32-attempt cap");
    assert.ok(start.status === "held" || /released/.test(start.superseded?.why ?? ""), "then (reversible start) released by the service");
    assert.equal(start.attempts.length, 32);
    assert.ok(start.retry.failures > 2, "counted past the budget without a hold");
    assert.ok(start.attempts.every((attempt) => attempt.phase === "dead" && attempt.death?.kind === "expiry-passed"));
    assert.ok(start.attempts.every((attempt) => attempt.sequence === "0"), "the sequence never moved");
    assert.equal(new Set(start.attempts.map((attempt) => attempt.tx_hash)).size, 32, "each attempt is new bytes (a new expiry height)");
    assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.sequence, BigInt(0));
    assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.balance, BigInt(10_000_000), "no fee was ever charged");
    assert.equal(kms.signs.length - signsBefore, 32, "KMS signed exactly one transaction per attempt");
  });

  test("DeliverTx failures spend the budget and HOLD at it; each landed failure consumed one sequence and one fee; a held Start is then released by the service (reversible start)", async () => {
    const world = makeWorld({ wrapRelayerKey: () => signer, relayerTuning: { failureBudget: 2 } });
    await startIntent(world);
    const startOf = async () => (await intentsOf(world)).find((intent) => intent.op.kind === "start")!;
    for (let round = 0; round < 6 && (await startOf()).status !== "held"; round += 1) {
      world.chain.paused = false;
      await world.relayer.pass(); // observes the last failure, then simulates (not paused) and signs the next attempt
      if ((await startOf()).status === "held") break;
      world.chain.paused = true; // ... paused before inclusion: the contract refuses at DeliverTx
      world.chain.produceBlock();
      world.clock.now += 120_000;
    }
    const start = await startOf();
    assert.equal(start.status, "held");
    assert.match(start.hold?.detail ?? "", /2 consecutive attempts failed/);
    assert.equal(start.attempts.length, 2);
    assert.ok(start.attempts.every((attempt) => attempt.phase === "included-failure" && attempt.error?.code === "PAUSED"));
    assert.deepEqual(start.attempts.map((attempt) => attempt.sequence), ["0", "1"], "each landed failure consumed its sequence");
    const fees = start.attempts.reduce((sum, attempt) => sum + BigInt(attempt.fee.amount), BigInt(0));
    assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.balance, BigInt(10_000_000) - fees, "and paid its fee");
    /* Held: nothing more is signed for it. The service then proves no Start happened and releases the freeze. */
    const before = kms.signs.length;
    world.chain.paused = false;
    world.clock.now += 600_000;
    world.chain.produceBlock();
    await world.relayer.pass();
    await world.service.idle();
    assert.equal(kms.signs.length, before);
    const after = await startOf();
    assert.ok(after.status === "held" || (after.status === "superseded" && /released/.test(after.superseded?.why ?? "")), after.status);
  });

  test("gas: the max_gas boundary signs at exactly the per-transaction cap; one simulated unit over holds with NO KMS Sign", async () => {
    const at = makeWorld({ wrapRelayerKey: () => signer });
    at.chain.simulateGasOverride = "1153846";
    await startIntent(at);
    await at.drive(async () => (await fin(at)).chain.started !== null);
    const [attempt] = (await intentsOf(at)).find((intent) => intent.op.kind === "start")!.attempts;
    checkAttemptBytes(at, attempt, signer, { gas_used: "1153846" });
    assert.equal(attempt.gas_limit, "1500000");
    assert.equal(attempt.fee.amount, perTransactionFeeCap(POLICY).toString(), "112500 ujunox = the L6-12D per-transaction cap");

    const over = makeWorld({ wrapRelayerKey: () => signer });
    over.chain.simulateGasOverride = "1153847";
    const before = kms.signs.length;
    await startIntent(over);
    await over.relayer.pass();
    const start = (await intentsOf(over)).find((intent) => intent.op.kind === "start")!;
    assert.equal(start.status, "held");
    assert.match(start.hold?.detail ?? "", /gas refused/);
    assert.equal(start.attempts.length, 0);
    assert.equal(kms.signs.length, before, "fail closed BEFORE the key is asked");
  });
});

describe("JX-2A: decideGas and the L6-12D planning cap are one rounding", () => {
  test("perTransactionFeeCap = min(max_fee, ceil(max_gas x price)) and bounds every fee decideGas accepts, over a deterministic policy sweep", () => {
    let state = BigInt(0x2a);
    const next = (mod: bigint) => {
      state = (state * BigInt(6364136223846793005) + BigInt(1442695040888963407)) & ((BigInt(1) << BigInt(64)) - BigInt(1));
      return (state >> BigInt(11)) % mod;
    };
    for (let n = 0; n < 400; n += 1) {
      const maxGas = BigInt(100_000) + next(BigInt(9_900_000));
      const policy: GasPolicy = {
        multiplierNum: BigInt(10) + next(BigInt(20)),
        multiplierDen: BigInt(10),
        minGas: BigInt(1) + next(maxGas),
        maxGas,
        gasPriceNum: BigInt(1) + next(BigInt(1000)),
        gasPriceDen: BigInt(1) + next(BigInt(100_000)),
        maxFee: BigInt(1) + next(BigInt(2_000_000)),
        feeDenom: "ujunox",
      };
      const cap = perTransactionFeeCap(policy);
      assert.equal(gasDerivedMaxFee(policy), ceilDiv(policy.maxGas * policy.gasPriceNum, policy.gasPriceDen));
      assert.equal(cap, policy.maxFee < gasDerivedMaxFee(policy) ? policy.maxFee : gasDerivedMaxFee(policy));
      for (let k = 0; k < 8; k += 1) {
        const used = (BigInt(1) + next(policy.maxGas * BigInt(2))).toString();
        const decision = decideGas(used, policy);
        if (decision.ok) {
          assert.ok(decision.gasLimit <= policy.maxGas && decision.gasLimit >= policy.minGas);
          assert.ok(decision.fee <= cap, `fee ${decision.fee} <= cap ${cap}`);
          assert.equal(decision.fee, ceilDiv(decision.gasLimit * policy.gasPriceNum, policy.gasPriceDen));
        }
      }
    }
    /* The defaults: 112,500 ujunox, the planning reserve's unit (8.2125 JUNOX = 73 x this; policy only, not encoding). */
    assert.equal(perTransactionFeeCap(POLICY), BigInt(112_500));
  });
});
