// server/src/ludum/ingress.ts
//
// ==================================================================
//  LUDUM v1 (Lane A): THE INGRESS FOR `/gs/api/ludum/v1/*` -- CREDENTIALED CORS FOR THIS PREFIX ONLY, READ-ONLY, NO COOKIE
// ==================================================================
//
// docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §2.1 (normative), §5, §10.3. `ludum.netadao.org` and `play.netadao.org` are
// same-site, so the browser sends the existing host-only `__Host-gs_session` cookie on Ludum's `credentials: "include"`
// fetch; they are cross-origin, so both sides of CORS must be exact. In order:
//
//   1. Not under the prefix: `false` (every other route keeps its own behaviour: no CORS header anywhere else).
//   2. A method other than OPTIONS or POST: 405 (the CORS headers only for an allow-listed origin).
//   3. The Origin: EXACTLY ONE `Origin` header (counted in the raw headers, so a repeat is never joined or picked from),
//      byte for byte in GS_LUDUM_ORIGINS ∪ GS_ALLOWED_ORIGINS, never `null`. Anything else: 403 with NO `Access-Control-*`
//      header and no body. Nothing below runs for it.
//   4. OPTIONS (the preflight): answered STATICALLY -- 204 and exactly the §2.1 headers for a known route. It reads no
//      cookie, no body and no `Access-Control-Request-*` / `Sec-Fetch-*` header (the edge does not forward them), and never
//      touches the session store.
//   5. POST: `Content-Type: application/json` (else 400 BEFORE the session is read: a form or text/plain "simple" request
//      does no work); the client address; the per-address budget; a body of at most 1 KiB that is a closed JSON object
//      of the route's schema (unknown keys, wrong types, oversize: 400).
//   6. The caller: the request's own session through the EXISTING verifier (`IdentityService.authenticate`, which writes
//      `last_seen` behind at most every 15 minutes and nothing else) -- then only a CURRENT, activated, profiled, standing
//      session is a principal. A rotated predecessor (bootstrap-only), a revoked, idle- or absolute-expired, provisional
//      or unprofiled session, a malformed or duplicated cookie, or none: `principalId: null` (signed out). It NEVER
//      rotates, NEVER mints, and NO response here carries `Set-Cookie`. A signed-in caller is charged to its session's
//      request budget (the same budget `/gs/api/account/me` reads under).
//   7. Dispatch through `registry.ts`: `session` here (`session.ts`); a "profiled" route answers a signed-out caller 401
//      `signed-out`; a "reviewer" route (v1.1) answers anyone who is not a bound conduct reviewer 404 `not-found`; a
//      handler's own answer otherwise. A handler that throws: 503 `unavailable` (with a reference).
//
// v1.1 (additive, docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §5.1): two routes WRITE -- `display-name` (the account's one
// change) and `moderation-decide` (a reviewer's decision, behind a live "Confirm it's you"). Both are reached only with
// the exact allow-listed Origin, `application/json` (so the browser preflights) and the caller's own session; neither
// sets a cookie. `moderation-decide` alone takes a larger body (a reviewer's note).
//
// EVERY response to an allow-listed origin -- 2xx, 4xx and 5xx alike -- carries the exact `Access-Control-Allow-Origin`,
// `Access-Control-Allow-Credentials: true`, `Vary: Origin` and `Cache-Control: no-store`, so Ludum can read the error
// JSON. Never `*`, never an unlisted origin reflected, never `Access-Control-Expose-Headers`.
//
// Errors use §5's vocabulary only: `{error: "bad-request" | "signed-out" | "not-found" | "rate-limited" | "unavailable",
// detail?}`. Nothing here logs a header, a cookie, a body or an id.

import type { IncomingMessage, ServerResponse } from "http";

import { readSessionCookie } from "../identity/cookies";
import { clientIpOf } from "../identity/clientIp";
import { isJson, readBody } from "../identity/httpApi";
import type { IdentityLimiter } from "../identity/limiter";
import type { IdentityService } from "../identity/sessions";
import { IpBuckets } from "../ingress/limits";
import { LUDUM_PREFIX, ludumRouteOf, type LudumRouteName } from "./registry";
import type { LudumCaller, LudumPorts } from "./ports";
import { sessionAnswer } from "./session";

/** §5: a body of at most 1 KiB. */
export const LUDUM_MAX_BODY_BYTES = 1024;
/** §2.1: how long a browser may cache an allowed preflight. */
export const LUDUM_PREFLIGHT_MAX_AGE_S = 600;

/** A closed body field: a string of at most this many characters, or a whole number. */
export type LudumFieldSpec = { readonly string: number } | "integer";

/** Each route's closed body (§5). The ingress checks keys and types; each handler checks the values' meaning. */
export const LUDUM_BODY_SCHEMAS: Readonly<Record<LudumRouteName, Readonly<Record<string, LudumFieldSpec>>>> = Object.freeze({
  session: {},
  games: { cursor: { string: 512 }, limit: "integer" },
  game: { gameId: { string: 64 } },
  case: { chainGameId: { string: 24 } },
  account: {},
  "display-name": { name: { string: 96 } },
  "moderation-queue": {},
  "moderation-case": { caseId: { string: 64 } },
  "moderation-decide": { caseId: { string: 64 }, revision: "integer", status: { string: 32 }, note: { string: 2000 } },
});

/** v1.1: a route whose body may exceed `LUDUM_MAX_BODY_BYTES` (a reviewer's note: 1000 characters, sanitized server-side). */
export const LUDUM_ROUTE_MAX_BODY_BYTES: Readonly<Partial<Record<LudumRouteName, number>>> = Object.freeze({ "moderation-decide": 8192 });

export interface LudumIngress {
  /** GS_LUDUM_ORIGINS ∪ GS_ALLOWED_ORIGINS: the exact origins this prefix answers with CORS. */
  readonly corsOrigins: ReadonlySet<string>;
  /** Play's own origin (the first GS_ALLOWED_ORIGINS entry): where sign-in and account management live. */
  readonly playOrigin: string;
  readonly trustedProxyHops: number;
  readonly identity: IdentityService;
  /** The identity limiters (`limiter.ts`): a signed-in caller's session budget, and the refusal counters. */
  readonly limiter: IdentityLimiter;
  /** Per client address, every request (signed out ones included). `createLudumIpBudget`. */
  readonly ipBudget: IpBuckets;
  readonly ports: LudumPorts;
  readonly now: () => number;
  readonly onError: (what: string, error: unknown) => string;
}

/** Per client address: a burst of 60, then one a second (a page makes a handful of calls). */
export function createLudumIpBudget(now: () => number, limiter: { readonly ipv6AggregateFactor: number; readonly maxTrackedKeys: number }): IpBuckets {
  return new IpBuckets({ capacity: 60, refillPerSecond: 1 }, now, limiter.ipv6AggregateFactor, limiter.maxTrackedKeys);
}

/** The one allow-listed Origin of a request, or null: exactly one `Origin` header, byte for byte on the list. */
export function ludumOriginOf(request: Pick<IncomingMessage, "rawHeaders">, allowed: ReadonlySet<string>): string | null {
  let value: string | null = null;
  let count = 0;
  const raw = request.rawHeaders;
  for (let at = 0; at + 1 < raw.length; at += 2) {
    if (raw[at].toLowerCase() !== "origin") continue;
    count += 1;
    value = raw[at + 1];
  }
  if (count !== 1 || value === null || value === "null") return null;
  return allowed.has(value) ? value : null;
}

/** The headers on every response to an allow-listed origin. */
export const corsHeaders = (origin: string): Record<string, string> => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Credentials": "true",
  Vary: "Origin",
  "Cache-Control": "no-store",
});

const NO_STORE = { "Cache-Control": "no-store", Vary: "Origin", "X-Content-Type-Options": "nosniff" } as const;

function send(response: ServerResponse, status: number, body: object | null, origin: string | null, extra: Record<string, string> = {}): void {
  if (response.headersSent) return;
  const headers: Record<string, string> = { ...NO_STORE, ...(origin !== null ? corsHeaders(origin) : {}), ...extra };
  if (body === null) {
    response.writeHead(status, headers);
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(text)) });
  response.end(text);
}

const fail = (error: "bad-request" | "signed-out" | "not-found" | "rate-limited" | "unavailable", detail?: string) => (detail === undefined ? { error } : { error, detail });

/** The closed body: a JSON object with only the schema's keys, each of its type. `""` is `{}`. */
export function parseLudumBody(text: string, schema: Readonly<Record<string, LudumFieldSpec>>): Record<string, string | number> | null {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string | number> = {};
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) return null;
    const spec = schema[key];
    const field = (value as Record<string, unknown>)[key];
    if (spec === "integer") {
      if (typeof field !== "number" || !Number.isSafeInteger(field)) return null;
    } else if (typeof field !== "string" || field.length > spec.string) {
      return null;
    }
    out[key] = field;
  }
  return out;
}

/** The signed-in principal of a request's own session, or null (signed out) -- see the header, step 6. Never writes
 *  anything but the existing `last_seen` write-behind; never rotates; never mints. */
export function ludumCallerOf(identity: IdentityService, cookieHeader: string | readonly string[] | undefined, now: number): { caller: LudumCaller; sessionId: string | null } {
  const signedOut = { caller: { principalId: null }, sessionId: null };
  const read = readSessionCookie(cookieHeader);
  if (read.kind !== "session") return signedOut;
  const auth = identity.authenticate(read, now);
  if (auth.kind !== "ok" || auth.provisional) return signedOut;
  if (!identity.isProfiled(auth.principalId)) return signedOut;
  const context = identity.securityContextOf(read, now);
  if (context === null || context.principalId !== auth.principalId) return signedOut;
  if (identity.securityStanding(context).kind !== "standing") return signedOut;
  return { caller: { principalId: auth.principalId }, sessionId: auth.sessionId };
}

/** Handle the request if it is under `/gs/api/ludum/v1/`; `false` leaves it to the caller. */
export function handleLudumHttp(request: IncomingMessage, response: ServerResponse, api: LudumIngress): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  if (!pathname.startsWith(LUDUM_PREFIX)) return false;
  const origin = ludumOriginOf(request, api.corsOrigins);
  const method = request.method ?? "";
  if (method !== "OPTIONS" && method !== "POST") {
    request.resume();
    send(response, 405, fail("bad-request", "method"), origin, { Allow: "POST, OPTIONS" });
    return true;
  }
  if (origin === null) {
    api.limiter.deny("ludum-origin");
    request.resume();
    send(response, 403, null, null);
    return true;
  }
  const route = ludumRouteOf(pathname);
  if (method === "OPTIONS") {
    request.resume();
    if (route === null) {
      send(response, 404, fail("not-found"), origin);
      return true;
    }
    /* Static: exactly the §2.1 headers. No cookie, no body, no Access-Control-Request-* read. */
    response.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": String(LUDUM_PREFLIGHT_MAX_AGE_S),
      Vary: "Origin",
      "Cache-Control": "no-store",
    });
    response.end();
    return true;
  }
  if (route === null) {
    request.resume();
    send(response, 404, fail("not-found"), origin);
    return true;
  }
  void serve(request, response, api, origin, route.name).catch((error) => {
    const ref = api.onError("a ludum request", error);
    send(response, 503, fail("unavailable", `ref ${ref}`), origin);
  });
  return true;
}

async function serve(request: IncomingMessage, response: ServerResponse, api: LudumIngress, origin: string, name: LudumRouteName): Promise<void> {
  /* Before any work, and before the session is read: a form or text/plain "simple" request is refused here. */
  if (!isJson(request.headers["content-type"])) {
    request.resume();
    send(response, 400, fail("bad-request", "content-type"), origin);
    return;
  }
  const client = clientIpOf(request, api.trustedProxyHops);
  if (!client.ok) {
    api.limiter.deny("client-ip");
    request.resume();
    send(response, 400, fail("bad-request"), origin);
    return;
  }
  const ipWait = api.ipBudget.take(client.ip);
  if (ipWait > 0) {
    api.limiter.deny("ludum-ip");
    request.resume();
    send(response, 429, fail("rate-limited"), origin, { "Retry-After": String(Math.max(1, Math.ceil(ipWait / 1000))) });
    return;
  }
  const body = await readBody(request, LUDUM_ROUTE_MAX_BODY_BYTES[name] ?? LUDUM_MAX_BODY_BYTES);
  if (!body.ok) {
    send(response, 400, fail("bad-request", body.status === 413 ? "too-large" : undefined), origin);
    return;
  }
  const fields = parseLudumBody(body.text, LUDUM_BODY_SCHEMAS[name]);
  if (fields === null) {
    send(response, 400, fail("bad-request"), origin);
    return;
  }
  const now = api.now();
  const { caller, sessionId } = ludumCallerOf(api.identity, request.headers.cookie, now);
  if (sessionId !== null) {
    const wait = api.limiter.bootstraps.take(sessionId);
    if (wait > 0) {
      api.limiter.deny("ludum-session");
      send(response, 429, fail("rate-limited"), origin, { "Retry-After": String(Math.max(1, Math.ceil(wait / 1000))) });
      return;
    }
  }
  const route = ludumRouteOf(`${LUDUM_PREFIX}${name}`);
  if (route === null) {
    send(response, 404, fail("not-found"), origin);
    return;
  }
  if (route.handler === null) {
    /* `session` (the only ingress-answered route). */
    const reviewer = caller.principalId !== null && api.ports.members !== undefined && api.ports.members.isReviewer(caller.principalId);
    const answer = sessionAnswer(api.identity, readSessionCookie(request.headers.cookie), caller, now, api.playOrigin, reviewer);
    send(response, 200, answer, origin);
    return;
  }
  if (route.access === "profiled" && caller.principalId === null) {
    send(response, 401, fail("signed-out"), origin);
    return;
  }
  if (route.access === "reviewer" && (caller.principalId === null || api.ports.members === undefined || !api.ports.members.isReviewer(caller.principalId))) {
    send(response, 404, fail("not-found"), origin);
    return;
  }
  /* v1.1: whether this session holds a live sensitive grant (read, never written; only `moderation-decide` asks). */
  if (caller.principalId !== null && route.access === "reviewer") caller.sensitiveAuth = api.identity.hasSensitiveAuth(readSessionCookie(request.headers.cookie), now);
  let result: { status: number; json: unknown };
  try {
    result = await route.handler(fields, caller, api.ports);
  } catch (error) {
    const ref = api.onError(`ludum ${name}`, error);
    send(response, 503, fail("unavailable", `ref ${ref}`), origin);
    return;
  }
  const json = result.json;
  send(response, result.status, typeof json === "object" && json !== null ? json : fail("unavailable"), origin);
}
