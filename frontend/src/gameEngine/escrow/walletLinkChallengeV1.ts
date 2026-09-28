// frontend/src/gameEngine/escrow/walletLinkChallengeV1.ts
//
// ==================================================================
//  ESCROW-4: THE WALLET-LINK CHALLENGE -- WHAT A WALLET SIGNS (ADR-036) TO PROVE IT IS THE PLAYER'S
// ==================================================================
//
// A seat's join ticket, its join admission and its payout all hang off ONE wallet, and the server never trusts a wallet
// because a browser named it. The wallet proves itself by signing -- with Keplr's `signArbitrary`, ADR-036 -- a text
// the SERVER minted for exactly this request:
//
//   18COSMOS/WALLET-LINK/v1
//   Project 18XX: link this wallet to your seat. This is not a transaction and moves no funds.
//   Site: https://play.example
//   Network: uni-7
//   Escrow contract: juno1...
//   Game: g_...
//   Seat: p-...
//   Wallet: juno1...
//   Nonce: <32 hex>
//   Expires: 2026-09-28T21:30:00.000Z
//
// The tag separates the domain (no other message of this app starts with it). ADR-036 itself fixes an EMPTY chain id and
// a `sign/MsgSignData` message, so the signature can never be a transaction -- which is also why the network and the
// contract are written INTO the text: Juno mainnet and its testnet share the `juno` prefix. The nonce is single-use and
// bound, on the server, to the session, its family and recovery selector, the game, the seat and the wallet; the server
// accepts a signature only over the exact text it minted for that nonce.
//
// The browser PARSES the text before asking Keplr to sign it and refuses one that does not name its own site, network,
// contract, game, seat and wallet (a compromised server cannot get a link for another table signed through this page).

export const WALLET_LINK_TAG_V1 = "18COSMOS/WALLET-LINK/v1";
/** How long a challenge may be answered (the server also bounds it by the "Confirm it's you" grant it was made under). */
export const WALLET_LINK_TTL_MS = 5 * 60 * 1000;

export interface WalletLinkChallengeFields {
  readonly appName: string;
  /** The allow-listed origin the request came from (`https://host`). */
  readonly site: string;
  readonly chainId: string;
  readonly contract: string;
  readonly gameId: string;
  readonly playerId: string;
  readonly wallet: string;
  /** 32 lowercase hex characters. */
  readonly nonce: string;
  /** Server ms. */
  readonly expiresAt: number;
}

const LINE = /^[\x20-\x7e]{1,200}$/;

function clean(value: string, where: string): string {
  if (typeof value !== "string" || !LINE.test(value) || value !== value.trim()) throw new Error(`walletLinkChallenge: ${where} is not a single printable line`);
  return value;
}

/** The exact text a wallet signs (LF line ends, no trailing newline). */
export function walletLinkChallengeText(fields: WalletLinkChallengeFields): string {
  if (!/^[0-9a-f]{32}$/.test(fields.nonce)) throw new Error("walletLinkChallenge: the nonce is not 32 lowercase hex characters");
  if (!Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= 0) throw new Error("walletLinkChallenge: expiresAt");
  return [
    WALLET_LINK_TAG_V1,
    `${clean(fields.appName, "appName")}: link this wallet to your seat. This is not a transaction and moves no funds.`,
    `Site: ${clean(fields.site, "site")}`,
    `Network: ${clean(fields.chainId, "chainId")}`,
    `Escrow contract: ${clean(fields.contract, "contract")}`,
    `Game: ${clean(fields.gameId, "gameId")}`,
    `Seat: ${clean(fields.playerId, "playerId")}`,
    `Wallet: ${clean(fields.wallet, "wallet")}`,
    `Nonce: ${fields.nonce}`,
    `Expires: ${new Date(fields.expiresAt).toISOString()}`,
  ].join("\n");
}

/** The fields of a challenge text, or null when it is not exactly one (the browser's check before it signs). */
export function parseWalletLinkChallenge(text: string): WalletLinkChallengeFields | null {
  if (typeof text !== "string" || text.length > 2048) return null;
  const lines = text.split("\n");
  if (lines.length !== 10 || lines[0] !== WALLET_LINK_TAG_V1) return null;
  const intro = /^(.{1,200}): link this wallet to your seat\. This is not a transaction and moves no funds\.$/.exec(lines[1]);
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
  const nonce = field(8, "Nonce");
  const expires = field(9, "Expires");
  if (intro === null || site === null || chainId === null || contract === null || gameId === null || playerId === null || wallet === null || nonce === null || expires === null) return null;
  const expiresAt = Date.parse(expires);
  if (!/^[0-9a-f]{32}$/.test(nonce) || !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== expires) return null;
  const fields: WalletLinkChallengeFields = { appName: intro[1], site, chainId, contract, gameId, playerId, wallet, nonce, expiresAt };
  try {
    return walletLinkChallengeText(fields) === text ? fields : null;
  } catch {
    return null;
  }
}

/* ==================================================================
    ADR-036: THE SIGN DOC A WALLET ACTUALLY SIGNS
   ==================================================================
   Keplr's `signArbitrary(chainId, signer, data)` signs the amino StdSignDoc below -- empty chain id, zero account
   number and sequence, zero fee, one `sign/MsgSignData {signer, data: base64(utf8(data))}`, empty memo -- serialized as
   SORTED JSON with `&`, `<` and `>` escaped (cosmjs `serializeSignDoc`), then SHA-256 and secp256k1. The server rebuilds
   exactly these bytes from the text it minted and the wallet it expects; it never uses bytes a browser sent. */

/** Base64 of the UTF-8 bytes of `text` (no dependency on a Buffer or a DOM). */
export function base64OfUtf8(text: string): string {
  const bytes: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    let code = text.charCodeAt(at);
    if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length) {
      code = 0x10000 + ((code - 0xd800) << 10) + (text.charCodeAt(at + 1) - 0xdc00);
      at += 1;
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const [a, b, c] = [bytes[at], bytes[at + 1], bytes[at + 2]];
    out += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c === undefined ? "=" : alphabet[c & 63]);
  }
  return out;
}

/** The exact ADR-036 sign-doc bytes (as a string of ASCII JSON) for `signer` signing `text`. */
export function adr036SignDocJson(signer: string, text: string): string {
  const doc = `{"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"","msgs":[{"type":"sign/MsgSignData","value":{"data":${JSON.stringify(base64OfUtf8(text))},"signer":${JSON.stringify(signer)}}}],"sequence":"0"}`;
  return doc.replace(/&/g, "\\u0026").replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
