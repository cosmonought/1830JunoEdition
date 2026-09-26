// server/src/identity/ids.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §3.2): THE FROZEN IDENTIFIERS
// ==================================================================
//
//   principal_id   `pr_` + 26 lowercase Crockford base32 characters of 16 bytes from `crypto.randomBytes` (128 bits)
//   session_id     `se_` + the same encoding (the SELECTOR -- a lookup key, not a credential)
//   secret         32 bytes from `crypto.randomBytes`, base64url without padding (43 characters, 256 bits). The
//                  VERIFIER: it travels only inside the cookie, and the store keeps only SHA-256 of its 32 bytes.
//
// CANONICAL OR NOTHING. 128 bits in 26 base32 symbols leaves two padding bits in the last symbol, and 256 bits in
// 43 base64url symbols leaves two in the last one too; a decoder that ignored them would accept four spellings of
// one id. The patterns below admit only the spelling the encoder produces, so an id has exactly one form on the
// wire, in the store and in every index (LIVE-2B §3: "ambiguous encodings" fail closed).
//
// No ULID, no timestamp, no counter: an id says nothing about when or where it was minted (LIVE-2 §3.2).

import { createHash, randomBytes, timingSafeEqual } from "crypto";

/** Lowercase Crockford base32: no i, l, o, u. */
export const CROCKFORD_LOWER = "0123456789abcdefghjkmnpqrstvwxyz";

/** `bytes` as lowercase Crockford base32, most significant bit first, the last symbol zero-padded. */
export function base32Lower(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_LOWER[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD_LOWER[(buffer << (5 - bits)) & 31];
  return out;
}

/** 25 free symbols, then a last symbol whose two padding bits are zero. */
const ID_BODY = "[0-9a-hjkmnp-tv-z]{25}[048cgmrw]";
export const PRINCIPAL_ID_PATTERN = new RegExp(`^pr_${ID_BODY}$`);
export const SESSION_ID_PATTERN = new RegExp(`^se_${ID_BODY}$`);
/** 42 free symbols, then a last symbol whose two padding bits are zero. */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const SECRET_BYTES = 32;
export const ID_BYTES = 16;

export type RandomSource = (size: number) => Buffer;
export const cryptoRandom: RandomSource = (size) => randomBytes(size);

export const mintPrincipalId = (random: RandomSource = cryptoRandom): string => `pr_${base32Lower(random(ID_BYTES))}`;
export const mintSessionId = (random: RandomSource = cryptoRandom): string => `se_${base32Lower(random(ID_BYTES))}`;
export const mintSecret = (random: RandomSource = cryptoRandom): string => random(SECRET_BYTES).toString("base64url");

/** The secret's 32 bytes, or `null` for anything that is not the canonical 43-symbol spelling of exactly 32. */
export function secretBytes(secret: string): Buffer | null {
  if (!SECRET_PATTERN.test(secret)) return null;
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.length !== SECRET_BYTES || bytes.toString("base64url") !== secret) return null;
  return bytes;
}

/** What the store keeps: hex SHA-256 of the secret's 32 bytes. Never the secret. */
export function secretHash(secret: string): string {
  const bytes = secretBytes(secret);
  if (bytes === null) throw new Error("not a session secret");
  return createHash("sha256").update(bytes).digest("hex");
}

const HEX_DIGEST = /^[0-9a-f]{64}$/;

/** LIVE-2 §3.4: SHA-256 the offered secret and compare the two 32-byte digests in constant time. */
export function secretMatches(offered: string, storedHash: string): boolean {
  const bytes = secretBytes(offered);
  if (bytes === null || !HEX_DIGEST.test(storedHash)) return false;
  const digest = createHash("sha256").update(bytes).digest();
  return timingSafeEqual(digest, Buffer.from(storedHash, "hex"));
}

/** Mint an id that `taken` does not already hold. 128 random bits do not collide in the life of the service;
 *  a collision therefore means a broken random source, and after five the mint refuses rather than loops. */
export function mintUnique(mint: () => string, taken: (id: string) => boolean, attempts = 5): string {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const id = mint();
    if (!taken(id)) return id;
  }
  throw new Error(`identity: ${attempts} consecutive id collisions -- the random source is not random`);
}
