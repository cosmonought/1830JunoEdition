// server/src/aws/controlPlane/flipSuppression.ts
//
// ==================================================================
//  LIVE-6 L6-5B: THE PLANNED-FLIP WINDOW'S ALARM SUPPRESSION -- BOUNDED BY CONSTRUCTION (PURE)
// ==================================================================
//
// L6-2's rule: inside an OPEN, UNEXPIRED planned-flip window (`AUDIT operator.flip-window`), and only for the flip's TWO
// pools, the ACTIONS of the alarms for the flip's expected effects are suppressed -- never a metric, never an alarm state,
// never a loss (exit 3 / 4), a refusal, a generation / restore failure, a money sweep failure or the relayer's page.
//
// THE MECHANISM (infra/aws/modules/app/alarms.tf): every suppressible alarm notifies only through a composite
// `<name>-notify` whose `actions_suppressor` is its pool's `gs-<env>-<pool>-flip-window` metric alarm. That suppressor is
// ALARM only while the SUM of the minute's `FlipWindowOpen` datapoints (namespace 18Cosmos/Operator, [Environment, Pool])
// is at least 1, and OK when there are none (missing data: notBreaching). ADDITIVE (review M5): each window adds +1 to its
// own minutes and its close adds -1 to the SAME minutes it still covers, so two windows that overlap (a flip re-run after a
// refused CAS; a rollback or a flip back within 45 minutes) compose -- a close ends only its own window. So:
//
//   OPEN   (the flip's F1, before the CAS)  one datapoint of value +1 per minute, for exactly the flip's two pools, from
//          the window's opening minute up to its `expires_at` -- published AHEAD of time (CloudWatch accepts timestamps up
//          to two hours in the future; the window is at most 45 minutes). No process has to stay alive: when the
//          published minutes run out, the suppressor sees no data, turns OK, and the composites act on their CURRENT
//          state -- a failure that is still there after the window still notifies.
//   CLOSE  (the CAS refused / conflicted, or the recovery settled)  a datapoint of value -1 for every remaining minute of
//          THIS window: its +1 is cancelled from the current minute on (another open window's +1 stands), so the suppressor
//          turns OK at once unless another window still covers the pool. A close is published once per window and only for
//          an open that was published (a close that is not matched can only cancel suppression: the safe direction).
//   EXPIRE nothing to do, ever: the window cannot outlive `expires_at`, and nothing any caller passes can publish past
//          `opened_at + 45 min` or past CloudWatch's own two-hour future limit (both refused below).
//
// Nothing here disables an alarm's actions, sets an alarm's state, or touches an alarm definition: there is nothing to
// "re-enable", so nothing can be left muted by a process that died. A publication that FAILS changes nothing about the
// flip (alarms then page during it: the safe direction); a close that fails is bounded by the expiry.
//
// A RESTORE / ADOPTION IS NOT A FLIP: no generation, adoption, identity-restore, restore-fencing, journal-ahead or
// generation-loss alarm is suppressible at all (alarm-contract.json), so an overlapping flip window can never mask one.

export const FLIP_SUPPRESSION = Object.freeze({
  namespace: "18Cosmos/Operator",
  metric: "FlipWindowOpen",
  /** L6-2's bound on the window (`FLIP_WINDOW_MS`); the suppression never reaches past it. */
  maxWindowMs: 45 * 60_000,
  /** CloudWatch refuses datapoints more than two hours in the future; kept well inside it. */
  maxAheadMs: 2 * 60 * 60_000 - 5 * 60_000,
  minuteMs: 60_000,
  /** PutMetricData datums per request (well under the service limit). */
  batch: 20,
});

export interface FlipWindowSpan {
  readonly environment: string;
  /** The flip's two pools: `from` and `to` (a rollback's too). */
  readonly pools: readonly string[];
  readonly opened_at: number;
  readonly expires_at: number;
}

export interface SuppressionDatum {
  readonly MetricName: string;
  readonly Dimensions: ReadonlyArray<{ readonly Name: "Environment" | "Pool"; readonly Value: string }>;
  /** Milliseconds since the epoch, at a minute boundary. */
  readonly Timestamp: number;
  readonly Value: 1 | -1;
  readonly Unit: "None";
}

export type SuppressionPlan =
  | { readonly ok: true; readonly namespace: string; readonly datums: readonly SuppressionDatum[]; readonly until: number | null }
  | { readonly ok: false; readonly problem: string };

const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/;
/** A pool the IaC deploys (infra/aws/modules/app `pools`): only those have a suppressor alarm. */
const IAC_POOL = /^[a-z][a-z0-9-]{0,15}$/;

/** Why `span` cannot be suppressed (null: it can): exactly two distinct pools, a real window of at most 45 minutes. */
export function flipWindowSpanProblem(span: FlipWindowSpan): string | null {
  if (!ENVIRONMENT.test(span.environment)) return `environment ${JSON.stringify(span.environment)} is not a runtime document's label`;
  if (!Array.isArray(span.pools) || span.pools.length !== 2 || span.pools[0] === span.pools[1]) return "a planned-flip window suppresses exactly the flip's two pools";
  for (const pool of span.pools) if (typeof pool !== "string" || !IAC_POOL.test(pool)) return `pool ${JSON.stringify(pool)} is not a serving pool id`;
  if (!Number.isSafeInteger(span.opened_at) || !Number.isSafeInteger(span.expires_at) || span.expires_at <= span.opened_at) return "the window has no opening and expiry in order";
  if (span.expires_at - span.opened_at > FLIP_SUPPRESSION.maxWindowMs) return `the window is longer than ${FLIP_SUPPRESSION.maxWindowMs / 60_000} minutes (L6-2's bound)`;
  return null;
}

const floorMinute = (at: number) => Math.floor(at / FLIP_SUPPRESSION.minuteMs) * FLIP_SUPPRESSION.minuteMs;

/**
 * The datapoints that OPEN (value +1) or CLOSE (value -1) the suppression of `span`, as of `now`: one per minute per pool,
 * from the current minute (open: the window's opening minute, if later) to the last minute that starts before
 * `expires_at`. An expired window yields nothing (it already ended by itself). Refused: a span `flipWindowSpanProblem`
 * refuses, an open that starts after its expiry, anything reaching past CloudWatch's future limit.
 */
export function suppressionDatums(span: FlipWindowSpan, phase: "open" | "close", now: number): SuppressionPlan {
  const problem = flipWindowSpanProblem(span);
  if (problem !== null) return { ok: false, problem };
  if (!Number.isSafeInteger(now)) return { ok: false, problem: "no current time" };
  if (now >= span.expires_at) return { ok: true, namespace: FLIP_SUPPRESSION.namespace, datums: [], until: null };
  if (span.expires_at - now > FLIP_SUPPRESSION.maxAheadMs) return { ok: false, problem: "the window's expiry is further ahead than CloudWatch accepts a datapoint" };
  const first = floorMinute(phase === "open" ? Math.max(now, span.opened_at) : now);
  const minutes: number[] = [];
  for (let at = first; at < span.expires_at; at += FLIP_SUPPRESSION.minuteMs) minutes.push(at);
  const value: 1 | -1 = phase === "open" ? 1 : -1;
  const datums: SuppressionDatum[] = [];
  for (const pool of span.pools) {
    for (const at of minutes) {
      datums.push({ MetricName: FLIP_SUPPRESSION.metric, Dimensions: [{ Name: "Environment", Value: span.environment }, { Name: "Pool", Value: pool }], Timestamp: at, Value: value, Unit: "None" });
    }
  }
  return { ok: true, namespace: FLIP_SUPPRESSION.namespace, datums, until: minutes.length === 0 ? null : minutes[minutes.length - 1] + FLIP_SUPPRESSION.minuteMs };
}

/** The API seam L6-2's flip and recovery call (production: `aws/operator/flipSuppression.ts`, CloudWatch PutMetricData
 *  into FLIP_SUPPRESSION.namespace only; tests: a recorder). Throws on failure; the caller never lets that change the flip. */
export interface FlipSuppressionPort {
  publish(namespace: string, datums: readonly SuppressionDatum[]): Promise<void>;
}

/** The outcome the flip audits (`operator.flip-suppression`) -- never a reason to refuse or stop the flip. */
export type SuppressionOutcome =
  | { readonly outcome: "published"; readonly datums: number; readonly until: number | null }
  | { readonly outcome: "nothing-to-publish" }
  | { readonly outcome: "not-configured" }
  | { readonly outcome: "refused"; readonly problem: string }
  | { readonly outcome: "failed"; readonly error_class: string };

/** Plan and publish; never throws. */
export async function applySuppression(port: FlipSuppressionPort | null, span: FlipWindowSpan, phase: "open" | "close", now: number): Promise<SuppressionOutcome> {
  if (port === null) return { outcome: "not-configured" };
  const plan = suppressionDatums(span, phase, now);
  if (!plan.ok) return { outcome: "refused", problem: plan.problem };
  if (plan.datums.length === 0) return { outcome: "nothing-to-publish" };
  try {
    for (let i = 0; i < plan.datums.length; i += FLIP_SUPPRESSION.batch) await port.publish(plan.namespace, plan.datums.slice(i, i + FLIP_SUPPRESSION.batch));
    return { outcome: "published", datums: plan.datums.length, until: plan.until };
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    return { outcome: "failed", error_class: typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error" };
  }
}
