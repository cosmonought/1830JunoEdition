// server/src/conduct/conductHttpApi.ts
//
// ==================================================================
//  PHASE 3 (P3-N032): THE CONDUCT REVIEW ROUTES -- REVIEWERS ONLY, THE SAME INGRESS RULES AS EVERY `/gs/api/*` ROUTE
// ==================================================================
//
//   POST /gs/api/conduct/me              {}                                  (profiled) `{reviewer}` -- whether THIS
//                                                                             account may open the review panel. Nothing
//                                                                             else: never a count of cases or reports.
//   POST /gs/api/conduct/review/queue    {}                                  (reviewer) every case, newest first
//   POST /gs/api/conduct/review/case     {caseId}                            (reviewer) one case, its evidence and its
//                                                                             log pointer re-verified now
//   POST /gs/api/conduct/review/decide   {caseId, revision, status, note?}   (reviewer + a live "Confirm it's you")
//                                                                             one transition, CAS on the revision
//
// A REVIEWER is a signed-in account whose USERNAME is on the server's configured list (`GS_CONDUCT_REVIEWERS`, compared
// by the same canonical login key the sign-in uses) AND held that username when the server started: the names are bound
// to those accounts' principals once, at startup, so a configured name nobody had registered yet can never be claimed
// by whoever registers it first. There is no other way to become one: no route grants it, no client claim is read, and
// an account without a username (a legacy profile) never is. Every review route answers a signed-in non-reviewer
// 404 `not-found` (after the transport's usual method / origin / body checks, which every `/gs/api/*` route makes
// first). A DECISION also needs the session's live sensitive grant ("Confirm it's you", the same grant a wallet change
// asks for): 403 `reauth-required` otherwise. A reviewer never sees -- in the queue, a case or a decision -- a case
// they are a party to (the reporter, the reported account, or anyone seated at its table): those are answered as cases
// that do not exist.
//
// Reporting itself is not here: a seated player reports through the table's own socket (`room-op report-player`), in
// the pool that serves the game, where the seat and the committed log are authoritative.
//
// POST only; an allow-listed Origin; JSON; a closed body; `no-store`; no CORS; budgeted per session. No answer carries a
// principal, profile, session or family id, a username, an address, a wallet or any credential: parties are public seat
// ids, nicknames and account FINGERPRINTS (`accountFingerprint`).

import type { IncomingMessage, ServerResponse } from "http";

import { readSessionCookie } from "../identity/cookies";
import { clientIpOf } from "../identity/clientIp";
import { isJson, json, readBody, retryAfter } from "../identity/httpApi";
import { cleanLoginName, loginKeyOf } from "../identity/accountCredentials";
import { originAllowed } from "../identity/origins";
import type { IdentityService } from "../identity/sessions";
import { KeyedBuckets } from "../ingress/limits";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { MAX_REVIEW_NOTE_LENGTH } from "../../../frontend/src/utils/conductReport";
import { ConductCaseUnreadableError } from "./conductCase";
import type { ConductService } from "./conductService";

export const CONDUCT_API_PREFIX = "/gs/api/conduct/";
export const CONDUCT_REVIEWERS_ENV = "GS_CONDUCT_REVIEWERS";

type Field = { readonly kind: "string"; readonly max: number; readonly optional?: true } | { readonly kind: "int"; readonly optional?: true } | { readonly kind: "string-or-null"; readonly max: number; readonly optional?: true };

const CONDUCT_ROUTES: Readonly<Record<string, Readonly<Record<string, Field>>>> = Object.freeze({
  me: {},
  "review/queue": {},
  "review/case": { caseId: { kind: "string", max: 64 } },
  "review/decide": {
    caseId: { kind: "string", max: 64 },
    revision: { kind: "int" },
    status: { kind: "string", max: 32 },
    note: { kind: "string-or-null", max: MAX_REVIEW_NOTE_LENGTH * 2, optional: true },
  },
});

/** The closed body: only the route's keys, each of its kind, every required one present. */
function parseClosed(text: string, schema: Readonly<Record<string, Field>>): Record<string, string | number | null> | null {
  let value: unknown;
  if (text.trim() === "") value = {};
  else {
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string | number | null> = {};
  for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(schema, key)) return null;
  for (const [key, spec] of Object.entries(schema)) {
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined) {
      if (spec.optional) continue;
      return null;
    }
    if (spec.kind === "int") {
      if (!(typeof field === "number" && Number.isSafeInteger(field))) return null;
    } else if (spec.kind === "string-or-null") {
      if (!(field === null || (typeof field === "string" && field.length <= spec.max))) return null;
    } else if (!(typeof field === "string" && field.length <= spec.max)) {
      return null;
    }
    out[key] = field as string | number | null;
  }
  return out;
}

/** The reviewers' canonical login keys, from the configured list (comma or whitespace separated usernames). */
export function conductReviewersFromEnv(env: Readonly<Record<string, string | undefined>>): { ok: true; reviewers: ReadonlySet<string> } | { ok: false; reason: string } {
  const raw = env[CONDUCT_REVIEWERS_ENV];
  if (raw === undefined || raw.trim() === "") return { ok: true, reviewers: new Set() };
  const keys = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    if (part === "") continue;
    const name = cleanLoginName(part);
    if (name === null) return { ok: false, reason: `${CONDUCT_REVIEWERS_ENV} names something that is not a username (${JSON.stringify(part.slice(0, 40))})` };
    keys.add(loginKeyOf(name));
  }
  if (keys.size > 32) return { ok: false, reason: `${CONDUCT_REVIEWERS_ENV} names more than 32 reviewers` };
  return { ok: true, reviewers: keys };
}

export const describeConductReviewers = (reviewers: ReadonlySet<string>): string =>
  reviewers.size === 0
    ? `conduct reports: received and kept for review; NO reviewer is configured (${CONDUCT_REVIEWERS_ENV}) -- nobody can open the review panel`
    : `conduct reports: received and kept for review; ${reviewers.size} reviewer username(s) configured (${CONDUCT_REVIEWERS_ENV}), bound at startup to the accounts holding them`;

export interface ConductHttpApi {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly trustedProxyHops: number;
  readonly identity: IdentityService;
  readonly maxBodyBytes: number;
  readonly now: () => number;
  readonly service: ConductService;
  /** The PRINCIPALS of the accounts that may review: the configured usernames, bound at startup to the accounts that
   *  held them then (`gameServer.ts`; never re-resolved per request, so a name registered later is never a reviewer). */
  readonly reviewers: ReadonlySet<string>;
  /** The committed log of a game, for re-verifying a case's pointer (`null`: not readable here now). */
  readonly readLog: (gameId: string) => Promise<readonly ServerLogEntry[] | null>;
  readonly onError: (what: string, error: unknown) => string;
}

/** Per session: 60 requests, refilling one a second (a reviewer pages through a queue). */
export function createConductLimiter(now: () => number): KeyedBuckets {
  return new KeyedBuckets({ capacity: 60, refillPerSecond: 1 }, now, 20_000);
}

export function handleConductHttp(request: IncomingMessage, response: ServerResponse, api: ConductHttpApi, limiter: KeyedBuckets): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  if (!pathname.startsWith(CONDUCT_API_PREFIX)) return false;
  const route = pathname.slice(CONDUCT_API_PREFIX.length);
  if (!Object.prototype.hasOwnProperty.call(CONDUCT_ROUTES, route)) {
    json(response, 404, { error: "not-found" });
    request.resume();
    return true;
  }
  void serve(request, response, api, limiter, route).catch((error) => {
    const ref = api.onError("a conduct request", error);
    json(response, 500, { error: "internal", ref });
  });
  return true;
}

async function serve(request: IncomingMessage, response: ServerResponse, api: ConductHttpApi, limiter: KeyedBuckets, route: string): Promise<void> {
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
  const fields = parseClosed(body.text, CONDUCT_ROUTES[route]);
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
  /* The reviewer test: this session's own principal, one of the accounts bound at startup. Asked per request. */
  const reviewer = api.reviewers.has(auth.principalId);
  if (route === "me") {
    json(response, 200, { ok: true, reviewer: reviewer && api.service.enabled });
    return;
  }
  if (!reviewer) {
    json(response, 404, { error: "not-found" });
    return;
  }
  if (!api.service.enabled) {
    json(response, 503, { error: "unavailable" });
    return;
  }
  if (route === "review/queue") {
    const queue = await api.service.queue(auth.principalId);
    json(response, 200, { ok: true, cases: queue.cases, unreadable: queue.unreadable });
    return;
  }
  if (route === "review/case") {
    try {
      const view = await api.service.caseView(String(fields.caseId), auth.principalId, api.readLog);
      if (view === null) {
        json(response, 404, { error: "no-such-case" });
        return;
      }
      json(response, 200, { ok: true, case: view });
    } catch (error) {
      if (error instanceof ConductCaseUnreadableError) {
        json(response, 409, { error: "case-unreadable" });
        return;
      }
      throw error;
    }
    return;
  }
  /* review/decide: a live "Confirm it's you" first (the same sensitive grant a wallet change needs). */
  if (!api.identity.hasSensitiveAuth(read, now)) {
    json(response, 403, { error: "reauth-required" });
    return;
  }
  const decided = await api.service.decide(
    { caseId: fields.caseId, revision: fields.revision, status: fields.status, note: fields.note ?? null, reviewerPrincipalId: auth.principalId },
    api.readLog,
  );
  if (decided.ok) {
    json(response, 200, { ok: true, case: decided.view });
    return;
  }
  const status = decided.code === "not-found" ? 404 : decided.code === "unavailable" || decided.code === "uncertain" ? 503 : decided.code === "bad-note" || decided.code === "bad-status" ? 400 : 409;
  json(response, status, { error: decided.code, reason: decided.reason });
}
