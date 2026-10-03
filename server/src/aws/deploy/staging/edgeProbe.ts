// server/src/aws/deploy/staging/edgeProbe.ts
//
// ==================================================================
//  LIVE-6 L6-6 §5-§7: THE DEPLOYED EDGE, FROM OUTSIDE -- QUERY STRINGS, PROXY HOPS, THE WEBSOCKET'S ANNOUNCEMENT AND IDLE
// ==================================================================
//
// Run from an operator's machine against the PUBLIC name of the distribution (client -> CloudFront -> ALB -> the task);
// the certification checks the host is the distribution's own name or alias, so the ALB cannot be probed "instead".
//
// §6 QUERY STRINGS (`/gs/diag/edge`, the staging-only hashed mirror: `ingress/edgeDiagnostic.ts`). Two GETs, each with a
//    NON-DEFAULT announcement (`cp=7`, `cr=11,3` out of order, `cb=l6cert-<run>`) and unrelated material (a nonce, a
//    marketing-style name, a percent-encoded value, a repeated name). The application must report every parameter,
//    name and value, unchanged (SHA-256 each), and read the announcement exactly as the canonical parser reads what was
//    sent. An edge that forwards only cp/cr/cb (an allow-list) FAILS here by name, as the verifier fails it statically.
// §5 PROXY HOPS. The second GET carries a spoofed two-entry X-Forwarded-For. With GS_TRUSTED_PROXY_HOPS=2 the edge must
//    have appended EXACTLY two entries (CloudFront the viewer, the ALB CloudFront's), the application's key must be none of
//    the spoofed ones, and -- with `--expected-client-ip` (the operator's own public address) -- must be the viewer's.
// §7 WEBSOCKET (the real `/gs` socket, a staging account's session cookie from GS_CERT_SESSION_COOKIE -- never a flag,
//    never written, scrubbed from every message):
//      ANNOUNCEMENT  `cp=9` (a protocol no pool accepts): the server must answer `reload` / client-protocol and close 4426
//                    -- which it can do only if `cp` reached it through the socket's own path;
//      IDLE          the canonical announcement and, on open, the browser lobby's standing subscription
//                    (`LOBBY_SUBSCRIPTION`, `{"kind":"rooms-watch","on":true}` -- what `frontend/src/utils/roomLink.ts`
//                    stands on every lobby socket; the server reaps a socket subscribed to nothing after 60 s,
//                    `limits.rooms.unsubscribedReapMs`), then NO FURTHER application activity: the probe only answers
//                    the server's pings (as every browser does), for longer than every idle bound on the path plus two
//                    ping periods. Server frames that arrive (the room list it answers with) are recorded, never
//                    answered. The pinned
//                    behaviour (`ingress/limits.ts`): the server pings every 25 s and drops a socket silent for 60 s; the
//                    ALB's idle timeout (300 s) and CloudFront's origin read timeout (60 s) come from the captured
//                    evidence. No keepalive is added: if the socket dies, the record says when, whether a close frame
//                    arrived (the server's) or not (an edge's -- attributed by timing, and said to be inferred).

import * as http from "http";
import * as https from "https";
import { WebSocket } from "ws";

import { ipKeyOf } from "../../../identity/clientIp";
import { DEFAULT_INGRESS_LIMITS } from "../../../ingress/limits";
import { EDGE_DIAGNOSTIC_FORMAT, EDGE_DIAGNOSTIC_PATH } from "../../../ingress/edgeDiagnostic";
import { parseClientAnnouncement, rawClientAnnouncementOf, clientAnnouncementQuery } from "../../../../../frontend/src/gameEngine/compat/clientCompatibility";
import { SUPPORTED_RULES_ENGINE_VERSIONS } from "../../../../../frontend/src/gameEngine/rulesVersion";
import { CLIENT_ANSWER_CLOSE_CODE } from "../../../../../frontend/src/utils/clientAnswers";
import type { Check } from "../deployVerify";
import { arr, judge, num, obj, scrub, sha256Hex, stableStringify, str } from "./evidence";

/** The server's keepalive, pinned from `ingress/limits.ts` (never chosen here). */
export const PING_INTERVAL_MS = DEFAULT_INGRESS_LIMITS.pingIntervalMs;
export const PONG_TIMEOUT_MS = DEFAULT_INGRESS_LIMITS.pongTimeoutMs;
export const TRUSTED_PROXY_HOPS = 2;
/** Spoofed X-Forwarded-For entries (TEST-NET-2: never a real viewer). */
export const SPOOFED_FORWARDED = Object.freeze(["198.51.100.23", "198.51.100.24"]);
export const SESSION_COOKIE_ENV = "GS_CERT_SESSION_COOKIE";
/** §7 IDLE: the lobby's standing subscription, exactly as the browser sends it (`roomLink.ts`: `stand(channel,
 *  "rooms-watch", {kind: "rooms-watch", on: true})`). Without it the server closes the socket 1000 "no subscription"
 *  at `unsubscribedReapMs` (60 s), and the idle path through the edge is never observed. */
export const LOBBY_SUBSCRIPTION = JSON.stringify({ kind: "rooms-watch", on: true });

/** How long an idle socket must survive: longer than every idle bound on the path, plus two server ping periods. */
export function requiredIdleMs(albIdleSeconds: number, originReadTimeoutSeconds: number): number {
  return Math.max(albIdleSeconds * 1_000, originReadTimeoutSeconds * 1_000, PONG_TIMEOUT_MS) + 2 * PING_INTERVAL_MS;
}

/** The query material each diagnostic GET sends (the announcement non-default; the rest unrelated to it). */
export function probeQuery(run: string): Array<readonly [string, string]> {
  return [
    ["cp", "7"],
    ["cr", "11,3"],
    ["cb", `l6cert-${run}`],
    ["l6x", sha256Hex(`l6-6/${run}`).slice(0, 16)],
    ["utm_source", "l6-6-staging-cert"],
    ["l6enc", "a/b c+d&e=f"],
    ["l6rep", "1"],
    ["l6rep", "2"],
  ];
}

export const encodeQuery = (parameters: ReadonlyArray<readonly [string, string]>): string => parameters.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join("&");

/* ------------------------------------------------------------------ */
/* Transport                                                            */
/* ------------------------------------------------------------------ */

export interface SocketEvent {
  readonly at_ms: number;
  /** `sent`: the one frame the probe sent on open (`frame_kind` its kind); `message`: a frame the server sent. */
  readonly kind: "ping" | "message" | "sent" | "close" | "error";
  readonly code?: number;
  /** A close frame arrived (the peer's close); false: the connection ended without one (1006). */
  readonly clean?: boolean;
  readonly frame_kind?: string;
  readonly frame_code?: string;
  readonly error?: string;
}

export interface SocketObservation {
  /** The HTTP status of a refused upgrade (null when it opened or never answered). */
  readonly upgrade_status: number | null;
  readonly opened: boolean;
  readonly events: readonly SocketEvent[];
  /** Who ended it: the probe (its hold elapsed), the remote side (a close), or an error. */
  readonly ended_by: "probe" | "remote" | "error";
  /** From the open (or the attempt) to the end. */
  readonly duration_ms: number;
}

export interface EdgeTransport {
  get(url: string, headers: Readonly<Record<string, string>>): Promise<{ readonly status: number; readonly body: string }>;
  /** `sendOnOpen`: one frame sent as soon as the socket opens (recorded as a `sent` event); nothing else is ever sent. */
  observeSocket(url: string, headers: Readonly<Record<string, string>>, holdMs: number, sendOnOpen?: string): Promise<SocketObservation>;
}

/** A frame's `kind` (bounded), or a marker when it has none or is not JSON. */
const frameKindOf = (text: string): string => {
  try {
    const frame = JSON.parse(text) as { kind?: unknown };
    return typeof frame.kind === "string" ? frame.kind.slice(0, 32) : "(no kind)";
  } catch {
    return "(not JSON)";
  }
};

/** The real transport: Node's https (http only for a loopback test server) and the `ws` client. */
export function nodeEdgeTransport(clock: () => number = () => Date.now()): EdgeTransport {
  return {
    get(url, headers) {
      return new Promise((resolve, reject) => {
        const target = new URL(url);
        const lib = target.protocol === "https:" ? https : http;
        const req = lib.get(target, { headers: { ...headers }, timeout: 15_000 }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= 65_536) chunks.push(chunk);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
      });
    },
    observeSocket(url, headers, holdMs, sendOnOpen) {
      return new Promise((resolve) => {
        const events: SocketEvent[] = [];
        const started = clock();
        let openedAt: number | null = null;
        let status: number | null = null;
        let done = false;
        let timer: NodeJS.Timeout | null = null;
        const at = () => clock() - (openedAt ?? started);
        const ws = new WebSocket(url, { headers: { ...headers }, handshakeTimeout: 15_000, perMessageDeflate: false });
        const finish = (endedBy: SocketObservation["ended_by"]) => {
          if (done) return;
          done = true;
          if (timer !== null) clearTimeout(timer);
          resolve({ upgrade_status: status, opened: openedAt !== null, events, ended_by: endedBy, duration_ms: Math.round(at()) });
        };
        ws.on("unexpected-response", (_req, res) => {
          status = res.statusCode ?? null;
          res.resume();
          ws.terminate();
          finish("remote");
        });
        ws.on("open", () => {
          openedAt = clock();
          if (sendOnOpen !== undefined) {
            ws.send(sendOnOpen);
            events.push({ at_ms: Math.round(at()), kind: "sent", frame_kind: frameKindOf(sendOnOpen) });
          }
          timer = setTimeout(() => {
            ws.close(1000, "l6-6 probe done");
            finish("probe");
          }, holdMs);
        });
        ws.on("ping", () => events.push({ at_ms: Math.round(at()), kind: "ping" }));
        ws.on("message", (data) => {
          let kind = "(not JSON)";
          let code: string | undefined;
          try {
            const frame = JSON.parse(String(data)) as { kind?: unknown; code?: unknown };
            kind = typeof frame.kind === "string" ? frame.kind.slice(0, 32) : "(no kind)";
            code = typeof frame.code === "string" ? frame.code.slice(0, 48) : undefined;
          } catch {
            /* recorded as not JSON */
          }
          events.push({ at_ms: Math.round(at()), kind: "message", frame_kind: kind, ...(code === undefined ? {} : { frame_code: code }) });
        });
        ws.on("close", (code) => {
          events.push({ at_ms: Math.round(at()), kind: "close", code, clean: code !== 1006 });
          finish(done ? "probe" : "remote");
        });
        ws.on("error", (error) => {
          events.push({ at_ms: Math.round(at()), kind: "error", error: (error as { code?: string }).code ?? error.name });
          if (openedAt === null) finish("error");
        });
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* The probe                                                            */
/* ------------------------------------------------------------------ */

export interface EdgeProbeOptions {
  readonly run: string;
  /** https://<the distribution's name or alias> (no path). */
  readonly baseUrl: string;
  /** An allow-listed Origin (GS_ALLOWED_ORIGINS). */
  readonly origin: string;
  /** The staging account's session cookie VALUE (`__Host-gs_session=` is added here); null: the socket paths are not run. */
  readonly sessionCookie: string | null;
  readonly expectedClientIp: string | null;
  readonly albIdleSeconds: number;
  readonly originReadTimeoutSeconds: number;
  /** How long the idle socket is held (at least `requiredIdleMs`; never shorter). */
  readonly holdMs: number;
  /** PHASE 1 REMAINDER (Step 16): the single host's path (client -> CloudFront -> Caddy -> server). Absent: the ECS path
   *  (CloudFront -> ALB), recorded exactly as before. Present: the host proxy's idle bound replaces the ALB's, and the
   *  record names the proxy instead of carrying an `alb_idle_seconds` it never measured. */
  readonly proxy?: { readonly name: "caddy"; readonly idleSeconds: number };
}

const wsUrlOf = (baseUrl: string, query: string): string => {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/gs";
  u.search = query;
  return u.toString();
};

export async function runEdgeProbe(transport: EdgeTransport, options: EdgeProbeOptions): Promise<Record<string, unknown>> {
  const secrets = options.sessionCookie === null ? [] : [options.sessionCookie];
  const clean = (text: string) => scrub(text, secrets);
  const query = probeQuery(options.run);
  const requests: Array<Record<string, unknown>> = [];
  for (const spoofed of [[], [...SPOOFED_FORWARDED]] as string[][]) {
    const url = `${options.baseUrl.replace(/\/+$/, "")}${EDGE_DIAGNOSTIC_PATH}?${encodeQuery(query)}`;
    const headers: Record<string, string> = { Origin: options.origin, "Cache-Control": "no-cache", ...(spoofed.length > 0 ? { "X-Forwarded-For": spoofed.join(", ") } : {}) };
    try {
      const answer = await transport.get(url, headers);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(answer.body);
      } catch {
        parsed = null;
      }
      requests.push({ spoofed, status: answer.status, answer: parsed });
    } catch (error) {
      requests.push({ spoofed, status: null, answer: null, error: clean((error as Error).message ?? String(error)).slice(0, 200) });
    }
  }
  const expectedKey = options.expectedClientIp === null ? null : ipKeyOf(options.expectedClientIp);
  const result: Record<string, unknown> = {
    target: { host: new URL(options.baseUrl).host, scheme: new URL(options.baseUrl).protocol.replace(":", "") },
    query: { sent: query, requests, expected_client_key_sha256: expectedKey === null ? null : sha256Hex(expectedKey.key), spoofed_keys_sha256: SPOOFED_FORWARDED.map((ip) => sha256Hex(ipKeyOf(ip)?.key ?? ip)) },
  };
  if (options.sessionCookie === null) {
    result.ws_announcement = { status: "not-run", reason: `${SESSION_COOKIE_ENV} is not set (a staging account's session is needed for /gs)` };
    result.ws_idle = { status: "not-run", reason: `${SESSION_COOKIE_ENV} is not set` };
    return result;
  }
  const socketHeaders = { Origin: options.origin, Cookie: `__Host-gs_session=${options.sessionCookie}` };
  const announcement = `cp=9&cr=${SUPPORTED_RULES_ENGINE_VERSIONS.join(",")}&cb=l6cert-${options.run}`;
  const refused = await transport.observeSocket(wsUrlOf(options.baseUrl, announcement), socketHeaders, 20_000);
  result.ws_announcement = { sent: announcement, observation: scrubObservation(refused, clean) };
  const canonical = clientAnnouncementQuery(1, SUPPORTED_RULES_ENGINE_VERSIONS, `l6cert-${options.run}`);
  const proxyIdleSeconds = options.proxy === undefined ? options.albIdleSeconds : options.proxy.idleSeconds;
  const required = requiredIdleMs(proxyIdleSeconds, options.originReadTimeoutSeconds);
  const hold = Math.max(options.holdMs, required + 10_000);
  const idle = await transport.observeSocket(wsUrlOf(options.baseUrl, canonical), socketHeaders, hold, LOBBY_SUBSCRIPTION);
  result.ws_idle = {
    sent: canonical,
    subscription: LOBBY_SUBSCRIPTION,
    ...(options.proxy === undefined ? { alb_idle_seconds: options.albIdleSeconds } : { proxy: options.proxy.name, proxy_idle_seconds: options.proxy.idleSeconds }),
    origin_read_timeout_seconds: options.originReadTimeoutSeconds,
    ping_interval_ms: PING_INTERVAL_MS,
    pong_timeout_ms: PONG_TIMEOUT_MS,
    required_ms: required,
    hold_ms: hold,
    observation: scrubObservation(idle, clean),
  };
  return result;
}

const scrubObservation = (o: SocketObservation, clean: (t: string) => string): SocketObservation => ({ ...o, events: o.events.map((e) => (e.error === undefined ? e : { ...e, error: clean(e.error) })) });

/* ------------------------------------------------------------------ */
/* Judgement (pure)                                                     */
/* ------------------------------------------------------------------ */

const pairKey = (pair: unknown): string => arr(pair).map(String).join(":");
const multiset = (pairs: readonly unknown[]): string[] => pairs.map(pairKey).sort();

/** §6 and §5 from the recorded GETs. `hopsFromTaskDefinition`: the running task definition's GS_TRUSTED_PROXY_HOPS (the
 *  ECS path). PHASE 1 REMAINDER: `hopsSource: "single-host"` replaces that ECS-only configuration read with the serving
 *  host process's OWN configured value as it answered through the real edge (both requests must report it); every other
 *  check is identical for both paths. */
export function judgeQueryProbe(section: unknown, expect: { readonly run: string; readonly hopsFromTaskDefinition: string | null; readonly hopsSource?: "task-definition" | "single-host" }): Check[] {
  const s = obj(section);
  const q = obj(s.query);
  const sent = arr(q.sent).map((p) => [String(arr(p)[0]), String(arr(p)[1])] as const);
  const requests = arr(q.requests).map(obj);
  const checks: Check[] = [];
  checks.push(judge("edge query: the probe's own material", JSON.stringify(sent) === JSON.stringify(probeQuery(expect.run)), "non-default cp/cr/cb and unrelated parameters", "the recorded query is not this run's probe query"));
  if (expect.hopsSource === "single-host") {
    const reported = requests.map((r) => obj(r.answer).trusted_proxy_hops);
    checks.push(
      judge(
        "edge: GS_TRUSTED_PROXY_HOPS of the serving single host",
        requests.length === 2 && reported.every((h) => h === TRUSTED_PROXY_HOPS),
        `${TRUSTED_PROXY_HOPS} (CloudFront + Caddy), as the host's process answered through the edge`,
        `the host's process answered GS_TRUSTED_PROXY_HOPS [${reported.map(String).join(", ")}] over ${requests.length} request(s), not ${TRUSTED_PROXY_HOPS}`,
      ),
    );
  } else checks.push(judge("edge: GS_TRUSTED_PROXY_HOPS in the running task definition", expect.hopsFromTaskDefinition === String(TRUSTED_PROXY_HOPS), String(TRUSTED_PROXY_HOPS), `GS_TRUSTED_PROXY_HOPS=${String(expect.hopsFromTaskDefinition)}`));
  if (requests.length !== 2) return [...checks, judge("edge query: both requests", false, "", `${requests.length} request(s) recorded`)];
  const expectedPairs = multiset(sent.map(([n, v]) => [sha256Hex(n), sha256Hex(v)]));
  /* Compared key-order-free: a record written by `writeRecord` has its keys sorted. */
  const expectedAnnouncement = stableStringify(parseClientAnnouncement(rawClientAnnouncementOf(new URLSearchParams(encodeQuery(sent)))), 0).trim();
  const cpcrcb = new Set(["cp", "cr", "cb"].map((n) => sha256Hex(n)));
  const spoofedHashes = arr(q.spoofed_keys_sha256).map(String);
  for (const [i, r] of requests.entries()) {
    const label = i === 0 ? "edge (no forwarded header)" : "edge (spoofed X-Forwarded-For)";
    const a = obj(r.answer);
    if (r.status !== 200 || a.format !== EDGE_DIAGNOSTIC_FORMAT) {
      checks.push(judge(`${label}: the diagnostic answered`, false, "", `status ${String(r.status)}, format ${String(a.format ?? "(none)")}${r.error !== undefined ? `, ${String(r.error)}` : ""} (is GS_EDGE_DIAGNOSTIC=staging set on the task, and /gs* routed to it?)`));
      continue;
    }
    const got = arr(a.parameters);
    const gotSet = multiset(got);
    const gotNames = new Set(got.map((p) => String(arr(p)[0])));
    const onlyAnnouncement = [...gotNames].every((n) => cpcrcb.has(n)) && [...cpcrcb].every((n) => gotNames.has(n));
    checks.push(
      judge(
        `${label}: ALL query strings forwarded unchanged (not an allow-list)`,
        JSON.stringify(gotSet) === JSON.stringify(expectedPairs) && a.parameters_truncated === false,
        `${got.length} parameters, every name and value unchanged (cp, cr, cb and the unrelated ones)`,
        onlyAnnouncement ? "only cp, cr and cb arrived: the edge forwards an allow-list, not ALL query strings" : `the application saw ${got.length} parameter(s) that are not the ${sent.length} sent (a parameter was dropped, added, renamed or re-encoded)`,
      ),
    );
    checks.push(
      judge(
        `${label}: cp, cr, cb read as sent`,
        stableStringify(a.announcement, 0).trim() === expectedAnnouncement,
        `the canonical parser's reading: ${expectedAnnouncement}`,
        `the application read ${stableStringify(a.announcement, 0).trim()}, not ${expectedAnnouncement}`,
      ),
    );
    checks.push(judge(`${label}: trusted hops`, a.trusted_proxy_hops === TRUSTED_PROXY_HOPS, String(TRUSTED_PROXY_HOPS), `the application is configured for ${String(a.trusted_proxy_hops)}`));
    const spoofed = arr(r.spoofed).length;
    const appended = (num(a.forwarded_entries) ?? -1) - spoofed;
    checks.push(
      judge(
        `${label}: exactly ${TRUSTED_PROXY_HOPS} proxies appended to X-Forwarded-For`,
        appended === TRUSTED_PROXY_HOPS,
        `${String(a.forwarded_entries)} entries = ${spoofed} sent + ${TRUSTED_PROXY_HOPS} (CloudFront, ${expect.hopsSource === "single-host" ? "Caddy" : "the ALB"})`,
        `${String(a.forwarded_entries)} entries for ${spoofed} sent: ${appended} appended, not ${TRUSTED_PROXY_HOPS} (GS_TRUSTED_PROXY_HOPS=${TRUSTED_PROXY_HOPS} would count the wrong address)`,
      ),
    );
    const key = str(a.client_key_sha256);
    const expected = str(q.expected_client_key_sha256);
    checks.push(
      judge(
        `${label}: the counted address is the viewer's`,
        key !== null && !spoofedHashes.includes(key) && (expected === null || key === expected),
        expected === null ? "a key that is none of the spoofed entries (no --expected-client-ip: the hop count above is the proof)" : "the operator's own address, and none of the spoofed entries",
        key === null ? `no key (${String(a.client_key_problem)})` : spoofedHashes.includes(key) ? "the application counted a SPOOFED entry" : "the application counted an address that is not the operator's",
      ),
    );
  }
  return checks;
}

/** The recorded target must be the distribution (its domain or an alias), never the ALB's name. */
export function judgeEdgeTarget(section: unknown, distribution: { readonly domainName: string | null; readonly aliases: readonly string[] }): Check[] {
  const t = obj(obj(section).target);
  const host = String(t.host ?? "");
  const names = [distribution.domainName, ...distribution.aliases].filter((n): n is string => n !== null);
  return [judge("edge: probed through the distribution", t.scheme === "https" && names.includes(host), `https://${host}`, `probed ${String(t.scheme)}://${host}; the distribution answers ${names.join(", ") || "(unknown)"}`)];
}

/** §7 the socket's own path: cp=9 answered `reload` / client-protocol, closed 4426. */
export function judgeWsAnnouncement(section: unknown): Check[] {
  const s = obj(obj(section).ws_announcement);
  if (s.status === "not-run") return [judge("WebSocket announcement", false, "", `not run (${String(s.reason)}): required`)];
  const o = obj(s.observation);
  const events = arr(o.events).map(obj);
  const reload = events.find((e) => e.kind === "message" && e.frame_kind === "reload");
  const close = events.find((e) => e.kind === "close");
  return [
    judge(
      "WebSocket: cp reaches the server through /gs",
      o.opened === true && reload?.frame_code === "client-protocol" && close?.code === CLIENT_ANSWER_CLOSE_CODE,
      `cp=9 answered reload/client-protocol, closed ${CLIENT_ANSWER_CLOSE_CODE}`,
      o.opened !== true
        ? `the upgrade did not open (HTTP ${String(o.upgrade_status)}: is the session cookie a live staging session with a profile, and the Origin allowed?)`
        : `frames [${events.map((e) => `${String(e.kind)}${e.frame_kind !== undefined ? `:${String(e.frame_kind)}/${String(e.frame_code)}` : ""}${e.code !== undefined ? `:${String(e.code)}` : ""}`).join(", ")}] (a stripped cp reads as the legacy wire and is never told reload)`,
    ),
  ];
}

/** Who most plausibly closed an idle socket that died early (said to be inferred when it is). `proxy`: the path's proxy
 *  (the ALB on the ECS path; Caddy on the single host's -- PHASE 1 REMAINDER). */
export function closedBy(o: Record<string, unknown>, bounds: { readonly albIdleMs: number; readonly originReadMs: number }, proxy: "the ALB" | "Caddy" = "the ALB"): string {
  const events = arr(o.events).map(obj);
  const close = events.find((e) => e.kind === "close");
  if (close === undefined) return o.ended_by === "error" ? "a connection error before the socket opened" : "unknown (no close observed)";
  if (close.clean === true) return `the server (close frame ${String(close.code)})`;
  const at = num(close.at_ms) ?? 0;
  const pings = events.filter((e) => e.kind === "ping").length;
  if (pings === 0) return "an edge, with no server ping ever delivered (control frames are not crossing the edge) -- inferred";
  const near = (bound: number) => Math.abs(at - bound) <= 15_000;
  if (near(bounds.albIdleMs)) return `${proxy} (no close frame at ${at} ms, its idle timeout is ${bounds.albIdleMs} ms) -- inferred from timing`;
  if (near(bounds.originReadMs)) return `CloudFront (no close frame at ${at} ms, its origin read timeout is ${bounds.originReadMs} ms) -- inferred from timing`;
  if (near(PONG_TIMEOUT_MS)) return `the server's half-open cut (no close frame at ${at} ms, pong timeout ${PONG_TIMEOUT_MS} ms: were our pongs dropped?) -- inferred from timing`;
  return `unknown: the connection ended without a close frame at ${at} ms (no bound on the path matches) -- an edge or the network`;
}

/** §7 the idle socket: it stood the browser's lobby subscription, survived the required interval (recomputed from the
 *  evidence) with nothing further sent, and the server's pings crossed. The ECS path (CloudFront -> ALB); unchanged except
 *  that a single-host path's record (it names its proxy) is never this path's. */
export function judgeWsIdle(section: unknown, evidence: { readonly albIdleSeconds: number | null; readonly originReadTimeoutSeconds: number | null }): Check[] {
  const s = obj(obj(section).ws_idle);
  if (s.status === "not-run") return [judge("WebSocket idle", false, "", `not run (${String(s.reason)}): required`)];
  if (evidence.albIdleSeconds === null || evidence.originReadTimeoutSeconds === null) return [judge("WebSocket idle: the bounds", false, "", "the ALB idle timeout or CloudFront's origin read timeout is not in the evidence")];
  return judgeWsIdleOnPath(section, { proxy: "ALB", proxyIdleSeconds: evidence.albIdleSeconds, originReadTimeoutSeconds: evidence.originReadTimeoutSeconds });
}

/** PHASE 1 REMAINDER (Step 16): the idle judgement for a named path. `ALB`: the ECS path, its check names exactly
 *  `judgeWsIdle`'s. `Caddy`: the single host's (client -> CloudFront -> Caddy -> server); the record must name the proxy
 *  and its idle bound, and carry no ALB bound (it never measured one). The interval is recomputed here from the bounds
 *  the CALLER read from evidence, never taken from the record. */
export function judgeWsIdleOnPath(section: unknown, bounds: { readonly proxy: "ALB" | "Caddy"; readonly proxyIdleSeconds: number; readonly originReadTimeoutSeconds: number }): Check[] {
  const s = obj(obj(section).ws_idle);
  if (s.status === "not-run") return [judge("WebSocket idle", false, "", `not run (${String(s.reason)}): required`)];
  const required = requiredIdleMs(bounds.proxyIdleSeconds, bounds.originReadTimeoutSeconds);
  const caddy = bounds.proxy === "Caddy";
  const pathRecorded = caddy ? s.proxy === "caddy" && s.proxy_idle_seconds === bounds.proxyIdleSeconds && s.alb_idle_seconds === undefined && s.origin_read_timeout_seconds === bounds.originReadTimeoutSeconds : s.proxy === undefined;
  const o = obj(s.observation);
  const events = arr(o.events).map(obj);
  const frames = events.filter((e) => e.kind === "message").map((e) => `${String(e.frame_kind)}/${String(e.frame_code ?? "-")}`);
  const closeEarly = events.find((e) => e.kind === "close" && (num(e.at_ms) ?? 0) < required);
  const survived = o.opened === true && o.ended_by === "probe" && (num(o.duration_ms) ?? 0) >= required && closeEarly === undefined;
  const pings = events.filter((e) => e.kind === "ping").map((e) => num(e.at_ms) ?? 0);
  const marks = [0, ...pings, num(o.duration_ms) ?? 0];
  const gaps = marks.slice(1).map((m, i) => m - marks[i]);
  const widest = gaps.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...gaps);
  const sent = events.filter((e) => e.kind === "sent");
  const subscribed = s.subscription === LOBBY_SUBSCRIPTION && sent.length === 1 && sent[0].frame_kind === "rooms-watch";
  const checks: Check[] = [
    judge(
      "WebSocket idle: the browser's lobby subscription stood on open",
      subscribed,
      `${LOBBY_SUBSCRIPTION}, as the browser's lobby sends it, and nothing else`,
      `the probe recorded subscription ${String(s.subscription)} and sent [${sent.map((e) => String(e.frame_kind)).join(", ")}] (a socket subscribed to nothing is reaped by the server at 60 s, so the idle path is never observed)`,
    ),
    judge(
      "WebSocket idle: the interval is the evidence's",
      s.required_ms === required && (num(s.hold_ms) ?? 0) >= required && pathRecorded,
      `${required} ms (max(${bounds.proxy} ${bounds.proxyIdleSeconds} s, CloudFront ${bounds.originReadTimeoutSeconds} s, pong ${PONG_TIMEOUT_MS / 1000} s) + 2 x ${PING_INTERVAL_MS / 1000} s)`,
      pathRecorded
        ? `the probe held for ${String(s.hold_ms)} ms against ${String(s.required_ms)} ms; the evidence requires ${required} ms`
        : caddy
          ? `the record is not the single host's path (proxy ${String(s.proxy)}, proxy idle ${String(s.proxy_idle_seconds)} s, ALB idle ${String(s.alb_idle_seconds)} s, CloudFront ${String(s.origin_read_timeout_seconds)} s; expected caddy ${bounds.proxyIdleSeconds} s, no ALB, CloudFront ${bounds.originReadTimeoutSeconds} s)`
          : `the record is the single host's path (proxy ${String(s.proxy)}), not the ALB's`,
    ),
    judge(
      `WebSocket idle: survived client -> CloudFront -> ${bounds.proxy} -> server`,
      survived,
      `open ${String(o.duration_ms)} ms with nothing sent after the lobby subscription, closed by the probe`,
      o.opened !== true ? `the upgrade did not open (HTTP ${String(o.upgrade_status)})` : `ended after ${String(o.duration_ms)} ms: closed by ${closedBy(o, { albIdleMs: bounds.proxyIdleSeconds * 1000, originReadMs: bounds.originReadTimeoutSeconds * 1000 }, caddy ? "Caddy" : "the ALB")}`,
    ),
    judge(
      "WebSocket idle: the server's pings crossed the edge",
      pings.length >= 1 && widest <= PONG_TIMEOUT_MS,
      `${pings.length} pings, widest gap ${widest} ms (<= ${PONG_TIMEOUT_MS} ms)`,
      pings.length === 0 ? "no ping arrived" : `widest gap ${widest} ms > ${PONG_TIMEOUT_MS} ms (the server would cut the socket)`,
    ),
    judge("WebSocket idle: nothing refused the socket", !frames.some((f) => /^(reload|route|error)\//.test(f)), `frames [${frames.join(", ") || "none"}]`, `the server answered [${frames.join(", ")}]`),
  ];
  return checks;
}
