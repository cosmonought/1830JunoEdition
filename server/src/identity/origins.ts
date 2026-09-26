// server/src/identity/origins.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §4.1, §4.3 step 4, §4.8): THE ORIGIN ALLOW-LIST
// ==================================================================
//
// EXACT MATCH, NOTHING ELSE. `GS_ALLOWED_ORIGINS` is a comma-separated list of origins, each exactly as a browser
// serializes one -- scheme, lowercase host, and a port only when it is not the scheme's default. An entry that is
// not already in that form (a trailing slash, a path, uppercase, `:443` on https, a wildcard, `null`) is REFUSED at
// startup rather than normalized, so what the operator wrote is what is compared. A request's `Origin` must equal an
// entry byte for byte: a missing Origin, `null`, two Origin headers, or anything malformed is refused. There is no
// CORS: no response ever carries an Access-Control header.
//
// This is the second, independent defense against cross-site WebSocket hijacking (after SameSite=Strict), and the
// one that also covers same-site-but-cross-origin siblings.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type OriginListResult = { ok: true; origins: string[] } | { ok: false; reason: string };

/** One configured origin, or why it is not one. */
export function checkOriginEntry(entry: string): string | null {
  if (entry === "") return "an empty entry";
  if (entry === "null") return "\"null\" is not an origin";
  if (entry.includes("*")) return `"${entry}" has a wildcard; origins are matched exactly`;
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return `"${entry}" is not an origin`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `"${entry}" is not an http(s) origin`;
  if (url.origin !== entry) return `"${entry}" is not written as an origin (expected "${url.origin}")`;
  return null;
}

export function parseAllowedOrigins(value: string | undefined): OriginListResult {
  if (value === undefined || value.trim() === "") return { ok: true, origins: [] };
  const origins: string[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    const problem = checkOriginEntry(entry);
    if (problem !== null) return { ok: false, reason: `GS_ALLOWED_ORIGINS: ${problem}` };
    if (!origins.includes(entry)) origins.push(entry);
  }
  return { ok: true, origins };
}

/** A request's Origin against the list: exact, single, present. */
export function originAllowed(header: string | readonly string[] | undefined, allowed: ReadonlySet<string>): boolean {
  if (typeof header !== "string") return false; // missing, or repeated
  if (header === "null") return false;
  return allowed.has(header);
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/** An origin whose host is localhost, 127.0.0.1 or [::1], any port. */
export function isLoopbackOrigin(origin: string): boolean {
  if (checkOriginEntry(origin) !== null) return false;
  return isLoopbackHostname(new URL(origin).hostname);
}

/** A `Host` header naming a loopback host, any port -- and nothing else in it. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (typeof host !== "string" || !/^[A-Za-z0-9.[\]:-]{1,255}$/.test(host)) return false;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }
  return url.username === "" && url.password === "" && url.pathname === "/" && isLoopbackHostname(url.hostname);
}
