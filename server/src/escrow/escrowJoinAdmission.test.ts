// server/src/escrow/escrowJoinAdmission.test.ts
//
// ==================================================================
//  ESCROW-JOIN (2026-09-28): THE SERVER'S JOIN ADMISSION -- BYTES, WIRE, SEAM, LEDGER
// ==================================================================
//
// Escrow 2.0.0's Join needs the hosted server's admission (a signature over the JOIN digest of the joining wallet, the
// game and the ticket). This suite pins the server's half:
//   - the admission signer reproduces the FROZEN cross-language vectors byte for byte (Python generator, the contract,
//     TypeScript), and verifies exactly the vectors the contract accepts;
//   - the wallet's Join message carries it in exactly the contract's wire shape (the same literal the Rust suite
//     executes: `contracts/escrow/tests/join_admission_vectors.rs`);
//   - `EscrowService.authorizeJoin` issues one only through the existing authority -- a bound FUNDING game, not frozen, the
//     seat's standing ticket issued to THIS principal for THIS wallet, the wallet's control proved (ESCROW-4's seam), no
//     conflicting grant, the chain open -- recording it on the ticket grant BEFORE signing;
//   - an outstanding admission keeps its seat's ticket from being superseded until it expires.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ALICE, BOB, quietConsole } from "../rooms/testSupport";
import { GNO_CODEC_V1_DRAFT } from "../../../frontend/src/gameEngine/escrow/gnoCodecV1.draft";
import { JUNO_CODEC_V1 } from "../../../frontend/src/gameEngine/escrow/junoCodecV1";
import { JoinAdmissionInputError, joinAdmissionDigestV1, joinAdmissionPreimageV1 } from "../../../frontend/src/gameEngine/escrow/junoJoinAdmissionV1";
import { junoJoinAdmissionSigner } from "./juno/joinAdmission";
import { JunoAbiError, parseConfigResponse, WALLET_EXECUTE } from "./juno/junoContract";
import { publicKeyOf, verifyDigest } from "./juno/secp256k1";
import { developmentDigestSigner, SignerError } from "./juno/signer";
import { createFileWalletTicketStore, WalletTicketStoreUnreadableError } from "./walletTicketFileStore";
import { createWalletTicketLedger } from "./walletTickets";
import {
  ADMISSION_PUBKEY,
  ADMISSION_SECRET,
  ADMISSION_TTL_SECS,
  CHAIN_ID,
  CONSENT_KEYS,
  CONTRACT,
  GAME_A,
  GAME_B,
  VARIANTS,
  WALLETS,
  fundedGame,
  makeWorld,
  proofFor,
  proofKey,
  type World,
} from "./escrow3bSupport";
import { WALLET_PROOF_MAX_AGE_MS } from "./escrowPorts";
import { ADMISSION_CLOCK_SKEW_MS } from "./walletTickets";
import type { JoinAdmissionSigner } from "./juno/joinAdmission";

quietConsole();

const sha = (text: string) => createHash("sha256").update(text).digest();
const GUARD = { serverMode: "development" as const, networkClass: "testnet" as const, chainId: CHAIN_ID, acknowledged: true };

function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, "contracts", "escrow", "testdata"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("the repository root was not found");
    dir = up;
  }
  return dir;
}

const VECTOR_FILE = path.join(repoRoot(), "contracts", "escrow", "testdata", "join_admission_vectors_v1.json");
const VECTOR_SHA256 = "cacc9ea3d0086253e27d8a67b7c16266f7113799526e888fe810197d16763cfb";

interface Vector {
  readonly name: string;
  readonly inputs: { chain_id: string; contract_addr: string; chain_game_id: string; wallet: string; join_ticket: string; expires_at: string };
  readonly preimage: string;
  readonly digest: string;
  readonly signature: string;
  readonly valid: boolean;
  readonly mutates?: string;
}

/** The exact wire form of the base vector's Join (the Rust suite deserializes and executes this same literal). */
const BASE_JOIN_WIRE =
  '{"join":{"chain_game_id":1,"consent_pubkey":"03346c3180a0b68922f81f0092a78e124c32bf5575860c1daec7de9d0b405c19fd","join_ticket":"3f1f9142c92994e97aced9dbd5dc92fede9aadebcfbc9b057c8a02f29bc4f444","admission":{"expires_at":"1790000900","signature":"7f6a5af1d02172534e1b31c7c03f6710dc01c691506f3f6af9c4921b258c3e3e1a0c2c8d71362e4fb2dca438caf54af9de3b976736323fb627795f854c25602a"}}}';

describe("ESCROW-JOIN: the frozen cross-language admission vectors, from the server's side", () => {
  const raw = fs.readFileSync(VECTOR_FILE);
  const doc = JSON.parse(raw.toString("utf8")) as { format: string; keys: Record<string, { secret_hex: string; pubkey: string }>; vectors: Vector[] };

  test("the file is the frozen one, and its admission key is this suite's test key", () => {
    assert.equal(createHash("sha256").update(raw).digest("hex"), VECTOR_SHA256);
    assert.equal(doc.format, "18JUNO/JOIN/admission-vectors/v1");
    assert.equal(doc.keys.admission.pubkey, ADMISSION_PUBKEY);
    assert.equal(doc.keys.admission.secret_hex, ADMISSION_SECRET.toString("hex"));
    assert.equal(doc.vectors.length, 20);
  });

  test("every preimage and digest is reproduced (the canonical spellings), every verdict is the contract's", () => {
    const key = Buffer.from(doc.keys.admission.pubkey, "hex");
    for (const v of doc.vectors) {
      const i = v.inputs;
      const inputs = { chain_id: i.chain_id, contract_addr: i.contract_addr, chain_game_id: BigInt(i.chain_game_id), wallet: i.wallet, join_ticket: i.join_ticket, expires_at: BigInt(i.expires_at) };
      if (i.wallet !== i.wallet.toLowerCase()) {
        /* A non-canonical spelling is never hashed (the chain's sender is lower case): the builder refuses it. */
        assert.throws(() => joinAdmissionPreimageV1(inputs), JoinAdmissionInputError, v.name);
        assert.throws(() => JUNO_CODEC_V1.joinAdmissionDigest({ chain_id: i.chain_id, deployment: i.contract_addr, chain_game_id: inputs.chain_game_id, wallet: i.wallet, join_ticket_hex: i.join_ticket, expires_at: inputs.expires_at }), v.name);
      } else {
        assert.equal(Buffer.from(joinAdmissionPreimageV1(inputs)).toString("hex"), v.preimage, `${v.name}: preimage`);
        assert.equal(joinAdmissionDigestV1(inputs), v.digest, `${v.name}: digest`);
        const viaCodec = JUNO_CODEC_V1.joinAdmissionDigest({ chain_id: i.chain_id, deployment: i.contract_addr, chain_game_id: inputs.chain_game_id, wallet: i.wallet, join_ticket_hex: i.join_ticket, expires_at: inputs.expires_at });
        assert.deepEqual(viaCodec, { codec: "18JUNO/v1", purpose: "join-admission", hex: v.digest }, `${v.name}: codec`);
      }
      const verdict = /^([0-9a-f]{2})*$/.test(v.signature) && verifyDigest(key, Buffer.from(v.digest, "hex"), Buffer.from(v.signature, "hex"));
      assert.equal(verdict, v.valid, `${v.name}: verdict`);
    }
  });

  test("the server's admission signer (development key) signs the valid vectors to the SAME bytes (RFC 6979, low-s)", async () => {
    const signer = junoJoinAdmissionSigner(ADMISSION_PUBKEY, JUNO_CODEC_V1, developmentDigestSigner(Buffer.from(doc.keys.admission.secret_hex, "hex"), "vectors", GUARD));
    for (const v of doc.vectors.filter((entry) => entry.valid)) {
      const i = v.inputs;
      const signed = await signer.sign({ chain_id: i.chain_id, deployment: i.contract_addr, chain_game_id: BigInt(i.chain_game_id), wallet: i.wallet, join_ticket_hex: i.join_ticket, expires_at: BigInt(i.expires_at) });
      assert.deepEqual(signed, { digest_hex: v.digest, signature_hex: v.signature }, v.name);
    }
  });

  test("the admission signer refuses a key that is not the configured one, and any codec but 18JUNO/v1", () => {
    const other = developmentDigestSigner(sha("another key"), "other", GUARD);
    assert.throws(() => junoJoinAdmissionSigner(ADMISSION_PUBKEY, JUNO_CODEC_V1, other), (error: unknown) => error instanceof SignerError && error.code === "config");
    assert.throws(() => junoJoinAdmissionSigner(ADMISSION_PUBKEY.toUpperCase(), JUNO_CODEC_V1, developmentDigestSigner(ADMISSION_SECRET, "a", GUARD)), SignerError);
    assert.throws(() => junoJoinAdmissionSigner(ADMISSION_PUBKEY, GNO_CODEC_V1_DRAFT as never, developmentDigestSigner(ADMISSION_SECRET, "a", GUARD)), SignerError);
  });

  test("the wallet's Join carries the admission in exactly the contract's wire shape (the literal the Rust suite executes)", () => {
    const base = doc.vectors.find((v) => v.name === "base")!;
    const seat1 = publicKeyOf(sha("18JUNO/TEST/seat/1")).toString("hex");
    const wire = WALLET_EXECUTE.join(base.inputs.chain_game_id, seat1, base.inputs.join_ticket, { expiresAt: base.inputs.expires_at, signature: base.signature });
    assert.equal(wire, BASE_JOIN_WIRE);
    assert.throws(() => WALLET_EXECUTE.join("1", seat1, base.inputs.join_ticket, { expiresAt: "01", signature: base.signature }), /admission.expires_at/);
    assert.throws(() => WALLET_EXECUTE.join("1", seat1, base.inputs.join_ticket, { expiresAt: "18446744073709551616", signature: base.signature }), /admission.expires_at/);
    assert.throws(() => WALLET_EXECUTE.join("1", seat1, base.inputs.join_ticket, { expiresAt: "1", signature: base.signature.toUpperCase() }), /admission.signature/);
    assert.throws(() => WALLET_EXECUTE.join("1", seat1, base.inputs.join_ticket, { expiresAt: "1", signature: base.signature.slice(2) }), /admission.signature/);
  });
});

describe("ESCROW-JOIN: a 1.0.0 contract (no admission key) is refused by the ABI, not by accident", () => {
  test("a ConfigResponse without admission_pubkey is a JunoAbiError (the deployment verification then refuses it)", () => {
    const config = { admin: "juno1a", operator: "juno1o", resolver: "juno1r", treasury: "juno1t", denom: "ujunox", paused: false, params: { subsidy_bps: 100, challenge_window_live_secs: 1, challenge_window_async_secs: 1, liveness_window_secs: 1, resolver_timeout_secs: 1 } };
    const answer = (extra: Record<string, unknown>) => ({ config: { ...config, ...extra }, next_chain_game_id: 1, next_signer_key_id: 2, contract_name: "crates.io:eighteen-cosmos-escrow", contract_version: "1.0.0" });
    assert.throws(() => parseConfigResponse(answer({})), JunoAbiError);
    assert.throws(() => parseConfigResponse(answer({ admission_pubkey: 7 })), JunoAbiError);
    assert.throws(() => parseConfigResponse(answer({ admission_pubkey: "02ab" })), JunoAbiError);
    assert.equal(parseConfigResponse(answer({ admission_pubkey: ADMISSION_PUBKEY.toUpperCase() })).admission_pubkey, ADMISSION_PUBKEY);
  });
});

/* ------------------------------------------------------------------ */
/* The seam: EscrowService.authorizeJoin                                */
/* ------------------------------------------------------------------ */

/** A bound money game on chain game "1": ALICE seated (wallet 0), BOB's seat OPEN (he withdrew), both tickets standing
 *  (principals pr_0 / pr_1). BOB's wallet control is proved unless `prove` is false. */
async function openSeat(world: World, prove = true): Promise<{ readonly chainGameId: string; readonly bobTicket: string }> {
  assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
  const chainGameId = await fundedGame(world, GAME_A);
  assert.ok(world.chain.withdraw(chainGameId, WALLETS[1]).ok);
  assert.ok((await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok);
  const grant = await world.ledger.standingGrantOf(GAME_A, BOB);
  assert.ok(grant !== null);
  if (prove) world.proofs.set(proofKey(GAME_A, BOB, "pr_1"), proofFor(GAME_A, BOB, "pr_1", WALLETS[1]));
  return { chainGameId, bobTicket: grant.ticket };
}

const bobAsks = (bobTicket: string, over: Partial<{ gameId: string; playerId: string; principalId: string; wallet: string; joinTicket: string }> = {}) => ({
  gameId: GAME_A,
  playerId: BOB,
  principalId: "pr_1",
  wallet: WALLETS[1],
  joinTicket: bobTicket,
  ...over,
});

const refusal = (result: { ok: boolean }) => (result.ok ? "ok" : (result as unknown as { code: string }).code);

describe("ESCROW-JOIN: authorizeJoin issues an admission only through the existing authority", () => {
  test("the admitted seat's own wallet joins on chain; the admission was recorded on its grant before it was signed", async () => {
    const world = makeWorld();
    const { chainGameId, bobTicket } = await openSeat(world);
    const granted = await world.service.authorizeJoin(bobAsks(bobTicket));
    assert.ok(granted.ok, JSON.stringify(granted));
    const admission = granted.admission;
    const expiresAt = Math.floor(world.clock.now / 1000) + ADMISSION_TTL_SECS;
    assert.deepEqual(
      { ...admission, signature: "" },
      { chain_id: CHAIN_ID, contract: CONTRACT, chain_game_id: chainGameId, wallet: WALLETS[1], join_ticket: bobTicket, expires_at: String(expiresAt), signature: "", admission_pubkey: ADMISSION_PUBKEY },
    );
    const digest = joinAdmissionDigestV1({ chain_id: CHAIN_ID, contract_addr: CONTRACT, chain_game_id: BigInt(chainGameId), wallet: WALLETS[1], join_ticket: bobTicket, expires_at: BigInt(expiresAt) });
    assert.ok(verifyDigest(Buffer.from(ADMISSION_PUBKEY, "hex"), Buffer.from(digest, "hex"), Buffer.from(admission.signature, "hex")));
    assert.equal((await world.ledger.standingGrantOf(GAME_A, BOB))?.admitted_until_secs, expiresAt, "recorded on the grant");
    const lines = world.ops.lines.filter((line) => line.event === "money.join-admitted");
    assert.equal(lines.length, 1);
    assert.doesNotMatch(JSON.stringify(lines[0]), /pr_1|pr_0|juno1/, "no principal (and no wallet) in the audit line");
    /* The wallet builds its Join from it; the (offline) contract seats it. */
    const join = world.chain.join(chainGameId, { wallet: WALLETS[1], consent_pubkey: CONSENT_KEYS[1], join_ticket: bobTicket }, { expires_at: admission.expires_at, signature: admission.signature });
    assert.ok(join.ok, JSON.stringify(join));
    assert.equal(world.chain.games.get(1)!.state, "funded");
    /* ...but the same admission is worthless to any other wallet. */
    assert.ok(world.chain.withdraw(chainGameId, WALLETS[1]).ok);
    const copied = world.chain.join(chainGameId, { wallet: WALLETS[2], consent_pubkey: CONSENT_KEYS[2], join_ticket: bobTicket }, { expires_at: admission.expires_at, signature: admission.signature });
    assert.equal(copied.ok, false);
    /* The honest seat rejoins; the roster freezes and starts; no admission is issued to a frozen table. */
    assert.ok(world.chain.join(chainGameId, { wallet: WALLETS[1], consent_pubkey: CONSENT_KEYS[1], join_ticket: bobTicket }, { expires_at: admission.expires_at, signature: admission.signature }).ok);
    assert.ok((await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }])).ok);
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket))), "frozen");
  });

  test("every precondition refuses on its own, and nothing is recorded or signed", async () => {
    const world = makeWorld();
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks("00".repeat(32)))), "not-found");
    assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks("00".repeat(32)))), "not-bound");
    const chainGameId = await fundedGame(world, GAME_A);
    assert.ok(world.chain.withdraw(chainGameId, WALLETS[1]).ok);
    assert.ok((await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok);
    const bobTicket = (await world.ledger.standingGrantOf(GAME_A, BOB))!.ticket;
    /* The wallet's control not proved (ESCROW-4 has not recorded it): refused, whatever else is right. So is every
       proof that does not bind exactly this game, seat, principal and wallet, or is too old, or carries no challenge. */
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket))), "wallet-unproven");
    const key = proofKey(GAME_A, BOB, "pr_1");
    const good = proofFor(GAME_A, BOB, "pr_1", WALLETS[1], world.clock.now);
    for (const bad of [
      { ...good, wallet: WALLETS[2] },
      { ...good, game_id: GAME_B },
      { ...good, player_id: ALICE },
      { ...good, principal_id: "pr_0" },
      { ...good, kind: "declared" as never },
      { ...good, challenge_digest: "" },
      { ...good, verified_at: world.clock.now - WALLET_PROOF_MAX_AGE_MS - 1 },
      { ...good, verified_at: world.clock.now + 3_600_000 },
    ]) {
      world.proofs.set(key, bad);
      assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket))), "wallet-unproven", JSON.stringify(bad));
    }
    world.proofs.set(key, good);
    /* Another principal (ALICE's) asking for BOB's seat; a wallet or ticket that is not the seat's standing one. */
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket, { principalId: "pr_0" }))), "not-seat-owner");
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket, { wallet: WALLETS[2] }))), "ticket-mismatch");
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks("ab".repeat(32)))), "ticket-mismatch");
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket, { playerId: "p-nobody" }))), "no-standing-ticket");
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket, { wallet: WALLETS[1].toUpperCase() }))), "request-invalid");
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket.toUpperCase()))), "request-invalid");
    /* ALICE's wallet is already seated on chain: an admission for it would be useless. */
    world.proofs.set(proofKey(GAME_A, ALICE, "pr_0"), proofFor(GAME_A, ALICE, "pr_0", WALLETS[0]));
    const aliceTicket = (await world.ledger.standingGrantOf(GAME_A, ALICE))!.ticket;
    assert.equal(refusal(await world.service.authorizeJoin({ gameId: GAME_A, playerId: ALICE, principalId: "pr_0", wallet: WALLETS[0], joinTicket: aliceTicket })), "already-seated");
    /* The chain paused. */
    world.chain.paused = true;
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket))), "paused");
    world.chain.paused = false;
    /* Nothing was recorded by any refusal. */
    assert.equal((await world.ledger.standingGrantOf(GAME_A, BOB))?.admitted_until_secs, null);
    assert.equal(world.ops.lines.filter((line) => line.event === "money.join-admitted").length, 0);
    assert.ok((await world.service.authorizeJoin(bobAsks(bobTicket))).ok, "and with everything right, it is issued");
  });

  test("escrow 2.1.0: a trusted resolver's wallet is never admitted to a seat (the contract would refuse to start the game)", async () => {
    const world = makeWorld({ extraResolvers: [WALLETS[1]] });
    const { bobTicket } = await openSeat(world);
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket))), "resolver-wallet");
    assert.equal((await world.ledger.standingGrantOf(GAME_A, BOB))?.admitted_until_secs, null, "nothing recorded");
    assert.equal(world.ops.lines.filter((line) => line.event === "money.join-admitted").length, 0, "nothing signed");
  });

  test("no conflicting grant: another seat's standing ticket naming the same wallet refuses", async () => {
    const world = makeWorld();
    const { bobTicket } = await openSeat(world);
    const carol = await world.ledger.issue({ binding: { backend: "juno-cosmwasm", chain_id: CHAIN_ID, deployment_id: CONTRACT }, gameId: GAME_A, playerId: "p-carol", wallet: WALLETS[1], context: { principalId: "pr_2", familyId: "sf_2", recoverySelector: "rk_2" }, reauthorized: true });
    assert.ok(carol.ok);
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket))), "wallet-conflict");
  });

  test("without an admission signer (a KMS key before LIVE-5) no admission is ever issued", async () => {
    const world = makeWorld({ noAdmissionSigner: true });
    const { bobTicket } = await openSeat(world);
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket))), "admission-unavailable");
  });

  test("an outstanding admission keeps its seat's ticket from being superseded until it expires", async () => {
    const world = makeWorld();
    const { bobTicket } = await openSeat(world);
    assert.ok((await world.service.authorizeJoin(bobAsks(bobTicket))).ok);
    const reissue = () =>
      world.ledger.issue({ binding: { backend: "juno-cosmwasm", chain_id: CHAIN_ID, deployment_id: CONTRACT }, gameId: GAME_A, playerId: BOB, wallet: WALLETS[2], context: { principalId: "pr_1", familyId: "sf_1", recoverySelector: "rk_1" }, reauthorized: true });
    assert.deepEqual(await reissue(), { ok: false, refusal: "admission-outstanding" });
    const outstanding = await world.ledger.outstandingAdmissions(GAME_A);
    assert.deepEqual(outstanding.map((entry) => [entry.player_id, entry.wallet]), [[BOB, WALLETS[1]]]);
    /* Outstanding until its expiry PLUS the clock-skew margin (the chain compares block time, which may trail). */
    world.clock.now += ADMISSION_TTL_SECS * 1000 + ADMISSION_CLOCK_SKEW_MS - 1000;
    assert.deepEqual(await reissue(), { ok: false, refusal: "admission-outstanding" }, "one second before expiry + margin");
    world.clock.now += 1000;
    assert.deepEqual(await world.ledger.outstandingAdmissions(GAME_A), []);
    const reissued = await reissue();
    assert.ok(reissued.ok, "then the seat may take another wallet");
  });

  test("the real admission is dead on chain at its expiry (block time), whatever the server does", async () => {
    const world = makeWorld();
    const { chainGameId, bobTicket } = await openSeat(world);
    const granted = await world.service.authorizeJoin(bobAsks(bobTicket));
    assert.ok(granted.ok);
    const { expires_at, signature } = granted.admission;
    world.chain.time = Number(expires_at) - 1;
    const seat = { wallet: WALLETS[1], consent_pubkey: CONSENT_KEYS[1], join_ticket: bobTicket };
    assert.ok(world.chain.join(chainGameId, seat, { expires_at, signature }).ok, "one second before: seated");
    assert.ok(world.chain.withdraw(chainGameId, WALLETS[1]).ok);
    world.chain.time = Number(expires_at);
    const late = world.chain.join(chainGameId, seat, { expires_at, signature });
    assert.equal(late.ok, false);
    assert.match((late as { error: string }).error, new RegExp(`the join admission expired at ${expires_at}`));
  });

  test("the admission is RECORDED before it is signed; a record that does not commit signs nothing", async () => {
    let calls = 0;
    let recordedWhenSigned: number | null = -1;
    let world: World | null = null;
    const spy = (inner: JoinAdmissionSigner): JoinAdmissionSigner => ({
      ...inner,
      async sign(input) {
        calls += 1;
        recordedWhenSigned = (await world!.ledger.standingGrantOf(GAME_A, BOB))?.admitted_until_secs ?? null;
        return inner.sign(input);
      },
    });
    world = makeWorld({ wrapAdmissionSigner: spy });
    const { bobTicket } = await openSeat(world);
    const granted = await world.service.authorizeJoin(bobAsks(bobTicket));
    assert.ok(granted.ok);
    assert.equal(calls, 1);
    assert.equal(recordedWhenSigned, Number(granted.admission.expires_at), "the ledger already held the expiry when the signer ran");
    /* A write conflict on the record: refused, and the signer is never called. */
    const store = world.tickets as unknown as { put: (...args: unknown[]) => Promise<"committed" | "conflict"> };
    const realPut = store.put.bind(store);
    store.put = async () => "conflict";
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket))), "conflict");
    assert.equal(calls, 1, "nothing was signed");
    store.put = realPut;
  });

  test("a security event ends the seat's ticket: no admission for it; the chain FUNDED, or its deadline passed, refuses too", async () => {
    const world = makeWorld();
    const { bobTicket } = await openSeat(world);
    world.standing = "ended"; // e.g. "sign out other devices" ended the session family the ticket was issued under
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket))), "no-standing-ticket");
    world.standing = "standing";
    /* The escrow's own funding deadline (chain clock) has passed by the server's clock. */
    const saved = world.clock.now;
    world.clock.now = (world.chain.time + 3600) * 1000;
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket))), "funding-closed");
    world.clock.now = saved;
    /* A full (FUNDED) chain game takes no one. */
    const other = makeWorld();
    assert.ok((await other.service.createMoneyGame(GAME_A)).ok);
    const chainGameId = await fundedGame(other, GAME_A);
    assert.ok((await other.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok);
    other.proofs.set(proofKey(GAME_A, BOB, "pr_1"), proofFor(GAME_A, BOB, "pr_1", WALLETS[1]));
    const ticket = (await other.ledger.standingGrantOf(GAME_A, BOB))!.ticket;
    assert.equal(refusal(await other.service.authorizeJoin(bobAsks(ticket))), "wrong-state");
  });

  test("admissions are per game: another table's admission is never issued from this table's authority", async () => {
    const world = makeWorld();
    const { bobTicket } = await openSeat(world);
    assert.equal(refusal(await world.service.authorizeJoin(bobAsks(bobTicket, { gameId: GAME_B }))), "not-found");
  });
});

describe("ESCROW-JOIN: the ticket file store keeps the admission (financial protocol 3: an older ledger is refused, never reinterpreted)", () => {
  test("a protocol-2 grant (3B's or ESCROW-JOIN's shape) is unreadable; a v3 grant's recorded admission round-trips; a bad value is unreadable", async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-join-tickets-"));
    const dir = path.join(data, "games", "wallet-tickets");
    fs.mkdirSync(dir, { recursive: true });
    const grant3b = { format: "gs-wallet-ticket", game_id: GAME_A, player_id: BOB, epoch: 1, wallet: WALLETS[1], ticket: "ab".repeat(32), issued_at: 5, issued_under: { principal_id: "pr_1", family_id: "sf_1", recovery_selector: "rk_1" }, revoked_at: null, revoke_reason: null, frozen_at: null };
    const write = (grant: object) => fs.writeFileSync(path.join(dir, `${GAME_A}.json`), `${JSON.stringify({ format: "gs-wallet-tickets", version: 1, game_id: GAME_A, document: { frozen_at: null, grants: [grant] } })}\n`);
    const ledger = createWalletTicketLedger({ store: createFileWalletTicketStore(data), standing: () => ({ kind: "standing" }), holdsSeat: () => true, now: () => 1_000 });
    /* ESCROW-4 amendment: no money game was ever created under financial protocol 2, so its ledgers are not migrated. */
    write(grant3b);
    await assert.rejects(() => ledger.standingGrantOf(GAME_A, BOB), (error: unknown) => error instanceof WalletTicketStoreUnreadableError && /financial protocol 2/.test(error.message));
    write({ ...grant3b, admitted_until_secs: null });
    await assert.rejects(() => ledger.standingGrantOf(GAME_A, BOB), (error: unknown) => error instanceof WalletTicketStoreUnreadableError && /financial protocol 2/.test(error.message));
    write({ ...grant3b, admitted_until_secs: null, proof: null, consent_keys: [], relinked_from: null, create_floor: null });
    assert.equal((await ledger.standingGrantOf(GAME_A, BOB))?.admitted_until_secs, null);
    assert.equal(await ledger.recordAdmission({ gameId: GAME_A, playerId: BOB, epoch: 1, wallet: WALLETS[1], ticket: "ab".repeat(32), expiresAt: 900 }), "committed");
    assert.equal(await ledger.recordAdmission({ gameId: GAME_A, playerId: BOB, epoch: 1, wallet: WALLETS[1], ticket: "ab".repeat(32), expiresAt: 800 }), "committed");
    assert.equal((await ledger.standingGrantOf(GAME_A, BOB))?.admitted_until_secs, 900, "only ever raised");
    assert.equal(await ledger.recordAdmission({ gameId: GAME_A, playerId: BOB, epoch: 2, wallet: WALLETS[1], ticket: "ab".repeat(32), expiresAt: 900 }), "refused", "another epoch");
    assert.equal(await ledger.recordAdmission({ gameId: GAME_A, playerId: BOB, epoch: 1, wallet: WALLETS[2], ticket: "ab".repeat(32), expiresAt: 900 }), "refused", "another wallet");
    const stored = JSON.parse(fs.readFileSync(path.join(dir, `${GAME_A}.json`), "utf8"));
    assert.equal(stored.document.grants[0].admitted_until_secs, 900, "written in the v3 shape");
    assert.deepEqual(Object.keys(stored.document.grants[0]).sort(), [...Object.keys(grant3b), "admitted_until_secs", "proof", "consent_keys", "relinked_from", "create_floor"].sort());
    stored.document.grants[0].admitted_until_secs = "soon";
    fs.writeFileSync(path.join(dir, `${GAME_A}.json`), `${JSON.stringify(stored)}\n`);
    await assert.rejects(() => ledger.standingGrantOf(GAME_A, BOB), WalletTicketStoreUnreadableError);
  });
});
