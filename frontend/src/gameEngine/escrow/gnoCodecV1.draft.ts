// frontend/src/gameEngine/escrow/gnoCodecV1.draft.ts
//
// ==================================================================
//  GNOLAND-1: THE GNO CODEC SHAPE -- DECLARED, NOT IMPLEMENTED (GNOLAND-2 freezes its bytes)
// ==================================================================
//
// This file proves the interface can carry GNOLAND-0's Gno divergences without touching Juno v1: a separate tag
// namespace, a domain that names the realm (package path AND derived address) instead of a contract address,
// seat-bound CONSENT and ANNUL digests, a key-possession extension, and Ed25519 for both the settlement key and the
// consent keys. It produces NO bytes: every byte-producing method refuses with NOT_IMPLEMENTED until GNOLAND-2
// freezes the Gno vectors (independently generated, like SET-0C's), so no draft digest can ever be signed, stored or
// compared by accident. The layouts below are GNOLAND-0 §4's, recorded as the starting point, not as a freeze.

import {
  refuseInterface,
  type CodecCommitment,
  type CodecDigest,
  type DomainBinding,
  type EscrowCodec,
  type KeyPossessionInput,
} from "./escrowCodec";

/** GNOLAND-0 §4 tag namespace (draft). Distinct from every `18JUNO/*` tag by construction. */
export const GNO_TAGS_V1_DRAFT = Object.freeze({
  SETTLE: "18GNO/SETTLE/v1",
  CONSENT: "18GNO/CONSENT/v1",
  ANNUL: "18GNO/ANNUL/v1",
  DOMAIN: "18GNO/DOMAIN/v1",
  ROSTER: "18GNO/ROSTER/v1",
  KEYPOP: "18GNO/KEYPOP/v1",
} as const);

/**
 * Draft Gno domain inputs (GNOLAND-0 §4):
 *   SHA-256("18GNO/DOMAIN/v1" ‖ u16 len ‖ chain_id ‖ u16 len ‖ realm_pkgpath ‖ u16 len ‖ realm_address ‖
 *           u64 chain_game_id ‖ roster_hash ‖ u32 rules_engine_version ‖ variants_digest ‖ u128 ante_gross ‖ u8 mode)
 * Draft CONSENT: SHA-256("18GNO/CONSENT/v1" ‖ domain ‖ u64 seq ‖ settle ‖ u8 seat_index).
 * Draft ANNUL:   SHA-256("18GNO/ANNUL/v1" ‖ domain ‖ u64 trusted_seq ‖ u8 seat_index).
 * Draft KEYPOP:  Ed25519 over "18GNO/KEYPOP/v1" ‖ realm_path ‖ u64 chain_game_id ‖ wallet ‖ pubkey.
 */
export interface GnoDomainInputsDraft {
  chain_id: string;
  realm_pkgpath: string;
  realm_address: string;
  chain_game_id: bigint;
  roster_hash: string;
  rules_engine_version: number;
  variants_digest: string;
  /** In ugnot; the realm's coin amounts are int64 (GNOLAND-0 §5), so the pool bound is 2^63 − 1. */
  ante_gross: bigint;
  mode: number;
}

const notYet = (what: string): never =>
  refuseInterface("NOT_IMPLEMENTED", `the Gno codec's ${what} is not frozen; GNOLAND-2 owns the Gno vector freeze`);

export const GNO_CODEC_V1_DRAFT: EscrowCodec<GnoDomainInputsDraft> = Object.freeze({
  id: "18GNO/v1" as const,
  backend: "gno-realm" as const,
  maturity: "draft" as const,
  settlementScheme: "ed25519-pure/sig64" as const,
  consentScheme: "ed25519-pure/sig64" as const,
  consentBindsSeat: true,
  annulBindsSeat: true,
  canonicalAddress(): string {
    return notYet("address rule (bech32 g1…, normalisation)");
  },
  rosterHash(): CodecCommitment<"roster"> {
    return notYet("ROSTER commitment");
  },
  bindDomain(): DomainBinding<GnoDomainInputsDraft> {
    return notYet("DOMAIN");
  },
  settleDigest(): CodecDigest<"settle"> {
    return notYet("SETTLE digest");
  },
  consentDigest(): CodecDigest<"consent"> {
    return notYet("seat-bound CONSENT digest");
  },
  annulDigest(): CodecDigest<"annul"> {
    return notYet("seat-bound ANNUL digest");
  },
  extensions: Object.freeze({
    keyPossession: (_input: KeyPossessionInput): CodecDigest<"keypop"> => notYet("KEYPOP"),
  }),
});
