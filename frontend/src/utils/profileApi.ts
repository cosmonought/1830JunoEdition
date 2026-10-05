// frontend/src/utils/profileApi.ts
//
// ==================================================================
//  LIVE-2E: THE PROFILE ACTIONS, CLIENT SIDE
// ==================================================================
//
// A browser's first session is a temporary, UNPROFILED one (the bootstrap's `profile: null`): a visitor, who may
// browse (P3-ACCT, public first) and, to play, CREATE AN ACCOUNT or LOG IN with a username and password. Two older
// ways in remain for profiles made before accounts (LIVE-2E): the recovery key, and a code from a device that is
// already signed in. A signed-in browser can make a link code for another device, replace a legacy recovery key, and
// sign out other devices or this one. The server (`server/src/identity/httpApi.ts`) owns every rule; this file only
// speaks its routes and turns each answer into one typed result.
//
// EVERY CALL goes through the installed session port (`port.api`), so it is a same-origin POST with a closed JSON
// body, `credentials: "same-origin"` and `cache: "no-store"` -- the bootstrap's own terms -- and the path is one of a
// closed list, so no credential can ever reach a URL. A development-identity (always-ready) port has no HTTP surface
// and answers "unavailable".
//
// NOTHING RETURNED HERE IS KEPT HERE. A recovery key or link code is handed to the one screen that shows it and is
// never logged, stored (no localStorage, no sessionStorage) or put in a URL. None of these functions rejects.
//
// SENSITIVE ACTIONS (ESCROW-3A §10B): rotating the recovery key, signing out other devices, binding a NEW payout
// wallet, forgetting the verified one -- need THIS session to have confirmed it's you within the last few minutes: with
// the account's PASSWORD (P3-ACCT; a sign-in counts, for its first five minutes) or a legacy profile's recovery key.
// The server answers 403 `reauth-required`; the surface asks, calls `reauthenticateWithPassword` / `reauthenticate`,
// and retries the action. The grant lives on the server, bound to this one session: nothing here keeps the secret or
// the grant (it is sent once in a POST body and dropped), and it is never a URL, a cookie or storage. Playing another
// game never asks: the wallet this account already proved is its own authority (`server/src/escrow/moneyTables.ts`).
//
// A LOST CREATE RESPONSE (ESCROW-3A, owner review). The key's one appearance is the create's 201; if that answer is
// lost, the page never saw the key. The creating page therefore sends a CREATION RECEIPT with the create -- 32 random
// bytes it makes and keeps in memory only -- and acknowledges the key (`profile/key-received`) the moment the 201
// arrives. Until then, and only for the session that created the profile, `rotateRecoveryKey(port, receipt)` may
// replace the unseen key ONCE without the key. A stolen cookie has no receipt; after the acknowledgement (or a
// rotation, a re-authentication, ten minutes, or a server restart) the receipt opens nothing.
//
// A CALL THAT CHANGES THE SESSION forces the next bootstrap before it resolves -- create, recover, link, sign out
// other devices, and the answers that say our picture was stale (already-profiled, not-authenticated) -- so the
// port's `state` and `account` are the server's by the time the caller reads them.

import { sessionPort, type SessionApiAnswer, type SessionApiPath, type SessionPort } from "./sessionBootstrap";

export type ProfileErrorCode =
  | "invalid-credential"
  /** P3-ACCT: create account -- the username is someone else's (in any letter case). */
  | "username-taken"
  /** P3-ACCT: create account -- not a username this server accepts (spaces, control characters, too long). */
  | "bad-username"
  /** P3-ACCT: create account -- the password is too short or too long (`problem`). */
  | "bad-password"
  /** P3-ACCT: this profile already has a username and password. */
  | "credentials-exist"
  /** P3-ACCT: the server is checking too many passwords at once; try again in a moment. */
  | "busy"
  | "already-profiled"
  /** LIVE-2E review M2: this browser played before profiles existed and may hold tables; it must create its own. */
  | "has-tables"
  | "bad-name"
  | "bad-request"
  | "rate-limited"
  | "not-authenticated"
  | "profile-required"
  /** ESCROW-3A: a sensitive action needs this session to re-enter the recovery key first (`reauthenticate`). */
  | "reauth-required"
  | "unavailable"
  | "network";

export interface ProfileFailure {
  ok: false;
  error: ProfileErrorCode;
  /** With "rate-limited": how long the server asked us to wait. */
  retryAfterMs?: number;
  /** With "already-profiled" from a create: the profile this browser already has (by name only). */
  name?: string;
  /** With "bad-password": why. */
  problem?: "too-short" | "too-long";
}

export type CreateProfileResult = { ok: true; name: string; recoveryKey: string } | ProfileFailure;
export type SignInResult = { ok: true; name: string } | ProfileFailure;
export type LinkCodeResult = { ok: true; code: string; expiresAt: number } | ProfileFailure;
export type RecoveryKeyResult = { ok: true; recoveryKey: string } | ProfileFailure;
export type SignOutResult = { ok: true } | ProfileFailure;
export type SignOutOthersResult = { ok: true; signedOut: number } | ProfileFailure;
export type ReauthResult = { ok: true; expiresAt: number } | ProfileFailure;

/** The longest profile name, after trimming (the server's sanitizer has the last word). */
export const PROFILE_NAME_MAX = 24;
/** How long a device-link code works, for the countdown's fallback when the device's clock disagrees. */
export const LINK_CODE_LIFETIME_MS = 10 * 60 * 1000;

const failure = (error: ProfileErrorCode, extra: Omit<ProfileFailure, "ok" | "error"> = {}): ProfileFailure => ({ ok: false, error, ...extra });

/** Any answer that is not the route's success, as one failure. */
function failureOf(answer: SessionApiAnswer): ProfileFailure {
  if (answer.kind === "network") return failure("network");
  if (answer.kind === "unavailable") return failure("unavailable");
  const code = answer.body?.error;
  switch (answer.status) {
    case 400:
      if (code === "bad-username") return failure("bad-username");
      if (code === "bad-password") return failure("bad-password", { problem: answer.body?.problem === "too-long" ? "too-long" : "too-short" });
      return failure(code === "bad-name" ? "bad-name" : "bad-request");
    case 401:
      return failure("not-authenticated");
    case 403:
      if (code === "invalid-credential") return failure("invalid-credential");
      if (code === "profile-required") return failure("profile-required");
      if (code === "reauth-required") return failure("reauth-required");
      return failure("unavailable"); // origin-forbidden: nothing a player can fix
    case 409: {
      if (code === "has-tables") return failure("has-tables");
      if (code === "username-taken") return failure("username-taken");
      if (code === "credentials-exist") return failure("credentials-exist");
      const profile = answer.body?.profile as { name?: unknown } | undefined;
      return failure("already-profiled", typeof profile?.name === "string" ? { name: profile.name } : {});
    }
    case 429: {
      const wait = answer.body?.retryAfterMs;
      return failure("rate-limited", { retryAfterMs: typeof wait === "number" && Number.isFinite(wait) && wait > 0 ? wait : 5_000 });
    }
    case 503:
      return failure(code === "busy" ? "busy" : "unavailable");
    default:
      return failure("unavailable");
  }
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** One call, and the re-bootstrap it earns. */
async function call(port: SessionPort, path: SessionApiPath, body: Record<string, string | boolean>, success: number[], rebootstrap: boolean) {
  const answer = await port.api(path, body);
  const ok = answer.kind === "answered" && success.includes(answer.status);
  /* 401 (no session: a lost cookie, or one that ended) and 409 (already profiled: another tab, or a lost response)
     both say this page's picture of the session is out of date. */
  const stale = answer.kind === "answered" && (answer.status === 401 || answer.status === 409);
  if (ok ? rebootstrap : stale) await port.ensure(true);
  return { answer, ok };
}

/** ESCROW-3A: a creation receipt -- 32 random bytes as lowercase hex, for ONE page's create. Keep it in memory only
 *  (never storage, a URL or the console). `null` when this browser has no secure random source: no rescue then. */
export function mintCreationReceipt(): string | null {
  const source = (globalThis as { crypto?: { getRandomValues?: (bytes: Uint8Array) => Uint8Array } }).crypto;
  if (typeof source?.getRandomValues !== "function") return null;
  const bytes = source.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** "Create profile": 201 with the recovery key's ONLY appearance. With a creation receipt, the key's arrival is
 *  acknowledged at once (best effort: an unanswered acknowledgement leaves the rescue to its ten-minute bound). */
export async function createProfile(name: string, port: SessionPort = sessionPort(), creationReceipt: string | null = null): Promise<CreateProfileResult> {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > PROFILE_NAME_MAX) return failure("bad-name");
  const body: Record<string, string> = creationReceipt === null ? { name: trimmed } : { name: trimmed, creationReceipt };
  const { answer, ok } = await call(port, "profile", body, [201], true);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const profile = answer.body?.profile as { name?: unknown } | undefined;
  const recoveryKey = text(answer.body?.recoveryKey);
  if (recoveryKey === null) return failure("unavailable");
  if (creationReceipt !== null) await port.api("profile/key-received", { creationReceipt });
  return { ok: true, name: text(profile?.name) ?? trimmed, recoveryKey };
}

/** A recovery key as pasted: whitespace anywhere (a wrapped line, a trailing newline) is forgiven. */
function cleanKey(raw: string): string {
  return raw.replace(/\s+/g, "");
}

/** A link code as typed: case, spaces and hyphens are forgiven (the server forgives Crockford's look-alikes too). */
function cleanCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}

async function signIn(port: SessionPort, path: "profile/recover" | "profile/link", body: Record<string, string>): Promise<SignInResult> {
  const { answer, ok } = await call(port, path, body, [200], true);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const profile = answer.body?.profile as { name?: unknown } | undefined;
  return { ok: true, name: text(profile?.name) ?? port.account?.name ?? "" };
}

/** "Recover profile": this browser signs in to the profile the key belongs to (the server sets the new cookie). */
export function recoverProfile(recoveryKey: string, port: SessionPort = sessionPort()): Promise<SignInResult> {
  const key = cleanKey(recoveryKey);
  /* Nothing to send, or longer than any key: the one answer a wrong key gets, without spending an attempt. */
  if (key === "" || key.length > 200) return Promise.resolve(failure("invalid-credential"));
  return signIn(port, "profile/recover", { recoveryKey: key });
}

/** "Link this device": the same, by a single-use code from a device that is already signed in. */
export function linkProfile(code: string, port: SessionPort = sessionPort()): Promise<SignInResult> {
  const clean = cleanCode(code);
  if (clean === "" || clean.length > 64) return Promise.resolve(failure("invalid-credential"));
  return signIn(port, "profile/link", { code: clean });
}

/** "Link another device": a code for the other device, shown here once. */
export async function createLinkCode(port: SessionPort = sessionPort()): Promise<LinkCodeResult> {
  const { answer, ok } = await call(port, "profile/link-code", {}, [201], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const code = text(answer.body?.code);
  const expiresAt = answer.body?.expiresAt;
  if (code === null || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return failure("unavailable");
  return { ok: true, code, expiresAt };
}

/** "Rotate recovery key": a new key, shown once; the old one stops working at once. It needs a recent
 *  re-authentication (`reauthenticate`) -- or, from the page whose create answer was lost, that page's creation
 *  receipt (the one-time rescue). */
export async function rotateRecoveryKey(port: SessionPort = sessionPort(), creationReceipt: string | null = null): Promise<RecoveryKeyResult> {
  const { answer, ok } = await call(port, "profile/recovery-key", creationReceipt === null ? {} : { creationReceipt }, [200], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const recoveryKey = text(answer.body?.recoveryKey);
  return recoveryKey === null ? failure("unavailable") : { ok: true, recoveryKey };
}

/** ESCROW-3A "Confirm it's you": re-enter the recovery key on THIS session so a sensitive action may follow within the
 *  server's short window. A wrong key is "invalid-credential" (and spends this session's action budget, never the
 *  address's). Nothing is kept here. */
export async function reauthenticate(recoveryKey: string, port: SessionPort = sessionPort()): Promise<ReauthResult> {
  const key = cleanKey(recoveryKey);
  if (key === "" || key.length > 200) return failure("invalid-credential");
  const { answer, ok } = await call(port, "profile/reauth", { recoveryKey: key }, [200], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const expiresAt = answer.body?.expiresAt;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? { ok: true, expiresAt } : failure("unavailable");
}

/** "Sign out this device": this browser's session only (the caller reloads to the public homepage). A 401 -- no
 *  session to end -- is this device signed out already. */
export async function signOutThisDevice(port: SessionPort = sessionPort()): Promise<SignOutResult> {
  const { answer, ok } = await call(port, "session/revoke", {}, [204, 200, 401], false);
  return ok ? { ok: true } : failureOf(answer);
}

/** "Sign out other devices": every other session of this profile; their sockets close and they meet the notice. */
export async function signOutOtherDevices(port: SessionPort = sessionPort()): Promise<SignOutOthersResult> {
  const { answer, ok } = await call(port, "profile/sign-out-others", {}, [200], true);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const count = answer.body?.signedOut;
  return { ok: true, signedOut: typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0 };
}

/* ==================================================================
    P3-ACCT: THE USERNAME + PASSWORD ACCOUNT
   ==================================================================
   The ordinary way in. The password is sent once, in a POST body, exactly as typed (never trimmed: spaces are part of
   it), and dropped; nothing here keeps it, logs it, stores it or puts it in a URL. A wrong password, an unknown
   username and a malformed one are ONE answer (`invalid-credential`) -- the server never says which. */

/** The password floor the server applies (NIST SP 800-63B: 8). Mirrored for the form's hint only -- an OWNER
 *  decision that the server holds (`server/src/identity/accountCredentials.ts`); the server has the last word. */
export const PASSWORD_MIN_LENGTH = 8;
/** The longest username the server takes, in characters (a technical bound, not a policy). */
export const USERNAME_MAX = 64;

export type AccountResult = { ok: true; name: string } | ProfileFailure;

/** Characters (code points), as the server counts them. */
const charCount = (text: string): number => Array.from(text).length;

/** "Create account": a username, a password and the name other players see. Signs this browser in (a fresh session;
 *  the server sets the cookie) -- no recovery key is made or shown. */
export async function createAccount(input: { username: string; password: string; name: string }, port: SessionPort = sessionPort()): Promise<AccountResult> {
  const name = input.name.trim();
  if (name === "" || name.length > PROFILE_NAME_MAX) return failure("bad-name");
  const username = input.username.trim();
  if (username === "" || charCount(username) > USERNAME_MAX || /\s/.test(username)) return failure("bad-username");
  if (charCount(input.password) < PASSWORD_MIN_LENGTH) return failure("bad-password", { problem: "too-short" });
  const { answer, ok } = await call(port, "account/create", { username, password: input.password, name }, [201], true);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const profile = answer.body?.profile as { name?: unknown } | undefined;
  return { ok: true, name: text(profile?.name) ?? name };
}

/** "Log in": the same principal, every seat and table with it, on a fresh session for this browser. */
export async function logIn(input: { username: string; password: string }, port: SessionPort = sessionPort()): Promise<AccountResult> {
  const username = input.username.trim();
  /* Nothing to send: the one answer a wrong password gets, without spending an attempt. */
  if (username === "" || input.password === "" || charCount(username) > USERNAME_MAX * 4 || input.password.length > 4096) return failure("invalid-credential");
  const { answer, ok } = await call(port, "account/login", { username, password: input.password }, [200], true);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const profile = answer.body?.profile as { name?: unknown } | undefined;
  return { ok: true, name: text(profile?.name) ?? port.account?.name ?? "" };
}

/** What this account's own sessions may read about it (never an id). */
export interface AccountDetails {
  readonly name: string;
  readonly username: string | null;
  /** A legacy profile that still has a recovery key. */
  readonly recoveryKey: boolean;
  readonly wallet: { readonly address: string; readonly verifiedAt: number } | null;
  readonly memberSince: number;
  readonly otherSessions: number;
}

export type AccountDetailsResult = { ok: true; account: AccountDetails } | ProfileFailure;

export async function accountDetails(port: SessionPort = sessionPort()): Promise<AccountDetailsResult> {
  const { answer, ok } = await call(port, "account/me", {}, [200], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const raw = (answer.body?.account ?? null) as Record<string, unknown> | null;
  if (raw === null || typeof raw.name !== "string" || typeof raw.memberSince !== "number") return failure("unavailable");
  const wallet = raw.wallet as { address?: unknown; verifiedAt?: unknown } | null | undefined;
  return {
    ok: true,
    account: {
      name: raw.name,
      username: typeof raw.username === "string" ? raw.username : null,
      recoveryKey: raw.recoveryKey === true,
      wallet: wallet && typeof wallet.address === "string" && typeof wallet.verifiedAt === "number" ? { address: wallet.address, verifiedAt: wallet.verifiedAt } : null,
      memberSince: raw.memberSince,
      otherSessions: typeof raw.otherSessions === "number" && Number.isInteger(raw.otherSessions) && raw.otherSessions >= 0 ? raw.otherSessions : 0,
    },
  };
}

/** A legacy (recovery-key) profile chooses a username and password -- sensitive: it needs "Confirm it's you" with the
 *  recovery key first (`reauth-required`). The recovery key keeps working until the owner retires it. */
export async function establishCredentials(input: { username: string; password: string }, port: SessionPort = sessionPort()): Promise<{ ok: true; username: string } | ProfileFailure> {
  const username = input.username.trim();
  if (username === "" || charCount(username) > USERNAME_MAX || /\s/.test(username)) return failure("bad-username");
  if (charCount(input.password) < PASSWORD_MIN_LENGTH) return failure("bad-password", { problem: "too-short" });
  const { answer, ok } = await call(port, "account/credentials", { username, password: input.password }, [200], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  return { ok: true, username: text(answer.body?.username) ?? username };
}

/** "Forget this wallet": the profile no longer remembers its verified wallet (seats already linked keep theirs). Sensitive. */
export async function forgetWallet(port: SessionPort = sessionPort()): Promise<{ ok: true; forgot: boolean } | ProfileFailure> {
  const { answer, ok } = await call(port, "account/forget-wallet", {}, [200], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  return { ok: true, forgot: answer.body?.forgot === true };
}

/** "Confirm it's you" with the account's PASSWORD (a username/password account); the window and its binding are the
 *  same as the recovery key's. */
export async function reauthenticateWithPassword(password: string, port: SessionPort = sessionPort()): Promise<ReauthResult> {
  if (password === "" || password.length > 4096) return failure("invalid-credential");
  const { answer, ok } = await call(port, "profile/reauth", { password }, [200], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const expiresAt = answer.body?.expiresAt;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? { ok: true, expiresAt } : failure("unavailable");
}

/** What a player reads for a failed profile action. `credential` is the recover/link screens, where a malformed
 *  entry is the same answer as a wrong one; `login` and `account` are the account dialog's two forms; `password` is
 *  "Confirm it's you" with the account's password. */
export function profileErrorSentence(result: ProfileFailure, context: "create" | "credential" | "reauth" | "action" | "login" | "account" | "password" = "action"): string {
  switch (result.error) {
    case "invalid-credential":
      if (context === "login") return "That username and password don't match an account. Check them and try again.";
      if (context === "password") return "That password doesn't match this account. Check it and try again.";
      if (context === "reauth") return "That recovery key doesn't work for this profile. Check it and try again.";
      return "That key or code doesn't work. Check it and try again — a device-link code works once, for 10 minutes.";
    case "username-taken":
      return "That username is taken. Choose another.";
    case "bad-username":
      return `A username is 1 to ${USERNAME_MAX} characters, with no spaces.`;
    case "bad-password":
      return result.problem === "too-long" ? "That password is too long." : `A password is at least ${PASSWORD_MIN_LENGTH} characters.`;
    case "credentials-exist":
      return "This account already has a username and password.";
    case "busy":
      return "The game server is busy checking sign-ins. Try again in a moment.";
    case "bad-name":
      return `A profile name is 1 to ${PROFILE_NAME_MAX} characters.`;
    case "bad-request":
      if (context === "credential" || context === "reauth" || context === "login" || context === "password") return profileErrorSentence(failure("invalid-credential"), context);
      if (context === "create") return profileErrorSentence(failure("bad-name"));
      return "The game server did not accept that request. Try again.";
    case "rate-limited": {
      const seconds = Math.max(1, Math.ceil((result.retryAfterMs ?? 5_000) / 1000));
      return `Too many attempts. Wait ${seconds} second${seconds === 1 ? "" : "s"} and try again.`;
    }
    case "already-profiled":
      return "This browser is already signed in.";
    case "has-tables":
      return "This browser still holds tables from before accounts existed. Choose “Create account” here to keep them.";
    case "not-authenticated":
      return "This browser's connection to the game server was reset. Try again.";
    case "profile-required":
      return "Log in or create an account first.";
    case "reauth-required":
      return "For your security, confirm it's you first.";
    case "network":
    case "unavailable":
    default:
      return "The game server could not be reached. Try again in a moment.";
  }
}

/** LIVE-2E: the nickname a create or join sends when the player has not chosen one -- the profile's name. Empty in a
 *  development build, whose seat the server names after that tab's own development profile. */
export function profileNickname(chosen?: string | null, port: SessionPort = sessionPort()): string {
  const typed = typeof chosen === "string" ? chosen.trim() : "";
  if (typed !== "") return typed;
  const account = port.account;
  return account !== null && !account.development ? account.name : "";
}
