// frontend/src/utils/profileApi.ts
//
// ==================================================================
//  THE ACCOUNT ACTIONS, CLIENT SIDE
// ==================================================================
//
// THE MODEL (PHASE 3 FINAL, owner ruling 2026-10-06): THE PROFILE / ACCOUNT IS THE PLAYER. A browser's first session is a
// temporary, signed-out one (the bootstrap's `profile: null`): a visitor, who may browse (public first) and, to play,
// CREATE AN ACCOUNT or LOG IN. An account is a username, a password and ONE designated AUTHORIZATION WALLET:
//   log in              username + password -- never a wallet;
//   create account      username + password + display name + the Authorization Wallet's signature (Keplr, ADR-036) over
//                       the CREATE text the server minted for this browser and this username;
//   forgot password     the username + the Authorization Wallet's signature over a RECOVER text + a new password;
//   change password     the current password + a new one (signed in);
//   change Authorization Wallet   (signed in, after "Confirm it's you") the CURRENT wallet approves and the NEW one
//                       accepts -- two signatures over the two texts of one operation.
// There is NO recovery key and NO email anywhere. The server (`server/src/identity/httpApi.ts`) owns every rule; this
// file only speaks its routes and turns each answer into one typed result. The Keplr part -- connecting, checking a text
// before it is signed, signing -- is `utils/authorizationWalletFlow.ts`.
//
// EVERY CALL goes through the installed session port (`port.api`), so it is a same-origin POST with a closed JSON
// body, `credentials: "same-origin"` and `cache: "no-store"` -- the bootstrap's own terms -- and the path is one of a
// closed list, so no credential can ever reach a URL. A development-identity (always-ready) port has no HTTP surface
// and answers "unavailable". Nothing returned here is kept here; none of these functions rejects.
//
// SENSITIVE ACTIONS (ESCROW-3A §10B): signing out other devices and linking a wallet to a seat need THIS session to have
// confirmed it's you within the last few minutes -- with the account's PASSWORD (a sign-in counts, for its first five
// minutes); beginning an Authorization Wallet replacement needs an explicit confirmation. The server answers 403
// `reauth-required`; the surface asks (`reauthenticateWithPassword`) and retries the action.
//
// A CALL THAT CHANGES THE SESSION forces the next bootstrap before it resolves -- create, log in, recover, change the
// password, sign out other devices, and the answers that say our picture was stale (already-profiled, not-authenticated)
// -- so the port's `state` and `account` are the server's by the time the caller reads them.

import { sessionPort, type SessionApiAnswer, type SessionApiPath, type SessionPort } from "./sessionBootstrap";

export type ProfileErrorCode =
  | "invalid-credential"
  /** Create account -- the username is someone else's (in any letter case). */
  | "username-taken"
  /** Create account -- not a username this server accepts (spaces, control characters, too long). */
  | "bad-username"
  /** The password is too short or too long (`problem`). */
  | "bad-password"
  /** PHASE 3 FINAL: the Authorization Wallet's signature did not verify, was for another account action, or its
   *  operation expired (sign again). */
  | "authorization-invalid"
  /** PHASE 3 FINAL: that signed operation was already used (sign again). */
  | "authorization-used"
  /** PHASE 3 FINAL: not a Juno wallet address. */
  | "bad-wallet"
  /** PHASE 3 FINAL: the new Authorization Wallet is the current one. */
  | "same-wallet"
  /** PHASE 3 FINAL: the account's Authorization Wallet changed meanwhile (start again). */
  | "stale"
  /** PHASE 3 FINAL: the right password of an account made before Authorization Wallets -- retired; make a new account. */
  | "legacy-account"
  /** The server is checking too many passwords at once; try again in a moment. */
  | "busy"
  | "already-profiled"
  /** LIVE-2E review M2: this browser played before profiles existed and may hold tables; it must create its own. */
  | "has-tables"
  | "bad-name"
  | "bad-request"
  | "rate-limited"
  | "not-authenticated"
  | "profile-required"
  /** ESCROW-3A: a sensitive action needs this session to confirm it's you first (`reauthenticateWithPassword`). */
  | "reauth-required"
  /** PHASE 3 FINAL: a route this build retired (a page from an older build asked for it). */
  | "retired"
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

export type SignOutResult = { ok: true } | ProfileFailure;
export type SignOutOthersResult = { ok: true; signedOut: number } | ProfileFailure;
export type ReauthResult = { ok: true; expiresAt: number } | ProfileFailure;

/** The longest profile name, after trimming (the server's sanitizer has the last word). */
export const PROFILE_NAME_MAX = 24;

const failure = (error: ProfileErrorCode, extra: Omit<ProfileFailure, "ok" | "error"> = {}): ProfileFailure => ({ ok: false, error, ...extra });

/** Any answer that is not the route's success, as one failure. */
function failureOf(answer: SessionApiAnswer): ProfileFailure {
  if (answer.kind === "network") return failure("network");
  if (answer.kind === "unavailable") return failure("unavailable");
  const code = answer.body?.error;
  switch (answer.status) {
    case 400:
      if (code === "bad-username") return failure("bad-username");
      if (code === "bad-wallet") return failure("bad-wallet");
      if (code === "bad-password") return failure("bad-password", { problem: answer.body?.problem === "too-long" ? "too-long" : "too-short" });
      return failure(code === "bad-name" ? "bad-name" : "bad-request");
    case 401:
      return failure("not-authenticated");
    case 403:
      if (code === "invalid-credential") return failure("invalid-credential");
      if (code === "profile-required") return failure("profile-required");
      if (code === "reauth-required") return failure("reauth-required");
      if (code === "authorization-invalid") return failure("authorization-invalid");
      return failure("unavailable"); // origin-forbidden: nothing a player can fix
    case 409: {
      if (code === "has-tables") return failure("has-tables");
      if (code === "username-taken") return failure("username-taken");
      if (code === "authorization-used") return failure("authorization-used");
      if (code === "same-wallet") return failure("same-wallet");
      if (code === "stale") return failure("stale");
      if (code === "legacy-account") return failure("legacy-account");
      const profile = answer.body?.profile as { name?: unknown } | undefined;
      return failure("already-profiled", typeof profile?.name === "string" ? { name: profile.name } : {});
    }
    case 410:
      return failure("retired");
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
  /* 401 (no session: a lost cookie, or one that ended) and 409 already-profiled (another tab, or a lost response) both
     say this page's picture of the session is out of date. */
  const stale = answer.kind === "answered" && (answer.status === 401 || (answer.status === 409 && answer.body?.error === "already-profiled"));
  if (ok ? rebootstrap : stale) await port.ensure(true);
  return { answer, ok };
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
    THE USERNAME + PASSWORD ACCOUNT
   ==================================================================
   The ordinary way in. The password is sent once, in a POST body, exactly as typed (never trimmed: spaces are part of
   it), and dropped; nothing here keeps it, logs it, stores it or puts it in a URL. A wrong password, an unknown username
   and a malformed one are ONE answer (`invalid-credential`) -- the server never says which. */

/** The password floor the server applies -- the OWNER's ruling (2026-10-05): 12 characters, no composition rule.
 *  Mirrored for the forms' hint only (`server/src/identity/accountCredentials.ts` has the last word). */
export const PASSWORD_MIN_LENGTH = 12;
/** The longest username the server takes, in characters (a technical bound, not a policy). */
export const USERNAME_MAX = 64;

export type AccountResult = { ok: true; name: string } | ProfileFailure;

/** Characters (code points), as the server counts them. */
const charCount = (value: string): number => Array.from(value).length;

/** The username as the forms send it (the server canonicalizes; this only refuses what can never be one). */
export function usernameProblem(raw: string): ProfileFailure | null {
  const username = raw.trim();
  return username === "" || charCount(username) > USERNAME_MAX || /\s/.test(username) ? failure("bad-username") : null;
}

/* ---------------- the Authorization Wallet's texts ---------------- */

/** One minted operation: the texts the browser checks, then asks Keplr to sign, in order. */
export interface MintedAuthorization {
  readonly operation: string;
  readonly texts: readonly { readonly purpose: string; readonly signer: string; readonly text: string }[];
  readonly expiresAt: number;
}

function mintedOf(body: Record<string, unknown> | null): MintedAuthorization | null {
  const operation = text(body?.operation);
  const texts = body?.texts;
  const expiresAt = body?.expiresAt;
  if (operation === null || !/^[0-9a-f]{32}$/.test(operation) || !Array.isArray(texts) || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  const parsed = texts.map((entry) => {
    const item = entry as { purpose?: unknown; signer?: unknown; text?: unknown } | null;
    return item !== null && typeof item.purpose === "string" && typeof item.signer === "string" && typeof item.text === "string" ? { purpose: item.purpose, signer: item.signer, text: item.text } : null;
  });
  if (parsed.length === 0 || parsed.length > 2 || parsed.some((entry) => entry === null)) return null;
  return { operation, texts: parsed as MintedAuthorization["texts"], expiresAt };
}

/** The CREATE or RECOVER text for this browser (signed out), the username and the wallet Keplr is on. CREATE says
 *  "username taken" before anything is signed; RECOVER says nothing about the username (the server looks nothing up). */
export async function mintAuthorization(input: { purpose: "create" | "recover"; username: string; wallet: string }, port: SessionPort = sessionPort()): Promise<{ ok: true; minted: MintedAuthorization } | ProfileFailure> {
  const problem = usernameProblem(input.username);
  if (problem !== null) return input.purpose === "recover" ? failure("invalid-credential") : problem;
  const { answer, ok } = await call(port, "account/authorization", { purpose: input.purpose, username: input.username.trim(), wallet: input.wallet }, [200], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const minted = mintedOf(answer.body);
  return minted === null ? failure("unavailable") : { ok: true, minted };
}

/** One Keplr signature, as the browser sends it on. */
export interface AuthorizationSignature {
  readonly pubKey: string;
  readonly signature: string;
}

/** "Create account": a username, a password, the name other players see, and the Authorization Wallet's signature over
 *  the CREATE text minted for exactly this username. Signs this browser in (a fresh session; the server sets the
 *  cookie). No recovery key exists: nothing is revealed after creation. */
export async function createAccount(
  input: { username: string; password: string; name: string; operation: string; signed: AuthorizationSignature },
  port: SessionPort = sessionPort(),
): Promise<AccountResult> {
  const name = input.name.trim();
  if (name === "" || name.length > PROFILE_NAME_MAX) return failure("bad-name");
  const problem = usernameProblem(input.username);
  if (problem !== null) return problem;
  if (charCount(input.password) < PASSWORD_MIN_LENGTH) return failure("bad-password", { problem: "too-short" });
  const { answer, ok } = await call(
    port,
    "account/create",
    { username: input.username.trim(), password: input.password, name, operation: input.operation, pubKey: input.signed.pubKey, signature: input.signed.signature },
    [201],
    true,
  );
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const profile = answer.body?.profile as { name?: unknown } | undefined;
  return { ok: true, name: text(profile?.name) ?? name };
}

/** "Log in": the same principal, every seat and table with it, on a fresh session for this browser. Never a wallet. */
export async function logIn(input: { username: string; password: string }, port: SessionPort = sessionPort()): Promise<AccountResult> {
  const username = input.username.trim();
  /* Nothing to send: the one answer a wrong password gets, without spending an attempt. */
  if (username === "" || input.password === "" || charCount(username) > USERNAME_MAX * 4 || input.password.length > 4096) return failure("invalid-credential");
  const { answer, ok } = await call(port, "account/login", { username, password: input.password }, [200], true);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const profile = answer.body?.profile as { name?: unknown } | undefined;
  return { ok: true, name: text(profile?.name) ?? port.account?.name ?? "" };
}

/** "Forgot password?" (signed out): the RECOVER operation the Authorization Wallet signed, and a new password. Signs this
 *  browser in on a fresh session; every earlier session of the account ends. ONE answer (`invalid-credential`) for every
 *  refusal -- the wallet is not that account's Authorization Wallet, the account doesn't exist, the signature didn't
 *  check out -- so nothing is said about any username. */
export async function recoverAccount(
  input: { operation: string; signed: AuthorizationSignature; newPassword: string },
  port: SessionPort = sessionPort(),
): Promise<{ ok: true; name: string; signedOut: number } | ProfileFailure> {
  if (charCount(input.newPassword) < PASSWORD_MIN_LENGTH) return failure("bad-password", { problem: "too-short" });
  const { answer, ok } = await call(port, "account/recover", { operation: input.operation, pubKey: input.signed.pubKey, signature: input.signed.signature, newPassword: input.newPassword }, [200], true);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const profile = answer.body?.profile as { name?: unknown } | undefined;
  const count = answer.body?.signedOut;
  return { ok: true, name: text(profile?.name) ?? port.account?.name ?? "", signedOut: typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0 };
}

/** "Change password" (signed in): the CURRENT password and the new one, in one request (a sign-in's standing grant never
 *  replaces a credential). Every other device is signed out; this browser continues on a fresh session. */
export async function changePassword(input: { currentPassword: string; newPassword: string }, port: SessionPort = sessionPort()): Promise<{ ok: true; signedOut: number } | ProfileFailure> {
  if (charCount(input.newPassword) < PASSWORD_MIN_LENGTH) return failure("bad-password", { problem: "too-short" });
  if (input.currentPassword === "" || input.currentPassword.length > 1024) return failure("invalid-credential");
  const { answer, ok } = await call(port, "account/password", { currentPassword: input.currentPassword, newPassword: input.newPassword }, [200], true);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const count = answer.body?.signedOut;
  return { ok: true, signedOut: typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0 };
}

/** "Change Authorization Wallet", step 1 (signed in, after "Confirm it's you"): the two texts -- the CURRENT wallet's
 *  approval, then the NEW wallet's acceptance. */
export async function replacementChallenge(newWallet: string, port: SessionPort = sessionPort()): Promise<{ ok: true; minted: MintedAuthorization } | ProfileFailure> {
  const { answer, ok } = await call(port, "account/authorization-wallet/challenge", { newWallet }, [200], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const minted = mintedOf(answer.body);
  return minted === null || minted.texts.length !== 2 ? failure("unavailable") : { ok: true, minted };
}

/** "Change Authorization Wallet", step 2: both signatures of the operation. */
export async function replaceAuthorizationWallet(
  input: { operation: string; approve: AuthorizationSignature; accept: AuthorizationSignature },
  port: SessionPort = sessionPort(),
): Promise<{ ok: true; authorizationWallet: { address: string; since: number } } | ProfileFailure> {
  const { answer, ok } = await call(
    port,
    "account/authorization-wallet/replace",
    { operation: input.operation, approvePubKey: input.approve.pubKey, approveSignature: input.approve.signature, acceptPubKey: input.accept.pubKey, acceptSignature: input.accept.signature },
    [200],
    false,
  );
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const wallet = answer.body?.authorizationWallet as { address?: unknown; since?: unknown } | undefined;
  return wallet !== undefined && typeof wallet.address === "string" && typeof wallet.since === "number" ? { ok: true, authorizationWallet: { address: wallet.address, since: wallet.since } } : failure("unavailable");
}

/** What this account's own sessions may read about it (never an id). */
export interface AccountDetails {
  readonly name: string;
  readonly username: string;
  /** PHASE 3 FINAL: the account's designated Authorization Wallet (the wallet that recovers it), and since when. */
  readonly authorizationWallet: { readonly address: string; readonly since: number };
  readonly memberSince: number;
  readonly otherSessions: number;
}

export type AccountDetailsResult = { ok: true; account: AccountDetails } | ProfileFailure;

export async function accountDetails(port: SessionPort = sessionPort()): Promise<AccountDetailsResult> {
  const { answer, ok } = await call(port, "account/me", {}, [200], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const raw = (answer.body?.account ?? null) as Record<string, unknown> | null;
  if (raw === null || typeof raw.name !== "string" || typeof raw.memberSince !== "number" || typeof raw.username !== "string") return failure("unavailable");
  const wallet = raw.authorizationWallet as { address?: unknown; since?: unknown } | null | undefined;
  if (!wallet || typeof wallet.address !== "string" || typeof wallet.since !== "number") return failure("unavailable");
  return {
    ok: true,
    account: {
      name: raw.name,
      username: raw.username,
      authorizationWallet: { address: wallet.address, since: wallet.since },
      memberSince: raw.memberSince,
      otherSessions: typeof raw.otherSessions === "number" && Number.isInteger(raw.otherSessions) && raw.otherSessions >= 0 ? raw.otherSessions : 0,
    },
  };
}

/** "Confirm it's you" with the account's PASSWORD: a sensitive action may follow within the server's short window. */
export async function reauthenticateWithPassword(password: string, port: SessionPort = sessionPort()): Promise<ReauthResult> {
  if (password === "" || password.length > 4096) return failure("invalid-credential");
  const { answer, ok } = await call(port, "profile/reauth", { password }, [200], false);
  if (!ok || answer.kind !== "answered") return failureOf(answer);
  const expiresAt = answer.body?.expiresAt;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? { ok: true, expiresAt } : failure("unavailable");
}

/** What a player reads for a failed account action. `login` and `account` are the account dialog's two forms;
 *  `password` is "Confirm it's you"; `recover` is "Forgot password?"; `change` is "Change password"; `replace` is
 *  "Change Authorization Wallet". */
export function profileErrorSentence(result: ProfileFailure, context: "create" | "reauth" | "action" | "login" | "account" | "password" | "recover" | "change" | "replace" = "action"): string {
  switch (result.error) {
    case "invalid-credential":
      if (context === "login") return "That username and password don't match an account. Check them and try again.";
      if (context === "password" || context === "reauth") return "That password doesn't match this account. Check it and try again.";
      if (context === "recover") return "That didn't recover an account. Check the username, and that Keplr is on the account's Authorization Wallet — a wallet you only used for games can't recover it.";
      if (context === "change") return "That current password doesn't match this account. Check it and try again.";
      return "That didn't work. Check it and try again.";
    case "username-taken":
      return "That username is taken. Choose another.";
    case "bad-username":
      return `A username is 1 to ${USERNAME_MAX} characters, with no spaces.`;
    case "bad-password":
      return result.problem === "too-long" ? "That password is too long." : `A password is at least ${PASSWORD_MIN_LENGTH} characters.`;
    case "authorization-invalid":
      return "The wallet's signature didn't check out (or it took too long). Nothing was changed — try again and sign the new message.";
    case "authorization-used":
      return "That signature was already used. Try again and sign the new message.";
    case "bad-wallet":
      return "That isn't a Juno wallet address.";
    case "same-wallet":
      return "That's already your Authorization Wallet. Switch Keplr to the wallet you want to use instead.";
    case "stale":
      return "Your Authorization Wallet changed meanwhile. Start again.";
    case "legacy-account":
      return "That account was made before Authorization Wallets and is retired. Create a new account to keep playing.";
    case "busy":
      return "The game server is busy checking sign-ins. Try again in a moment.";
    case "bad-name":
      return `A display name is 1 to ${PROFILE_NAME_MAX} characters.`;
    case "bad-request":
      if (context === "reauth" || context === "login" || context === "password" || context === "recover" || context === "change") return profileErrorSentence(failure("invalid-credential"), context);
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
    case "retired":
      return "This page is out of date. Reload it and try again.";
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
