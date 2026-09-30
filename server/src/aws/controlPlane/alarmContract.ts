// server/src/aws/controlPlane/alarmContract.ts
//
// ==================================================================
//  LIVE-6 L6-5B: THE ALARM CONTRACT, AND THE LIVE ALARMS JUDGED AGAINST IT (PURE; READ-ONLY EVIDENCE)
// ==================================================================
//
// `ALARM_CONTRACT` is infra/aws/modules/app/alarm-contract.json -- the file Terraform builds every alarm from -- carried
// here as a constant (the server never reads the infrastructure tree at run time); `l6_5bAlarms.test.ts` pins the two
// byte-for-byte, so a threshold changed in one place and not the other fails the suite.
//
// `checkAlarmsEvidence` judges `aws cloudwatch describe-alarms --alarm-name-prefix gs-<env>-` (captured by
// infra/aws/scripts/capture-evidence) against the contract expanded for this deployment: every expected alarm exists
// with exactly its namespace, metrics, statistics, dimensions, period, threshold, evaluation window and missing-data
// rule; the primary-only alarms watch --primary-pool; the page / ticket wiring class; a suppressible alarm notifies only
// through its composite, suppressed by its OWN pool's flip window; nothing else is suppressible; every alarm's actions are
// ENABLED (nobody muted one); each flip-window suppressor is not in ALARM outside an open, unexpired window of that pool;
// and no alarm exists in the game-server namespace that the contract does not name (a per-task alarm, a high-cardinality
// dimension). It reads nothing but the evidence and writes nothing.

import type { Check } from "./evidence";

export const ALARM_CONTRACT = Object.freeze({
  "format": "18COSMOS/ALARM-CONTRACT/v1",
  "namespace": "18Cosmos/GameServer",
  "dimensions": {
    "environment": [
      "Environment"
    ],
    "pool": [
      "Environment",
      "Pool"
    ],
    "primary": [
      "Environment",
      "Pool"
    ]
  },
  "suppressor": {
    "namespace": "18Cosmos/Operator",
    "metric": "FlipWindowOpen",
    "statistic": "Sum",
    "period": 60,
    "threshold": 1,
    "missing": "notBreaching",
    "wait_period": 120,
    "extension_period": 120,
    "max_window_minutes": 45
  },
  "alarms": [
    {
      "id": "a1-unexpected-task-loss",
      "scope": "environment",
      "class": "page",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "TaskLost",
          "stat": "Sum"
        },
        {
          "id": "m2",
          "metric": "TaskSuperseded",
          "stat": "Sum"
        }
      ],
      "expression": "FILL(m1, 0) - FILL(m2, 0)",
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A1: a task lost for any cause but a proven same-pool supersession (exit 3). Never suppressed: an exit 3 during a flip is still abnormal."
    },
    {
      "id": "a2-writer-epoch-conflict",
      "scope": "pool",
      "class": "page",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "TaskSuperseded",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 600,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanThreshold",
      "threshold": 2,
      "missing": "notBreaching",
      "description": "A2: more than 2 same-pool supersessions in 10 minutes (two tasks of one pool taking it from each other)."
    },
    {
      "id": "a3-store-uncertain",
      "scope": "environment",
      "class": "ticket",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "StoreUncertain",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A3: a store could not settle a write (exit 4), first occurrence. Never suppressed."
    },
    {
      "id": "a3-store-restart-loop",
      "scope": "environment",
      "class": "page",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "StoreUncertain",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 900,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 2,
      "missing": "notBreaching",
      "description": "A3: repeated store-uncertain restarts within 15 minutes (a restart loop). Never suppressed."
    },
    {
      "id": "a4-startup-refused",
      "scope": "environment",
      "class": "page",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "StartupRefused",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A4: a refused start (exit 2). A drained service runs no task and refuses nothing, so it never pages."
    },
    {
      "id": "a4g-generation-refused",
      "scope": "environment",
      "class": "page",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "StartupRefusedGeneration",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A4g: a start refused by the generation rules (APPGEN, SYSTEM/GENERATION, the adoption binding). Never suppressed by a flip or a restore window."
    },
    {
      "id": "a4i-identity-restore-refused",
      "scope": "environment",
      "class": "page",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "StartupRefusedIdentityRestore",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A4i: the primary refused to serve an identity table whose restore is incomplete (L6-4). Never suppressed."
    },
    {
      "id": "a5-money-sweep-stale",
      "scope": "pool",
      "class": "page",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "MoneySweepSecondsSinceSuccess",
          "stat": "Maximum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 180,
      "missing": "notBreaching",
      "description": "A5: no completed money claim sweep for 3 minutes on the pool that sweeps. Never suppressed."
    },
    {
      "id": "a5b-money-sweep-games-failing",
      "scope": "pool",
      "class": "ticket",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "MoneySweepGamesFailed",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 3,
      "datapoints_to_alarm": 3,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A5b: completed sweep passes that could not judge or claim some games, 3 minutes running (a count, never the games)."
    },
    {
      "id": "a5c-money-sweep-passes-failing",
      "scope": "environment",
      "class": "ticket",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "MoneySweepPassFailed",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 300,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 3,
      "missing": "notBreaching",
      "description": "A5c: at least 3 failed sweep passes in 5 minutes (the early signal before A5)."
    },
    {
      "id": "a6-relayer-unusable",
      "scope": "primary",
      "class": "page",
      "suppressible": true,
      "requires": "escrow",
      "metrics": [
        {
          "id": "m1",
          "metric": "RelayerUsable",
          "stat": "Maximum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 2,
      "datapoints_to_alarm": 2,
      "comparison": "LessThanThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A6: the primary's relayer not usable for 2 minutes (held and escrow active). Suppressed only inside a planned flip window of this pool."
    },
    {
      "id": "a6b-relayer-takeover-not-taken",
      "scope": "environment",
      "class": "ticket",
      "suppressible": false,
      "requires": "escrow",
      "metrics": [
        {
          "id": "m1",
          "metric": "RelayerTakeoverNotTaken",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 600,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 3,
      "missing": "notBreaching",
      "description": "A6b: relayer-role takeovers refused or unknown at least 3 times in 10 minutes."
    },
    {
      "id": "a7-escrow-inactive",
      "scope": "primary",
      "class": "page",
      "suppressible": false,
      "requires": "escrow",
      "metrics": [
        {
          "id": "m1",
          "metric": "EscrowActive",
          "stat": "Maximum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 10,
      "datapoints_to_alarm": 10,
      "comparison": "LessThanThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A7: the primary's financial mode not active for 10 minutes (a damaged RELAYQ/FINIDX/FINKEYS load leaves it unverified). Never suppressed."
    },
    {
      "id": "a8-kms-refused",
      "scope": "environment",
      "class": "page",
      "suppressible": false,
      "requires": "escrow",
      "metrics": [
        {
          "id": "m1",
          "metric": "KmsRefused",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A8: KMS refused a key the service uses. Any occurrence."
    },
    {
      "id": "a9-kms-invalid-answer",
      "scope": "environment",
      "class": "page",
      "suppressible": false,
      "requires": "escrow",
      "metrics": [
        {
          "id": "m1",
          "metric": "KmsInvalidAnswer",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A9: KMS answered something the service cannot use (the verify-failed class). Any occurrence."
    },
    {
      "id": "a10-signer-unavailable",
      "scope": "environment",
      "class": "page",
      "suppressible": false,
      "requires": "escrow",
      "metrics": [
        {
          "id": "t",
          "metric": "KmsTransient",
          "stat": "Sum"
        },
        {
          "id": "o",
          "metric": "KmsOtherFailure",
          "stat": "Sum"
        },
        {
          "id": "w",
          "metric": "KmsSignWithheld",
          "stat": "Sum"
        },
        {
          "id": "s",
          "metric": "KmsSigns",
          "stat": "Sum"
        }
      ],
      "expression": "IF((FILL(t, 0) + FILL(o, 0) + FILL(w, 0)) > 0 AND FILL(s, 0) == 0, 1, 0)",
      "period": 60,
      "evaluation_periods": 5,
      "datapoints_to_alarm": 5,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A10: signing attempted and failing (or withheld: KmsSignWithheld = KMS never called, the pool writer unconfirmed) with no successful Sign, 5 minutes running."
    },
    {
      "id": "a11-readiness-flapping",
      "scope": "pool",
      "class": "ticket",
      "suppressible": true,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "ReadinessTransitions",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 600,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 6,
      "missing": "notBreaching",
      "description": "A11: at least 6 readiness transitions in 10 minutes (target health is /gs/readyz, so this is also the target-health flap)."
    },
    {
      "id": "a12-prolonged-unready",
      "scope": "pool",
      "class": "page",
      "suppressible": true,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "UnreadySeconds",
          "stat": "Maximum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 300,
      "missing": "notBreaching",
      "description": "A12: a task continuously unready for 5 minutes. A healthy non-primary router answers ready and is never Unready."
    },
    {
      "id": "a12b-pool-writer-unconfirmed",
      "scope": "pool",
      "class": "ticket",
      "suppressible": true,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "PoolWriterConfirmed",
          "stat": "Minimum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 2,
      "datapoints_to_alarm": 2,
      "comparison": "LessThanThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A12b: the pool writer without a good self-check for 2 minutes."
    },
    {
      "id": "a13-primary-heartbeat",
      "scope": "primary",
      "class": "page",
      "suppressible": true,
      "requires": "services",
      "metrics": [
        {
          "id": "m1",
          "metric": "Primary",
          "stat": "SampleCount"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 3,
      "datapoints_to_alarm": 3,
      "comparison": "LessThanThreshold",
      "threshold": 1,
      "missing": "breaching",
      "description": "A13: no status record from the task holding the identity-writer role in the pool marked primary for 3 minutes (dead, not logging, or this alarm left on a demoted pool). Missing data is breaching. TASK# is never read for this."
    },
    {
      "id": "a14-task-status-write-failures",
      "scope": "pool",
      "class": "ticket",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "TaskStatusWriteFailures",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 600,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 10,
      "missing": "notBreaching",
      "description": "A14: the diagnostic TASK# item failing to write (diagnostics only)."
    },
    {
      "id": "a15-relayer-paging",
      "scope": "pool",
      "class": "page",
      "suppressible": false,
      "requires": "escrow",
      "metrics": [
        {
          "id": "m1",
          "metric": "RelayerPaging",
          "stat": "Maximum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "A15: the relayer-role holder has a PAGED waiting condition (L6-7). On every pool (only the holder emits it). Never suppressed."
    },
    {
      "id": "r1-generation-lost",
      "scope": "environment",
      "class": "page",
      "suppressible": false,
      "requires": null,
      "metrics": [
        {
          "id": "m1",
          "metric": "GenerationLost",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "R1: a serving task lost to the generation fence (APPGEN moved under it). A planned restore stops every task before adoption, so this is never expected. Never suppressed."
    },
    {
      "id": "r2-money-journal-ahead",
      "scope": "environment",
      "class": "page",
      "suppressible": false,
      "requires": "escrow",
      "metrics": [
        {
          "id": "m1",
          "metric": "MoneyHeldJournalAhead",
          "stat": "Sum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 1,
      "datapoints_to_alarm": 1,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "R2: a money game held journal-ahead (after a restore: its F1 or quorum check failed). Never suppressed."
    },
    {
      "id": "r3-restore-unverified",
      "scope": "pool",
      "class": "page",
      "suppressible": false,
      "requires": "escrow",
      "metrics": [
        {
          "id": "m1",
          "metric": "RestoreUnverifiedGames",
          "stat": "Minimum"
        }
      ],
      "expression": null,
      "period": 60,
      "evaluation_periods": 60,
      "datapoints_to_alarm": 60,
      "comparison": "GreaterThanOrEqualToThreshold",
      "threshold": 1,
      "missing": "notBreaching",
      "description": "R3: on a restored table, money games still read-only (check pending, neither verified nor held) for a whole hour. Ordinary verifications clear long before. Never suppressed."
    }
  ]
} as const);

export type AlarmSpec = (typeof ALARM_CONTRACT.alarms)[number];

/* ------------------------------------------------------------------ */
/* The contract expanded for one deployment                            */
/* ------------------------------------------------------------------ */

export interface ExpectedAlarm {
  /** `<id>`, `<pool>/<id>` or `primary/<id>` (Terraform's key, the `alarms` output's key). */
  readonly key: string;
  readonly name: string;
  readonly spec: AlarmSpec;
  /** The Pool dimension it watches (null: [Environment] only). */
  readonly pool: string | null;
}

export interface DeploymentShape {
  readonly environment: string;
  readonly pools: readonly string[];
  readonly primaryPool: string;
  /** The runtime document names an escrow (the escrow-only alarms exist). */
  readonly escrow: boolean;
  /** The services run (the heartbeat, whose missing data is breaching, exists). */
  readonly services: boolean;
}

export const suppressorName = (environment: string, pool: string): string => `gs-${environment}-${pool}-flip-window`;
/** How long after a window closed or expired its suppressor may still read ALARM (evaluation lag + the composite's
 *  extension period): the verifier's grace, never a suppression of its own. */
export const SUPPRESSOR_TAIL_MS = 5 * 60_000;

/** Exactly what alarms.tf builds for `shape` (the same expansion, in TypeScript). */
export function expectedAlarms(shape: DeploymentShape): ExpectedAlarm[] {
  const prefix = `gs-${shape.environment}`;
  const specs = ALARM_CONTRACT.alarms.filter((a) => a.requires === null || (a.requires === "escrow" && shape.escrow) || (a.requires === "services" && shape.services));
  const out: ExpectedAlarm[] = [];
  for (const spec of specs) {
    if (spec.scope === "environment") out.push({ key: spec.id, name: `${prefix}-${spec.id}`, spec, pool: null });
    else if (spec.scope === "primary") out.push({ key: `primary/${spec.id}`, name: `${prefix}-primary-${spec.id}`, spec, pool: shape.primaryPool });
    else for (const pool of [...shape.pools].sort()) out.push({ key: `${pool}/${spec.id}`, name: `${prefix}-${pool}-${spec.id}`, spec, pool });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The live alarms (describe-alarms evidence), judged                   */
/* ------------------------------------------------------------------ */

type Json = unknown;
const obj = (value: Json): Record<string, Json> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : {});
const arr = (value: Json): Json[] => (Array.isArray(value) ? value : []);
const strs = (value: Json): string[] => arr(value).map(String).sort();
const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });
const judge = (name: string, ok: boolean, good: string, bad: string): Check => (ok ? pass(name, good) : fail(name, bad));
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A planned-flip window as its record states it (L6-2's `FlipRecord.window`, with its two pools). */
export interface FlipWindowFacts {
  readonly from: string;
  readonly to: string;
  readonly opened_at: number;
  readonly expires_at: number;
  readonly closed_at: number | null;
}

export interface AlarmEvidenceExpectation extends DeploymentShape {
  /** The configured destinations (`page_alarm_action_arns` / `ticket_alarm_action_arns`); null: not given -- then only
   *  the class consistency is judged (every page alarm alike, every ticket alarm alike, the two never shared). */
  readonly pageActions: readonly string[] | null;
  readonly ticketActions: readonly string[] | null;
  /** The flip whose window may be open now (--flip-record), or null. */
  readonly flip: FlipWindowFacts | null;
  readonly now: number;
}

/** One metric query of an alarm, as describe-alarms prints it, against the contract's. */
function metricsProblem(alarm: Record<string, Json>, expected: ExpectedAlarm, environment: string): string | null {
  const queries = arr(alarm.Metrics).map(obj);
  const spec = expected.spec;
  const want = spec.metrics.length + (spec.expression === null ? 0 : 1);
  if (queries.length !== want) return `${queries.length} metric queries, the contract has ${want}`;
  for (const m of spec.metrics) {
    const q = queries.find((x) => x.Id === m.id);
    if (q === undefined) return `no metric query ${m.id}`;
    const stat = obj(q.MetricStat);
    const metric = obj(stat.Metric);
    const dims = arr(metric.Dimensions).map(obj).map((d) => `${String(d.Name)}=${String(d.Value)}`).sort();
    const wantDims = (expected.pool === null ? [`Environment=${environment}`] : [`Environment=${environment}`, `Pool=${expected.pool}`]).sort();
    if (metric.Namespace !== ALARM_CONTRACT.namespace) return `${m.id} reads namespace ${String(metric.Namespace)}, not ${ALARM_CONTRACT.namespace}`;
    if (metric.MetricName !== m.metric) return `${m.id} reads ${String(metric.MetricName)}, not ${m.metric}`;
    if (stat.Stat !== m.stat) return `${m.id}'s statistic is ${String(stat.Stat)}, not ${m.stat}`;
    if (stat.Period !== spec.period) return `${m.id}'s period is ${String(stat.Period)}, not ${spec.period}`;
    if (!same(dims, wantDims)) return `${m.id}'s dimensions are [${dims.join(", ")}], not [${wantDims.join(", ")}]`;
    if ((q.ReturnData === true) !== (spec.expression === null)) return `${m.id}'s ReturnData is ${String(q.ReturnData)}`;
  }
  if (spec.expression !== null) {
    const e = queries.find((x) => typeof x.Expression === "string");
    if (e === undefined) return "no expression query";
    if (e.Expression !== spec.expression) return `the expression is ${JSON.stringify(e.Expression)}, not ${JSON.stringify(spec.expression)}`;
    if (e.ReturnData !== true) return "the expression does not return the alarm's data";
  }
  return null;
}

/** Every check of the live alarms (see the header). A missing evidence document is the caller's failure. */
export function checkAlarmsEvidence(doc: Json, expect: AlarmEvidenceExpectation): Check[] {
  const checks: Check[] = [];
  const metricAlarms = arr(obj(doc).MetricAlarms).map(obj);
  const composites = arr(obj(doc).CompositeAlarms).map(obj);
  if (!Array.isArray(obj(doc).MetricAlarms) || !Array.isArray(obj(doc).CompositeAlarms)) return [fail("alarms: evidence", "not a describe-alarms answer (MetricAlarms and CompositeAlarms)")];
  const byName = new Map(metricAlarms.map((a) => [String(a.AlarmName), a] as const));
  const compositeByName = new Map(composites.map((a) => [String(a.AlarmName), a] as const));
  const expected = expectedAlarms(expect);
  const classActions = new Map<string, Set<string>>([["page", new Set()], ["ticket", new Set()]]);
  const noteActions = (cls: string, alarm: Record<string, Json>) => {
    const key = [...strs(alarm.AlarmActions)].join(",") + "|" + [...strs(alarm.OKActions)].join(",");
    classActions.get(cls)?.add(key);
  };
  const want = (cls: string): readonly string[] | null => (cls === "page" ? expect.pageActions : expect.ticketActions);

  /* 1. every contract alarm, exactly */
  for (const e of expected) {
    const a = byName.get(e.name);
    const label = `alarm ${e.name}`;
    if (a === undefined) {
      checks.push(fail(`${label}: exists`, "not in the evidence"));
      continue;
    }
    const spec = e.spec;
    const problems = [
      metricsProblem(a, e, expect.environment),
      a.ComparisonOperator === spec.comparison ? null : `comparison ${String(a.ComparisonOperator)}, not ${spec.comparison}`,
      a.Threshold === spec.threshold ? null : `threshold ${String(a.Threshold)}, not ${spec.threshold}`,
      a.EvaluationPeriods === spec.evaluation_periods ? null : `evaluation periods ${String(a.EvaluationPeriods)}, not ${spec.evaluation_periods}`,
      a.DatapointsToAlarm === spec.datapoints_to_alarm ? null : `datapoints to alarm ${String(a.DatapointsToAlarm)}, not ${spec.datapoints_to_alarm}`,
      a.TreatMissingData === spec.missing ? null : `missing data ${String(a.TreatMissingData)}, not ${spec.missing}`,
      a.ActionsEnabled === true ? null : "its actions are DISABLED (an alarm is never muted: a flip suppresses through its composite, bounded)",
    ].filter((p): p is string => p !== null);
    checks.push(judge(`${label}: definition`, problems.length === 0, `${spec.class}, ${spec.scope}${e.pool === null ? "" : ` (${e.pool})`}`, problems.join("; ")));
    if (spec.suppressible) {
      checks.push(judge(`${label}: notifies only through its composite`, strs(a.AlarmActions).length === 0 && strs(a.OKActions).length === 0, "no direct action", `direct actions [${strs(a.AlarmActions).join(", ")}]`));
      const c = compositeByName.get(`${e.name}-notify`);
      if (c === undefined) {
        checks.push(fail(`${label}: composite`, `${e.name}-notify is not in the evidence (the alarm would never notify)`));
        continue;
      }
      const suppressor = suppressorName(expect.environment, e.pool as string);
      const cProblems = [
        c.AlarmRule === `ALARM("${e.name}")` ? null : `rule ${JSON.stringify(c.AlarmRule)}`,
        c.ActionsEnabled === true ? null : "its actions are DISABLED",
        c.ActionsSuppressor === suppressor ? null : `suppressed by ${String(c.ActionsSuppressor)}, not its pool's ${suppressor}`,
        c.ActionsSuppressorWaitPeriod === ALARM_CONTRACT.suppressor.wait_period && c.ActionsSuppressorExtensionPeriod === ALARM_CONTRACT.suppressor.extension_period ? null : `suppressor periods ${String(c.ActionsSuppressorWaitPeriod)} / ${String(c.ActionsSuppressorExtensionPeriod)}`,
      ].filter((p): p is string => p !== null);
      checks.push(judge(`${label}: composite`, cProblems.length === 0, `${e.name}-notify, suppressed only by ${suppressor}`, cProblems.join("; ")));
      noteActions(spec.class, c);
      const w = want(spec.class);
      if (w !== null) checks.push(judge(`${label}: ${spec.class} actions`, same(strs(c.AlarmActions), [...w].sort()) && same(strs(c.OKActions), [...w].sort()), `the ${spec.class} list`, `[${strs(c.AlarmActions).join(", ")}], not the ${spec.class} list`));
    } else {
      /* Never suppressed: notifies directly, and NO composite anywhere wraps it (a wrapper could be suppressed). */
      const wrappers = composites.filter((c) => String(c.AlarmRule ?? "").includes(`"${e.name}"`)).map((c) => String(c.AlarmName));
      checks.push(judge(`${label}: never suppressed`, wrappers.length === 0, "no composite wraps it", `wrapped by ${wrappers.join(", ")}`));
      noteActions(spec.class, a);
      const w = want(spec.class);
      if (w !== null) checks.push(judge(`${label}: ${spec.class} actions`, same(strs(a.AlarmActions), [...w].sort()) && same(strs(a.OKActions), [...w].sort()), `the ${spec.class} list`, `[${strs(a.AlarmActions).join(", ")}], not the ${spec.class} list`));
    }
  }

  /* 2. the wiring class: every page alarm alike, every ticket alarm alike, the classes never share a destination */
  const page = [...(classActions.get("page") ?? [])];
  const ticket = [...(classActions.get("ticket") ?? [])];
  const destinations = (keys: string[]) => new Set(keys.flatMap((k) => k.split("|").flatMap((part) => part.split(",")).filter((x) => x.length > 0)));
  const shared = [...destinations(page)].filter((d) => destinations(ticket).has(d));
  checks.push(judge("alarms: page / ticket wiring class", page.length <= 1 && ticket.length <= 1 && shared.length === 0, page.length === 0 || page[0] === "|" ? "consistent (no destination configured: valid in staging)" : "consistent per class, none shared", `${page.length} different page wirings, ${ticket.length} different ticket wirings${shared.length > 0 ? `; shared: ${shared.join(", ")}` : ""}`));

  /* 3. the flip-window suppressors: their definition, and never ALARM outside an open, unexpired window of their pool */
  const flip = expect.flip;
  /* Review L4: a suppressor evaluates a minute behind and is judged on its latest datapoint, so it may still read ALARM a
     few minutes after its window closed or expired -- a bounded tail, never permanent. */
  const tailEnd = flip === null ? 0 : Math.min(flip.expires_at, flip.closed_at ?? Number.POSITIVE_INFINITY) + SUPPRESSOR_TAIL_MS;
  const windowOpen = flip !== null && expect.now >= flip.opened_at && expect.now < tailEnd;
  for (const pool of [...expect.pools].sort()) {
    const name = suppressorName(expect.environment, pool);
    const s = byName.get(name);
    if (s === undefined) {
      checks.push(fail(`suppressor ${name}`, "not in the evidence"));
      continue;
    }
    const dims = arr(s.Dimensions).map(obj).map((d) => `${String(d.Name)}=${String(d.Value)}`).sort();
    const problems = [
      s.Namespace === ALARM_CONTRACT.suppressor.namespace && s.MetricName === ALARM_CONTRACT.suppressor.metric ? null : `reads ${String(s.Namespace)}/${String(s.MetricName)}`,
      s.Statistic === ALARM_CONTRACT.suppressor.statistic && s.Period === ALARM_CONTRACT.suppressor.period ? null : `statistic ${String(s.Statistic)} over ${String(s.Period)} s`,
      s.Threshold === ALARM_CONTRACT.suppressor.threshold && s.ComparisonOperator === "GreaterThanOrEqualToThreshold" && s.EvaluationPeriods === 1 ? null : "not ALARM exactly while the minute's open windows sum to at least 1",
      s.TreatMissingData === ALARM_CONTRACT.suppressor.missing ? null : `missing data ${String(s.TreatMissingData)} (it must END by itself when the published minutes run out)`,
      same(dims, [`Environment=${expect.environment}`, `Pool=${pool}`].sort()) ? null : `dimensions [${dims.join(", ")}]`,
      strs(s.AlarmActions).length === 0 && strs(s.OKActions).length === 0 ? null : "it has actions",
    ].filter((p): p is string => p !== null);
    checks.push(judge(`suppressor ${name}: definition`, problems.length === 0, "Sum of FlipWindowOpen >= 1 (additive windows); missing data OK", problems.join("; ")));
    const inWindow = windowOpen && flip !== null && (pool === flip.from || pool === flip.to);
    checks.push(judge(`suppressor ${name}: restored outside a window`, inWindow || s.StateValue !== "ALARM", inWindow ? `inside the open window of the flip ${flip?.from} -> ${flip?.to} (until ${new Date(flip?.expires_at ?? 0).toISOString()})` : `${String(s.StateValue)}: not suppressing`, `ALARM with no open, unexpired flip window of ${pool}: this pool's alarm actions are being suppressed`));
  }

  /* 4. cardinality: nothing in the game-server namespace (or wrapping it) the contract does not name */
  const known = new Set([...expected.map((e) => e.name), ...[...expect.pools].map((p) => suppressorName(expect.environment, p))]);
  /* This environment's only: `--alarm-name-prefix gs-<env>-` also lists an environment named `<env>-x`. */
  /* Review L-B: excluded only when it names ANOTHER environment -- an alarm with no Environment dimension stays in scope. */
  const ofThisEnvironment = (a: Record<string, Json>) =>
    ![...arr(a.Dimensions), ...arr(a.Metrics).flatMap((m) => arr(obj(obj(obj(m).MetricStat).Metric).Dimensions))].map(obj).some((d) => d.Name === "Environment" && d.Value !== expect.environment);
  const extra = metricAlarms.filter((a) => !known.has(String(a.AlarmName)) && ofThisEnvironment(a) && (a.Namespace === ALARM_CONTRACT.namespace || arr(a.Metrics).some((m) => obj(obj(obj(m).MetricStat).Metric).Namespace === ALARM_CONTRACT.namespace))).map((a) => String(a.AlarmName));
  checks.push(judge("alarms: nothing outside the contract", extra.length === 0, `${expected.length} contract alarms and ${expect.pools.length} suppressor(s)`, `alarms the contract does not name (a per-task alarm, a high-cardinality dimension): ${extra.slice(0, 10).join(", ")}`));
  const badDims = metricAlarms.flatMap((a) => arr(a.Metrics).map((m) => obj(obj(obj(m).MetricStat).Metric)).filter((m) => m.Namespace === ALARM_CONTRACT.namespace).flatMap((m) => arr(m.Dimensions).map((d) => String(obj(d).Name))).filter((n) => n !== "Environment" && n !== "Pool"));
  checks.push(judge("alarms: dimensions Environment and Pool only", badDims.length === 0, "[Environment] or [Environment, Pool]", `other dimensions: ${[...new Set(badDims)].join(", ")}`));
  return checks;
}
