// frontend/src/utils/profileAuthorizationV1.ts
//
// ==================================================================
//  PHASE 3 (FINAL ACCOUNT / AUTHORIZATION WALLET): WHAT AN AUTHORIZATION WALLET SIGNS (ADR-036)
// ==================================================================
//
// Every player account has ONE designated AUTHORIZATION WALLET: a profile-level cryptographic authority, proven with a
// Keplr `signArbitrary` (ADR-036) signature over a text the SERVER minted for exactly one account action. It is the
// account's long-term authority and its recovery -- never its ordinary login (that is the username and password), never
// a gameplay identity, and never the wallet a game is funded from unless the player chooses so.
//
//   1830JUNO/PROFILE-AUTHORIZATION/v1
//   Project 18XX: make this wallet the Authorization Wallet of a new account.
//   This is not a transaction: it moves no funds and grants no permission to spend.
//   Purpose: CREATE
//   Site: https://play.example
//   Account: Brad.Player
//   Authorization wallet: juno1...
//   Replaces: none
//   Signer: juno1...
//   Operation: <32 hex>
//   Nonce: <32 hex>
//   Expires: 2026-10-06T05:30:00.000Z
//
// THE PURPOSES (domain separation: the tag, the purpose line and its sentence differ for each, and the server accepts a
// signature only over the exact text it minted for that nonce, purpose and operation):
//   CREATE           a new account designates `Authorization wallet` (the signer) -- before the account exists.
//   RECOVER          "Forgot password?": the signer, the account's CURRENT Authorization Wallet, recovers it.
//   REPLACE-APPROVE  the CURRENT Authorization Wallet (`Replaces`, the signer) approves its replacement by
//                    `Authorization wallet`.
//   REPLACE-ACCEPT   the NEW one (`Authorization wallet`, the signer) accepts the designation. Both replacement texts
//                    carry the SAME `Operation`: the server applies a replacement only with both signatures of one
//                    operation.
//
// ADR-036 fixes an EMPTY chain id and a `sign/MsgSignData` message, so the signature can never be a transaction; the
// text says so in plain words because a player reads it in Keplr's own window. Nothing here is a secret.
//
// The browser PARSES the text before asking Keplr to sign and refuses one that does not name its own site, the account it
// is acting for, the purpose it asked for and the wallet Keplr is on as the signer (a compromised server cannot get a
// different account action signed through this page).

export const PROFILE_AUTHORIZATION_TAG_V1 = "1830JUNO/PROFILE-AUTHORIZATION/v1";
/** How long a minted authorization text may be answered. */
export const PROFILE_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;

export type ProfileAuthorizationPurpose = "CREATE" | "RECOVER" | "REPLACE-APPROVE" | "REPLACE-ACCEPT";
export const PROFILE_AUTHORIZATION_PURPOSES: readonly ProfileAuthorizationPurpose[] = Object.freeze(["CREATE", "RECOVER", "REPLACE-APPROVE", "REPLACE-ACCEPT"]);

/** The plain sentence each purpose opens with (after the app's name). */
const SENTENCES: Readonly<Record<ProfileAuthorizationPurpose, string>> = {
  CREATE: "make this wallet the Authorization Wallet of a new account.",
  RECOVER: "recover this account and set a new password.",
  "REPLACE-APPROVE": "approve replacing this account's Authorization Wallet.",
  "REPLACE-ACCEPT": "make this wallet this account's new Authorization Wallet.",
};
const NOT_A_TRANSACTION = "This is not a transaction: it moves no funds and grants no permission to spend.";

export interface ProfileAuthorizationFields {
  readonly appName: string;
  readonly purpose: ProfileAuthorizationPurpose;
  /** The allow-listed origin the request came from (`https://host`). */
  readonly site: string;
  /** The account's username, as the player typed it (the server binds the canonical form). */
  readonly account: string;
  /** The wallet that is (RECOVER), or becomes (CREATE, REPLACE-*), the account's Authorization Wallet. */
  readonly authorizationWallet: string;
  /** REPLACE-*: the account's current Authorization Wallet; otherwise null ("none"). */
  readonly replaces: string | null;
  /** The wallet that signs THIS text. */
  readonly signer: string;
  /** 32 lowercase hex: one account action (both texts of a replacement share it). */
  readonly operation: string;
  /** 32 lowercase hex: this text. */
  readonly nonce: string;
  /** Server ms. */
  readonly expiresAt: number;
}

const ASCII_LINE = /^[\x20-\x7e]{1,200}$/;
/** An account name line: no control, line or format separators (a username is NFKC text of at most 64 code points). */
const ACCOUNT_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,256}$/u;
const JUNO_ADDRESS = /^juno1[02-9ac-hj-np-z]{38}$/;
const HEX_32 = /^[0-9a-f]{32}$/;

function clean(value: string, where: string): string {
  if (typeof value !== "string" || !ASCII_LINE.test(value) || value !== value.trim()) throw new Error(`profileAuthorization: ${where} is not a single printable line`);
  return value;
}

/** The wallet that must sign a text of this purpose (and the shape every purpose requires). */
export function signerFor(fields: Pick<ProfileAuthorizationFields, "purpose" | "authorizationWallet" | "replaces">): string | null {
  switch (fields.purpose) {
    case "CREATE":
    case "RECOVER":
      return fields.replaces === null ? fields.authorizationWallet : null;
    case "REPLACE-APPROVE":
      return fields.replaces !== null && fields.replaces !== fields.authorizationWallet ? fields.replaces : null;
    case "REPLACE-ACCEPT":
      return fields.replaces !== null && fields.replaces !== fields.authorizationWallet ? fields.authorizationWallet : null;
    default:
      return null;
  }
}

/** The exact text a wallet signs (LF line ends, no trailing newline). Throws on fields that do not make one. */
export function profileAuthorizationText(fields: ProfileAuthorizationFields): string {
  if (!(PROFILE_AUTHORIZATION_PURPOSES as readonly string[]).includes(fields.purpose)) throw new Error("profileAuthorization: unknown purpose");
  if (!HEX_32.test(fields.nonce) || !HEX_32.test(fields.operation)) throw new Error("profileAuthorization: the nonce and operation are 32 lowercase hex characters");
  if (!Number.isSafeInteger(fields.expiresAt) || fields.expiresAt <= 0) throw new Error("profileAuthorization: expiresAt");
  if (typeof fields.account !== "string" || !ACCOUNT_LINE.test(fields.account) || fields.account !== fields.account.trim() || Array.from(fields.account).length > 64) throw new Error("profileAuthorization: account");
  for (const wallet of [fields.authorizationWallet, fields.signer, ...(fields.replaces === null ? [] : [fields.replaces])]) {
    if (typeof wallet !== "string" || !JUNO_ADDRESS.test(wallet)) throw new Error("profileAuthorization: a wallet is not a Juno account address");
  }
  if (signerFor(fields) !== fields.signer) throw new Error("profileAuthorization: the signer is not the one this purpose needs");
  return [
    PROFILE_AUTHORIZATION_TAG_V1,
    `${clean(fields.appName, "appName")}: ${SENTENCES[fields.purpose]}`,
    NOT_A_TRANSACTION,
    `Purpose: ${fields.purpose}`,
    `Site: ${clean(fields.site, "site")}`,
    `Account: ${fields.account}`,
    `Authorization wallet: ${fields.authorizationWallet}`,
    `Replaces: ${fields.replaces ?? "none"}`,
    `Signer: ${fields.signer}`,
    `Operation: ${fields.operation}`,
    `Nonce: ${fields.nonce}`,
    `Expires: ${new Date(fields.expiresAt).toISOString()}`,
  ].join("\n");
}

/** The fields of an authorization text, or null when it is not exactly one (the browser's check before it signs). */
export function parseProfileAuthorization(text: string): ProfileAuthorizationFields | null {
  if (typeof text !== "string" || text.length > 4096) return null;
  const lines = text.split("\n");
  if (lines.length !== 12 || lines[0] !== PROFILE_AUTHORIZATION_TAG_V1 || lines[2] !== NOT_A_TRANSACTION) return null;
  const field = (at: number, label: string): string | null => {
    const prefix = `${label}: `;
    return lines[at].startsWith(prefix) ? lines[at].slice(prefix.length) : null;
  };
  const purpose = field(3, "Purpose");
  if (purpose === null || !(PROFILE_AUTHORIZATION_PURPOSES as readonly string[]).includes(purpose)) return null;
  const intro = new RegExp(`^(.{1,200}): ${SENTENCES[purpose as ProfileAuthorizationPurpose].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).exec(lines[1]);
  const site = field(4, "Site");
  const account = field(5, "Account");
  const authorizationWallet = field(6, "Authorization wallet");
  const replaces = field(7, "Replaces");
  const signer = field(8, "Signer");
  const operation = field(9, "Operation");
  const nonce = field(10, "Nonce");
  const expires = field(11, "Expires");
  if (intro === null || site === null || account === null || authorizationWallet === null || replaces === null || signer === null || operation === null || nonce === null || expires === null) return null;
  const expiresAt = Date.parse(expires);
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== expires) return null;
  const fields: ProfileAuthorizationFields = {
    appName: intro[1],
    purpose: purpose as ProfileAuthorizationPurpose,
    site,
    account,
    authorizationWallet,
    replaces: replaces === "none" ? null : replaces,
    signer,
    operation,
    nonce,
    expiresAt,
  };
  try {
    return profileAuthorizationText(fields) === text ? fields : null;
  } catch {
    return null;
  }
}

/** What the browser checks before it lets Keplr sign an authorization text: exactly the action it asked for. */
export interface ProfileAuthorizationExpectation {
  readonly purpose: ProfileAuthorizationPurpose;
  readonly site: string;
  /** The username this page is acting for (compared as typed, case-insensitively: the server binds the canonical form). */
  readonly account: string;
  /** The wallet Keplr is on (the signer). */
  readonly signer: string;
  /** CREATE / RECOVER: the signer; REPLACE-*: the new wallet. */
  readonly authorizationWallet: string;
  /** REPLACE-*: the current Authorization Wallet as this page knows it (null: not known here -- not compared). */
  readonly replaces?: string | null;
  /** REPLACE-*: the operation both texts must share. */
  readonly operation?: string;
  readonly now: number;
}

/** Null when the text is exactly the expected action; otherwise the sentence saying why nothing will be signed. */
export function checkProfileAuthorization(text: string, expected: ProfileAuthorizationExpectation): string | null {
  const fields = parseProfileAuthorization(text);
  if (fields === null) return "The server's authorization message wasn't in the expected form, so nothing was signed.";
  if (fields.purpose !== expected.purpose) return "The server asked Keplr to sign for a different account action, so nothing was signed.";
  if (fields.site !== expected.site) return "The authorization message names another site, so nothing was signed.";
  if (fields.account.normalize("NFKC").toLowerCase() !== expected.account.trim().normalize("NFKC").toLowerCase()) return "The authorization message names another account, so nothing was signed.";
  if (fields.signer !== expected.signer) return "The authorization message is for another wallet than the one Keplr is on, so nothing was signed.";
  if (fields.authorizationWallet !== expected.authorizationWallet) return "The authorization message names another Authorization Wallet, so nothing was signed.";
  if (expected.replaces !== undefined && expected.replaces !== null && fields.replaces !== expected.replaces) return "The authorization message names another current Authorization Wallet, so nothing was signed.";
  if (expected.operation !== undefined && fields.operation !== expected.operation) return "The two replacement messages don't belong to one replacement, so nothing was signed.";
  if (fields.expiresAt <= expected.now) return "The authorization message has expired. Start again.";
  return null;
}
