// server/src/identity/httpApi.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §4.1): THE SAME-ORIGIN HTTP SURFACE
// ==================================================================
//
//   POST /gs/api/session          bootstrap: 200 (the current session, rotated when older than 7 days, with a new
//                                 cookie then); 201 + Set-Cookie (a new provisional guest: no cookie, an unknown
//                                 selector, or the explicit `{"fresh": true}`); 401 `session-ended` {reason} for a
//                                 KNOWN session that has ended -- never a silent new guest; 403 origin-forbidden;
//                                 429 rate-limited; 503 when the store did not take a rotation.
//   POST /gs/api/session/revoke   the current session only: revoked "logout" (durable first), cookie cleared, its
//                                 sockets closed 4401, 204.
//   GET  /gs/healthz              200 "ok", nothing else.
//
// EVERY `/gs/api/*` REQUEST: POST only; an allow-listed Origin (exact); `Content-Type: application/json` (which a
// cross-site form cannot send without a preflight nobody answers); a body of at most 4 KiB, a closed JSON object;
// `Cache-Control: no-store`; and NO CORS header, ever. `/gs/api/me/games` is LIVE-2C's and answers 404 here.
//
// NOTHING HERE LOGS A REQUEST'S HEADERS, COOKIE OR BODY, and no response carries a principal id: the principal
// never goes on the wire (LIVE-2 §3.2).

import type { IncomingMessage, ServerResponse } from "http";

import type { IdentityLimits } from "../ingress/limits";
import { clearedSessionCookie, readSessionCookie } from "./cookies";
import { clientIpOf } from "./clientIp";
import type { IdentityLimiter } from "./limiter";
import type { GsMode } from "./mode";
import { originAllowed } from "./origins";
import type { IdentityService } from "./sessions";

export const SESSION_PATH = "/gs/api/session";
export const REVOKE_PATH = "/gs/api/session/revoke";
export const HEALTH_PATH = "/gs/healthz";
const API_PREFIX = "/gs/api/";

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

function json(response: ServerResponse, status: number, body: object | null, headers: Record<string, string | string[]> = {}): void {
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

const retryAfter = (ms: number) => ({ "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) });

/** A body of at most `max` bytes, or why not. Never buffers past the cap. */
function readBody(request: IncomingMessage, max: number): Promise<{ ok: true; text: string } | { ok: false; status: 400 | 413 }> {
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

/** The closed body: an object with only `allowed` keys, each boolean. `""` is `{}`. */
function parseBody(text: string, allowed: readonly string[]): Record<string, boolean> | null {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, boolean> = {};
  for (const key of Object.keys(value)) {
    const field = (value as Record<string, unknown>)[key];
    if (!allowed.includes(key) || typeof field !== "boolean") return null;
    out[key] = field;
  }
  return out;
}

const isJson = (header: string | undefined): boolean =>
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
  if (pathname !== SESSION_PATH && pathname !== REVOKE_PATH) {
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
    if (parseBody(body.text, []) === null) {
      json(response, 400, { error: "bad-request" });
      return;
    }
    const sessionId = api.identity.currentSession(read, now);
    if (sessionId === null) {
      json(response, 401, { error: "not-authenticated" });
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

  const fields = parseBody(body.text, ["fresh"]);
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
    /* NOT a new guest, and the cookie is NOT cleared: a reload must reach this same answer, and only the player's
       explicit "Continue as a new guest" (`{"fresh": true}`) replaces the identity. */
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
    { ok: true, expiresAt: outcome.expiresAt, ...(outcome.rotated ? { rotated: true } : {}) },
    outcome.setCookie === null ? {} : { "Set-Cookie": outcome.setCookie },
  );
}
