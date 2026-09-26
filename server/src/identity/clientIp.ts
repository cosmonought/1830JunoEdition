// server/src/identity/clientIp.ts
//
// ==================================================================
//  LIVE-2B (LIVE-2 §12.1): WHICH ADDRESS A REQUEST IS COUNTED AGAINST
// ==================================================================
//
// `GS_TRUSTED_PROXY_HOPS` says how many proxies in front of this server append to X-Forwarded-For:
//   0  the TCP peer, `socket.remoteAddress`. X-Forwarded-For is ignored entirely.
//   N  the N-th address from the RIGHT of X-Forwarded-For -- the one the outermost trusted proxy saw. Everything to
//      its left was written by the client and is never read, so a spoofed header can only choose a bucket for the
//      spoofer, never escape one. Fewer than N entries, or a malformed entry among the N, FAILS CLOSED: the request
//      is refused rather than counted against the proxy's own address.
//
// THE KEY IS A NETWORK, NOT AN ADDRESS: IPv4 /32, IPv6 /64 -- one household or one host. An IPv4-mapped IPv6
// address is its IPv4 address. An IPv6 key also names its /48, which the limiter checks at ten times the /64's
// limit, so a site holding 65,536 /64s does not hold 65,536 budgets (LIVE-2 §7.3, review finding 4).
//
// IP keys live only in the in-memory limiters. Nothing here is ever stored (LIVE-2 §4.9).

import { isIP } from "net";
import type { IncomingMessage } from "http";

export interface IpKey {
  /** The bucket key: `v4:a.b.c.d` or `v6:xxxx:xxxx:xxxx:xxxx/64`. */
  key: string;
  /** The IPv6 /48 aggregate, or null for IPv4. */
  aggregate: string | null;
}

export type ClientIpResult = { ok: true; ip: IpKey } | { ok: false; reason: string };

/** Expand an IPv6 address (any spelling, zone removed) to eight 16-bit groups. */
function ipv6Groups(address: string): number[] | null {
  let host: string;
  try {
    host = new URL(`http://[${address}]`).hostname; // canonical, compressed, embedded IPv4 rewritten in hex
  } catch {
    return null;
  }
  const inner = host.slice(1, -1);
  const [head, tail] = inner.includes("::") ? inner.split("::") : [inner, null];
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === null || tail === "" ? [] : tail.split(":");
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === null ? missing !== 0 : missing < 1) return null;
  const groups = [...headGroups, ...Array(tail === null ? 0 : missing).fill("0"), ...tailGroups].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

const hex4 = (group: number) => group.toString(16).padStart(4, "0");

/** The limiter key for one address, or null when it is not an IP address at all. */
export function ipKeyOf(raw: string): IpKey | null {
  const address = raw.trim().replace(/%.*$/, ""); // an IPv6 zone names an interface, not a host
  const family = isIP(address);
  if (family === 4) return { key: `v4:${address}`, aggregate: null };
  if (family !== 6) return null;
  const groups = ipv6Groups(address);
  if (groups === null) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { key: `v4:${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`, aggregate: null };
  }
  return { key: `v6:${groups.slice(0, 4).map(hex4).join(":")}/64`, aggregate: `v6:${groups.slice(0, 3).map(hex4).join(":")}/48` };
}

/** The address a request is counted against, per the trusted hop count. */
export function clientIpOf(request: Pick<IncomingMessage, "headers" | "socket">, trustedProxyHops: number): ClientIpResult {
  if (trustedProxyHops === 0) {
    const key = ipKeyOf(request.socket.remoteAddress ?? "");
    return key === null ? { ok: false, reason: "the connection has no peer address" } : { ok: true, ip: key };
  }
  const header = request.headers["x-forwarded-for"];
  const joined = Array.isArray(header) ? header.join(",") : header;
  if (typeof joined !== "string" || joined.trim() === "") return { ok: false, reason: "no X-Forwarded-For behind a trusted proxy" };
  const hops = joined.split(",").map((entry) => entry.trim());
  if (hops.length < trustedProxyHops) return { ok: false, reason: "fewer X-Forwarded-For entries than trusted proxies" };
  const trusted = hops.slice(hops.length - trustedProxyHops);
  if (trusted.some((entry) => ipKeyOf(entry) === null)) return { ok: false, reason: "a malformed X-Forwarded-For entry from a trusted proxy" };
  return { ok: true, ip: ipKeyOf(trusted[0]) as IpKey };
}
