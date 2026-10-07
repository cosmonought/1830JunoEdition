// server/src/escrow/fp4RemedyIntents.test.ts
//
// ==================================================================
//  FINANCIAL PROTOCOL 4 (PHASE 3 ESCROW 2.1): THE DURABLE REMEDY INTENT, THE FENCE, AND PROTOCOL 3 <-> 4 COMPATIBILITY
// ==================================================================
//
// What this file proves (the brief's FP4 items; the contract's own suites prove the chain side):
//   1. the bump is explicit and complete: financial protocol 4 with its changelog row, the intent file schema 1 -> 2,
//      escrow 2.1.0 as the only contract version this build serves;
//   2. the two protocols never consume each other's financial work: a protocol-3 reader (intent schema [1]) classifies
//      every intent this build writes as `newer` (never parsed, never relayed); this build classifies a protocol-3
//      intent as `older-unread` (never parsed, never rewritten) and adds nothing to such a game; a protocol-3 money
//      identity is not continued (a drain);
//   3. the remedy intent: what the contract would refuse on shape is never written; one slot per (decision, expiry); a
//      subject binding the exact REMEDY digest; a message with no address and no amount; a record whose key, op and
//      subject disagree is unreadable;
//   4. the fence: never two OPEN remedy intents for a game, nothing after one landed, idempotent re-prepares; a fresh
//      attestation of the same decision or a later decision only after every earlier one ended without effect (a held
//      one is retired first);
//   5. end to end over the offline chain (escrow 2.1.0 semantics, `fakeJunoChain.submitRemedy`): nothing is relayed
//      without the remedy lane's gate (or while it says wait -- the system pause seam); finality and the attestation
//      time are waited for, a foreclosing remedy waits out a pause while a neutral one lands, an expired attestation
//      never lands and a fresh attestation of it does, play that went on makes it moot, another remedy on chain is a
//      contradiction (held), a foreclosure refused for good (an approver rotated its key) gives way to the neutral
//      TimeoutAnnul, a third strike is finalized by this server after its challenge window, and a lost broadcast answer
//      plus a restart submits once;
//   6. deployment verification: escrow 2.0.0 and an active REMEDY key this server does not hold are refused; the bind
//      refuses a 2.0.0-stored game and an async game (no table records its deadline class yet).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { FINANCIAL_PROTOCOL_CHANGELOG, FINANCIAL_PROTOCOL_VERSION } from "../../../frontend/src/gameEngine/protocolVersions";
import { formatFactOf } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { remedyApproveDigestV1, remedyAttestationWire, remedyDecisionDigestV1, remedyDigestV1, type RemedyAttestationV1, type RemedyKindByte } from "../../../frontend/src/gameEngine/escrow/junoRemedyV1";
import {
  CHAIN_INTENT_FORMAT,
  CHAIN_INTENT_SCHEMA,
  ChainIntentUnreadableError,
  READABLE_INTENT_SCHEMAS,
  chainIntentDirectory,
  chainIntentFormat,
  confirmedIntent,
  createFileChainIntentStore,
  createMemoryChainIntentStore,
  heldIntent,
  isChainIntentRecord,
  junoInstanceOf,
  newChainIntent,
  remedyFence,
  supersededIntent,
  type ChainIntentRecord,
  type ChainIntentStore,
} from "./chainIntents";
import { prepareRemedyIntent, remedyChainIntent, remedyIntentProblem, RemedyIntentError, type RemedyIntentInput } from "./juno/remedyIntents";
import { RELAYER_EXECUTE } from "./juno/junoContract";
import { JUNO_ESCROW_CONTRACT_VERSIONS, parseJunoBackendConfig, verifyJunoDeployment } from "./juno/junoConfig";
import { publicKeyOf, signDigest } from "./juno/secp256k1";
import { currentMoneyContinuation, moneyContinuationVerdict } from "./moneyContinuation";
import { ADMISSION_PUBKEY, CANONICAL_CHECKSUM, CHAIN_ID, CONSENT_KEYS, CONTRACT, GAME_A, RELAYER_ADDRESS, SETTLEMENT_SECRET, VARIANTS, WALLETS, fundedGame, makeWorld, startedGame, type World, type WorldOptions } from "./escrow3bSupport";

const sha = (label: string) => createHash("sha256").update(label).digest();
const n = (value: number) => BigInt(value);
const REMEDY_SECRET = sha("18JUNO/TEST/remedy/1");
const REMEDY_PUB = publicKeyOf(REMEDY_SECRET).toString("hex");
/** The seats' consent keys are `escrow3bSupport`'s: secret SHA-256("consent-<i>"). */
const seatSecret = (seat: number) => sha(`consent-${seat}`);
const sign = (secret: Buffer, digestHex: string) => signDigest(secret, Buffer.from(digestHex, "hex")).toString("hex");
const quiet = { warn: () => undefined };
const NET = BigInt(1_000_000);

/* ------------------------------------------------------------------ */
/* Pure fixtures                                                       */
/* ------------------------------------------------------------------ */

const DOMAIN = "d0".repeat(32);
const INSTANCE = junoInstanceOf(CHAIN_ID, CONTRACT, "7");

const PURE_SEATS = [0, 1, 2].map((seat) => publicKeyOf(seatSecret(seat)).toString("hex"));

function pureAttestation(remedy: RemedyKindByte, over: Partial<RemedyAttestationV1> = {}): RemedyAttestationV1 {
  const live = remedy <= 3;
  const overdue = n(1_760_001_200);
  const final = remedy === 3 ? overdue : live ? overdue + n(600) : overdue + n(3_600);
  return {
    version: 1,
    domain: DOMAIN,
    chain_game_id: n(7),
    remedy,
    defaulting_seat: 2,
    strike: remedy === 3 ? 3 : live ? 1 : 0,
    overdue_epoch: n(4),
    log_len: n(40),
    log_hash: "ab".repeat(32),
    allowance_secs: live ? n(1_200) : n(86_400),
    overdue_at: overdue,
    final_at: final,
    attested_at: final,
    expires_at: final + n(3_600),
    evidence_hash: "ef".repeat(32),
    remedy_key_id: 1,
    ...over,
  };
}

/** Each seat's approval of `a`, usable until `until` (default: one day after the attestation time). */
const approvalsOf = (a: RemedyAttestationV1, seats: readonly number[], until: bigint = a.attested_at + n(86_400)) =>
  seats.map((seat) => ({ seat_index: seat, approve_until: until, signature: sign(seatSecret(seat), remedyApproveDigestV1(a, until, seat)) }));

function pureInput(a: RemedyAttestationV1, approvals: readonly number[] = [], over: Partial<RemedyIntentInput> = {}): RemedyIntentInput {
  return {
    game_id: GAME_A,
    instance: INSTANCE,
    consent_pubkeys: PURE_SEATS,
    remedy_pubkey: REMEDY_PUB,
    started_at: a.overdue_at - a.allowance_secs,
    attestation: a,
    signature: sign(REMEDY_SECRET, remedyDigestV1(a)),
    approvals: approvalsOf(a, approvals),
    now: 1_760_000_000_000,
    ...over,
  };
}

/* ================================================================================================= */
/* 1-2. THE BUMP, AND WHAT EACH PROTOCOL READS OF THE OTHER                                           */
/* ================================================================================================= */

describe("FP4: the bump is explicit, and protocols 3 and 4 never consume each other's financial work", () => {
  test("financial protocol 4 with its own changelog row; the intent schema 1 -> 2 with it; escrow 2.1.0 only", () => {
    assert.equal(FINANCIAL_PROTOCOL_VERSION, 4);
    const row = FINANCIAL_PROTOCOL_CHANGELOG[FINANCIAL_PROTOCOL_CHANGELOG.length - 1];
    assert.equal(row.version, 4);
    assert.match(row.note, /escrow 2\.1\.0/);
    assert.match(row.note, /never on 2\.0\.0, which protocol 3 keeps/);
    assert.match(row.note, /a bump means a drain|a drain, as every bump/);
    assert.equal(CHAIN_INTENT_SCHEMA, 2);
    assert.deepEqual([...READABLE_INTENT_SCHEMAS], [2]);
    assert.deepEqual([...JUNO_ESCROW_CONTRACT_VERSIONS], ["2.1.0"]);
  });

  test("a protocol-3 reader (intent schema [1]) classifies every intent this build writes as newer -- never parsed, never relayed", () => {
    const record = remedyChainIntent(pureInput(pureAttestation(2), [0, 1]));
    assert.equal(record.schema, 2);
    /* Protocol 3's own classification (`chainIntentFormat` with READABLE_INTENT_SCHEMAS = [1]) runs on format and schema
       alone, before any field is read: the remedy (and every other FP4 intent) is another build's work. */
    assert.equal(formatFactOf(record.schema, [1]), "newer");
    const fp3Start = newChainIntent({ game_id: GAME_A, instance: INSTANCE, key: { op: "start" }, subject: { kind: "roster", roster_hash: "aa".repeat(32) }, op: { kind: "start", chain_game_id: "7", roster_hash: "aa".repeat(32) }, msg_json: RELAYER_EXECUTE.start("7", "aa".repeat(32)), now: 1 });
    assert.equal(formatFactOf(fp3Start.schema, [1]), "newer", "even an FP4 Start (unchanged op) is not protocol 3's to run");
    assert.equal(chainIntentFormat(record, GAME_A, record.intent_id), "current");
  });

  test("this build classifies a protocol-3 intent as older-unread: never parsed, never rewritten, and a remedy is never added beside it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp4-older-"));
    const store = createFileChainIntentStore(dir, quiet);
    /* A protocol-3 intent file: an FP3 build's record (schema 1), byte for byte what it wrote. */
    const fp3 = { ...newChainIntent({ game_id: GAME_A, instance: INSTANCE, key: { op: "finalize", seq: "9" }, subject: { kind: "digest", digests: [{ codec: "18JUNO/v1", purpose: "settle", hex: "cc".repeat(32) }] }, op: { kind: "finalize", chain_game_id: "7", seq: "9" }, msg_json: RELAYER_EXECUTE.finalize("7"), now: 1 }), schema: 1 };
    assert.equal(chainIntentFormat(fp3, GAME_A, fp3.intent_id), "older-unread");
    assert.equal(isChainIntentRecord(fp3), false);
    fs.mkdirSync(path.join(chainIntentDirectory(dir), GAME_A), { recursive: true });
    const file = path.join(chainIntentDirectory(dir), GAME_A, `${fp3.intent_id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(fp3)}\n`);
    const before = fs.readFileSync(file, "utf8");
    assert.equal(await store.formatOf(GAME_A), "older-unread");
    await assert.rejects(() => store.load(GAME_A, fp3.intent_id), (error: unknown) => error instanceof ChainIntentUnreadableError && error.format === "older-unread");
    const candidate = remedyChainIntent(pureInput(pureAttestation(1)));
    const pokes: string[] = [];
    assert.deepEqual(await prepareRemedyIntent(store, candidate, { poke: (_g, id) => pokes.push(id) }), { kind: "hold", why: "the game's intent files are older-unread: this build does not add to them" });
    assert.deepEqual(pokes, []);
    assert.deepEqual(fs.readdirSync(path.join(chainIntentDirectory(dir), GAME_A)), [`${fp3.intent_id}.json`], "nothing written beside it");
    assert.equal(fs.readFileSync(file, "utf8"), before, "the protocol-3 file is unchanged");
  });

  test("an FP4 remedy intent on disk is schema 2, and a later build's (schema 3) is never read here", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp4-disk-"));
    const store = createFileChainIntentStore(dir, quiet);
    const record = remedyChainIntent(pureInput(pureAttestation(4, { defaulting_seat: 0 }), [1, 2]));
    assert.equal((await prepareRemedyIntent(store, record)).kind, "created");
    const raw = JSON.parse(fs.readFileSync(path.join(chainIntentDirectory(dir), GAME_A, `${record.intent_id}.json`), "utf8")) as { format: string; schema: number };
    assert.deepEqual([raw.format, raw.schema], [CHAIN_INTENT_FORMAT, 2]);
    assert.equal(formatFactOf(raw.schema, [1]), "newer", "a protocol-3 build would not read it");
    assert.deepEqual(await store.listGame(GAME_A), [record]);
    fs.writeFileSync(path.join(chainIntentDirectory(dir), GAME_A, `${"f".repeat(64)}.json`), `${JSON.stringify({ format: CHAIN_INTENT_FORMAT, schema: 3, game_id: GAME_A, intent_id: "f".repeat(64) })}\n`);
    assert.equal(await store.formatOf(GAME_A), "newer");
    const renewal = remedyChainIntent(pureInput(pureAttestation(4, { defaulting_seat: 0, attested_at: pureAttestation(4).final_at + n(7_200), expires_at: pureAttestation(4).final_at + n(7_800) }), [1, 2]));
    assert.equal((await prepareRemedyIntent(store, renewal)).kind, "hold");
  });

  test("a protocol-3 money identity (an escrow 2.0.0 game) is not continued by this build: a drain", () => {
    assert.equal(currentMoneyContinuation().financial_protocol, 4);
    const fp3 = moneyContinuationVerdict({ ...currentMoneyContinuation(), financial_protocol: 3 });
    assert.equal(fp3.continues ? "continues" : fp3.why, "financial-protocol");
    assert.deepEqual(moneyContinuationVerdict(currentMoneyContinuation()), { continues: true });
  });
});

/* ================================================================================================= */
/* 3. THE REMEDY INTENT                                                                               */
/* ================================================================================================= */

describe("FP4: the remedy intent is exactly one attestation, never one the contract would refuse on shape", () => {
  test("refused before it is written: shape, roster, instance, signature form, and approvals that do not match the remedy", () => {
    const a1 = pureAttestation(1);
    assert.equal(remedyIntentProblem(pureInput(a1)), null);
    assert.match(String(remedyIntentProblem(pureInput({ ...a1, strike: 3 }))), /strike 3/);
    assert.match(String(remedyIntentProblem(pureInput({ ...a1, overdue_at: a1.overdue_at + n(1) }))), /10 minutes/);
    assert.match(String(remedyIntentProblem({ ...pureInput(a1), attestation: { ...a1, domain: "XY" } })), /not encodable/);
    assert.match(String(remedyIntentProblem(pureInput(a1, [], { consent_pubkeys: [...PURE_SEATS, ...PURE_SEATS, ...PURE_SEATS] }))), /not an escrow roster/);
    assert.match(String(remedyIntentProblem(pureInput(a1, [], { consent_pubkeys: ["02" + "zz".repeat(32), PURE_SEATS[1], PURE_SEATS[2]] }))), /consent key/);
    assert.match(String(remedyIntentProblem(pureInput({ ...a1, defaulting_seat: 3 }))), /not one of the 3 seats/);
    assert.match(String(remedyIntentProblem(pureInput(a1, [], { instance: junoInstanceOf(CHAIN_ID, CONTRACT, "8") }))), /chain game 7's/);
    assert.match(String(remedyIntentProblem(pureInput(a1, [], { signature: "AB".repeat(64) }))), /REMEDY signature/);
    // Every signature verifies before anything is written: the REMEDY key's (low-s ECDSA, the named key) ...
    assert.match(String(remedyIntentProblem(pureInput(a1, [], { signature: sign(SETTLEMENT_SECRET, remedyDigestV1(a1)) }))), /does not verify/);
    assert.match(String(remedyIntentProblem(pureInput(a1, [], { remedy_pubkey: PURE_SEATS[0] }))), /does not verify/);
    // Remedies 1 and 3 carry no approvals; 2, 4 and 5 carry every non-defaulting seat's, once, and never the defaulter's.
    assert.match(String(remedyIntentProblem(pureInput(a1, [0]))), /carries no seat approvals/);
    assert.match(String(remedyIntentProblem(pureInput(pureAttestation(3), [0, 1]))), /carries no seat approvals/);
    const a2 = pureAttestation(2);
    assert.equal(remedyIntentProblem(pureInput(a2, [0, 1])), null);
    assert.match(String(remedyIntentProblem(pureInput(a2, [0]))), /all 2 non-defaulting approvals, not 1/);
    assert.match(String(remedyIntentProblem(pureInput(a2, [0, 2]))), /defaulting seat 2 cannot approve/);
    assert.match(String(remedyIntentProblem(pureInput(a2, [0, 0, 1]))), /approves twice/);
    assert.match(String(remedyIntentProblem(pureInput(a2, [0, 5]))), /not one of the 3 seats/);
    const a5 = pureAttestation(5, { defaulting_seat: 1 });
    assert.equal(remedyIntentProblem(pureInput(a5, [2, 0])), null, "in any order");
    // ... and every approval, under the seat's CURRENT consent key, for THIS overdue instance.
    assert.match(String(remedyIntentProblem(pureInput(a2, [0, 1], { consent_pubkeys: [publicKeyOf(sha("rotated-0")).toString("hex"), PURE_SEATS[1], PURE_SEATS[2]] }))), /seat 0's approval does not verify/);
    const cured = { ...a2, overdue_at: a2.overdue_at - n(900), final_at: a2.final_at - n(900), attested_at: a2.attested_at - n(900), expires_at: a2.expires_at - n(900) };
    const stale = pureInput(cured, [0, 1]).approvals;
    assert.match(String(remedyIntentProblem({ ...pureInput(a2), approvals: stale })), /seat 0's approval does not verify/);
    assert.throws(() => remedyChainIntent(pureInput(a2, [0])), RemedyIntentError);
    /* The game's start (read from the chain): no overdue before one whole allowance has run. */
    assert.match(String(remedyIntentProblem(pureInput(a1, [], { started_at: a1.overdue_at - a1.allowance_secs + n(1) }))), /first allowance after the game's start/);
    assert.equal(remedyIntentProblem(pureInput(a1, [], { started_at: a1.overdue_at - a1.allowance_secs })), null);
    /* Each approval's own horizon (signed), judged at the decision's final_at (owner ruling, 2026-10-07): one presented
       with another horizon is not the seat's; one that ends at or before final_at never counts; one valid at final_at
       counts however late it is relayed (an attestation made after its horizon, a wall clock long past it). */
    const extended = approvalsOf(a2, [0, 1]).map((x, at) => (at === 0 ? { ...x, approve_until: x.approve_until + n(1) } : x));
    assert.match(String(remedyIntentProblem({ ...pureInput(a2), approvals: extended })), /seat 0's approval does not verify/);
    assert.match(String(remedyIntentProblem({ ...pureInput(a2), approvals: approvalsOf(a2, [0, 1], a2.final_at) })), /seat 0's approval ended \(\d+\) at or before the remedy became final/);
    assert.equal(remedyIntentProblem({ ...pureInput(a2), approvals: approvalsOf(a2, [0, 1], a2.final_at + n(1)) }), null);
    const reattested = { ...a2, attested_at: a2.final_at + n(7_200), expires_at: a2.final_at + n(7_800) };
    assert.equal(remedyIntentProblem({ ...pureInput(reattested), approvals: approvalsOf(reattested, [0, 1], a2.final_at + n(60)) }), null, "attested again after the horizon passed");
    const late = Number(a2.attested_at + n(86_400 * 30)) * 1000;
    assert.equal(remedyIntentProblem(pureInput(a2, [0, 1], { now: late })), null, "the wall clock plays no part");
    /* The key each seat held AT final_at (the chain's retired-key history): seat 0 rotated after final_at -> its old
       key still counts; rotated at final_at -> the old key is void (and the new one did not sign). */
    const rotated0 = [publicKeyOf(sha("rotated-0")).toString("hex"), PURE_SEATS[1], PURE_SEATS[2]];
    const after = [[{ pubkey: PURE_SEATS[0], retired_at_secs: (a2.final_at + n(1)).toString() }], [], []];
    assert.equal(remedyIntentProblem(pureInput(a2, [0, 1], { consent_pubkeys: rotated0, retired_consent_keys: after })), null);
    const atFinal = [[{ pubkey: PURE_SEATS[0], retired_at_secs: a2.final_at.toString() }], [], []];
    assert.match(String(remedyIntentProblem(pureInput(a2, [0, 1], { consent_pubkeys: rotated0, retired_consent_keys: atFinal }))), /seat 0's approval does not verify under the consent key it held at final_at/);
  });

  test("its slot is (decision, expiry); its subject the exact REMEDY digest; its message the contract's submit_remedy, no address, no amount", () => {
    const a = pureAttestation(5, { defaulting_seat: 1 });
    const record = remedyChainIntent(pureInput(a, [2, 0]));
    const decision = remedyDecisionDigestV1(a);
    assert.deepEqual(record.key, { op: "submit-remedy", decision, expires_at: a.expires_at.toString() });
    assert.deepEqual(record.subject, { kind: "remedy", protocol: "18JUNO/REMEDY/v1", decision, remedy_digest: remedyDigestV1(a) });
    assert.equal(record.op.kind, "remedy");
    assert.deepEqual({ ...record.op }, {
      kind: "remedy",
      chain_game_id: "7",
      remedy: 5,
      defaulting_seat: 1,
      strike: 0,
      overdue_epoch: "4",
      log_len: "40",
      final_at: a.final_at.toString(),
      attested_at: a.attested_at.toString(),
      expires_at: a.expires_at.toString(),
      usable_until: a.expires_at.toString(),
      remedy_key_id: 1,
      remedy_digest: remedyDigestV1(a),
      decision,
      approvals: 0b101,
    });
    const msg = JSON.parse(record.msg_json) as { submit_remedy: { chain_game_id: number; attestation: unknown; signature: string; approvals: Array<{ seat_index: number; approve_until: string }> } };
    assert.deepEqual(Object.keys(msg), ["submit_remedy"]);
    assert.equal(msg.submit_remedy.chain_game_id, 7);
    assert.deepEqual(msg.submit_remedy.attestation, remedyAttestationWire(a));
    assert.deepEqual(msg.submit_remedy.approvals.map((x) => x.seat_index), [0, 2], "approvals in seat order");
    assert.deepEqual(msg.submit_remedy.approvals.map((x) => x.approve_until), [(a.attested_at + n(86_400)).toString(), (a.attested_at + n(86_400)).toString()]);
    /* The usable life is the attestation's expiry: an approval horizon never shortens it (judged at final_at). */
    const early = a.final_at + n(60);
    const shortLived = remedyChainIntent({ ...pureInput(a), approvals: [...approvalsOf(a, [0]), ...approvalsOf(a, [2], early)] });
    assert.equal(shortLived.op.kind === "remedy" && shortLived.op.usable_until, a.expires_at.toString());
    assert.equal(shortLived.intent_id, record.intent_id, "the slot is the decision and the attestation's expiry");
    assert.doesNotMatch(record.msg_json, /juno1|amount|denom|funds/);
    assert.equal(record.status, "pending");
    assert.equal(isChainIntentRecord(record), true);
    /* A fresh attestation of the same decision (a new attestation time and expiry) keeps the decision. */
    const renewed = remedyChainIntent(pureInput({ ...a, attested_at: a.attested_at + n(7_200), expires_at: a.attested_at + n(7_800) }, [0, 2]));
    assert.equal(renewed.op.kind === "remedy" && renewed.op.decision, decision);
    assert.notEqual(renewed.intent_id, record.intent_id);
  });

  test("a stored remedy intent whose key, op and subject disagree is unreadable, never relayed", () => {
    const record = remedyChainIntent(pureInput(pureAttestation(1)));
    const other = remedyDecisionDigestV1(pureAttestation(1, { defaulting_seat: 0 }));
    assert.equal(isChainIntentRecord(record), true);
    assert.equal(isChainIntentRecord({ ...record, op: { ...record.op, decision: other } }), false);
    assert.equal(isChainIntentRecord({ ...record, op: { ...record.op, expires_at: "1" } }), false);
    assert.equal(isChainIntentRecord({ ...record, op: { ...record.op, usable_until: "1" } }), false, "a usable life the message does not imply");
    assert.equal(isChainIntentRecord({ ...record, subject: { ...record.subject, remedy_digest: "00".repeat(32) } }), false);
    assert.equal(isChainIntentRecord({ ...record, subject: { ...record.subject, protocol: "18JUNO/v1" } }), false);
    assert.equal(isChainIntentRecord({ ...record, subject: { kind: "digest", digests: [] } }), false, "a remedy key with a codec subject");
    const finalize = newChainIntent({ game_id: GAME_A, instance: INSTANCE, key: { op: "finalize", seq: "9" }, subject: { kind: "digest", digests: [] }, op: { kind: "finalize", chain_game_id: "7", seq: "9" }, msg_json: "{}", now: 1 });
    assert.equal(isChainIntentRecord(finalize), true);
    assert.equal(isChainIntentRecord({ ...finalize, op: record.op }), false, "a remedy op in another op's slot");
    /* The message itself is checked against the op: another attestation, approvals or chain game in `msg_json` makes the
       record unreadable (a damaged file never relays what its slot was not made for). */
    const otherAttestation = remedyChainIntent(pureInput(pureAttestation(1, { expires_at: pureAttestation(1).expires_at - n(1) })));
    assert.equal(isChainIntentRecord({ ...record, msg_json: otherAttestation.msg_json }), false, "another attestation's message");
    const approved = remedyChainIntent(pureInput(pureAttestation(2), [0, 1]));
    const oneApproval = JSON.parse(approved.msg_json) as { submit_remedy: { approvals: unknown[] } };
    oneApproval.submit_remedy.approvals.pop();
    assert.equal(isChainIntentRecord({ ...approved, msg_json: JSON.stringify(oneApproval) }), false, "an approval dropped from the message");
    const longer = JSON.parse(approved.msg_json) as { submit_remedy: { approvals: Array<{ approve_until: string }> } };
    longer.submit_remedy.approvals[0].approve_until = "1";
    assert.equal(isChainIntentRecord({ ...approved, msg_json: JSON.stringify(longer) }), false, "a horizon that changes the usable life");
    assert.equal(isChainIntentRecord({ ...record, msg_json: record.msg_json.replace('"chain_game_id":7,', '"chain_game_id":8,') }), false, "another chain game");
    assert.equal(isChainIntentRecord(approved), true);
  });
});

/* ================================================================================================= */
/* 4. THE FENCE                                                                                        */
/* ================================================================================================= */

describe("FP4: the fence -- one remedy decision per game, idempotent, renewed only after a terminal attestation", () => {
  const put = async (store: ChainIntentStore, next: ChainIntentRecord) => assert.equal((await store.put(next, next.record_version - 1)).kind, "committed");

  test("created, then exists; nothing while an earlier intent is open; after it ended without effect a fresh attestation or another decision is new work (a held one is retired first); nothing after a confirmation", async () => {
    const store = createMemoryChainIntentStore({ relayQueue: true });
    const a = pureAttestation(1);
    const first = remedyChainIntent(pureInput(a));
    const pokes: string[] = [];
    const poke = (_g: string, id: string) => pokes.push(id);
    assert.equal((await prepareRemedyIntent(store, first, { poke })).kind, "created");
    /* A retried request or a restart: the same work in the same slot (a different REMEDY signature over the SAME digest
       -- KMS ECDSA is not deterministic -- is the same work). */
    const resigned = remedyChainIntent(pureInput(a, [], { signature: sign(REMEDY_SECRET, remedyDigestV1(a)) }));
    assert.equal(resigned.intent_id, first.intent_id);
    assert.equal((await prepareRemedyIntent(store, resigned, { poke })).kind, "exists");
    assert.deepEqual(pokes, [first.intent_id, first.intent_id]);
    /* Another attestation in the same slot (another attestation time, the same expiry): a hold, never overwritten. */
    const rekeyed = remedyChainIntent(pureInput({ ...a, attested_at: a.attested_at + n(1) }));
    assert.equal(rekeyed.intent_id, first.intent_id);
    assert.deepEqual(await prepareRemedyIntent(store, rekeyed), { kind: "hold", why: "a different attestation occupies this remedy slot" });
    /* While the first can still broadcast: neither a fresh attestation of it nor another decision. */
    const renewal = remedyChainIntent(pureInput({ ...a, attested_at: a.attested_at + n(600), expires_at: a.attested_at + n(1_200) }));
    const otherDecision = remedyChainIntent(pureInput(pureAttestation(2, { defaulting_seat: 0 }), [1, 2]));
    assert.match(JSON.stringify(await prepareRemedyIntent(store, renewal)), /still pending/);
    assert.match(JSON.stringify(await prepareRemedyIntent(store, otherDecision)), /still pending/);
    /* Held WITH a live attempt is still open; held without one was refused for good: it is retired, and the renewal is
       written beside it. */
    await put(store, heldIntent(first, "chain-intent-held", "test", 2));
    const held = (await store.load(GAME_A, first.intent_id)) as ChainIntentRecord;
    assert.equal(held.status, "held");
    assert.equal((await prepareRemedyIntent(store, renewal, { now: 3 })).kind, "created");
    assert.equal((await store.load(GAME_A, first.intent_id))?.status, "superseded", "the held one was retired first");
    assert.match(String((await store.load(GAME_A, first.intent_id))?.superseded?.why), /replaced by a later remedy intent/);
    /* The renewal expires unused (the relayer supersedes it). ANOTHER decision (e.g. the neutral TimeoutAnnul once a
       foreclosure can no longer land) waits until no earlier attestation of this one can land on chain either -- the
       retired first one could, until its expiry, if anyone relayed it (a key or an approval made valid again): until
       the chain's OBSERVED block time reached it (never the server's clock; unread: never). */
    await put(store, supersededIntent((await store.load(GAME_A, renewal.intent_id)) as ChainIntentRecord, "the remedy attestation expired", 4));
    const dead = Number(a.expires_at);
    assert.match(JSON.stringify(await prepareRemedyIntent(store, otherDecision, { now: (dead + 3_600) * 1000 })), new RegExp(`could still land until ${a.expires_at} \\(block time; the chain's block time was not read\\)`));
    assert.match(JSON.stringify(await prepareRemedyIntent(store, otherDecision, { now: (dead + 3_600) * 1000, chainTime: dead - 1 })), new RegExp(`the chain's block time is ${dead - 1}`));
    assert.equal((await prepareRemedyIntent(store, otherDecision, { chainTime: dead })).kind, "created");
    /* Confirmed on chain: nothing more is prepared for the game, and the confirmed slot answers `exists` without a poke. */
    await put(store, confirmedIntent((await store.load(GAME_A, otherDecision.intent_id)) as ChainIntentRecord, "chain-state", null, null, "remedy live_foreclose is on chain", 5));
    const third = remedyChainIntent(pureInput({ ...a, attested_at: a.attested_at + n(3_000), expires_at: a.attested_at + n(3_100) }));
    assert.match(JSON.stringify(await prepareRemedyIntent(store, third)), /already confirmed on chain/);
    pokes.length = 0;
    assert.equal((await prepareRemedyIntent(store, otherDecision, { poke })).kind, "exists");
    assert.deepEqual(pokes, [], "a confirmed intent is not handed to the relayer again");
    assert.equal((await store.listGame(GAME_A)).length, 3);
  });

  test("remedyFence alone: not a remedy intent is a hold; a racing writer's different attestation is a hold, its same work is exists", async () => {
    const a = pureAttestation(4, { defaulting_seat: 0 });
    const record = remedyChainIntent(pureInput(a, [1, 2]));
    const finalize = newChainIntent({ game_id: GAME_A, instance: INSTANCE, key: { op: "finalize", seq: "9" }, subject: { kind: "digest", digests: [] }, op: { kind: "finalize", chain_game_id: "7", seq: "9" }, msg_json: "{}", now: 1 });
    assert.deepEqual(remedyFence([], finalize, null), { kind: "hold", why: "not a remedy intent" });
    assert.deepEqual(remedyFence([finalize], record, null), { kind: "proceed", retire: [] }, "other intents of the game do not fence a remedy");
    /* The same decision attested again never waits on the earlier one's life (whichever lands, it is the same remedy). */
    const expired = supersededIntent(record, "the remedy attestation expired", 2);
    const again = remedyChainIntent(pureInput({ ...a, attested_at: a.attested_at + n(4_000), expires_at: a.attested_at + n(4_600) }, [1, 2]));
    assert.deepEqual(remedyFence([expired], again, null), { kind: "proceed", retire: [] });
    /* The slot is made between the fence's read and the write. */
    const racing = (existing: ChainIntentRecord): ChainIntentStore => {
      const inner = createMemoryChainIntentStore();
      return { ...inner, listGame: async () => [], create: async () => ({ kind: "exists", record: existing, same: existing.intent_id === record.intent_id && JSON.stringify(existing.op) === JSON.stringify(record.op) }) };
    };
    assert.equal((await prepareRemedyIntent(racing(record), record)).kind, "exists");
    const rekeyed = remedyChainIntent(pureInput({ ...a, attested_at: a.attested_at + n(5) }, [1, 2]));
    assert.equal(rekeyed.intent_id, record.intent_id);
    assert.deepEqual(await prepareRemedyIntent(racing(rekeyed), record), { kind: "hold", why: "a different attestation occupies this remedy slot" });
  });
});

/* ================================================================================================= */
/* 5. END TO END OVER THE OFFLINE CHAIN (escrow 2.1.0 semantics)                                       */
/* ================================================================================================= */

interface FakeGameView {
  state: string;
  seats: { wallet: string; consent_pubkey: string }[];
  domain: string | null;
  started_at: number | null;
  policy: string | null;
  remedy: { remedy_digest: string; kind: string } | null;
  outcome: { route: string; amounts: string[]; dust: string } | null;
  settlement: { source: string; payload: { seq: string; payload_digest: string; settlement_weights: string[] } } | null;
  checkpoints: Map<number, unknown>;
}

const gameOf = (world: World, chainGameId: string) => world.chain.games.get(Number(chainGameId)) as unknown as FakeGameView;

/** The chain and the server's clock jump together (a long wait with nothing happening). */
function advanceTo(world: World, secs: number): void {
  const delta = secs - world.chain.time;
  if (delta <= 0) return;
  world.chain.time = secs;
  world.clock.now += delta * 1000;
}

/** The remedy lane's gate, as a test scripts it ("ok" unless a test says the game is in system pause). */
const OPEN_GATE: NonNullable<WorldOptions["remedyGate"]> = async () => ({ kind: "ok" });

async function liveWorld(options: WorldOptions = {}): Promise<{ world: World; chainGameId: string }> {
  const world = makeWorld({ remedyKeys: [REMEDY_PUB], remedyGate: OPEN_GATE, ...options });
  const chainGameId = await startedGame(world, GAME_A, { live_action_clock: {} });
  assert.equal(gameOf(world, chainGameId).policy, "timed_remedy_v1");
  return { world, chainGameId };
}

function attestationFor(world: World, chainGameId: string, remedy: RemedyKindByte, over: Partial<RemedyAttestationV1> = {}): RemedyAttestationV1 {
  const game = gameOf(world, chainGameId);
  const overdue = n(game.started_at as number) + n(1_200);
  const live = remedy <= 3;
  const final = remedy === 3 ? overdue : live ? overdue + n(600) : overdue + n(60);
  return {
    version: 1,
    domain: game.domain as string,
    chain_game_id: BigInt(chainGameId),
    remedy,
    defaulting_seat: 1,
    strike: remedy === 3 ? 3 : live ? 1 : 0,
    overdue_epoch: n(1),
    log_len: n(1),
    log_hash: "ab".repeat(32),
    allowance_secs: live ? n(1_200) : n(86_400),
    overdue_at: overdue,
    final_at: final,
    attested_at: final,
    expires_at: final + n(3_600),
    evidence_hash: "ef".repeat(32),
    remedy_key_id: 1,
    ...over,
  };
}

function intentFor(world: World, chainGameId: string, a: RemedyAttestationV1, approvals: readonly number[] = [], until?: bigint): ChainIntentRecord {
  const game = world.chain.games.get(Number(chainGameId)) as unknown as { seats: { consent_pubkey: string }[]; started_at: number };
  return remedyChainIntent({
    game_id: GAME_A,
    instance: junoInstanceOf(CHAIN_ID, CONTRACT, chainGameId),
    remedy_pubkey: REMEDY_PUB,
    consent_pubkeys: game.seats.map((seat) => seat.consent_pubkey),
    started_at: n(game.started_at),
    attestation: a,
    signature: sign(REMEDY_SECRET, remedyDigestV1(a)),
    approvals: approvalsOf(a, approvals, until),
    now: world.clock.now,
  });
}

async function prepare(world: World, record: ChainIntentRecord): Promise<void> {
  const outcome = await prepareRemedyIntent(world.intents, record, { poke: (gameId, intentId) => world.relayer.poke(gameId, intentId), chainTime: world.chain.time });
  assert.equal(outcome.kind, "created", JSON.stringify(outcome));
}

const statusOf = async (world: World, record: ChainIntentRecord) => (await world.intents.load(GAME_A, record.intent_id))?.status;
const sequenceOf = (world: World) => (world.chain.accounts.get(RELAYER_ADDRESS) as { sequence: bigint }).sequence;

describe("FP4 end to end: the relayer, the remedy intent and an escrow 2.1.0 game", () => {
  test("Live TimeoutAnnul: nothing is sent before 30:00; then it lands once, is confirmed from the chain's own record, and the money game closes; a restart and a re-prepare change nothing", async () => {
    const { world, chainGameId } = await liveWorld();
    const a = attestationFor(world, chainGameId, 1);
    const record = intentFor(world, chainGameId, a);
    await prepare(world, record);
    const sequence = sequenceOf(world);
    await world.relayer.pass();
    await world.relayer.pass();
    assert.equal(await statusOf(world, record), "pending");
    assert.equal(sequenceOf(world), sequence, "nothing signed before finality");
    assert.equal(gameOf(world, chainGameId).state, "in_progress");
    advanceTo(world, Number(a.final_at));
    await world.drive(async () => (await statusOf(world, record)) === "confirmed");
    const game = gameOf(world, chainGameId);
    assert.equal(game.state, "annulled");
    assert.equal(game.outcome?.route, "remedy_timeout_annul");
    assert.deepEqual(game.outcome?.amounts, [NET.toString(), NET.toString()]);
    assert.equal(game.remedy?.remedy_digest, remedyDigestV1(a));
    assert.equal(sequenceOf(world), sequence + BigInt(1), "exactly one transaction");
    await world.drive(async () => (await world.financial.load(GAME_A))?.phase === "closed");
    /* A restart: the confirmed intent stays confirmed; nothing is sent again; a re-prepare is `exists`, a renewal a hold. */
    await world.restart();
    for (let round = 0; round < 3; round += 1) {
      await world.relayer.pass();
      world.chain.produceBlock();
    }
    assert.equal(sequenceOf(world), sequence + BigInt(1));
    assert.equal((await prepareRemedyIntent(world.intents, record)).kind, "exists");
    assert.match(JSON.stringify(await prepareRemedyIntent(world.intents, intentFor(world, chainGameId, { ...a, attested_at: a.attested_at + n(60), expires_at: a.expires_at + n(60) }))), /already confirmed/);
  });

  test("the remedy lane's gate: absent, nothing is ever relayed (fail closed); saying wait (a system pause), nothing is relayed and the attestation dies; a fresh attestation after the resume lands", async () => {
    const closed = await liveWorld({ remedyGate: undefined });
    const a = attestationFor(closed.world, closed.chainGameId, 1);
    const record = intentFor(closed.world, closed.chainGameId, a);
    await prepare(closed.world, record);
    advanceTo(closed.world, Number(a.final_at));
    const sequence = sequenceOf(closed.world);
    for (let round = 0; round < 4; round += 1) {
      await closed.world.relayer.pass();
      closed.world.chain.produceBlock();
      closed.world.clock.now += 60_000;
    }
    assert.equal(await statusOf(closed.world, record), "pending");
    assert.equal(sequenceOf(closed.world), sequence, "no gate: nothing relayed");

    let paused = true;
    const { world, chainGameId } = await liveWorld({ remedyGate: async () => (paused ? { kind: "wait", why: "the table is in system pause" } : { kind: "ok" }) });
    const b = attestationFor(world, chainGameId, 1, {});
    const first = intentFor(world, chainGameId, { ...b, expires_at: b.attested_at + n(600) });
    await prepare(world, first);
    advanceTo(world, Number(b.final_at));
    const before = sequenceOf(world);
    for (let round = 0; round < 3; round += 1) {
      await world.relayer.pass();
      world.chain.produceBlock();
      world.clock.now += 60_000;
    }
    assert.equal(sequenceOf(world), before, "a system-paused table's remedy is not relayed");
    /* The pause outlives the attestation: it dies, never to revive. */
    advanceTo(world, Number(b.attested_at) + 600);
    await world.drive(async () => (await statusOf(world, first)) === "superseded");
    /* The players resumed; the server lane decides the remedy is still final and attests it afresh. */
    paused = false;
    const fresh = { ...b, attested_at: n(world.chain.time), expires_at: n(world.chain.time + 600) };
    const second = intentFor(world, chainGameId, fresh);
    await prepare(world, second);
    await world.drive(async () => (await statusOf(world, second)) === "confirmed");
    assert.equal(gameOf(world, chainGameId).state, "annulled");
    assert.equal(sequenceOf(world), before + BigInt(1));
  });

  test("an attempt signed before a SYSTEM PAUSE but never answered by a node is not handed to a node again while the gate says wait", async () => {
    let paused = false;
    const { world, chainGameId } = await liveWorld({ remedyGate: async () => (paused ? { kind: "wait", why: "the table is in system pause" } : { kind: "ok" }) });
    const a = attestationFor(world, chainGameId, 1);
    const record = intentFor(world, chainGameId, { ...a, expires_at: a.attested_at + n(600) });
    await prepare(world, record);
    advanceTo(world, Number(a.final_at));
    const sequence = sequenceOf(world);
    world.chain.dropNextBroadcast = 1; // signed and journalled, but no node ever received it
    await world.relayer.pass();
    const signed = await world.intents.load(GAME_A, record.intent_id);
    assert.equal(signed?.status, "in-flight", "an attempt was signed and is open");
    const sent = world.chain.broadcasts.length;
    paused = true; // the server restarted: the table is system-paused
    for (let round = 0; round < 4; round += 1) {
      await world.relayer.pass();
      world.chain.produceBlock();
      world.clock.now += 60_000;
    }
    assert.equal(world.chain.broadcasts.length, sent, "the unanswered attempt is withheld while the gate says wait");
    assert.equal(sequenceOf(world), sequence, "nothing landed");
    /* Resumed: the same bytes go out at the next pass (the attempt had not expired). */
    paused = false;
    await world.relayer.pass();
    assert.ok(world.chain.broadcasts.length > sent, "handed to a node once the gate says ok");
  });

  test("a foreclosure refused for good (an approver rotated its consent key after the approval) gives way to the neutral TimeoutAnnul; the money game is not held", async () => {
    const { world, chainGameId } = await liveWorld({ relayerTuning: { failureBudget: 1 } });
    const fore = attestationFor(world, chainGameId, 2, { defaulting_seat: 1 });
    const record = intentFor(world, chainGameId, fore, [0]);
    await prepare(world, record);
    assert.deepEqual(world.chain.setConsentKey(chainGameId, gameOf(world, chainGameId).seats[0].wallet, publicKeyOf(sha("seat-0-rotated")).toString("hex")), { ok: true });
    advanceTo(world, Number(fore.final_at));
    await world.drive(async () => (await statusOf(world, record)) === "held");
    assert.equal(gameOf(world, chainGameId).state, "in_progress");
    assert.notEqual((await world.financial.load(GAME_A))?.phase, "held", "a refused remedy is not a held game");
    /* At 30:00 the overdue was uncured and no VALID N-1 foreclosure exists: the neutral TimeoutAnnul of the same overdue
       -- but only once the refused foreclosure can no longer land: until its attestation expires, the seat rotating its
       key back would make it valid again, and anyone may relay it. */
    const early = attestationFor(world, chainGameId, 1, { defaulting_seat: 1, attested_at: n(world.chain.time), expires_at: n(world.chain.time + 600) });
    assert.match(JSON.stringify(await prepareRemedyIntent(world.intents, intentFor(world, chainGameId, early), { chainTime: world.chain.time })), /could still land until/);
    assert.equal(await statusOf(world, record), "held", "nothing was retired by the refused prepare");
    advanceTo(world, Number(fore.expires_at));
    const annul = attestationFor(world, chainGameId, 1, { defaulting_seat: 1, attested_at: n(world.chain.time), expires_at: n(world.chain.time + 600) });
    const fallback = intentFor(world, chainGameId, annul);
    await prepare(world, fallback);
    assert.equal(await statusOf(world, record), "superseded", "the refused foreclosure was retired");
    await world.drive(async () => (await statusOf(world, fallback)) === "confirmed");
    assert.equal(gameOf(world, chainGameId).outcome?.route, "remedy_timeout_annul");
  });

  test("Live foreclosure (N-1 approvals): waits out a pause, then pays the foreclosure split; a neutral remedy lands while paused", async () => {
    const { world, chainGameId } = await liveWorld();
    const a = attestationFor(world, chainGameId, 2, { defaulting_seat: 1 });
    const record = intentFor(world, chainGameId, a, [0]);
    await prepare(world, record);
    advanceTo(world, Number(a.final_at));
    world.chain.paused = true;
    const sequence = sequenceOf(world);
    for (let round = 0; round < 4; round += 1) {
      await world.relayer.pass();
      world.chain.produceBlock();
      world.clock.now += 6_000;
    }
    assert.equal(await statusOf(world, record), "pending");
    assert.equal(sequenceOf(world), sequence, "a foreclosing remedy is not sent while the escrow is paused");
    world.chain.paused = false;
    await world.drive(async () => (await statusOf(world, record)) === "confirmed");
    const game = gameOf(world, chainGameId);
    assert.equal(game.state, "settled");
    assert.equal(game.outcome?.route, "remedy_foreclosure");
    assert.deepEqual(game.outcome?.amounts, [(NET + NET).toString(), "0"], "seat 0 keeps its net and takes the defaulter's");
    assert.equal(game.outcome?.dust, "0");

    const second = await liveWorld();
    const b = attestationFor(second.world, second.chainGameId, 1);
    const neutral = intentFor(second.world, second.chainGameId, b);
    await prepare(second.world, neutral);
    advanceTo(second.world, Number(b.final_at));
    second.world.chain.paused = true;
    await second.world.drive(async () => (await statusOf(second.world, neutral)) === "confirmed");
    assert.equal(gameOf(second.world, second.chainGameId).state, "annulled", "the neutral TimeoutAnnul lands while paused");
  });

  test("an expired attestation never lands (superseded, nothing sent); a fresh attestation of the same decision does; nothing after it landed", async () => {
    const { world, chainGameId } = await liveWorld();
    const a = attestationFor(world, chainGameId, 1, {});
    const short = { ...a, expires_at: a.attested_at + n(60) };
    const record = intentFor(world, chainGameId, short);
    await prepare(world, record);
    advanceTo(world, Number(short.expires_at));
    const sequence = sequenceOf(world);
    await world.drive(async () => (await statusOf(world, record)) === "superseded");
    assert.equal(sequenceOf(world), sequence, "nothing sent");
    assert.equal(gameOf(world, chainGameId).state, "in_progress");
    const renewed = { ...a, attested_at: n(world.chain.time), expires_at: n(world.chain.time + 600) };
    const renewal = intentFor(world, chainGameId, renewed);
    await prepare(world, renewal);
    await world.drive(async () => (await statusOf(world, renewal)) === "confirmed");
    assert.equal(gameOf(world, chainGameId).remedy?.remedy_digest, remedyDigestV1(renewed));
    assert.equal(sequenceOf(world), sequence + BigInt(1));
    const other = attestationFor(world, chainGameId, 1, { defaulting_seat: 0, attested_at: n(world.chain.time), expires_at: n(world.chain.time + 600) });
    assert.match(JSON.stringify(await prepareRemedyIntent(world.intents, intentFor(world, chainGameId, other))), /already confirmed/);
  });

  test("SEALED APPROVAL FINALITY: a seat's approval horizon passing does NOT end the intent -- a foreclosure held up past it still lands (approvals judged at final_at)", async () => {
    const { world, chainGameId } = await liveWorld();
    const fore = attestationFor(world, chainGameId, 2, { defaulting_seat: 1 });
    const until = fore.final_at + n(120);
    const record = intentFor(world, chainGameId, fore, [0], until);
    assert.equal(record.op.kind === "remedy" && record.op.usable_until, fore.expires_at.toString());
    assert.ok(until < fore.expires_at);
    await prepare(world, record);
    advanceTo(world, Number(fore.final_at));
    world.chain.paused = true; // a foreclosing remedy waits out the pause ...
    const sequence = sequenceOf(world);
    for (let round = 0; round < 3; round += 1) {
      await world.relayer.pass();
      world.chain.produceBlock();
      world.clock.now += 6_000;
    }
    assert.equal(await statusOf(world, record), "pending");
    advanceTo(world, Number(until) + 60); // ... past seat 0's horizon
    world.chain.paused = false;
    await world.drive(async () => (await statusOf(world, record)) === "confirmed");
    assert.equal(gameOf(world, chainGameId).remedy?.remedy_digest, remedyDigestV1(fore));
    assert.equal(sequenceOf(world), sequence + BigInt(1), "sent once");
  });

  test("play went on past the attested position: the remedy is moot (superseded, nothing sent)", async () => {
    const { world, chainGameId } = await liveWorld();
    const a = attestationFor(world, chainGameId, 1);
    const record = intentFor(world, chainGameId, a);
    await prepare(world, record);
    /* A checkpoint at seq 4 (log_len 2) >= 2*1+1: the table kept playing after the attested overdue (a cure). */
    gameOf(world, chainGameId).checkpoints.set(1, {
      payload: { seq: "4", kind: 0, reason: 0, log_len: "2", log_hash: "12".repeat(32), appraisal_log_len: "2", appraisal_state_hash: "34".repeat(32), state_schema_version: 1, settlement_weights: ["1", "1"], signer_key_id: 1, issued_at: String(world.chain.time), payload_digest: "56".repeat(32) },
      accepted_at: world.chain.time,
    });
    advanceTo(world, Number(a.final_at));
    const sequence = sequenceOf(world);
    await world.drive(async () => (await statusOf(world, record)) === "superseded");
    assert.match(String((await world.intents.load(GAME_A, record.intent_id))?.superseded?.why), /passed the attested log position/);
    assert.equal(sequenceOf(world), sequence);
    assert.equal(gameOf(world, chainGameId).state, "in_progress");
  });

  test("another remedy on chain is a contradiction: the intent is held, and so is the money game", async () => {
    const { world, chainGameId } = await liveWorld();
    const a = attestationFor(world, chainGameId, 1);
    const record = intentFor(world, chainGameId, a);
    await prepare(world, record);
    gameOf(world, chainGameId).remedy = { kind: "live_timeout_annul", defaulting_seat: 0, strike: 1, overdue_epoch: "9", log_len: "1", final_at: String(world.chain.time), attested_at: String(world.chain.time), expires_at: String(world.chain.time + 60), remedy_key_id: 1, remedy_digest: "00".repeat(32), approvals_bitmap: 0, accepted_at: world.chain.time } as never;
    await world.drive(async () => (await statusOf(world, record)) === "held");
    assert.equal((await world.intents.load(GAME_A, record.intent_id))?.hold?.code, "chain-inconsistent");
    await world.drive(async () => (await world.financial.load(GAME_A))?.phase === "held");
  });

  test("a third strike stores a challengeable foreclosure that THIS server finalizes after its window (the foreclosure split, never a hold)", async () => {
    const { world, chainGameId } = await liveWorld();
    const a = attestationFor(world, chainGameId, 3, { defaulting_seat: 0 });
    const record = intentFor(world, chainGameId, a);
    await prepare(world, record);
    advanceTo(world, Number(a.final_at));
    await world.drive(async () => (await statusOf(world, record)) === "confirmed");
    const stored = gameOf(world, chainGameId);
    assert.equal(stored.state, "settleable");
    assert.equal(stored.settlement?.source, "remedy_strike3");
    assert.equal(stored.settlement?.payload.payload_digest, remedyDigestV1(a));
    assert.equal(stored.settlement?.payload.seq, "3");
    assert.deepEqual(stored.settlement?.payload.settlement_weights, ["0", "1"]);
    await world.drive(async () => gameOf(world, chainGameId).state === "settled", 60);
    const game = gameOf(world, chainGameId);
    assert.equal(game.outcome?.route, "finalized");
    assert.deepEqual(game.outcome?.amounts, ["0", (NET + NET).toString()]);
    await world.drive(async () => (await world.financial.load(GAME_A))?.phase === "closed");
    assert.equal((await world.financial.load(GAME_A))?.hold, null);
  });

  test("a lost broadcast answer and a restart: the attempt is resolved by its hash, and the remedy is submitted once", async () => {
    const { world, chainGameId } = await liveWorld();
    const a = attestationFor(world, chainGameId, 1);
    const record = intentFor(world, chainGameId, a);
    await prepare(world, record);
    advanceTo(world, Number(a.final_at));
    const sequence = sequenceOf(world);
    world.chain.loseNextBroadcastAnswer = 1;
    await world.relayer.pass();
    const inFlight = await world.intents.load(GAME_A, record.intent_id);
    assert.equal(inFlight?.status, "in-flight");
    await world.restart();
    await world.drive(async () => (await statusOf(world, record)) === "confirmed");
    assert.equal(sequenceOf(world), sequence + BigInt(1), "one transaction, whatever the restart");
    assert.equal(gameOf(world, chainGameId).state, "annulled");
  });

  test("the bind (FP4): a 2.0.0-stored chain game (no exit policy) and an async chain game (no table records its deadline class yet) are refused; a Live action-clock game binds", async () => {
    for (const [name, prepareGame, why] of [
      ["2.0.0-stored", (world: World, id: string) => void ((world.chain.games.get(Number(id)) as unknown as { policy: string | null }).policy = null), /escrow 2\.0\.0 code/],
      ["async", null, /async money table's deadline class/],
    ] as const) {
      const world = makeWorld({ remedyKeys: [REMEDY_PUB], remedyGate: OPEN_GATE });
      const created = await world.service.createMoneyGame(GAME_A);
      assert.ok(created.ok, name);
      const chainGameId = await fundedGame(world, GAME_A, undefined, name === "async" ? { async_pace: { allowance_secs: 86_400 } } : { live_action_clock: {} });
      if (prepareGame !== null) prepareGame(world, chainGameId);
      const bound = await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS);
      assert.equal(bound.ok, false, name);
      assert.match((bound as { detail: string }).detail, why, name);
    }
    /* A seat held by a trusted resolver's wallet: the contract would refuse to start the game, so it is never bound. */
    const seated = makeWorld({ remedyKeys: [REMEDY_PUB], remedyGate: OPEN_GATE, extraResolvers: [WALLETS[1]] });
    assert.ok((await seated.service.createMoneyGame(GAME_A)).ok);
    const seatedId = await fundedGame(seated, GAME_A, undefined, { live_action_clock: {} });
    const refusedBind = await seated.service.bindChainGame(GAME_A, seatedId, VARIANTS);
    assert.equal(refusedBind.ok, false);
    assert.equal((refusedBind as { code: string }).code, "resolver-wallet");
    const world = makeWorld({ remedyKeys: [REMEDY_PUB], remedyGate: OPEN_GATE });
    assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
    const chainGameId = await fundedGame(world, GAME_A, undefined, { live_action_clock: {} });
    assert.equal((await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok, true);
  });
});

/* ================================================================================================= */
/* 6. DEPLOYMENT VERIFICATION                                                                         */
/* ================================================================================================= */

describe("FP4: deployment verification serves escrow 2.1.0 only, and never a REMEDY key this server does not hold", () => {
  const config = () => {
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
        relayer: { address: RELAYER_ADDRESS, signer: { kind: "development", key_file: "/keys/relayer.key" } },
        settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "development", key_file: "/keys/settlement.key" } },
        admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "development", key_file: "/keys/admission.key" } },
        trust: { operators: [RELAYER_ADDRESS], resolvers: [RELAYER_ADDRESS], min_challenge_window_secs: "60", min_liveness_window_secs: "60", min_resolver_timeout_secs: "60" },
        journal_dir: "/journal",
        dev_signer: "allow-unprotected-testnet-key",
      },
      { serverMode: "development", dataDir: "/data" },
    );
    return { ...parsed, trust: { ...parsed.trust, resolvers: ["juno1resolver"] } };
  };

  test("verified on 2.1.0; an escrow 2.0.0 contract (protocol 3's) is a mismatch", async () => {
    const world = makeWorld();
    assert.equal((await verifyJunoDeployment(config(), world.chain)).kind, "verified");
    world.chain.reportedContractVersion = "2.0.0";
    const verdict = await verifyJunoDeployment(config(), world.chain);
    assert.equal(verdict.kind, "mismatch");
    assert.match((verdict as { readonly problems: readonly string[] }).problems.join(" "), /the contract version 2\.0\.0 is not certified here/);
  });

  test("an active REMEDY key is a key this build does not hold: a mismatch until it is retired", async () => {
    const world = makeWorld({ remedyKeys: [REMEDY_PUB] });
    const verdict = await verifyJunoDeployment(config(), world.chain);
    assert.equal(verdict.kind, "mismatch");
    assert.match((verdict as { readonly problems: readonly string[] }).problems.join(" "), /REMEDY registry has active keys this server does not hold: 1/);
    world.chain.remedyKeys[0].retired = true;
    assert.equal((await verifyJunoDeployment(config(), world.chain)).kind, "verified");
  });
});
