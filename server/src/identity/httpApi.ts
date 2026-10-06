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
// THE ACCOUNT (PHASE 3 FINAL, owner ruling 2026-10-06): THE PROFILE / ACCOUNT IS THE PLAYER. An account is a username, a
// password and ONE designated AUTHORIZATION WALLET (`sessions.ts`, `authorizationWallet.ts`). Ordinary sign-in is the
// username and password -- never a wallet. The Authorization Wallet signs only account actions: creating the account,
// "Forgot password?" and approving its own replacement. There is NO recovery key and NO email anywhere.
//   POST /gs/api/account/authorization {purpose: "create" | "recover", username, wallet}   (signed out) the text the
//                                                          wallet signs for this browser: 200 {operation, texts:[{purpose,
//                                                          signer, text}], expiresAt}. CREATE: 409 username-taken (before
//                                                          Keplr signs). RECOVER looks NOTHING up (no enumeration).
//   POST /gs/api/account/create        {username, password, name, operation, pubKey, signature}  this browser's
//                                                          account, its Authorization Wallet the CREATE text's signer: 201
//                                                          {profile, username} + a FRESH session cookie (the temporary one
//                                                          is `replaced`). 400 bad-username / bad-password {problem} /
//                                                          bad-name; 409 username-taken / already-profiled; 403
//                                                          authorization-invalid; 409 authorization-used.
//   POST /gs/api/account/login         {username, password}  200 {profile} + a fresh session cookie for the account's
//                                                          principal. ONE answer for every wrong or unknown username or
//                                                          password: 403 invalid-credential, after the same KDF work. The
//                                                          right password of a LEGACY account (made before Authorization
//                                                          Wallets): 409 legacy-account.
//   POST /gs/api/account/me            {}             (profiled) the account's own details: username, Authorization
//                                                          Wallet (address and since), member since.
//   POST /gs/api/account/password      {currentPassword, newPassword}  (profiled) "Change password": 200 {signedOut} + a
//                                                          FRESH cookie for this browser (same family); every other device
//                                                          is signed out. 403 invalid-credential; 400 bad-password.
//   POST /gs/api/account/recover       {operation, pubKey, signature, newPassword}  (signed out) "Forgot password?" by the
//                                                          Authorization Wallet: 200 {profile, signedOut} + a fresh cookie;
//                                                          every earlier session of the account ends. ONE answer (403
//                                                          invalid-credential) for every refusal: a bad signature, a
//                                                          wallet that is not that account's Authorization Wallet, an
//                                                          unknown, disabled or legacy account, an unknown or expired
//                                                          operation. 409 authorization-used (a replay).
//   POST /gs/api/account/authorization-wallet/challenge  {newWallet}  (profiled, under an explicit "Confirm it's you")
//                                                          the two replacement texts: 200 {operation, texts, expiresAt};
//                                                          403 reauth-required; 409 same-wallet.
//   POST /gs/api/account/authorization-wallet/replace    {operation, approvePubKey, approveSignature, acceptPubKey,
//                                                          acceptSignature}  (profiled) the CURRENT wallet's approval and
//                                                          the NEW wallet's acceptance: 200 {authorizationWallet}; 403
//                                                          authorization-invalid; 409 authorization-used / stale.
//   POST /gs/api/profile/sign-out-others {}           (profiled, SENSITIVE) 200 {signedOut}
//   POST /gs/api/profile/reauth        {password}     "Confirm it's you": 200 {expiresAt}; 403 invalid-credential.
// RETIRED (answer 410 `retired`): the LIVE-2E profile create, the recovery-key recover / rotate / key-received /
// re-authenticate paths, "Link another device" codes, the legacy credential migration, "Forget this wallet" and the
// recovery-key "Forgot password?". No route here issues, shows, accepts or stores a recovery key.
// Budgets: every sign-in attempt per SESSION; WRONG passwords per address and per username -- spent, every password
// attempt there is refused 429 BEFORE any check. Recoveries per session, and the address's FAILURE budget. A KDF the
// server is already running too many of answers 503 `busy`. No password is ever logged, echoed, put in a URL or kept.
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
import type { IdentityService, MintOutcome } from "./sessions";

export const SESSION_PATH = "/gs/api/session";
export const REVOKE_PATH = "/gs/api/session/revoke";
export const HEALTH_PATH = "/gs/healthz";
export const SIGN_OUT_OTHERS_PATH = "/gs/api/profile/sign-out-others";
export const REAUTH_PATH = "/gs/api/profile/reauth";
/* P3-ACCT */
export const ACCOUNT_CREATE_PATH = "/gs/api/account/create";
export const ACCOUNT_LOGIN_PATH = "/gs/api/account/login";
export const ACCOUNT_ME_PATH = "/gs/api/account/me";
/* P3-ACCT POLICY */
export const ACCOUNT_PASSWORD_PATH = "/gs/api/account/password";
/* PHASE 3 FINAL: the Authorization Wallet */
export const ACCOUNT_AUTHORIZATION_PATH = "/gs/api/account/authorization";
export const ACCOUNT_RECOVER_PATH = "/gs/api/account/recover";
export const ACCOUNT_WALLET_CHALLENGE_PATH = "/gs/api/account/authorization-wallet/challenge";
export const ACCOUNT_WALLET_REPLACE_PATH = "/gs/api/account/authorization-wallet/replace";
/** PHASE 3 FINAL: the recovery-key and device-link product, retired: these answer 410 `retired` (nothing is read). */
export const RETIRED_PATHS: ReadonlySet<string> = new Set([
  "/gs/api/profile",
  "/gs/api/profile/recover",
  "/gs/api/profile/link",
  "/gs/api/profile/link-code",
  "/gs/api/profile/recovery-key",
  "/gs/api/profile/key-received",
  "/gs/api/account/credentials",
  "/gs/api/account/forget-wallet",
  "/gs/api/account/reset",
]);
const API_PREFIX = "/gs/api/";
const ROUTES = new Set([
  SESSION_PATH,
  REVOKE_PATH,
  SIGN_OUT_OTHERS_PATH,
  REAUTH_PATH,
  ACCOUNT_CREATE_PATH,
  ACCOUNT_LOGIN_PATH,
  ACCOUNT_ME_PATH,
  ACCOUNT_PASSWORD_PATH,
  ACCOUNT_AUTHORIZATION_PATH,
  ACCOUNT_RECOVER_PATH,
  ACCOUNT_WALLET_CHALLENGE_PATH,
  ACCOUNT_WALLET_REPLACE_PATH,
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
  if (RETIRED_PATHS.has(pathname)) {
    /* PHASE 3 FINAL: the recovery-key product is gone; say so plainly (a stale client learns why). */
    json(response, 410, { error: "retired" });
    request.resume();
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
    await serveProfile(response, api, pathname, body.text, read, client.ip, now, request.headers.origin as string);
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
    THE ACCOUNT ROUTES
   ================================================================== */

const tooMany = (response: ServerResponse, api: HttpApi, name: string, wait: number) => {
  api.limiter.deny(name);
  json(response, 429, { error: "rate-limited", retryAfterMs: wait }, retryAfter(wait));
};

/** A signature field as the browser sends Keplr's answer: base64 (a 33-byte key is 44 characters, a 64-byte signature 88). */
const SIGNATURE_FIELDS = { pubKey: { string: 64 }, signature: { string: 128 } } as const;

/** The closed body of each route. */
const SCHEMAS: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>> = {
  [ACCOUNT_AUTHORIZATION_PATH]: { purpose: { string: 16 }, username: { string: 256 }, wallet: { string: 128 } },
  [ACCOUNT_CREATE_PATH]: { username: { string: 256 }, password: { string: 1024 }, name: { string: 256 }, operation: { string: 64 }, ...SIGNATURE_FIELDS },
  [ACCOUNT_LOGIN_PATH]: { username: { string: 256 }, password: { string: 1024 } },
  [ACCOUNT_PASSWORD_PATH]: { currentPassword: { string: 1024 }, newPassword: { string: 1024 } },
  [ACCOUNT_RECOVER_PATH]: { operation: { string: 64 }, newPassword: { string: 1024 }, ...SIGNATURE_FIELDS },
  [ACCOUNT_WALLET_CHALLENGE_PATH]: { newWallet: { string: 128 } },
  [ACCOUNT_WALLET_REPLACE_PATH]: { operation: { string: 64 }, approvePubKey: { string: 64 }, approveSignature: { string: 128 }, acceptPubKey: { string: 64 }, acceptSignature: { string: 128 } },
  [REAUTH_PATH]: { password: { string: 1024 } },
};

/** A minted operation's answer (the texts the browser checks, then asks Keplr to sign), or its refusal. */
function answerMint(response: ServerResponse, minted: MintOutcome): void {
  switch (minted.kind) {
    case "ok":
      json(response, 200, { ok: true, operation: minted.operation, texts: minted.texts, expiresAt: minted.expiresAt });
      return;
    case "bad-username":
    case "bad-wallet":
      json(response, 400, { error: minted.kind });
      return;
    case "username-taken":
    case "already-profiled":
    case "has-tables":
    case "same-wallet":
      json(response, 409, { error: minted.kind });
      return;
    case "reauth-required":
    case "profile-required":
      json(response, 403, { error: minted.kind });
      return;
    case "busy":
      json(response, 503, { error: "busy" }, retryAfter(5_000));
      return;
    default:
      json(response, 401, { error: "not-authenticated" });
      return;
  }
}

async function serveProfile(
  response: ServerResponse,
  api: HttpApi,
  pathname: string,
  text: string,
  read: SessionCookieRead,
  ip: IpKey,
  now: number,
  origin: string,
): Promise<void> {
  const fields = parseBody(text, SCHEMAS[pathname] ?? {});
  if (fields === null) {
    json(response, 400, { error: "bad-request" });
    return;
  }
  /* Every account route is an AUTHENTICATED request: the browser's own session (signed out or not), charged to that
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

  /* PHASE 3 FINAL: the text a signed-out browser's wallet signs (CREATE / RECOVER). Minting writes nothing; a CREATE
     says "username taken" before Keplr signs (account creation necessarily says so) -- and that answer spends the
     address's creation budget; a RECOVER looks nothing up. */
  if (pathname === ACCOUNT_AUTHORIZATION_PATH) {
    if (fields.purpose !== "create" && fields.purpose !== "recover") {
      json(response, 400, { error: "bad-request" });
      return;
    }
    if (fields.purpose === "create") {
      const ipWait = api.limiter.profileCreates.peek(ip);
      if (ipWait > 0) return tooMany(response, api, "profile-create-ip", ipWait);
    } else {
      const redeemWait = api.limiter.credentialRedeemsPerSession.peek(sessionId);
      if (redeemWait > 0) return tooMany(response, api, "credential-session", redeemWait);
    }
    const minted = api.identity.mintAuthorization(read, { purpose: fields.purpose, username: fields.username, wallet: fields.wallet, site: origin }, now);
    /* Security review (M1): "username taken" tells whoever asks that an account exists. That answer is CHARGED to the
       address's account-creation budget (5, then 10 an hour), so a stranger learns no more existing usernames than the
       accounts it could create -- and once the budget is spent every CREATE mint from the address answers 429 above. */
    if (fields.purpose === "create" && minted.kind === "username-taken") api.limiter.profileCreates.take(ip);
    answerMint(response, minted);
    return;
  }

  /* "Forgot password?" by the Authorization Wallet -- budgeted as every recovery is: the session's attempts, and the
     address's FAILURE budget (charged only for a refused one; it never stands between the right wallet and its account,
     and a refusal past it is answered after the same work). The new password's KDF runs only for a proof that matched. */
  if (pathname === ACCOUNT_RECOVER_PATH) {
    const sessionRedeemWait = api.limiter.credentialRedeemsPerSession.peek(sessionId);
    if (sessionRedeemWait > 0) return tooMany(response, api, "credential-session", sessionRedeemWait);
    api.limiter.credentialRedeemsPerSession.take(sessionId);
    const addressExhausted = api.limiter.credentialRedeems.peek(ip);
    const recovered = await api.identity.recoverAccount(read, { operation: fields.operation, pubKey: fields.pubKey, signature: fields.signature, newPassword: fields.newPassword }, now, { client: ip.key });
    switch (recovered.kind) {
      case "ok":
        json(response, 200, { ok: true, profile: { name: recovered.name }, signedOut: recovered.signedOut }, { "Set-Cookie": recovered.setCookie });
        return;
      case "invalid":
        api.limiter.credentialRedeems.take(ip);
        if (addressExhausted > 0) return tooMany(response, api, "credential-ip", addressExhausted);
        json(response, 403, { error: "invalid-credential" });
        return;
      case "bad-password":
        json(response, 400, { error: "bad-password", problem: recovered.problem });
        return;
      case "authorization-used":
      case "already-profiled":
      case "has-tables":
        json(response, 409, { error: recovered.kind });
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

  /* A read of the account's own details -- under the session's request budget only (the menu asks it). */
  if (pathname === ACCOUNT_ME_PATH) {
    const details = api.identity.accountDetails(read, now);
    if (details === null) json(response, 403, { error: "profile-required" });
    else json(response, 200, { ok: true, account: details });
    return;
  }

  /* The profiled actions: budgeted per SESSION (LIVE-2E review H1) -- a budget shared by the whole principal would let
     one signed-in device spend it and keep the owner's other device from signing it out. */
  const wait = api.limiter.profileActions.take(sessionId);
  if (wait > 0) return tooMany(response, api, "profile-actions", wait);

  if (pathname === REAUTH_PATH) {
    /* "Confirm it's you" with the password. A wrong password is charged to this DEVICE's budget (its session family: a
       rotated cookie shares it) and to the ACCOUNT's own backstop (every signed-in device of it together, so new sessions
       minted from a stolen cookie add no guesses) -- both reserved before the KDF, so concurrent attempts cannot overshoot
       them, and given back unless the password was wrong. The anonymous per-username login budget is never read here:
       nobody outside the account can block the owner's own confirmation. (Internal ids key in-memory buckets only.) */
    if (typeof fields.password !== "string") {
      json(response, 400, { error: "bad-request" });
      return;
    }
    const context = api.identity.securityContextOf(read, now);
    const familyKey = context?.familyId ?? sessionId;
    const accountKey = context?.principalId ?? null;
    const reauthWait = api.limiter.passwordReauthFailures.take(familyKey);
    if (reauthWait > 0) return tooMany(response, api, "password-reauth", reauthWait);
    if (accountKey !== null) {
      const accountWait = api.limiter.passwordReauthFailuresPerAccount.take(accountKey);
      if (accountWait > 0) {
        api.limiter.passwordReauthFailures.give(familyKey);
        return tooMany(response, api, "password-reauth-account", accountWait);
      }
    }
    const reauth = await api.identity.reauthenticateWithPassword(read, fields.password, now, { client: ip.key });
    if (reauth.kind !== "invalid") {
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
    /* "Change password": the current password, in the request. A wrong one is charged exactly as "Confirm it's you"
       charges one (this device's family, and the account's own backstop; reserved before the KDF, given back unless it
       was wrong); every attempt is charged to the ACCOUNT's change budget (a success mints a fresh session, so a
       per-session budget would start over each time), given back when nothing was checked or written. */
    if (typeof fields.currentPassword !== "string" || typeof fields.newPassword !== "string") {
      json(response, 400, { error: "bad-request" });
      return;
    }
    const context = api.identity.securityContextOf(read, now);
    const familyKey = context?.familyId ?? sessionId;
    const accountKey = context?.principalId ?? null;
    const changeKey = accountKey ?? sessionId;
    const changeWait = api.limiter.passwordChanges.take(changeKey);
    if (changeWait > 0) return tooMany(response, api, "password-change-account", changeWait);
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
    const changed = await api.identity.changePassword(read, { currentPassword: fields.currentPassword, newPassword: fields.newPassword }, now, { client: ip.key });
    if (changed.kind !== "invalid") {
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

  /* PHASE 3 FINAL: "Change Authorization Wallet" -- the two texts (under an explicit "Confirm it's you"), then the two
     signatures. Charged to the session's action budget (each step above already took one). */
  if (pathname === ACCOUNT_WALLET_CHALLENGE_PATH) {
    answerMint(response, api.identity.mintReplacement(read, { newWallet: fields.newWallet, site: origin }, now));
    return;
  }
  if (pathname === ACCOUNT_WALLET_REPLACE_PATH) {
    const replaced = await api.identity.replaceAuthorizationWallet(
      read,
      { operation: fields.operation, approve: { pubKey: fields.approvePubKey, signature: fields.approveSignature }, accept: { pubKey: fields.acceptPubKey, signature: fields.acceptSignature } },
      now,
    );
    switch (replaced.kind) {
      case "ok":
        json(response, 200, { ok: true, authorizationWallet: replaced.authorizationWallet });
        return;
      case "authorization-invalid":
      case "reauth-required":
      case "profile-required":
        json(response, 403, { error: replaced.kind });
        return;
      case "authorization-used":
      case "stale":
        json(response, 409, { error: replaced.kind });
        return;
      case "not-authenticated":
        json(response, 401, { error: "not-authenticated" });
        return;
      default:
        json(response, 503, { error: "unavailable" }, retryAfter(5_000));
        return;
    }
  }

  /* SIGN_OUT_OTHERS_PATH (the last route left). */
  const answered = await api.identity.signOutOthers(read, now);
  switch (answered.kind) {
    case "ok":
      json(response, 200, { ok: true, signedOut: answered.signedOut });
      return;
    case "profile-required":
    case "reauth-required":
      json(response, 403, { error: answered.kind });
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
    CREATE ACCOUNT AND LOG IN
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
    const created = await api.identity.createAccount(
      read,
      { username: fields.username, password: fields.password, displayName: name, authorization: { operation: fields.operation, pubKey: fields.pubKey, signature: fields.signature } },
      now,
      { client: ip.key },
    );
    /* Review M1: a create the KDF gate turned away (or the store refused) wrote nothing -- its tokens go back. */
    if (created.kind === "busy" || created.kind === "unavailable") {
      api.limiter.profileCreates.give(ip);
      api.limiter.profileCreatesGlobal.give("global");
    }
    switch (created.kind) {
      case "ok":
        json(response, 201, { ok: true, profile: { name: created.name, otherSessions: 0 }, username: created.username }, { "Set-Cookie": created.setCookie });
        return;
      case "already-profiled":
        json(response, 409, { error: "already-profiled", profile: { name: created.name } });
        return;
      case "username-taken":
      case "authorization-used":
        json(response, 409, { error: created.kind });
        return;
      case "authorization-invalid":
        json(response, 403, { error: "authorization-invalid" });
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
    case "has-tables":
    case "legacy-account":
      json(response, 409, { error: outcome.kind });
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
