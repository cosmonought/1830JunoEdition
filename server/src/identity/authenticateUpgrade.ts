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
  | { ok: true; ctx: ConnectionContext; ip: IpKey }
  | { ok: false; status: 400 | 401 | 403 | 404 | 429 | 503; step: UpgradeStep; retryAfterMs?: number; why: string };

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

export function decideUpgrade(request: Pick<IncomingMessage, "headers" | "socket" | "url">, gate: UpgradeGate): UpgradeDecision {
  const now = gate.now();
  const { limits, limiter } = gate;

  /* 1. PATH */
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return { ok: false, status: 404, step: "path", why: "unreadable path" };
  }
  if (!(pathname === gate.wsPath || (gate.mode === "development" && pathname === "/"))) {
    return { ok: false, status: 404, step: "path", why: "not the game socket path" };
  }

  /* 2. GLOBAL CAPACITY */
  if (gate.counts.global() >= limits.maxSocketsGlobal) {
    limiter.deny("sockets-global");
    return { ok: false, status: 503, step: "capacity", retryAfterMs: 5_000, why: "the server is at its socket capacity" };
  }
  /* PEEKED here, SPENT after step 3: an address refused by its own limits must not drain the server's budget
     (LIVE-2B adversarial review, High). */
  const globalWait = limiter.upgradesGlobal.peek("global");
  if (globalWait > 0) {
    limiter.deny("upgrades-global");
    return { ok: false, status: 503, step: "capacity", retryAfterMs: globalWait, why: "the server is taking too many connections" };
  }

  /* 3. IP */
  const client = clientIpOf(request, gate.trustedProxyHops);
  if (!client.ok) {
    limiter.deny("client-ip");
    return { ok: false, status: 400, step: "ip", why: client.reason };
  }
  const ip = client.ip;
  const cooling = limiter.cooldowns.remaining(ip.key);
  if (cooling > 0) {
    limiter.deny("malformed-cooldown");
    return { ok: false, status: 429, step: "ip", retryAfterMs: cooling, why: "malformed-frame cooldown" };
  }
  const failedWait = limiter.failedUpgrades.peek(ip);
  if (failedWait > 0) {
    limiter.deny("upgrades-failed-ip");
    return { ok: false, status: 429, step: "ip", retryAfterMs: failedWait, why: "too many failed upgrades" };
  }
  const ipWait = limiter.upgrades.take(ip);
  if (ipWait > 0) {
    limiter.deny("upgrades-ip");
    return { ok: false, status: 429, step: "ip", retryAfterMs: ipWait, why: "too many upgrades" };
  }
  if (gate.counts.forIp(ip.key) >= limits.maxSocketsPerIp) {
    limiter.deny("sockets-ip");
    return { ok: false, status: 429, step: "ip", retryAfterMs: 5_000, why: "too many sockets from this address" };
  }
  if (ip.aggregate !== null && gate.counts.forAggregate(ip.aggregate) >= limits.maxSocketsPerIp * limits.ipv6AggregateFactor) {
    limiter.deny("sockets-ip-aggregate");
    return { ok: false, status: 429, step: "ip", retryAfterMs: 5_000, why: "too many sockets from this network" };
  }
  limiter.upgradesGlobal.take("global");

  const failed = (status: 401 | 403 | 429, step: UpgradeStep, why: string, retryAfterMs?: number): UpgradeDecision => {
    limiter.failedUpgrades.take(ip);
    return { ok: false, status, step, why, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  };

  /* 4. ORIGIN */
  if (!originAllowed(request.headers.origin, gate.allowedOrigins)) {
    limiter.deny("origin");
    return failed(403, "origin", "Origin not allowed");
  }

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

  /* 5b. LIVE-2E: A PROFILE IS REQUIRED. An unprofiled principal (the temporary one a browser gets from the bootstrap)
     opens no game socket: no public list, no room, no log, no chat, no presence -- nothing, not even whether a
     private table exists, is reachable before a profile. 403, charged to the address's failed-upgrade budget like
     any other refused upgrade (LIVE-2E review I3): the client never opens a socket before its profile exists, so
     only a misbehaving one ever gets here. */
  if (!gate.hasProfile(principalId)) {
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
  return { ok: true, ctx, ip };
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
