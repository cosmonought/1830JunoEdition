// frontend/src/utils/profileApi.ts
//
// ==================================================================
//  LIVE-2E: THE PROFILE ACTIONS, CLIENT SIDE
// ==================================================================
//
// PROFILES ARE MANDATORY. A browser's first session is a temporary, UNPROFILED one (the bootstrap's `profile: null`);
// it can create a profile, recover one with its recovery key, or link to one with a code from a device that is
// already signed in -- and nothing else. A profiled browser can make a link code for another device, replace its
// recovery key, and sign out other devices or this one. The server (`server/src/identity/httpApi.ts`) owns every
// rule; this file only speaks its routes and turns each answer into one typed result.
//
// EVERY CALL goes through the installed session port (`port.api`), so it is a same-origin POST with a closed JSON
// body, `credentials: "same-origin"` and `cache: "no-store"` -- the bootstrap's own terms -- and the path is one of a
// closed list, so no credential can ever reach a URL. A development-identity (always-ready) port has no HTTP surface
// and answers "unavailable".
//
// NOTHING RETURNED HERE IS KEPT HERE. A recovery key or link code is handed to the one screen that shows it and is
// never logged, stored (no localStorage, no sessionStorage) or put in a URL. None of these functions rejects.
//
// SENSITIVE ACTIONS (ESCROW-3A §10B): rotating the recovery key and signing out other devices -- and, later, binding a
// payout wallet -- need THIS session to have re-entered the profile's recovery key within the last few minutes. The
// server answers 403 `reauth-required`; the menu asks for the key, calls `reauthenticate`, and retries the action. The
// grant lives on the server, bound to this one session: nothing here keeps the key or the grant (the key is sent once
// in a POST body, as a recovery is, and dropped), and it is never a URL, a cookie or storage.
//
// A CALL THAT CHANGES THE SESSION forces the next bootstrap before it resolves -- create, recover, link, sign out
// other devices, and the answers that say our picture was stale (already-profiled, not-authenticated) -- so the
// port's `state` and `account` are the server's by the time the caller reads them.

import { sessionPort, type SessionApiAnswer, type SessionApiPath, type SessionPort } from "./sessionBootstrap";

export type ProfileErrorCode =
  | "invalid-credential"
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
      const profile = answer.body?.profile as { name?: unknown } | undefined;
      return failure("already-profiled", typeof profile?.name === "string" ? { name: profile.name } : {});
    }
    case 429: {
      const wait = answer.body?.retryAfterMs;
      return failure("rate-limited", { retryAfterMs: typeof wait === "number" && Number.isFinite(wait) && wait > 0 ? wait : 5_000 });
    }
    default:
      return failure("unavailable");
  }
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** One call, and the re-bootstrap it earns. */
async function call(port: SessionPort, path: SessionApiPath, body: Record<string, string>, success: number[], rebootstrap: boolean) {
  const answer = await port.api(path, body);
  const ok = answer.kind === "answered" && success.includes(answer.status);
  /* 401 (no session: a lost cookie, or one that ended) and 409 (already profiled: another tab, or a lost response)
     both say this page's picture of the session is out of date. */
  const stale = answer.kind === "answered" && (answer.status === 401 || answer.status === 409);
  if (ok ? rebootstrap : stale) await port.ensure(true);
  return { answer, ok };
}

/** "Create profile": 201 with the recovery key's ONLY appearance. */
export async function createProfile(name: string, port: SessionPort = sessionPort()): Promise<CreateProfileResult> {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > PROFILE_NAME_MAX) return failure("bad-name");
  const { answer, ok } = await call(port, "profile", { name: trimmed }, [201], true);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const profile = answer.body?.profile as { name?: unknown } | undefined;
  const recoveryKey = text(answer.body?.recoveryKey);
  if (recoveryKey === null) return failure("unavailable");
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

/** "Rotate recovery key": a new key, shown once; the old one stops working at once. */
export async function rotateRecoveryKey(port: SessionPort = sessionPort()): Promise<RecoveryKeyResult> {
  const { answer, ok } = await call(port, "profile/recovery-key", {}, [200], false);
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

/** "Sign out this device": this browser's session only (the caller reloads to the profile gate). A 401 -- no
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

/** What a player reads for a failed profile action. `credential` is the recover/link screens, where a malformed
 *  entry is the same answer as a wrong one. */
export function profileErrorSentence(result: ProfileFailure, context: "create" | "credential" | "reauth" | "action" = "action"): string {
  switch (result.error) {
    case "invalid-credential":
      if (context === "reauth") return "That recovery key doesn't work for this profile. Check it and try again.";
      return "That key or code doesn't work. Check it and try again — a device-link code works once, for 10 minutes.";
    case "bad-name":
      return `A profile name is 1 to ${PROFILE_NAME_MAX} characters.`;
    case "bad-request":
      if (context === "credential" || context === "reauth") return profileErrorSentence(failure("invalid-credential"), context);
      if (context === "create") return profileErrorSentence(failure("bad-name"));
      return "The game server did not accept that request. Try again.";
    case "rate-limited": {
      const seconds = Math.max(1, Math.ceil((result.retryAfterMs ?? 5_000) / 1000));
      return `Too many attempts. Wait ${seconds} second${seconds === 1 ? "" : "s"} and try again.`;
    }
    case "already-profiled":
      return "This browser is already signed in to a profile.";
    case "has-tables":
      return "This browser still holds tables from before profiles existed. Choose “Create profile” here to keep them.";
    case "not-authenticated":
      return "This browser's connection to the game server was reset. Try again.";
    case "profile-required":
      return "Sign in to a profile first.";
    case "reauth-required":
      return "For your security, confirm it's you with your recovery key first.";
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
