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
/** LIVE-2E: a profile's private id -- never on the wire, in a RoomView, a log, a URL or a chain. */
export const PROFILE_ID_PATTERN = new RegExp(`^pf_${ID_BODY}$`);
/** LIVE-2E: a recovery key's SELECTOR (a lookup key, 128 bits, so it cannot be enumerated). */
export const RECOVERY_SELECTOR_PATTERN = new RegExp(`^rk_${ID_BODY}$`);
/** 42 free symbols, then a last symbol whose two padding bits are zero. */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const SECRET_BYTES = 32;
export const ID_BYTES = 16;

export type RandomSource = (size: number) => Buffer;
export const cryptoRandom: RandomSource = (size) => randomBytes(size);

export const mintPrincipalId = (random: RandomSource = cryptoRandom): string => `pr_${base32Lower(random(ID_BYTES))}`;
export const mintSessionId = (random: RandomSource = cryptoRandom): string => `se_${base32Lower(random(ID_BYTES))}`;
export const mintSecret = (random: RandomSource = cryptoRandom): string => random(SECRET_BYTES).toString("base64url");
export const mintProfileId = (random: RandomSource = cryptoRandom): string => `pf_${base32Lower(random(ID_BYTES))}`;
export const mintRecoverySelector = (random: RandomSource = cryptoRandom): string => `rk_${base32Lower(random(ID_BYTES))}`;

/* ==================================================================
    ESCROW-3A (IR-03): A SESSION FAMILY -- ONE BROWSER'S ROTATION LINEAGE
   ==================================================================
   A family is named after the session that FOUNDED it (a bootstrap, a recovery, a link): every rotation successor and
   every grace successor minted from a member inherits it. The id is derived, not drawn -- `sf_` + the first 128 bits
   of SHA-256 over a domain tag and the founding session id -- so minting a family consumes no randomness (seeded tests
   keep their ids), a legacy v3 session's family is re-derived identically by every load that migrates it, and it is
   exactly as unguessable as the random session id it is named after. PRIVATE, like every `se_`/`pr_`/`pf_` id: never on
   the wire, in a RoomView, a log, a hold, an audit line or a chain. It is not an identity: it names one cookie jar's
   lineage so a sign-out can end all of it. */
export const FAMILY_ID_PATTERN = new RegExp(`^sf_${ID_BODY}$`);
const FAMILY_TAG = "18COSMOS/SESSION-FAMILY/v1\n";
export const familyIdOf = (foundingSessionId: string): string =>
  `sf_${base32Lower(createHash("sha256").update(FAMILY_TAG).update(foundingSessionId).digest().subarray(0, ID_BYTES))}`;

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

/* ==================================================================
    LIVE-2E: THE PROFILE CREDENTIALS
   ==================================================================
   RECOVERY KEY   `rk_<26 base32>.<43 base64url>` -- a 128-bit SELECTOR (the lookup key; unguessable, so a wrong one
                  cannot tell anybody which profiles exist) and a 256-bit SECRET, exactly the session cookie's shape.
                  The store keeps the selector and SHA-256 of the secret's 32 bytes; verification is constant-time.
                  A random bearer secret, not a password: SHA-256 is the right hash for it (no KDF buys anything).
   LINK CODE      20 symbols of upper-case Crockford base32 (100 bits), shown as `XXXX-XXXX-XXXX-XXXX-XXXX` so a
                  person can type it on a second device. Short-lived (10 minutes), single use, and stored only as
                  SHA-256 of its canonical spelling -- the record is found BY that digest, so the code itself is
                  never compared and there is nothing to time.
   Neither is ever logged, put in a URL, or kept by the client beyond the moment it is shown. */

export const RECOVERY_KEY_PATTERN = /^rk_[0-9a-hjkmnp-tv-z]{25}[048cgmrw]\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function mintRecoveryKey(random: RandomSource = cryptoRandom): { selector: string; secret: string; key: string } {
  const selector = mintRecoverySelector(random);
  const secret = mintSecret(random);
  return { selector, secret, key: `${selector}.${secret}` };
}

/** A recovery key as typed or pasted: surrounding whitespace forgiven, nothing else. `null` when it cannot be one. */
export function parseRecoveryKey(raw: unknown): { selector: string; secret: string } | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const key = raw.trim();
  if (!RECOVERY_KEY_PATTERN.test(key)) return null;
  const [selector, secret] = key.split(".");
  if (!RECOVERY_SELECTOR_PATTERN.test(selector) || secretBytes(secret) === null) return null;
  return { selector, secret };
}

export const LINK_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const LINK_CODE_SYMBOLS = 20;

/** 20 symbols, 5 uniform bits each (a byte's low five bits: 256 is a multiple of 32). */
export function mintLinkCode(random: RandomSource = cryptoRandom): { canonical: string; display: string } {
  const bytes = random(LINK_CODE_SYMBOLS);
  let canonical = "";
  for (const byte of bytes) canonical += LINK_CODE_ALPHABET[byte & 31];
  return { canonical, display: (canonical.match(/.{4}/g) as string[]).join("-") };
}

/** A link code as typed: case, spaces and hyphens forgiven, and Crockford's look-alikes (I and L are 1, O is 0).
 *  `null` unless exactly 20 symbols of the alphabet remain. */
export function canonicalLinkCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const body = raw.toUpperCase().replace(/[\s-]+/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (body.length !== LINK_CODE_SYMBOLS) return null;
  for (const symbol of body) if (!LINK_CODE_ALPHABET.includes(symbol)) return null;
  return body;
}

/** What the store keeps for a link code: hex SHA-256 of its canonical spelling (domain-separated). */
export function linkCodeHash(canonical: string): string {
  return createHash("sha256").update(`gs-link-code:${canonical}`, "utf8").digest("hex");
}
