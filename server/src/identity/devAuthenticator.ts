// server/src/identity/devAuthenticator.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §4.8): THE DEVELOPMENT AUTHENTICATOR, AND WHY IT CANNOT REACH PRODUCTION
// ==================================================================
//
// The successor of `trustClaimedIdentity`: local multi-tab play, where each tab says who it is. It maps
// `?dev_claim=<[A-Za-z0-9_-]{1,32}>` on the WebSocket URL to the deterministic principal `pr_dev_<claim>` with a
// synthetic session, and everything downstream runs the SAME principal-bound path a cookie session does.
//
// IT EXISTS ONLY THROUGH `createDevAuthenticator()`, which throws unless `GS_MODE` is "development" AT CALL TIME,
// and the game server refuses to be given one in production mode. It accepts an upgrade only when EVERY one of
// these holds -- each refusal is 403, before any claim is read:
//   - the Origin's host is localhost, 127.0.0.1 or [::1] (any port) -- and the generic step 4 already required it
//     to be on the allow-list;
//   - the Host header is loopback too;
//   - the TCP peer is loopback;
//   - no Forwarded, X-Forwarded-For, X-Forwarded-Host or X-Real-IP header is present, even empty;
//   - the server trusts no proxy hops and every allowed origin is loopback (startup refuses otherwise; checked again
//     here so a misassembled server cannot relax it).
// Then the claim: exactly one `dev_claim`, well formed, or 401.
//
// THESE HEADER CHECKS ARE DEFENCE IN DEPTH, NOT A GUARANTEE: headers are the client's, and a local proxy makes every
// peer loopback. The rule is absolute and the banner says it: NEVER POINT A TUNNEL AT A DEVELOPMENT-MODE SERVER.

import type { IncomingMessage } from "http";

import { isLoopbackHostHeader, isLoopbackOrigin } from "./origins";

export const DEV_CLAIM_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const DEV_PRINCIPAL_PREFIX = "pr_dev_";
export const DEV_SESSION_PREFIX = "se_dev_";
const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"] as const;
const DEV_SESSION_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

export type DevAuthResult =
  | { kind: "ok"; principalId: string; sessionId: string; sessionExpiresAt: number }
  | { kind: "refused"; status: 401 | 403; why: string };

export interface DevAuthenticator {
  readonly kind: "development";
  authenticate(
    request: Pick<IncomingMessage, "headers" | "socket" | "url">,
    config: { allowedOrigins: readonly string[]; trustedProxyHops: number },
    now: number,
  ): DevAuthResult;
}

/** 127.0.0.0/8, ::1, and their IPv4-mapped forms. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== "string") return false;
  const bare = address.replace(/^::ffff:/i, "");
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;
  return address === "::1" || address === "0:0:0:0:0:0:0:1";
}

const refused = (status: 401 | 403, why: string): DevAuthResult => ({ kind: "refused", status, why });

function authenticate(
  request: Pick<IncomingMessage, "headers" | "socket" | "url">,
  config: { allowedOrigins: readonly string[]; trustedProxyHops: number },
  now: number,
): DevAuthResult {
  if (config.trustedProxyHops !== 0) return refused(403, "development identity is refused behind a trusted proxy");
  if (config.allowedOrigins.length === 0 || !config.allowedOrigins.every(isLoopbackOrigin)) {
    return refused(403, "development identity needs every allowed origin to be loopback");
  }
  for (const name of FORWARDING_HEADERS) {
    if (request.headers[name] !== undefined) return refused(403, `development identity refuses a forwarded request (${name})`);
  }
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !isLoopbackOrigin(origin)) return refused(403, "development identity needs a loopback Origin");
  if (!isLoopbackHostHeader(request.headers.host)) return refused(403, "development identity needs a loopback Host");
  if (!isLoopbackAddress(request.socket.remoteAddress)) return refused(403, "development identity needs a loopback peer");
  let claims: string[];
  try {
    claims = new URL(request.url ?? "/", "http://localhost").searchParams.getAll("dev_claim");
  } catch {
    return refused(401, "unreadable request URL");
  }
  if (claims.length !== 1 || !DEV_CLAIM_PATTERN.test(claims[0])) return refused(401, "no valid dev_claim");
  const claim = claims[0];
  return {
    kind: "ok",
    principalId: `${DEV_PRINCIPAL_PREFIX}${claim}`,
    sessionId: `${DEV_SESSION_PREFIX}${claim}`,
    sessionExpiresAt: now + DEV_SESSION_LIFETIME_MS,
  };
}

/** The only way to obtain the development authenticator. Refuses unless `GS_MODE` is "development" right now. */
export function createDevAuthenticator(): DevAuthenticator {
  if (process.env.GS_MODE !== "development") {
    throw new Error('createDevAuthenticator: refused -- GS_MODE is not "development" (LIVE-2 §4.8)');
  }
  return Object.freeze({ kind: "development" as const, authenticate });
}

/** The legacy room protocol's actor for a development principal: its claim. `null` for every other principal --
 *  a cookie principal has no seat identity until LIVE-2C binds one from the GameRecord. */
export function devClaimOf(principalId: string): string | null {
  if (!principalId.startsWith(DEV_PRINCIPAL_PREFIX)) return null;
  const claim = principalId.slice(DEV_PRINCIPAL_PREFIX.length);
  return DEV_CLAIM_PATTERN.test(claim) ? claim : null;
}
