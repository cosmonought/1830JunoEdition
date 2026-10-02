// server/src/aws/controlPlane/restoreFence.ts
//
// ==================================================================
//  LIVE-6 L6-6 (RESTORE DRILL): THE OLD-GENERATION FENCING PROBE'S CONTRACT -- ITS COMMAND, ITS ONE LOG LINE
// ==================================================================
//
// The fencing probe runs INSIDE a standalone ECS task (`aws/runtime/restoreFenceProbe.ts`, the task role, never a service
// task, GS_STORAGE overridden to a value start.ts refuses); the staging certification's producer
// (`aws/deploy/staging/restoreFencing.ts`) builds its command override and reads its answer back from the task's own log.
// Both sides use THIS contract, so neither restates the other:
//
//   the command   ["node", FENCE_PROBE_ENTRY, "--mode", <ledger-kms | old-task>, "--run-id", R, "--environment", E,
//                  "--pool", P, "--previous-generation", N, "--generation", M, "--restore-id", X, "--old-game-table", T]
//   the answer    ONE log line: `L6-6-RESTORE-FENCE-PROBE/v1 <sha256 of the JSON> <JSON>` (no secret: generations, table
//                 names, a restore id, codes, counts, times; never a claim token, a key, an item's content)
//
// The two modes (each its own task, so ECS's own exit code is part of the evidence):
//   ledger-kms   old-generation-ledger-write-refused + kms-side-effect-withheld; exits 0 once its answer is printed.
//   old-task     old-generation-task-never-ready: the PRODUCTION startup (`startAwsRuntime`) configured for the OLD
//                generation, behind a substrate that serves only the generation reads; exits with the runtime's own
//                exit code (2: refused; never ready).

import { createHash } from "crypto";

export const RESTORE_FENCE_PROBE_FORMAT = "18COSMOS/L6-6-RESTORE-FENCE-PROBE/v1";
export const RESTORE_FENCE_LINE_PREFIX = "L6-6-RESTORE-FENCE-PROBE/v1";
export type FenceProbeMode = "ledger-kms" | "old-task";
export const FENCE_PROBE_MODES: readonly FenceProbeMode[] = Object.freeze(["ledger-kms", "old-task"]);
/** The image's compiled probe (Dockerfile: WORKDIR /app/server, dist/ copied whole). */
export const FENCE_PROBE_ENTRY = "dist/server/src/aws/runtime/restoreFenceProbe.js";
export const fenceProbeStartedBy = (mode: FenceProbeMode): string => `l6-6-restore-fence-${mode}`;
/** The probe exits with this when it refused to run at all (not after this adoption, a bad argument): never 2 or 3. */
export const FENCE_PROBE_REFUSED_EXIT = 9;
/** The disposable key of the never-committable ledger write (its Put's condition can never hold: nothing is written). */
export const fenceProbeLedgerKey = (run: string): { readonly pk: string; readonly sk: string } => ({ pk: `L6CERT#${run}`, sk: "RESTORE-FENCE" });

export interface FenceProbeArgs {
  readonly mode: FenceProbeMode;
  readonly run: string;
  readonly environment: string;
  readonly pool: string;
  readonly previousGeneration: number;
  readonly generation: number;
  readonly restoreId: string;
  readonly oldGameTable: string;
}

const RUN = /^[a-z0-9][a-z0-9-]{5,39}$/;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/;
const POOL = /^[a-z][a-z0-9-]{0,15}$/;
const RESTORE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;

/** Why `a` is not a fencing probe's arguments (null: it is). */
export function fenceProbeArgsProblem(a: FenceProbeArgs): string | null {
  if (!FENCE_PROBE_MODES.includes(a.mode)) return "--mode is ledger-kms or old-task";
  if (!RUN.test(a.run)) return "--run-id must be a run id";
  if (!ENVIRONMENT.test(a.environment) || /^prod/.test(a.environment)) return "the restore fencing probe runs only in a non-prod environment";
  if (!POOL.test(a.pool)) return "--pool must be a pool id";
  if (!Number.isSafeInteger(a.previousGeneration) || a.previousGeneration < 1 || !Number.isSafeInteger(a.generation) || a.generation <= a.previousGeneration) return "--previous-generation N and --generation M are whole numbers with M > N";
  if (!RESTORE_ID.test(a.restoreId)) return "--restore-id must be a restore id";
  if (!TABLE.test(a.oldGameTable)) return "--old-game-table must be a table name";
  return null;
}

/** The probe task's command (the container's command override), built in this one place. */
export function fenceProbeCommand(a: FenceProbeArgs): string[] {
  const problem = fenceProbeArgsProblem(a);
  if (problem !== null) throw new Error(problem);
  return ["node", FENCE_PROBE_ENTRY, "--mode", a.mode, "--run-id", a.run, "--environment", a.environment, "--pool", a.pool, "--previous-generation", String(a.previousGeneration), "--generation", String(a.generation), "--restore-id", a.restoreId, "--old-game-table", a.oldGameTable];
}

/** The probe's own argv back (after `node <entry>`), strictly: exactly the flags `fenceProbeCommand` writes. */
export function parseFenceProbeArgs(argv: readonly string[]): FenceProbeArgs | { readonly problem: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!["--mode", "--run-id", "--environment", "--pool", "--previous-generation", "--generation", "--restore-id", "--old-game-table"].includes(name) || value === undefined || flags.has(name)) return { problem: `unexpected argument ${JSON.stringify(name)}` };
    flags.set(name, value);
  }
  const whole = (v: string | undefined) => (v !== undefined && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : Number.NaN);
  const a: FenceProbeArgs = {
    mode: (flags.get("--mode") ?? "") as FenceProbeMode,
    run: flags.get("--run-id") ?? "",
    environment: flags.get("--environment") ?? "",
    pool: flags.get("--pool") ?? "",
    previousGeneration: whole(flags.get("--previous-generation")),
    generation: whole(flags.get("--generation")),
    restoreId: flags.get("--restore-id") ?? "",
    oldGameTable: flags.get("--old-game-table") ?? "",
  };
  const problem = fenceProbeArgsProblem(a);
  return problem === null ? a : { problem };
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The probe's answer as its one log line (a record of a few hundred bytes: well under Docker's 16 KiB line split). */
export function fenceProbeLine(record: unknown): string {
  const json = JSON.stringify(record);
  return `${RESTORE_FENCE_LINE_PREFIX} ${sha256(json)} ${json}`;
}

/** The answer back from the task's log events: exactly one probe line, intact. */
export function fenceProbeRecordFromLog(messages: readonly string[]): { readonly ok: true; readonly record: unknown } | { readonly ok: false; readonly problem: string } {
  const lines = messages.filter((m) => m.startsWith(`${RESTORE_FENCE_LINE_PREFIX} `));
  if (lines.length !== 1) return { ok: false, problem: `${lines.length} ${RESTORE_FENCE_LINE_PREFIX} lines in the log (exactly one: one probe per task)` };
  const m = new RegExp(`^${RESTORE_FENCE_LINE_PREFIX.replace(/[/.]/g, "\\$&")} ([0-9a-f]{64}) (\\{.*\\})\\s*$`).exec(lines[0]);
  if (m === null) return { ok: false, problem: "a malformed probe line" };
  if (sha256(m[2]) !== m[1]) return { ok: false, problem: "the probe line does not match its SHA-256 (truncated or altered)" };
  try {
    return { ok: true, record: JSON.parse(m[2]) as unknown };
  } catch {
    return { ok: false, problem: "the probe line's record is not JSON" };
  }
}
