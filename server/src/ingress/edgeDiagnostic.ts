// server/src/ingress/edgeDiagnostic.ts
//
// ==================================================================
//  LIVE-6 L6-6: `/gs/diag/edge` -- WHAT THE APPLICATION SAW OF THE EDGE, FOR THE STAGING CERTIFICATION ONLY
// ==================================================================
//
// The real-AWS staging gate (Project `claude/LIVE6_L6_6_STAGING_CERT_HARNESS_2026-09-30.md`) must prove, through the
// DEPLOYED path (client -> CloudFront -> ALB -> this task), two facts no Terraform inspection can:
//
//   PROXY HOPS   `GS_TRUSTED_PROXY_HOPS=2` is right: exactly two trusted proxies appended to X-Forwarded-For, so the
//                right-anchored address (`identity/clientIp.ts`) is the viewer's -- never a spoofed entry, never
//                CloudFront's or the ALB's own address;
//   QUERY        the `/gs*` query string arrives unchanged: `cp`, `cr`, `cb` (the client announcement) AND every other
//                parameter -- the edge contract is "forward ALL query strings", never an allow-list of today's three.
//
// So this route answers, for ONE request, only what that request itself carried or what is derived from it:
//
//   format                "18COSMOS/EDGE-DIAGNOSTIC/v1"
//   trusted_proxy_hops    the configured count (a public fact of the deployment: infra/aws/README.md)
//   forwarded_entries     how many entries X-Forwarded-For had (never their values)
//   client_key_sha256     SHA-256 of the limiter key the request is counted against (`v4:a.b.c.d` / `v6:<prefix>/64`) --
//                         the caller's OWN address, hashed; the answer never carries an address in the clear
//   client_key_problem    the fixed refusal reason of `clientIpOf` when there is no key, else null
//   announcement          the canonical parser's reading of cp / cr / cb (`parseClientAnnouncement`): numbers, and a
//                         build id only when it is one (`BUILD_PATTERN`) -- never a stranger's free text
//   parameters            [SHA-256(name), SHA-256(value)] for every query parameter, in the order received
//   query_sha256          SHA-256 of the raw query string (after `?`) exactly as received
//
// WHAT IT NEVER DOES: echo a header, a cookie, an address, a name or a value in the clear; read a body; authenticate;
// touch identity, a game, a store or any AWS service; decide anything. It grants nothing, so it cannot be an
// authentication bypass: it is a mirror of the caller's own request, hashed.
//
// WHERE IT EXISTS: only in AWS storage mode, and only when the task's environment says `GS_EDGE_DIAGNOSTIC=staging`
// (`aws/runtime/awsMain.ts`), which the runtime refuses beside a MAINNET escrow configuration and Terraform sets only
// through `edge_diagnostic_staging` (validated non-mainnet). PROCESS mode and every production task have no such route.

import { createHash } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

import { clientIpOf } from "../identity/clientIp";
import { parseClientAnnouncement, rawClientAnnouncementOf, type ClientAnnouncement } from "../../../frontend/src/gameEngine/compat/clientCompatibility";

export const EDGE_DIAGNOSTIC_PATH = "/gs/diag/edge";
export const EDGE_DIAGNOSTIC_FORMAT = "18COSMOS/EDGE-DIAGNOSTIC/v1";
/** The task environment variable that mounts the route, and its one accepted value. */
export const EDGE_DIAGNOSTIC_ENV = "GS_EDGE_DIAGNOSTIC";
export const EDGE_DIAGNOSTIC_SWITCH = "staging";
/** A request line longer than this is answered 414 (CloudFront's own URL limit is 8,192 bytes). */
export const EDGE_DIAGNOSTIC_MAX_URL = 8_192;
/** At most this many parameters are reported (a probe sends a handful). */
export const EDGE_DIAGNOSTIC_MAX_PARAMETERS = 64;

export interface EdgeDiagnosticAnswer {
  readonly format: typeof EDGE_DIAGNOSTIC_FORMAT;
  readonly trusted_proxy_hops: number;
  readonly forwarded_entries: number;
  readonly client_key_sha256: string | null;
  readonly client_key_problem: string | null;
  readonly announcement: ClientAnnouncement;
  readonly parameters: ReadonlyArray<readonly [string, string]>;
  readonly parameters_truncated: boolean;
  readonly query_sha256: string;
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The answer for one request (pure: the request's URL and headers, the configured hop count). */
export function edgeDiagnosticAnswer(request: Pick<IncomingMessage, "url" | "headers" | "socket">, trustedProxyHops: number): EdgeDiagnosticAnswer {
  const url = request.url ?? "/";
  const at = url.indexOf("?");
  const rawQuery = at < 0 ? "" : url.slice(at + 1);
  const query = new URLSearchParams(rawQuery);
  const parameters: Array<readonly [string, string]> = [];
  let truncated = false;
  for (const [name, value] of query) {
    if (parameters.length >= EDGE_DIAGNOSTIC_MAX_PARAMETERS) {
      truncated = true;
      break;
    }
    parameters.push([sha256Hex(name), sha256Hex(value)] as const);
  }
  const header = request.headers["x-forwarded-for"];
  const joined = Array.isArray(header) ? header.join(",") : header;
  const forwarded = typeof joined === "string" && joined.trim() !== "" ? joined.split(",").length : 0;
  const client = clientIpOf(request, trustedProxyHops);
  return {
    format: EDGE_DIAGNOSTIC_FORMAT,
    trusted_proxy_hops: trustedProxyHops,
    forwarded_entries: forwarded,
    client_key_sha256: client.ok ? sha256Hex(client.ip.key) : null,
    client_key_problem: client.ok ? null : client.reason,
    announcement: parseClientAnnouncement(rawClientAnnouncementOf(query)),
    parameters,
    parameters_truncated: truncated,
    query_sha256: sha256Hex(rawQuery),
  };
}

const HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

/** Answer `/gs/diag/edge` when that is the path (true: handled). GET only; the body is never read. */
export function handleEdgeDiagnostic(request: IncomingMessage, response: ServerResponse, options: { readonly trustedProxyHops: number }): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return false;
  }
  if (pathname !== EDGE_DIAGNOSTIC_PATH) return false;
  if (request.method !== "GET") {
    response.writeHead(405, { ...HEADERS, Allow: "GET" });
    response.end(`${JSON.stringify({ error: "method-not-allowed" })}\n`);
    return true;
  }
  if ((request.url ?? "").length > EDGE_DIAGNOSTIC_MAX_URL) {
    response.writeHead(414, HEADERS);
    response.end(`${JSON.stringify({ error: "uri-too-long" })}\n`);
    return true;
  }
  response.writeHead(200, HEADERS);
  response.end(`${JSON.stringify(edgeDiagnosticAnswer(request, options.trustedProxyHops))}\n`);
  return true;
}

/** Mainnet chain ids (`escrow/juno/signer.ts`'s list, restated so this ingress module loads nothing of escrow). */
const MAINNET_CHAINS: readonly string[] = Object.freeze(["juno-1"]);

/**
 * The switch as the task's environment gives it: absent -> off; `staging` -> on; anything else is a refusal. On is also
 * refused beside a MAINNET escrow configuration (network class or chain id) and in an environment named `prod*`: the
 * route is the staging certification's probe, never a production surface.
 */
export function edgeDiagnosticSwitch(
  value: string | undefined,
  deployment: { readonly environment: string; readonly escrow: { readonly networkClass: string; readonly chainId: string } | null },
): { readonly ok: true; readonly enabled: boolean } | { readonly ok: false; readonly reason: string } {
  if (value === undefined || value === "") return { ok: true, enabled: false };
  if (value !== EDGE_DIAGNOSTIC_SWITCH) return { ok: false, reason: `${EDGE_DIAGNOSTIC_ENV} must be absent or "${EDGE_DIAGNOSTIC_SWITCH}" (it mounts ${EDGE_DIAGNOSTIC_PATH} for the staging certification only)` };
  if (deployment.escrow !== null && (deployment.escrow.networkClass === "mainnet" || MAINNET_CHAINS.includes(deployment.escrow.chainId))) {
    return { ok: false, reason: `${EDGE_DIAGNOSTIC_ENV} is refused beside a mainnet escrow configuration (it is the staging certification's probe)` };
  }
  if (/^prod/.test(deployment.environment)) return { ok: false, reason: `${EDGE_DIAGNOSTIC_ENV} is refused in the ${deployment.environment} environment (it is the staging certification's probe)` };
  return { ok: true, enabled: true };
}
