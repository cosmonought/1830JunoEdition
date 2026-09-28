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
import { cleanProfileName } from "./profileName";
import type { CredentialOutcome, IdentityService } from "./sessions";

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
const API_PREFIX = "/gs/api/";
const ROUTES = new Set([SESSION_PATH, REVOKE_PATH, PROFILE_PATH, RECOVER_PATH, LINK_PATH, LINK_CODE_PATH, RECOVERY_KEY_PATH, SIGN_OUT_OTHERS_PATH, REAUTH_PATH, KEY_RECEIVED_PATH]);

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
      : pathname === RECOVER_PATH || pathname === REAUTH_PATH
        ? { recoveryKey: { string: 256 } }
        : pathname === LINK_PATH
          ? { code: { string: 64 } }
          : pathname === RECOVERY_KEY_PATH || pathname === KEY_RECEIVED_PATH
            ? { creationReceipt: { string: 128 } }
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

  if (pathname === PROFILE_PATH) {
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
      case "not-authenticated":
        json(response, 401, { error: "not-authenticated" });
        return;
      default:
        json(response, 503, { error: "unavailable" }, retryAfter(5_000));
        return;
    }
  }

  /* The profiled actions: budgeted per SESSION (LIVE-2E review H1) -- a budget shared by the whole principal would let
     one signed-in device spend it and keep the owner's other device from signing it out or rotating the key. */
  const wait = api.limiter.profileActions.take(sessionId);
  if (wait > 0) return tooMany(response, api, "profile-actions", wait);
  if (pathname === REAUTH_PATH) {
    /* ESCROW-3A: charged to this session's action budget like every profiled action (a stolen session can spend only
       its own), verified in constant time against THIS session's profile only. */
    const reauth = await api.identity.reauthenticate(read, fields.recoveryKey, now);
    switch (reauth.kind) {
      case "ok":
        json(response, 200, { ok: true, expiresAt: reauth.expiresAt });
        return;
      case "invalid":
        json(response, 403, { error: "invalid-credential" });
        return;
      case "profile-required":
        json(response, 403, { error: "profile-required" });
        return;
      default:
        json(response, 401, { error: "not-authenticated" });
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
    case "not-authenticated":
      json(response, 401, { error: "not-authenticated" });
      return;
    default:
      json(response, 503, { error: "unavailable" }, retryAfter(5_000));
      return;
  }
}
