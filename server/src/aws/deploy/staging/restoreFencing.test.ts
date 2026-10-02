/* LIVE-6 L6-6 (restore drill tooling): the producer of probe-restore-fencing.json -- bound to THE adoption and the
 * restore-stop capture, each probe task's answer bound to ECS's own record of it, the new generation from the deployment's
 * own evidence, every refusal the brief names, the final record against the UNCHANGED judgeRestoreFencing, and
 * run-restore-fence-probe.{sh,ps1} against a stub AWS CLI. No AWS. */
import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, test } from "node:test";

import { fenceProbeCommand, fenceProbeLine } from "../../controlPlane/restoreFence";
import { judgeRestoreFencing, readGenerationEvidence, RESTORE_FENCING_FILE, RESTORE_FENCING_FORMAT, type AdoptionFacts, type GenerationEvidence, type RecoveryReaders } from "./recovery";
import { ADOPTION, cleanup, ENV, FENCE_POOL, fenceProbeRecord, fenceTask, read, RUN, RUNTIME_ARN, tempDir, write, writeDeploymentCapture, writeFenceProbes } from "./restoreDrillFixtures.test";
import { collectFenceProbe, recordRestoreFencing, RESTORE_FENCE_FILES, restoreFenceOverrides, restoreFencingCommand } from "./restoreFencing";
import { CERTIFIER_STORAGE_OVERRIDE } from "./evidence";

const SERVER_ROOT = path.join(__dirname, "..", "..", "..", "..", "..", "..");
const REPO_ROOT = path.join(SERVER_ROOT, "..");
const AD: AdoptionFacts = { previous_generation: 1, adopted_at: ADOPTION.adopted_at, adopted_by: "op", restore_id: ADOPTION.restore_id, game_table: ADOPTION.game_table, claim: "22222222-2222-4222-8222-222222222222", generation: 2 };
const reasons = (v: { kind: string; reasons?: readonly string[] }) => (v.reasons ?? []).join("\n");

/** L6-4's readers as the binding answers them (fakes over parsed shapes), read through the harness's own reader. */
async function generationOf(over: { readonly adoption?: Partial<AdoptionFacts> | null; readonly rule?: string | null } = {}): Promise<GenerationEvidence> {
  const ad = over.adoption === null ? null : { ...AD, ...(over.adoption ?? {}) };
  const readers: RecoveryReaders = {
    generationMarker: async () => ({ generation: 2, game_table: ADOPTION.game_table, origin: "restore", restored_from_generation: 1, restored_from_table: `gs-${ENV}-game-g1`, restore_point: 5, restore_id: ADOPTION.restore_id, prepared_at: 1, prepared_by: "op", claim: "11111111-1111-4111-8111-111111111111" }),
    appGeneration: async () => (ad === null ? { current_generation: 1, adoption: null } : { current_generation: ad.generation, adoption: { previous_generation: ad.previous_generation, adopted_at: ad.adopted_at, adopted_by: ad.adopted_by, restore_id: ad.restore_id, game_table: ad.game_table, claim: ad.claim } }),
    generationServingProblem: () => (over.rule === undefined ? null : over.rule),
    identityState: async () => ({ restore: null, self: null, servingProblem: null }),
    reviews: async () => [],
    adoptionRecord: async () => null,
  };
  return readGenerationEvidence(readers, { app: {} as never, ledger: {} as never }, { game: ADOPTION.game_table, ledger: "gs-staging-ledger" });
}

const input = async (over: Parameters<typeof generationOf>[0] = {}, more: Record<string, unknown> = {}) => ({ run: RUN, environment: ENV, primaryPool: "p1", runtimeParameter: RUNTIME_ARN("p1"), configGeneration: 2, configGameTable: ADOPTION.game_table, generation: await generationOf(over), ...more });

function drill(bend: Parameters<typeof writeFenceProbes>[1] = {}, capture: Parameters<typeof writeDeploymentCapture>[1] = {}): string {
  const dir = tempDir("gs-rf-");
  writeFenceProbes(dir, bend);
  writeDeploymentCapture(dir, capture);
  return dir;
}

const recorded = async (dir: string, over: Parameters<typeof generationOf>[0] = {}, more: Record<string, unknown> = {}) => recordRestoreFencing(dir, (await input(over, more)) as Parameters<typeof recordRestoreFencing>[1]);

describe("restore fencing producer: bound to THE adoption, every case from AWS, judged unchanged", () => {
  test("the whole record: four cases, bound to the adoption, passing the UNCHANGED judgeRestoreFencing", async () => {
    const dir = drill();
    try {
      const v = await recorded(dir);
      assert.equal(v.kind, "observed", reasons(v as any));
      const rec = read(dir, RESTORE_FENCING_FILE);
      assert.equal(rec.format, RESTORE_FENCING_FORMAT);
      assert.deepEqual(rec.adoption, { restore_id: AD.restore_id, game_table: AD.game_table, previous_generation: 1, generation: 2, adopted_at: AD.adopted_at });
      assert.deepEqual(Object.keys(rec.cases).sort(), ["kms-side-effect-withheld", "new-generation-started", "old-generation-ledger-write-refused", "old-generation-task-never-ready"]);
      const checks = judgeRestoreFencing(dir, { run: RUN, adoption: AD });
      assert.ok(checks.length === 5 && checks.every((c) => c.status === "pass"), JSON.stringify(checks));
      assert.equal(rec.cases["old-generation-task-never-ready"].task.exit_code, 2, "ECS's own exit code rides with the case");
      assert.equal(rec.cases["new-generation-started"].ready, true);
      assert.match(rec.statement, /no serving pool, no old-generation document, nothing written, no KMS Sign, no chain transaction/);
    } finally {
      cleanup(dir);
    }
  });

  test("wrong adoption fails: another restore, other generations, no adoption at all, an unbound build, another run's restore-stop", async () => {
    for (const [over, more, capture, why] of [
      [{ adoption: { restore_id: "drill-other" } }, {}, {}, /restore-stop capture is run .* restore drill-1002; this run is .*APPGEN adopted restore drill-other/],
      [{ adoption: { previous_generation: 2, generation: 3 } }, {}, {}, /not this run's and this adoption's probe/],
      [{ adoption: null }, {}, {}, /APPGEN shows no adoption/],
      [{}, {}, { stop: { run_id: "l6restore-other-run" } }, /restore-stop capture is run l6restore-other-run/],
      [{}, {}, { stop: { captured_at: "2026-10-02T01:30:00.000Z" } }, /not before the adoption/],
    ] as Array<[Parameters<typeof generationOf>[0], Record<string, unknown>, Parameters<typeof writeDeploymentCapture>[1], RegExp]>) {
      const dir = drill({}, capture);
      try {
        const v = await recorded(dir, over, more);
        assert.equal(v.kind, "refused", String(why));
        assert.match(reasons(v as any), why);
        assert.equal(fs.existsSync(path.join(dir, RESTORE_FENCING_FILE)), false, "nothing written");
      } finally {
        cleanup(dir);
      }
    }
    const dir = drill();
    try {
      const unbound: GenerationEvidence = await readGenerationEvidence(undefined, { app: {} as never, ledger: {} as never }, { game: "g", ledger: "l" });
      assert.match(reasons(recordRestoreFencing(dir, { ...(await input()), generation: unbound }) as any), /not bound in this build/);
      /* A probe that observed another adoption than APPGEN's. */
      writeFenceProbes(dir, { "ledger-kms": { record: { adoption: { ...ADOPTION, adopted_at: ADOPTION.adopted_at + 1 } } } });
      assert.match(reasons((await recorded(dir)) as any), /observed the adoption .* not APPGEN's/);
    } finally {
      cleanup(dir);
    }
  });

  test("pre-adoption observation fails: a probe task started before adopted_at, a case observed before it, a capture before it", async () => {
    const before = ADOPTION.adopted_at - 60_000;
    for (const [bend, capture, why] of [
      [{ "old-task": { task: { startedAt: new Date(before).toISOString() } } }, {}, /started .* before the adoption/],
      [{ "ledger-kms": { record: { cases: { ...(fenceProbeRecord("ledger-kms", "x").cases as object), "old-generation-ledger-write-refused": { ...((fenceProbeRecord("ledger-kms", "x").cases as any)["old-generation-ledger-write-refused"]), observed_at: new Date(before).toISOString() } } } } }, {}, /observed .* not after the adoption/],
      [{}, { capturedAt: before }, /is not after the adoption/],
      [{}, { started: before }, /not after the adoption .*: it is not the new generation's/],
    ] as Array<[Parameters<typeof writeFenceProbes>[1], Parameters<typeof writeDeploymentCapture>[1], RegExp]>) {
      const dir = drill(bend, capture);
      try {
        const v = await recorded(dir);
        assert.equal(v.kind, "refused", String(why));
        assert.match(reasons(v as any), why);
      } finally {
        cleanup(dir);
      }
    }
  });

  test("the old ledger write must be fenced SPECIFICALLY by the generation: a generic refusal, a missing control, a write that landed all fail", async () => {
    const base = (fenceProbeRecord("ledger-kms", "x").cases as any)["old-generation-ledger-write-refused"];
    const variants: Array<[string, Record<string, unknown>]> = [
      ["generic refusal (AccessDenied before evaluation)", { ...base, evidence: { ...base.evidence, old: { codes: null, outcome: "error", error: "AccessDeniedException" } } }],
      ["only the guard failed (the fence term passed)", { ...base, evidence: { ...base.evidence, old: { codes: ["None", "ConditionalCheckFailed"], outcome: "cancelled" } } }],
      ["no control showing the fence term itself", { ...base, evidence: { ...base.evidence, control: { generation: 2, codes: ["ConditionalCheckFailed", "ConditionalCheckFailed"], outcome: "cancelled" } } }],
      ["APPGEN not at the new generation", { ...base, evidence: { ...base.evidence, appgen_after: 1 } }],
      ["written", { ...base, evidence: { ...base.evidence, written: true } }],
      ["not-fenced outcome", { ...base, outcome: "not-fenced", fence: null }],
      ["fenced by something else", { ...base, fence: "relayer" }],
      ["another generation", { ...base, generation: 2 }],
    ];
    for (const [label, ledger] of variants) {
      const cases = { ...(fenceProbeRecord("ledger-kms", "x").cases as object), "old-generation-ledger-write-refused": ledger };
      const dir = drill({ "ledger-kms": { record: { cases } } });
      try {
        const v = await recorded(dir);
        assert.equal(v.kind, "refused", label);
        assert.match(reasons(v as any), /not refused by the generation fence|not a generation fence/, label);
      } finally {
        cleanup(dir);
      }
    }
  });

  test("any KMS call makes the withheld case fail; so does any other KMS answer", async () => {
    const base = (fenceProbeRecord("ledger-kms", "x").cases as any)["kms-side-effect-withheld"];
    for (const [label, kms] of [
      ["one KMS Sign call", { ...base, kms_sign_calls: 1 }],
      ["signed", { ...base, outcome: "not-withheld", evidence: { ...base.evidence, withheld_counter: 0, signs_counter: 1 } }],
      ["withheld for something other than the generation", { ...base, evidence: { ...base.evidence, gate: "pool" } }],
      ["a signature may exist", { ...base, evidence: { ...base.evidence, signature_may_exist: true } }],
      ["the new generation", { ...base, generation: 2 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const cases = { ...(fenceProbeRecord("ledger-kms", "x").cases as object), "kms-side-effect-withheld": kms };
      const dir = drill({ "ledger-kms": { record: { cases } } });
      try {
        const v = await recorded(dir);
        assert.equal(v.kind, "refused", label);
        assert.match(reasons(v as any), /not withheld before KMS/, label);
      } finally {
        cleanup(dir);
      }
    }
  });

  test("the old task: a generic crash fails, ready=true fails, the wrong generation fails, ECS's exit must be the runtime's", async () => {
    const base = (fenceProbeRecord("old-task", "x").cases as any)["old-generation-task-never-ready"];
    const variants: Array<[string, Record<string, unknown>, Record<string, unknown>, RegExp]> = [
      ["a generic crash (exit 1, no refusal class)", { ...base, exit_code: 1, reason: null, evidence: { ...base.evidence, startup_error: "TypeError", refusal: null } }, { containers: [{ name: "game-server", exitCode: 1 }] }, /exited 1 \(ECS\)/],
      ["a crash that still exited 2", { ...base, reason: null, evidence: { ...base.evidence, startup_error: "TypeError", refusal: null } }, {}, /a crash or another refusal is not generation fencing/],
      ["refused for the identity restore", { ...base, reason: "identity-restore", evidence: { ...base.evidence, refusal: "identity-restore" } }, {}, /a crash or another refusal is not generation fencing/],
      ["ready", { ...base, ready: true }, {}, /came up/],
      ["the runtime came up", { ...base, evidence: { ...base.evidence, runtime_started: true } }, {}, /came up/],
      ["the wrong generation", { ...base, generation: 2, game_table: ADOPTION.game_table }, {}, /not the previous generation 1/],
      ["ECS saw another exit", { ...base, exit_code: 3 }, {}, /ECS's exit is the runtime's/],
      ["the pool was reached", { ...base, evidence: { ...base.evidence, boundary_calls: ["takePool"] } }, {}, /reached past the generation reads/],
    ];
    for (const [label, c, task, why] of variants) {
      const dir = drill({ "old-task": { record: { cases: { "old-generation-task-never-ready": c } }, task } });
      try {
        const v = await recorded(dir);
        assert.equal(v.kind, "refused", label);
        assert.match(reasons(v as any), why, label);
      } finally {
        cleanup(dir);
      }
    }
  });

  test("the new generation: ready=false (no healthy target) is not recorded; a wrong table, another document, a refusing startup rule fail", async () => {
    for (const [capture, over, more, kind, why] of [
      [{ health: "unhealthy" }, {}, {}, "not-yet", /target health/],
      [{}, {}, { configGameTable: "gs-staging-game-g2b" }, "refused", /serves generation 2 \(gs-staging-game-g2b\), not the adopted 2 \(gs-staging-game-g2\)/],
      [{}, {}, { configGeneration: 1 }, "refused", /serves generation 1/],
      [{ runtimeParameter: RUNTIME_ARN("p2") }, {}, {}, "refused", /reads .*runtime\/p2/],
      [{ storage: "file" }, {}, {}, "refused", /GS_STORAGE file/],
      [{}, { rule: "the game table holds generation 1" }, {}, "refused", /startup rule refuses generation 2/],
    ] as Array<[Parameters<typeof writeDeploymentCapture>[1], Parameters<typeof generationOf>[0], Record<string, unknown>, string, RegExp]>) {
      const dir = drill({}, capture);
      try {
        const v = await recorded(dir, over, more);
        assert.equal(v.kind, kind, String(why));
        assert.match(reasons(v as any), why);
        assert.equal(fs.existsSync(path.join(dir, RESTORE_FENCING_FILE)), false);
      } finally {
        cleanup(dir);
      }
    }
    /* The unchanged judge on its own: a written record whose new generation is not ready, or on another table, fails. */
    const dir = drill();
    try {
      assert.equal((await recorded(dir)).kind, "observed");
      const rec = read(dir, RESTORE_FENCING_FILE);
      for (const c of [{ ...rec.cases["new-generation-started"], ready: false }, { ...rec.cases["new-generation-started"], game_table: "gs-staging-game-g1" }]) {
        write(dir, RESTORE_FENCING_FILE, { ...rec, cases: { ...rec.cases, "new-generation-started": c } });
        assert.ok(judgeRestoreFencing(dir, { run: RUN, adoption: AD }).some((x) => x.status === "fail" && /new-generation-started/.test(x.name)));
      }
    } finally {
      cleanup(dir);
    }
  });

  test("each answer is the probe task's own: ECS's record of it, its exact command, its own log line", async () => {
    const bad: Array<[Parameters<typeof writeFenceProbes>[1], RegExp]> = [
      [{ "ledger-kms": { task: { group: `service:gs-${ENV}-${FENCE_POOL}` } } }, /belongs to a service/],
      [{ "ledger-kms": { task: { startedBy: "someone" } } }, /was started by someone/],
      [{ "ledger-kms": { task: { overrides: { containerOverrides: [{ name: "game-server", command: fenceProbeCommand({ mode: "ledger-kms", run: RUN, environment: ENV, pool: FENCE_POOL, previousGeneration: 1, generation: 2, restoreId: "drill-other", oldGameTable: `gs-${ENV}-game-g1` }), environment: [{ name: "GS_STORAGE", value: CERTIFIER_STORAGE_OVERRIDE }] }] } } } }, /is not this run's and this adoption's probe/],
      [{ "ledger-kms": { task: { overrides: { containerOverrides: [{ name: "game-server", command: (fenceTask("ledger-kms", { started: 1, stopped: 2 }) as any).overrides.containerOverrides[0].command, environment: [] }] } } } }, /GS_STORAGE/],
      [{ "ledger-kms": { task: { lastStatus: "RUNNING" } } }, /capture it once STOPPED/],
      [{ "ledger-kms": { record: { task_arn: "arn:aws:ecs:us-east-1:111111111111:task/gs-staging/other" } } }, /not .*the record must be the task's own/],
      [{ "ledger-kms": { lines: [] } }, /0 L6-6-RESTORE-FENCE-PROBE\/v1 lines/],
      [{ "ledger-kms": { lines: [fenceProbeLine({ a: 1 }), fenceProbeLine({ b: 2 })] } }, /2 L6-6-RESTORE-FENCE-PROBE\/v1 lines/],
      [{ "ledger-kms": { lines: [fenceProbeLine(fenceProbeRecord("ledger-kms", "x")).replace('"fenced"', '"FENCED"')] } }, /does not match its SHA-256/],
      [{ "ledger-kms": { record: { refused: "APPGEN shows no adoption" } } }, /refused to run/],
      [{ "ledger-kms": { task: { containers: [{ name: "game-server", exitCode: 9 }] } } }, /exited 9 \(ECS\)/],
    ];
    for (const [bend, why] of bad) {
      const dir = drill(bend);
      try {
        const v = collectFenceProbe(dir, "ledger-kms", { run: RUN, environment: ENV, adoption: AD });
        assert.equal(v.kind, "refused", String(why));
        assert.match(reasons(v as any), why);
      } finally {
        cleanup(dir);
      }
    }
  });

  test("overrides: the probe's exact command, GS_STORAGE refusing a server, the old table by the naming contract, non-prod", async () => {
    const o = restoreFenceOverrides({ mode: "old-task", run: RUN, environment: ENV, pool: "p2", previousGeneration: 1, generation: 2, restoreId: ADOPTION.restore_id, oldGameTable: `gs-${ENV}-game-g1` }) as any;
    assert.deepEqual(o.containerOverrides[0].command.slice(0, 2), ["node", "dist/server/src/aws/runtime/restoreFenceProbe.js"]);
    assert.deepEqual(o.containerOverrides[0].environment, [{ name: "GS_STORAGE", value: CERTIFIER_STORAGE_OVERRIDE }]);
    assert.throws(() => restoreFenceOverrides({ mode: "old-task", run: RUN, environment: ENV, pool: "p2", previousGeneration: 1, generation: 2, restoreId: ADOPTION.restore_id, oldGameTable: `gs-${ENV}-game-g2` }), /naming contract/);
    assert.throws(() => restoreFenceOverrides({ mode: "old-task", run: RUN, environment: "prod", pool: "p2", previousGeneration: 1, generation: 2, restoreId: ADOPTION.restore_id, oldGameTable: "gs-prod-game-g1" }), /non-prod/);
    /* The command surface: overrides prints JSON; record refuses an unbound read of the generation. */
    const out: string[] = [];
    const deps = { out: (l: string) => out.push(l) } as any;
    assert.equal(await restoreFencingCommand(["overrides", "--mode", "ledger-kms", "--run-id", RUN, "--environment", ENV, "--pool", "p2", "--previous-generation", "1", "--generation", "2", "--restore-id", ADOPTION.restore_id, "--old-game-table", `gs-${ENV}-game-g1`], deps, async () => await generationOf()), 0);
    assert.equal(JSON.parse(out[0]).containerOverrides[0].command[3], "ledger-kms");
  });
});

/* ------------------------------------------------------------------ */
/* run-restore-fence-probe.{sh,ps1} against a stub AWS CLI               */
/* ------------------------------------------------------------------ */

const PWSH = (() => {
  for (const c of process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"]) if (spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8", timeout: 60_000 }).status === 0) return c;
  return null;
})();
const BASH = process.platform === "win32" ? null : spawnSync("bash", ["-c", "exit 0"]).status === 0 ? "bash" : null;
const STUB = String.raw`
const fs = require("fs");
const argv = process.argv.slice(2);
const sc = JSON.parse(fs.readFileSync(process.env.STUB_SCENARIO, "utf8"));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(argv) + "\n");
const i = argv.findIndex((a) => ["ecs", "logs"].includes(a));
const op = argv.slice(i, i + 2).join(" ");
const answer = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
if (op === "ecs describe-services") answer({ services: [{ taskDefinition: sc.taskDefinition, networkConfiguration: { awsvpcConfiguration: { subnets: ["subnet-1"], securityGroups: ["sg-1"] } } }] });
else if (op === "ecs describe-task-definition") answer({ taskDefinition: { containerDefinitions: [{ name: "game-server", logConfiguration: { options: { "awslogs-group": "/gs/staging/game-server", "awslogs-stream-prefix": "gs" } } }] } });
else if (op === "ecs run-task") answer(sc.taskArn + "\n");
else if (op === "ecs wait") process.exit(0);
else if (op === "ecs describe-tasks") answer(sc.tasks);
else if (op === "logs get-log-events") answer(sc.log);
else { process.stderr.write("stub: unexpected " + op + "\n"); process.exit(254); }
`;

for (const shell of ["sh", "ps1"] as const) {
  describe(`run-restore-fence-probe.${shell} (stub AWS CLI; no AWS)`, () => {
    const skip = shell === "ps1" ? (PWSH === null ? "PowerShell is not available here" : false) : BASH === null ? "bash is not available here" : false;
    function run(mode: string, environment: string, dir: string, scenario: Record<string, unknown>) {
      const bin = tempDir("gs-rf-bin-");
      fs.writeFileSync(path.join(bin, "aws-stub.js"), STUB);
      if (process.platform === "win32") fs.writeFileSync(path.join(bin, "aws.cmd"), `@"${process.execPath}" "%~dp0aws-stub.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
      else fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "aws-stub.js")}" "$@"\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "scenario.json"), JSON.stringify(scenario));
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, STUB_SCENARIO: path.join(bin, "scenario.json"), STUB_LOG: path.join(bin, "calls.log") };
      const script = path.join(REPO_ROOT, "infra", "aws", "scripts", `run-restore-fence-probe.${shell}`);
      const r =
        shell === "ps1"
          ? spawnSync(PWSH as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", mode, "-Environment", environment, "-Region", "us-east-1", "-Run", RUN, "-Out", dir, "-Pool", FENCE_POOL, "-PreviousGeneration", "1", "-Generation", "2", "-RestoreId", ADOPTION.restore_id], { env, encoding: "utf8", timeout: 300_000 })
          : spawnSync("bash", [script, mode, environment, "us-east-1", RUN, dir, FENCE_POOL, "1", "2", ADOPTION.restore_id], { env, encoding: "utf8", timeout: 300_000 });
      const calls = fs.existsSync(env.STUB_LOG) ? fs.readFileSync(env.STUB_LOG, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as string[]) : [];
      cleanup(bin);
      return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
    }

    test("old-task: ONE standalone run-task with the probe's own command (from the TS overrides), then its ECS record and its log", { skip }, () => {
      const dir = tempDir("gs-rf-sh-");
      try {
        const taskArn = "arn:aws:ecs:us-east-1:111111111111:task/gs-staging/f2f20000000000000000000000000000";
        const r = run("old-task", ENV, dir, { taskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p2:7", taskArn, tasks: { tasks: [{ taskArn }] }, log: { events: [{ message: "x" }] } });
        assert.equal(r.status, 0, r.out);
        const ops = r.calls.map((c) => c.slice(c.findIndex((a) => ["ecs", "logs"].includes(a)), c.findIndex((a) => ["ecs", "logs"].includes(a)) + 2).join(" "));
        assert.deepEqual(ops, ["ecs describe-services", "ecs describe-task-definition", "ecs run-task", "ecs wait", "ecs describe-tasks", "logs get-log-events"]);
        const runTask = r.calls.find((c) => c.includes("run-task")) as string[];
        assert.equal(runTask[runTask.indexOf("--started-by") + 1], "l6-6-restore-fence-old-task");
        const overrides = JSON.parse(fs.readFileSync(path.join(dir, RESTORE_FENCE_DIR_OVERRIDES), "utf8"));
        assert.deepEqual(overrides.containerOverrides[0].command, fenceProbeCommand({ mode: "old-task", run: RUN, environment: ENV, pool: FENCE_POOL, previousGeneration: 1, generation: 2, restoreId: ADOPTION.restore_id, oldGameTable: `gs-${ENV}-game-g1` }));
        for (const f of [RESTORE_FENCE_FILES.task("old-task"), RESTORE_FENCE_FILES.log("old-task"), RESTORE_FENCE_FILES.logStream("old-task")]) assert.ok(fs.existsSync(path.join(dir, f)), f);
        assert.equal(read(dir, RESTORE_FENCE_FILES.logStream("old-task")).log_stream, "gs/game-server/f2f20000000000000000000000000000");
      } finally {
        cleanup(dir);
      }
    });

    test("prod is refused before any AWS call; an unknown mode too", { skip }, () => {
      const dir = tempDir("gs-rf-sh-");
      try {
        const prod = run("ledger-kms", "prod", dir, {});
        assert.notEqual(prod.status, 0);
        assert.deepEqual(prod.calls, []);
        const odd = run("serve", ENV, dir, {});
        assert.notEqual(odd.status, 0);
        assert.deepEqual(odd.calls, []);
      } finally {
        cleanup(dir);
      }
    });
  });
}

const RESTORE_FENCE_DIR_OVERRIDES = "restore-fence/old-task-overrides.json";
