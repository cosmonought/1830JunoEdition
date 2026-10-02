// server/src/aws/operator/suppressionOverlap.ts
//
// ==================================================================
//  LIVE-6 L6-6 (RESTORE DRILL): `gamesDoctor aws suppression-overlap open | close` -- A STAGING FLIP-SUPPRESSION OVERLAP
//  TEST THROUGH THE PLANNED FLIP'S OWN SUPPRESSION MECHANISM, WITHOUT A ROUTING FLIP
// ==================================================================
//
// Owner decision (restore-drill tooling): the restore drill does NOT make a second real routing flip. To prove that the
// restore alarms are never suppressed by an overlapping planned-flip window, this command drives the SAME mechanism a real
// flip drives -- `controlPlane/flipSuppression.ts` `applySuppression` (the +1-per-minute `FlipWindowOpen` datapoints, for
// exactly two pools, published ahead, bounded by L6-2's 45 minutes and CloudWatch's two-hour future limit) through the
// operator's own `cloudWatchSuppression` port (PutMetricData into `18Cosmos/Operator` only) -- and nothing else:
//
//   open   staging only (a `prod*` environment is refused); the two pools must be pools of THIS deployment (each pool's
//          own runtime document is read, exactly as a flip's preflight reads it, and must name this environment and that
//          pool); SYSTEM/ROUTING is read strongly and recorded (absent or unreadable: refused -- a test whose "nothing
//          moved" cannot be shown is not run); the record is written FIRST (create-once: an earlier test's record is never
//          overwritten); then the window's datapoints are published and the answer recorded.
//   close  SYSTEM/ROUTING read strongly again and recorded; if the window was published and has not expired, its -1
//          datapoints cancel THIS window's remaining minutes (the additive close: another window's +1 stands); recorded.
//
// It writes no DynamoDB item at all (the routing is READ: no CAS, no version, no pool, role, game, generation or escrow),
// sets no alarm state, and enables or disables no alarm action. A publication that fails changes nothing but the record
// (alarms then simply act: the safe direction). Every write is a dry run unless `--apply`. It is never called a flip.

import * as fs from "fs";

import { FLIP_SUPPRESSION, applySuppression, flipWindowSpanProblem, suppressionDatums, type FlipSuppressionPort, type FlipWindowSpan } from "../controlPlane/flipSuppression";
import {
  parseSuppressionOverlap,
  routingUnchanged,
  SUPPRESSION_OVERLAP_FORMAT,
  SUPPRESSION_OVERLAP_KIND,
  SUPPRESSION_OVERLAP_MAX_MINUTES,
  SUPPRESSION_OVERLAP_STATEMENT,
  writeSuppressionOverlap,
  type RoutingSeen,
  type SuppressionOverlapRecord,
} from "../controlPlane/suppressionOverlap";

export interface OverlapDeps {
  /** The deployment's environment label (the runtime document's). */
  readonly environment: string;
  /** SYSTEM/ROUTING, strongly consistent (null: none; throws: unreadable / unavailable). */
  readonly readRouting: () => Promise<{ readonly primary_pool: string; readonly routing_version: number } | null>;
  /** A pool's own runtime document, read as its task reads it (throws: no such pool / unreadable). */
  readonly poolDocument: (pool: string) => Promise<{ readonly environment: string; readonly pool: string }>;
  /** The planned-flip suppression's publisher (production: `cloudWatchSuppression`; null: not configured). */
  readonly suppression: FlipSuppressionPort | null;
  readonly now: () => number;
  readonly audit: (event: string, fields: Record<string, unknown>) => void;
}

export type OverlapAnswer =
  | { readonly kind: "planned"; readonly detail: string; readonly record: SuppressionOverlapRecord | null; readonly datums: number }
  | { readonly kind: "opened" | "closed"; readonly detail: string; readonly record: SuppressionOverlapRecord }
  | { readonly kind: "refused"; readonly detail: string; readonly record: SuppressionOverlapRecord | null };

const POOL = /^[a-z][a-z0-9-]{0,15}$/;
const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 240);

async function routingNow(deps: OverlapDeps): Promise<{ readonly routing: RoutingSeen | null; readonly problem: string | null }> {
  try {
    const r = await deps.readRouting();
    if (r === null) return { routing: null, problem: "SYSTEM/ROUTING does not exist" };
    return { routing: { primary_pool: r.primary_pool, routing_version: r.routing_version }, problem: null };
  } catch (error) {
    return { routing: null, problem: `SYSTEM/ROUTING could not be read (${describe(error)})` };
  }
}

const spanOf = (record: SuppressionOverlapRecord): FlipWindowSpan => ({ environment: record.environment, pools: [...record.pools], opened_at: record.opened_at, expires_at: record.expires_at });

/** `suppression-overlap open <A> <B> --minutes <n> --note "<why>" --record <file> [--apply]`. */
export async function openSuppressionOverlap(deps: OverlapDeps, input: { readonly pools: readonly string[]; readonly minutes: number; readonly note: string; readonly recordFile: string; readonly apply: boolean }): Promise<OverlapAnswer> {
  const refuse = (detail: string): OverlapAnswer => ({ kind: "refused", detail, record: null });
  if (/^prod/.test(deps.environment)) return refuse(`the staging flip-suppression overlap test never runs in a prod* environment (${deps.environment})`);
  if (input.pools.length !== 2 || input.pools[0] === input.pools[1] || input.pools.some((p) => !POOL.test(p))) return refuse("name exactly two distinct pools of this deployment");
  if (!Number.isSafeInteger(input.minutes) || input.minutes < 1 || input.minutes > SUPPRESSION_OVERLAP_MAX_MINUTES) return refuse(`--minutes is 1..${SUPPRESSION_OVERLAP_MAX_MINUTES} (the planned-flip window's bound)`);
  if (input.note.trim() === "") return refuse('--note "<why>" is required');
  for (const pool of input.pools) {
    try {
      const doc = await deps.poolDocument(pool);
      if (doc.environment !== deps.environment || doc.pool !== pool) return refuse(`pool ${pool}'s runtime document names ${doc.environment}/${doc.pool}, not ${deps.environment}/${pool}`);
    } catch (error) {
      return refuse(`pool ${pool} is not a pool of this deployment (its runtime document: ${describe(error)})`);
    }
  }
  const before = await routingNow(deps);
  if (before.routing === null) return refuse(`${String(before.problem)}: the test must show that the routing did not move, so it is not run`);
  const opened = Math.floor(deps.now());
  const span: FlipWindowSpan = { environment: deps.environment, pools: [...input.pools], opened_at: opened, expires_at: opened + input.minutes * 60_000 };
  const spanProblem = flipWindowSpanProblem(span);
  if (spanProblem !== null) return refuse(spanProblem);
  const plan = suppressionDatums(span, "open", opened);
  if (!plan.ok) return refuse(plan.problem);
  const record: SuppressionOverlapRecord = {
    format: SUPPRESSION_OVERLAP_FORMAT,
    kind: SUPPRESSION_OVERLAP_KIND,
    statement: SUPPRESSION_OVERLAP_STATEMENT,
    environment: deps.environment,
    pools: [input.pools[0], input.pools[1]],
    note: input.note,
    opened_at: span.opened_at,
    expires_at: span.expires_at,
    routing_before: before.routing,
    open: { outcome: "pending", datums: null, until: null, detail: null },
    closed: null,
  };
  if (!input.apply) return { kind: "planned", detail: `would publish ${plan.datums.length} FlipWindowOpen datapoints (+1/min) for [${input.pools.join(", ")}] until ${new Date(span.expires_at).toISOString()}; SYSTEM/ROUTING v${before.routing.routing_version} (primary ${before.routing.primary_pool}) is only read`, record, datums: plan.datums.length };
  if (fs.existsSync(input.recordFile)) return refuse(`${input.recordFile} exists (an earlier test's record is never overwritten): give a new --record`);
  /* Evidence first: the record exists before anything is published. */
  try {
    writeSuppressionOverlap(input.recordFile, record, "create");
  } catch (error) {
    return refuse(`the record could not be created (${describe(error)}); nothing was published`);
  }
  const answer = await applySuppression(deps.suppression, span, "open", Math.floor(deps.now()));
  const outcome = answer.outcome;
  const done: SuppressionOverlapRecord = {
    ...record,
    open: {
      outcome,
      datums: answer.outcome === "published" ? answer.datums : null,
      until: answer.outcome === "published" ? answer.until : null,
      detail: answer.outcome === "refused" ? answer.problem : answer.outcome === "failed" ? answer.error_class : null,
    },
  };
  writeSuppressionOverlap(input.recordFile, done, "replace");
  deps.audit("operator.suppression-overlap", { phase: "open", kind: SUPPRESSION_OVERLAP_KIND, pools: [...input.pools], opened_at: span.opened_at, expires_at: span.expires_at, outcome, routing_version: before.routing.routing_version });
  if (outcome !== "published") return { kind: "refused", detail: `the suppression was not published (${outcome}${done.open.detail !== null ? `: ${done.open.detail}` : ""}); the record says so`, record: done };
  return { kind: "opened", detail: `FlipWindowOpen published for [${input.pools.join(", ")}] until ${new Date(span.expires_at).toISOString()} (${String(done.open.datums)} datapoints); SYSTEM/ROUTING read, not written`, record: done };
}

/** `suppression-overlap close --record <file> [--apply]`. */
export async function closeSuppressionOverlap(deps: OverlapDeps, input: { readonly recordFile: string; readonly apply: boolean }): Promise<OverlapAnswer> {
  let text: string;
  try {
    text = fs.readFileSync(input.recordFile, "utf8");
  } catch (error) {
    return { kind: "refused", detail: `${input.recordFile} cannot be read (${describe(error)})`, record: null };
  }
  const parsed = parseSuppressionOverlap(text);
  if ("problem" in parsed) return { kind: "refused", detail: `${input.recordFile}: ${parsed.problem}`, record: null };
  if (parsed.environment !== deps.environment) return { kind: "refused", detail: `${input.recordFile} is ${parsed.environment}'s test, not ${deps.environment}'s`, record: parsed };
  if (parsed.closed !== null) return { kind: "closed", detail: `already closed at ${new Date(parsed.closed.at).toISOString()} (${parsed.closed.outcome})${routingUnchanged(parsed) ? "; SYSTEM/ROUTING unchanged" : "; SYSTEM/ROUTING NOT shown unchanged"}`, record: parsed };
  const after = await routingNow(deps);
  const at = Math.floor(deps.now());
  const live = parsed.open.outcome === "published" && at < parsed.expires_at;
  if (!input.apply) return { kind: "planned", detail: `${live ? "would cancel the window's remaining minutes (-1 each)" : "the window already ended (nothing to publish)"}; SYSTEM/ROUTING now ${after.routing === null ? String(after.problem) : `v${after.routing.routing_version} (primary ${after.routing.primary_pool})`}`, record: parsed, datums: 0 };
  let outcome: SuppressionOverlapRecord["open"]["outcome"] | "expired" = "expired";
  let detail: string | null = null;
  if (live) {
    const answer = await applySuppression(deps.suppression, spanOf(parsed), "close", at);
    outcome = answer.outcome;
    detail = answer.outcome === "refused" ? answer.problem : answer.outcome === "failed" ? `${answer.error_class} (the window still ends by itself at ${new Date(parsed.expires_at).toISOString()})` : null;
  } else if (parsed.open.outcome !== "published") outcome = "nothing-to-publish";
  if (after.routing === null) detail = `${detail === null ? "" : `${detail}; `}${String(after.problem)}`;
  const closed: SuppressionOverlapRecord = { ...parsed, closed: { at, outcome, routing_after: after.routing, detail } };
  writeSuppressionOverlap(input.recordFile, closed, "replace");
  deps.audit("operator.suppression-overlap", { phase: "close", kind: SUPPRESSION_OVERLAP_KIND, pools: [...parsed.pools], expires_at: parsed.expires_at, outcome, routing_version: after.routing?.routing_version ?? null });
  const unchanged = routingUnchanged(closed);
  return unchanged
    ? { kind: "closed", detail: `closed (${outcome}); SYSTEM/ROUTING unchanged at v${parsed.routing_before.routing_version} (primary ${parsed.routing_before.primary_pool})`, record: closed }
    : { kind: "refused", detail: `closed (${outcome}), but SYSTEM/ROUTING is ${after.routing === null ? String(after.problem) : `v${after.routing.routing_version} (primary ${after.routing.primary_pool})`}, not the v${parsed.routing_before.routing_version} (primary ${parsed.routing_before.primary_pool}) read at the open: the overlap test cannot certify anything`, record: closed };
}

/** For the CLI's summary. */
export const OVERLAP_BOUND_MINUTES = FLIP_SUPPRESSION.maxWindowMs / 60_000;
