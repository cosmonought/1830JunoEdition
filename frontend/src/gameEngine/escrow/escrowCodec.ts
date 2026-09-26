// frontend/src/gameEngine/escrow/escrowCodec.ts
//
// ==================================================================
//  GNOLAND-1: THE BACKEND CODEC SEAM (types only, plus the tagged-digest guard)
// ==================================================================
//
// WHAT A CODEC OWNS. Everything that makes a settlement verifiable on ONE backend and on no other: the address rule
// the backend stores seats under, the roster commitment, the settlement DOMAIN (chain id + deployment identity +
// game terms), the digest tags (SETTLE / CONSENT / ANNUL, and any backend extension such as a key-possession proof),
// and which signature scheme signs which digest. It owns no semantics: the payload's fields, the 136 + 16·n layout,
// seq, kind/reason coupling, A1, the appraisal, the weights and the payout arithmetic are SettlementCoreV1's
// (settlementCoreV1.ts), identical for every backend.
//
// WHY DIGESTS ARE TAGGED OBJECTS, NOT HEX STRINGS. A 32-byte hex string cannot say which backend's tag produced it,
// so a Juno settle digest passed to a Gno consent function (or signed by a Gno key) would be indistinguishable from a
// correct one. Every digest a codec returns is a frozen `{codec, purpose, hex}`; a codec refuses a digest whose
// `codec` is not its own, and a signer refuses a digest whose codec its key does not serve. Cross-backend replay is
// already impossible ON CHAIN (different domain, tags and curves -- GNOLAND-0 §4); the tag makes the server refuse
// the mistake before it spends a KMS call or a transaction on it.
//
// NO I/O. A codec is deterministic and synchronous: it never reads a chain, a clock or a key.

import type { SettlementDomainInputs } from "../settlementPayload";

/** The backends the interface knows. The string is persisted (EscrowBinding v2), so it never changes meaning. */
export type EscrowBackendKind = "juno-cosmwasm" | "gno-realm";

/**
 * A codec's identity: tag namespace + codec version. `18JUNO/v1` is SET-0C / ESCROW-2.x, certified and frozen.
 * `18GNO/v1` is GNOLAND-0's draft; GNOLAND-2 freezes its bytes (until then its codec refuses to produce any).
 */
export type EscrowCodecId = "18JUNO/v1" | "18GNO/v1";

/**
 * A signature scheme, named by everything a verifier must agree on. Never "the chain's default": the scheme is part
 * of every signature object, and a signature carrying one scheme is never checked under another.
 *
 *  - `secp256k1-ecdsa-prehashed/rs64-low-s`: ECDSA over secp256k1 whose message hash IS the 32-byte codec digest (no
 *    second hash), encoded as 64 bytes r‖s with s ≤ n/2; public keys are 33-byte compressed SEC1. This is what the
 *    Juno contract's `secp256k1_verify(digest, sig, pubkey)` accepts (ESCROW-2 `crypto.rs`). AWS KMS returns DER over
 *    a DIGEST-mode request; the Juno signer converts DER → r‖s and normalises s (never the codec's job).
 *  - `ed25519-pure/sig64`: RFC 8032 Ed25519 with the 32-byte codec digest as the MESSAGE (pure, not Ed25519ph);
 *    32-byte public keys; 64-byte signatures. GNOLAND-0 §3 / OD-GNO-1 (KMS `ED25519_SHA_512`, message type RAW).
 */
export type SignatureSchemeId = "secp256k1-ecdsa-prehashed/rs64-low-s" | "ed25519-pure/sig64";

/** What a digest is for. SETTLE is signed by the settlement key; CONSENT and ANNUL by a seat's consent key. */
export type DigestPurpose = "settle" | "consent" | "annul" | "keypop";
/** What a commitment binds (hashed into the domain / compared on chain, never signed on its own). */
export type CommitmentPurpose = "domain" | "roster";

/** A 32-byte digest, stamped with the codec that produced it and what it is for. Frozen. */
export interface CodecDigest<P extends DigestPurpose = DigestPurpose> {
  readonly codec: EscrowCodecId;
  readonly purpose: P;
  /** 32 bytes, lowercase hex. */
  readonly hex: string;
}

/** A 32-byte commitment (domain, roster), stamped like a digest. */
export interface CodecCommitment<P extends CommitmentPurpose = CommitmentPurpose> {
  readonly codec: EscrowCodecId;
  readonly purpose: P;
  readonly hex: string;
}

/** A backend's domain inputs after the codec has read them ONCE (own data fields only, into a frozen copy) and
 *  hashed them: the builder compares from this one copy, never from the caller's object again. */
export interface DomainBinding<I> {
  readonly inputs: Readonly<I>;
  readonly domain: CodecCommitment<"domain">;
  /** The roster commitment the inputs carry (32 bytes, lowercase hex). */
  readonly roster_hash: string;
  /** The rules engine the domain declares (u32): must equal the appraised board's pin. */
  readonly rules_engine_version: number;
}

/** GNOLAND-2 extension seam: the Gno key-possession proof (GNOLAND-0 `18GNO/KEYPOP/v1`). Juno v1 has none. */
export interface KeyPossessionInput {
  readonly deployment: string;
  readonly chain_game_id: bigint;
  readonly wallet: string;
  readonly public_key_hex: string;
}

/**
 * The backend codec. Juno: `JUNO_CODEC_V1` (junoCodecV1.ts), a pure delegation to the certified SET-0C functions.
 * Gno: `GNO_CODEC_V1_DRAFT` (gnoCodecV1.draft.ts), a declared shape whose byte-producing methods refuse until
 * GNOLAND-2 freezes them.
 */
export interface EscrowCodec<I = unknown> {
  readonly id: EscrowCodecId;
  readonly backend: EscrowBackendKind;
  /** `certified`: bytes frozen and cross-checked (Rust/Python/TS). `draft`: shape declared, bytes refused. */
  readonly maturity: "certified" | "draft";
  /** The scheme the settlement (operator/notary) key signs SETTLE digests with. */
  readonly settlementScheme: SignatureSchemeId;
  /** The scheme each seat's consent key signs CONSENT and ANNUL digests with. */
  readonly consentScheme: SignatureSchemeId;
  /**
   * Whether the CONSENT digest itself names the seat. Juno v1: NO -- the seat is bound by the per-seat consent key,
   * which ESCROW-2.x keeps unique within a game (`ConsentKeyInUse`), so one seat's signature can never count for
   * another. Gno v1 (draft): YES (GNOLAND-0 §3.3 adds `u8 seat_index`). Callers never rely on either: they always
   * pass the seat and the codec decides whether it is hashed.
   */
  readonly consentBindsSeat: boolean;
  /** The same question for ANNUL. */
  readonly annulBindsSeat: boolean;

  /** The address exactly as the backend stores a seat (refuses any other spelling: it would hash differently). */
  canonicalAddress(value: unknown, where: string): string;
  /** The roster commitment over the seat addresses in chain seat order. */
  rosterHash(addresses: readonly string[]): CodecCommitment<"roster">;
  /** Reads the backend's domain inputs once and hashes them. */
  bindDomain(raw: unknown): DomainBinding<I>;
  /** SETTLE digest over an already-encoded SettlementCoreV1 payload (lowercase hex in). */
  settleDigest(encodedHex: string): CodecDigest<"settle">;
  /** CONSENT digest for one seat's fast consent. `settle` must be THIS codec's settle digest. */
  consentDigest(args: {
    readonly domain: string;
    readonly seq: bigint;
    readonly settle: CodecDigest<"settle">;
    readonly seat_index: number;
    readonly seat_count: number;
  }): CodecDigest<"consent">;
  /** ANNUL digest over the game's TRUSTED sequence (ESCROW-2.1 OD-ESC2-3), never the raw last_seq. */
  annulDigest(args: {
    readonly domain: string;
    readonly trusted_seq: bigint;
    readonly seat_index: number;
    readonly seat_count: number;
  }): CodecDigest<"annul">;
  /** Backend-only additions. Present only where the backend defines them; absent is a capability, not an error. */
  readonly extensions: Readonly<{ keyPossession?: (input: KeyPossessionInput) => CodecDigest<"keypop"> }>;
}

/** The Juno codec's domain inputs are exactly SET-0C's (`crypto::DomainInputs`). */
export type JunoDomainInputs = SettlementDomainInputs;

/* ------------------------------------------------------------------ */
/* The interface's own refusals                                        */
/* ------------------------------------------------------------------ */

export type EscrowInterfaceErrorCode =
  /** A digest, commitment or signature produced for one codec was handed to another. */
  | "CODEC_MISMATCH"
  /** A signature's scheme is not the scheme this key / codec / purpose uses. */
  | "SCHEME_MISMATCH"
  /** A digest of the wrong purpose (e.g. a CONSENT digest offered for settlement signing). */
  | "PURPOSE_MISMATCH"
  /** A draft backend asked to produce bytes GNOLAND-2 has not frozen, or a stub asked to do I/O. */
  | "NOT_IMPLEMENTED"
  /** An EscrowBinding that fails its structural or identity rules. */
  | "BINDING_INVALID"
  | "SEAT_INDEX_OUT_OF_RANGE"
  /** Settlement-key selection could not find exactly one key for the binding (never falls back). */
  | "SIGNER_SELECTION_REFUSED"
  /** A capability the operation needs is absent on this backend (never emulated silently). */
  | "UNSUPPORTED_CAPABILITY";

export class EscrowInterfaceError extends Error {
  readonly code: EscrowInterfaceErrorCode;
  readonly detail: string;

  constructor(code: EscrowInterfaceErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "EscrowInterfaceError";
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, EscrowInterfaceError.prototype);
  }
}

export const refuseInterface = (code: EscrowInterfaceErrorCode, detail: string): never => {
  throw new EscrowInterfaceError(code, detail);
};

const HEX32 = /^[0-9a-f]{64}$/;

/** Stamps a digest. The hex must already be 32 lowercase bytes (it always is: it comes from a SET-0C digest). */
export function codecDigest<P extends DigestPurpose>(codec: EscrowCodecId, purpose: P, hex: string): CodecDigest<P> {
  if (!HEX32.test(hex)) throw new Error(`codecDigest invariant broken: ${purpose} digest is not 32-byte lowercase hex`);
  return Object.freeze({ codec, purpose, hex });
}

export function codecCommitment<P extends CommitmentPurpose>(codec: EscrowCodecId, purpose: P, hex: string): CodecCommitment<P> {
  if (!HEX32.test(hex)) throw new Error(`codecCommitment invariant broken: ${purpose} is not 32-byte lowercase hex`);
  return Object.freeze({ codec, purpose, hex });
}

/** Refuses a digest that is not exactly `{codec, purpose, hex}` of the expected codec and purpose. */
export function requireDigest<P extends DigestPurpose>(value: unknown, codec: EscrowCodecId, purpose: P, where: string): CodecDigest<P> {
  if (typeof value !== "object" || value === null) return refuseInterface("CODEC_MISMATCH", `${where} is not a codec digest`);
  const digest = value as Partial<CodecDigest>;
  if (digest.codec !== codec) return refuseInterface("CODEC_MISMATCH", `${where} was produced by ${String(digest.codec)}, not ${codec}`);
  if (digest.purpose !== purpose) return refuseInterface("PURPOSE_MISMATCH", `${where} is a ${String(digest.purpose)} digest, not ${purpose}`);
  if (typeof digest.hex !== "string" || !HEX32.test(digest.hex)) return refuseInterface("CODEC_MISMATCH", `${where} carries no 32-byte digest`);
  return digest as CodecDigest<P>;
}

/** A seat index for a digest: an integer in [0, seat_count), seat_count in 2..7 (the contract's roster bound). */
export function requireSeatIndex(seatIndex: unknown, seatCount: unknown, where: string): number {
  if (typeof seatCount !== "number" || !Number.isInteger(seatCount) || seatCount < 2 || seatCount > 7) {
    return refuseInterface("SEAT_INDEX_OUT_OF_RANGE", `${where}: seat_count ${String(seatCount)} is not 2..7`);
  }
  if (typeof seatIndex !== "number" || !Number.isInteger(seatIndex) || Object.is(seatIndex, -0) || seatIndex < 0 || seatIndex >= seatCount) {
    return refuseInterface("SEAT_INDEX_OUT_OF_RANGE", `${where}: seat_index ${String(seatIndex)} is not in 0..${seatCount - 1}`);
  }
  return seatIndex;
}
