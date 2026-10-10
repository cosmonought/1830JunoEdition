// server/src/escrow/walletProof.ts
//
// ==================================================================
//  ESCROW-4: PROVING A WALLET IS THE PLAYER'S -- ADR-036 CHALLENGES, VERIFIED ON THE SERVER, SINGLE USE
// ==================================================================
//
// `POST /gs/api/money/wallet-challenge` mints a challenge (`walletLinkChallengeV1.ts`) for ONE request: this session
// (and the session family and recovery selector it stands under), this game, this seat (`player_id`, derived from the
// session's own principal -- never named by the browser) and this wallet. `POST /gs/api/money/wallet-link` answers it
// with the wallet's ADR-036 signature. The server then:
//
//   1. finds the challenge by its nonce, and requires the SAME session, family and selector, and the same game;
//   2. rebuilds the ADR-036 sign doc itself -- from the text it minted and the wallet it expects -- and verifies the
//      secp256k1 signature over its SHA-256 with the public key the wallet sent;
//   3. derives the address from that key (bech32 `juno`, RIPEMD-160(SHA-256(key))) and requires it to be the wallet;
//   4. consumes the nonce whatever the outcome (single use); a retry of the SAME signature after a lost answer gets the
//      same answer back (the result is kept with the spent nonce until it expires).
//
// Nonces live in MEMORY ONLY, like the "Confirm it's you" grant they are minted under: a restart drops them and the
// player simply asks again (LIVE-5: a short-TTL item keyed by nonce, or session-sticky routing). Nothing here is a
// secret; nothing here is logged except counts.

import { createHash, randomBytes } from "crypto";

import { adr036SignDocJson, walletLinkChallengeText, WALLET_LINK_TTL_MS } from "../../../frontend/src/gameEngine/escrow/walletLinkChallengeV1";
import { signingKeyChallengeText, SIGNING_KEY_TTL_MS } from "../../../frontend/src/gameEngine/escrow/signingKeyChallengeV1";
import { addressOfPublicKey, bech32Decode } from "./juno/cosmosTx";
import { verifyDigest } from "./juno/secp256k1";
import type { WalletLinkProof } from "./walletTickets";

/** The context a challenge is bound to (server-private ids: never on the wire). */
export interface ChallengeContext {
  readonly sessionId: string;
  readonly familyId: string;
  readonly recoverySelector: string;
  readonly principalId: string;
}

export interface MintedChallenge {
  readonly nonce: string;
  readonly text: string;
  readonly expiresAt: number;
}

interface ChallengeEntry {
  readonly nonce: string;
  readonly context: ChallengeContext;
  readonly gameId: string;
  readonly playerId: string;
  readonly wallet: string;
  /** PHASE 4: a signing-key book's challenge names the consent key it registers (null in a link book). */
  readonly signingKey: string | null;
  readonly text: string;
  readonly expiresAt: number;
  /** Set when the nonce is spent: the signature it was spent with, and what the link answered. */
  spent: { readonly signature: string; readonly result: unknown } | null;
}

/** A wallet a Juno contract could hold as a seat: lowercase bech32 `juno`, a 20-byte account. */
export function canonicalJunoWallet(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 90) return null;
  try {
    const decoded = bech32Decode(value, "juno");
    return decoded.bytes.length === 20 ? value : null;
  } catch {
    return null;
  }
}

/** SHA-256 over u32-length-framed parts (what `proof_hash` is taken over). */
function framedHash(parts: readonly Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part.length);
    hash.update(length).update(part);
  }
  return hash.digest("hex");
}

export type ProofVerdict = { readonly ok: true; readonly proof: WalletLinkProof } | { readonly ok: false; readonly why: "bad-key" | "bad-signature" | "wrong-wallet" };

/** Verifies an ADR-036 signature by `wallet` over `text` (the key and signature as the wallet returned them, base64). */
export function verifyAdr036(input: { readonly wallet: string; readonly text: string; readonly pubKeyBase64: string; readonly signatureBase64: string; readonly now: number }): ProofVerdict {
  /* 33 bytes are exactly 44 base64 characters (no padding); 64 bytes are 86 and "==". */
  const pubkey = Buffer.from(typeof input.pubKeyBase64 === "string" && /^[A-Za-z0-9+/]{44}$/.test(input.pubKeyBase64) ? input.pubKeyBase64 : "", "base64");
  if (pubkey.length !== 33 || (pubkey[0] !== 2 && pubkey[0] !== 3)) return { ok: false, why: "bad-key" };
  const signature = Buffer.from(typeof input.signatureBase64 === "string" && /^[A-Za-z0-9+/]{86}(==)?$/.test(input.signatureBase64) ? input.signatureBase64 : "", "base64");
  if (signature.length !== 64) return { ok: false, why: "bad-signature" };
  let derived: string;
  try {
    derived = addressOfPublicKey(pubkey, "juno");
  } catch {
    return { ok: false, why: "bad-key" };
  }
  if (derived !== input.wallet) return { ok: false, why: "wrong-wallet" };
  const digest = createHash("sha256").update(Buffer.from(adr036SignDocJson(input.wallet, input.text), "utf8")).digest();
  /* ADR-036 is verified as the chain verifies a signature: r and s in range. A high-s form is accepted (a wallet may
     return one); malleability is harmless for a single-use challenge. */
  let valid = false;
  try {
    valid = verifyDigest(pubkey, digest, signature, false);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, why: "bad-signature" };
  const text = Buffer.from(input.text, "utf8");
  return {
    ok: true,
    proof: {
      kind: "adr036",
      wallet: input.wallet,
      pubkey: pubkey.toString("hex"),
      challenge_digest: createHash("sha256").update(text).digest("hex"),
      proof_hash: framedHash([text, pubkey, signature]),
      verified_at: input.now,
    },
  };
}

/** The in-memory challenge book: one open challenge per (session, game), single-use nonces, bounded. */
/** PHASE 4: a book mints ONE kind of text -- a wallet link (`walletLinkChallengeV1`) or a signing-key registration
 *  (`signingKeyChallengeV1`). Two books, so a nonce of one can never be taken by the other's route. */
export function createChallengeBook(options: { readonly now: () => number; readonly appName: string; readonly max?: number; readonly random?: (size: number) => Buffer; readonly purpose?: "link" | "signing-key" }) {
  const purpose = options.purpose ?? "link";
  const byNonce = new Map<string, ChallengeEntry>();
  const openBySessionGame = new Map<string, string>();
  const max = options.max ?? 10_000;
  const random = options.random ?? ((size: number) => randomBytes(size));
  const keyOf = (sessionId: string, gameId: string) => `${sessionId}\u0000${gameId}`;

  function prune(): void {
    const now = options.now();
    for (const [nonce, entry] of byNonce) {
      if (entry.expiresAt <= now) {
        byNonce.delete(nonce);
        const key = keyOf(entry.context.sessionId, entry.gameId);
        if (openBySessionGame.get(key) === nonce) openBySessionGame.delete(key);
      }
    }
    /* Over the bound: the oldest go first (insertion order). */
    for (const nonce of byNonce.keys()) {
      if (byNonce.size <= max) break;
      byNonce.delete(nonce);
    }
  }

  return {
    /** Mint a challenge for this session, game, seat and wallet (replacing this session's open one for the game). */
    mint(input: { readonly context: ChallengeContext; readonly gameId: string; readonly playerId: string; readonly wallet: string; readonly site: string; readonly chainId: string; readonly contract: string; readonly signingKey?: string }): MintedChallenge {
      prune();
      const now = options.now();
      const nonce = random(16).toString("hex");
      const signingKey = purpose === "signing-key" ? input.signingKey ?? "" : null;
      const expiresAt = now + (purpose === "signing-key" ? SIGNING_KEY_TTL_MS : WALLET_LINK_TTL_MS);
      const common = { appName: options.appName, site: input.site, chainId: input.chainId, contract: input.contract, gameId: input.gameId, playerId: input.playerId, wallet: input.wallet, nonce, expiresAt };
      const text = signingKey === null ? walletLinkChallengeText(common) : signingKeyChallengeText({ ...common, signingKey });
      const key = keyOf(input.context.sessionId, input.gameId);
      const previous = openBySessionGame.get(key);
      if (previous !== undefined && byNonce.get(previous)?.spent === null) byNonce.delete(previous);
      byNonce.set(nonce, { nonce, context: input.context, gameId: input.gameId, playerId: input.playerId, wallet: input.wallet, signingKey, text, expiresAt, spent: null });
      openBySessionGame.set(key, nonce);
      return { nonce, text, expiresAt };
    },

    /** The challenge a link names, if it is this session's (same session, family and selector), this game's and live.
     *  `spent` tells a retry of the same signature apart from a replay. */
    take(nonce: unknown, context: ChallengeContext, gameId: string): { readonly kind: "open"; readonly entry: Readonly<Omit<ChallengeEntry, "spent">> } | { readonly kind: "spent"; readonly signature: string; readonly result: unknown } | { readonly kind: "unknown" } {
      prune();
      if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return { kind: "unknown" };
      const entry = byNonce.get(nonce);
      if (entry === undefined) return { kind: "unknown" };
      const same = entry.context.sessionId === context.sessionId && entry.context.familyId === context.familyId && entry.context.recoverySelector === context.recoverySelector && entry.context.principalId === context.principalId && entry.gameId === gameId;
      if (!same) return { kind: "unknown" };
      if (entry.spent !== null) return { kind: "spent", signature: entry.spent.signature, result: entry.spent.result };
      return { kind: "open", entry };
    },

    /** Spend a nonce (single use) and keep what it answered, for a retry of the same signature. */
    spend(nonce: string, signature: string, result: unknown): void {
      const entry = byNonce.get(nonce);
      if (entry === undefined || entry.spent !== null) return;
      entry.spent = { signature, result };
    },

    size: () => byNonce.size,
  };
}

export type ChallengeBook = ReturnType<typeof createChallengeBook>;
