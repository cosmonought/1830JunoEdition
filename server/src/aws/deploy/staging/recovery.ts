// server/src/aws/deploy/staging/recovery.ts
//
// ==================================================================
//  LIVE-6 L6-6 (L6-4 ADDENDUM): THE RECOVERY GATES -- GENERATION, APPGEN BINDING, IDENTITY RESTORE, REVIEW#, ROLLBACK,
//  RESTORE QUIETNESS AND FENCING -- AS A CERTIFICATION CONTRACT OVER L6-4'S OWN READERS
// ==================================================================
//
// L6-4 (`088abbd`, Project `claude/LIVE6_L6_4_GENERATION_RESTORE_2026-09-30.md`) made the serving deployment depend on
// three more facts than L5-8 verifies: the game table's `SYSTEM/GENERATION`, APPGEN's adoption binding, and the identity
// table's restore state (`RESTORE#identity`, `TABLE#identity`, `REVIEW#`). This slice is built on L5-8 (`aa2c64c`) and does
// NOT merge L6-4. So the gates below are a CONTRACT:
//
//   - they judge L6-4's PARSED shapes (the interfaces are restated here, field for field: `GenerationMarker`,
//     `AppGeneration`/`Adoption`, `RestoreRecord`, `ReviewRecord`), never raw items -- the STRICT READING stays L6-4's
//     (`readGenerationMarker`, `readAppGeneration`, `readIdentityRestore`, `identityServingProblem`); this file builds no
//     competing parser;
//   - the readers arrive through `RecoveryReaders`, bound by the integration that contains both slices
//     (`tools/awsDeploy.ts`; the import guard's `aws/deploy` rule gains exactly those read functions). UNBOUND -- as on this
//     branch -- every gate below FAILS with "not integrated": the integrated deployment cannot PASS without them;
//   - missing, unreadable or mismatched evidence is FAIL, never SKIP.
//
// THE GATES:
//   generation     `SYSTEM/GENERATION` present and strictly readable; its generation = the runtime document's; it names the
//                  document's game_table; its bootstrap / restore form is internally valid; APPGEN = that generation; and
//                  the ADOPTION BINDS THIS TABLE (a bootstrap marker: APPGEN never adopted; a restore marker: APPGEN's
//                  adopted game_table and restore_id are the marker's, and its previous generation the marker's source).
//                  Read live by `stage-cert` (the bootstrap/verify role may GetItem SYSTEM/* and APPGEN).
//   identity       the identity table's restore state, classified and reported -- never-restored, target-complete,
//                  target-replaying (incomplete), source-superseded, unreplayed-copy -- and its TABLE#identity binding;
//                  only a serving-safe table (L6-4's `identityServingProblem` null, bound to its own name) passes. Read by
//                  the certifier task (the task role reads the identity table).
//   review         every OPEN `REVIEW#` record is an unresolved recovery finding: FAIL, surfaced by restore id and count
//                  only (never a profile, principal, selector, event id or hash).
//   rollback       the deployment invariant (L6-4 §12.3): the serving image contains L6-4, and no ACTIVE earlier task
//                  definition revision -- an automatic rollback target -- is a build not attested to contain it. The image's
//                  own evidence: the certifier task reports which L6-4 modules its build carries (no version number is
//                  invented); earlier builds are attested by earlier PASSing certifications copied into
//                  `prior-certifications/`.
//   restore-quiet  (scenario `restore-drill`) the stop before adoption: every pool drained to zero and no task in the
//                  cluster, captured BEFORE APPGEN's `adopted_at`; with L6-5A integrated, no fresh `TASK#` heartbeat of an
//                  old-generation task after the stop -- operator proof, never a correctness lease.
//   restore-fence  (scenario `restore-drill`) the evidence slot for the later real-staging fencing probe: after adoption, an
//                  old-generation ledger write refused, an old-generation task never serving-ready, the KMS side effect
//                  withheld, and the explicitly configured new generation started. No destructive or chain-affecting probe
//                  exists yet: the slot is judged, and missing evidence FAILS the drill.

import * as fs from "fs";
import * as path from "path";

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type { Check } from "../deployVerify";
import { arr, fail, judge, num, obj, readEvidence, str } from "./evidence";

/* ------------------------------------------------------------------ */
/* L6-4's parsed shapes (restated; the strict parsers are L6-4's)       */
/* ------------------------------------------------------------------ */

/** `aws/game/generationMarker.ts` `GenerationMarker` (L6-4). */
export interface GenerationMarkerFacts {
  readonly generation: number;
  readonly game_table: string;
  readonly origin: "bootstrap" | "restore";
  readonly restored_from_generation: number | null;
  readonly restored_from_table: string | null;
  readonly restore_point: number | null;
  readonly restore_id: string | null;
  readonly prepared_at: number;
  readonly prepared_by: string;
  readonly claim: string;
}

/** `aws/ledger/appGeneration.ts` `AppGeneration` (L6-4); `adoption` null: the bootstrap item, never adopted. */
export interface AppGenerationFacts {
  readonly current_generation: number;
  readonly adoption: { readonly previous_generation: number; readonly adopted_at: number; readonly adopted_by: string; readonly restore_id: string; readonly game_table: string; readonly claim: string } | null;
}

/** `aws/identity/identityItems.ts` `RestoreRecord` (L6-4). */
export interface IdentityRestoreFacts {
  readonly restore_id: string;
  readonly state: "replaying" | "complete" | "superseded";
  readonly identity_table: string;
  readonly peer_table: string;
  readonly restore_point: number;
  readonly started_at: number;
  readonly journal_digest: string;
  readonly journal_events: number;
  readonly completed_at: number | null;
  readonly reviews: number | null;
}

/** What a REVIEW# record may contribute to evidence: its restore, its reason, whether it is open. Nothing that names or
 *  keys a player (profile, principal), no selector, no event id, no hash. */
export interface ReviewSummary {
  readonly restore_id: string;
  readonly reason: string;
  readonly open: boolean;
}

/** A read that failed or found an item this build cannot read: its kind and a message (never item content). */
export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly unreadable: string };

/** L6-4's readers, bound by the integration (see the header). */
export interface RecoveryReaders {
  /** `readGenerationMarker` (null: no item; throws for an item it cannot read). */
  readonly generationMarker: (client: DynamoDBClient, gameTable: string) => Promise<GenerationMarkerFacts | null>;
  /** `readAppGeneration` (null: no APPGEN; throws for an item it cannot read). */
  readonly appGeneration: (client: DynamoDBClient, ledgerTable: string) => Promise<AppGenerationFacts | null>;
  /** `readIdentityRestore`, the table's own name (TABLE#identity), and `identityServingProblem`. */
  readonly identityState: (client: DynamoDBClient, identityTable: string) => Promise<{ readonly restore: IdentityRestoreFacts | null; readonly self: string | null; readonly servingProblem: string | null }>;
  /** Every REVIEW# record, summarised (L6-4's strict decoder; the summary drops every identifying field). */
  readonly reviews: (client: DynamoDBClient, identityTable: string) => Promise<readonly ReviewSummary[]>;
}

export const NOT_INTEGRATED = "L6-4's readers are not bound in this build (the integration of L6-4 and L6-6 binds them): the gate cannot be certified";

const describeError = (error: unknown): string => `${(error as { name?: string } | null)?.name ?? "Error"}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`;

async function settle<T>(read: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, unreadable: describeError(error) };
  }
}

/* ------------------------------------------------------------------ */
/* generation (live, stage-cert)                                        */
/* ------------------------------------------------------------------ */

export interface GenerationEvidence {
  readonly integrated: boolean;
  readonly marker: Read<GenerationMarkerFacts | null> | null;
  readonly appgen: Read<AppGenerationFacts | null> | null;
}

export async function readGenerationEvidence(readers: RecoveryReaders | undefined, clients: { readonly app: DynamoDBClient; readonly ledger: DynamoDBClient }, tables: { readonly game: string; readonly ledger: string }): Promise<GenerationEvidence> {
  if (readers === undefined) return { integrated: false, marker: null, appgen: null };
  return { integrated: true, marker: await settle(() => readers.generationMarker(clients.app, tables.game)), appgen: await settle(() => readers.appGeneration(clients.ledger, tables.ledger)) };
}

/** The marker's own form (L6-4's parser enforces it; restated so a reader bound wrongly cannot slip past the gate). */
export function markerFormProblem(m: GenerationMarkerFacts): string | null {
  const restoreFields = [m.restored_from_generation, m.restored_from_table, m.restore_point, m.restore_id];
  if (m.origin === "bootstrap") return restoreFields.every((f) => f === null) ? null : "a bootstrap marker names a restore";
  if (m.origin !== "restore") return `an unknown origin ${String(m.origin)}`;
  if (restoreFields.some((f) => f === null)) return "a restore marker without its source, point or restore id";
  if ((m.restored_from_generation ?? 0) >= m.generation) return "a restore marker whose source generation is not below its own";
  if (m.restored_from_table === m.game_table) return "a restore marker naming itself as its source";
  return null;
}

export function judgeGeneration(evidence: GenerationEvidence, expect: { readonly generation: number; readonly gameTable: string; readonly requireRestore: boolean }): Check[] {
  if (!evidence.integrated || evidence.marker === null || evidence.appgen === null) return [fail("generation: SYSTEM/GENERATION and APPGEN", NOT_INTEGRATED)];
  const checks: Check[] = [];
  const m = evidence.marker;
  const a = evidence.appgen;
  if (!m.ok) checks.push(fail("generation: SYSTEM/GENERATION readable", `unreadable (${m.unreadable}): never read as some generation`));
  else if (m.value === null) checks.push(fail("generation: SYSTEM/GENERATION present", "the game table carries no SYSTEM/GENERATION (the bootstrap or a restore's preparation writes it)"));
  if (!a.ok) checks.push(fail("generation: APPGEN readable", `unreadable (${a.unreadable})`));
  else if (a.value === null) checks.push(fail("generation: APPGEN present", "the ledger has no APPGEN"));
  if (!m.ok || m.value === null || !a.ok || a.value === null) return checks;
  const marker = m.value;
  const appgen = a.value;
  const form = markerFormProblem(marker);
  checks.push(judge("generation: the marker's form", form === null, `${marker.origin} marker, internally valid`, String(form)));
  checks.push(judge("generation: the marker's generation = the runtime document's", marker.generation === expect.generation, `generation ${marker.generation}`, `the game table holds generation ${marker.generation}, the runtime document says ${expect.generation}`));
  checks.push(judge("generation: the marker names the configured game table", marker.game_table === expect.gameTable, marker.game_table, `the marker names ${marker.game_table}, the runtime document's game table is ${expect.gameTable}`));
  checks.push(judge("generation: APPGEN = the marker's generation", appgen.current_generation === marker.generation, `APPGEN current_generation ${appgen.current_generation}`, `APPGEN is ${appgen.current_generation}, the marker ${marker.generation} (not certified on the number alone: see the binding)`));
  const ad = appgen.adoption;
  let binding: string | null;
  if (marker.origin === "bootstrap") binding = ad === null ? null : `APPGEN adopted ${ad.game_table} (restore ${ad.restore_id}), but this table is a bootstrap table: not the adopted one`;
  else if (ad === null) binding = "this table is a prepared restore, but APPGEN was never adopted";
  else if (ad.game_table !== marker.game_table || ad.restore_id !== marker.restore_id) binding = `APPGEN adopted ${ad.game_table} (restore ${ad.restore_id}), not this table (${marker.game_table}, restore ${String(marker.restore_id)})`;
  else if (ad.previous_generation !== marker.restored_from_generation) binding = `APPGEN's previous generation ${ad.previous_generation} is not the marker's source generation ${String(marker.restored_from_generation)}`;
  else binding = null;
  checks.push(judge("generation: the adoption binds this table", binding === null, marker.origin === "bootstrap" ? "bootstrap table, APPGEN never adopted" : `APPGEN adopted ${marker.game_table} (restore ${String(marker.restore_id)}) from generation ${String(marker.restored_from_generation)}`, String(binding)));
  if (expect.requireRestore) checks.push(judge("generation: a restore drill serves the restored generation", marker.origin === "restore" && ad !== null, "restore marker, adopted", `a restore drill, but the serving table is a ${marker.origin} table${ad === null ? " and APPGEN was never adopted" : ""}`));
  return checks;
}

/** The record the certification keeps (no claim token: it is a write's token, and adds nothing to the audit). */
export function generationMeasurement(evidence: GenerationEvidence): Record<string, unknown> | null {
  if (!evidence.integrated || evidence.marker === null || evidence.appgen === null) return null;
  const m = evidence.marker.ok ? evidence.marker.value : null;
  const a = evidence.appgen.ok ? evidence.appgen.value : null;
  return {
    marker: m === null ? null : { generation: m.generation, game_table: m.game_table, origin: m.origin, restored_from_generation: m.restored_from_generation, restored_from_table: m.restored_from_table, restore_id: m.restore_id },
    appgen: a === null ? null : { current_generation: a.current_generation, adopted: a.adoption === null ? null : { previous_generation: a.adoption.previous_generation, game_table: a.adoption.game_table, restore_id: a.adoption.restore_id, adopted_at: a.adoption.adopted_at } },
  };
}

/* ------------------------------------------------------------------ */
/* identity + review (the certifier task)                               */
/* ------------------------------------------------------------------ */

export type IdentityRestoreState = "never-restored" | "target-complete" | "target-replaying" | "source-superseded" | "unreplayed-copy";

/** The identity table's restore state, as the report names it. */
export function identityRestoreState(restore: IdentityRestoreFacts | null, self: string | null, table: string): IdentityRestoreState {
  if (restore === null) return self !== null && self !== table ? "unreplayed-copy" : "never-restored";
  if (restore.identity_table !== table) return "unreplayed-copy";
  if (restore.state === "superseded") return "source-superseded";
  if (restore.state === "replaying") return "target-replaying";
  return self !== null && self !== table ? "unreplayed-copy" : "target-complete";
}

/** The task-role probe's `identity_state` section (read-only; ids and states only). */
export async function readIdentityRecovery(readers: RecoveryReaders | undefined, client: DynamoDBClient, identityTable: string): Promise<Record<string, unknown>> {
  if (readers === undefined) return { status: "not-integrated", reason: NOT_INTEGRATED };
  const state = await settle(() => readers.identityState(client, identityTable));
  const reviews = await settle(() => readers.reviews(client, identityTable));
  const restore = state.ok ? state.value.restore : null;
  return {
    status: "ran",
    identity_table: identityTable,
    state: state.ok ? { restore_state: identityRestoreState(restore, state.value.self, identityTable), restore_id: restore?.restore_id ?? null, marker_state: restore?.state ?? null, peer_table: restore?.peer_table ?? null, table_binding: state.value.self, serving_problem: state.value.servingProblem, completed_at: restore?.completed_at ?? null } : { unreadable: state.unreadable },
    reviews: reviews.ok ? { open: reviews.value.filter((r) => r.open).map((r) => ({ restore_id: r.restore_id, reason: r.reason })), resolved: reviews.value.filter((r) => !r.open).length } : { unreadable: reviews.unreadable },
  };
}

export function judgeIdentityRecovery(section: unknown, identityTable: string): Check[] {
  const s = obj(section);
  if (s.status !== "ran") return [fail("identity restore state", String(s.reason ?? "not recorded"))];
  const st = obj(s.state);
  if (typeof st.unreadable === "string") return [fail("identity restore state: readable", `unreadable (${st.unreadable})`)];
  const state = String(st.restore_state);
  const checks: Check[] = [
    judge("identity: the probed table is the configured one", s.identity_table === identityTable, identityTable, `probed ${String(s.identity_table)}, the runtime document names ${identityTable}`),
    judge(
      "identity: serving-safe restore state",
      (state === "never-restored" || state === "target-complete") && st.serving_problem === null,
      state === "target-complete" ? `target complete (restore ${String(st.restore_id)})` : "never restored",
      state === "target-replaying"
        ? `target replaying / incomplete (restore ${String(st.restore_id)}): it serves nothing -- never a healthy identity deployment`
        : state === "source-superseded"
          ? `source superseded by restore ${String(st.restore_id)} (replaced by ${String(st.peer_table)}): it never serves again`
          : state === "unreplayed-copy"
            ? "an unreplayed copy (it carries another table's name or restore marker): it serves nothing"
            : `not serving-safe: ${String(st.serving_problem)}`,
    ),
    judge("identity: TABLE#identity binding", st.table_binding === identityTable, `TABLE#identity names ${identityTable}`, st.table_binding === null ? "no TABLE#identity: no serving takeover has bound this table (a served deployment always has one)" : `TABLE#identity names ${String(st.table_binding)}, not ${identityTable}`),
  ];
  return checks;
}

export function judgeReviews(section: unknown): Check[] {
  const s = obj(section);
  if (s.status !== "ran") return [fail("REVIEW#", String(s.reason ?? "not recorded"))];
  const r = obj(s.reviews);
  if (typeof r.unreadable === "string") return [fail("REVIEW#: readable", `unreadable (${r.unreadable})`)];
  const open = arr(r.open).map(obj);
  const byRestore = new Map<string, number>();
  for (const o of open) byRestore.set(String(o.restore_id), (byRestore.get(String(o.restore_id)) ?? 0) + 1);
  return [
    judge(
      "REVIEW#: no unresolved recovery review",
      Array.isArray(r.open) && open.length === 0,
      `no open review (${String(num(r.resolved) ?? 0)} resolved)`,
      `${open.length} open REVIEW# record(s) -- an unresolved staging/recovery finding: ${[...byRestore].map(([id, n]) => `restore ${id}: ${n}`).join(", ")} (resolve through the operator path, L6-3)`,
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* rollback: the serving image and every automatic rollback target      */
/* ------------------------------------------------------------------ */

/** The L6-4 modules a build must carry (their compiled files, relative to this directory in dist/). */
export const L6_4_MODULES = Object.freeze({ generation_marker: "../../game/generationMarker.js", app_generation: "../../ledger/appGeneration.js", identity_restore: "../../identity/identityRestore.js", security_replay: "../../../identity/securityReplay.js" });

/** Which L6-4 modules THIS build carries -- evidence from the running image itself (no version number is invented). */
export function buildCapabilities(here: string = __dirname): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, file] of Object.entries(L6_4_MODULES)) out[name] = fs.existsSync(path.join(here, file));
  return out;
}

export const hasL64 = (capabilities: unknown): boolean => Object.keys(L6_4_MODULES).every((name) => obj(capabilities)[name] === true);

export const PRIOR_CERTIFICATIONS = "prior-certifications";
export const revisionsFile = (pool: string): string => `revisions-${pool}.json`;

/**
 * The deployment invariant: the running build carries L6-4 (the certifier task's own report), and every ACTIVE revision of
 * each pool's family other than the running one -- what the circuit breaker may roll back to -- is a build attested to
 * carry it: this run's, or one named by an earlier PASSing certification in `prior-certifications/`. A pre-L6-4 or
 * unattested revision must be deregistered (INACTIVE revisions are never rollback targets).
 */
export function judgeRollback(dir: string, expect: { readonly pools: readonly string[]; readonly runningBuild: string | null; readonly runningCapabilities: unknown; readonly runningTaskDefinitions: Readonly<Record<string, string | null>> }): Check[] {
  const checks: Check[] = [];
  const ok = hasL64(expect.runningCapabilities);
  checks.push(judge("rollback: the serving image contains L6-4", ok && expect.runningBuild !== null, `BUILD_ID ${String(expect.runningBuild)} carries ${Object.keys(L6_4_MODULES).join(", ")}`, `BUILD_ID ${String(expect.runningBuild)}: ${JSON.stringify(expect.runningCapabilities ?? null)} (the first AWS-mode image must contain L6-4)`));
  const attested = new Set<string>(ok && expect.runningBuild !== null ? [expect.runningBuild] : []);
  let priors: string[] = [];
  try {
    priors = fs.readdirSync(path.join(dir, PRIOR_CERTIFICATIONS)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    priors = [];
  }
  for (const file of priors) {
    const r = readEvidence(dir, path.join(PRIOR_CERTIFICATIONS, file), { ownRecord: true });
    if (!r.ok) continue;
    const c = obj(r.value);
    if (c.verdict === "PASS" && typeof c.build_id === "string" && hasL64(c.build_capabilities)) attested.add(c.build_id);
  }
  for (const pool of expect.pools) {
    const list = readEvidence(dir, revisionsFile(pool));
    if (!list.ok) {
      checks.push(fail(`rollback: ${pool}'s rollback targets`, `${list.problem} (capture-evidence lists every ACTIVE revision)`));
      continue;
    }
    const revisions = arr(obj(list.value).taskDefinitions).map(obj);
    const running = expect.runningTaskDefinitions[pool];
    const targets = revisions.filter((r) => r.taskDefinitionArn !== running);
    const unattested = targets
      .map((r) => {
        const game = arr(r.containerDefinitions).map(obj).find((c) => c.name === "game-server");
        const build = str(arr(game?.environment).map(obj).find((e) => e.name === "BUILD_ID")?.value);
        return { arn: String(r.taskDefinitionArn), build };
      })
      .filter((t) => t.build === null || !attested.has(t.build));
    checks.push(
      judge(
        `rollback: ${pool}'s automatic rollback targets contain L6-4`,
        revisions.some((r) => r.taskDefinitionArn === running) && unattested.length === 0,
        `${targets.length} ACTIVE earlier revision(s), each an attested L6-4 build`,
        !revisions.some((r) => r.taskDefinitionArn === running) ? `the running revision is not among the captured ACTIVE revisions` : `unattested (pre-L6-4 or unknown) rollback target(s): ${unattested.map((t) => `${t.arn.split("/").pop()} (BUILD_ID ${String(t.build)})`).join(", ")} -- deregister them or attest their build`,
      ),
    );
  }
  return checks;
}

/* ------------------------------------------------------------------ */
/* restore drill: quietness and the fencing slot                        */
/* ------------------------------------------------------------------ */

export const RESTORE_STOP_DIR = "restore-stop";
export const RESTORE_FENCING_FILE = "probe-restore-fencing.json";

/** Optional L6-5A seam: fresh TASK# heartbeats (operator proof only, never a lease). */
export interface HeartbeatEvidence {
  readonly integrated: boolean;
  /** Heartbeats seen after the stop, from tasks of the OLD generation (task ids only). */
  readonly oldGenerationAfterStop: readonly string[];
}

/**
 * The stop before adoption: `restore-stop/services.json` (every pool desired 0, running 0, pending 0),
 * `restore-stop/cluster-tasks.json` (no RUNNING or PENDING task), `restore-stop/stamp.json` (the run, the time) -- captured
 * before APPGEN's `adopted_at`.
 */
export function judgeRestoreQuiet(dir: string, expect: { readonly run: string; readonly adoptedAt: number | null; readonly heartbeats: HeartbeatEvidence | null }): Check[] {
  const services = readEvidence(dir, path.join(RESTORE_STOP_DIR, "services.json"));
  const tasks = readEvidence(dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"));
  const stamp = readEvidence(dir, path.join(RESTORE_STOP_DIR, "stamp.json"));
  const missing = [services, tasks, stamp].filter((r) => !r.ok).map((r) => (r.ok ? "" : r.problem));
  if (missing.length > 0) return [fail("restore: the stop before adoption", `${missing.join("; ")} (capture the stopped state before appgen-adopt)`)];
  const s = obj(stamp.ok ? stamp.value : null);
  const at = Date.parse(String(s.captured_at));
  const busy = arr(obj(services.ok ? services.value : null).services).map(obj).filter((x) => x.desiredCount !== 0 || x.runningCount !== 0 || x.pendingCount !== 0).map((x) => String(x.serviceName));
  const live = arr(obj(tasks.ok ? tasks.value : null).tasks).map(obj).filter((t) => t.lastStatus !== "STOPPED").map((t) => String(t.taskArn).split("/").pop());
  const checks: Check[] = [
    judge("restore: this run's stop", s.run_id === expect.run && Number.isFinite(at), `captured ${String(s.captured_at)}`, `the stop evidence is run ${String(s.run_id)}'s`),
    judge("restore: every pool stopped", busy.length === 0 && arr(obj(services.ok ? services.value : null).services).length > 0, "desired 0, running 0, pending 0", busy.length > 0 ? `not stopped: ${busy.join(", ")}` : "no service in the stop evidence"),
    judge("restore: no task left in the cluster", Array.isArray(obj(tasks.ok ? tasks.value : null).tasks) && live.length === 0, "no RUNNING or PENDING task", `still running: ${live.join(", ")}`),
    judge("restore: the stop precedes the adoption", expect.adoptedAt !== null && Number.isFinite(at) && at <= expect.adoptedAt, `stopped ${String(s.captured_at)}, adopted ${expect.adoptedAt === null ? "?" : new Date(expect.adoptedAt).toISOString()}`, expect.adoptedAt === null ? "APPGEN shows no adoption" : "the stop was captured after APPGEN moved"),
  ];
  if (expect.heartbeats !== null && expect.heartbeats.integrated) {
    checks.push(judge("restore: no old-generation TASK# heartbeat after the stop (operator proof, not a lease)", expect.heartbeats.oldGenerationAfterStop.length === 0, "none", `fresh heartbeats from ${expect.heartbeats.oldGenerationAfterStop.join(", ")}`));
  } else {
    /* Said in the report, never silently absent: the stop is proven from ECS alone until L6-5A's TASK# is integrated. */
    checks.push(judge("restore: TASK# heartbeats (operator proof, not a lease)", true, "not integrated (L6-5A): the stop is proven from ECS alone", ""));
  }
  return checks;
}

/** The fencing probe's evidence slot (the probe itself is a later real-staging slice). */
export const RESTORE_FENCING_CASES = Object.freeze(["old-generation-ledger-write-refused", "old-generation-task-never-ready", "kms-side-effect-withheld", "new-generation-started"] as const);

export function judgeRestoreFencing(dir: string, expect: { readonly run: string; readonly newGeneration: number | null }): Check[] {
  const r = readEvidence(dir, RESTORE_FENCING_FILE, { ownRecord: true });
  if (!r.ok) return [fail("restore fencing", `${r.problem} (the real-staging fencing probe records it; no destructive or chain-affecting probe is part of this slice)`)];
  const rec = obj(r.value);
  const cases = obj(rec.cases);
  const checks: Check[] = [judge("restore fencing: this run, the adopted generation", rec.run_id === expect.run && expect.newGeneration !== null && rec.new_generation === expect.newGeneration, `run ${expect.run}, generation ${String(expect.newGeneration)}`, `run ${String(rec.run_id)}, generation ${String(rec.new_generation)}`)];
  for (const name of RESTORE_FENCING_CASES) {
    const c = obj(cases[name]);
    checks.push(judge(`restore fencing: ${name}`, c.observed === true, String(c.detail ?? "observed"), c.observed === false ? `NOT observed: ${String(c.detail ?? "")}` : "no evidence recorded"));
  }
  return checks;
}
