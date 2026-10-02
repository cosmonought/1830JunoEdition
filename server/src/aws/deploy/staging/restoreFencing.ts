// server/src/aws/deploy/staging/restoreFencing.ts
//
// ==================================================================
//  LIVE-6 L6-6 (RESTORE DRILL): A SUPPORTED PRODUCER FOR `probe-restore-fencing.json`
// ==================================================================
//
// `recovery.ts` judges `probe-restore-fencing.json` (RESTORE_FENCING_FORMAT, `judgeRestoreFencing` -- UNCHANGED) and
// nothing produced it. This is the producer. It binds itself to the ACTUAL APPGEN adoption (read live through L6-4's own
// readers, the staging binding in `tools/awsDeploy.ts`): the run id, the restore id, the previous and new generation, the
// adopted table and `adopted_at` -- and to the restore-stop capture, which must name this run and this restore id (both
// fixed before any mutation). Its four cases:
//
//   old-generation-ledger-write-refused   } the standalone `ledger-kms` probe task (`aws/runtime/restoreFenceProbe.ts`):
//   kms-side-effect-withheld              } the ledger's own generation fence for the OLD generation, refused, with a
//                                           control; the KMS gate refusing an old-generation Sign before KMS (0 calls).
//   old-generation-task-never-ready         the standalone `old-task` probe task: the PRODUCTION startup configured for the
//                                           OLD generation, refused for the generation (exit 2), never ready, no pool.
//   new-generation-started                  the DEPLOYMENT's own evidence: the runtime document (read live) serves the
//                                           adopted generation and table; L6-4's own startup rule (bound) accepts that
//                                           table now; the primary's one running task started after the adoption, runs
//                                           the task definition that names that document, and is the ALB target group's
//                                           one HEALTHY target (/gs/readyz 200: ready) in this run's capture.
//
// The probe tasks' answers are read back from THEIR OWN log streams (one SHA-256-checked line each) and bound to ECS's
// own record of each task (describe-tasks: started by the drill, standalone, the probe's exact command, GS_STORAGE refused,
// STOPPED, its exit code -- ledger-kms 0, old-task the runtime's own 2 or 3 -- started after the adoption). Nothing is typed:
// a capture that is not there, not this run's, not this adoption's, or that says anything else is REFUSED, and the
// assembled record is judged by `judgeRestoreFencing` in a scratch copy before it is written.
//
// Commands (`awsDeploy stage-probe restore-fencing ...`; infra/aws/scripts/run-restore-fence-probe.{sh,ps1}):
//   overrides --mode ledger-kms|old-task --run-id R --environment E --pool P --previous-generation N --generation M
//             --restore-id X --old-game-table T          the probe task's overrides (JSON)
//   record    --run-id R --evidence <dir> --runtime-parameter <ARN> --environment E --primary-pool P --generation M
//             reads AWS (the document, APPGEN, SYSTEM/GENERATION -- read-only) and the evidence; writes probe-restore-fencing.json

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { cliTime } from "../../controlPlane/evidence";
import { FENCE_PROBE_MODES, fenceProbeCommand, fenceProbeRecordFromLog, fenceProbeStartedBy, RESTORE_FENCE_PROBE_FORMAT, type FenceProbeArgs, type FenceProbeMode } from "../../controlPlane/restoreFence";
import type { DeployDeps } from "../commands";
import { clientsFor, environmentOf, EXIT_FAILED, EXIT_OK, generationOf, loadAndMatch, need, parseFlags, UsageError } from "../commands";
import { EVIDENCE_FILES, expectedNames } from "../deployVerify";
import { arr, CERTIFIER_STORAGE_OVERRIDE, EVIDENCE, evidenceName, num, obj, readEvidence, runIdProblem, str, writeRecord } from "./evidence";
import { checkRunningTasks, checkTargetHealth } from "./prerequisite";
import { adoptionOf, judgeRestoreFencing, RESTORE_FENCING_FILE, RESTORE_FENCING_FORMAT, RESTORE_STOP_DIR, RESTORE_STOP_FORMAT, restoreSafe, type AdoptionFacts, type GenerationEvidence } from "./recovery";
import { notYet, refused, type Verdict } from "./restoreAlarmProbe";

export const RESTORE_FENCE_DIR = "restore-fence";
export const RESTORE_FENCE_FILES = Object.freeze({
  task: (mode: FenceProbeMode) => `${RESTORE_FENCE_DIR}/${mode}-task.json`,
  log: (mode: FenceProbeMode) => `${RESTORE_FENCE_DIR}/${mode}-log.json`,
  logStream: (mode: FenceProbeMode) => `${RESTORE_FENCE_DIR}/${mode}-log-stream.json`,
});
export const RESTORE_FENCING_STATEMENT =
  "the old generation exercised through the production fences by standalone probe tasks after the adoption (no serving pool, no old-generation document, nothing written, no KMS Sign, no chain transaction); the new generation from the deployment's own evidence";

const iso = (ms: number): string => new Date(ms).toISOString();

/** The probe task's overrides: the probe's exact command (`controlPlane/restoreFence.ts`), GS_STORAGE refusing a server. */
export function restoreFenceOverrides(a: FenceProbeArgs): Record<string, unknown> {
  if (a.oldGameTable !== expectedNames(a.environment, a.previousGeneration).gameTable) throw new Error(`--old-game-table is ${expectedNames(a.environment, a.previousGeneration).gameTable} (generation ${a.previousGeneration}'s table by the naming contract)`);
  return { containerOverrides: [{ name: "game-server", command: fenceProbeCommand(a), environment: [{ name: "GS_STORAGE", value: CERTIFIER_STORAGE_OVERRIDE }] }] };
}

/* ------------------------------------------------------------------ */
/* One probe task, from ECS and its own log                              */
/* ------------------------------------------------------------------ */

export interface FenceExpect {
  readonly run: string;
  readonly environment: string;
  readonly adoption: AdoptionFacts;
}

const sameAdoption = (x: unknown, ad: AdoptionFacts): boolean => {
  const o = obj(x);
  return o.restore_id === ad.restore_id && o.previous_generation === ad.previous_generation && o.generation === ad.generation && o.game_table === ad.game_table && o.adopted_at === ad.adopted_at;
};

/** A probe task's record, bound to ECS's own record of that task. */
export function collectFenceProbe(dir: string, mode: FenceProbeMode, expect: FenceExpect): Verdict<{ readonly record: Record<string, unknown>; readonly task: Record<string, unknown> }> {
  const ad = expect.adoption;
  const cap = readEvidence(dir, RESTORE_FENCE_FILES.task(mode));
  if (!cap.ok) return refused(`${cap.problem} (run-restore-fence-probe ${mode} records it)`);
  const tasks = arr(obj(cap.value).tasks).map(obj);
  if (tasks.length !== 1) return refused(`expected exactly one ${mode} probe task in ${RESTORE_FENCE_FILES.task(mode)}, found ${tasks.length}`);
  const t = tasks[0];
  if (t.startedBy !== fenceProbeStartedBy(mode)) return refused(`the ${mode} task was started by ${String(t.startedBy)}, not ${fenceProbeStartedBy(mode)}`);
  if (typeof t.group === "string" && t.group.startsWith("service:")) return refused(`the ${mode} task belongs to a service: a probe task is always standalone`);
  const override = arr(obj(t.overrides).containerOverrides).map(obj).find((c) => c.name === "game-server");
  const command = arr(override?.command).map(String);
  const env = arr(override?.environment).map(obj);
  if (env.find((e) => e.name === "GS_STORAGE")?.value !== CERTIFIER_STORAGE_OVERRIDE) return refused(`the ${mode} task's GS_STORAGE is not ${CERTIFIER_STORAGE_OVERRIDE} (a lost override must start nothing)`);
  const at = (flag: string) => command[command.indexOf(flag) + 1];
  const args: FenceProbeArgs = { mode, run: expect.run, environment: expect.environment, pool: String(at("--pool")), previousGeneration: ad.previous_generation, generation: ad.generation, restoreId: ad.restore_id, oldGameTable: expectedNames(expect.environment, ad.previous_generation).gameTable };
  let want: string[];
  try {
    want = fenceProbeCommand(args);
  } catch (error) {
    return refused(`the ${mode} task's command is not a fencing probe's (${(error as Error).message})`);
  }
  if (JSON.stringify(command) !== JSON.stringify(want)) return refused(`the ${mode} task's command [${command.join(" ")}] is not this run's and this adoption's probe [${want.join(" ")}]`);
  const container = arr(t.containers).map(obj).find((c) => c.name === "game-server") ?? {};
  const exit = num(container.exitCode);
  const started = cliTime(t.startedAt as never);
  const stopped = cliTime(t.stoppedAt as never);
  if (t.lastStatus !== "STOPPED" || stopped === null || started === null) return refused(`the ${mode} task is ${String(t.lastStatus)}: capture it once STOPPED`);
  if (started < ad.adopted_at) return refused(`the ${mode} task started ${iso(started)}, before the adoption (${iso(ad.adopted_at)}): a pre-adoption observation proves no fence`);
  const where = readEvidence(dir, RESTORE_FENCE_FILES.logStream(mode));
  if (!where.ok) return refused(where.problem);
  const stream = String(obj(where.value).log_stream ?? "");
  if (!stream.endsWith(`/${String(t.taskArn).split("/").pop()}`)) return refused(`the captured log stream ${stream} is not the ${mode} task's`);
  const log = readEvidence(dir, RESTORE_FENCE_FILES.log(mode));
  if (!log.ok) return refused(log.problem);
  const got = fenceProbeRecordFromLog(arr(obj(log.value).events).map((e) => String(obj(e).message ?? "")));
  if (!got.ok) return refused(`the ${mode} task's log: ${got.problem}`);
  const r = obj(got.record);
  if (r.format !== RESTORE_FENCE_PROBE_FORMAT || r.mode !== mode || r.run_id !== expect.run || r.environment !== expect.environment || r.pool !== args.pool) return refused(`the ${mode} task's answer is ${String(r.format)} ${String(r.mode)} run ${String(r.run_id)} ${String(r.environment)}/${String(r.pool)}: not this run's`);
  if (r.refused !== null) return refused(`the ${mode} probe refused to run: ${restoreSafe(String(r.refused))}`);
  if (!sameAdoption(r.adoption, ad)) return refused(restoreSafe(`the ${mode} probe observed the adoption ${JSON.stringify(r.adoption)}, not APPGEN's ${JSON.stringify(ad)}`));
  if (r.task_arn !== t.taskArn) return refused(`the ${mode} answer names task ${String(r.task_arn)}, not ${String(t.taskArn)} (the record must be the task's own)`);
  const expectedExit = mode === "ledger-kms" ? [0] : [2, 3];
  if (exit === null || !expectedExit.includes(exit)) return refused(`the ${mode} task exited ${String(exit)} (ECS), not ${expectedExit.join(" or ")}`);
  return { kind: "observed", value: { record: r, task: { task_arn: String(t.taskArn), task_definition: String(t.taskDefinitionArn), started_at: started, stopped_at: stopped, exit_code: exit, log_stream: stream } } };
}

/* ------------------------------------------------------------------ */
/* The cases                                                            */
/* ------------------------------------------------------------------ */

const observedAfter = (c: Record<string, unknown>, ad: AdoptionFacts): boolean => Number.isFinite(Date.parse(String(c.observed_at))) && Date.parse(String(c.observed_at)) >= ad.adopted_at;

/** The ledger-kms task's two cases: fenced SPECIFICALLY by the generation, withheld with KMS never called. */
export function fenceCasesFrom(collected: { readonly record: Record<string, unknown>; readonly task: Record<string, unknown> }, ad: AdoptionFacts): Verdict<Record<string, unknown>> {
  const cases = obj(collected.record.cases);
  const ledger = obj(cases["old-generation-ledger-write-refused"]);
  const ev = obj(ledger.evidence);
  const old = obj(ev.old);
  const control = obj(ev.control);
  const oldCodes = arr(old.codes).map(String);
  const controlCodes = arr(control.codes).map(String);
  const problems: string[] = [];
  if (!observedAfter(ledger, ad)) problems.push(`the ledger write was observed ${String(ledger.observed_at)}, not after the adoption`);
  if (!(ledger.generation === ad.previous_generation && ledger.outcome === "fenced" && ledger.fence === "generation")) problems.push(`the ledger write of generation ${String(ledger.generation)} came to ${String(ledger.outcome)} (fence ${String(ledger.fence)}): not refused by the generation fence`);
  if (!(oldCodes[0] === "ConditionalCheckFailed" && controlCodes[0] === "None" && controlCodes[1] === "ConditionalCheckFailed" && control.generation === ad.generation && ev.appgen_before === ad.generation && ev.appgen_after === ad.generation && ev.written === false)) {
    problems.push(`the ledger write's evidence is not a generation fence (old [${oldCodes.join(", ")}], control [${controlCodes.join(", ")}] at ${String(control.generation)}, APPGEN ${String(ev.appgen_before)} -> ${String(ev.appgen_after)}, written ${String(ev.written)}): a generic refusal is not generation fencing`);
  }
  const kms = obj(cases["kms-side-effect-withheld"]);
  const kev = obj(kms.evidence);
  if (!observedAfter(kms, ad)) problems.push(`the KMS case was observed ${String(kms.observed_at)}, not after the adoption`);
  if (!(kms.generation === ad.previous_generation && kms.kms_sign_calls === 0 && kms.outcome === "withheld" && kev.gate === "generation" && kev.withheld_counter === 1 && kev.signs_counter === 0 && kev.error_code === "unavailable" && kev.native === "PoolWriterNotCurrent" && kev.signature_may_exist === false)) {
    problems.push(`the KMS case is generation ${String(kms.generation)}, ${String(kms.kms_sign_calls)} KMS Sign call(s), ${String(kms.outcome)} (gate ${String(kev.gate)}, withheld ${String(kev.withheld_counter)}, error ${String(kev.error_code)}/${String(kev.native)}): not withheld before KMS`);
  }
  if (problems.length > 0) return refused(...problems.map(restoreSafe));
  return { kind: "observed", value: { "old-generation-ledger-write-refused": { ...ledger, task: collected.task }, "kms-side-effect-withheld": { ...kms, task: collected.task } } };
}

/** The old-task task's case: never ready, refused for the GENERATION (never any crash), ECS's exit = the runtime's. */
export function oldTaskCaseFrom(collected: { readonly record: Record<string, unknown>; readonly task: Record<string, unknown> }, ad: AdoptionFacts, environment: string): Verdict<Record<string, unknown>> {
  const c = obj(obj(collected.record.cases)["old-generation-task-never-ready"]);
  const ev = obj(c.evidence);
  const problems: string[] = [];
  if (!observedAfter(c, ad)) problems.push(`observed ${String(c.observed_at)}, not after the adoption`);
  if (c.generation !== ad.previous_generation || c.game_table !== expectedNames(environment, ad.previous_generation).gameTable) problems.push(`the task was configured for generation ${String(c.generation)} (${String(c.game_table)}), not the previous generation ${ad.previous_generation} (${expectedNames(environment, ad.previous_generation).gameTable})`);
  if (c.ready !== false || ev.runtime_started !== false) problems.push(`the old-generation task came up (ready ${String(c.ready)}, runtime started ${String(ev.runtime_started)})`);
  if (!((c.exit_code === 2 || c.exit_code === 3) && c.exit_code === collected.task.exit_code)) problems.push(`the runtime decided exit ${String(c.exit_code)}, ECS saw ${String(collected.task.exit_code)}: a generation refusal is 2 (or a loss 3), and ECS's exit is the runtime's`);
  if (!(c.reason === "generation" && ev.refusal === "generation" && ev.startup_error === "AwsStartupError")) problems.push(`refused for ${String(ev.refusal)} (${String(ev.startup_error)}): a crash or another refusal is not generation fencing`);
  if (!(Array.isArray(ev.boundary_calls) && ev.boundary_calls.length === 0)) problems.push(`the startup reached past the generation reads (${JSON.stringify(ev.boundary_calls)})`);
  if (problems.length > 0) return refused(...problems.map(restoreSafe));
  return { kind: "observed", value: { ...c, task: collected.task } };
}

/** new-generation-started from the deployment's own evidence (see the header). */
export function newGenerationCase(
  dir: string,
  input: { readonly adoption: AdoptionFacts; readonly environment: string; readonly primaryPool: string; readonly runtimeParameter: string; readonly configGeneration: number; readonly configGameTable: string; readonly generation: GenerationEvidence },
): Verdict<Record<string, unknown>> {
  const ad = input.adoption;
  const problems: string[] = [];
  if (input.configGeneration !== ad.generation || input.configGameTable !== ad.game_table) problems.push(`the runtime document serves generation ${input.configGeneration} (${input.configGameTable}), not the adopted ${ad.generation} (${ad.game_table})`);
  const rule = input.generation.startupRule === null ? null : input.generation.startupRule({ generation: ad.generation, gameTable: ad.game_table });
  if (rule === null) problems.push("L6-4's readers are not bound in this build: the new generation's startup rule cannot be read");
  else if (!rule.ok) problems.push(`L6-4's startup rule could not be read (${rule.unreadable})`);
  else if (rule.value !== null) problems.push(`L6-4's startup rule refuses generation ${ad.generation} on ${ad.game_table}: ${rule.value}`);
  const capture = readEvidence(dir, EVIDENCE.capture);
  const services = readEvidence(dir, EVIDENCE_FILES.services);
  const tasks = readEvidence(dir, EVIDENCE.runningTasks);
  const health = readEvidence(dir, EVIDENCE.targetHealth);
  const td = readEvidence(dir, EVIDENCE_FILES.taskDefinition(input.primaryPool));
  for (const r of [capture, services, tasks, health, td]) if (!r.ok) problems.push(`${r.problem} (capture-evidence after the switch)`);
  if (problems.length > 0) return refused(...problems.map(restoreSafe));
  const capturedAt = Date.parse(String(obj(capture.ok ? capture.value : null).captured_at));
  if (!Number.isFinite(capturedAt) || capturedAt < ad.adopted_at) return refused(`the capture (${String(obj(capture.ok ? capture.value : null).captured_at)}) is not after the adoption (${iso(ad.adopted_at)})`);
  const prereq = { environment: input.environment, pools: [input.primaryPool], primaryPool: input.primaryPool };
  const running = checkRunningTasks(tasks.ok ? tasks.value : null, services.ok ? services.value : null, prereq);
  const live = running.running.get(input.primaryPool) ?? [];
  const failed = [...running.checks, ...checkTargetHealth(health.ok ? health.value : null, live)].filter((c) => c.status !== "pass");
  if (failed.length > 0) return notYet(...failed.map((c) => `${c.name}: ${c.detail}`));
  const task = live[0];
  const started = cliTime(task.startedAt as never);
  if (started === null || started < ad.adopted_at) return refused(`the primary's running task started ${started === null ? "?" : iso(started)}, not after the adoption (${iso(ad.adopted_at)}): it is not the new generation's`);
  const def = obj(obj(td.ok ? td.value : null).taskDefinition);
  const game = arr(def.containerDefinitions).map(obj).find((c) => c.name === "game-server");
  const envOf = (name: string) => str(arr(game?.environment).map(obj).find((e) => e.name === name)?.value);
  if (def.taskDefinitionArn !== task.taskDefinitionArn) return refused(`${EVIDENCE_FILES.taskDefinition(input.primaryPool)} is ${String(def.taskDefinitionArn)}, not the running task's ${String(task.taskDefinitionArn)}`);
  if (envOf("GS_AWS_CONFIG_PARAMETER") !== input.runtimeParameter || envOf("GS_STORAGE") !== "aws") return refused(`the running task definition reads ${String(envOf("GS_AWS_CONFIG_PARAMETER"))} with GS_STORAGE ${String(envOf("GS_STORAGE"))}, not the runtime document ${input.runtimeParameter} with GS_STORAGE aws`);
  return {
    kind: "observed",
    value: {
      observed_at: iso(capturedAt),
      generation: ad.generation,
      game_table: ad.game_table,
      ready: true,
      detail: `the primary ${input.primaryPool}'s task ${String(task.taskArn).split("/").pop()} (started ${iso(started)}, after the adoption) serves generation ${ad.generation} on ${ad.game_table}: the ALB's one healthy target (/gs/readyz 200), L6-4's startup rule accepts the table`,
      evidence: { task_arn: String(task.taskArn), task_definition: String(task.taskDefinitionArn), started_at: started, target: "healthy", runtime_parameter: input.runtimeParameter, startup_rule: "accepts", captured_at: iso(capturedAt) },
    },
  };
}

/** The restore-stop capture names this run and this restore id (fixed before any mutation). */
export function restoreStopProblem(dir: string, run: string, ad: AdoptionFacts): string | null {
  const stamp = readEvidence(dir, evidenceName(RESTORE_STOP_DIR, "stamp.json"));
  if (!stamp.ok) return `${stamp.problem} (capture-restore-stop BEFORE the restore: it fixes the run id and the restore id)`;
  const s = obj(stamp.value);
  if (s.format !== RESTORE_STOP_FORMAT || s.run_id !== run || s.restore_id !== ad.restore_id) return restoreSafe(`the restore-stop capture is run ${String(s.run_id)} restore ${String(s.restore_id)}; this run is ${run}, APPGEN adopted restore ${ad.restore_id}`);
  const at = Date.parse(String(s.captured_at));
  if (!Number.isFinite(at) || at > ad.adopted_at) return "the restore-stop capture is not before the adoption";
  return null;
}

/** Assemble, judge (unchanged `judgeRestoreFencing`) and write `probe-restore-fencing.json`. */
export function recordRestoreFencing(
  dir: string,
  input: { readonly run: string; readonly environment: string; readonly primaryPool: string; readonly runtimeParameter: string; readonly configGeneration: number; readonly configGameTable: string; readonly generation: GenerationEvidence },
): Verdict<string> {
  const ad = adoptionOf(input.generation);
  if (!input.generation.integrated) return refused("L6-4's readers are not bound in this build: the adoption cannot be read");
  if (ad === null) return refused("APPGEN shows no adoption: the old generation is not fenced (record only after appgen-adopt)");
  const stop = restoreStopProblem(dir, input.run, ad);
  if (stop !== null) return refused(stop);
  const expect = { run: input.run, environment: input.environment, adoption: ad };
  const ledgerKms = collectFenceProbe(dir, "ledger-kms", expect);
  if (ledgerKms.kind !== "observed") return ledgerKms;
  const oldTask = collectFenceProbe(dir, "old-task", expect);
  if (oldTask.kind !== "observed") return oldTask;
  const fence = fenceCasesFrom(ledgerKms.value, ad);
  if (fence.kind !== "observed") return fence;
  const never = oldTaskCaseFrom(oldTask.value, ad, input.environment);
  if (never.kind !== "observed") return never;
  const started = newGenerationCase(dir, { adoption: ad, environment: input.environment, primaryPool: input.primaryPool, runtimeParameter: input.runtimeParameter, configGeneration: input.configGeneration, configGameTable: input.configGameTable, generation: input.generation });
  if (started.kind !== "observed") return started;
  const record = {
    format: RESTORE_FENCING_FORMAT,
    run_id: input.run,
    environment: input.environment,
    statement: RESTORE_FENCING_STATEMENT,
    adoption: { restore_id: ad.restore_id, game_table: ad.game_table, previous_generation: ad.previous_generation, generation: ad.generation, adopted_at: ad.adopted_at },
    cases: { ...fence.value, "old-generation-task-never-ready": never.value, "new-generation-started": started.value },
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gs-restore-fencing-"));
  try {
    writeRecord(scratch, RESTORE_FENCING_FILE, record);
    const failed = judgeRestoreFencing(scratch, { run: input.run, adoption: ad }).filter((c) => c.status !== "pass");
    if (failed.length > 0) return refused(...failed.map((c) => `${c.name}: ${c.detail}`));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { kind: "observed", value: writeRecord(dir, RESTORE_FENCING_FILE, record) };
}

/* ------------------------------------------------------------------ */
/* The command                                                          */
/* ------------------------------------------------------------------ */

const wholeOf = (flags: Map<string, string>, name: string): number => {
  const text = need(flags, name);
  if (!/^[1-9][0-9]{0,15}$/.test(text)) throw new UsageError(`${name} must be a positive whole number`);
  return Number(text);
};

/** `readGeneration`: L6-4's live reading, wired ONLY in `commands.ts` (the one place the staging harness reads it, through the
 *  bound `staging.recovery`). */
export async function restoreFencingCommand(argv: readonly string[], deps: DeployDeps, readGeneration: (clients: ReturnType<typeof clientsFor>["clients"], tables: { readonly game: string; readonly ledger: string }) => Promise<GenerationEvidence>): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "overrides") {
    const flags = parseFlags(rest, ["--mode", "--run-id", "--environment", "--pool", "--previous-generation", "--generation", "--restore-id", "--old-game-table"], []);
    const mode = need(flags, "--mode");
    if (!(FENCE_PROBE_MODES as readonly string[]).includes(mode)) throw new UsageError("--mode is ledger-kms or old-task");
    try {
      deps.out(JSON.stringify(restoreFenceOverrides({ mode: mode as FenceProbeMode, run: need(flags, "--run-id"), environment: environmentOf(need(flags, "--environment")), pool: need(flags, "--pool"), previousGeneration: wholeOf(flags, "--previous-generation"), generation: wholeOf(flags, "--generation"), restoreId: need(flags, "--restore-id"), oldGameTable: need(flags, "--old-game-table") })));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError((error as Error).message);
    }
    return EXIT_OK;
  }
  if (sub === "record") {
    const flags = parseFlags(rest, ["--run-id", "--evidence", "--runtime-parameter", "--environment", "--primary-pool", "--generation"], []);
    const run = need(flags, "--run-id");
    const runProblem = runIdProblem(run);
    if (runProblem !== null) throw new UsageError(runProblem);
    const environment = environmentOf(need(flags, "--environment"));
    const primaryPool = need(flags, "--primary-pool");
    const arn = need(flags, "--runtime-parameter");
    const startup = await loadAndMatch(deps, arn, { environment, pool: primaryPool, generation: generationOf(need(flags, "--generation")) });
    const { clients, tables } = clientsFor(deps, startup);
    const generation = await readGeneration(clients, { game: tables.game, ledger: tables.ledger });
    const verdict = recordRestoreFencing(need(flags, "--evidence"), { run, environment, primaryPool, runtimeParameter: arn, configGeneration: startup.config.generation, configGameTable: startup.config.gameTable, generation });
    if (verdict.kind === "observed") {
      deps.out(`RECORDED: ${verdict.value}`);
      return EXIT_OK;
    }
    deps.out(`${verdict.kind === "not-yet" ? "NOT YET" : "REFUSED"}: ${verdict.reasons.join("; ")}`);
    return EXIT_FAILED;
  }
  throw new UsageError("stage-probe restore-fencing overrides | record");
}
