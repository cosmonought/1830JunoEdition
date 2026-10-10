// frontend/src/gameEngine/escrow/signingKeyChallengeV1.ts
//
// ==================================================================
//  PHASE 4: THE SIGNING-KEY CHALLENGE -- WHAT A SEAT'S WALLET SIGNS (ADR-036) TO PUT THIS BROWSER'S KEY ON THE SEAT
// ==================================================================
//
// A funded seat approves its game's outcome with a small signing key kept in the browser that registered it (the
// "consent key"). A browser that holds none (another device, cleared storage) needs a new key registered on the seat.
// That used to need the account password ("Confirm it's you"). Now the seat's OWN linked wallet authorizes it, by
// signing -- with Keplr's `signArbitrary`, ADR-036 -- a text the SERVER minted for exactly this request:
//
//   18COSMOS/SIGNING-KEY/v1
//   Project 18XX: use this browser's signing key for your seat. This is not a transaction and moves no funds.
//   Site: https://play.example
//   Network: uni-7
//   Escrow contract: juno1...
//   Game: g_...
//   Seat: p-...
//   Wallet: juno1...
//   Signing key: 02...
//   Nonce: <32 hex>
//   Expires: 2026-09-28T21:30:00.000Z
//
// Its own tag (never `18COSMOS/WALLET-LINK/v1`), so a key signature can never stand in for a wallet link, nor a link
// for a key. The nonce is single-use and bound, on the server, to the session, its family and recovery selector, the
// game, the seat, the seat's linked wallet and THIS key; the server accepts a signature only over the exact text it
// minted. The browser parses the text before Keplr signs and refuses one that does not name its own site, network,
// contract, game, seat, wallet and key.

export const SIGNING_KEY_TAG_V1 = "18COSMOS/SIGNING-KEY/v1";
/** How long a challenge may be answered. */
export const SIGNING_KEY_TTL_MS = 5 * 60 * 1000;
/** A compressed secp256k1 public key, lowercase hex (what a consent key is). */
export const SIGNING_KEY_PATTERN = /^0[23][0-9a-f]{64}$/;

export interface SigningKeyChallengeFields {
  readonly appName: string;
  readonly site: string;
  readonly chainId: string;
  readonly contract: string;
  readonly gameId: string;
  readonly playerId: string;
  readonly wallet: string;
  /** The consent key being registered (compressed secp256k1, lowercase hex). */
  readonly signingKey: string;
  /** 32 lowercase hex characters. */
  readonly nonce: string;
  /** Server ms. */
  readonly expiresAt: number;
}

const LINE = /^[\x20-\x7e]{1,200}$/;

function clean(value: string, where: string): string {
  if (typeof value !== "string" || !LINE.test(value) || value !== value.trim()) throw new Error(`signingKeyChallenge: ${where} is not a single printable line`);
  return value;
}

/** The exact text the seat's wallet signs (LF line ends, no trailing newline). */
export function signingKeyChallengeText(fields: SigningKeyChallengeFields): string {
  if (!/^[0-9a-f]{32}$/.test(fields.nonce)) throw new Error("signingKeyChallenge: the nonce is not 32 lowercase hex characters");
  if (!SIGNING_KEY_PATTERN.test(fields.signingKey)) throw new Error("signingKeyChallenge: the signing key is not a compressed secp256k1 key");
  if (!Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= 0) throw new Error("signingKeyChallenge: expiresAt");
  return [
    SIGNING_KEY_TAG_V1,
    `${clean(fields.appName, "appName")}: use this browser's signing key for your seat. This is not a transaction and moves no funds.`,
    `Site: ${clean(fields.site, "site")}`,
    `Network: ${clean(fields.chainId, "chainId")}`,
    `Escrow contract: ${clean(fields.contract, "contract")}`,
    `Game: ${clean(fields.gameId, "gameId")}`,
    `Seat: ${clean(fields.playerId, "playerId")}`,
    `Wallet: ${clean(fields.wallet, "wallet")}`,
    `Signing key: ${fields.signingKey}`,
    `Nonce: ${fields.nonce}`,
    `Expires: ${new Date(fields.expiresAt).toISOString()}`,
  ].join("\n");
}

/** The fields of a challenge text, or null when it is not exactly one (the browser's check before it signs). */
export function parseSigningKeyChallenge(text: string): SigningKeyChallengeFields | null {
  if (typeof text !== "string" || text.length > 2048) return null;
  const lines = text.split("\n");
  if (lines.length !== 11 || lines[0] !== SIGNING_KEY_TAG_V1) return null;
  const intro = /^(.{1,200}): use this browser's signing key for your seat\. This is not a transaction and moves no funds\.$/.exec(lines[1]);
  const field = (at: number, label: string): string | null => {
    const prefix = `${label}: `;
    return lines[at].startsWith(prefix) ? lines[at].slice(prefix.length) : null;
  };
  const site = field(2, "Site");
  const chainId = field(3, "Network");
  const contract = field(4, "Escrow contract");
  const gameId = field(5, "Game");
  const playerId = field(6, "Seat");
  const wallet = field(7, "Wallet");
  const signingKey = field(8, "Signing key");
  const nonce = field(9, "Nonce");
  const expires = field(10, "Expires");
  if (intro === null || site === null || chainId === null || contract === null || gameId === null || playerId === null || wallet === null || signingKey === null || nonce === null || expires === null) return null;
  const expiresAt = Date.parse(expires);
  if (!/^[0-9a-f]{32}$/.test(nonce) || !SIGNING_KEY_PATTERN.test(signingKey) || !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== expires) return null;
  const fields: SigningKeyChallengeFields = { appName: intro[1], site, chainId, contract, gameId, playerId, wallet, signingKey, nonce, expiresAt };
  try {
    return signingKeyChallengeText(fields) === text ? fields : null;
  } catch {
    return null;
  }
}
