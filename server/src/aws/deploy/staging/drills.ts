// server/src/aws/deploy/staging/drills.ts
//
// ==================================================================
//  LIVE-6 FINAL CONVERGENCE: THE STAGING GATES THAT BIND L6-2 / L6-5B / L6-7 TO THE L6-6R HARNESS -- THE ALARMS, THE
//  MACHINE-PRODUCED GATE RECORDS, THE FLIP DRILL, THE RELAYER-ROTATION DRILL, THE RESTORE ALARMS
// ==================================================================
//
// Each gate below JUDGES evidence with the owning slice's own code -- it restates no contract:
//
//   alarms              `checkAlarmsEvidence` (L6-5B) over the capture's `alarms.json`: every contract alarm, its
//                       metric / math, namespace, Environment / Pool dimensions only, primary scope, class wiring, the
//                       suppression wiring, ActionsEnabled, the suppressors not stuck in ALARM outside an active window,
//                       nothing unknown in the game-server namespace -- plus the evidence's identity: the alarms were
//                       captured with this capture's manifest (environment, pools), and each contract alarm's ARN is
//                       `arn:<partition>:cloudwatch:<the runtime document's region>:<the app account>:alarm:<its name>`.
//                       Staging may configure EMPTY action lists (`--page-actions none --ticket-actions none`). No BUILD_ID.
//   generation-gate     (restore drill) the generation switch's machine record (`gate-generation.json`, written by
//                       `awsDeploy generation-gate --record`): `generationAttestationProblem` (L6-5B) against the app
//                       plan's own `generation_adoption`, AND a read-only cross-check of the record's `adoption_claim`
//                       against the ledger's canonical `APPGEN#HISTORY / GEN#<new>` (read live through L6-4's
//                       `readAdoptionRecord`): a plain JSON record is not integrity proof. Terraform itself still reads
//                       nothing cross-account (owner decision: it consumes the machine-produced attestation).
//   flip                (flip drill) L6-2's own flip record (`flip-record.json`, `18COSMOS/FLIP-EVIDENCE/v1`) and the
//                       captures: the window opened before the routing CAS; the CAS applied and settled; both pools
//                       restarted into their roles (L6-2's `checkRoleChange`: exit 5, a replacement); no exit 3 / 4 from
//                       either pool's SERVICE tasks since the window opened (from the COMPLETE cluster listing, L6-6P);
//                       `/gs*` on the new primary and every pool's exact route (L6-2's `checkPoolListenerRules`); the
//                       singleton roles on the new primary; the recovery of the old epoch settled (the window closed by it);
//                       the suppression bounded (<= 45 min, published for exactly the two pools, every suppressor OK once
//                       the window ended). A planned primary DRAIN is not a flip: nothing here covers it (A13 may page).
//   flip-alarms         (flip drill) the drill's live observations (`probe-flip-alarms.json`): an exit 3 inside the window
//                       still trips A1 (never suppressible), a suppressible alarm still failing after the window becomes
//                       actionable again, and only the flip's two pools' suppressors were ALARM during it.
//   relayer-rotation    (rotation drill) L6-2/L6-7's `relayer-rotation-gate --record` (`gate-relayer-rotation.json`):
//                       `rotationGateRecordProblem` (L6-5B), every pool of this deployment drained at the gate, the OLD
//                       queue read completely and empty, the NEW queue never consulted, and the configuration changed
//                       only afterwards (the gate saw the old address; the live document names the new one; every
//                       running task started after the gate). Unknown or unreadable: FAIL. No automatic queue migration.
//   restore-alarms      (restore drill) the drill's live observations (`probe-restore-alarms.json`, `restoreAlarmDrill.ts`):
//                       R1, A4g, A4i, R2 and R3 each FIRED after an alarm-pipeline injection with no action suppression,
//                       re-derived from the AWS captures; at least one while a staging flip-suppression overlap test was
//                       PROVEN active (both suppressors ALARM at the injection, from CloudWatch) and moved no routing --
//                       a restore is not a flip, and no restore suppression exists.
//
// NOTHING HERE READS AWS: every input is a file of the run's evidence directory or a reading the command made (L6-4's
// readers, live). Missing, unreadable or mismatched evidence is FAIL, never SKIP.

import * as path from "path";

import { ALARM_CONTRACT, checkAlarmsEvidence, expectedAlarms, SUPPRESSOR_TAIL_MS, suppressorName, type FlipWindowFacts } from "../../controlPlane/alarmContract";
import { ABNORMAL_EXITS, checkPoolListenerRules, checkPoolTargetGroups, checkRoleChange, cliTime, EXIT_ROLE_CHANGED, POOL_EVIDENCE_FILES } from "../../controlPlane/evidence";
import { FLIP_EVIDENCE_FORMAT, parseFlipRecord, type FlipRecord } from "../../controlPlane/flipRecord";
import { FLIP_SUPPRESSION } from "../../controlPlane/flipSuppression";
import type { Check } from "../deployVerify";
import { EVIDENCE_FILES, expectedNames } from "../deployVerify";
import { generationAttestationProblem, rotationGateRecordProblem, type GenerationAttestation } from "../gateRecords";
import { arr, EVIDENCE, evidenceName, fail, judge, num, obj, readEvidence, readEvidenceText, stableStringify } from "./evidence";
import { readClusterListing } from "./prerequisite";
import { adoptionOf, restoreSafe, type GenerationEvidence } from "./recovery";
import { BINDING_MS, contractMinDelayMs, deriveRestoreCase, INJECTION_KIND, overlapRoutingProblem, RESTORE_ALARM_DIR, RESTORE_CASE_ALARM, RESTORE_CASES, restoreAlarmName, restoreMetricOf, SKEW_MS } from "./restoreAlarmProbe";
import { SUPPRESSION_OVERLAP_KIND } from "../../controlPlane/suppressionOverlap";

type Json = unknown;

/** A time for a report line: ISO when it is one, else as given (evidence text never throws a judge). */
const isoText = (ms: unknown): string => (typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : String(ms));

export const DRILL_FILES = Object.freeze({
  /** `awsDeploy generation-gate ... --record <dir>/gate-generation.json` (created once by the gate itself). */
  generationGate: "gate-generation.json",
  /** `awsDeploy relayer-rotation-gate ... --record <dir>/gate-relayer-rotation.json`. */
  rotationGate: "gate-relayer-rotation.json",
  /** `gamesDoctor aws flip ... --flip-record <dir>/flip-record.json` (then flip-observe / recover with the same record). */
  flipRecord: "flip-record.json",
  flipAlarms: "probe-flip-alarms.json",
  restoreAlarms: "probe-restore-alarms.json",
});

export const FLIP_ALARM_DRILL_FORMAT = "18COSMOS/L6-6-FLIP-ALARM-DRILL/v1";
export const RESTORE_ALARM_DRILL_FORMAT = "18COSMOS/L6-6-RESTORE-ALARM-DRILL/v1";

/** L6-5B's never-suppressed alarms the brief names (A1, store uncertain, the money sweep, generation / adoption and
 *  identity-restore refusals, the relayer page, R1-R3): the contract must keep each of them unsuppressible. */
export const NEVER_SUPPRESSED = Object.freeze(["a1-unexpected-task-loss", "a3-store-uncertain", "a3-store-restart-loop", "a4-startup-refused", "a4g-generation-refused", "a4i-identity-restore-refused", "a5-money-sweep-stale", "a5b-money-sweep-games-failing", "a5c-money-sweep-passes-failing", "a15-relayer-paging", "r1-generation-lost", "r2-money-journal-ahead", "r3-restore-unverified"] as const);
/** The restore alarms a restore drill must see fire (never suppressed by an overlapping flip window). */
export const RESTORE_ALARM_CASES = Object.freeze(["r1-generation-lost", "a4g-generation-refused", "a4i-identity-restore-refused", "r2-money-journal-ahead", "r3-restore-unverified"] as const);

const specOf = (id: string) => ALARM_CONTRACT.alarms.find((a) => a.id === id);

/** An alarm's contract name in this environment (a pool-scoped alarm: any pool of the deployment; null: not a name). */
function contractAlarm(environment: string, pools: readonly string[], id: string, name: unknown): boolean {
  const spec = specOf(id);
  if (spec === undefined || typeof name !== "string") return false;
  if (spec.scope === "environment") return name === `gs-${environment}-${id}`;
  if (spec.scope === "primary") return name === `gs-${environment}-primary-${id}`;
  return pools.some((pool) => name === `gs-${environment}-${pool}-${id}`);
}

/* ------------------------------------------------------------------ */
/* alarms                                                               */
/* ------------------------------------------------------------------ */

export interface AlarmsGateExpect {
  readonly environment: string;
  readonly region: string;
  /** The app account (the runtime parameter ARN's): every alarm lives in it. */
  readonly account: string | null;
  readonly pools: readonly string[];
  readonly primaryPool: string;
  readonly escrow: boolean;
  readonly pageActions: readonly string[] | null;
  readonly ticketActions: readonly string[] | null;
  /** The run's flip window (flip drill), else null. */
  readonly flip: FlipWindowFacts | null;
}

/** The account of an ARN (`arn:<partition>:<service>:<region>:<account>:...`), or null. */
export const accountOf = (arn: string): string | null => /^arn:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]*:([0-9]{12}):/.exec(arn)?.[1] ?? null;

export function judgeAlarmsGate(dir: string, expect: AlarmsGateExpect): { readonly checks: Check[]; readonly measurements: Record<string, unknown> } {
  const alarms = readEvidence(dir, EVIDENCE_FILES.alarms);
  const manifest = readEvidence(dir, POOL_EVIDENCE_FILES.manifest);
  const capture = readEvidence(dir, EVIDENCE.capture);
  if (!alarms.ok) return { checks: [fail("alarms: evidence", `${alarms.problem} (capture-evidence writes alarms.json)`)], measurements: {} };
  const checks: Check[] = [];
  /* The capture's time is the judgment's time: the verdict never depends on when `certify` runs. */
  const capturedAt = capture.ok ? Date.parse(String(obj(capture.value).captured_at)) : Number.NaN;
  if (!capture.ok) checks.push(fail("alarms: the capture's time", capture.problem));
  /* 1. The evidence's identity: this environment's and these pools' capture, taken with this capture. */
  const m = manifest.ok ? obj(manifest.value) : {};
  const manifestAt = Date.parse(String(m.captured_at));
  const manifestPools = arr(m.pools).map(String).sort();
  checks.push(
    judge(
      "alarms: captured for this environment and these pools",
      manifest.ok && m.environment === expect.environment && manifestPools.join(",") === [...expect.pools].sort().join(",") && Number.isFinite(manifestAt) && Number.isFinite(capturedAt) && manifestAt <= capturedAt && capturedAt - manifestAt <= 15 * 60_000,
      `manifest.json: ${expect.environment}, pools [${manifestPools.join(", ")}], captured ${String(m.captured_at)} with this capture`,
      manifest.ok ? `manifest.json names ${String(m.environment)}, pools [${manifestPools.join(", ")}], captured ${String(m.captured_at)} (this run: ${expect.environment}, [${[...expect.pools].sort().join(", ")}], capture ${capture.ok ? String(obj(capture.value).captured_at) : "?"})` : manifest.problem,
    ),
  );
  /* 2. The contract itself (L6-5B's own judge; staging may have empty action lists), judged at the time the alarms were
     read: manifest.json is written right after alarms.json (its identity is checked above); capture.json only last. */
  const now = Number.isFinite(manifestAt) ? manifestAt : Number.isFinite(capturedAt) ? capturedAt : 0;
  checks.push(
    ...checkAlarmsEvidence(alarms.value, {
      environment: expect.environment,
      pools: expect.pools,
      primaryPool: expect.primaryPool,
      escrow: expect.escrow,
      services: true,
      pageActions: expect.pageActions,
      ticketActions: expect.ticketActions,
      flip: expect.flip,
      now,
    }).map((c) => ({ ...c, name: `alarms: ${c.name}` })),
  );
  /* 3. Stable resource identity: each contract alarm (and suppressor) is THIS account's, in THIS region, by its name. */
  const byName = new Map([...arr(obj(alarms.value).MetricAlarms), ...arr(obj(alarms.value).CompositeAlarms)].map(obj).map((a) => [String(a.AlarmName), a] as const));
  const wanted = [
    ...expectedAlarms({ environment: expect.environment, pools: expect.pools, primaryPool: expect.primaryPool, escrow: expect.escrow, services: true }).flatMap((e) => (e.spec.suppressible ? [e.name, `${e.name}-notify`] : [e.name])),
    ...expect.pools.map((p) => suppressorName(expect.environment, p)),
  ];
  const wrongArn = wanted.filter((name) => {
    const a = byName.get(name);
    if (a === undefined) return false; // "exists" is the contract check's
    const found = /^arn:([a-z0-9-]+):cloudwatch:([a-z0-9-]+):([0-9]{12}):alarm:(.+)$/.exec(String(a.AlarmArn ?? ""));
    return found === null || found[2] !== expect.region || (expect.account !== null && found[3] !== expect.account) || found[4] !== name;
  });
  checks.push(judge("alarms: stable identity (this account, this region, by name)", expect.account !== null && wrongArn.length === 0, `${wanted.length} alarm ARNs: ${expect.region}, account ${String(expect.account)}`, expect.account === null ? "the app account is not known from the runtime parameter ARN" : `alarm ARNs not this deployment's: ${wrongArn.slice(0, 8).join(", ")}`));
  /* 4. The never-suppressed list, from the contract (and each of them live wrapped by nothing: the contract judge above). */
  const suppressible = NEVER_SUPPRESSED.filter((id) => specOf(id)?.suppressible !== false);
  const flipOnly = ALARM_CONTRACT.alarms.filter((a) => a.suppressible).map((a) => a.id).sort();
  checks.push(judge("alarms: never suppressed -- losses, store, sweep, generation / restore, relayer page, R1-R3", suppressible.length === 0, `${NEVER_SUPPRESSED.length} alarms unsuppressible; suppressible only [${flipOnly.join(", ")}] (the planned flip's expected effects)`, `suppressible in the contract: ${suppressible.join(", ")}`));
  return { checks, measurements: { alarms: wanted.length, suppressible: flipOnly } };
}

/* ------------------------------------------------------------------ */
/* the generation-gate record (restore drill)                           */
/* ------------------------------------------------------------------ */

/** The app plan's `generation_adoption` (Terraform `show -json`: variables.<name>.value); null when absent or null. */
export function plannedGenerationAdoption(appPlan: Json): GenerationAttestation | null {
  const v = obj(obj(obj(appPlan).variables).generation_adoption).value;
  const o = obj(v);
  if (v === null || v === undefined || typeof o.generation !== "number" || typeof o.game_table !== "string" || typeof o.restore_id !== "string") return null;
  return { generation: o.generation, game_table: o.game_table, restore_id: o.restore_id };
}

export function judgeGenerationGateRecord(
  dir: string,
  expect: { readonly environment: string; readonly generation: number; readonly gameTable: string; readonly evidence: GenerationEvidence; readonly prerequisiteAt: string | null; readonly running?: ReadonlyMap<string, readonly Record<string, unknown>[]> },
): Check[] {
  const label = "generation gate";
  const rec = readEvidence(dir, DRILL_FILES.generationGate, { ownRecord: true });
  if (!rec.ok) return [fail(`${label}: the gate's own record`, `${rec.problem} (\`awsDeploy generation-gate ... --record <dir>/${DRILL_FILES.generationGate}\` before the switch)`)];
  const r = obj(rec.value);
  const plan = readEvidence(dir, evidenceName(EVIDENCE.terraformDir("app"), "plan.json"));
  const planned = plan.ok ? plannedGenerationAdoption(plan.value) : null;
  const checks: Check[] = [];
  const attestation = generationAttestationProblem(rec.value, planned, { environment: expect.environment });
  checks.push(judge(`${label}: the plan's generation_adoption is the gate's OPEN attestation`, plan.ok && attestation === null, `generation ${String(planned?.generation)}, ${String(planned?.game_table)}, restore ${restoreSafe(String(planned?.restore_id))}`, plan.ok ? String(attestation) : plan.problem));
  const a = obj(r.attestation);
  const ad = adoptionOf(expect.evidence);
  const appgen = expect.evidence.appgen !== null && expect.evidence.appgen.ok ? expect.evidence.appgen.value : null;
  checks.push(
    judge(
      `${label}: the attestation is this adoption and this serving document`,
      ad !== null && a.generation === ad.generation && a.generation === expect.generation && a.game_table === ad.game_table && a.game_table === expect.gameTable && a.restore_id === ad.restore_id && r.from_generation === ad.previous_generation,
      ad === null ? "" : `${ad.previous_generation} -> ${ad.generation} (${ad.game_table}, restore ${restoreSafe(ad.restore_id)})`,
      ad === null ? "APPGEN shows no adoption (not read, or never adopted)" : restoreSafe(`the record attests ${String(r.from_generation)} -> ${String(a.generation)} (${String(a.game_table)}, restore ${String(a.restore_id)}); APPGEN adopted ${ad.previous_generation} -> ${ad.generation} (${ad.game_table}, restore ${ad.restore_id}); the runtime document serves ${expect.generation} (${expect.gameTable})`),
    ),
  );
  /* The integrity cross-check: the record's claim = the ledger's own history item's = APPGEN's (read-only, live). */
  const h = expect.evidence.history ?? null;
  const history = h !== null && h.ok ? h.value : null;
  checks.push(
    judge(
      `${label}: adoption_claim = APPGEN#HISTORY/GEN#${ad?.generation ?? "?"} (read from the ledger)`,
      history !== null && ad !== null && appgen !== null && appgen.adoption !== null && typeof r.adoption_claim === "string" && r.adoption_claim === history.claim && history.claim === ad.claim && history.generation === ad.generation && history.game_table === ad.game_table && history.restore_id === ad.restore_id && history.previous_generation === ad.previous_generation,
      "the record's claim is the adoption's one transaction (APPGEN and its history item agree)",
      h === null ? "APPGEN#HISTORY was not read (no adoption, or L6-4's readers are not bound)" : !h.ok ? `APPGEN#HISTORY unreadable (${h.unreadable})` : history === null ? `no APPGEN#HISTORY/GEN#${ad?.generation ?? "?"}: the adoption's transaction did not land` : "the record's adoption_claim, the history item and APPGEN do not all name the same adoption (a plain JSON record is never integrity proof)",
    ),
  );
  const gated = Date.parse(String(r.gated_at));
  const since = Date.parse(String(expect.prerequisiteAt));
  checks.push(judge(`${label}: gated after the adoption, before the certification`, ad !== null && Number.isFinite(gated) && gated >= ad.adopted_at && (!Number.isFinite(since) || gated <= since), `gated ${String(r.gated_at)}`, `gated ${String(r.gated_at)}; adopted ${ad === null ? "?" : isoText(ad.adopted_at)}; prerequisite ${String(expect.prerequisiteAt)}`));
  /* The switch came AFTER the gate: every task now serving the new generation started after the gate ran (ECS's own
     times; a task CREATED after it also started after it) -- the gate's attestation was never typed in after the fact. */
  if (expect.running !== undefined) {
    const tasks = [...expect.running.entries()].flatMap(([pool, list]) => list.map((t) => ({ pool, t })));
    const early = tasks.filter(({ t }) => !((cliTime(t.startedAt ?? t.createdAt) ?? Number.NEGATIVE_INFINITY) > gated)).map(({ pool, t }) => `${pool}:${String(t.taskArn).split("/").pop()}`);
    checks.push(judge(`${label}: the switch came after the gate (every new-generation task started after it)`, Number.isFinite(gated) && tasks.length > 0 && early.length === 0, `${tasks.length} task(s) started after ${String(r.gated_at)}`, tasks.length === 0 ? "no running task to date the switch by" : `started before the gate: ${early.join(", ")}`));
  }
  return checks;
}

/* ------------------------------------------------------------------ */
/* the flip drill                                                        */
/* ------------------------------------------------------------------ */

/** The flip record in the evidence, parsed by L6-2's own parser (null + problem when absent or not one). */
export function flipRecordOf(dir: string): { readonly record: FlipRecord | null; readonly problem: string | null } {
  const text = readEvidenceText(dir, DRILL_FILES.flipRecord);
  if (!text.ok) return { record: null, problem: text.problem };
  const parsed = parseFlipRecord(text.text);
  return "problem" in parsed ? { record: null, problem: parsed.problem } : { record: parsed, problem: null };
}

/** The window a flip record states (for the alarm judge), or null. */
export const flipWindowOf = (record: FlipRecord | null): FlipWindowFacts | null =>
  record === null || record.window === null ? null : { from: record.from, to: record.to, opened_at: record.window.opened_at, expires_at: record.window.expires_at, closed_at: record.window.closed_at };

/** When a window's suppression ended (its close, or its expiry, whichever is first). */
const windowEnd = (w: NonNullable<FlipRecord["window"]>): number => Math.min(w.expires_at, w.closed_at ?? Number.POSITIVE_INFINITY);

export function judgeFlipDrill(dir: string, expect: { readonly environment: string; readonly pools: readonly string[]; readonly primaryPool: string; readonly escrow: boolean }): Check[] {
  const { record, problem } = flipRecordOf(dir);
  if (record === null) return [fail("flip: L6-2's flip record", `${String(problem)} (\`gamesDoctor aws flip ... --flip-record <dir>/${DRILL_FILES.flipRecord}\`)`)];
  const checks: Check[] = [];
  const w = record.window;
  const cas = record.cas;
  checks.push(
    judge(
      "flip: this environment's flip onto the primary",
      record.format === FLIP_EVIDENCE_FORMAT && record.environment === expect.environment && record.from !== record.to && expect.pools.includes(record.from) && expect.pools.includes(record.to) && record.to === expect.primaryPool,
      `${record.from} -> ${record.to}${record.rollback === true ? " (rollback)" : ""}, ${expect.environment}`,
      `the record flips ${record.from} -> ${record.to} in ${record.environment} (this run: ${expect.environment}, primary ${expect.primaryPool}, pools [${expect.pools.join(", ")}])`,
    ),
  );
  checks.push(judge("flip: the roles settled", record.verdict === "roles-settled", "verdict roles-settled", `verdict ${record.verdict} (resume with flip-observe; certify only a settled flip)`));
  /* The drill certifies a FORWARD flip (both pools' role changes observable). A rollback (`flip B A --rollback`: the pool
     that failed to promote may show no exit 5) is not a certifiable drill: certify the forward flip instead. */
  checks.push(judge("flip: a forward flip (a rollback is not a certifiable drill)", record.rollback !== true, "forward", "the record is a rollback: certify a forward flip drill"));
  checks.push(
    judge(
      "flip: the window opened BEFORE the routing CAS",
      w !== null && cas !== null && Number.isFinite(w.opened_at) && w.opened_at <= cas.at,
      w === null || cas === null ? "" : `opened ${isoText(w.opened_at)}, CAS ${isoText(cas.at)}`,
      w === null ? "no observability window in the record" : cas === null ? "no routing CAS in the record" : `the window opened ${isoText(w.opened_at)}, after the CAS ${isoText(cas.at)}`,
    ),
  );
  checks.push(judge("flip: the routing CAS applied and settled", cas !== null && cas.outcome === "applied" && cas.version === record.expected_version + 1, `SYSTEM/ROUTING v${record.expected_version} -> v${record.expected_version + 1}`, cas === null ? "no CAS" : `CAS ${cas.outcome}, version ${String(cas.version)} (expected ${record.expected_version + 1})`));
  /* The singleton roles and both pools' writers moved (the record's own snapshots, observed, never assumed). */
  const before = record.before;
  const after = record.after;
  const roleOk = after !== null && after.identity_writer !== null && after.identity_writer.pool === record.to && (!expect.escrow || (after.relayer !== null && after.relayer.pool === record.to));
  const poolsMoved = before !== null && after !== null && [record.from, record.to].every((p) => (after.pools[p]?.epoch ?? 0) > (before.pools[p]?.epoch ?? Number.POSITIVE_INFINITY));
  checks.push(judge("flip: both tasks restarted into their roles (the record's snapshots)", roleOk && poolsMoved, `identity writer${expect.escrow ? " and relayer" : ""} on ${record.to}; both pools' writer epochs moved`, `after the flip: identity writer on ${String(after?.identity_writer?.pool)}${expect.escrow ? `, relayer on ${String(after?.relayer?.pool)}` : ""}; pool epochs moved: ${String(poolsMoved)}`));
  /* L6-2's role-change judge over the per-pool captures, from the window's opening (an exit 3/4 between it and the CAS counts). */
  const since = w !== null ? Math.min(w.opened_at, cas?.at ?? w.opened_at) : cas?.at ?? Number.NaN;
  for (const pool of [record.from, record.to]) {
    const stopped = readEvidence(dir, POOL_EVIDENCE_FILES.stoppedTasks(pool));
    const running = readEvidence(dir, POOL_EVIDENCE_FILES.runningTasks(pool));
    if (!stopped.ok || !running.ok) {
      checks.push(fail(`flip: role change ${pool}`, stopped.ok ? (running.ok ? "" : running.problem) : stopped.problem));
      continue;
    }
    checks.push(...checkRoleChange(pool, expect.environment, stopped.value, running.value, since).map((c) => ({ ...c, name: `flip: ${c.name}` })));
  }
  /* The COMPLETE cluster listing (L6-6P): no service task of either pool stopped with a loss (3) or a store restart (4)
     since the window opened -- the per-pool capture is a bounded view; this one is every page. */
  const cluster = readEvidence(dir, EVIDENCE.clusterTasks);
  const listing = cluster.ok ? readClusterListing(cluster.value, expect.environment) : null;
  if (listing === null || !listing.ok) checks.push(fail("flip: no exit 3 / 4 in the window (complete cluster listing)", listing === null ? (cluster.ok ? "" : cluster.problem) : listing.problem));
  else {
    const names = expectedNames(expect.environment, 1);
    const groups = new Set([record.from, record.to].map((p) => `service:${names.service(p)}`));
    const exits = listing.tasks
      .filter((t) => groups.has(String(t.group)))
      .flatMap((t) => arr(t.containers).map(obj).filter((c) => c.name === "game-server").map((c) => ({ task: String(String(t.taskArn).split("/").pop()), exit: num(c.exitCode), at: cliTime(t.stoppedAt) })))
      .filter((x) => x.at !== null && x.at >= since);
    const abnormal = exits.filter((x) => x.exit !== null && ABNORMAL_EXITS.includes(x.exit));
    const roleChanges = exits.filter((x) => x.exit === EXIT_ROLE_CHANGED);
    checks.push(judge("flip: no exit 3 / 4 in the window (complete cluster listing)", abnormal.length === 0 && roleChanges.length >= 2, `${roleChanges.length} exit ${EXIT_ROLE_CHANGED} (the expected role transition), no loss or store restart`, abnormal.length > 0 ? `${abnormal.map((x) => `${x.task}: exit ${x.exit}`).join(", ")} -- abnormal even inside a planned flip` : `${roleChanges.length} exit ${EXIT_ROLE_CHANGED} seen in the complete listing (each pool's service must show its role change)`));
  }
  /* /gs* on the new primary, every pool's exact route (L6-2's judge, on this capture). */
  const tgs = readEvidence(dir, POOL_EVIDENCE_FILES.targetGroups);
  const rules = readEvidence(dir, POOL_EVIDENCE_FILES.listenerRules);
  if (!tgs.ok || !rules.ok) checks.push(fail("flip: /gs* and the pool routes", tgs.ok ? (rules.ok ? "" : rules.problem) : tgs.problem));
  else {
    const groups = checkPoolTargetGroups(tgs.value, { environment: expect.environment, pools: expect.pools });
    const routes = Object.fromEntries(expect.pools.map((p) => [p, `/gs/p/${p}`]));
    checks.push(...checkPoolListenerRules(rules.value, { primary: record.to, routes, targetGroups: groups.arns }).map((c) => ({ ...c, name: `flip: ${c.name}` })));
  }
  /* The recovery of the old epoch settled (only `recover --flip-record` closes a settled flip's window), and the
     suppression was bounded: at most 45 minutes, for exactly the flip's two pools, ended before the capture. */
  checks.push(judge("flip: the recovery of the superseded ownership settled", w !== null && w.closed_at !== null && cas !== null && w.closed_at >= cas.at && record.verdict === "roles-settled", `the window closed ${w?.closed_at === null || w === null ? "?" : isoText(w.closed_at)} by the settled recovery`, "the window was not closed by a settled recovery (`gamesDoctor aws recover <A> --apply --flip-record ...` until RECOVERY SETTLED)"));
  const capture = readEvidence(dir, EVIDENCE.capture);
  const capturedAt = capture.ok ? Date.parse(String(obj(capture.value).captured_at)) : Number.NaN;
  checks.push(
    judge(
      "flip: the alarm suppression was bounded",
      w !== null && w.expires_at - w.opened_at <= FLIP_SUPPRESSION.maxWindowMs && w.expires_at > w.opened_at && (w.suppression === "published" || w.suppression === "closed") && Number.isFinite(capturedAt) && capturedAt >= windowEnd(w) + SUPPRESSOR_TAIL_MS,
      w === null ? "" : `${Math.round((w.expires_at - w.opened_at) / 60_000)} min window for [${record.from}, ${record.to}], ${String(w.suppression)}; ended ${isoText(windowEnd(w))}, captured after it`,
      w === null ? "no window" : w.suppression !== "published" && w.suppression !== "closed" ? `the window's suppression was ${String(w.suppression)} (the drill must publish it)` : !(Number.isFinite(capturedAt) && capturedAt >= windowEnd(w) + SUPPRESSOR_TAIL_MS) ? "the evidence was captured before the window (and its tail) ended: capture again after it" : `a window of ${Math.round((w.expires_at - w.opened_at) / 60_000)} min`,
    ),
  );
  return checks;
}

/* ------------------------------------------------------------------ */
/* the flip drill's live alarm observations                              */
/* ------------------------------------------------------------------ */

/**
 * `probe-flip-alarms.json` (FLIP_ALARM_DRILL_FORMAT): what the drill OBSERVED in CloudWatch during and after the window
 * (describe-alarms / describe-alarm-history), bound to the flip record's window:
 *   exit3-in-window-pages-a1              { task_arn, exit_code: 3, stopped_at, alarm: gs-<env>-a1-unexpected-task-loss,
 *                                           state: "ALARM", alarm_at >= stopped_at, actions_suppressed: false } -- the
 *                                           stop inside the window: A1 is never suppressible (L6-5B H1, FILL-free).
 *   suppressed-alarm-actionable-after-window { alarm: a suppressible alarm of a flip pool, during: { at in the window,
 *                                           composite_state: "ALARM", actions_suppressed_by: "Alarm" }, after: { at >=
 *                                           the window's end, composite_state: "ALARM", actions_suppressed_by: "None" } }
 *   suppressors-during-window             { at in the window, states: { <pool>: "ALARM" | "OK" | ... } }: ALARM for
 *                                           exactly the flip's two pools, never another pool's.
 */
export function judgeFlipAlarmDrill(dir: string, expect: { readonly run: string; readonly environment: string; readonly pools: readonly string[] }): Check[] {
  const { record } = flipRecordOf(dir);
  const r = readEvidence(dir, DRILL_FILES.flipAlarms, { ownRecord: true });
  if (!r.ok) return [fail("flip alarms: the drill's observations", `${r.problem} (the flip drill records ${DRILL_FILES.flipAlarms})`)];
  const rec = obj(r.value);
  const w = record?.window ?? null;
  const checks: Check[] = [];
  const f = obj(rec.flip);
  checks.push(judge("flip alarms: this run, this flip's window", rec.format === FLIP_ALARM_DRILL_FORMAT && rec.run_id === expect.run && w !== null && record !== null && f.from === record.from && f.to === record.to && f.opened_at === w.opened_at && f.expires_at === w.expires_at, w === null || record === null ? "" : `${record.from} -> ${record.to}, window ${isoText(w.opened_at)}`, `${String(rec.format)} run ${String(rec.run_id)} flip ${JSON.stringify(rec.flip ?? null)} (the flip record's window: ${w === null ? "none" : `${w.opened_at}..${w.expires_at}`})`));
  if (w === null || record === null) return checks;
  const end = windowEnd(w);
  const inWindow = (at: unknown) => typeof at === "number" && at >= w.opened_at && at < end;
  const cases = obj(rec.cases);
  /* An exit 3 inside the window still trips A1. */
  const a1 = obj(cases["exit3-in-window-pages-a1"]);
  const a1Name = `gs-${expect.environment}-a1-unexpected-task-loss`;
  checks.push(
    judge(
      "flip alarms: an exit 3 during the flip still trips A1",
      a1.exit_code === 3 && inWindow(a1.stopped_at) && a1.alarm === a1Name && a1.state === "ALARM" && typeof a1.alarm_at === "number" && a1.alarm_at >= (a1.stopped_at as number) && a1.actions_suppressed === false && specOf("a1-unexpected-task-loss")?.suppressible === false,
      `task ${String(a1.task_arn).split("/").pop()} exit 3 at ${isoText(Number(a1.stopped_at))} (inside the window): ${a1Name} ALARM, actions not suppressed`,
      cases["exit3-in-window-pages-a1"] === undefined ? "no observation (the drill injects one exit 3 inside the window)" : `exit ${String(a1.exit_code)} at ${String(a1.stopped_at)} (window ${w.opened_at}..${end}), ${String(a1.alarm)} ${String(a1.state)} at ${String(a1.alarm_at)}, suppressed ${String(a1.actions_suppressed)}`,
    ),
  );
  /* A suppressible alarm that still fails after the window becomes actionable again. */
  const s = obj(cases["suppressed-alarm-actionable-after-window"]);
  const during = obj(s.during);
  const afterObs = obj(s.after);
  const suppressibleOfFlip = [record.from, record.to].flatMap((p) => ALARM_CONTRACT.alarms.filter((a) => a.suppressible).map((a) => (a.scope === "primary" ? `gs-${expect.environment}-primary-${a.id}` : `gs-${expect.environment}-${p}-${a.id}`)));
  checks.push(
    judge(
      "flip alarms: a still-failing suppressible alarm becomes actionable after the window",
      typeof s.alarm === "string" && suppressibleOfFlip.includes(s.alarm) && inWindow(during.at) && during.composite_state === "ALARM" && during.actions_suppressed_by === "Alarm" && typeof afterObs.at === "number" && afterObs.at >= end && afterObs.composite_state === "ALARM" && afterObs.actions_suppressed_by === "None",
      `${String(s.alarm)}-notify: suppressed by its pool's window during it, actionable (not suppressed) at ${isoText(Number(afterObs.at))}`,
      cases["suppressed-alarm-actionable-after-window"] === undefined ? "no observation (the drill keeps one suppressible condition failing past the window's end)" : `${String(s.alarm)}: during ${JSON.stringify(during)}, after ${JSON.stringify(afterObs)} (window end ${isoText(end)})`,
    ),
  );
  /* Only the flip's two pools were suppressed. */
  const sup = obj(cases["suppressors-during-window"]);
  const states = obj(sup.states);
  const others = expect.pools.filter((p) => p !== record.from && p !== record.to);
  checks.push(
    judge(
      "flip alarms: only the flip's two pools were suppressed",
      inWindow(sup.at) && states[record.from] === "ALARM" && states[record.to] === "ALARM" && others.every((p) => states[p] === "OK") && Object.keys(states).every((p) => expect.pools.includes(p)),
      `suppressors ALARM for [${record.from}, ${record.to}]${others.length > 0 ? `, OK for [${others.join(", ")}]` : ""} during the window`,
      cases["suppressors-during-window"] === undefined ? "no observation of the suppressors during the window" : `during the window: ${JSON.stringify(states)} at ${String(sup.at)}`,
    ),
  );
  return checks;
}

/* ------------------------------------------------------------------ */
/* the relayer-address rotation drill                                    */
/* ------------------------------------------------------------------ */

export function judgeRotationDrill(
  dir: string,
  expect: { readonly environment: string; readonly from: string | null; readonly to: string | null; readonly pools: readonly string[]; readonly configuredRelayer: string | null; readonly prerequisiteAt: string | null; readonly running: ReadonlyMap<string, readonly Record<string, unknown>[]> },
): Check[] {
  if (expect.from === null || expect.to === null) return [fail("relayer rotation: the addresses", "--from-relayer and --to-relayer name the rotation this drill certifies")];
  const rec = readEvidence(dir, DRILL_FILES.rotationGate, { ownRecord: true });
  if (!rec.ok) return [fail("relayer rotation: the gate's own record", `${rec.problem} (\`awsDeploy relayer-rotation-gate ... --record <dir>/${DRILL_FILES.rotationGate}\` BEFORE the address changes)`)];
  const r = obj(rec.value);
  const checks: Check[] = [];
  const problem = rotationGateRecordProblem(rec.value, { environment: expect.environment, from: expect.from, to: expect.to });
  checks.push(judge("relayer rotation: the gate was OPEN for exactly this rotation (the old address configured, the old queue empty)", problem === null, `${expect.from} -> ${expect.to}: OPEN`, String(problem)));
  const gateChecks = arr(r.checks).map(obj);
  const status = (name: string) => gateChecks.find((c) => c.name === name)?.status;
  const recordPools = arr(r.pools).map(String).sort();
  const undrained = expect.pools.filter((p) => status(`drained ${p}`) !== "pass");
  checks.push(judge("relayer rotation: every pool drained at the gate", recordPools.join(",") === [...expect.pools].sort().join(",") && undrained.length === 0, `[${recordPools.join(", ")}] desired = running = pending = 0`, `the gate judged pools [${recordPools.join(", ")}] (this deployment: [${[...expect.pools].sort().join(", ")}]); not proven drained: ${undrained.join(", ") || "-"}`));
  checks.push(judge(`relayer rotation: RELAYQ#<old> read completely (strong, every page) and empty`, r.queue === "empty" && status(`RELAYQ#${expect.from} empty (strongly consistent, every page)`) === "pass", "the old queue: empty, every page read", `queue ${String(r.queue)}, check ${String(status(`RELAYQ#${expect.from} empty (strongly consistent, every page)`))} (unknown or unread is never empty)`));
  checks.push(judge("relayer rotation: the new address's queue was never used to infer safety", status(`RELAYQ#${expect.to}`) === "skipped" && gateChecks.every((c) => !(c.name === `RELAYQ#${expect.to}` && c.status === "pass")), `RELAYQ#${expect.to}: never consulted`, `RELAYQ#${expect.to} was ${String(status(`RELAYQ#${expect.to}`))} in the gate`));
  /* Only afterwards: the gate saw the OLD configuration; the live one names the NEW address; every running task started
     after the gate (the pools restarted on the changed configuration, never before it). */
  const gated = Date.parse(String(r.gated_at));
  const since = Date.parse(String(expect.prerequisiteAt));
  /* ECS's own times (startedAt; createdAt precedes it, so a task CREATED after the gate also started after it). */
  const early = expect.pools.flatMap((p) => (expect.running.get(p) ?? []).filter((t) => !((cliTime(t.startedAt ?? t.createdAt) ?? Number.NEGATIVE_INFINITY) > gated)).map((t) => `${p}:${String(t.taskArn).split("/").pop()}`));
  checks.push(
    judge(
      "relayer rotation: the configuration changed only after the gate",
      r.configured_relayer === expect.from && expect.configuredRelayer === expect.to && Number.isFinite(gated) && (!Number.isFinite(since) || gated <= since) && early.length === 0 && expect.pools.some((p) => (expect.running.get(p) ?? []).length > 0),
      `at the gate (${String(r.gated_at)}) ${expect.from}; now ${expect.to}; every running task started after the gate`,
      `at the gate ${String(r.configured_relayer)}, now ${String(expect.configuredRelayer)}; gated ${String(r.gated_at)}, prerequisite ${String(expect.prerequisiteAt)}${early.length > 0 ? `; started before the gate: ${early.join(", ")}` : ""}`,
    ),
  );
  return checks;
}

/* ------------------------------------------------------------------ */
/* the restore drill's live alarm observations                           */
/* ------------------------------------------------------------------ */

/**
 * `probe-restore-alarms.json` (RESTORE_ALARM_DRILL_FORMAT), produced by `restoreAlarmDrill.ts` -- per RESTORE_ALARM_CASES:
 *   { alarm: its contract name (R3: the injected pool's), injected_at, alarm_at, state: "ALARM", actions_suppressed: false,
 *     pre_injection: { at, state != ALARM }, injection: { kind: "alarm-pipeline-injection", the probe task, its log stream,
 *     the contract metric and value }, history_read_at, suppression_overlap: null | { the staging flip-suppression overlap
 *     test's window and pools, and per pool the suppressor's proof: ALARM in describe-alarms just before the injection,
 *     and its last StateUpdate at or before the injection (describe-alarm-history read after it) to ALARM, inside this
 *     test's window }, overlapping_flip_window: null }
 * -- and at least one case inside the overlap test. A restore is not a flip, and none of these is ever suppressed (the
 * contract keeps them unsuppressible; `alarms` proves no composite wraps them live).
 *
 * STRENGTHENED (restore-drill tooling, owner-approved; the format is unchanged, the judge only asks for more):
 *   - every case is RE-DERIVED from the AWS captures in `restore-alarms/` (`deriveRestoreCase`, the producer's own
 *     derivation) and must equal the record: a typed record, or one its captures contradict, never passes;
 *   - the injection is named an alarm-pipeline injection of the alarm's own contract metric (never a claimed real fault);
 *   - the alarm was not ALARM before the injection, and fired no earlier than the contract's (datapoints - 1) periods after
 *     it (R3: 59 minutes -- the real sixty-period contract) and within the binding after that;
 *   - a self-reported `overlapping_flip_window` is never evidence (a case carrying one FAILS); an overlap counts only with
 *     both suppressors' CloudWatch proof, and the overlap test must have left SYSTEM/ROUTING unchanged (read at its close).
 */
export function judgeRestoreAlarmDrill(dir: string, expect: { readonly run: string; readonly environment: string; readonly pools: readonly string[] }): Check[] {
  const r = readEvidence(dir, DRILL_FILES.restoreAlarms, { ownRecord: true });
  if (!r.ok) return [fail("restore alarms: the drill's observations", `${r.problem} (the restore drill records ${DRILL_FILES.restoreAlarms}: run-restore-alarm-probe, then stage-probe restore-alarms record)`)];
  const rec = obj(r.value);
  const cases = obj(rec.cases);
  const checks: Check[] = [judge("restore alarms: this run's drill", rec.format === RESTORE_ALARM_DRILL_FORMAT && rec.run_id === expect.run && rec.environment === expect.environment, `run ${expect.run}, ${expect.environment}`, `${String(rec.format)} run ${String(rec.run_id)} environment ${String(rec.environment)}`)];
  const ctx = { dir, run: expect.run, environment: expect.environment };
  let overlapped = 0;
  for (const c of RESTORE_CASES) {
    const id = RESTORE_CASE_ALARM[c];
    const x = obj(cases[id]);
    const inj = obj(x.injection);
    const pre = obj(x.pre_injection);
    const injected = typeof x.injected_at === "number" ? x.injected_at : Number.NaN;
    const earliest = injected + contractMinDelayMs(c);
    const selfReported = x.overlapping_flip_window !== null && x.overlapping_flip_window !== undefined;
    const ok =
      contractAlarm(expect.environment, expect.pools, id, x.alarm) &&
      specOf(id)?.suppressible === false &&
      typeof x.injected_at === "number" &&
      typeof x.alarm_at === "number" &&
      x.alarm_at >= x.injected_at &&
      x.alarm_at >= earliest &&
      x.alarm_at <= earliest + BINDING_MS &&
      x.state === "ALARM" &&
      x.actions_suppressed === false &&
      inj.kind === INJECTION_KIND &&
      inj.case === c &&
      inj.metric === restoreMetricOf(c) &&
      (specOf(id)?.scope !== "pool" || x.alarm === restoreAlarmName(expect.environment, c, String(inj.pool))) &&
      typeof pre.at === "number" &&
      pre.at <= injected + SKEW_MS &&
      typeof pre.state === "string" &&
      pre.state !== "ALARM" &&
      !selfReported;
    checks.push(
      judge(
        `restore alarms: ${id} fires under its injected condition, never suppressed`,
        ok,
        `${String(x.alarm)} ALARM ${Math.round((Number(x.alarm_at) - injected) / 1000)} s after an ${INJECTION_KIND} of ${String(inj.metric)} (${String(pre.state)} before it; the contract's earliest: ${Math.round(contractMinDelayMs(c) / 1000)} s)`,
        cases[id] === undefined
          ? "no observation (the drill injects this condition)"
          : selfReported
            ? `${String(x.alarm)}: a self-reported overlapping_flip_window is never evidence (the overlap is proven from CloudWatch: suppression_overlap)`
            : `${String(x.alarm)} ${String(x.state)} injected ${String(x.injected_at)} alarm ${String(x.alarm_at)} (contract earliest ${String(earliest)}, bound ${String(earliest + BINDING_MS)}) suppressed ${String(x.actions_suppressed)}; injection ${String(inj.kind)} of ${String(inj.metric)}; before it ${String(pre.state)} at ${String(pre.at)}`,
      ),
    );
    /* The record is what AWS answered: the same derivation, over the same captures, gives the same case. */
    const derived = cases[id] === undefined ? null : deriveRestoreCase(ctx, c);
    checks.push(
      judge(
        `restore alarms: ${id} is what AWS answered (re-derived from ${RESTORE_ALARM_DIR}/)`,
        derived !== null && derived.kind === "observed" && stableStringify(derived.value) === stableStringify(cases[id]),
        "the record equals the derivation from the probe task, its log, describe-alarms and describe-alarm-history",
        derived === null ? "no observation" : derived.kind !== "observed" ? `the captures do not show it (${derived.kind}: ${derived.reasons.join("; ")})` : "the record differs from what its captures show (a record is never typed)",
      ),
    );
    const o = x.suppression_overlap === null || x.suppression_overlap === undefined ? null : obj(x.suppression_overlap);
    if (o !== null) {
      const pools = Array.isArray(o.pools) ? o.pools.map(String) : [];
      const proofs = Array.isArray(o.suppressors) ? o.suppressors.map(obj) : [];
      const floor = Math.floor(Number(o.opened_at) / 60_000) * 60_000;
      const proven =
        o.kind === SUPPRESSION_OVERLAP_KIND &&
        pools.length === 2 &&
        pools[0] !== pools[1] &&
        typeof o.opened_at === "number" &&
        typeof o.expires_at === "number" &&
        o.opened_at <= injected &&
        injected < o.expires_at &&
        o.expires_at - o.opened_at <= FLIP_SUPPRESSION.maxWindowMs &&
        proofs.length === 2 &&
        pools.every((pool) => {
          const p = proofs.find((q) => q.pool === pool);
          return p !== undefined && p.alarm === suppressorName(expect.environment, pool) && p.pre_state === "ALARM" && p.state_at_injection === "ALARM" && typeof p.pre_at === "number" && p.pre_at <= injected + SKEW_MS && typeof p.history_alarm_at === "number" && p.history_alarm_at <= injected && p.history_alarm_at >= floor;
        });
      if (proven) overlapped += 1;
      checks.push(
        judge(
          `restore alarms: ${id} -- both suppressors of the staging flip-suppression overlap test were ALARM at the injection (CloudWatch)`,
          proven,
          `[${pools.join(", ")}] window ${isoText(o.opened_at)}..${isoText(o.expires_at)}: each suppressor ALARM before the injection, its last state change at or before it to ALARM`,
          `the suppressor observations do not prove the window was active at the injection: ${JSON.stringify(o).slice(0, 400)}`,
        ),
      );
    }
  }
  checks.push(
    judge(
      "restore alarms: never suppressed while the planned-flip suppression was genuinely active (a staging flip-suppression overlap test, observed)",
      overlapped >= 1,
      `${overlapped} of ${RESTORE_ALARM_CASES.length} fired, actions not suppressed, with both suppressors proven ALARM at the injection`,
      "no restore alarm was observed firing while the flip-suppression mechanism was proven active (inject one counter case inside `gamesDoctor aws suppression-overlap`; a self-reported window is never evidence)",
    ),
  );
  if (overlapped >= 1) {
    const routing = overlapRoutingProblem(dir);
    checks.push(judge("restore alarms: the overlap test moved no routing (SYSTEM/ROUTING read at its open and its close)", routing === null, "SYSTEM/ROUTING unchanged: a suppression test, not a routing flip", String(routing)));
  }
  return checks;
}

/** For the report: the run's configured action lists as given (`none` = empty; staging may have none). */
export const actionsText = (list: readonly string[] | null): string => (list === null ? "not judged" : list.length === 0 ? "none" : list.join(","));
