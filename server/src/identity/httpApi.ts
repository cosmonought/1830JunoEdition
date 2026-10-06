// server/src/identity/httpApi.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §4.1): THE SAME-ORIGIN HTTP SURFACE
// ==================================================================
//
//   POST /gs/api/session          bootstrap: 200 (the current session, rotated when older than 7 days, with a new
//                                 cookie then); 201 + Set-Cookie (a new, UNPROFILED principal: no cookie, an unknown
//                                 selector, or the explicit `{"fresh": true}`); 401 `session-ended` {reason} for a
//                                 KNOWN session that has ended -- never a silent new identity; 403 origin-forbidden;
//                                 429 rate-limited; 503 when the store did not take a rotation. LIVE-2E: the body
//                                 says `profile: {name, otherSessions}` or `profile: null` -- never an id.
//   POST /gs/api/session/revoke   "Sign out this device": the current session only, revoked "logout" (durable first),
//                                 cookie cleared, its sockets closed 4401, 204. The profile and its seats stay.
//   GET  /gs/healthz              200 "ok", nothing else.
//
// LIVE-2E: MANDATORY PROFILES. An unprofiled session can reach only these (and the two above); it cannot open a game
// socket at all (the upgrade answers 403 `profile`), so no room, list, view, log, chat or presence is reachable from it.
//   POST /gs/api/profile                    {name, creationReceipt?}  create this browser's profile: 201 {profile,
//                                                          recoveryKey} -- the recovery key, ONCE; 409 already-profiled;
//                                                          400 bad-name. ESCROW-3A: `creationReceipt` (64 hex, random,
//                                                          held only in the creating page's memory) opens the one-time
//                                                          lost-response rescue below
//   POST /gs/api/profile/recover            {recoveryKey}  200 {profile} + a fresh session cookie for the profile's
//                                                          principal (this browser's temporary one is `replaced`)
//   POST /gs/api/profile/link               {code}         the same, by a single-use "Link another device" code
//   POST /gs/api/profile/link-code          {}             (profiled) 201 {code, expiresAt}
//   POST /gs/api/profile/recovery-key       {creationReceipt?}  (profiled) 200 {recoveryKey} -- the old key stops working
//   POST /gs/api/profile/sign-out-others    {}             (profiled) 200 {signedOut}
//   POST /gs/api/profile/reauth             {recoveryKey}  (profiled) ESCROW-3A: re-authenticate THIS session with its own
//                                                          profile's recovery key: 200 {expiresAt}; 403 invalid-credential
//   POST /gs/api/profile/key-received       {creationReceipt}  (profiled) ESCROW-3A: the creating page has its key -- the
//                                                          lost-response rescue closes for good. 204, whatever it closed
// ESCROW-3A (brief §10B, owner review): `recovery-key` and `sign-out-others` are SENSITIVE -- without a recent
// re-authentication of the same session they answer 403 `reauth-required` (the client asks for the key, calls `reauth`,
// and retries). `sign-out-others` has no exception. `recovery-key` has ONE, and it is not a time window: the session
// that created the profile, presenting the creating page's receipt, may replace the key ONCE while that page has not
// acknowledged receiving it (a lost create response) -- memory only, so a restart closes it; any rotation, a
// re-authentication, the acknowledgement or ten minutes close it too. A stolen cookie alone never has the receipt.
// P3-ACCT: THE ORDINARY ACCOUNT -- USERNAME + PASSWORD (`accountCredentials.ts`; the service's `createAccount`, `login`,
// `establishCredentials`):
//   POST /gs/api/account/create        {username, password, name}  this browser's account: 201 {profile, username,
//                                                          recoveryKey} + a FRESH session cookie (the temporary one is
//                                                          `replaced`). P3-ACCT POLICY: `recoveryKey` is the account's ONE
//                                                          recovery key, in its ONE appearance (the dialog's reveal). 400
//                                                          bad-username / bad-password {problem} / bad-name; 409
//                                                          username-taken / already-profiled.
//   POST /gs/api/account/login         {username, password}  200 {profile} + a fresh session cookie for the account's
//                                                          principal (the temporary one is `replaced`). ONE answer for
//                                                          every wrong or unknown username or password: 403
//                                                          invalid-credential, after the same KDF work.
//   POST /gs/api/account/credentials   {username, password}  (profiled, SENSITIVE) a LEGACY recovery-key profile sets its
//                                                          username and password: 200 {username}; 409 credentials-exist.
//   POST /gs/api/account/me            {}             (profiled) the account's own details: its username, whether it
//                                                          still has a recovery key, its verified wallet, when it was made.
//   POST /gs/api/account/forget-wallet {}             (profiled, SENSITIVE) the profile keeps no verified wallet.
//   POST /gs/api/profile/reauth        {password}     "Confirm it's you" with the password (or {recoveryKey}: a profile
//                                                          with no password only -- P3-ACCT POLICY).
// P3-ACCT POLICY FOLLOW-UP (owner rulings 2026-10-05; `sessions.ts` changePassword / resetPassword):
//   POST /gs/api/account/password      {currentPassword | recoveryKey, newPassword}  (profiled) "Change password": the
//                                                          CURRENT password or the recovery key IN THE REQUEST (a sign-in's
//                                                          standing grant never replaces a credential). 200 {signedOut} + a
//                                                          FRESH cookie for this browser (same family); every other device
//                                                          is signed out. 403 invalid-credential; 400 bad-password
//                                                          {problem}; 409 no-password (a legacy profile: set one instead).
//   POST /gs/api/account/reset         {recoveryKey, newPassword}  (signed out) "Forgot password?": 200 {profile,
//                                                          signedOut} + a fresh cookie; every earlier session of the account
//                                                          ends. No username: the key names the account. ONE answer for
//                                                          every wrong, unknown, malformed or retired key (403
//                                                          invalid-credential), budgeted as a recovery is. 409 no-password
//                                                          (a valid key of a profile with no password).
//   POST /gs/api/profile/recover       a VALID key of an account with a password: 409 use-password-reset (the key is
//                                                          account recovery there, never a sign-in).
// No email exists anywhere: there is no address to collect, verify or send to (owner ruling: out of scope).
// Budgets: every sign-in attempt per SESSION; WRONG passwords per address and per username -- spent, every password
// attempt there is refused 429 BEFORE any check (a password can be guessed; a recovery key cannot). A KDF the server is
// already running too many of answers 503 `busy`. No password is ever logged, echoed, put in a URL or kept.
//
// A wrong, expired, used, revoked or disabled credential is ONE answer: 403 `invalid-credential`. Redemptions are
// budgeted per address and per session, apart from every room limit; the plaintext key or code appears only in the one
// response that delivers it, and nothing here logs a request body.
//
// EVERY `/gs/api/*` REQUEST: POST only; an allow-listed Origin (exact); `Content-Type: application/json` (which a
// cross-site form cannot send without a preflight nobody answers); a body of at most 4 KiB, a closed JSON object;
// `Cache-Control: no-store`; and NO CORS header, ever. Any other `/gs/api/*` path answers 404.
//
// NOTHING HERE LOGS A REQUEST'S HEADERS, COOKIE OR BODY, and no response carries a principal or profile id: neither
// ever goes on the wire (LIVE-2 §3.2).

import type { IncomingMessage, ServerResponse } from "http";

import type { IdentityLimits } from "../ingress/limits";
import { clearedSessionCookie, readSessionCookie, type SessionCookieRead } from "./cookies";
import { clientIpOf, type IpKey } from "./clientIp";
import type { IdentityLimiter } from "./limiter";
import type { GsMode } from "./mode";
import { originAllowed } from "./origins";
import { cleanLoginName, loginKeyOf } from "./accountCredentials";
import { cleanProfileName } from "./profileName";
import type { CredentialOutcome, CurrentCredential, IdentityService } from "./sessions";

export const SESSION_PATH = "/gs/api/session";
export const REVOKE_PATH = "/gs/api/session/revoke";
export const HEALTH_PATH = "/gs/healthz";
export const PROFILE_PATH = "/gs/api/profile";
export const RECOVER_PATH = "/gs/api/profile/recover";
export const LINK_PATH = "/gs/api/profile/link";
export const LINK_CODE_PATH = "/gs/api/profile/link-code";
export const RECOVERY_KEY_PATH = "/gs/api/profile/recovery-key";
export const SIGN_OUT_OTHERS_PATH = "/gs/api/profile/sign-out-others";
export const REAUTH_PATH = "/gs/api/profile/reauth";
export const KEY_RECEIVED_PATH = "/gs/api/profile/key-received";
/* P3-ACCT */
export const ACCOUNT_CREATE_PATH = "/gs/api/account/create";
export const ACCOUNT_LOGIN_PATH = "/gs/api/account/login";
export const ACCOUNT_CREDENTIALS_PATH = "/gs/api/account/credentials";
export const ACCOUNT_ME_PATH = "/gs/api/account/me";
export const ACCOUNT_FORGET_WALLET_PATH = "/gs/api/account/forget-wallet";
/* P3-ACCT POLICY */
export const ACCOUNT_PASSWORD_PATH = "/gs/api/account/password";
export const ACCOUNT_RESET_PATH = "/gs/api/account/reset";
const API_PREFIX = "/gs/api/";
const ROUTES = new Set([
  SESSION_PATH,
  REVOKE_PATH,
  PROFILE_PATH,
  RECOVER_PATH,
  LINK_PATH,
  LINK_CODE_PATH,
  RECOVERY_KEY_PATH,
  SIGN_OUT_OTHERS_PATH,
  REAUTH_PATH,
  KEY_RECEIVED_PATH,
  ACCOUNT_CREATE_PATH,
  ACCOUNT_LOGIN_PATH,
  ACCOUNT_CREDENTIALS_PATH,
  ACCOUNT_ME_PATH,
  ACCOUNT_FORGET_WALLET_PATH,
  ACCOUNT_PASSWORD_PATH,
  ACCOUNT_RESET_PATH,
]);

export interface HttpApi {
  mode: GsMode;
  allowedOrigins: ReadonlySet<string>;
  trustedProxyHops: number;
  identity: IdentityService;
  limiter: IdentityLimiter;
  limits: IdentityLimits;
  now: () => number;
  /** A failure answered with a reference: the reference is logged with the error, the client sees the reference. */
  onError: (what: string, error: unknown) => string;
}

const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

/** ESCROW-4: shared with `escrow/moneyHttpApi.ts` (the same ingress rules for every `/gs/api/*` route). */
export function json(response: ServerResponse, status: number, body: object | null, headers: Record<string, string | string[]> = {}): void {
  if (response.headersSent) return;
  if (body === null) {
    response.writeHead(status, { ...BASE_HEADERS, ...headers });
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text)),
    ...headers,
  });
  response.end(text);
}

export const retryAfter = (ms: number) => ({ "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) });

/** A body of at most `max` bytes, or why not. Never buffers past the cap. */
export function readBody(request: IncomingMessage, max: number): Promise<{ ok: true; text: string } | { ok: false; status: 400 | 413 }> {
  return new Promise((resolve) => {
    const declared = request.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > max)) {
      resolve({ ok: false, status: 413 });
      request.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: { ok: true; text: string } | { ok: false; status: 400 | 413 }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, status: 400 });
      request.destroy();
    }, 10_000);
    timer.unref?.();
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        finish({ ok: false, status: 413 });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    request.on("error", () => finish({ ok: false, status: 400 }));
    request.on("aborted", () => finish({ ok: false, status: 400 }));
  });
}

/** A body field's type: a boolean, or a string of at most this many characters. */
export type FieldSpec = "boolean" | { string: number };

/** The closed body: an object with only the schema's keys, each of its type. `""` is `{}`. */
export function parseBody(text: string, schema: Readonly<Record<string, FieldSpec>>): Record<string, boolean | string> | null {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, boolean | string> = {};
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) return null;
    const spec = schema[key];
    const field = (value as Record<string, unknown>)[key];
    if (spec === "boolean") {
      if (typeof field !== "boolean") return null;
    } else if (typeof field !== "string" || field.length > spec.string) {
      return null;
    }
    out[key] = field;
  }
  return out;
}

export const isJson = (header: string | undefined): boolean =>
  typeof header === "string" && /^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(header.trim());

/** Handle the request if it is one of ours; `false` leaves it to the caller. */
export function handleIdentityHttp(request: IncomingMessage, response: ServerResponse, api: HttpApi): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  if (pathname === HEALTH_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      json(response, 405, { error: "method-not-allowed" }, { Allow: "GET, HEAD" });
      return true;
    }
    response.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end(request.method === "HEAD" ? undefined : "ok\n");
    return true;
  }
  if (!ROUTES.has(pathname)) {
    /* ESCROW-4: `/gs/api/money/*` is `escrow/moneyHttpApi.ts`'s (the server asks it first); anything else is 404. */
    if (pathname.startsWith(API_PREFIX) || pathname === "/gs/api") {
      json(response, 404, { error: "not-found" });
      return true;
    }
    return false;
  }
  void serve(request, response, api, pathname).catch((error) => {
    const ref = api.onError("an identity request", error);
    json(response, 500, { error: "internal", ref });
  });
  return true;
}

async function serve(request: IncomingMessage, response: ServerResponse, api: HttpApi, pathname: string): Promise<void> {
  if (request.method !== "POST") {
    json(response, 405, { error: "method-not-allowed" }, { Allow: "POST" });
    request.resume();
    return;
  }
  if (!originAllowed(request.headers.origin, api.allowedOrigins)) {
    api.limiter.deny("api-origin");
    json(response, 403, { error: "origin-forbidden" });
    request.resume();
    return;
  }
  if (!isJson(request.headers["content-type"])) {
    json(response, 415, { error: "unsupported-media-type" });
    request.resume();
    return;
  }
  const client = clientIpOf(request, api.trustedProxyHops);
  if (!client.ok) {
    api.limiter.deny("client-ip");
    json(response, 400, { error: "bad-request" });
    request.resume();
    return;
  }
  const body = await readBody(request, api.limits.maxApiBodyBytes);
  if (!body.ok) {
    json(response, body.status, { error: body.status === 413 ? "too-large" : "bad-request" });
    return;
  }
  const now = api.now();
  const read = readSessionCookie(request.headers.cookie);

  if (pathname === REVOKE_PATH) {
    if (parseBody(body.text, {}) === null) {
      json(response, 400, { error: "bad-request" });
      return;
    }
    /* LIVE-2F/3D (C1-03b): a rotated session still in its grace is signed out too (it could still bootstrap), and a
       401 clears the cookie -- the client reads it as "signed out", so the browser must not keep one that works. */
    const sessionId = api.identity.revocableSession(read, now);
    if (sessionId === null) {
      json(response, 401, { error: "not-authenticated" }, { "Set-Cookie": clearedSessionCookie() });
      return;
    }
    const wait = api.limiter.bootstraps.take(sessionId);
    if (wait > 0) {
      api.limiter.deny("bootstrap-session");
      json(response, 429, { error: "rate-limited", retryAfterMs: wait }, retryAfter(wait));
      return;
    }
    try {
      await api.identity.revoke(sessionId, "logout", now);
    } catch (error) {
      const ref = api.onError("a session revocation", error);
      json(response, 503, { error: "unavailable", ref }, retryAfter(5_000));
      return;
    }
    json(response, 204, null, { "Set-Cookie": clearedSessionCookie() });
    return;
  }

  if (pathname !== SESSION_PATH) {
    await serveProfile(response, api, pathname, body.text, read, client.ip, now);
    return;
  }

  const fields = parseBody(body.text, { fresh: "boolean" });
  if (fields === null) {
    json(response, 400, { error: "bad-request" });
    return;
  }
  const fresh = fields.fresh === true;
  const decided = api.identity.classify(read, fresh, now);
  if (decided.kind === "create") {
    /* LIVE-2 §12.2: principal creation -- the IP key's budget first, then the server's; a refusal spends neither. */
    const ipWait = api.limiter.guestCreates.peek(client.ip);
    const globalWait = ipWait > 0 ? 0 : api.limiter.guestCreatesGlobal.peek("global");
    if (ipWait > 0 || globalWait > 0) {
      api.limiter.deny(ipWait > 0 ? "guest-create-ip" : "guest-create-global");
      const wait = Math.max(ipWait, globalWait);
      json(response, 429, { error: "rate-limited", retryAfterMs: wait }, retryAfter(wait));
      return;
    }
    api.limiter.guestCreates.take(client.ip);
    api.limiter.guestCreatesGlobal.take("global");
  } else if (decided.kind === "existing") {
    const wait = api.limiter.bootstraps.take(decided.sessionId);
    if (wait > 0) {
      api.limiter.deny("bootstrap-session");
      json(response, 429, { error: "rate-limited", retryAfterMs: wait }, retryAfter(wait));
      return;
    }
  }
  /* A rotated cookie inside its grace mints a durable successor each time, so each one is charged to the
     PRINCIPAL's grace budget -- inside the identity queue, where concurrent requests cannot all pass one check
     (LIVE-2B adversarial review). */
  const outcome = await api.identity.bootstrap(read, fresh, now, { graceBudget: (principalId) => api.limiter.graceMints.take(principalId) });
  if (outcome.kind === "rate-limited") {
    api.limiter.deny("bootstrap-grace");
    json(response, 429, { error: "rate-limited", retryAfterMs: outcome.retryAfterMs }, retryAfter(outcome.retryAfterMs));
    return;
  }
  if (outcome.kind === "ended") {
    /* NOT a new identity, and the cookie is NOT cleared: a reload must reach this same answer, and only the player's
       explicit "Continue" (`{"fresh": true}`, which leads to the profile gate) replaces it. */
    json(response, 401, { error: "session-ended", reason: outcome.reason });
    return;
  }
  if (outcome.kind === "unavailable") {
    json(response, 503, { error: "unavailable" }, retryAfter(5_000));
    return;
  }
  json(
    response,
    outcome.created ? 201 : 200,
    {
      ok: true,
      expiresAt: outcome.expiresAt,
      ...(outcome.rotated ? { rotated: true } : {}),
      /* LIVE-2E: the account, by name only -- or `null`, which is the profile gate. */
      profile: api.identity.accountView(outcome.principalId, outcome.sessionId, now),
    },
    outcome.setCookie === null ? {} : { "Set-Cookie": outcome.setCookie },
  );
}

/* ==================================================================
    LIVE-2E: THE PROFILE ROUTES
   ================================================================== */

const tooMany = (response: ServerResponse, api: HttpApi, name: string, wait: number) => {
  api.limiter.deny(name);
  json(response, 429, { error: "rate-limited", retryAfterMs: wait }, retryAfter(wait));
};

async function serveProfile(
  response: ServerResponse,
  api: HttpApi,
  pathname: string,
  text: string,
  read: SessionCookieRead,
  ip: IpKey,
  now: number,
): Promise<void> {
  const schema: Record<string, FieldSpec> =
    pathname === PROFILE_PATH
      ? { name: { string: 256 }, creationReceipt: { string: 128 } }
      : pathname === RECOVER_PATH
        ? { recoveryKey: { string: 256 } }
        : pathname === REAUTH_PATH
          ? /* P3-ACCT: the recovery key (a legacy profile) or the password -- exactly one (checked below). */
            { recoveryKey: { string: 256 }, password: { string: 1024 } }
          : pathname === LINK_PATH
            ? { code: { string: 64 } }
            : pathname === RECOVERY_KEY_PATH || pathname === KEY_RECEIVED_PATH
              ? { creationReceipt: { string: 128 } }
              : pathname === ACCOUNT_CREATE_PATH
                ? { username: { string: 256 }, password: { string: 1024 }, name: { string: 256 } }
                : pathname === ACCOUNT_LOGIN_PATH || pathname === ACCOUNT_CREDENTIALS_PATH
                  ? { username: { string: 256 }, password: { string: 1024 } }
                  : pathname === ACCOUNT_PASSWORD_PATH
                    ? /* exactly one of the two current credentials (checked below) */ { currentPassword: { string: 1024 }, recoveryKey: { string: 256 }, newPassword: { string: 1024 } }
                    : pathname === ACCOUNT_RESET_PATH
                      ? { recoveryKey: { string: 256 }, newPassword: { string: 1024 } }
                      : {};
  const fields = parseBody(text, schema);
  if (fields === null) {
    json(response, 400, { error: "bad-request" });
    return;
  }
  /* Every profile route is an AUTHENTICATED request: the browser's own session (unprofiled or not), charged to that
     session's request budget. No cookie, or an ended one, is 401 -- the client bootstraps first. */
  const sessionId = api.identity.currentSession(read, now);
  if (sessionId === null) {
    json(response, 401, { error: "not-authenticated" });
    return;
  }
  const sessionWait = api.limiter.bootstraps.take(sessionId);
  if (sessionWait > 0) return tooMany(response, api, "bootstrap-session", sessionWait);

  if (pathname === ACCOUNT_CREATE_PATH || pathname === ACCOUNT_LOGIN_PATH) {
    await serveAccount(response, api, pathname, fields, read, ip, sessionId, now);
    return;
  }

  if (pathname === PROFILE_PATH) {
    /* P3-ACCT (review L2): new accounts are username + password (P3-ACCT POLICY: with ONE account-recovery key, made by
       the account create); this server makes no new LIVE-2E recovery-key-only profile (existing ones keep theirs). */
    if (!api.identity.legacyProfileCreation) {
      json(response, 410, { error: "use-account" });
      return;
    }
    const name = cleanProfileName(fields.name);
    if (name === null) {
      json(response, 400, { error: "bad-name" });
      return;
    }
    /* A browser that already has its profile (a retried create whose answer was lost) is told so without spending
       the creation budget: nothing would be written. The race is still settled inside the identity queue. */
    const who = api.identity.authenticate(read, now);
    const existing = who.kind === "ok" ? api.identity.profileName(who.principalId) : null;
    if (existing !== null) {
      json(response, 409, { error: "already-profiled", profile: { name: existing } });
      return;
    }
    const ipWait = api.limiter.profileCreates.peek(ip);
    const globalWait = ipWait > 0 ? 0 : api.limiter.profileCreatesGlobal.peek("global");
    if (ipWait > 0 || globalWait > 0) return tooMany(response, api, ipWait > 0 ? "profile-create-ip" : "profile-create-global", Math.max(ipWait, globalWait));
    api.limiter.profileCreates.take(ip);
    api.limiter.profileCreatesGlobal.take("global");
    const created = await api.identity.createProfile(read, name, now, fields.creationReceipt);
    switch (created.kind) {
      case "ok":
        /* The recovery key's one appearance. `no-store` is on every response here. */
        json(response, 201, { ok: true, profile: { name: created.name, otherSessions: 0 }, recoveryKey: created.recoveryKey });
        return;
      case "already-profiled":
        json(response, 409, { error: "already-profiled", profile: { name: created.name } });
        return;
      case "bad-name":
        json(response, 400, { error: "bad-name" });
        return;
      case "not-authenticated":
        json(response, 401, { error: "not-authenticated" });
        return;
      case "retired":
        json(response, 410, { error: "use-account" });
        return;
      default:
        json(response, 503, { error: "unavailable" }, retryAfter(5_000));
        return;
    }
  }

  if (pathname === RECOVER_PATH || pathname === LINK_PATH) {
    /* Redemptions. There is deliberately no server-wide budget (LIVE-2E review M1): with 256-bit keys and 100-bit
       single-use codes a global cap adds no protection against guessing, and it would let a few addresses switch off
       recovery -- the only way back into a profile -- for everybody.
       ESCROW-3A (brief §10C, LIVE-2F/3D C1-04): the ADDRESS budget is a FAILURE budget. It is charged only for a wrong
       credential, and it never stands between the holder of the RIGHT one and recovery: a neighbour on the same address
       (a NAT, a campus) sending wrong keys can exhaust it, and the right key still signs in. What it still controls is
       everything wrong: once exhausted, a wrong credential is answered 429 -- after the SAME constant-time verification
       and the same work as any other attempt, so neither the answer nor its timing says whether a selector exists, and
       a 200 is learned only by someone already holding a valid credential. Every attempt, right or wrong, is still
       charged to the SESSION making it (a caller cannot drain another browser's session budget). */
    const sessionRedeemWait = api.limiter.credentialRedeemsPerSession.peek(sessionId);
    if (sessionRedeemWait > 0) return tooMany(response, api, "credential-session", sessionRedeemWait);
    api.limiter.credentialRedeemsPerSession.take(sessionId);
    const addressExhausted = api.limiter.credentialRedeems.peek(ip);
    const outcome: CredentialOutcome =
      pathname === RECOVER_PATH ? await api.identity.recover(read, fields.recoveryKey, now) : await api.identity.redeemLink(read, fields.code, now);
    switch (outcome.kind) {
      case "ok":
        json(response, 200, { ok: true, profile: { name: outcome.name } }, { "Set-Cookie": outcome.setCookie });
        return;
      case "invalid":
        api.limiter.credentialRedeems.take(ip);
        if (addressExhausted > 0) return tooMany(response, api, "credential-ip", addressExhausted);
        json(response, 403, { error: "invalid-credential" });
        return;
      case "already-profiled":
        json(response, 409, { error: "already-profiled" });
        return;
      case "has-tables":
        /* About this browser's own principal only -- nothing about the credential or its profile is said. */
        json(response, 409, { error: "has-tables" });
        return;
      case "password-account":
        /* P3-ACCT POLICY: said only to the holder of this VALID key -- the key recovers the account ("Forgot
           password?"); it never signs in. */
        json(response, 409, { error: "use-password-reset" });
        return;
      case "not-authenticated":
        json(response, 401, { error: "not-authenticated" });
        return;
      default:
        json(response, 503, { error: "unavailable" }, retryAfter(5_000));
        return;
    }
  }

  /* P3-ACCT POLICY: "Forgot password?" -- budgeted exactly as a recovery is (the session's attempts; the address's
     FAILURE budget, which never stands between the right key and its account). The new password's KDF runs only for a
     key that matched (so wrong keys cost the server no KDF work). */
  if (pathname === ACCOUNT_RESET_PATH) {
    const sessionRedeemWait = api.limiter.credentialRedeemsPerSession.peek(sessionId);
    if (sessionRedeemWait > 0) return tooMany(response, api, "credential-session", sessionRedeemWait);
    api.limiter.credentialRedeemsPerSession.take(sessionId);
    const addressExhausted = api.limiter.credentialRedeems.peek(ip);
    const reset = await api.identity.resetPassword(read, { recoveryKey: fields.recoveryKey, newPassword: fields.newPassword }, now, { client: ip.key });
    switch (reset.kind) {
      case "ok":
        json(response, 200, { ok: true, profile: { name: reset.name }, signedOut: reset.signedOut }, { "Set-Cookie": reset.setCookie });
        return;
      case "invalid":
        api.limiter.credentialRedeems.take(ip);
        if (addressExhausted > 0) return tooMany(response, api, "credential-ip", addressExhausted);
        json(response, 403, { error: "invalid-credential" });
        return;
      case "bad-password":
        json(response, 400, { error: "bad-password", problem: reset.problem });
        return;
      case "no-password":
      case "already-profiled":
      case "has-tables":
        json(response, 409, { error: reset.kind });
        return;
      case "not-authenticated":
        json(response, 401, { error: "not-authenticated" });
        return;
      case "busy":
        json(response, 503, { error: "busy" }, retryAfter(2_000));
        return;
      default:
        json(response, 503, { error: "unavailable" }, retryAfter(5_000));
        return;
    }
  }

  /* P3-ACCT: a read of the account's own details -- under the session's request budget only (the menu asks it). */
  if (pathname === ACCOUNT_ME_PATH) {
    const details = api.identity.accountDetails(read, now);
    if (details === null) json(response, 403, { error: "profile-required" });
    else json(response, 200, { ok: true, account: details });
    return;
  }

  /* The profiled actions: budgeted per SESSION (LIVE-2E review H1) -- a budget shared by the whole principal would let
     one signed-in device spend it and keep the owner's other device from signing it out or rotating the key. */
  const wait = api.limiter.profileActions.take(sessionId);
  if (wait > 0) return tooMany(response, api, "profile-actions", wait);
  if (pathname === REAUTH_PATH) {
    /* ESCROW-3A: charged to this session's action budget like every profiled action (a stolen session can spend only
       its own), verified in constant time against THIS session's profile only. P3-ACCT: with the password instead of
       the recovery key -- never both -- the account's wrong-password budget applies too. */
    const byPassword = typeof fields.password === "string";
    if (byPassword === (typeof fields.recoveryKey === "string")) {
      json(response, 400, { error: "bad-request" });
      return;
    }
    /* P3-ACCT (review M2, M3; re-review N-1): a wrong password here is charged to this DEVICE's budget (its session
       family: a rotated cookie shares it) and to the ACCOUNT's own backstop (every signed-in device of it together, so
       new sessions minted from a stolen cookie add no guesses) -- both reserved before the KDF, so concurrent attempts
       cannot overshoot them, and given back unless the password was wrong. The anonymous per-username login budget is
       never read here: nobody outside the account can block the owner's own confirmation. (Internal ids key in-memory
       buckets only; none is ever sent.) */
    const context = byPassword ? api.identity.securityContextOf(read, now) : null;
    const familyKey = context?.familyId ?? sessionId;
    const accountKey = context?.principalId ?? null;
    if (byPassword) {
      const reauthWait = api.limiter.passwordReauthFailures.take(familyKey);
      if (reauthWait > 0) return tooMany(response, api, "password-reauth", reauthWait);
      if (accountKey !== null) {
        const accountWait = api.limiter.passwordReauthFailuresPerAccount.take(accountKey);
        if (accountWait > 0) {
          api.limiter.passwordReauthFailures.give(familyKey);
          return tooMany(response, api, "password-reauth-account", accountWait);
        }
      }
    }
    const reauth = byPassword ? await api.identity.reauthenticateWithPassword(read, fields.password, now, { client: ip.key }) : await api.identity.reauthenticate(read, fields.recoveryKey, now);
    if (byPassword && reauth.kind !== "invalid") {
      api.limiter.passwordReauthFailures.give(familyKey);
      if (accountKey !== null) api.limiter.passwordReauthFailuresPerAccount.give(accountKey);
    }
    switch (reauth.kind) {
      case "ok":
        json(response, 200, { ok: true, expiresAt: reauth.expiresAt });
        return;
      case "invalid":
        json(response, 403, { error: "invalid-credential" });
        return;
      case "busy":
        json(response, 503, { error: "busy" }, retryAfter(2_000));
        return;
      case "profile-required":
        json(response, 403, { error: "profile-required" });
        return;
      default:
        json(response, 401, { error: "not-authenticated" });
        return;
    }
  }
  if (pathname === ACCOUNT_PASSWORD_PATH) {
    /* P3-ACCT POLICY "Change password": exactly one current credential, in the request. A wrong CURRENT PASSWORD is
       charged exactly as "Confirm it's you" charges one (this device's family, and the account's own backstop; reserved
       before the KDF, given back unless it was wrong); a recovery key cannot be guessed (the session's action budget). */
    const byPassword = typeof fields.currentPassword === "string";
    if (byPassword === (typeof fields.recoveryKey === "string") || typeof fields.newPassword !== "string") {
      json(response, 400, { error: "bad-request" });
      return;
    }
    const context = api.identity.securityContextOf(read, now);
    const familyKey = context?.familyId ?? sessionId;
    const accountKey = context?.principalId ?? null;
    /* Security review L5: every attempt is charged to the ACCOUNT (a success mints a fresh session, so a per-session
       budget would start over each time); given back below only when nothing was checked or written. */
    const changeKey = accountKey ?? sessionId;
    const changeWait = api.limiter.passwordChanges.take(changeKey);
    if (changeWait > 0) return tooMany(response, api, "password-change-account", changeWait);
    if (byPassword) {
      const reauthWait = api.limiter.passwordReauthFailures.take(familyKey);
      if (reauthWait > 0) {
        api.limiter.passwordChanges.give(changeKey);
        return tooMany(response, api, "password-reauth", reauthWait);
      }
      if (accountKey !== null) {
        const accountWait = api.limiter.passwordReauthFailuresPerAccount.take(accountKey);
        if (accountWait > 0) {
          api.limiter.passwordReauthFailures.give(familyKey);
          api.limiter.passwordChanges.give(changeKey);
          return tooMany(response, api, "password-reauth-account", accountWait);
        }
      }
    }
    const current: CurrentCredential = byPassword ? { password: fields.currentPassword } : { recoveryKey: fields.recoveryKey };
    const changed = await api.identity.changePassword(read, { current, newPassword: fields.newPassword }, now, { client: ip.key });
    if (byPassword && changed.kind !== "invalid") {
      api.limiter.passwordReauthFailures.give(familyKey);
      if (accountKey !== null) api.limiter.passwordReauthFailuresPerAccount.give(accountKey);
    }
    if (changed.kind !== "ok" && changed.kind !== "invalid") api.limiter.passwordChanges.give(changeKey);
    switch (changed.kind) {
      case "ok":
        json(response, 200, { ok: true, signedOut: changed.signedOut }, { "Set-Cookie": changed.setCookie });
        return;
      case "invalid":
        json(response, 403, { error: "invalid-credential" });
        return;
      case "bad-password":
        json(response, 400, { error: "bad-password", problem: changed.problem });
        return;
      case "no-password":
        json(response, 409, { error: "no-password" });
        return;
      case "profile-required":
        json(response, 403, { error: "profile-required" });
        return;
      case "not-authenticated":
        json(response, 401, { error: "not-authenticated" });
        return;
      case "busy":
        json(response, 503, { error: "busy" }, retryAfter(2_000));
        return;
      default:
        json(response, 503, { error: "unavailable" }, retryAfter(5_000));
        return;
    }
  }
  if (pathname === ACCOUNT_CREDENTIALS_PATH) {
    const established = await api.identity.establishCredentials(read, { username: fields.username, password: fields.password }, now, { client: ip.key });
    switch (established.kind) {
      case "ok":
        json(response, 200, { ok: true, username: established.username });
        return;
      case "bad-username":
        json(response, 400, { error: "bad-username" });
        return;
      case "bad-password":
        json(response, 400, { error: "bad-password", problem: established.problem });
        return;
      case "username-taken":
      case "credentials-exist":
        json(response, 409, { error: established.kind });
        return;
      case "reauth-required":
      case "profile-required":
        json(response, 403, { error: established.kind });
        return;
      case "not-authenticated":
        json(response, 401, { error: "not-authenticated" });
        return;
      case "busy":
        json(response, 503, { error: "busy" }, retryAfter(2_000));
        return;
      default:
        json(response, 503, { error: "unavailable" }, retryAfter(5_000));
        return;
    }
  }
  if (pathname === ACCOUNT_FORGET_WALLET_PATH) {
    const forgot = await api.identity.forgetWallet(read, now);
    switch (forgot.kind) {
      case "ok":
        json(response, 200, { ok: true, forgot: forgot.forgot });
        return;
      case "reauth-required":
      case "profile-required":
        json(response, 403, { error: forgot.kind });
        return;
      case "not-authenticated":
        json(response, 401, { error: "not-authenticated" });
        return;
      default:
        json(response, 503, { error: "unavailable" }, retryAfter(5_000));
        return;
    }
  }
  if (pathname === KEY_RECEIVED_PATH) {
    const acknowledged = await api.identity.acknowledgeKeyDelivery(read, fields.creationReceipt, now);
    if (acknowledged.kind === "ok") json(response, 204, null);
    else if (acknowledged.kind === "profile-required") json(response, 403, { error: "profile-required" });
    else json(response, 401, { error: "not-authenticated" });
    return;
  }
  const answered =
    pathname === LINK_CODE_PATH
      ? await api.identity.createLinkCode(read, now)
      : pathname === RECOVERY_KEY_PATH
        ? await api.identity.rotateRecoveryKey(read, now, fields.creationReceipt)
        : await api.identity.signOutOthers(read, now);
  switch (answered.kind) {
    case "ok": {
      const { kind: _kind, ...rest } = answered;
      json(response, pathname === LINK_CODE_PATH ? 201 : 200, { ok: true, ...rest });
      return;
    }
    case "profile-required":
      json(response, 403, { error: "profile-required" });
      return;
    case "reauth-required":
      json(response, 403, { error: "reauth-required" });
      return;
    case "no-recovery-key":
      json(response, 409, { error: "no-recovery-key" });
      return;
    case "not-authenticated":
      json(response, 401, { error: "not-authenticated" });
      return;
    default:
      json(response, 503, { error: "unavailable" }, retryAfter(5_000));
      return;
  }
}

/* ==================================================================
    P3-ACCT: CREATE ACCOUNT AND LOG IN
   ================================================================== */

async function serveAccount(
  response: ServerResponse,
  api: HttpApi,
  pathname: string,
  fields: Record<string, string | boolean>,
  read: SessionCookieRead,
  ip: IpKey,
  sessionId: string,
  now: number,
): Promise<void> {
  if (pathname === ACCOUNT_CREATE_PATH) {
    const name = cleanProfileName(fields.name);
    if (name === null) {
      json(response, 400, { error: "bad-name" });
      return;
    }
    /* A browser already signed in is told so before any budget is spent (nothing would be written). */
    const who = api.identity.authenticate(read, now);
    const existing = who.kind === "ok" ? api.identity.profileName(who.principalId) : null;
    if (existing !== null) {
      json(response, 409, { error: "already-profiled", profile: { name: existing } });
      return;
    }
    /* Account creation writes durable records: the profile-creation budgets (per address, and the server's). */
    const ipWait = api.limiter.profileCreates.peek(ip);
    const globalWait = ipWait > 0 ? 0 : api.limiter.profileCreatesGlobal.peek("global");
    if (ipWait > 0 || globalWait > 0) return tooMany(response, api, ipWait > 0 ? "profile-create-ip" : "profile-create-global", Math.max(ipWait, globalWait));
    api.limiter.profileCreates.take(ip);
    api.limiter.profileCreatesGlobal.take("global");
    const created = await api.identity.createAccount(read, { username: fields.username, password: fields.password, displayName: name }, now, { client: ip.key });
    /* Review M1: a create the KDF gate turned away wrote nothing and checked nothing -- its tokens go back. */
    if (created.kind === "busy") {
      api.limiter.profileCreates.give(ip);
      api.limiter.profileCreatesGlobal.give("global");
    }
    switch (created.kind) {
      case "ok":
        /* P3-ACCT POLICY: the recovery key's ONE appearance (`no-store` is on every response here). */
        json(response, 201, { ok: true, profile: { name: created.name, otherSessions: 0 }, username: created.username, recoveryKey: created.recoveryKey }, { "Set-Cookie": created.setCookie });
        return;
      case "already-profiled":
        json(response, 409, { error: "already-profiled", profile: { name: created.name } });
        return;
      case "username-taken":
        json(response, 409, { error: "username-taken" });
        return;
      case "bad-username":
      case "bad-name":
        json(response, 400, { error: created.kind });
        return;
      case "bad-password":
        json(response, 400, { error: "bad-password", problem: created.problem });
        return;
      case "not-authenticated":
        json(response, 401, { error: "not-authenticated" });
        return;
      case "busy":
        json(response, 503, { error: "busy" }, retryAfter(2_000));
        return;
      default:
        json(response, 503, { error: "unavailable" }, retryAfter(5_000));
        return;
    }
  }

  /* LOG IN. Every attempt is charged to this SESSION; the address's and the username's WRONG-password budgets are
     looked at first and, spent, refuse at once (before any check: nothing is learned and nothing is guessed). */
  const sessionWait = api.limiter.passwordLogins.take(sessionId);
  if (sessionWait > 0) return tooMany(response, api, "password-session", sessionWait);
  /* Review M3: the WRONG-password budgets are RESERVED before the KDF -- the address's, the username's from this address,
     and the username's from everywhere -- so attempts in flight together can never overshoot them; each is given back
     unless the attempt turns out wrong. Review M2: the username's hard limit is per ADDRESS; the all-addresses one is a
     wider backstop, so a stranger who knows a username cannot cheaply lock its owner out. */
  const name = cleanLoginName(fields.username);
  const accountKey = name === null ? null : loginKeyOf(name);
  const pairKey = accountKey === null ? null : `${accountKey}\u0000${ip.key}`;
  const addressWait = api.limiter.passwordFailures.take(ip);
  if (addressWait > 0) return tooMany(response, api, "password-ip", addressWait);
  if (accountKey !== null && pairKey !== null) {
    const pairWait = api.limiter.passwordFailuresPerAccountAddress.take(pairKey);
    if (pairWait > 0) {
      api.limiter.passwordFailures.give(ip);
      return tooMany(response, api, "password-account-address", pairWait);
    }
    const accountWait = api.limiter.passwordFailuresPerAccount.take(accountKey);
    if (accountWait > 0) {
      api.limiter.passwordFailures.give(ip);
      api.limiter.passwordFailuresPerAccountAddress.give(pairKey);
      return tooMany(response, api, "password-account", accountWait);
    }
  }
  const outcome = await api.identity.login(read, { username: fields.username, password: fields.password }, now, { client: ip.key });
  /* Re-review NIT: a login the KDF gate turned away checked nothing -- this session's own attempt goes back too. */
  if (outcome.kind === "busy") api.limiter.passwordLogins.give(sessionId);
  if (outcome.kind !== "invalid") {
    api.limiter.passwordFailures.give(ip);
    if (accountKey !== null && pairKey !== null) {
      api.limiter.passwordFailuresPerAccountAddress.give(pairKey);
      api.limiter.passwordFailuresPerAccount.give(accountKey);
    }
  }
  switch (outcome.kind) {
    case "ok":
      json(response, 200, { ok: true, profile: { name: outcome.name } }, { "Set-Cookie": outcome.setCookie });
      return;
    case "invalid":
      json(response, 403, { error: "invalid-credential" });
      return;
    case "already-profiled":
      json(response, 409, { error: "already-profiled" });
      return;
    case "has-tables":
      json(response, 409, { error: "has-tables" });
      return;
    case "not-authenticated":
      json(response, 401, { error: "not-authenticated" });
      return;
    case "busy":
      json(response, 503, { error: "busy" }, retryAfter(2_000));
      return;
    default:
      json(response, 503, { error: "unavailable" }, retryAfter(5_000));
      return;
  }
}
