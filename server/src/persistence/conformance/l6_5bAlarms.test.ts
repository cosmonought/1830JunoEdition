// server/src/persistence/conformance/l6_5bAlarms.test.ts
//
// LIVE-6 L6-5B: the alarm contract, the verifier's alarm and TTL checks, the planned-flip suppression, the gates'
// machine records, and the boundaries (targeted; no AWS -- the suppressor publisher's CloudWatch client is a fake).
//
//   contract     alarm-contract.json (Terraform's source) == ALARM_CONTRACT (the verifier's); every metric is L6-5A's
//                catalog's, at a dimension set the catalog emits; gauges never summed; exactly A6/A11/A12/A12b/A13
//                suppressible -- never a loss, a refusal, a generation / restore failure, the sweep, KMS or the relayer page
//   verifier     a describe-alarms answer rendered from the contract passes; each tampering fails by name: a metric, the
//                math, a dimension, a threshold, the evaluation, missing data, muted actions, a direct action on a
//                suppressible alarm, its composite missing or suppressed by another pool, a never-suppress alarm wrapped,
//                a suppressor in ALARM outside a window (open / closed / expired / unrelated pool), a primary alarm left
//                on the old primary, an alarm outside the contract, page / ticket wiring; the game table's TTL
//   suppression  one datum per minute per pool, the flip's two pools only, to expires_at and never past 45 minutes or
//                CloudWatch's future limit; a close writes 0s; an expired window needs nothing; a failing publisher never
//                throws into the flip; the publisher writes only 18Cosmos/Operator; the flip's hook audits and never throws
//   gates        the generation-gate attestation and the rotation gate's record: only the gate's own OPEN record binds;
//                a record is created once
//   escrow       restoreStatus counts the checks' last answers (pending / held / verified) and decides nothing
//   boundaries   no Logs metric filter anywhere; only TASK# carries `ttl` in the game table; the runtime never reaches
//                CloudWatch; the rotation gate's queue reader stays the gate's own

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

import { ALARM_CONTRACT, checkAlarmsEvidence, expectedAlarms, suppressorName, type AlarmEvidenceExpectation, type ExpectedAlarm } from "../../aws/controlPlane/alarmContract";
import { applySuppression, FLIP_SUPPRESSION, suppressionDatums, type FlipSuppressionPort, type SuppressionDatum } from "../../aws/controlPlane/flipSuppression";
import type { FlipRecord } from "../../aws/controlPlane/flipRecord";
import { cloudWatchSuppression } from "../../aws/operator/flipSuppression";
import { closeFlipWindow, FLIP_WINDOW_MS, suppressFlipWindow } from "../../aws/operator/flip";
import type { MutationContext } from "../../aws/operator/mutations";
import { checkTable, EVIDENCE_FILES } from "../../aws/deploy/deployVerify";
import { GENERATION_GATE_FORMAT, generationAttestationProblem, ROTATION_GATE_FORMAT, rotationGateRecordProblem, writeGateRecord } from "../../aws/deploy/gateRecords";
import { METRIC_NAMESPACE, METRICS } from "../../aws/runtime/runtimeMetrics";
import { TASK_STATUS_TTL_SECONDS } from "../../aws/runtime/taskStatus";
import { readCheckoutText, relativePosix } from "../../testSupport/portability";
import { GAME_A, makeWorld, play, startedGame, toStockRound, type World } from "../../escrow/escrow3bSupport";
import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";

/* dist/server/src/persistence/conformance -> server/src (the sources), and the repository root above it. */
const SERVER_SRC = path.resolve(__dirname, "../../../../../src");
const REPO = path.resolve(SERVER_SRC, "../..");
const CONTRACT_FILE = path.join(REPO, "infra/aws/modules/app/alarm-contract.json");

/** LIVE-6 W1: the only aws/ sources that may name `ttl` -- TASK#'s writer, and identity / deploy code (the identity
 *  table's own TTL, the verifier's TTL checks) -- judged on the `/`-separated name relative to server/src. */
const ttlGuardExempt = (rel: string): boolean => rel.endsWith(".test.ts") || /^aws\/(identity|deploy)\//.test(rel) || rel === "aws/runtime/taskStatus.ts";

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });

/* ================================================================== */
describe("L6-5B the alarm contract", () => {
  test("alarm-contract.json (what Terraform builds) is exactly ALARM_CONTRACT (what the verifier judges)", () => {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(CONTRACT_FILE, "utf8")), JSON.parse(JSON.stringify(ALARM_CONTRACT)));
  });

  test("every alarm reads L6-5A's namespace and catalog, at a dimension set the catalog emits; gauges are never summed; counters are summed", () => {
    assert.equal(ALARM_CONTRACT.namespace, METRIC_NAMESPACE);
    const ids = new Set<string>();
    for (const a of ALARM_CONTRACT.alarms) {
      assert.ok(!ids.has(a.id), `duplicate ${a.id}`);
      ids.add(a.id);
      assert.ok(["environment", "pool", "primary"].includes(a.scope), a.id);
      assert.ok(["page", "ticket"].includes(a.class), a.id);
      for (const m of a.metrics) {
        const spec = (METRICS as Record<string, { kind: string; scope: string }>)[m.metric];
        assert.ok(spec !== undefined, `${a.id}: ${m.metric} is not in the EMF catalog`);
        if (a.scope === "environment") assert.equal(spec.scope, "environment", `${a.id}: ${m.metric} has no [Environment] series`);
        if (spec.kind === "gauge") assert.ok(["Maximum", "Minimum", "SampleCount", "Average"].includes(m.stat), `${a.id}: a gauge is never summed`);
        else assert.equal(m.stat, "Sum", `${a.id}: a counter is alarmed on its Sum`);
      }
      assert.ok(a.datapoints_to_alarm <= a.evaluation_periods && a.period * a.evaluation_periods <= 86_400, a.id);
      assert.ok(a.missing === "notBreaching" || a.id === "a13-primary-heartbeat", `${a.id}: only the heartbeat's missing data breaches`);
    }
    assert.deepEqual(ALARM_CONTRACT.dimensions, { environment: ["Environment"], pool: ["Environment", "Pool"], primary: ["Environment", "Pool"] });
  });

  test("the suppressible class is exactly the flip's expected effects; losses, refusals, generation / restore failures, the sweep, escrow, KMS and the relayer page never are", () => {
    const suppressible = ALARM_CONTRACT.alarms.filter((a) => a.suppressible).map((a) => a.id).sort();
    assert.deepEqual(suppressible, ["a11-readiness-flapping", "a12-prolonged-unready", "a12b-pool-writer-unconfirmed", "a13-primary-heartbeat", "a6-relayer-unusable"]);
    for (const id of ["a1-unexpected-task-loss", "a3-store-uncertain", "a3-store-restart-loop", "a4-startup-refused", "a4g-generation-refused", "a4i-identity-restore-refused", "r1-generation-lost", "r2-money-journal-ahead", "r3-restore-unverified", "a15-relayer-paging", "a5-money-sweep-stale", "a7-escrow-inactive", "a8-kms-refused", "a9-kms-invalid-answer", "a10-signer-unavailable"]) {
      const a = ALARM_CONTRACT.alarms.find((x) => x.id === id);
      assert.ok(a !== undefined && !a.suppressible, id);
    }
    assert.equal(ALARM_CONTRACT.alarms.find((a) => a.id === "a15-relayer-paging")?.class, "page");
    assert.deepEqual(ALARM_CONTRACT.alarms.filter((a) => a.scope === "primary").map((a) => a.id).sort(), ["a13-primary-heartbeat", "a6-relayer-unusable", "a7-escrow-inactive"]);
    assert.equal(ALARM_CONTRACT.suppressor.max_window_minutes * 60_000, FLIP_WINDOW_MS, "the suppression's bound is L6-2's window");
    assert.equal(ALARM_CONTRACT.suppressor.namespace, FLIP_SUPPRESSION.namespace);
  });

  test("A1 subtracts only the proven same-pool supersession; A10 keeps KmsSignWithheld (KMS never called) as its own term", () => {
    const a1 = ALARM_CONTRACT.alarms.find((a) => a.id === "a1-unexpected-task-loss")!;
    assert.deepEqual(a1.metrics.map((m) => m.metric), ["TaskLost", "TaskSuperseded"]);
    assert.equal(a1.expression, "FILL(m1, 0) - FILL(m2, 0)");
    const a10 = ALARM_CONTRACT.alarms.find((a) => a.id === "a10-signer-unavailable")!;
    assert.deepEqual(a10.metrics.map((m) => `${m.id}=${m.metric}`), ["t=KmsTransient", "o=KmsOtherFailure", "w=KmsSignWithheld", "s=KmsSigns"]);
  });

  test("the expansion: 13 per environment + 9 per pool + 3 on the primary (escrow and services); nothing per task", () => {
    const all = expectedAlarms({ environment: "staging", pools: ["p1", "p2", "p3"], primaryPool: "p1", escrow: true, services: true });
    assert.equal(all.length, 13 + 9 * 3 + 3);
    assert.ok(all.every((e) => /^gs-staging-(primary|p[123])?-?[a-z0-9-]+$/.test(e.name) && !/t-[0-9a-f]{8,}/.test(e.name)), "names from the contract's ids and pool ids only");
    assert.deepEqual(new Set(all.map((e) => e.pool)), new Set([null, "p1", "p2", "p3"]));
    const bare = expectedAlarms({ environment: "staging", pools: ["p1"], primaryPool: "p1", escrow: false, services: false });
    assert.ok(!bare.some((e) => /a6-|a7-|a8-|a9-|a10-|a15-|r2-|r3-|a13-/.test(e.key)), "no escrow: no relayer / KMS / money alarm; no services: no heartbeat");
  });
});

/* ================================================================== */
/* The verifier: a describe-alarms answer rendered as Terraform would    */
/* ================================================================== */

const PAGE = "arn:aws:sns:us-east-1:111111111111:gs-staging-page";
const TICKET = "arn:aws:sns:us-east-1:111111111111:gs-staging-ticket";
const SHAPE = { environment: "staging", pools: ["p1", "p2"], primaryPool: "p1", escrow: true, services: true } as const;

function render(shape: { readonly environment: string; readonly pools: readonly string[]; readonly primaryPool: string; readonly escrow: boolean; readonly services: boolean }, actions: { page: string[]; ticket: string[] }) {
  const listOf = (cls: string) => (cls === "page" ? actions.page : actions.ticket);
  const metricAlarm = (e: ExpectedAlarm) => ({
    AlarmName: e.name,
    ActionsEnabled: true,
    AlarmActions: e.spec.suppressible ? [] : listOf(e.spec.class),
    OKActions: e.spec.suppressible ? [] : listOf(e.spec.class),
    InsufficientDataActions: [],
    StateValue: "OK",
    EvaluationPeriods: e.spec.evaluation_periods,
    DatapointsToAlarm: e.spec.datapoints_to_alarm,
    Threshold: e.spec.threshold,
    ComparisonOperator: e.spec.comparison,
    TreatMissingData: e.spec.missing,
    Metrics: [
      ...e.spec.metrics.map((m) => ({
        Id: m.id,
        MetricStat: { Metric: { Namespace: ALARM_CONTRACT.namespace, MetricName: m.metric, Dimensions: [{ Name: "Environment", Value: shape.environment }, ...(e.pool === null ? [] : [{ Name: "Pool", Value: e.pool }])] }, Period: e.spec.period, Stat: m.stat },
        ReturnData: e.spec.expression === null,
      })),
      ...(e.spec.expression === null ? [] : [{ Id: "e1", Expression: e.spec.expression, Label: e.spec.id, ReturnData: true }]),
    ],
  });
  const expected = expectedAlarms(shape);
  return {
    MetricAlarms: [
      ...expected.map(metricAlarm),
      ...shape.pools.map((pool) => ({
        AlarmName: suppressorName(shape.environment, pool),
        ActionsEnabled: true,
        AlarmActions: [],
        OKActions: [],
        StateValue: "OK",
        Namespace: "18Cosmos/Operator",
        MetricName: "FlipWindowOpen",
        Statistic: "Sum",
        Period: 60,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
        Dimensions: [{ Name: "Environment", Value: shape.environment }, { Name: "Pool", Value: pool }],
      })),
    ],
    CompositeAlarms: expected
      .filter((e) => e.spec.suppressible)
      .map((e) => ({
        AlarmName: `${e.name}-notify`,
        AlarmRule: `ALARM("${e.name}")`,
        ActionsEnabled: true,
        AlarmActions: listOf(e.spec.class),
        OKActions: listOf(e.spec.class),
        StateValue: "OK",
        ActionsSuppressor: suppressorName(shape.environment, e.pool as string),
        ActionsSuppressorWaitPeriod: 120,
        ActionsSuppressorExtensionPeriod: 120,
      })),
  };
}

type Doc = ReturnType<typeof render>;
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const expectation = (over: Partial<AlarmEvidenceExpectation> = {}): AlarmEvidenceExpectation => ({ ...SHAPE, pools: [...SHAPE.pools], pageActions: [PAGE], ticketActions: [TICKET], flip: null, now: NOW, ...over });
const failures = (doc: unknown, over: Partial<AlarmEvidenceExpectation> = {}) => checkAlarmsEvidence(doc, expectation(over)).filter((c) => c.status === "fail");
const clone = (doc: Doc): Doc => JSON.parse(JSON.stringify(doc)) as Doc;
const alarm = (doc: Doc, name: string) => doc.MetricAlarms.find((a) => a.AlarmName === name) as Record<string, any>;

describe("L6-5B the verifier's alarm checks", () => {
  test("the contract's alarms as Terraform builds them pass; so do EMPTY staging action lists (class consistency only)", () => {
    const doc = render(SHAPE, { page: [PAGE], ticket: [TICKET] });
    assert.deepEqual(failures(doc), []);
    const staging = render(SHAPE, { page: [], ticket: [] });
    assert.deepEqual(failures(staging, { pageActions: [], ticketActions: [] }), []);
    assert.deepEqual(failures(staging, { pageActions: null, ticketActions: null }), []);
    assert.ok(checkAlarmsEvidence(doc, expectation()).length > 40);
  });

  test("each tampering is found, by the alarm's name", () => {
    const base = render(SHAPE, { page: [PAGE], ticket: [TICKET] });
    const cases: Array<[string, (d: Doc) => void, RegExp]> = [
      ["a metric renamed", (d) => (alarm(d, "gs-staging-p1-a15-relayer-paging").Metrics[0].MetricStat.Metric.MetricName = "RelayerWaiting"), /a15-relayer-paging: definition/],
      ["the A1 math changed", (d) => (alarm(d, "gs-staging-a1-unexpected-task-loss").Metrics[2].Expression = "FILL(m1, 0)"), /a1-unexpected-task-loss: definition/],
      ["a Task dimension added", (d) => alarm(d, "gs-staging-p2-a12-prolonged-unready").Metrics[0].MetricStat.Metric.Dimensions.push({ Name: "Task", Value: "t-0123456789abcdef" }), /a12-prolonged-unready: definition|dimensions Environment and Pool only/],
      ["another namespace", (d) => (alarm(d, "gs-staging-a8-kms-refused").Metrics[0].MetricStat.Metric.Namespace = "AWS/KMS"), /a8-kms-refused: definition/],
      ["a threshold", (d) => (alarm(d, "gs-staging-p1-a5-money-sweep-stale").Threshold = 900), /a5-money-sweep-stale: definition/],
      ["the evaluation window", (d) => (alarm(d, "gs-staging-a10-signer-unavailable").EvaluationPeriods = 1), /a10-signer-unavailable: definition/],
      ["the heartbeat's missing data", (d) => (alarm(d, "gs-staging-primary-a13-primary-heartbeat").TreatMissingData = "notBreaching"), /a13-primary-heartbeat: definition/],
      ["the statistic", (d) => (alarm(d, "gs-staging-p1-a12b-pool-writer-unconfirmed").Metrics[0].MetricStat.Stat = "Maximum"), /a12b-pool-writer-unconfirmed: definition/],
      ["an alarm muted", (d) => (alarm(d, "gs-staging-a1-unexpected-task-loss").ActionsEnabled = false), /a1-unexpected-task-loss: definition/],
      ["a composite muted", (d) => ((d.CompositeAlarms[0] as Record<string, unknown>).ActionsEnabled = false), /: composite/],
      ["a direct action on a suppressible alarm", (d) => (alarm(d, "gs-staging-p1-a12-prolonged-unready").AlarmActions = [PAGE]), /a12-prolonged-unready: notifies only through its composite/],
      ["a composite missing", (d) => d.CompositeAlarms.splice(d.CompositeAlarms.findIndex((c) => c.AlarmName === "gs-staging-p2-a11-readiness-flapping-notify"), 1), /p2-a11-readiness-flapping: composite/],
      ["a composite suppressed by ANOTHER pool's window", (d) => (d.CompositeAlarms.find((c) => c.AlarmName === "gs-staging-p2-a12-prolonged-unready-notify")!.ActionsSuppressor = "gs-staging-p1-flip-window"), /p2-a12-prolonged-unready: composite/],
      ["an exit-3 alarm wrapped in a suppressed composite", (d) => d.CompositeAlarms.push({ AlarmName: "gs-staging-a1-quiet", AlarmRule: 'ALARM("gs-staging-a1-unexpected-task-loss")', ActionsEnabled: true, AlarmActions: [PAGE], OKActions: [PAGE], StateValue: "OK", ActionsSuppressor: "gs-staging-p1-flip-window", ActionsSuppressorWaitPeriod: 120, ActionsSuppressorExtensionPeriod: 120 }), /a1-unexpected-task-loss: never suppressed/],
      ["the relayer page wrapped", (d) => d.CompositeAlarms.push({ AlarmName: "x", AlarmRule: 'ALARM("gs-staging-p1-a15-relayer-paging")', ActionsEnabled: true, AlarmActions: [], OKActions: [], StateValue: "OK", ActionsSuppressor: "gs-staging-p1-flip-window", ActionsSuppressorWaitPeriod: 120, ActionsSuppressorExtensionPeriod: 120 }), /a15-relayer-paging: never suppressed/],
      ["a ticket wired to the page list", (d) => (alarm(d, "gs-staging-a3-store-uncertain").AlarmActions = [PAGE]), /a3-store-uncertain: ticket actions|wiring class/],
      ["a per-task alarm outside the contract", (d) => d.MetricAlarms.push({ ...alarm(d, "gs-staging-p1-a12-prolonged-unready"), AlarmName: "gs-staging-p1-t-0123456789abcdef-unready" } as never), /nothing outside the contract/],
      ["an undimensioned alarm in the namespace (review L-B: no Environment is not another environment)", (d) => d.MetricAlarms.push({ ...alarm(d, "gs-staging-a8-kms-refused"), AlarmName: "gs-staging-foo", Metrics: [{ Id: "m1", MetricStat: { Metric: { Namespace: "18Cosmos/GameServer", MetricName: "KmsRefused", Dimensions: [] }, Period: 60, Stat: "Sum" }, ReturnData: true }] } as never), /nothing outside the contract/],
      ["a suppressor that reads another metric", (d) => (alarm(d, "gs-staging-p2-flip-window").Statistic = "Maximum"), /suppressor gs-staging-p2-flip-window: definition/],
      ["a suppressor whose missing data suppresses", (d) => (alarm(d, "gs-staging-p1-flip-window").TreatMissingData = "breaching"), /suppressor gs-staging-p1-flip-window: definition/],
      ["an alarm gone", (d) => d.MetricAlarms.splice(d.MetricAlarms.findIndex((a) => a.AlarmName === "gs-staging-r1-generation-lost"), 1), /r1-generation-lost: exists/],
    ];
    for (const [label, mutate, expected] of cases) {
      const doc = clone(base);
      mutate(doc);
      const found = failures(doc).map((c) => `${c.name}: ${c.detail}`);
      assert.ok(found.some((line) => expected.test(line)), `${label}: ${JSON.stringify(found)}`);
    }
    assert.match(failures({})[0].detail, /not a describe-alarms answer/);
    /* An environment named "staging-x" is listed by the prefix "gs-staging-": its alarms are not this environment's. */
    const neighbour = clone(base);
    neighbour.MetricAlarms.push({ ...alarm(render({ ...SHAPE, environment: "staging-x" }, { page: [], ticket: [] }), "gs-staging-x-a1-unexpected-task-loss") } as never);
    assert.deepEqual(failures(neighbour), []);
  });

  test("a primary-only alarm still watching the OLD primary after a flip fails (never silently attached to the wrong pool)", () => {
    const stale = render({ ...SHAPE, primaryPool: "p1" }, { page: [PAGE], ticket: [TICKET] });
    const found = failures(stale, { primaryPool: "p2" }).map((c) => c.name);
    for (const id of ["a6-relayer-unusable", "a7-escrow-inactive", "a13-primary-heartbeat"]) assert.ok(found.includes(`alarm gs-staging-primary-${id}: definition`), `${id}: ${JSON.stringify(found)}`);
  });

  test("the suppressors: never ALARM outside an open, unexpired window of THEIR pool (an unrelated pool, a closed or expired window, or none, fails)", () => {
    const doc = render(SHAPE, { page: [PAGE], ticket: [TICKET] });
    alarm(doc, "gs-staging-p1-flip-window").StateValue = "ALARM";
    alarm(doc, "gs-staging-p2-flip-window").StateValue = "ALARM";
    const flip = { from: "p1", to: "p2", opened_at: NOW - 10 * 60_000, expires_at: NOW + 35 * 60_000, closed_at: null };
    assert.deepEqual(failures(doc, { flip }), [], "inside the open window: both flip pools may suppress");
    const restored = (over: Partial<AlarmEvidenceExpectation>) => failures(doc, over).map((c) => c.name).sort();
    assert.deepEqual(restored({ flip: null }), ["suppressor gs-staging-p1-flip-window: restored outside a window", "suppressor gs-staging-p2-flip-window: restored outside a window"]);
    assert.equal(restored({ flip: { ...flip, closed_at: NOW - 6 * 60_000 } }).length, 2, "closed (past the evaluation tail)");
    assert.equal(restored({ flip, now: NOW + 41 * 60_000 }).length, 2, "expired (45 minutes, past the tail)");
    assert.deepEqual(restored({ flip: { ...flip, closed_at: NOW - 2 * 60_000 } }), [], "review L4: a few minutes' evaluation tail after a close is not a stuck suppression");
    assert.deepEqual(restored({ flip, now: NOW + 37 * 60_000 }), [], "nor right after the expiry");
    const three = render({ ...SHAPE, pools: ["p1", "p2", "p3"] }, { page: [PAGE], ticket: [TICKET] });
    alarm(three, "gs-staging-p3-flip-window").StateValue = "ALARM";
    assert.deepEqual(
      failures(three, { pools: ["p1", "p2", "p3"], flip }).map((c) => c.name),
      ["suppressor gs-staging-p3-flip-window: restored outside a window"],
      "an unrelated pool is never inside the flip's window",
    );
  });

  test("the game table's TTL: `ttl` enabled passes; off or on another attribute fails; the identity table unchanged; the ledger never", () => {
    const table = (name: string) => ({ TableName: name, TableStatus: "ACTIVE", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" }, DeletionProtectionEnabled: true });
    const ttlCheck = (status: string | null, attribute: string | null, want: string | null) =>
      checkTable("game table", { table: table("gs-staging-game-g1") as never, pitr: { status: "ENABLED" }, ttl: { status, attribute } }, { name: "gs-staging-game-g1", ttlAttribute: want }).find((c) => c.name === "game table: TTL")!.status;
    assert.equal(ttlCheck("ENABLED", "ttl", "ttl"), "pass");
    assert.equal(ttlCheck("DISABLED", null, "ttl"), "fail");
    assert.equal(ttlCheck("ENABLED", "expires", "ttl"), "fail");
    assert.equal(ttlCheck("ENABLED", "ttl", null), "fail", "a table that must have NO TTL (the ledger) with one fails");
    assert.equal(EVIDENCE_FILES.alarms, "alarms.json");
    const commands = fs.readFileSync(path.join(SERVER_SRC, "aws/deploy/commands.ts"), "utf8");
    assert.match(commands, /checkTable\("game table", [^\n]*ttlAttribute: "ttl"/);
    assert.match(commands, /checkTable\("identity table", [^\n]*ttlAttribute: "ttl"/);
    assert.match(commands, /checkTable\("ledger table", [^\n]*ttlAttribute: null/);
    assert.match(commands, /checkTable\(`game table g\$\{other\}`, [^\n]*ttlAttribute: "ttl"/, "every other managed generation too");
  });
});

/* ================================================================== */
describe("L6-5B the planned-flip suppression", () => {
  const OPENED = Date.UTC(2026, 8, 30, 12, 0, 20);
  const span = (over: Partial<{ environment: string; pools: string[]; opened_at: number; expires_at: number }> = {}) => ({ environment: "staging", pools: ["p1", "p2"], opened_at: OPENED, expires_at: OPENED + FLIP_WINDOW_MS, ...over });

  test("open: one 1 per minute per pool, the two flip pools only, from the opening minute to the last minute before expires_at", () => {
    const plan = suppressionDatums(span(), "open", OPENED);
    assert.ok(plan.ok);
    if (!plan.ok) return;
    assert.equal(plan.namespace, "18Cosmos/Operator");
    assert.equal(plan.datums.length, 2 * 46, "45 minutes from a mid-minute opening touch 46 minute buckets");
    assert.ok(plan.datums.every((d) => d.Value === 1 && d.MetricName === "FlipWindowOpen" && d.Timestamp % 60_000 === 0 && d.Timestamp < OPENED + FLIP_WINDOW_MS && d.Timestamp >= OPENED - 60_000));
    assert.deepEqual([...new Set(plan.datums.map((d) => d.Dimensions.map((x) => `${x.Name}=${x.Value}`).join(",")))], ["Environment=staging,Pool=p1", "Environment=staging,Pool=p2"]);
    assert.ok(plan.until !== null && plan.until <= OPENED + FLIP_WINDOW_MS + 60_000);
  });

  test("close: -1 for every remaining minute of THIS window (its +1 cancelled from now on); an expired window needs nothing -- it ended by itself", () => {
    const at = OPENED + 20 * 60_000;
    const plan = suppressionDatums(span(), "close", at);
    assert.ok(plan.ok && plan.datums.length > 0 && plan.datums.every((d) => d.Value === -1 && d.Timestamp >= at - 60_000 && d.Timestamp < OPENED + FLIP_WINDOW_MS));
    const expired = suppressionDatums(span(), "close", OPENED + FLIP_WINDOW_MS);
    assert.ok(expired.ok && expired.datums.length === 0);
    const late = suppressionDatums(span(), "open", OPENED + FLIP_WINDOW_MS + 1);
    assert.ok(late.ok && late.datums.length === 0, "an open after expiry suppresses nothing");
  });

  test("additive (review M5): a flip re-run or a flip back inside the first window keeps its own suppression -- a close ends only its own window", () => {
    const sums = new Map<string, number>();
    const add = (plan: ReturnType<typeof suppressionDatums>) => {
      assert.ok(plan.ok);
      if (plan.ok) for (const d of plan.datums) sums.set(`${d.Dimensions[1].Value}@${d.Timestamp}`, (sums.get(`${d.Dimensions[1].Value}@${d.Timestamp}`) ?? 0) + d.Value);
    };
    const first = span();
    add(suppressionDatums(first, "open", OPENED));
    add(suppressionDatums(first, "close", OPENED + 5 * 60_000)); // its CAS was refused, or the recovery settled
    const second = span({ pools: ["p2", "p1"], opened_at: OPENED + 6 * 60_000, expires_at: OPENED + 6 * 60_000 + FLIP_WINDOW_MS });
    add(suppressionDatums(second, "open", OPENED + 6 * 60_000));
    const minute = (m: number) => Math.floor((OPENED + m * 60_000) / 60_000) * 60_000;
    assert.equal(sums.get(`p1@${minute(2)}`), 1, "the first window, before its close");
    assert.equal(sums.get(`p1@${minute(5)}`), 0, "closed");
    assert.equal(sums.get(`p1@${minute(20)}`), 1, "the second window suppresses although the first one's close covers this minute");
    assert.equal(sums.get(`p2@${minute(40)}`), 1);
    assert.equal(sums.get(`p1@${minute(49)}`), 1, "the second window runs to its own expiry");
    assert.ok([...sums.values()].every((v) => v === 0 || v === 1), "never more than one window's worth, never negative");
  });

  test("never more than the window: > 45 minutes, one pool, the same pool twice, an operator pool, a bad environment, or past CloudWatch's future limit is refused", () => {
    const refused = (s: ReturnType<typeof span>, now = OPENED) => {
      const plan = suppressionDatums(s, "open", now);
      return plan.ok ? null : plan.problem;
    };
    assert.match(refused(span({ expires_at: OPENED + FLIP_WINDOW_MS + 60_000 })) ?? "", /longer than 45 minutes/);
    assert.match(refused(span({ pools: ["p1"] })) ?? "", /exactly the flip's two pools/);
    assert.match(refused(span({ pools: ["p1", "p1"] })) ?? "", /exactly the flip's two pools/);
    assert.match(refused(span({ pools: ["p1", "op:r-0000000000000000"] })) ?? "", /not a serving pool/);
    assert.match(refused(span({ environment: "Prod!" })) ?? "", /environment/);
    assert.match(refused(span(), OPENED - 3 * 60 * 60_000) ?? "", /further ahead than CloudWatch/);
  });

  test("applySuppression: batches of 20; a failing publisher is an outcome, never a throw; none configured is said so", async () => {
    const sent: SuppressionDatum[][] = [];
    const ok: FlipSuppressionPort = { publish: async (_ns, datums) => void sent.push([...datums]) };
    const outcome = await applySuppression(ok, span(), "open", OPENED);
    assert.equal(outcome.outcome, "published");
    assert.ok(sent.every((batch) => batch.length <= 20) && sent.flat().length === 92);
    const failing: FlipSuppressionPort = { publish: async () => Promise.reject(Object.assign(new Error("AccessDenied (injected)"), { name: "AccessDeniedException" })) };
    assert.deepEqual(await applySuppression(failing, span(), "open", OPENED), { outcome: "failed", error_class: "AccessDeniedException" });
    assert.deepEqual(await applySuppression(null, span(), "open", OPENED), { outcome: "not-configured" });
    assert.equal((await applySuppression(ok, span({ pools: ["p1"] }), "open", OPENED)).outcome, "refused");
  });

  test("the CloudWatch publisher writes PutMetricData into 18Cosmos/Operator only (timestamps as dates), and refuses any other namespace before sending", async () => {
    const commands: PutMetricDataCommand[] = [];
    const client = { send: async (command: PutMetricDataCommand) => void commands.push(command) } as never;
    const port = cloudWatchSuppression(client);
    const plan = suppressionDatums(span(), "open", OPENED);
    assert.ok(plan.ok);
    if (!plan.ok) return;
    await port.publish(plan.namespace, plan.datums.slice(0, 3));
    assert.equal(commands.length, 1);
    assert.equal(commands[0].input.Namespace, "18Cosmos/Operator");
    assert.ok(commands[0].input.MetricData?.every((d) => d.Timestamp instanceof Date && d.Value === 1 && d.MetricName === "FlipWindowOpen"));
    await assert.rejects(port.publish("18Cosmos/GameServer", plan.datums.slice(0, 1)), /writes only 18Cosmos\/Operator/);
    assert.equal(commands.length, 1, "nothing sent for another namespace");
  });

  function context(now: number) {
    const audits: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const ctx = { now: () => now, audit: (event: string, fields: Record<string, unknown>) => void audits.push({ event, fields }) } as unknown as MutationContext;
    return { ctx, audits };
  }
  const record = (over: Partial<FlipRecord> = {}): FlipRecord =>
    ({ format: "18COSMOS/FLIP-EVIDENCE/v1", environment: "staging", from: "p1", to: "p2", expected_version: 4, note: "drill", verdict: "flipped", preflight: { at: OPENED, checks: [] }, before: null, cas: null, window: { opened_at: OPENED, expires_at: OPENED + FLIP_WINDOW_MS, closed_at: null }, after: null, observations: [], ...over }) as FlipRecord;

  test("the flip's hook: open publishes the window for the record's two pools and audits it; a failure is audited and never thrown; a rollback's pools are its own; no window, nothing", async () => {
    const sent: SuppressionDatum[] = [];
    const port: FlipSuppressionPort = { publish: async (_ns, d) => void sent.push(...d) };
    const { ctx, audits } = context(OPENED);
    await suppressFlipWindow(port, ctx, record(), "open");
    assert.deepEqual([...new Set(sent.map((d) => d.Dimensions[1].Value))].sort(), ["p1", "p2"]);
    assert.deepEqual(audits.map((a) => [a.event, a.fields.phase, a.fields.outcome]), [["operator.flip-suppression", "open", "published"]]);
    const broken = context(OPENED);
    await suppressFlipWindow({ publish: async () => Promise.reject(new Error("no network")) }, broken.ctx, record(), "open");
    assert.equal(broken.audits[0].fields.outcome, "failed");
    const rollback: SuppressionDatum[] = [];
    await suppressFlipWindow({ publish: async (_ns, d) => void rollback.push(...d) }, context(OPENED).ctx, record({ from: "p2", to: "p1", rollback: true } as Partial<FlipRecord>), "open");
    assert.deepEqual([...new Set(rollback.map((d) => d.Dimensions[1].Value))].sort(), ["p1", "p2"], "a rollback suppresses its own two pools the same way");
    const none = context(OPENED);
    await suppressFlipWindow(port, none.ctx, record({ window: null }), "open");
    assert.deepEqual(none.audits, []);
  });

  test("the recovery's close: the window closed in the record, then 0s published from now for its two pools", async () => {
    const at = OPENED + 25 * 60_000;
    const { ctx, audits } = context(at);
    const closed = closeFlipWindow(ctx, record({ verdict: "roles-settled" }), "the recovery of p1 settled");
    assert.equal(closed.window?.closed_at, at);
    const sent: SuppressionDatum[] = [];
    await suppressFlipWindow({ publish: async (_ns, d) => void sent.push(...d) }, ctx, closed, "close");
    assert.ok(sent.length > 0 && sent.every((d) => d.Value === -1 && d.Timestamp >= at - 60_000));
    assert.deepEqual(audits.map((a) => [a.event, a.fields.phase]), [["operator.flip-window", "closed"], ["operator.flip-suppression", "close"]]);
  });
});

/* ================================================================== */
describe("L6-5B the gates' machine records", () => {
  const passed = [{ name: "x", status: "pass", detail: "ok" }];
  const genRecord = (over: Record<string, unknown> = {}) => ({ format: GENERATION_GATE_FORMAT, environment: "staging", from_generation: 1, verdict: "OPEN", attestation: { generation: 2, game_table: "gs-staging-game-g2", restore_id: "drill-0001" }, adoption_claim: "c", checks: passed, gated_at: "2026-09-30T12:00:00.000Z", ...over });

  test("generation_adoption binds only to the gate's OWN open attestation (owner decision: never a hand-entered replacement)", () => {
    const planned = { generation: 2, game_table: "gs-staging-game-g2", restore_id: "drill-0001" };
    assert.equal(generationAttestationProblem(genRecord(), planned, { environment: "staging" }), null);
    assert.match(generationAttestationProblem(genRecord(), { ...planned, restore_id: "drill-0002" }, { environment: "staging" }) ?? "", /differs .* restore_id/);
    assert.match(generationAttestationProblem(genRecord(), { ...planned, game_table: "gs-staging-game-g3" }, { environment: "staging" }) ?? "", /game_table/);
    assert.match(generationAttestationProblem(genRecord({ verdict: "CLOSED", attestation: null }), planned, { environment: "staging" }) ?? "", /not OPEN/);
    assert.match(generationAttestationProblem(genRecord({ checks: [{ name: "x", status: "fail", detail: "" }] }), planned, { environment: "staging" }) ?? "", /not OPEN/);
    assert.match(generationAttestationProblem(genRecord({ environment: "prod" }), planned, { environment: "staging" }) ?? "", /prod/);
    assert.match(generationAttestationProblem({ ...planned }, planned, { environment: "staging" }) ?? "", /not a generation-gate record/, "the bare value is not the gate's record");
    assert.match(generationAttestationProblem(genRecord(), null, { environment: "staging" }) ?? "", /carries no generation_adoption/);
  });

  test("the rotation gate's record proves an OPEN gate for exactly this from/to, the old queue EMPTY; unknown or closed fails", () => {
    const from = "juno1xc5etfhxjg4qfc9cx25qh3tvxdcf5skjj5epte";
    const to = "juno1wfk5fda0sg5z2lqrpwh7wexnckpe6hqzljkt4v";
    /* LIVE-6 relayer rotation: v2 -- the deployment the rotation must leave untouched, and the contract's operator. */
    const deployment = {
      chain_id: "uni-7",
      contract_address: "juno1qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qursaq28r5",
      code_checksums: ["5ecc302221a2dab4bb4f0f71b632f2beeafe9523ebd7b33bd0e94d017b8d09e8"],
      settlement_key: { signer_key_id: 1, public_key_hex: "03d01115d548e7561b15c38f004d734633687cf4419620095bc5b0f47070afe85a", key_ref: "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222" },
      admission_key: { public_key_hex: "03f28773c2d975288bc7d1d205c3748651b075fbc6610e58cddeeddf8f19405aa8", key_ref: "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333" },
      from_relayer_key_ref: "arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111",
    };
    const rec = (over: Record<string, unknown> = {}) => ({ format: ROTATION_GATE_FORMAT, environment: "staging", from_relayer: from, to_relayer: to, configured_relayer: from, pools: ["p1"], evidence_captured_at: "2026-09-30T11:59:00Z", queue: "empty", verdict: "OPEN", checks: passed, gated_at: "2026-09-30T12:00:00.000Z", deployment, contract_operator: from, ...over });
    const expect = { environment: "staging", from, to };
    assert.equal(rotationGateRecordProblem(rec(), expect), null);
    assert.match(rotationGateRecordProblem(rec({ queue: "unknown", verdict: "CLOSED" }), expect) ?? "", /unknown/);
    assert.match(rotationGateRecordProblem(rec({ queue: "open", verdict: "CLOSED" }), expect) ?? "", /open/);
    assert.match(rotationGateRecordProblem(rec({ verdict: "CLOSED" }), expect) ?? "", /not OPEN/);
    assert.match(rotationGateRecordProblem(rec({ configured_relayer: to }), expect) ?? "", /configuration named/);
    assert.match(rotationGateRecordProblem(rec(), { ...expect, to: from }) ?? "", /gates/);
    assert.match(rotationGateRecordProblem({}, expect) ?? "", /not a relayer-rotation-gate record/);
    /* Review M2: the gate's REAL checks include one reported skipped by name (the new queue is never consulted). */
    const real = [...passed, { name: `RELAYQ#${to}`, status: "skipped", detail: "never consulted" }];
    assert.equal(rotationGateRecordProblem(rec({ checks: real }), expect), null);
    assert.match(rotationGateRecordProblem(rec({ checks: [{ name: `RELAYQ#${to}`, status: "skipped", detail: "" }] }), expect) ?? "", /not OPEN/, "skipped alone proves nothing");
    assert.match(rotationGateRecordProblem(rec({ checks: [...real, { name: "y", status: "fail", detail: "" }] }), expect) ?? "", /not OPEN/);
    /* LIVE-6 relayer rotation: v2 only -- a v1 record (no deployment identity) no longer certifies; the operator at the
       gate is the old or the new relayer; the deployment identity is complete and well-formed. */
    assert.equal(ROTATION_GATE_FORMAT, "18COSMOS/RELAYER-ROTATION-GATE/v2");
    assert.match(rotationGateRecordProblem(rec({ format: "18COSMOS/RELAYER-ROTATION-GATE/v1" }), expect) ?? "", /carries no deployment identity .*run the gate again/);
    assert.equal(rotationGateRecordProblem(rec({ contract_operator: to }), expect), null, "SetOperator already sent before the gate: still a rotation the gate can prove");
    assert.match(rotationGateRecordProblem(rec({ contract_operator: "juno1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" }), expect) ?? "", /neither the old nor the new relayer/);
    assert.match(rotationGateRecordProblem(rec({ contract_operator: null }), expect) ?? "", /neither the old nor the new relayer/, "an unread operator proves nothing");
    assert.match(rotationGateRecordProblem(rec({ deployment: null }), expect) ?? "", /no well-formed deployment identity/);
    assert.match(rotationGateRecordProblem(rec({ deployment: { ...deployment, settlement_key: { ...deployment.settlement_key, public_key_hex: "zz" } } }), expect) ?? "", /no well-formed deployment identity/);
    assert.match(rotationGateRecordProblem(rec({ deployment: { ...deployment, code_checksums: [] } }), expect) ?? "", /no well-formed deployment identity/);
    assert.match(rotationGateRecordProblem(rec({ deployment: { ...deployment, admission_key: undefined } }), expect) ?? "", /no well-formed deployment identity/);
  });

  test("a gate record is created once: an existing file is never overwritten", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l65b-gate-"));
    try {
      const file = path.join(dir, "gate.json");
      writeGateRecord(file, genRecord() as never);
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).format, GENERATION_GATE_FORMAT);
      assert.throws(() => writeGateRecord(file, genRecord({ environment: "prod" }) as never));
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).environment, "staging", "the first record stands");
      assert.deepEqual(fs.readdirSync(dir), ["gate.json"], "no temporary file left behind");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================== */
describe("L6-5B escrow: restoreStatus is a view of the checks' last answers", () => {
  const fin = (world: World) => world.financial.load(GAME_A) as Promise<FinancialGameRecord>;

  test("verified and held are counted as the checks answer; nothing is started or decided by the view; a table that is not restored reports safe_mode false", async () => {
    const world = makeWorld();
    await startedGame(world, GAME_A);
    const session = play(world, GAME_A, 0);
    await world.drive(async () => (await fin(world)).chain.checkpoint_confirmed !== null);
    toStockRound(world, GAME_A, session);
    await world.drive(async () => BigInt((await fin(world)).chain.checkpoint_confirmed?.seq ?? "0") > BigInt(2));
    assert.deepEqual(world.service.restoreStatus(), { safe_mode: false, verified: 0, pending: 0, held: 0 });
    world.restoreSafeMode = true;
    await world.restart();
    assert.deepEqual(world.service.restoreStatus(), { safe_mode: true, verified: 0, pending: 0, held: 0 }, "the view starts no check");
    assert.equal((await world.service.restoreCheck(GAME_A)).kind, "verified");
    assert.deepEqual(world.service.restoreStatus(), { safe_mode: true, verified: 1, pending: 0, held: 0 });
    /* A shorter history: the F1 check holds it journal-ahead -- the escrow service's own `settlement.held` audit, which
       the runtime counts as MoneyHeldJournalAhead. */
    world.logs.set(GAME_A, world.logs.get(GAME_A)!.slice(0, 1));
    await world.restart();
    assert.equal((await world.service.restoreCheck(GAME_A)).kind, "held");
    assert.deepEqual(world.service.restoreStatus(), { safe_mode: true, verified: 0, pending: 0, held: 1 });
    assert.ok(world.ops.lines.some((line) => line.event === "settlement.held" && line.code === "journal-ahead"), "the audit shape the runtime's tap counts");
  });
});

/* ================================================================== */
describe("L6-5B boundaries", () => {
  test("no Logs metric filter anywhere in the IaC (every signal is an EMF metric the task writes itself)", () => {
    const tf = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === ".terraform" ? [] : tf(path.join(dir, e.name))) : e.name.endsWith(".tf") ? [path.join(dir, e.name)] : []));
    const files = tf(path.join(REPO, "infra/aws"));
    assert.ok(files.length > 5);
    for (const file of files) assert.ok(!/aws_cloudwatch_log_metric_filter/.test(fs.readFileSync(file, "utf8")), file);
  });

  test("only TASK# carries `ttl` in the game table: no other game-table writer names the attribute, and TASK#'s TTL outlives a restore drill's stop window", () => {
    /* Classified by the `/`-separated name relative to server/src (LIVE-6 W1: the `/` patterns never matched a Windows
       absolute path, so every exempt file was reported). The exemptions are the same three, exactly. */
    const scanned = sourceFiles(path.join(SERVER_SRC, "aws")).map((file) => ({ file, rel: relativePosix(SERVER_SRC, file) }));
    const namesTtl = (file: string) => /\bttl\b/.test(readCheckoutText(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""));
    const offenders = scanned.filter(({ rel }) => !ttlGuardExempt(rel)).filter(({ file }) => namesTtl(file)).map(({ rel }) => rel);
    assert.deepEqual(offenders, []);
    /* The scan is live: it walked aws/, and the exempt writer it spares really does name the attribute. */
    assert.ok(scanned.length > 20 && scanned.some(({ rel }) => rel === "aws/runtime/taskStatus.ts" && namesTtl(path.join(SERVER_SRC, rel))), "TASK#'s writer names ttl");
    assert.equal(TASK_STATUS_TTL_SECONDS, 86_400);
    assert.ok(TASK_STATUS_TTL_SECONDS * 1000 > 6 * 60 * 60 * 1000, "a fresh old-generation heartbeat is still there for L6-6R's restore-quiet check (6 h window)");
  });

  test("LIVE-6 W1: the TTL guard classifies a Windows walk exactly as a POSIX one (pinned with path.win32)", () => {
    const src = "C:\\Users\\owner\\1830Juno\\server\\src";
    const rel = (file: string) => relativePosix(src, `${src}\\${file}`, path.win32);
    assert.equal(rel("aws\\deploy\\commands.ts"), "aws/deploy/commands.ts");
    for (const exempt of ["aws\\deploy\\commands.ts", "aws\\deploy\\staging\\recovery.ts", "aws\\identity\\identityItems.ts", "aws\\runtime\\taskStatus.ts", "aws\\game\\gameTable.test.ts"]) assert.ok(ttlGuardExempt(rel(exempt)), exempt);
    for (const judged of ["aws\\game\\gameTable.ts", "aws\\runtime\\taskHeartbeats.ts", "aws\\ownership\\poolOwnership.ts", "aws\\runtime\\taskStatus.ts.bak", "aws\\gamedeploy\\x.ts"]) assert.ok(!ttlGuardExempt(rel(judged)), judged);
  });

  test("the serving task never reaches CloudWatch (EMF only); the rotation gate's queue reader stays its own, read-only", () => {
    for (const file of sourceFiles(path.join(SERVER_SRC, "aws/runtime"))) {
      const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // code, not comments
      assert.ok(!/client-cloudwatch|createCloudWatchClient|PutMetricData/.test(code), file);
    }
    const users = sourceFiles(SERVER_SRC).filter((file) => !file.endsWith(".test.ts") && /\brelayQueueState\b/.test(fs.readFileSync(file, "utf8"))).map((file) => path.relative(SERVER_SRC, file).split(path.sep).join("/"));
    /* LIVE-6 relayer rotation: + the staging binding (`tools/awsDeploy.ts`), which hands the SAME reader to the
       post-rotation proof (RELAYQ#<old> still empty after the change). */
    assert.deepEqual(users.sort(), ["aws/deploy/commands.ts", "aws/deploy/relayerRotation.ts", "tools/awsDeploy.ts"]);
    const gate = fs.readFileSync(path.join(SERVER_SRC, "aws/deploy/relayerRotation.ts"), "utf8");
    assert.ok(!/PutItem|UpdateItem|DeleteItem|TransactWrite|BatchWrite/.test(gate), "the gate writes nothing");
    const records = fs.readFileSync(path.join(SERVER_SRC, "aws/deploy/gateRecords.ts"), "utf8");
    assert.ok(!/@aws-sdk|relayQueueState|queryAll/.test(records), "the records module reads no table: it only writes the gate's own verdict");
  });
});
