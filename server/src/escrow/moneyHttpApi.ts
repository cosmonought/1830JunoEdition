// server/src/escrow/moneyHttpApi.ts
//
// ==================================================================
//  ESCROW-4: THE `/gs/api/money/*` ROUTES -- THE SAME INGRESS RULES AS `/gs/api/profile/*`, THE SESSION'S OWN AUTHORITY
// ==================================================================
//
//   POST /gs/api/money/config            {}                                   whether real-money tables can be opened here,
//                                                                              the pinned deployment, fee, minimum ante
//   POST /gs/api/money/wallet-challenge  {gameId, wallet}                     SENSITIVE -> {text, nonce, expiresAt, replaces?}
//   POST /gs/api/money/wallet-link       {gameId, nonce, pubKey, signature,   SENSITIVE -> {mode, wallet, epoch, ticket}
//                                         consentKey, replace?}
//   POST /gs/api/money/join-admission    {gameId}                             the seat's Join admission (ESCROW-JOIN)
//   POST /gs/api/money/deposit-sent      {gameId, kind, txHash, chainGameId?, a HINT (202); never financial truth
//                                         timeoutHeight?}
//   POST /gs/api/money/consent-key       {gameId, pubkey}                     SENSITIVE: register a (new) signing key
//   POST /gs/api/money/consent           {gameId, signature}                  relay the seat's own CONSENT (not sensitive:
//                                                                              the signature is the authority)
//   POST /gs/api/money/annul             {gameId, signature}                  the seat's ANNUL signature (collected)
//   POST /gs/api/money/escrow-details    {gameId}                             the server's signed checkpoint / settlement
//   POST /gs/api/money/deposits          {}                                   "Your deposits"
//
// EVERY ROUTE: POST only; an allow-listed Origin; `Content-Type: application/json`; a closed body of at most the API
// limit (a field the route does not name -- a player id, a creation receipt, anything -- is 400); `no-store`; no CORS. The
// caller is the request's OWN current, profiled session: its principal decides the seat (a body never names one), and
// SENSITIVE means that session holds a live "Confirm it's you" grant (`hasSensitiveAuth`, ESCROW-3A) -- nothing else
// counts (INV-CR: the lost-create-response rescue is never an authority here; no money module mentions it). Budgeted
// per session, apart from the profile actions. Nothing here logs a body, a signature or an id.

import type { IncomingMessage, ServerResponse } from "http";

import { readSessionCookie } from "../identity/cookies";
import { clientIpOf } from "../identity/clientIp";
import { isJson, json, parseBody, readBody, retryAfter, type FieldSpec } from "../identity/httpApi";
import { originAllowed } from "../identity/origins";
import type { IdentityService } from "../identity/sessions";
import { KeyedBuckets } from "../ingress/limits";
import type { MoneyCaller, MoneyTables } from "./moneyTables";

export const MONEY_API_PREFIX = "/gs/api/money/";

/** Each route's closed body. */
export const MONEY_ROUTES: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>> = Object.freeze({
  config: {},
  "wallet-challenge": { gameId: { string: 64 }, wallet: { string: 96 } },
  "wallet-link": { gameId: { string: 64 }, nonce: { string: 64 }, pubKey: { string: 64 }, signature: { string: 128 }, consentKey: { string: 80 }, replace: "boolean" },
  "join-admission": { gameId: { string: 64 } },
  "deposit-sent": { gameId: { string: 64 }, kind: { string: 32 }, txHash: { string: 80 }, chainGameId: { string: 24 }, timeoutHeight: { string: 24 } },
  "consent-key": { gameId: { string: 64 }, pubkey: { string: 80 } },
  consent: { gameId: { string: 64 }, signature: { string: 160 } },
  annul: { gameId: { string: 64 }, signature: { string: 160 } },
  "escrow-details": { gameId: { string: 64 } },
  deposits: {},
});

export interface MoneyHttpApi {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly trustedProxyHops: number;
  readonly identity: IdentityService;
  readonly maxBodyBytes: number;
  readonly now: () => number;
  /** Null: money is not configured on this server (every route answers 404 -- the surface does not exist). */
  readonly money: () => MoneyTables | null;
  readonly onError: (what: string, error: unknown) => string;
}

/** Per session: 30 requests, refilling one every two seconds (a funding flow is a handful; the view is pushed). */
export function createMoneyLimiter(now: () => number): KeyedBuckets {
  return new KeyedBuckets({ capacity: 30, refillPerSecond: 0.5 }, now, 20_000);
}

/** Handle the request if it is a money route; `false` leaves it to the caller. */
export function handleMoneyHttp(request: IncomingMessage, response: ServerResponse, api: MoneyHttpApi, limiter: KeyedBuckets): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  if (!pathname.startsWith(MONEY_API_PREFIX)) return false;
  const route = pathname.slice(MONEY_API_PREFIX.length);
  const money = api.money();
  if (money === null || !Object.prototype.hasOwnProperty.call(MONEY_ROUTES, route)) {
    json(response, 404, { error: "not-found" });
    request.resume();
    return true;
  }
  void serve(request, response, api, limiter, money, route).catch((error) => {
    const ref = api.onError("a money request", error);
    json(response, 500, { error: "internal", ref });
  });
  return true;
}

async function serve(request: IncomingMessage, response: ServerResponse, api: MoneyHttpApi, limiter: KeyedBuckets, money: MoneyTables, route: string): Promise<void> {
  if (request.method !== "POST") {
    json(response, 405, { error: "method-not-allowed" }, { Allow: "POST" });
    request.resume();
    return;
  }
  const origin = request.headers.origin;
  if (!originAllowed(origin, api.allowedOrigins) || typeof origin !== "string") {
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
  const fields = parseBody(body.text, MONEY_ROUTES[route]);
  if (fields === null) {
    json(response, 400, { error: "bad-request" });
    return;
  }
  const now = api.now();
  const read = readSessionCookie(request.headers.cookie);
  const sessionId = api.identity.currentSession(read, now);
  if (sessionId === null) {
    json(response, 401, { error: "not-authenticated" });
    return;
  }
  const wait = limiter.take(sessionId);
  if (wait > 0) {
    json(response, 429, { error: "rate-limited", retryAfterMs: wait }, retryAfter(wait));
    return;
  }
  /* A profiled, STANDING session only: the security context is the one a wallet link is issued under. */
  const context = api.identity.securityContextOf(read, now);
  if (context === null) {
    json(response, 403, { error: "profile-required" });
    return;
  }
  if (api.identity.securityStanding(context).kind !== "standing") {
    json(response, 401, { error: "not-authenticated" });
    return;
  }
  const caller: MoneyCaller = {
    sessionId,
    familyId: context.familyId,
    recoverySelector: context.recoverySelector,
    principalId: context.principalId,
    sensitive: api.identity.hasSensitiveAuth(read, now),
    origin,
  };
  const handler = money.routes[route];
  const result = await handler(caller, fields as Record<string, unknown>);
  if (result.ok) json(response, result.status ?? 200, { ok: true, ...result.body });
  else json(response, result.status, { error: result.code, reason: result.reason }, result.status === 503 ? retryAfter(5_000) : {});
}
