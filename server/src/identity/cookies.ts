// server/src/identity/cookies.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §4.2): THE SESSION COOKIE, READ STRICTLY
// ==================================================================
//
//   __Host-gs_session=v1.<session_id>.<secret>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000
//
// `__Host-` makes the browser enforce Secure, Path=/ and no Domain, so a sibling subdomain cannot plant or overwrite
// it (no tossing, no fixation). HttpOnly keeps it from script. SameSite=Strict keeps it off every cross-site request
// and handshake. Max-Age is the 180-day absolute lifetime; the server's `expires_at` is what decides.
//
// THE READER FAILS CLOSED. One well-formed `__Host-gs_session` or none: two of them, a quoted or percent-encoded
// value, a name that differs only by case or encoding, a version other than v1, a selector or a secret that is not
// the canonical spelling, or a Cookie header past 8 KiB are all `malformed` -- never "the first one", never "the
// one that parses", never an anonymous fallback. What `malformed` becomes is the caller's decision (the upgrade
// answers 401; the bootstrap answers 401 `session-ended` and offers the explicit new-guest path).
//
// NOTHING HERE LOGS, and nothing that calls it may log the header, the value, the secret or its hash.

import { SESSION_ID_PATTERN, secretBytes } from "./ids";

export const SESSION_COOKIE_NAME = "__Host-gs_session";
/** 180 days, in seconds: the absolute session lifetime (LIVE-2 §4.2, §4.5). */
export const SESSION_COOKIE_MAX_AGE_S = 180 * 24 * 60 * 60;
/** A Cookie header longer than this is refused unread (browsers cap a whole header near 8 KiB anyway). */
export const MAX_COOKIE_HEADER_BYTES = 8 * 1024;

export type CookieProblem = "oversized" | "duplicate" | "ambiguous-name" | "encoding" | "version" | "selector" | "secret";

export type SessionCookieRead =
  | { readonly kind: "none" }
  | { readonly kind: "malformed"; readonly problem: CookieProblem }
  | { readonly kind: "session"; readonly sessionId: string; readonly secret: string };

const NONE: SessionCookieRead = Object.freeze({ kind: "none" as const });
const malformed = (problem: CookieProblem): SessionCookieRead => ({ kind: "malformed", problem });

const lowerName = SESSION_COOKIE_NAME.toLowerCase();

/** A cookie name as it might have been MEANT, for spotting look-alikes: percent-decoded when that decodes, lowered. */
function normalisedName(raw: string): string {
  let name = raw.trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    /* not percent-encoding; compared as written */
  }
  return name.toLowerCase();
}

/** Read the session cookie out of a request's `Cookie` header (Node joins repeated headers with "; "). */
export function readSessionCookie(header: string | readonly string[] | undefined): SessionCookieRead {
  if (header === undefined) return NONE;
  const text = typeof header === "string" ? header : header.join("; ");
  if (Buffer.byteLength(text, "utf8") > MAX_COOKIE_HEADER_BYTES) return malformed("oversized");
  const values: string[] = [];
  for (const pair of text.split(";")) {
    const at = pair.indexOf("=");
    const rawName = (at === -1 ? pair : pair.slice(0, at)).trim();
    if (rawName === "") continue;
    if (rawName === SESSION_COOKIE_NAME) {
      values.push(at === -1 ? "" : pair.slice(at + 1).trim());
      continue;
    }
    /* A near-miss of OUR name -- `__host-gs_session`, `__Host-gs%5Fsession` -- is not a different cookie that happens
       to look similar; it is an ambiguity, and ambiguity is refused. */
    if (normalisedName(rawName) === lowerName) return malformed("ambiguous-name");
  }
  if (values.length === 0) return NONE;
  if (values.length > 1) return malformed("duplicate");
  const value = values[0];
  /* Quotes, percent-escapes, spaces, commas: a browser never sends ours that way, so no spelling of it is decoded. */
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return malformed("encoding");
  const parts = value.split(".");
  if (parts[0] !== "v1") return malformed("version");
  if (parts.length !== 3) return malformed(parts.length < 3 ? "selector" : "secret");
  const [, sessionId, secret] = parts;
  if (!SESSION_ID_PATTERN.test(sessionId)) return malformed("selector");
  if (secretBytes(secret) === null) return malformed("secret");
  return { kind: "session", sessionId, secret };
}

const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

/** The `Set-Cookie` that delivers a session. No `Domain`, ever. */
export const sessionSetCookie = (sessionId: string, secret: string): string =>
  `${SESSION_COOKIE_NAME}=v1.${sessionId}.${secret}; ${ATTRIBUTES}; Max-Age=${SESSION_COOKIE_MAX_AGE_S}`;

/** The `Set-Cookie` that clears it (revoke / "Forget this device"). */
export const clearedSessionCookie = (): string => `${SESSION_COOKIE_NAME}=; ${ATTRIBUTES}; Max-Age=0`;
