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
//   3. a CheckTx rejection (the node's minimum gas price above the policy's) never advances the sequence and is signed
//      ONCE: the refused bytes are not re-sent, the account's submissions stop and page at once, its expiry death spends no
//      budget and nothing is re-signed or held (JX-2B; JX-2A's finding D-1 was 32 attempts, one per expiry window);
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
import { submissionRefusalOf } from "../../escrow/juno/relayer";
import { bigIntTo32, bytesToBigInt, decompressPublicKey, isLowS, publicKeyOf, SECP256K1_N, signDigest, verifyDigest } from "../../escrow/juno/secp256k1";
import { decodeRelayerTx } from "../../escrow/juno/fakeJunoChain";
import { encodeSignDoc, signDocDigest } from "../../escrow/juno/cosmosTx";
import { ceilDiv, decideGas, DEFAULT_GAS_POLICY, type GasPolicy } from "../../escrow/juno/gasPolicy";
import { perTransactionFeeCap, gasDerivedMaxFee } from "./junoChain";
import { CHAIN_ID, GAME_A, GAME_B, RELAYER_ADDRESS, RELAYER_SECRET, fundedGame, makeWorld, move, passRound, play, startedGame, toStockRound, VARIANTS, type World } from "../../escrow/escrow3bSupport";

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

  test("a CheckTx rejection (node min gas price above the policy): ONE signature, its bytes never re-sent, the account's submissions stopped and paged at once; its expiry death spends no budget, nothing is held, nothing re-signed, no fee (JX-2B; D-1 was 32 attempts)", async () => {
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
    /* Many expiry windows later (timeout 2 blocks): proven dead, but never re-sent, re-signed or held. */
    for (let round = 0; round < 40; round += 1) {
      world.chain.produceBlock();
      world.clock.now += 6_000;
      await world.relayer.pass();
      await world.service.idle();
    }
    start = (await intentsOf(world)).find((intent) => intent.op.kind === "start")!;
    assert.equal(start.status, "pending", "WAIT + PAGE, never a hold (F-L5-16)");
    assert.equal(start.attempts.length, 1, "no second attempt: nothing re-signed");
    assert.equal(start.attempts[0].phase, "dead");
    assert.equal(start.attempts[0].death?.kind, "expiry-passed");
    assert.equal(start.retry.failures, 0, "the account's condition spends no intent budget (F-L5-17)");
    assert.deepEqual(world.chain.broadcasts, [firstHash], "the refused bytes were handed to a node once");
    assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.sequence, BigInt(0));
    assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.balance, BigInt(10_000_000), "no fee was ever charged");
    assert.equal(kms.signs.length - signsBefore, 1, "KMS signed exactly once");
    const paging = world.relayer.status().paging;
    assert.equal(paging.paged, 1);
    assert.equal(paging.conditions[0].condition, "submission-refused");
    assert.match(paging.conditions[0].why, /^submissions refused \(insufficient-fee, sdk\/13\): raise the configured gas price.*then restart the relayer/);
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

describe("JX-2B: submission refusals -- deterministic ones wait and page without re-signing; unknown ones stay bounded (loopback KMS, offline chain)", () => {
  const kms = new LoopbackKms(RELAYER_SECRET);
  let signer: DigestSigner;
  before(async () => {
    await kms.start();
    signer = await openKmsDigestSigner(kmsDigestClient(createKmsClient({ kind: "kms-local", endpoint: kms.endpoint }), { region: LOCAL_TEST_REGION }), KEY_ARN);
  });
  after(async () => {
    await kms.stop();
  });

  const startOf = async (world: World, gameId: string = GAME_A) => (await intentsOf(world, gameId)).find((intent) => intent.op.kind === "start")!;
  const opsOf = (world: World, event: string) => world.ops.lines.filter((line) => line.event === event);
  /** Blocks, time and relayer passes: with `timeoutBlocks: 2` an attempt's expiry is proven within a few rounds. */
  async function rounds(world: World, n: number): Promise<void> {
    for (let round = 0; round < n; round += 1) {
      world.chain.produceBlock();
      world.clock.now += 6_000;
      await world.relayer.pass();
      await world.service.idle();
    }
  }
  const UNNAMED = Object.freeze({ code: 4, codespace: "sdk", raw_log: "signature verification failed; please verify account number (1) and chain-id (uni-7): unauthorized" });

  test("the classifier: only sdk/5 (insufficient funds) and sdk/13 (insufficient fee) are deterministic -- by code and codespace, never by text", () => {
    assert.equal(submissionRefusalOf({ code: 5, codespace: "sdk" }), "insufficient-funds");
    assert.equal(submissionRefusalOf({ code: 13, codespace: "sdk" }), "insufficient-fee");
    for (const code of [0, 4, 11, 19, 30, 32, 2, 18, -1]) assert.equal(submissionRefusalOf({ code, codespace: "sdk" }), null, `sdk/${code}`);
    for (const codespace of ["", "wasm", "globalfee", "feemarket", "transport", "SDK"]) {
      assert.equal(submissionRefusalOf({ code: 5, codespace }), null, `${codespace}/5`);
      assert.equal(submissionRefusalOf({ code: 13, codespace }), null, `${codespace}/13`);
    }
  });

  /* Tests 1-3 and 10 of the brief, for each deterministic refusal. */
  const deterministic = [
    {
      name: "insufficient funds (the relayer cannot pay the fee)",
      code: 5,
      kind: "insufficient-funds",
      action: /fund the relayer account/,
      cause: (world: World) => {
        world.chain.accounts.get(RELAYER_ADDRESS)!.balance = BigInt(1_000);
      },
      fix: (world: World) => world.chain.fund(RELAYER_ADDRESS, BigInt(10_000_000)),
      balance: BigInt(1_000),
    },
    {
      name: "insufficient fee (the node's minimum gas price above the configured one)",
      code: 13,
      kind: "insufficient-fee",
      action: /raise the configured gas price/,
      cause: (world: World) => {
        (world.chain.options as { minGasPriceNum?: bigint }).minGasPriceNum = BigInt(100);
      },
      fix: (world: World) => {
        (world.chain.options as { minGasPriceNum?: bigint }).minGasPriceNum = BigInt(75);
      },
      balance: BigInt(10_000_000),
    },
  ] as const;

  for (const scenario of deterministic) {
    test(`${scenario.name}: ONE KMS signature, then WAIT + PAGE at once (A15) -- no expiry/re-sign loop, no hold, no budget; the intent, its attempt, the refused answer and the journal entry all kept`, async () => {
      const world = makeWorld({ wrapRelayerKey: () => signer, timeoutBlocks: 2, relayerTuning: { failureBudget: 2 } });
      scenario.cause(world);
      const signsBefore = kms.signs.length;
      await startIntent(world);
      await world.relayer.pass();
      const refusedOnce = await startOf(world);
      assert.equal(refusedOnce.attempts.length, 1);
      const [attempt] = refusedOnce.attempts;
      assert.equal(attempt.phase, "signed", "refused at CheckTx: never accepted");
      assert.deepEqual([attempt.broadcast?.code, attempt.broadcast?.codespace], [scenario.code, "sdk"]);
      /* Paged at once: the condition (the A15 gauge's source), its durable audit, and the operator's action in words. */
      const paging = world.relayer.status().paging;
      assert.equal(paging.paged, 1, "paged at once (RelayerPaging >= 1)");
      assert.equal(paging.conditions[0].condition, "submission-refused");
      assert.equal(paging.conditions[0].intent_id, refusedOnce.intent_id);
      assert.match(paging.conditions[0].why, scenario.action);
      assert.equal(opsOf(world, "chain.relayer-page").filter((line) => line.condition === "submission-refused").length, 1);
      const audited = opsOf(world, "chain.submission-refused");
      assert.equal(audited.length, 1);
      assert.equal(audited[0].kind, scenario.kind);
      assert.equal(audited[0].tx_hash, attempt.tx_hash);
      assert.ok(world.warnings.some((line) => /PAGE submission-refused for start/.test(line) && scenario.action.test(line)));

      /* Many expiry windows (timeout 2 blocks; the budget is 2): the attempt is proven dead, and nothing else happens. */
      await rounds(world, 40);
      const after = await startOf(world);
      assert.equal(after.status, "pending", "not held: the account's condition is waited out, never turned into a hold");
      assert.equal(after.hold, null);
      assert.equal(after.attempts.length, 1, "no re-sign");
      assert.equal(after.attempts[0].phase, "dead");
      assert.equal(after.attempts[0].death?.kind, "expiry-passed");
      assert.equal(after.retry.failures, 0, "no intent budget spent (F-L5-17)");
      assert.equal(kms.signs.length - signsBefore, 1, "the KMS sign count stopped at one");
      assert.deepEqual(world.chain.broadcasts, [attempt.tx_hash], "the refused bytes were never handed to a node again");
      assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.sequence, BigInt(0));
      assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.balance, scenario.balance, "no fee charged");
      assert.equal(world.relayer.status().paging.paged, 1, "still paging: only the operator ends it");
      assert.equal(opsOf(world, "chain.relayer-page").filter((line) => line.condition === "submission-refused").length, 1, "paged once, not once per pass");

      /* Evidence (test 3): the intent, its attempt (bytes, hash, sequence, the refused answer, the death proof) and the
         journal entry -- nothing erased. */
      const stored = await world.intents.load(GAME_A, after.intent_id);
      assert.ok(stored !== null);
      const kept = stored.attempts[0];
      assert.equal(kept.tx_hash, attempt.tx_hash);
      assert.equal(kept.tx_bytes, attempt.tx_bytes);
      assert.equal(kept.sequence, "0");
      assert.equal(kept.broadcast?.code, scenario.code);
      assert.ok(kept.resolved_height !== null, "the death proof's height (the reversible Start reads at or above it)");
      checkAttemptBytes(world, kept, signer, { gas_used: "180000" });
      const journalled = await world.journal.attemptsOf(after.intent_id);
      assert.equal(journalled.length, 1);
      assert.deepEqual([journalled[0].tx_id, journalled[0].sequence, journalled[0].expires_after_height, journalled[0].account], [kept.tx_hash, kept.sequence, kept.timeout_height, RELAYER_ADDRESS]);
      /* The roster freeze stands (the Start is neither done nor proven impossible to the service). */
      assert.equal((await fin(world)).chain.started, null);
    });

    test(`${scenario.name}: corrected by the operator, then the supported recovery (a relayer restart) -- the SAME intent signs afresh at the chain's sequence and lands; one more KMS signature`, async () => {
      const world = makeWorld({ wrapRelayerKey: () => signer, timeoutBlocks: 2, relayerTuning: { failureBudget: 2 } });
      scenario.cause(world);
      const signsBefore = kms.signs.length;
      const intent = await startIntent(world);
      await rounds(world, 12);
      assert.equal(kms.signs.length - signsBefore, 1);
      /* Corrected, but this process's condition stands: still nothing signed. */
      scenario.fix(world);
      await rounds(world, 6);
      assert.equal(kms.signs.length - signsBefore, 1, "no signing before the operator's restart");
      /* The operator restarts the relayer: a new process observes the dead attempt and signs at the chain's sequence. */
      await world.restart();
      assert.equal(world.relayer.status().paging.waiting, 0);
      await world.drive(async () => (await fin(world)).chain.started !== null);
      const start = await startOf(world);
      assert.equal(start.intent_id, intent.intent_id, "the same durable intent");
      assert.equal(start.status, "confirmed");
      assert.equal(start.attempts.length, 2);
      assert.deepEqual(start.attempts.map((a) => [a.phase, a.sequence]), [["dead", "0"], ["included-success", "0"]]);
      assert.equal(kms.signs.length - signsBefore, 2);
      checkAttemptBytes(world, start.attempts[1], signer, { gas_used: "180000" });
      assert.equal((await world.journal.attemptsOf(intent.intent_id)).length, 2, "both attempts journalled");
      assert.equal(world.chain.accounts.get(RELAYER_ADDRESS)?.sequence, BigInt(1));
    });
  }

  test("a queue of two games: game A's Start refused for the ACCOUNT's fee; game B's ready Start is not signed into the same refusal (one signature in all); corrected and restarted, both land", async () => {
    const world = makeWorld({ wrapRelayerKey: () => signer, timeoutBlocks: 2, relayerTuning: { failureBudget: 2 } });
    (world.chain.options as { minGasPriceNum?: bigint }).minGasPriceNum = BigInt(100);
    const signsBefore = kms.signs.length;
    await startIntent(world, GAME_A);
    await startIntent(world, GAME_B);
    await rounds(world, 30);
    const [a, b] = [await startOf(world, GAME_A), await startOf(world, GAME_B)];
    assert.equal(a.attempts.length, 1);
    assert.equal(a.attempts[0].phase, "dead");
    assert.equal(b.attempts.length, 0, "B is never signed while the account's submissions are refused (it would meet the same refusal)");
    assert.deepEqual([a.status, b.status], ["pending", "pending"], "neither is held");
    assert.equal(kms.signs.length - signsBefore, 1);
    (world.chain.options as { minGasPriceNum?: bigint }).minGasPriceNum = BigInt(75);
    await world.restart();
    await world.drive(async () => (await fin(world, GAME_A)).chain.started !== null && (await fin(world, GAME_B)).chain.started !== null);
    assert.deepEqual([(await startOf(world, GAME_A)).status, (await startOf(world, GAME_B)).status], ["confirmed", "confirmed"]);
    assert.equal(kms.signs.length - signsBefore, 3);
  });

  test("an UNNAMED CheckTx refusal (sdk/4) is not deterministic: no page, the same bytes retried, a new attempt per proven expiry -- and (D-1) HELD at the failure budget, not the 32-attempt cap; nothing signed after the hold", async () => {
    const world = makeWorld({ wrapRelayerKey: () => signer, timeoutBlocks: 2, relayerTuning: { failureBudget: 2 } });
    world.chain.checkTxRefusal = UNNAMED;
    const signsBefore = kms.signs.length;
    await startIntent(world);
    await world.relayer.pass();
    assert.equal(world.relayer.status().paging.waiting, 0, "no submission-refused condition");
    await world.drive(async () => ["held", "superseded"].includes((await startOf(world)).status), 60);
    const start = await startOf(world);
    /* Held at the budget; the service then releases a held Start at once (reversible start), so the hold is read from
       its durable audit and warning -- the record may already be `superseded` (released). */
    const held = opsOf(world, "chain.intent-held");
    assert.equal(held.length, 1);
    assert.equal(held[0].code, "chain-intent-held");
    assert.match(String(held[0].detail), /^2 consecutive attempts failed; the last expired unincluded \(last CheckTx sdk\/(4|30)\)$/, "the last answer a node gave (near its expiry: 30, timeout height)");
    assert.ok(world.warnings.some((line) => /HELD start .*\(chain-intent-held\) -- 2 consecutive attempts failed/.test(line)));
    assert.ok(start.status === "held" || (start.status === "superseded" && /released/.test(start.superseded?.why ?? "")), start.status);
    assert.equal(start.attempts.length, 2, "held at the budget (2), not the 32-attempt cap");
    assert.ok(start.attempts.every((attempt) => attempt.phase === "dead" && attempt.death?.kind === "expiry-passed" && attempt.sequence === "0"));
    assert.ok(start.attempts.every((attempt) => attempt.broadcasts >= 2), "the same bytes were retried while includable");
    assert.equal(start.retry.failures, 2);
    assert.equal(kms.signs.length - signsBefore, 2);
    assert.equal(opsOf(world, "chain.submission-refused").length, 0);
    /* Test 10: held -- no signature, ever (the service may then release the reversible Start; it signs nothing either). */
    await rounds(world, 20);
    assert.equal(kms.signs.length - signsBefore, 2, "no signature after the hold");
    const after = await startOf(world);
    assert.ok(after.status === "held" || (after.status === "superseded" && /released/.test(after.superseded?.why ?? "")), after.status);
  });

  test("the 32-attempt cap is still the final backstop (an unnamed refusal with a budget above it)", async () => {
    const world = makeWorld({ wrapRelayerKey: () => signer, timeoutBlocks: 2, relayerTuning: { failureBudget: 40 } });
    world.chain.checkTxRefusal = UNNAMED;
    const signsBefore = kms.signs.length;
    await startIntent(world);
    await world.drive(async () => ["held", "superseded"].includes((await startOf(world)).status), 400);
    const start = await startOf(world);
    assert.ok(world.warnings.some((line) => /HELD start .*\(chain-intent-held\) -- the attempt budget is spent/.test(line)));
    assert.equal(start.attempts.length, 32);
    assert.equal(kms.signs.length - signsBefore, 32);
    await rounds(world, 10);
    assert.equal(kms.signs.length - signsBefore, 32);
  });

  test("sequence handling unchanged: a sequence used elsewhere while our attempt was live is `sequence-consumed` (no budget, no page), and the next attempt signs at the chain's sequence", async () => {
    const world = makeWorld({ wrapRelayerKey: () => signer, timeoutBlocks: 50 });
    const signsBefore = kms.signs.length;
    await startIntent(world);
    world.chain.dropNextBroadcast = 1; // stored and live; no node has it
    await world.relayer.pass();
    assert.equal((await startOf(world)).attempts[0].phase, "signed");
    world.chain.consumeSequenceExternally(RELAYER_ADDRESS);
    await world.drive(async () => (await fin(world)).chain.started !== null);
    const start = await startOf(world);
    assert.equal(start.attempts[0].phase, "dead");
    assert.equal(start.attempts[0].death?.kind, "sequence-consumed");
    assert.equal(start.attempts[1].sequence, "1", "the chain's sequence, read afresh");
    assert.equal(start.retry.failures, 0);
    assert.equal(world.relayer.status().paging.waiting, 0);
    assert.equal(kms.signs.length - signsBefore, 2);
  });

  test("rebroadcast cadence (JX-2A O-2): an ANSWERED refusal waits the rebroadcast spacing instead of every pass; an unanswered send (transport) is retried at the next pass", async () => {
    const world = makeWorld({ wrapRelayerKey: () => signer, timeoutBlocks: 1_000, relayerTuning: { rebroadcastMs: 30_000 } });
    world.chain.checkTxRefusal = UNNAMED;
    await startIntent(world);
    await world.relayer.pass();
    const [first] = (await startOf(world)).attempts;
    for (const step of [1_000, 5_000, 10_000, 13_000]) {
      world.clock.now += step;
      await world.relayer.pass();
    }
    assert.deepEqual(world.chain.broadcasts, [first.tx_hash], "29 s later: not re-sent at every pass (was: every pass)");
    world.clock.now += 1_500;
    await world.relayer.pass();
    assert.deepEqual(world.chain.broadcasts, [first.tx_hash, first.tx_hash], "past the 30 s spacing: the SAME bytes once more");
    assert.equal((await startOf(world)).attempts.length, 1);

    const lost = makeWorld({ wrapRelayerKey: () => signer, timeoutBlocks: 1_000, relayerTuning: { rebroadcastMs: 30_000 } });
    await startIntent(lost);
    lost.chain.dropNextBroadcast = 1;
    await lost.relayer.pass();
    assert.equal((await startOf(lost)).attempts[0].broadcast?.codespace, "transport");
    lost.clock.now += 1_000;
    await lost.relayer.pass();
    const sent = (await startOf(lost)).attempts[0];
    assert.equal(sent.phase, "broadcast", "a send that never reached a node is retried at once");
    assert.deepEqual(lost.chain.broadcasts, [sent.tx_hash]);
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
