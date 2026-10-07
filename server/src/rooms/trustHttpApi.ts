// server/src/rooms/trustHttpApi.ts
//
// ==================================================================
//  PHASE 3 (P3-ACCT): THE TRUST-FACTS ROUTES -- THE SAME INGRESS RULES AS EVERY `/gs/api/*` ROUTE
// ==================================================================
//
//   POST /gs/api/trust/table  {gameId}   (profiled) the facts (`trustFacts.ts`) of every seat of a REAL-MONEY table the
//                                         caller may READ -- a public one, or a private one it is seated at or admitted
//                                         to; anything else (a free table, a table it may not read, no such table) is
//                                         404 `not-found`, one answer. Keyed by the seats' PUBLIC ids (`player_id`).
//                                         Review L4: signed-in callers only (a visitor must sign in to sit anyway), and
//                                         money tables only -- the facts exist to decide whether to stake real money
//                                         beside someone, not to follow a player from table to table.
//   POST /gs/api/trust/me     {}         (profiled) the account's own facts.
//
// POST only; an allow-listed Origin; JSON; a closed body; `no-store`; no CORS; a current, signed-in session; budgeted
// per session. Nothing here logs a body or an id, and no answer carries a principal, profile, session or family id, a
// username, an address or a wallet.

import type { IncomingMessage, ServerResponse } from "http";

import { readSessionCookie } from "../identity/cookies";
import { clientIpOf } from "../identity/clientIp";
import { isJson, json, parseBody, readBody, retryAfter, type FieldSpec } from "../identity/httpApi";
import { originAllowed } from "../identity/origins";
import type { IdentityService } from "../identity/sessions";
import { KeyedBuckets } from "../ingress/limits";
import type { TrustFactsService } from "./trustFacts";

export const TRUST_API_PREFIX = "/gs/api/trust/";

const TRUST_ROUTES: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>> = Object.freeze({
  table: { gameId: { string: 64 } },
  me: {},
});

export interface TrustHttpApi {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly trustedProxyHops: number;
  readonly identity: IdentityService;
  readonly maxBodyBytes: number;
  readonly now: () => number;
  readonly facts: TrustFactsService;
  /** The seats of a real-money table this principal may read (`roomHost.readableSeats`, money only), or null. */
  readonly readableSeats: (gameId: string, principalId: string | null) => ReadonlyArray<{ readonly playerId: string; readonly principalId: string }> | null;
  readonly onError: (what: string, error: unknown) => string;
}

/** Per session: 30 requests, refilling one every two seconds (a lobby asks once per real-money table it shows). */
export function createTrustLimiter(now: () => number): KeyedBuckets {
  return new KeyedBuckets({ capacity: 30, refillPerSecond: 0.5 }, now, 20_000);
}

export function handleTrustHttp(request: IncomingMessage, response: ServerResponse, api: TrustHttpApi, limiter: KeyedBuckets): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  if (!pathname.startsWith(TRUST_API_PREFIX)) return false;
  const route = pathname.slice(TRUST_API_PREFIX.length);
  if (!Object.prototype.hasOwnProperty.call(TRUST_ROUTES, route)) {
    json(response, 404, { error: "not-found" });
    request.resume();
    return true;
  }
  void serve(request, response, api, limiter, route).catch((error) => {
    const ref = api.onError("a trust-facts request", error);
    json(response, 500, { error: "internal", ref });
  });
  return true;
}

async function serve(request: IncomingMessage, response: ServerResponse, api: TrustHttpApi, limiter: KeyedBuckets, route: string): Promise<void> {
  if (request.method !== "POST") {
    json(response, 405, { error: "method-not-allowed" }, { Allow: "POST" });
    request.resume();
    return;
  }
  if (!originAllowed(request.headers.origin, api.allowedOrigins)) {
    json(response, 403, { error: "origin-forbidden" });
    request.resume();
    return;
  }
  if (!isJson(request.headers["content-type"])) {
    json(response, 415, { error: "unsupported-media-type" });
    request.resume();
    return;
  }
  if (!clientIpOf(request, api.trustedProxyHops).ok) {
    json(response, 400, { error: "bad-request" });
    request.resume();
    return;
  }
  const body = await readBody(request, api.maxBodyBytes);
  if (!body.ok) {
    json(response, body.status, { error: body.status === 413 ? "too-large" : "bad-request" });
    return;
  }
  const fields = parseBody(body.text, TRUST_ROUTES[route]);
  if (fields === null) {
    json(response, 400, { error: "bad-request" });
    return;
  }
  const now = api.now();
  const read = readSessionCookie(request.headers.cookie);
  const auth = api.identity.authenticate(read, now);
  if (auth.kind !== "ok") {
    json(response, 401, { error: "not-authenticated" });
    return;
  }
  const wait = limiter.take(auth.sessionId);
  if (wait > 0) {
    json(response, 429, { error: "rate-limited", retryAfterMs: wait }, retryAfter(wait));
    return;
  }
  if (!api.identity.isProfiled(auth.principalId)) {
    json(response, 403, { error: "profile-required" });
    return;
  }
  if (route === "me") {
    json(response, 200, { ok: true, facts: await api.facts.factsOf(auth.principalId) });
    return;
  }
  const gameId = typeof fields.gameId === "string" ? fields.gameId : "";
  const seats = gameId === "" ? null : api.readableSeats(gameId, auth.principalId);
  if (seats === null) {
    json(response, 404, { error: "not-found" });
    return;
  }
  const out: Array<{ playerId: string; facts: unknown }> = [];
  for (const seat of seats) out.push({ playerId: seat.playerId, facts: await api.facts.factsOf(seat.principalId) });
  json(response, 200, { ok: true, seats: out });
}
