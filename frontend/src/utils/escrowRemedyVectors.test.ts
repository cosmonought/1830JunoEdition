/** @jest-environment node */
// frontend/src/utils/escrowRemedyVectors.test.ts
//
// ==================================================================
//  PHASE 3 ESCROW 2.1 (FP4): THE REMEDY ATTESTATION, TYPESCRIPT AGAINST THE FROZEN CROSS-LANGUAGE VECTORS
// ==================================================================
//
// `contracts/escrow/testdata/remedy_vectors_v1.json` was written by an independent Python generator
// (`gen_remedy_vectors.py`) from the specification text; the contract reproduces every byte and EXECUTES every
// replayable vector on chain with the recorded verdict (`tests/remedy_vectors.rs`). Here the TypeScript codec
// (`junoRemedyV1.ts`) reproduces every encoding, preimage, REMEDY digest and REMEDY-APPROVE digest, its wire JSON is the
// vector's, and an INDEPENDENT verifier (@cosmjs/crypto plus the contract's explicit low-s rule) reaches exactly the
// recorded verdict on every remedy-key and seat signature.

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { Secp256k1, Secp256k1Signature } from "@cosmjs/crypto";

import {
  ASYNC_PACES_SECS,
  JUNO_REMEDY_APPROVE_TAG_V1,
  JUNO_REMEDY_TAG_V1,
  LIVE_ACTION_SECS,
  LIVE_CURE_WINDOW_SECS,
  MAX_REMEDY_TTL_SECS,
  REMEDY_ENCODED_LEN,
  REVIEW_DELAY_SECS,
  RemedyInputError,
  encodeRemedyAttestationV1,
  remedyApprovalWire,
  remedyApproveDigestV1,
  remedyApprovePreimageV1,
  remedyAttestationWire,
  remedyDecisionDigestV1,
  remedyDigestV1,
  remedyPreimageV1,
  remedyShapeProblem,
  type RemedyAttestationV1,
  type RemedyKindByte,
} from "../gameEngine/escrow/junoRemedyV1";

const FILE = join(__dirname, "..", "..", "..", "contracts", "escrow", "testdata", "remedy_vectors_v1.json");
const FILE_SHA256 = "6613f137eaa07cfd20a70aa4d52a7db5588cf0ef8782a2247261750c1d2b191a";
const SECP_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

interface Approval {
  seat_index: number;
  approve_until: string;
  preimage: string;
  digest: string;
  signed_digest: string;
  signature: string;
  signature_verifies: boolean;
}
interface Vector {
  name: string;
  game: string;
  replay: boolean;
  attestation: Record<string, string | number>;
  encoding: string;
  preimage: string;
  digest: string;
  signature: string;
  signature_verifies: boolean;
  approvals: Approval[];
  valid: boolean;
  expect: string;
}

const raw = readFileSync(FILE);
const doc = JSON.parse(raw.toString("utf8")) as {
  format: string;
  tag: string;
  approve_tag: string;
  keys: { remedy: { pubkey: string }; seats: { pubkey: string }[] };
  vectors: Vector[];
};
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

const attestationOf = (v: Vector): RemedyAttestationV1 => {
  const a = v.attestation;
  return {
    version: a.version as 1,
    domain: a.domain as string,
    chain_game_id: BigInt(a.chain_game_id as string),
    remedy: a.remedy as RemedyKindByte,
    defaulting_seat: a.defaulting_seat as number,
    strike: a.strike as number,
    overdue_epoch: BigInt(a.overdue_epoch as string),
    log_len: BigInt(a.log_len as string),
    log_hash: a.log_hash as string,
    allowance_secs: BigInt(a.allowance_secs as string),
    overdue_at: BigInt(a.overdue_at as string),
    final_at: BigInt(a.final_at as string),
    attested_at: BigInt(a.attested_at as string),
    expires_at: BigInt(a.expires_at as string),
    evidence_hash: a.evidence_hash as string,
    remedy_key_id: a.remedy_key_id as number,
  };
};

/** The contract's rule, checked independently: 64 bytes, low-s, ECDSA over the digest itself. */
async function contractVerdict(pubkeyHex: string, digestHex: string, sigHex: string): Promise<boolean> {
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return false;
  const s = BigInt(`0x${sigHex.slice(64)}`);
  const r = BigInt(`0x${sigHex.slice(0, 64)}`);
  if (r === BigInt(0) || s === BigInt(0) || r >= SECP_N || s >= SECP_N || s > SECP_N / BigInt(2)) return false;
  return Secp256k1.verifySignature(Secp256k1Signature.fromFixedLength(bytes(sigHex)), bytes(digestHex), bytes(pubkeyHex));
}

describe("FP4: the frozen remedy vectors", () => {
  it("the file is the frozen one, and the policy constants are the contract's", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(FILE_SHA256);
    expect(doc.format).toBe("18JUNO/REMEDY/vectors/v1");
    expect(doc.tag).toBe(JUNO_REMEDY_TAG_V1);
    expect(doc.approve_tag).toBe(JUNO_REMEDY_APPROVE_TAG_V1);
    expect(doc.vectors).toHaveLength(41);
    expect(doc.vectors.filter((v) => v.valid).map((v) => v.name)).toEqual(["live-timeout-annul", "live-foreclose", "live-strike3", "async-annul", "async-foreclose", "reattested-foreclose", "approval-last-second"]);
    expect([LIVE_ACTION_SECS, LIVE_CURE_WINDOW_SECS, REVIEW_DELAY_SECS, MAX_REMEDY_TTL_SECS]).toEqual([1200, 600, 604800, 3600]);
    expect([...ASYNC_PACES_SECS]).toEqual([43200, 86400, 172800, 259200, 604800]);
  });

  it.each(doc.vectors.map((v) => [v.name, v] as const))("%s: encoding, preimage, digest, wire, approvals and every signature verdict", async (_, v) => {
    const a = attestationOf(v);
    const enc = encodeRemedyAttestationV1(a);
    expect(enc).toHaveLength(REMEDY_ENCODED_LEN);
    expect(hexOf(enc)).toBe(v.encoding);
    expect(hexOf(remedyPreimageV1(a))).toBe(v.preimage);
    expect(remedyDigestV1(a)).toBe(v.digest);
    expect(createHash("sha256").update(Buffer.from(v.preimage, "hex")).digest("hex")).toBe(v.digest);
    expect(remedyAttestationWire(a)).toEqual(v.attestation);
    expect(await contractVerdict(doc.keys.remedy.pubkey, v.digest, v.signature)).toBe(v.signature_verifies);
    for (const approval of v.approvals) {
      const until = BigInt(approval.approve_until);
      expect(hexOf(remedyApprovePreimageV1(a, until, approval.seat_index))).toBe(approval.preimage);
      expect(remedyApproveDigestV1(a, until, approval.seat_index)).toBe(approval.digest);
      expect(remedyApprovalWire({ seat_index: approval.seat_index, approve_until: until, signature: approval.signature.length === 128 ? approval.signature : "00".repeat(64) }).approve_until).toBe(approval.approve_until);
      expect(await contractVerdict(doc.keys.seats[approval.seat_index].pubkey, approval.digest, approval.signature)).toBe(approval.signature_verifies);
    }
  });

  it("the valid vectors pass the shape rules; the decision identity ignores only the attestation time, the expiry and the key id", () => {
    for (const v of doc.vectors.filter((x) => x.valid)) expect(remedyShapeProblem(attestationOf(v))).toBeNull();
    const base = attestationOf(doc.vectors[0]);
    const decision = remedyDecisionDigestV1(base);
    expect(remedyDecisionDigestV1({ ...base, expires_at: base.expires_at + BigInt(60) })).toBe(decision);
    expect(remedyDecisionDigestV1({ ...base, attested_at: base.attested_at + BigInt(7_200) })).toBe(decision);
    expect(remedyDecisionDigestV1({ ...base, remedy_key_id: 2 })).toBe(decision);
    /* The re-attested foreclosure is the live-foreclose decision. */
    const byName = (name: string) => attestationOf(doc.vectors.find((v) => v.name === name) as Vector);
    expect(remedyDecisionDigestV1(byName("reattested-foreclose"))).toBe(remedyDecisionDigestV1(byName("live-foreclose")));
    for (const change of [{ defaulting_seat: 1 }, { strike: 2 }, { overdue_epoch: BigInt(8) }, { log_len: BigInt(1) }, { overdue_at: base.overdue_at - BigInt(1) }, { final_at: base.final_at + BigInt(1) }, { evidence_hash: "00".repeat(32) }, { remedy: 2 as RemedyKindByte }]) {
      expect(remedyDecisionDigestV1({ ...base, ...change })).not.toBe(decision);
    }
    expect(decision).not.toBe(remedyDigestV1(base));
  });

  it("the shape rules refuse what the contract refuses on shape alone", () => {
    const live = attestationOf(doc.vectors[0]);
    expect(remedyShapeProblem({ ...live, strike: 3 })).toMatch(/strike/);
    expect(remedyShapeProblem({ ...live, overdue_at: live.overdue_at + BigInt(1) })).toMatch(/10 minutes/);
    /* A pause froze the cure window: final later than 30:00 is a valid shape (the attestation time follows it). */
    expect(remedyShapeProblem({ ...live, overdue_at: live.overdue_at - BigInt(300) })).toBeNull();
    expect(remedyShapeProblem({ ...live, attested_at: live.final_at - BigInt(1) })).toMatch(/attested_at precedes final_at/);
    expect(remedyShapeProblem({ ...live, expires_at: live.attested_at })).toMatch(/after attested_at/);
    expect(remedyShapeProblem({ ...live, expires_at: live.attested_at + BigInt(MAX_REMEDY_TTL_SECS + 1) })).toMatch(/TTL/);
    expect(remedyShapeProblem({ ...live, allowance_secs: BigInt(1201) })).toMatch(/20-minute/);
    const asyncV = attestationOf(doc.vectors.find((v) => v.name === "async-annul") as Vector);
    expect(remedyShapeProblem({ ...asyncV, allowance_secs: BigInt(3600) })).toMatch(/paces/);
    expect(remedyShapeProblem({ ...asyncV, final_at: asyncV.overdue_at - BigInt(1) })).toMatch(/before the overdue/);
    expect(remedyShapeProblem({ ...live, remedy: 7 as RemedyKindByte })).toMatch(/unknown/);
  });

  it("out-of-range fields are refused, never truncated", () => {
    const a = attestationOf(doc.vectors[0]);
    expect(() => encodeRemedyAttestationV1({ ...a, chain_game_id: BigInt(-1) })).toThrow(RemedyInputError);
    expect(() => encodeRemedyAttestationV1({ ...a, overdue_epoch: (BigInt(1) << BigInt(64)) })).toThrow(RemedyInputError);
    expect(() => encodeRemedyAttestationV1({ ...a, defaulting_seat: 256 })).toThrow(RemedyInputError);
    expect(() => encodeRemedyAttestationV1({ ...a, remedy_key_id: 65536 })).toThrow(RemedyInputError);
    expect(() => encodeRemedyAttestationV1({ ...a, domain: "AB".repeat(32) })).toThrow(RemedyInputError);
    expect(() => encodeRemedyAttestationV1({ ...a, log_hash: "ab".repeat(31) })).toThrow(RemedyInputError);
    expect(() => remedyApproveDigestV1(a, BigInt(1), 7.5)).toThrow(RemedyInputError);
    expect(() => remedyApproveDigestV1(a, BigInt(-1), 0)).toThrow(RemedyInputError);
    expect(() => remedyApprovalWire({ seat_index: 0, approve_until: BigInt(1) << BigInt(64), signature: "00".repeat(64) })).toThrow(RemedyInputError);
    expect(() => remedyApprovalWire({ seat_index: 0, approve_until: BigInt(1), signature: "AB".repeat(64) })).toThrow(RemedyInputError);
  });
});
