/* LIVE-6 L6-6 (restore drill tooling): the restore alarms' alarm-pipeline injection -- the probe program over the production
 * encoder and decision metric sets, its overrides and bounds, the precheck, every case derived from AWS captures and never
 * invented, the overlap proven from CloudWatch, the record against the STRENGTHENED judge, and the scripts against a stub
 * AWS CLI. No AWS. */
import { strict as assert } from "assert";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, test } from "node:test";

import { ALARM_CONTRACT } from "../../controlPlane/alarmContract";
import { buildEmfRecord, METRIC_NAMESPACE } from "../../runtime/runtimeMetrics";
import { storageKindOf } from "../../runtime/storageMode";
import { DRILL_FILES, judgeRestoreAlarmDrill, RESTORE_ALARM_CASES } from "./drills";
import { CERTIFIER_STORAGE_OVERRIDE, stableStringify } from "./evidence";
import { precheckRestoreCase, recordRestoreAlarms, stageRestoreCase } from "./restoreAlarmDrill";
import {
  BINDING_MS,
  contractMinDelayMs,
  deriveRestoreCase,
  EXIT_NOT_YET,
  R3_HOLD_MAX_SECONDS,
  R3_HOLD_MIN_SECONDS,
  RESTORE_ALARM_FILES,
  RESTORE_CASE_ALARM,
  RESTORE_CASES,
  RESTORE_PROBE_PROGRAM,
  restoreProbeOverrides,
  type RestoreCase,
} from "./restoreAlarmProbe";
import { alarmName, alarmsDoc, at, cleanup, decisionRecord, ENV, historyDoc, POOLS, read, restoreAlarmDrill, RUN, SCRIPTS, suppressionRecord, suppressor, SUPPRESSORS_ALARM_AT, tempDir, WINDOW, write, writeCase } from "./restoreDrillFixtures.test";

const METRICS_MODULE = path.join(__dirname, "..", "..", "runtime", "runtimeMetrics.js");
const SERVER_ROOT = path.join(__dirname, "..", "..", "..", "..", "..", "..");
const REPO_ROOT = path.join(SERVER_ROOT, "..");
const ctx = (dir: string) => ({ dir, run: RUN, environment: ENV });
const reasons = (v: { kind: string; reasons?: readonly string[] }) => (v.reasons ?? []).join("\n");
const failed = (dir: string, pools: readonly string[] = POOLS) =>
  judgeRestoreAlarmDrill(dir, { run: RUN, environment: ENV, pools })
    .filter((c) => c.status !== "pass")
    .map((c) => `${c.name}: ${c.detail}`)
    .join("\n");

/* ------------------------------------------------------------------ */

describe("restore alarm probe: the program, the production encoder and decisions, and its bounds", () => {
  const runProgram = (env: Record<string, string>, timeout = 20_000) => spawnSync(process.execPath, ["-e", RESTORE_PROBE_PROGRAM], { env: { ...process.env, RA_METRICS_MODULE: METRICS_MODULE, ...env }, encoding: "utf8", timeout });
  const emfOf = (stdout: string) => stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

  test("the overrides run node -e RESTORE_PROBE_PROGRAM with GS_STORAGE = the refusing value (start.ts refuses it); the program reaches nothing but the encoder", () => {
    const o = restoreProbeOverrides({ case: "r1", environment: ENV, pool: "p1", run: RUN }) as any;
    const c = o.containerOverrides[0];
    assert.equal(c.name, "game-server");
    assert.deepEqual(c.command, ["node", "-e", RESTORE_PROBE_PROGRAM]);
    const env = Object.fromEntries(c.environment.map((e: any) => [e.name, e.value]));
    assert.equal(env.GS_STORAGE, CERTIFIER_STORAGE_OVERRIDE);
    assert.equal(storageKindOf([], { GS_STORAGE: env.GS_STORAGE }).ok, false, "a lost command override: start.ts refuses this storage, no game server can start");
    assert.deepEqual([env.RA_CASE, env.RA_ENVIRONMENT, env.RA_POOL, env.RA_RUN], ["r1", ENV, "p1", RUN]);
    assert.ok(!/start\.js|gameServer|awsMain|awsRuntime|dynamo|kms|routing|escrow|ledger|https?:/i.test(RESTORE_PROBE_PROGRAM.replace(/runtimeMetrics\.js/g, "")), "the program reaches nothing but the metrics encoder");
    assert.match(RESTORE_PROBE_PROGRAM, /require\(e\.RA_METRICS_MODULE\|\|'\/app\/server\/dist\/server\/src\/aws\/runtime\/runtimeMetrics\.js'\)/);
  });

  for (const c of ["r1", "a4g", "a4i", "r2"] as const) {
    test(`${c}: ONE record -- the decision's own metric set through the production encoder, under the alarm's dimensions -- then exit 0 (never a loss)`, () => {
      const r = runProgram({ RA_CASE: c, RA_ENVIRONMENT: ENV, RA_POOL: "p1", RA_RUN: RUN });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const lines = emfOf(r.stdout);
      assert.equal(lines.length, 1);
      const line = lines[0];
      assert.deepEqual(line, buildEmfRecord({ environment: ENV, pool: "p1" }, line._aws.Timestamp, decisionRecord(c)) as any, "byte-for-byte what the runtime's decision writes through createEmfSink");
      const spec = ALARM_CONTRACT.alarms.find((a) => a.id === RESTORE_CASE_ALARM[c]);
      assert.ok(spec !== undefined && spec.suppressible === false);
      const metric = String(spec.metrics[0].metric);
      assert.equal(line[metric], 1, `${metric} = 1`);
      const directive = line._aws.CloudWatchMetrics.find((d: any) => d.Metrics.some((m: any) => m.Name === metric));
      assert.equal(directive.Namespace, METRIC_NAMESPACE);
      assert.ok(directive.Dimensions.some((d: string[]) => JSON.stringify(d) === JSON.stringify(ALARM_CONTRACT.dimensions[spec.scope as "environment"])), "the [Environment] series the alarm reads");
      assert.equal(line.why, "l6-6-restore-alarm-drill");
      assert.match(r.stdout, /L6-6-RESTORE-ALARM-PROBE .*"emitted":true,"exit":0/);
    });
  }

  test("r3: RestoreUnverifiedGames = 1 under exactly [Environment, Pool], repeatedly, then a bounded exit 0", () => {
    const r = runProgram({ RA_CASE: "r3", RA_ENVIRONMENT: ENV, RA_POOL: "p2", RA_RUN: RUN, RA_HOLD_SECONDS: "1", RA_TICK_MS: "200" });
    assert.equal(r.status, 0, r.stderr);
    const lines = emfOf(r.stdout);
    assert.ok(lines.length >= 3, `${lines.length} lines`);
    for (const l of lines) {
      assert.deepEqual(l, buildEmfRecord({ environment: ENV, pool: "p2" }, l._aws.Timestamp, decisionRecord("r3")) as any);
      assert.deepEqual(l._aws.CloudWatchMetrics, [{ Namespace: METRIC_NAMESPACE, Dimensions: [["Environment", "Pool"]], Metrics: [{ Name: "RestoreUnverifiedGames", Unit: "Count" }] }]);
    }
    assert.match(r.stdout, /"done":"max-duration"/);
  });

  /* hold-stop's SIGTERM ends it at once (an interrupted run leaves nothing behind it: the task stops). The probe runs only in
   * the Linux game-server image, where ECS delivers a real SIGTERM. On Windows a parent cannot deliver one (Node's kill() is
   * TerminateProcess there: the handler never runs, the exit code is null), so this POSIX-signal case is skipped there, as
   * processLock.test's is. */
  test("r3: SIGTERM (hold-stop) runs the handler and stops it at once: exit 0, \"done\":\"stopped\"", { skip: process.platform === "win32" ? "POSIX signals" : false }, async () => {
    const child = spawn(process.execPath, ["-e", RESTORE_PROBE_PROGRAM], { env: { ...process.env, RA_METRICS_MODULE: METRICS_MODULE, RA_CASE: "r3", RA_ENVIRONMENT: ENV, RA_POOL: "p2", RA_RUN: RUN, RA_HOLD_SECONDS: "60", RA_TICK_MS: "100" } });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const started = Date.now();
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 5000);
    assert.match(out, /"done":"stopped"/);
  });

  test("refusals emit nothing: a bad case, prod, a bad pool or run, an unbounded hold, an image without the decisions' metric sets", () => {
    const base = { RA_CASE: "r3", RA_ENVIRONMENT: ENV, RA_POOL: "p2", RA_RUN: RUN, RA_HOLD_SECONDS: "1", RA_TICK_MS: "200" };
    for (const bad of [{ RA_CASE: "r9" }, { RA_ENVIRONMENT: "prod-1" }, { RA_POOL: "P2" }, { RA_RUN: "x" }, { RA_HOLD_SECONDS: String(R3_HOLD_MAX_SECONDS + 1) }, { RA_TICK_MS: "5" }]) {
      const r = runProgram({ ...base, ...bad });
      assert.equal(r.status, 2, JSON.stringify(bad));
      assert.equal(emfOf(r.stdout).length, 0, "nothing emitted before a refusal");
    }
    const stub = path.join(tempDir("gs-ra-stub-"), "metrics.js");
    fs.writeFileSync(stub, `module.exports = require(${JSON.stringify(METRICS_MODULE)}); module.exports = { createEmfSink: module.exports.createEmfSink };`);
    const old = runProgram({ RA_CASE: "r1", RA_ENVIRONMENT: ENV, RA_POOL: "p1", RA_RUN: RUN, RA_METRICS_MODULE: stub });
    assert.equal(old.status, 2);
    assert.match(old.stdout, /image-predates-the-decision-metric-sets/);
    assert.equal(emfOf(old.stdout).length, 0);
    cleanup(path.dirname(stub));
  });

  test("bounds: R3's hold is 3900..5400 s (more than the real sixty periods, never open-ended); counters take no hold; prod refused", () => {
    const env = (o: any) => Object.fromEntries(o.containerOverrides[0].environment.map((e: any) => [e.name, e.value]));
    assert.equal(env(restoreProbeOverrides({ case: "r3", environment: ENV, pool: "p2", run: RUN })).RA_HOLD_SECONDS, "4500");
    for (const holdSeconds of [R3_HOLD_MIN_SECONDS - 1, R3_HOLD_MAX_SECONDS + 1, 600, 1.5]) assert.throws(() => restoreProbeOverrides({ case: "r3", environment: ENV, pool: "p2", run: RUN, holdSeconds }), /hold-seconds/);
    assert.throws(() => restoreProbeOverrides({ case: "r1", environment: ENV, pool: "p1", run: RUN, holdSeconds: 4000 }), /r3 only/);
    assert.throws(() => restoreProbeOverrides({ case: "r1", environment: "prod", pool: "p1", run: RUN }), /non-prod/);
    assert.ok(R3_HOLD_MIN_SECONDS * 1000 > 60 * 60_000 + 60_000, "the shortest hold outlasts sixty one-minute periods");
  });

  test("R3 keeps the REAL sixty-period contract: the producer reads it from the contract and never shortens it", () => {
    const r3 = ALARM_CONTRACT.alarms.find((a) => a.id === "r3-restore-unverified") as any;
    assert.deepEqual([r3.period, r3.evaluation_periods, r3.datapoints_to_alarm, r3.metrics[0].stat, r3.comparison, r3.threshold, r3.missing, r3.suppressible], [60, 60, 60, "Minimum", "GreaterThanOrEqualToThreshold", 1, "notBreaching", false]);
    assert.equal(contractMinDelayMs("r3"), 59 * 60_000);
    for (const c of ["r1", "a4g", "a4i", "r2"] as const) assert.equal(contractMinDelayMs(c), 0);
    const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "infra/aws/modules/app/alarm-contract.json"), "utf8"));
    assert.deepEqual(contract.alarms.find((a: any) => a.id === "r3-restore-unverified"), r3, "the Terraform contract is the verifier's, unchanged");
  });

  test("the runtime sends each decision through the SAME builders (one copy of each metric set)", () => {
    const runtime = fs.readFileSync(path.join(SERVER_ROOT, "src/aws/runtime/awsRuntime.ts"), "utf8");
    for (const builder of ["taskLostMetrics(cause)", "startupRefusedMetrics(refusal)", "moneyHeldJournalAheadMetrics()", "restoreUnverifiedMetrics("]) assert.ok(runtime.includes(builder), builder);
    assert.ok(!/GenerationLost:\s*1|StartupRefusedGeneration:\s*1|StartupRefusedIdentityRestore:\s*1|MoneyHeldJournalAhead:\s*1|RestoreUnverifiedGames\s*=/.test(runtime), "no second, hand-written copy of a decision's metrics");
  });
});

/* ------------------------------------------------------------------ */

describe("restore alarm producer: every case from AWS captures, never invented", () => {
  test("the whole drill: five cases staged, one overlapping the staging flip-suppression test, recorded and passing the strengthened judge", () => {
    const dir = tempDir("gs-ra-");
    try {
      const { staged, recorded } = restoreAlarmDrill(dir);
      for (const c of RESTORE_CASES) assert.equal(staged[c].kind, "observed", `${c}: ${reasons(staged[c] as any)}`);
      assert.equal(recorded?.kind, "observed", reasons(recorded as any));
      assert.equal(failed(dir), "");
      const rec = read(dir, DRILL_FILES.restoreAlarms);
      assert.deepEqual(Object.keys(rec.cases).sort(), [...RESTORE_ALARM_CASES].sort());
      assert.equal(rec.environment, ENV);
      assert.match(rec.statement, /alarm-pipeline injections/);
      const r1 = rec.cases["r1-generation-lost"];
      assert.equal(r1.injection.kind, "alarm-pipeline-injection");
      assert.equal(r1.injected_at, SCRIPTS.r1.emf[0]);
      assert.equal(r1.alarm_at, at("2026-10-02T02:07:10Z"));
      assert.equal(r1.overlapping_flip_window, null, "never the self-reported field");
      assert.deepEqual(r1.suppression_overlap.pools, ["p1", "p2"]);
      for (const s of r1.suppression_overlap.suppressors) assert.deepEqual([s.pre_state, s.state_at_injection, s.history_alarm_at], ["ALARM", "ALARM", SUPPRESSORS_ALARM_AT]);
      assert.equal(rec.cases["a4g-generation-refused"].suppression_overlap, null);
      const r3 = rec.cases["r3-restore-unverified"];
      assert.equal(r3.alarm, "gs-staging-p2-r3-restore-unverified");
      assert.ok(r3.alarm_at - r3.injected_at >= 59 * 60_000, "R3 fired only after its sixty periods");
      assert.equal(r3.injection.exit_code, null, "the hold was still running at the observation");
    } finally {
      cleanup(dir);
    }
  });

  test("alarm records cannot be finalized without real AWS observations: every capture is required", () => {
    for (const [c, file] of [
      ["r1", RESTORE_ALARM_FILES.raw("r1", "history")],
      ["r1", RESTORE_ALARM_FILES.raw("r1", "alarms")],
      ["a4g", RESTORE_ALARM_FILES.log("a4g")],
      ["a4i", RESTORE_ALARM_FILES.task("a4i")],
      ["r2", RESTORE_ALARM_FILES.raw("r2", "stamp")],
      ["r3", RESTORE_ALARM_FILES.logStream("r3")],
      ["r1", RESTORE_ALARM_FILES.raw("r1", "suppressor-history")],
    ] as Array<[RestoreCase, string]>) {
      const dir = tempDir("gs-ra-");
      try {
        restoreAlarmDrill(dir, { record: false });
        fs.rmSync(path.join(dir, file));
        const v = deriveRestoreCase(ctx(dir), c);
        assert.equal(v.kind, "refused", `${file}: ${v.kind}`);
        assert.equal(recordRestoreAlarms({ ...ctx(dir), pools: [...POOLS] }).kind, "refused");
        assert.equal(fs.existsSync(path.join(dir, DRILL_FILES.restoreAlarms)), false, "nothing written");
      } finally {
        cleanup(dir);
      }
    }
    /* A record typed by hand, with no captures beside it, never passes the judge. */
    const typed = tempDir("gs-ra-");
    const source = tempDir("gs-ra-");
    try {
      restoreAlarmDrill(source);
      write(typed, DRILL_FILES.restoreAlarms, read(source, DRILL_FILES.restoreAlarms));
      assert.match(failed(typed), /is what AWS answered .*the captures do not show it/);
    } finally {
      cleanup(typed);
      cleanup(source);
    }
    /* No launch record: the precheck is the only way into a case. */
    const dir = tempDir("gs-ra-");
    try {
      restoreAlarmDrill(dir, { record: false });
      fs.rmSync(path.join(dir, RESTORE_ALARM_FILES.launch("a4i")));
      assert.match(reasons(deriveRestoreCase(ctx(dir), "a4i") as any), /precheck writes it/);
    } finally {
      cleanup(dir);
    }
  });

  test("wrong alarm names fail: another alarm's history, another pool's R3, a renamed record", () => {
    const dir = tempDir("gs-ra-");
    try {
      restoreAlarmDrill(dir);
      const rec = read(dir, DRILL_FILES.restoreAlarms);
      for (const [id, name] of [
        ["r1-generation-lost", "gs-staging-r2-money-journal-ahead"],
        ["r3-restore-unverified", "gs-staging-p9-r3-restore-unverified"],
        ["a4g-generation-refused", "gs-prod-a4g-generation-refused"],
      ]) {
        write(dir, DRILL_FILES.restoreAlarms, { ...rec, cases: { ...rec.cases, [id]: { ...rec.cases[id], alarm: name } } });
        assert.match(failed(dir), new RegExp(`${id} fires`), `${id} as ${name}`);
      }
      write(dir, DRILL_FILES.restoreAlarms, rec);
      assert.equal(failed(dir), "");
      /* The alarm's history answered for another alarm only: nothing for this one, so no transition is invented. */
      write(dir, RESTORE_ALARM_FILES.raw("a4i", "history"), historyDoc("gs-staging-a4g-generation-refused", [{ at: at("2026-10-02T02:24:00Z"), to: "ALARM" }]));
      const v = deriveRestoreCase(ctx(dir), "a4i");
      assert.notEqual(v.kind, "observed");
    } finally {
      cleanup(dir);
    }
  });

  test("a transition before the injection fails; so does one earlier than the contract allows, or later than the binding", () => {
    const cases: Array<[RestoreCase, ReadonlyArray<{ at: number; to: string; from?: string }>, string, RegExp]> = [
      ["r1", [{ at: at("2026-10-02T02:04:00Z"), to: "ALARM" }], "refused", /before the injection, and had not left it/],
      ["a4g", [{ at: at("2026-10-02T02:10:00Z"), to: "ALARM" }, { at: at("2026-10-02T02:17:00Z"), to: "ALARM", from: "ALARM" }], "refused", /before the injection/],
      ["r3", [{ at: SCRIPTS.r3.emf[0] + 30 * 60_000, to: "ALARM" }], "refused", /before the contract's 60 period\(s\)/],
      ["r2", [{ at: SCRIPTS.r2.emf[0] + BINDING_MS + 60_000, to: "ALARM" }], "refused", /not bound to it/],
    ];
    for (const [c, history, kind, why] of cases) {
      const dir = tempDir("gs-ra-");
      try {
        restoreAlarmDrill(dir, { record: false, bends: { [c]: { history: historyDoc(alarmName(c, SCRIPTS[c].pool), history) } } });
        const v = deriveRestoreCase(ctx(dir), c);
        assert.equal(v.kind, kind, `${c}: ${reasons(v as any)}`);
        assert.match(reasons(v as any), why);
      } finally {
        cleanup(dir);
      }
    }
    /* Already ALARM in the capture before the injection. */
    const dir = tempDir("gs-ra-");
    try {
      write(dir, RESTORE_ALARM_FILES.suppression, suppressionRecord({ closed: null }));
      writeCase(dir, SCRIPTS.a4g);
      write(dir, RESTORE_ALARM_FILES.raw("a4g", "pre-alarms"), alarmsDoc({ [alarmName("a4g", "p1")]: "ALARM" }));
      assert.match(reasons(deriveRestoreCase(ctx(dir), "a4g") as any), /already ALARM before the injection/);
      /* None yet: NOT YET while the binding is open; REFUSED once it has passed. */
      writeCase(dir, SCRIPTS.r2, { history: historyDoc(alarmName("r2", "p1"), []) });
      assert.equal(deriveRestoreCase(ctx(dir), "r2").kind, "not-yet");
      write(dir, RESTORE_ALARM_FILES.raw("r2", "stamp"), { captured_from: SCRIPTS.r2.emf[0] + BINDING_MS + 60_000, captured_to: SCRIPTS.r2.emf[0] + BINDING_MS + 62_000 });
      assert.match(reasons(deriveRestoreCase(ctx(dir), "r2") as any), /is not bound to any transition/);
      /* The judge, given a record whose alarm_at precedes its injection, fails it. */
      const full = tempDir("gs-ra-");
      try {
        restoreAlarmDrill(full);
        const rec = read(full, DRILL_FILES.restoreAlarms);
        const r1 = rec.cases["r1-generation-lost"];
        write(full, DRILL_FILES.restoreAlarms, { ...rec, cases: { ...rec.cases, "r1-generation-lost": { ...r1, alarm_at: r1.injected_at - 1 } } });
        assert.match(failed(full), /r1-generation-lost fires/);
        const r3 = rec.cases["r3-restore-unverified"];
        write(full, DRILL_FILES.restoreAlarms, { ...rec, cases: { ...rec.cases, "r3-restore-unverified": { ...r3, alarm_at: r3.injected_at + 10 * 60_000 } } });
        assert.match(failed(full), /r3-restore-unverified fires/, "the judge enforces the sixty-period contract too");
      } finally {
        cleanup(full);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("suppressed = true fails for EVERY restore alarm: actions disabled, a composite with an actions suppressor, a record claiming it", () => {
    for (const c of RESTORE_CASES) {
      const name = alarmName(c, SCRIPTS[c].pool);
      for (const postAlarms of [alarmsDoc({}, { metric: { [name]: { ActionsEnabled: false } } }), alarmsDoc({}, { composites: [{ AlarmName: `${name}-notify`, StateValue: "OK", ActionsEnabled: true, ActionsSuppressor: suppressor("p1"), AlarmRule: `ALARM("${name}")` }] })]) {
        const dir = tempDir("gs-ra-");
        try {
          restoreAlarmDrill(dir, { record: false, bends: { [c]: { postAlarms } } });
          assert.match(reasons(deriveRestoreCase(ctx(dir), c) as any), /actions are suppressed/, c);
        } finally {
          cleanup(dir);
        }
      }
    }
    const dir = tempDir("gs-ra-");
    try {
      restoreAlarmDrill(dir);
      const rec = read(dir, DRILL_FILES.restoreAlarms);
      for (const id of RESTORE_ALARM_CASES) {
        write(dir, DRILL_FILES.restoreAlarms, { ...rec, cases: { ...rec.cases, [id]: { ...rec.cases[id], actions_suppressed: true } } });
        assert.match(failed(dir), new RegExp(`${id} fires under its injected condition`), id);
      }
    } finally {
      cleanup(dir);
    }
  });

  test("an overlap cannot be claimed without CloudWatch showing BOTH suppressors ALARM at the injection", () => {
    const refusals: Array<[string, Parameters<typeof restoreAlarmDrill>[1], RegExp]> = [
      ["a suppressor's last change before the injection was to OK", { bends: { r1: { supHistory: { p1: historyDoc(suppressor("p1"), [{ at: SUPPRESSORS_ALARM_AT, to: "ALARM" }, { at: at("2026-10-02T02:05:20Z"), to: "OK", from: "ALARM" }]), p2: historyDoc(suppressor("p2"), [{ at: SUPPRESSORS_ALARM_AT, to: "ALARM" }]) } } }, record: false }, /was not ALARM at the injection/],
      ["a suppressor that never went to ALARM", { bends: { r1: { supHistory: { p1: historyDoc(suppressor("p1"), []), p2: historyDoc(suppressor("p2"), [{ at: SUPPRESSORS_ALARM_AT, to: "ALARM" }]) } } }, record: false }, /none: it was not ALARM/],
      ["ALARM from an earlier window, not this test's", { bends: { r1: { supHistory: Object.fromEntries(POOLS.map((p) => [p, historyDoc(suppressor(p), [{ at: at("2026-10-02T01:20:00Z"), to: "ALARM" }])])) } }, record: false }, /before this test's window opened/],
      ["the suppressor history read only in part", { bends: { r1: { supHistory: { p1: historyDoc(suppressor("p1"), [{ at: SUPPRESSORS_ALARM_AT, to: "ALARM" }], { NextToken: "more" }), p2: historyDoc(suppressor("p2"), [{ at: SUPPRESSORS_ALARM_AT, to: "ALARM" }]) } } }, record: false }, /one page of several/],
    ];
    for (const [label, options, why] of refusals) {
      const dir = tempDir("gs-ra-");
      try {
        restoreAlarmDrill(dir, options);
        const v = deriveRestoreCase(ctx(dir), "r1");
        assert.equal(v.kind, "refused", label);
        assert.match(reasons(v as any), why, label);
      } finally {
        cleanup(dir);
      }
    }
    /* A suppressor not ALARM in the capture taken right before the injection: the precheck starts nothing (NOT YET). */
    const dir = tempDir("gs-ra-");
    try {
      write(dir, RESTORE_ALARM_FILES.suppression, suppressionRecord({ closed: null }));
      const w = writeCase(dir, SCRIPTS.r1, { preStates: { [suppressor("p2")]: "OK" } });
      assert.equal(w.precheck.kind, "not-yet");
      assert.match(reasons(w.precheck as any), /suppressors not ALARM yet: gs-staging-p2-flip-window OK/);
      assert.equal(fs.existsSync(path.join(dir, RESTORE_ALARM_FILES.launch("r1"))), false, "no launch record: the script starts no task");
      /* ... and a launch forged with overlap, over that capture, never derives. */
      write(dir, RESTORE_ALARM_FILES.launch("r1"), { format: "18COSMOS/L6-6-RESTORE-ALARM-LAUNCH/v1", run_id: RUN, environment: ENV, case: "r1", alarm: alarmName("r1", "p1"), pool: "p1", overlap: true, prechecked_at: SCRIPTS.r1.pre + 5000, pre: { captured_from: SCRIPTS.r1.pre, captured_to: SCRIPTS.r1.pre + 2000, alarm_state: "OK", suppressors: { p1: "ALARM", p2: "ALARM" } } });
      assert.match(reasons(deriveRestoreCase(ctx(dir), "r1") as any), /gs-staging-p2-flip-window was OK just before the injection/);
    } finally {
      cleanup(dir);
    }
  });

  test("a fake / self-reported window alone fails: overlapping_flip_window is never evidence, a typed suppression_overlap never re-derives, no overlap at all fails", () => {
    const dir = tempDir("gs-ra-");
    try {
      restoreAlarmDrill(dir);
      const rec = read(dir, DRILL_FILES.restoreAlarms);
      const r1 = rec.cases["r1-generation-lost"];
      const a4g = rec.cases["a4g-generation-refused"];
      const selfReported = { from: "p1", to: "p2", opened_at: WINDOW.opened_at, expires_at: WINDOW.expires_at };
      /* The pre-strengthening shape: a window that "covers" the injection, and no suppressor observation. */
      write(dir, DRILL_FILES.restoreAlarms, { ...rec, cases: { ...rec.cases, "r1-generation-lost": { ...r1, suppression_overlap: null, overlapping_flip_window: selfReported } } });
      const text = failed(dir);
      assert.match(text, /self-reported overlapping_flip_window is never evidence/);
      assert.match(text, /never suppressed while the planned-flip suppression was genuinely active/);
      /* A typed suppressor proof on a case whose captures show none. */
      write(dir, DRILL_FILES.restoreAlarms, { ...rec, cases: { ...rec.cases, "a4g-generation-refused": { ...a4g, suppression_overlap: { ...r1.suppression_overlap } } } });
      assert.match(failed(dir), /a4g-generation-refused is what AWS answered/);
      write(dir, DRILL_FILES.restoreAlarms, rec);
      assert.equal(failed(dir), "");
    } finally {
      cleanup(dir);
    }
    /* No case inside the overlap test: the producer refuses, and so would the judge. */
    const none = tempDir("gs-ra-");
    try {
      write(none, RESTORE_ALARM_FILES.suppression, suppressionRecord());
      for (const c of RESTORE_CASES) writeCase(none, { ...SCRIPTS[c], overlap: false });
      for (const c of RESTORE_CASES) assert.equal(stageRestoreCase(ctx(none), c).kind, "observed", c);
      assert.match(reasons(recordRestoreAlarms({ ...ctx(none), pools: [...POOLS] }) as any), /no case was injected inside the staging flip-suppression overlap test/);
    } finally {
      cleanup(none);
    }
  });

  test("the overlap test must have moved no routing (read at its open and its close) -- and must be closed", () => {
    for (const [suppression, why] of [
      [{ closed: null }, /was not closed/],
      [{ closed: { at: at("2026-10-02T02:40:00Z"), outcome: "published", routing_after: { primary_pool: "p2", routing_version: 6 }, detail: null } }, /is not the routing read at the open/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const dir = tempDir("gs-ra-");
      try {
        const { recorded } = restoreAlarmDrill(dir, { suppression });
        assert.equal(recorded?.kind, "refused");
        assert.match(reasons(recorded as any), why);
      } finally {
        cleanup(dir);
      }
    }
  });

  test("precheck: pools of this deployment only; no overlap for R3; the window must have time left; an earlier attempt is moved aside, never deleted", () => {
    const dir = tempDir("gs-ra-");
    try {
      write(dir, RESTORE_ALARM_FILES.suppression, suppressionRecord({ closed: null }));
      write(dir, RESTORE_ALARM_FILES.raw("r1", "pre-alarms"), alarmsDoc({ [suppressor("p1")]: "ALARM", [suppressor("p2")]: "ALARM" }));
      write(dir, RESTORE_ALARM_FILES.raw("r1", "pre-stamp"), { captured_from: SCRIPTS.r1.pre, captured_to: SCRIPTS.r1.pre + 2000 });
      const pc = (input: Partial<Parameters<typeof precheckRestoreCase>[1]>, pools: readonly string[] = POOLS) => precheckRestoreCase({ ...ctx(dir), pools }, { case: "r1", pool: "p1", overlap: true, now: SCRIPTS.r1.pre + 5000, ...input });
      assert.match(reasons(pc({ pool: "p9" }) as any), /not one of the deployment's pools/);
      assert.match(reasons(pc({}, ["p1"]) as any), /names pools outside the deployment: p2/);
      assert.match(reasons(pc({ case: "r3" }) as any), /R3's hold lasts more than an hour/);
      write(dir, RESTORE_ALARM_FILES.raw("r1", "pre-stamp"), { captured_from: WINDOW.expires_at - 64_000, captured_to: WINDOW.expires_at - 62_000 });
      assert.match(reasons(pc({ now: WINDOW.expires_at - 60_000 }) as any), /less than 5 min are left/);
      write(dir, RESTORE_ALARM_FILES.raw("r1", "pre-stamp"), { captured_from: SCRIPTS.r1.pre, captured_to: SCRIPTS.r1.pre + 2000 });
      assert.match(reasons(pc({ now: SCRIPTS.r1.pre + 10 * 60_000 }) as any), /capture it again/);
      assert.match(reasons(precheckRestoreCase({ ...ctx(dir), environment: "prod", pools: POOLS }, { case: "r1", pool: "p1", overlap: true, now: SCRIPTS.r1.pre + 5000 }) as any), /never runs in a prod/);
      assert.equal(pc({}).kind, "observed");
      write(dir, RESTORE_ALARM_FILES.task("r1"), { tasks: [] });
      assert.equal(pc({}).kind, "observed");
      const moved = fs.readdirSync(path.join(dir, "restore-alarms/superseded"));
      assert.equal(moved.length, 1);
      assert.deepEqual(fs.readdirSync(path.join(dir, "restore-alarms/superseded", moved[0])).sort(), ["r1-launch.json", "r1-task.json"]);
    } finally {
      cleanup(dir);
    }
  });

  test("the record re-derives every case: a capture changed after staging is refused (observe again)", () => {
    const dir = tempDir("gs-ra-");
    try {
      restoreAlarmDrill(dir, { record: false });
      write(dir, RESTORE_ALARM_FILES.raw("a4i", "history"), historyDoc(alarmName("a4i", "p2"), [{ at: at("2026-10-02T02:25:00Z"), to: "ALARM" }]));
      assert.match(reasons(recordRestoreAlarms({ ...ctx(dir), pools: [...POOLS] }) as any), /a4i's captures changed since it was staged/);
      assert.equal(stageRestoreCase(ctx(dir), "a4i").kind, "observed");
      assert.equal(recordRestoreAlarms({ ...ctx(dir), pools: [...POOLS] }).kind, "observed");
      assert.equal(stableStringify(read(dir, DRILL_FILES.restoreAlarms).cases["a4i-identity-restore-refused"].alarm_at), stableStringify(at("2026-10-02T02:25:00Z")));
    } finally {
      cleanup(dir);
    }
  });

  test("the probe task must be the drill's own standalone program: a service task, another command, a lost GS_STORAGE, a real exit 3 are refused", () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ group: "service:gs-staging-p1" }, /belongs to a service/],
      [{ startedBy: "ecs-svc/1" }, /started by/],
      [{ overrides: { containerOverrides: [{ name: "game-server", command: ["node", "dist/server/src/start.js"] }] } }, /does not run the drill's program/],
      [{ overrides: { containerOverrides: [{ name: "game-server", command: ["node", "-e", RESTORE_PROBE_PROGRAM], environment: [{ name: "GS_STORAGE", value: "aws" }, { name: "RA_CASE", value: "a4g" }] }] } }, /GS_STORAGE/],
      [{ containers: [{ name: "game-server", exitCode: 3 }] }, /never a real loss/],
    ];
    for (const [task, why] of bad) {
      const dir = tempDir("gs-ra-");
      try {
        restoreAlarmDrill(dir, { record: false, bends: { a4g: { task } } });
        assert.match(reasons(deriveRestoreCase(ctx(dir), "a4g") as any), why);
      } finally {
        cleanup(dir);
      }
    }
    /* Its log must carry exactly the one injected record, from the production encoder, of the case's metric. */
    const dir = tempDir("gs-ra-");
    try {
      restoreAlarmDrill(dir, { record: false, bends: { r2: { log: { events: [{ message: JSON.stringify(buildEmfRecord({ environment: ENV, pool: "p1" }, SCRIPTS.r2.emf[0], { event: "money-held", metrics: { MoneySweepPassFailed: 1 } })) }] } } } });
      assert.match(reasons(deriveRestoreCase(ctx(dir), "r2") as any), /holds no EMF record of MoneyHeldJournalAhead/);
    } finally {
      cleanup(dir);
    }
  });
});

describe("stage-probe restore-alarms: the command's exits (0 done, 10 not yet, 1 refused) and its usage", () => {
  const { stageProbeCommand } = require("./commands") as typeof import("./commands");
  const call = async (argv: string[], now = Date.now()) => {
    const out: string[] = [];
    const code = await stageProbeCommand(["restore-alarms", ...argv], { now: () => now, out: (l: string) => out.push(l) } as never, {} as never);
    return { code, out: out.join("\n") };
  };
  test("record / observe / precheck / overrides", async () => {
    const dir = tempDir("gs-ra-cli-");
    try {
      restoreAlarmDrill(dir, { record: false });
      const rec = await call(["record", "--run-id", RUN, "--evidence", dir, "--environment", ENV, "--pools", "p1,p2"]);
      assert.equal(rec.code, 0, rec.out);
      assert.match(rec.out, /^RECORDED: /);
      const obs = await call(["observe", "--run-id", RUN, "--evidence", dir, "--environment", ENV, "--case", "a4g"]);
      assert.equal(obs.code, 0, obs.out);
      fs.rmSync(path.join(dir, RESTORE_ALARM_FILES.raw("a4g", "history")));
      const gone = await call(["observe", "--run-id", RUN, "--evidence", dir, "--environment", ENV, "--case", "a4g"]);
      assert.equal(gone.code, 1);
      assert.match(gone.out, /^REFUSED: /);
      write(dir, RESTORE_ALARM_FILES.raw("r2", "pre-alarms"), alarmsDoc({ [alarmName("r2", "p1")]: "ALARM" }));
      write(dir, RESTORE_ALARM_FILES.raw("r2", "pre-stamp"), { captured_from: Date.now() - 3000, captured_to: Date.now() - 1000 });
      const pc = await call(["precheck", "--run-id", RUN, "--evidence", dir, "--environment", ENV, "--pools", "p1,p2", "--case", "r2", "--pool", "p1"]);
      assert.equal(pc.code, EXIT_NOT_YET, pc.out);
      const o = await call(["overrides", "--case", "r3", "--environment", ENV, "--pool", "p2", "--run-id", RUN, "--hold-seconds", "4000"]);
      assert.equal(o.code, 0);
      assert.equal(JSON.parse(o.out).containerOverrides[0].command[2], RESTORE_PROBE_PROGRAM);
      await assert.rejects(call(["overrides", "--case", "r3", "--environment", ENV, "--pool", "p2", "--run-id", RUN, "--hold-seconds", "60"]), /hold-seconds/);
      await assert.rejects(call(["observe", "--run-id", RUN, "--evidence", dir, "--environment", ENV, "--case", "r9"]), /--case is/);
      await assert.rejects(call(["flip"]), /overrides \| precheck \| observe \| record/);
    } finally {
      cleanup(dir);
    }
  });
});

/* ------------------------------------------------------------------ */
/* run-restore-alarm-probe.{sh,ps1} against a stub AWS CLI               */
/* ------------------------------------------------------------------ */

const PWSH = (() => {
  for (const c of process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"]) if (spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8", timeout: 60_000 }).status === 0) return c;
  return null;
})();
const BASH = process.platform === "win32" ? null : spawnSync("bash", ["-c", "exit 0"]).status === 0 ? "bash" : null;

/** A stub `aws`: answers from a scenario file, logs every call. `ecs run-task` answers a fixed task ARN. */
export const STUB = String.raw`
const fs = require("fs");
const argv = process.argv.slice(2);
const sc = JSON.parse(fs.readFileSync(process.env.STUB_SCENARIO, "utf8"));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(argv) + "\n");
const i = argv.findIndex((a) => ["ecs", "cloudwatch", "logs"].includes(a));
const op = argv.slice(i, i + 2).join(" ");
const flag = (n) => argv[argv.indexOf(n) + 1];
const answer = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
if (op === "cloudwatch describe-alarms") answer(sc.alarms);
else if (op === "cloudwatch describe-alarm-history") answer((sc.history || {})[flag("--alarm-name")] || { AlarmHistoryItems: [] });
else if (op === "ecs describe-services") answer({ services: [{ taskDefinition: sc.taskDefinition, networkConfiguration: { awsvpcConfiguration: { subnets: ["subnet-1"], securityGroups: ["sg-1"] } } }] });
else if (op === "ecs describe-task-definition") answer({ taskDefinition: { containerDefinitions: [{ name: "game-server", logConfiguration: { options: { "awslogs-group": "/gs/staging/game-server", "awslogs-stream-prefix": "gs" } } }] } });
else if (op === "ecs run-task") answer(sc.taskArn + "\n");
else if (op === "ecs wait") process.exit(0);
else if (op === "ecs describe-tasks") answer(sc.tasks);
else if (op === "ecs stop-task") answer(sc.taskArn + "\n");
else if (op === "logs get-log-events") answer(sc.log);
else { process.stderr.write("stub: unexpected " + op + "\n"); process.exit(254); }
`;

function stubBin(scenario: Record<string, unknown>): { readonly bin: string; readonly env: NodeJS.ProcessEnv; readonly calls: () => string[][] } {
  const bin = tempDir("gs-ra-bin-");
  fs.writeFileSync(path.join(bin, "aws-stub.js"), STUB);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "aws.cmd"), `@"${process.execPath}" "%~dp0aws-stub.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
  else fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "aws-stub.js")}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "scenario.json"), JSON.stringify(scenario));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, STUB_SCENARIO: path.join(bin, "scenario.json"), STUB_LOG: path.join(bin, "calls.log") };
  return { bin, env, calls: () => (fs.existsSync(env.STUB_LOG) ? fs.readFileSync(env.STUB_LOG, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as string[]) : []) };
}

const opsOf = (calls: string[][]) => calls.map((c) => {
  const i = c.findIndex((a) => ["ecs", "cloudwatch", "logs"].includes(a));
  return c.slice(i, i + 2).join(" ");
});

for (const shell of ["sh", "ps1"] as const) {
  describe(`run-restore-alarm-probe.${shell} (stub AWS CLI; no AWS)`, () => {
    const skip = shell === "ps1" ? (PWSH === null ? "PowerShell is not available here" : false) : BASH === null ? "bash is not available here" : false;
    function run(args: { mode: string; caseId?: string; pool?: string; overlap?: boolean; pools?: string; timeout?: number; hold?: number }, dir: string, scenario: Record<string, unknown>) {
      const stub = stubBin(scenario);
      const script = path.join(REPO_ROOT, "infra", "aws", "scripts", `run-restore-alarm-probe.${shell}`);
      const r =
        shell === "ps1"
          ? spawnSync(PWSH as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", args.mode, "-Environment", ENV, "-Region", "us-east-1", "-Run", RUN, "-Out", dir, ...(args.caseId === undefined ? [] : ["-Case", args.caseId]), ...(args.pool === undefined ? [] : ["-Pool", args.pool]), ...(args.pools === undefined ? [] : ["-Pools", args.pools]), ...(args.overlap === true ? ["-Overlap"] : []), ...(args.timeout === undefined ? [] : ["-TimeoutSeconds", String(args.timeout)]), ...(args.hold === undefined ? [] : ["-HoldSeconds", String(args.hold)])], { env: stub.env, encoding: "utf8", timeout: 300_000 })
          : spawnSync(
              "bash",
              [
                script,
                args.mode,
                ENV,
                "us-east-1",
                RUN,
                dir,
                ...(args.mode === "inject"
                  ? [args.caseId as string, args.pool as string, args.pools as string, args.overlap === true ? "overlap" : "no-overlap", ...(args.timeout === undefined ? [] : [String(args.timeout)])]
                  : args.mode === "hold-start"
                    ? [args.caseId as string, args.pool as string, args.pools as string, String(args.hold ?? 4500), ...(args.timeout === undefined ? [] : [String(args.timeout)])]
                    : args.mode === "observe"
                      ? [args.caseId as string, ...(args.timeout === undefined ? [] : [String(args.timeout)])]
                      : []),
              ],
              { env: stub.env, encoding: "utf8", timeout: 300_000 },
            );
      const calls = stub.calls();
      cleanup(stub.bin);
      return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
    }

    test("inject: the precheck refuses (alarm ALARM, an overlap without suppressors) -> NO run-task at all", { skip }, () => {
      const dir = tempDir("gs-ra-sh-");
      try {
        const r = run({ mode: "inject", caseId: "a4g", pool: "p1", pools: "p1,p2", timeout: 1 }, dir, { alarms: alarmsDoc({ [alarmName("a4g", "p1")]: "ALARM" }) });
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /NOT YET/);
        assert.ok(!opsOf(r.calls).includes("ecs run-task"), JSON.stringify(opsOf(r.calls)));
        const o = run({ mode: "inject", caseId: "r1", pool: "p1", pools: "p1,p2", overlap: true, timeout: 1 }, dir, { alarms: alarmsDoc() });
        assert.notEqual(o.status, 0);
        assert.match(o.out, /REFUSED[\s\S]*suppression-overlap/);
        assert.ok(!opsOf(o.calls).includes("ecs run-task"));
      } finally {
        cleanup(dir);
      }
    });

    test("inject: pre-capture, precheck, then ONE standalone run-task of the pool's definition with the drill's overrides; the task, its log captured", { skip }, () => {
      const dir = tempDir("gs-ra-sh-");
      try {
        const task = { tasks: [{ taskArn: "arn:aws:ecs:us-east-1:111111111111:task/gs-staging/a4ga0000000000000000000000000000", startedBy: "l6-6-restore-alarm-a4g" }] };
        const r = run({ mode: "inject", caseId: "a4g", pool: "p1", pools: "p1,p2" }, dir, { alarms: alarmsDoc(), taskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:7", taskArn: task.tasks[0].taskArn, tasks: task, log: { events: [{ message: "x" }] } });
        assert.equal(r.status, 0, r.out);
        assert.deepEqual(opsOf(r.calls), ["cloudwatch describe-alarms", "ecs describe-services", "ecs describe-task-definition", "ecs run-task", "ecs wait", "ecs describe-tasks", "logs get-log-events"]);
        const runTask = r.calls.find((c) => c.includes("run-task")) as string[];
        assert.equal(runTask[runTask.indexOf("--started-by") + 1], "l6-6-restore-alarm-a4g");
        assert.equal(runTask[runTask.indexOf("--task-definition") + 1], "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:7");
        assert.ok(!runTask.includes("--enable-execute-command") && !runTask.some((a) => a.startsWith("service")), "standalone");
        for (const f of [RESTORE_ALARM_FILES.launch("a4g"), RESTORE_ALARM_FILES.raw("a4g", "pre-alarms"), RESTORE_ALARM_FILES.raw("a4g", "pre-stamp"), RESTORE_ALARM_FILES.task("a4g"), RESTORE_ALARM_FILES.log("a4g"), RESTORE_ALARM_FILES.logStream("a4g")]) assert.ok(fs.existsSync(path.join(dir, f)), f);
        assert.equal(read(dir, RESTORE_ALARM_FILES.logStream("a4g")).log_stream, "gs/game-server/a4ga0000000000000000000000000000");
        const stamp = read(dir, RESTORE_ALARM_FILES.raw("a4g", "pre-stamp"));
        assert.ok(stamp.captured_to >= stamp.captured_from && stamp.captured_from > at("2026-10-01T00:00:00Z"), "a machine stamp");
      } finally {
        cleanup(dir);
      }
    });

    test("observe: describe-alarms + the case's history (+ both suppressors' with an overlap) under a machine stamp; stages the case; NOT YET polls to its bound", { skip }, () => {
      const dir = tempDir("gs-ra-sh-");
      try {
        restoreAlarmDrill(dir, { record: false });
        for (const f of [RESTORE_ALARM_FILES.raw("r1", "alarms"), RESTORE_ALARM_FILES.raw("r1", "history"), RESTORE_ALARM_FILES.raw("r1", "suppressor-history"), RESTORE_ALARM_FILES.raw("r1", "stamp"), RESTORE_ALARM_FILES.observation("r1")]) fs.rmSync(path.join(dir, f));
        const history = { [alarmName("r1", "p1")]: historyDoc(alarmName("r1", "p1"), SCRIPTS.r1.history), [suppressor("p1")]: historyDoc(suppressor("p1"), [{ at: SUPPRESSORS_ALARM_AT, to: "ALARM" }]), [suppressor("p2")]: historyDoc(suppressor("p2"), [{ at: SUPPRESSORS_ALARM_AT, to: "ALARM" }]) };
        const r = run({ mode: "observe", caseId: "r1", timeout: 30 }, dir, { alarms: alarmsDoc(), history });
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /OBSERVED/);
        assert.deepEqual(opsOf(r.calls), ["cloudwatch describe-alarms", "cloudwatch describe-alarm-history", "cloudwatch describe-alarm-history", "cloudwatch describe-alarm-history"]);
        assert.deepEqual(r.calls.filter((c) => c.includes("describe-alarm-history")).map((c) => c[c.indexOf("--alarm-name") + 1]), [alarmName("r1", "p1"), suppressor("p1"), suppressor("p2")]);
        assert.equal(read(dir, RESTORE_ALARM_FILES.observation("r1")).observation.suppression_overlap.pools.join(), "p1,p2");
        /* A fresh injection (relative to this machine's clock, which stamps the captures): still inside its binding. */
        const now = Date.now();
        writeCase(dir, { ...SCRIPTS.a4g, pre: now - 120_000, emf: [now - 60_000], started: now - 65_000, stopped: now - 55_000, history: [], post: now });
        const waiting = run({ mode: "observe", caseId: "a4g", timeout: 1 }, dir, { alarms: alarmsDoc(), history: {} });
        assert.notEqual(waiting.status, 0);
        assert.match(waiting.out, /NOT YET[\s\S]*not observed within 1 s/);
        assert.equal(EXIT_NOT_YET, 10);
      } finally {
        cleanup(dir);
      }
    });

    test("hold-start refuses a counter case; hold-stop stops the r3 task and captures it STOPPED", { skip }, () => {
      const dir = tempDir("gs-ra-sh-");
      try {
        const refused = run({ mode: "hold-start", caseId: "a4g", pool: "p2", pools: "p1,p2", hold: 4500 }, dir, { alarms: alarmsDoc() });
        assert.notEqual(refused.status, 0);
        assert.deepEqual(refused.calls, []);
        write(dir, RESTORE_ALARM_FILES.task("r3"), { tasks: [{ taskArn: "arn:aws:ecs:us-east-1:111111111111:task/gs-staging/r3a00000000000000000000000000000" }] });
        const stopped = run({ mode: "hold-stop" }, dir, { taskArn: "arn:aws:ecs:us-east-1:111111111111:task/gs-staging/r3a00000000000000000000000000000", tasks: { tasks: [{ lastStatus: "STOPPED" }] } });
        assert.equal(stopped.status, 0, stopped.out);
        assert.deepEqual(opsOf(stopped.calls), ["ecs stop-task", "ecs wait", "ecs describe-tasks"]);
        assert.ok(fs.existsSync(path.join(dir, RESTORE_ALARM_FILES.taskStopped("r3"))));
      } finally {
        cleanup(dir);
      }
    });
  });
}

void fs;
void at;
