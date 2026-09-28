// frontend/src/gameEngine/escrow/variantsDigest.ts
//
// ==================================================================
//  ESCROW-3B (GNOLAND-1 F7): THE ONE VARIANTS DIGEST A MONEY GAME'S DOMAIN BINDS
// ==================================================================
//
// `CreateGame.variants_digest` (32 bytes) is hashed into the settlement domain, so every signed payload of a money game
// commits to the table's variants. This is the ONE function that computes it, shared by the server (which checks the
// chain game against the room's variants when it binds the game, and again at the deal) and by the client (ESCROW-4,
// which checks the WalletRequest the server hands its wallet):
//
//   variantsDigestV1(variants) = SHA-256("18COSMOS/VARIANTS/v1\n" ‖ canonicalJson(variants))
//
// `canonicalJson` is the state digest's canonical text (keys sorted, `undefined` omitted, no whitespace), so two builds
// that spell the same variants object differently agree. A new meaning gets a new tag (`/v2`), never a new reading of
// this one. Pure; no chain concept; not part of the frozen settlement bytes (the contract treats the digest as opaque).

import { sha256HexOfBytes, utf8Bytes } from "../sha256";
import { canonicalJson } from "../stateDigest";

export const VARIANTS_DIGEST_TAG_V1 = "18COSMOS/VARIANTS/v1\n";

export function variantsDigestV1(variants: unknown): string {
  if (typeof variants !== "object" || variants === null || Array.isArray(variants)) throw new Error("variantsDigestV1: the variants are not an object");
  return sha256HexOfBytes(utf8Bytes(`${VARIANTS_DIGEST_TAG_V1}${canonicalJson(variants)}`));
}
