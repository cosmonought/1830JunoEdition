// server/src/identity/authenticateUpgrade.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §4.3): THE UPGRADE, DECIDED BEFORE A WEBSOCKET EXISTS
// ==================================================================
//
// The successor of `ResolveIdentity`: authentication happens ONCE, here, at the HTTP upgrade -- not at `hello`. The
// steps run in the frozen order and the first failure answers, with a minimal HTTP response written to the raw
// socket, which is then destroyed. No WebSocket object is ever created for a refused upgrade.
//
//   1. path              `/gs` (development also `/`)                                   404
//   2. global capacity   2,000 sockets; 50 upgrades a second                           503 + Retry-After
//   3. IP                the trusted client address (400 when it cannot be read); the
//                        malformed-flood cooldown, the failed-upgrade budget, 60
//                        upgrades a minute, 64 concurrent sockets (640 per IPv6 /48)    429 + Retry-After
//                        -- and only then is the server's 50-a-second budget spent
//   4. Origin            exactly one allow-listed Origin                                403
//   5. authenticate      production: the session cookie; development: the dev
//                        authenticator (its environment refusals are 403)               401 / 403
//   5b. profile          LIVE-2E: the principal must have a profile                      403
//   6. socket caps       12 per session (one browser), 24 per principal (every device), or
//                        6 for a never-activated one (LIVE-2E)                          429 + Retry-After
//   7. `handleUpgrade`   by the caller, SYNCHRONOUSLY after this returns ok -- nothing here awaits, so no other
//                        upgrade can slip between the caps above and the socket's registration.
//
// Steps 4 and 5 spend the IP key's failed-upgrade budget when they refuse (step 6 does not: see there).
//
// THE CONTEXT IS FROZEN: { principalId, sessionId, sessionExpiresAt, ipKey, openedAt } for the life of the socket.
// A socket never changes identity; changing identity is a new socket.
//
// LIVE-4 (L4-3): THE CLIENT'S ANNOUNCEMENT IS READ HERE TOO -- `cp` / `cr` / `cb` on the socket URL's query, through
// the one canonical parser (`gameEngine/compat/clientCompatibility.ts`) -- and handed back beside the context, frozen
// for the socket's life like it. It decides nothing about the upgrade itself (who the socket is, and whether it may
// exist, are the steps above): the server judges it once the socket exists, so a protocol-1 client can be TOLD why it
// may not talk here (`reload`, close 4426) instead of seeing a failed open it would retry. A socket that announces
// nothing is the legacy wire (protocol 0).

import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

import type { IdentityLimits } from "../ingress/limits";
import { readSessionCookie } from "./cookies";
import { clientIpOf, type IpKey } from "./clientIp";
import type { DevAuthenticator } from "./devAuthenticator";
import type { IdentityLimiter } from "./limiter";
import type { GsMode } from "./mode";
import { originAllowed } from "./origins";
import type { IdentityService } from "./sessions";
import type { SessionVerifier } from "./verifier";
import {
  parseClientAnnouncement,
  rawClientAnnouncementOf,
  type ClientAnnouncement,
} from "../../../frontend/src/gameEngine/compat/clientCompatibility";

export interface ConnectionContext {
  readonly principalId: string;
  readonly sessionId: string;
  readonly sessionExpiresAt: number;
  readonly ipKey: string;
  readonly openedAt: number;
}

export interface SocketCounts {
  global(): number;
  forIp(key: string): number;
  /** An IPv6 /48's sockets (LIVE-2 §7.3: the aggregate at ten times the /64's cap). */
  forAggregate(aggregate: string): number;
  forPrincipal(principalId: string): number;
  /** LIVE-2E: one session's sockets (one browser: every tab of it). */
  forSession(sessionId: string): number;
}

export interface UpgradeGate {
  mode: GsMode;
  wsPath: string;
  /** LIVE-6 L6-1: further exact socket paths this server answers (its own pool's route path, `/gs/p/<pool>`, from the
   *  trusted runtime configuration). Absent: `wsPath` only, exactly as before. */
  alsoWsPaths?: readonly string[];
  allowedOrigins: ReadonlySet<string>;
  allowedOriginList: readonly string[];
  trustedProxyHops: number;
  identity: IdentityService;
  devAuthenticator: DevAuthenticator | null;
  limiter: IdentityLimiter;
  limits: IdentityLimits;
  counts: SocketCounts;
  now: () => number;
  /** LIVE-2E: whether this principal has a profile (a development principal: its synthetic development profile).
   *  An unprofiled principal opens no game socket at all. */
  hasProfile: (principalId: string) => boolean;
}

export type UpgradeStep = "path" | "capacity" | "ip" | "origin" | "authenticate" | "profile" | "principal-cap";

export type UpgradeDecision =
  /** LIVE-4 (L4-3): `client` is the socket's announcement, parsed once (the legacy wire when it announced nothing). */
  | { ok: true; ctx: ConnectionContext; ip: IpKey; client: ClientAnnouncement }
  | { ok: false; status: 400 | 401 | 403 | 404 | 429 | 503; step: UpgradeStep; retryAfterMs?: number; why: string };

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

export function decideUpgrade(request: Pick<IncomingMessage, "headers" | "socket" | "url">, gate: UpgradeGate): UpgradeDecision {
  const pre = precheck(request, gate);
  if (!pre.ok) return pre.decision;
  const { now, failed } = pre;
  const { limiter } = gate;

  /* 5. AUTHENTICATE */
  let principalId: string;
  let sessionId: string;
  let sessionExpiresAt: number;
  let provisional = false;
  if (gate.mode === "development") {
    if (gate.devAuthenticator === null) return failed(401, "authenticate", "no development authenticator");
    const dev = gate.devAuthenticator.authenticate(
      request,
      { allowedOrigins: gate.allowedOriginList, trustedProxyHops: gate.trustedProxyHops },
      now,
    );
    if (dev.kind !== "ok") {
      limiter.deny(dev.status === 403 ? "dev-environment" : "authenticate");
      return failed(dev.status, "authenticate", dev.why);
    }
    ({ principalId, sessionId, sessionExpiresAt } = dev);
  } else {
    const auth = gate.identity.authenticate(readSessionCookie(request.headers.cookie), now);
    if (auth.kind !== "ok") {
      limiter.deny("authenticate");
      return failed(401, "authenticate", auth.why);
    }
    ({ principalId, sessionId, sessionExpiresAt, provisional } = auth);
  }

  return afterAuthentication(gate, pre, { principalId, sessionId, sessionExpiresAt, provisional, profiled: gate.hasProfile(principalId) });
}

/* ==================================================================
    LIVE-6 L6-1: THE SAME UPGRADE, AUTHENTICATED BY THE IDENTITY VERIFIER (a task that is not the identity writer)
   ==================================================================
   A non-primary task holds no identity in memory: step 5 (and 5b, from the same reads) is answered by the verifier's
   strongly consistent reads of the durable records (`identity/verifier.ts`) -- which is the one await in the gate.
   Everything else is `decideUpgrade`'s own steps, in its order, spending the same budgets: steps 1-4 run first,
   synchronously, exactly as there; then the verifier; then -- because other upgrades may have been registered while the
   reads were in flight -- the socket caps are checked AGAIN (global, per address, per /48) before step 6's, so the caps
   hold exactly as they do without the await. The caller still runs `handleUpgrade` synchronously after `ok`.
   Production only: development identity is loopback-only and never runs against AWS tables. A verifier that cannot
   answer (a failed read, damaged records) is 503 -- a fault of the store, not the caller's, so it is not charged to the
   address's failed-upgrade budget. */
export interface VerifiedUpgradeGate extends Omit<UpgradeGate, "identity" | "devAuthenticator" | "hasProfile" | "mode"> {
  readonly mode: "production";
  readonly verifier: SessionVerifier;
}

export async function decideVerifiedUpgrade(request: Pick<IncomingMessage, "headers" | "socket" | "url">, gate: VerifiedUpgradeGate): Promise<UpgradeDecision> {
  if (gate.mode !== "production") return { ok: false, status: 503, step: "authenticate", why: "the identity verifier runs in production mode only" };
  const pre = precheck(request, { ...gate, mode: "production" });
  if (!pre.ok) return pre.decision;
  const { now, ip, failed } = pre;
  const { limiter, limits } = gate;

  /* 5 + 5b. AUTHENTICATE, from the durable records (the one await). */
  const auth = await gate.verifier.authenticate(readSessionCookie(request.headers.cookie), now);
  if (auth.kind === "unavailable") {
    limiter.deny("identity-unavailable");
    return { ok: false, status: 503, step: "authenticate", retryAfterMs: 5_000, why: "the identity records could not be read" };
  }
  if (auth.kind !== "ok") {
    limiter.deny("authenticate");
    return failed(401, "authenticate", auth.why);
  }

  /* The caps of steps 2-3 again: sockets registered while the reads were in flight count. */
  if (gate.counts.global() >= limits.maxSocketsGlobal) {
    limiter.deny("sockets-global");
    return { ok: false, status: 503, step: "capacity", retryAfterMs: 5_000, why: "the server is at its socket capacity" };
  }
  if (gate.counts.forIp(ip.key) >= limits.maxSocketsPerIp) {
    limiter.deny("sockets-ip");
    return { ok: false, status: 429, step: "ip", retryAfterMs: 5_000, why: "too many sockets from this address" };
  }
  if (ip.aggregate !== null && gate.counts.forAggregate(ip.aggregate) >= limits.maxSocketsPerIp * limits.ipv6AggregateFactor) {
    limiter.deny("sockets-ip-aggregate");
    return { ok: false, status: 429, step: "ip", retryAfterMs: 5_000, why: "too many sockets from this network" };
  }

  return afterAuthentication(gate, pre, { principalId: auth.principalId, sessionId: auth.sessionId, sessionExpiresAt: auth.sessionExpiresAt, provisional: auth.provisional, profiled: auth.profiled });
}

/* ---------------------------------------------------------------------------
    The shared steps (one implementation for both gates)
   --------------------------------------------------------------------------- */

type Prechecked =
  | { readonly ok: false; readonly decision: UpgradeDecision }
  | {
      readonly ok: true;
      readonly now: number;
      readonly ip: IpKey;
      readonly query: URLSearchParams;
      readonly failed: (status: 401 | 403 | 429, step: UpgradeStep, why: string, retryAfterMs?: number) => UpgradeDecision;
    };

type GateSteps = Pick<UpgradeGate, "mode" | "wsPath" | "alsoWsPaths" | "allowedOrigins" | "trustedProxyHops" | "limiter" | "limits" | "counts" | "now">;

/** Steps 1-4: path, capacity, IP, Origin -- in the frozen order, spending the same budgets. */
function precheck(request: Pick<IncomingMessage, "headers" | "socket" | "url">, gate: GateSteps): Prechecked {
  const now = gate.now();
  const { limits, limiter } = gate;
  const refused = (decision: UpgradeDecision): Prechecked => ({ ok: false, decision });

  /* 1. PATH */
  let pathname: string;
  let query: URLSearchParams;
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    return refused({ ok: false, status: 404, step: "path", why: "unreadable path" });
  }
  /* LIVE-6 L6-1: this pool's own route path (`/gs/p/<pool>`, the trusted configuration's) is a game socket path too. */
  if (!(pathname === gate.wsPath || (gate.alsoWsPaths ?? []).includes(pathname) || (gate.mode === "development" && pathname === "/"))) {
    return refused({ ok: false, status: 404, step: "path", why: "not the game socket path" });
  }

  /* 2. GLOBAL CAPACITY */
  if (gate.counts.global() >= limits.maxSocketsGlobal) {
    limiter.deny("sockets-global");
    return refused({ ok: false, status: 503, step: "capacity", retryAfterMs: 5_000, why: "the server is at its socket capacity" });
  }
  /* PEEKED here, SPENT after step 3: an address refused by its own limits must not drain the server's budget
     (LIVE-2B adversarial review, High). */
  const globalWait = limiter.upgradesGlobal.peek("global");
  if (globalWait > 0) {
    limiter.deny("upgrades-global");
    return refused({ ok: false, status: 503, step: "capacity", retryAfterMs: globalWait, why: "the server is taking too many connections" });
  }

  /* 3. IP */
  const client = clientIpOf(request, gate.trustedProxyHops);
  if (!client.ok) {
    limiter.deny("client-ip");
    return refused({ ok: false, status: 400, step: "ip", why: client.reason });
  }
  const ip = client.ip;
  const cooling = limiter.cooldowns.remaining(ip.key);
  if (cooling > 0) {
    limiter.deny("malformed-cooldown");
    return refused({ ok: false, status: 429, step: "ip", retryAfterMs: cooling, why: "malformed-frame cooldown" });
  }
  const failedWait = limiter.failedUpgrades.peek(ip);
  if (failedWait > 0) {
    limiter.deny("upgrades-failed-ip");
    return refused({ ok: false, status: 429, step: "ip", retryAfterMs: failedWait, why: "too many failed upgrades" });
  }
  const ipWait = limiter.upgrades.take(ip);
  if (ipWait > 0) {
    limiter.deny("upgrades-ip");
    return refused({ ok: false, status: 429, step: "ip", retryAfterMs: ipWait, why: "too many upgrades" });
  }
  if (gate.counts.forIp(ip.key) >= limits.maxSocketsPerIp) {
    limiter.deny("sockets-ip");
    return refused({ ok: false, status: 429, step: "ip", retryAfterMs: 5_000, why: "too many sockets from this address" });
  }
  if (ip.aggregate !== null && gate.counts.forAggregate(ip.aggregate) >= limits.maxSocketsPerIp * limits.ipv6AggregateFactor) {
    limiter.deny("sockets-ip-aggregate");
    return refused({ ok: false, status: 429, step: "ip", retryAfterMs: 5_000, why: "too many sockets from this network" });
  }
  limiter.upgradesGlobal.take("global");

  const failed = (status: 401 | 403 | 429, step: UpgradeStep, why: string, retryAfterMs?: number): UpgradeDecision => {
    limiter.failedUpgrades.take(ip);
    return { ok: false, status, step, why, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  };

  /* 4. ORIGIN */
  if (!originAllowed(request.headers.origin, gate.allowedOrigins)) {
    limiter.deny("origin");
    return refused(failed(403, "origin", "Origin not allowed"));
  }
  return { ok: true, now, ip, query, failed };
}

/** Steps 5b and 6, and the frozen context: after a successful authentication (either gate's). */
function afterAuthentication(
  gate: Pick<UpgradeGate, "limiter" | "limits" | "counts">,
  pre: Extract<Prechecked, { ok: true }>,
  auth: { readonly principalId: string; readonly sessionId: string; readonly sessionExpiresAt: number; readonly provisional: boolean; readonly profiled: boolean },
): UpgradeDecision {
  const { limits, limiter } = gate;
  const { now, ip, query, failed } = pre;
  const { principalId, sessionId, sessionExpiresAt, provisional } = auth;

  /* 5b. LIVE-2E: A PROFILE IS REQUIRED. An unprofiled principal (the temporary one a browser gets from the bootstrap)
     opens no game socket: no public list, no room, no log, no chat, no presence -- nothing, not even whether a
     private table exists, is reachable before a profile. 403, charged to the address's failed-upgrade budget like
     any other refused upgrade (LIVE-2E review I3): the client never opens a socket before its profile exists, so
     only a misbehaving one ever gets here. */
  if (!auth.profiled) {
    limiter.deny("profile-required");
    return failed(403, "profile", "no profile");
  }

  /* 6. PER-SESSION AND PER-PRINCIPAL SOCKETS -- refused without spending the ADDRESS's failed-upgrade budget: one
     player's extra tabs must not lock out everybody behind the same NAT (LIVE-2B adversarial review). LIVE-2E: a
     session (one browser) and a principal (every device of it) are capped separately, so a second device is not
     counted against the first one's tabs (see `DEFAULT_INGRESS_LIMITS.identity` for the derivation). */
  if (gate.counts.forSession(sessionId) >= limits.maxSocketsPerSession) {
    limiter.deny("sockets-session");
    return { ok: false, status: 429, step: "principal-cap", retryAfterMs: 5_000, why: "too many sockets for this browser" };
  }
  const cap = provisional ? limits.maxSocketsPerProvisionalPrincipal : limits.maxSocketsPerPrincipal;
  if (gate.counts.forPrincipal(principalId) >= cap) {
    limiter.deny(provisional ? "sockets-provisional" : "sockets-principal");
    return { ok: false, status: 429, step: "principal-cap", retryAfterMs: 5_000, why: "too many sockets for this player" };
  }

  const ctx: ConnectionContext = Object.freeze({ principalId, sessionId, sessionExpiresAt, ipKey: ip.key, openedAt: now });
  /* LIVE-4 (L4-3): the announcement, read with the canonical parser; every value of each parameter, so a repeated one
     is malformed rather than silently its first value. */
  const announcement = parseClientAnnouncement(rawClientAnnouncementOf(query));
  return { ok: true, ctx, ip, client: announcement };
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** A refused upgrade: a minimal HTTP response on the raw socket, then the socket is destroyed. The body is the
 *  status text only -- never why, never anything the request carried. */
export function refuseUpgrade(socket: Duplex, status: number, retryAfterMs?: number): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const text = STATUS_TEXT[status] ?? "Error";
  const body = `${text}\n`;
  const head = [
    `HTTP/1.1 ${status} ${text}`,
    "Connection: close",
    "Cache-Control: no-store",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...(retryAfterMs === undefined ? [] : [`Retry-After: ${seconds(retryAfterMs)}`]),
  ];
  socket.once("finish", () => socket.destroy());
  socket.end(`${head.join("\r\n")}\r\n\r\n${body}`);
}
