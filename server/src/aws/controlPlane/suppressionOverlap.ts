// server/src/aws/controlPlane/suppressionOverlap.ts
//
// ==================================================================
//  LIVE-6 L6-6 (RESTORE DRILL): THE STAGING FLIP-SUPPRESSION OVERLAP TEST'S RECORD -- `18COSMOS/L6-6-SUPPRESSION-OVERLAP/v1`
// ==================================================================
//
// The restore drill must show that its unsuppressible alarms (R1, A4g, A4i, R2, R3) still fire, with their actions not
// suppressed, while the planned-flip suppression mechanism is GENUINELY active. A second real routing flip during a
// restore drill is not required (owner decision): instead `gamesDoctor aws suppression-overlap open <A> <B>` drives the
// SAME mechanism a real flip drives -- L6-5B's `applySuppression` publishing `FlipWindowOpen` (+1 per minute, ahead, for
// exactly two pools, at most 45 minutes, through the operator's `cloudWatchSuppression` port) -- and NOTHING ELSE:
// SYSTEM/ROUTING is read (strongly) before the open and again at the close, and never written; no pool, role, game,
// generation or escrow is touched. It is NOT a routing flip and is never called one: its record says so in `statement`.
//
// The record (one JSON file, normally `<evidence>/restore-alarms/suppression-window.json`) is written BEFORE anything is
// published (evidence first; created once -- an existing file is never overwritten by an open) and updated by the close:
//
//   { format, kind: "staging-flip-suppression-overlap", statement, environment, pools: [A, B], note,
//     opened_at, expires_at,                                   (ms; expires_at - opened_at <= 45 min)
//     routing_before: { primary_pool, routing_version },      (SYSTEM/ROUTING, read strongly before publishing)
//     open:   { outcome, datums, until, detail },             (applySuppression's answer: published | refused | failed | pending)
//     closed: null | { at, outcome, routing_after } }         (the close's answer; routing_after read strongly at the close)
//
// The drill's producer (`aws/deploy/staging/restoreAlarmProbe.ts`) never takes this file's word for the suppression: it
// proves each pool's suppressor `gs-<env>-<pool>-flip-window` ALARM at the injection from CloudWatch's own answers
// (describe-alarms before the injection, describe-alarm-history after it). This file contributes the window's span, the
// two pools, and the routing seen before and after (which must be the same: the test moved nothing).

import * as fs from "fs";

import { FLIP_SUPPRESSION } from "./flipSuppression";

export const SUPPRESSION_OVERLAP_FORMAT = "18COSMOS/L6-6-SUPPRESSION-OVERLAP/v1";
export const SUPPRESSION_OVERLAP_KIND = "staging-flip-suppression-overlap";
export const SUPPRESSION_OVERLAP_STATEMENT =
  "a staging flip-suppression overlap test: FlipWindowOpen published for two named pools through the planned-flip mechanism; NOT a routing flip -- SYSTEM/ROUTING was read, never written";
/** The bound on the test's window: L6-2's flip window bound (the mechanism refuses anything longer). */
export const SUPPRESSION_OVERLAP_MAX_MINUTES = FLIP_SUPPRESSION.maxWindowMs / 60_000;

export interface RoutingSeen {
  readonly primary_pool: string;
  readonly routing_version: number;
}

export type OverlapOutcome = "pending" | "published" | "nothing-to-publish" | "not-configured" | "refused" | "failed";

export interface SuppressionOverlapRecord {
  readonly format: typeof SUPPRESSION_OVERLAP_FORMAT;
  readonly kind: typeof SUPPRESSION_OVERLAP_KIND;
  readonly statement: typeof SUPPRESSION_OVERLAP_STATEMENT;
  readonly environment: string;
  readonly pools: readonly [string, string];
  readonly note: string;
  readonly opened_at: number;
  readonly expires_at: number;
  readonly routing_before: RoutingSeen;
  readonly open: { readonly outcome: OverlapOutcome; readonly datums: number | null; readonly until: number | null; readonly detail: string | null };
  readonly closed: null | { readonly at: number; readonly outcome: OverlapOutcome | "expired"; readonly routing_after: RoutingSeen | null; readonly detail: string | null };
}

const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/;
const POOL = /^[a-z][a-z0-9-]{0,15}$/;
const OUTCOMES: readonly string[] = ["pending", "published", "nothing-to-publish", "not-configured", "refused", "failed"];
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

function routingOf(v: unknown): RoutingSeen | null {
  const r = obj(v);
  return typeof r.primary_pool === "string" && POOL.test(r.primary_pool) && int(r.routing_version) && r.routing_version >= 1 ? { primary_pool: r.primary_pool, routing_version: r.routing_version } : null;
}

/** The record, strictly (a BOM tolerated): anything else is a problem, never a partial record. */
export function parseSuppressionOverlap(text: string): SuppressionOverlapRecord | { readonly problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { problem: "not JSON" };
  }
  const r = obj(raw);
  if (r.format !== SUPPRESSION_OVERLAP_FORMAT || r.kind !== SUPPRESSION_OVERLAP_KIND || r.statement !== SUPPRESSION_OVERLAP_STATEMENT) return { problem: `not a ${SUPPRESSION_OVERLAP_FORMAT} staging flip-suppression overlap record` };
  if (typeof r.environment !== "string" || !ENVIRONMENT.test(r.environment)) return { problem: "no environment" };
  const pools = Array.isArray(r.pools) ? r.pools : [];
  if (pools.length !== 2 || pools.some((p) => typeof p !== "string" || !POOL.test(p)) || pools[0] === pools[1]) return { problem: "the test names exactly two distinct pools" };
  if (!int(r.opened_at) || !int(r.expires_at) || r.expires_at <= r.opened_at || r.expires_at - r.opened_at > FLIP_SUPPRESSION.maxWindowMs) return { problem: `the window is not a span of at most ${SUPPRESSION_OVERLAP_MAX_MINUTES} minutes` };
  const before = routingOf(r.routing_before);
  if (before === null) return { problem: "no routing read before the open" };
  const open = obj(r.open);
  if (typeof open.outcome !== "string" || !OUTCOMES.includes(open.outcome)) return { problem: "no open outcome" };
  let closed: SuppressionOverlapRecord["closed"] = null;
  if (r.closed !== null && r.closed !== undefined) {
    const c = obj(r.closed);
    if (!int(c.at) || typeof c.outcome !== "string" || !(OUTCOMES.includes(c.outcome) || c.outcome === "expired")) return { problem: "a malformed close" };
    closed = { at: c.at, outcome: c.outcome as OverlapOutcome | "expired", routing_after: c.routing_after === null ? null : routingOf(c.routing_after), detail: typeof c.detail === "string" ? c.detail : null };
    if (c.routing_after !== null && closed.routing_after === null) return { problem: "a malformed routing read at the close" };
  }
  return {
    format: SUPPRESSION_OVERLAP_FORMAT,
    kind: SUPPRESSION_OVERLAP_KIND,
    statement: SUPPRESSION_OVERLAP_STATEMENT,
    environment: r.environment,
    pools: [pools[0] as string, pools[1] as string],
    note: typeof r.note === "string" ? r.note : "",
    opened_at: r.opened_at,
    expires_at: r.expires_at,
    routing_before: before,
    open: { outcome: open.outcome as OverlapOutcome, datums: int(open.datums) ? open.datums : null, until: int(open.until) ? open.until : null, detail: typeof open.detail === "string" ? open.detail : null },
    closed,
  };
}

/** Whether the test moved the routing (it must not have): the close's read equals the open's. */
export const routingUnchanged = (record: SuppressionOverlapRecord): boolean =>
  record.closed !== null && record.closed.routing_after !== null && record.closed.routing_after.primary_pool === record.routing_before.primary_pool && record.closed.routing_after.routing_version === record.routing_before.routing_version;

/** Write the record. `create`: only if absent (an open never overwrites an earlier test's record). */
export function writeSuppressionOverlap(file: string, record: SuppressionOverlapRecord, mode: "create" | "replace"): void {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (mode === "create") fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
  else fs.writeFileSync(file, text, "utf8");
}
