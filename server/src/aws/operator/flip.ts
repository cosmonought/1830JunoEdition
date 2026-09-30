// server/src/aws/operator/flip.ts
//
// ==================================================================
//  LIVE-6 L6-2: THE PRODUCTION PRIMARY FLIP A -> B -- PREFLIGHT, THE ROUTING CAS, THE ROLE-CHANGE OBSERVATION
// ==================================================================
//
// `gamesDoctor aws flip <A> <B> --expect-version <N> --note "..." --evidence <dir> --flip-record <file> [--apply]` and
// `gamesDoctor aws flip-observe --flip-record <file>`. The whole procedure (infra/aws/README.md "Flip") is:
//
//   F0 PREFLIGHT   (always; a dry run stops here and writes nothing -- not even evidence)
//                    data plane (strong reads): the routing is at exactly version N and names A; POOL#A and POOL#B are
//                    readable, carry nothing this build never writes, and B's has been taken (a task of B exists); APPGEN
//                    and the serving table's SYSTEM/GENERATION are the configuration's (the tasks' own startup rules,
//                    L6-4); A's current task holds the identity-writer role; each pool's runtime document -- read and
//                    parsed by the TASK'S OWN parser -- is v2, for its pool, on the same tables, with the same trusted
//                    route table naming both A and B;
//                    control plane (the evidence directory, captured within `maxEvidenceAgeMs`): both services settled
//                    (no deployment in progress) and each behind its own target group; A's and B's targets healthy (B's is
//                    L6-1's non-primary router, readiness 200); `/gs*` -> A's group and each pool's exact ws_path -> its
//                    own, nothing shadowed; every rollback target of both families declares L6-4's identity layout.
//                    The operator names A -> B explicitly, and `--expect-version` binds the flip to the routing inspected.
//   F1 WINDOW      the planned-flip observability window opens (`AUDIT operator.flip-window {phase: "open", expires_at}`
//                  and the record's `window`) BEFORE the CAS: from the CAS on, A's and B's exit-5 role changes are expected.
//   F2 CAS         L6-3's `set-primary` -- L5-3's `setPrimaryPool` compare-and-swap at exactly (N, claim), with its OPRUN#
//                  evidence written first. A lost answer settles by the routing's claim (L6-3); `unknown` STOPS here (re-run
//                  the same flip: it can never move the routing twice; `flip-observe` if the routing shows the run).
//   F3 OBSERVE     (strong reads, every `pollMs`, bounded by `observeMs`) -- the routing still names B at N+1; POOL#A AND
//                  POOL#B were each taken again (epoch above the preflight's: each task stopped -- exit 5 -- and its ECS
//                  replacement started and took its pool); the identity-writer role is held by B's CURRENT task at a newer
//                  epoch (the promoted task took it inside its transaction conditioned on the routing and its pool epoch,
//                  BEFORE it loaded identity: the certified L5-7 order); with escrow, the relayer mirror too; A holds no
//                  singleton role. The bound passing first is `timeout`: the procedure STOPS -- nothing is assumed.
//                  Promotion is never faked in-process: only the restarted tasks' own takeovers can satisfy this.
//   (IN PARALLEL with F3, as soon as the CAS landed -- review M2: until /gs* forwards to B, the identity HTTP API reaches
//   A's router, which answers it 503) `terraform apply` with `pools.<B>.primary = true` (the /gs* rule's target only; the
//   plan refuses until the routing names B); then capture-evidence, `awsDeploy verify --flip-record` (exit 5 of both pools
//   after the CAS, both replacements running, no exit 3/4, /gs* -> B), and `gamesDoctor aws recover <A> --flip-record`
//   (recovery.ts), whose settled pass closes the window.
//
// Everything is recorded in the flip record (`controlPlane/flipRecord.ts`, 18COSMOS/FLIP-EVIDENCE/v1): L6-6's evidence.
//
// INTERRUPTED OR UNCERTAIN (review H1). The CLI never writes a new flip over a record whose window opened. A record whose
// CAS outcome is not known -- the process ended between the window and the CAS's answer (`cas` null), the answer was
// `unknown`, or a `conflict` while the routing names B at N+1 (this flip's own late write, or an identical one) -- is SETTLED
// by `flip-observe` from SYSTEM/ROUTING itself: B at N+1, moved by a gamesDoctor run at or after the window opened ->
// `flipped` (then F3 continues); A still at N -> the CAS never landed (`unknown`: re-run the flip with a NEW record file --
// it can never move the routing twice); anything else -> `unknown` with what the routing says. Nothing is assumed.
//
// ROLLBACK (review M3; `flip B A --rollback`): when B's promotion fails (its task cannot start as primary), the routing is
// moved back to A through the same preflight, window, CAS and observation -- with the preflight accepting that the roles
// never left A (the identity-writer / relayer role held by A's pool or B's current task), that B's service may be
// unsettled and its target unhealthy (it is the one failing), and that /gs* may still point at either pool; A (the
// destination) must be running and healthy. In the observation, B's own restart is reported, not required.
//
// A re-snapshot immediately before the CAS (review L3) refuses the flip if either pool's task or a role changed since the
// preflight -- the observation's baseline is then the state at the CAS.

import type { AwsRuntimeConfig } from "../runtime/runtimeConfig";
import { AWS_RUNTIME_CONFIG_FORMAT_V2 } from "../runtime/runtimeConfig";
import { primaryPoolProblem, readRouting, type RoutingRecord } from "../game/routing";
import { readRelayerRole } from "../game/relayerRole";
import { adoptionBindingProblem, generationMarkerProblem, readGenerationMarker } from "../game/generationMarker";
import { readIdentityRole } from "../identity/dynamoIdentityStore";
import { readAdoptedGeneration } from "../ledger/dynamoSigningLedger";
import { readAppGeneration } from "../ledger/appGeneration";
import {
  checkIdentityLayout,
  checkManifest,
  checkPoolListenerRules,
  checkPoolServices,
  checkPoolTargetGroups,
  checkTargetHealth,
  POOL_EVIDENCE_FILES,
  readEvidence,
  readRevisions,
  serviceOf,
  type Check,
} from "../controlPlane/evidence";
import { FLIP_EVIDENCE_FORMAT, type FlipRecord, type FlipSnapshot, type RoleSnapshot } from "../controlPlane/flipRecord";
import { applySuppression, type FlipSuppressionPort, type SuppressionOutcome } from "../controlPlane/flipSuppression";
import { readAs, readPoolView } from "./inspect";
import { noteProblem, setPrimary, type MutationContext } from "./mutations";

export const DEFAULT_OBSERVE_MS = 15 * 60_000;
export const DEFAULT_POLL_MS = 5_000;
export const DEFAULT_EVIDENCE_AGE_MS = 15 * 60_000;
/** How long the planned-flip window may suppress alarm ACTIONS at most (then they resume whatever happened). */
export const FLIP_WINDOW_MS = 45 * 60_000;

export interface FlipDeps {
  readonly context: MutationContext;
  /** Each pool's runtime document, read and parsed exactly as its task reads it (SSM + `parseAwsRuntimeConfigText`). */
  readonly documents: (pool: string) => Promise<AwsRuntimeConfig>;
  readonly sleep: (ms: number) => Promise<void>;
  /** A progress line (stdout). */
  readonly progress?: (line: string) => void;
  /** After each phase: persist the record (the CLI writes the --flip-record file). */
  readonly persist?: (record: FlipRecord) => void;
  /** LIVE-6 L6-5B: where the window's alarm-action suppression is published (CloudWatch; absent: nothing is suppressed --
   *  the alarms simply page during the flip). Its failure never changes the flip. */
  readonly suppression?: FlipSuppressionPort | null;
}

export interface FlipInput {
  readonly from: string;
  readonly to: string;
  readonly expectVersion: number;
  readonly note: string;
  readonly apply: boolean;
  /** The control-plane evidence directory (required with --apply). */
  readonly evidence: string | null;
  readonly maxEvidenceAgeMs?: number;
  readonly observeMs?: number;
  readonly pollMs?: number;
  /** Move the routing BACK to the pool the roles never left (B's promotion failed): see the header. */
  readonly rollback?: boolean;
}

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });
const judge = (name: string, ok: boolean, good: string, bad: string): Check => (ok ? pass(name, good) : fail(name, bad));
const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);

/* ------------------------------------------------------------------ */
/* Snapshots                                                            */
/* ------------------------------------------------------------------ */

/** What the tables say now about the two pools and the singleton roles (strong reads; a failed read is `null` + a check). */
export async function snapshot(context: MutationContext, pools: readonly string[]): Promise<{ readonly snap: FlipSnapshot; readonly routing: RoutingRecord | null; readonly problems: string[] }> {
  const { target } = context;
  const problems: string[] = [];
  const poolsOut: Record<string, { epoch: number; task: string } | null> = {};
  for (const pool of pools) {
    const read = await readPoolView(target.app, target.tables.game, pool);
    if (read.state === "ok") poolsOut[pool] = { epoch: read.value.writer_epoch, task: read.value.writer_task };
    else {
      poolsOut[pool] = null;
      problems.push(`POOL#${pool} ${read.state}${read.state === "unreadable" || read.state === "unavailable" ? `: ${read.detail}` : ""}`);
    }
  }
  const routing = await readAs(() => readRouting(target.app, target.tables.game));
  if (routing.state !== "ok") problems.push(`SYSTEM/ROUTING ${routing.state}`);
  const role = await readAs(() => readIdentityRole(target.app, target.tables.identity));
  if (role.state === "unreadable" || role.state === "unavailable") problems.push(`the identity-writer role ${role.state}`);
  let relayer: RoleSnapshot | null = null;
  if (target.escrow.state === "ok") {
    const mirror = await readAs(() => readRelayerRole(target.app, target.tables.game, (target.escrow as { relayer: string }).relayer));
    if (mirror.state === "ok") relayer = { epoch: mirror.value.epoch, pool: mirror.value.pool, task: mirror.value.task };
    else if (mirror.state !== "absent") problems.push(`the relayer mirror ${mirror.state}`);
  }
  return {
    snap: {
      at: context.now(),
      pools: poolsOut,
      identity_writer: role.state === "ok" ? { epoch: role.value.epoch, pool: role.value.pool, task: role.value.task } : null,
      relayer,
    },
    routing: routing.state === "ok" ? routing.value : null,
    problems,
  };
}

/* ------------------------------------------------------------------ */
/* F0: the preflight                                                    */
/* ------------------------------------------------------------------ */

export async function flipPreflight(deps: FlipDeps, input: FlipInput): Promise<{ readonly checks: Check[]; readonly before: FlipSnapshot | null }> {
  const { context } = deps;
  const { target } = context;
  const checks: Check[] = [];
  const note = noteProblem(input.note);
  checks.push(judge("note", note === null, "given", note ?? ""));
  const names = [input.from, input.to];
  for (const pool of names) {
    const problem = primaryPoolProblem(pool);
    checks.push(judge(`pool id ${pool}`, problem === null, "a pool id", problem ?? ""));
  }
  checks.push(judge("A -> B named explicitly", input.from !== input.to, `${input.from} -> ${input.to}`, "from and to are the same pool"));
  checks.push(judge("--expect-version", Number.isSafeInteger(input.expectVersion) && input.expectVersion >= 1, String(input.expectVersion), "the routing_version you inspected (a positive whole number)"));
  if (checks.some((c) => c.status === "fail")) return { checks, before: null };

  /* The routing: exactly version N, naming A. */
  const { snap, routing, problems } = await snapshot(context, names);
  for (const problem of problems) checks.push(fail("read", problem));
  if (routing !== null) {
    checks.push(judge("SYSTEM/ROUTING names A", routing.primary_pool === input.from, `primary ${routing.primary_pool}`, `primary is ${routing.primary_pool}, not ${input.from}`));
    checks.push(judge("SYSTEM/ROUTING at the expected version", routing.routing_version === input.expectVersion, `version ${routing.routing_version}`, `version ${routing.routing_version}, not --expect-version ${input.expectVersion}: inspect it again`));
  }
  /* Both pool items: current, readable, nothing this build never writes. */
  for (const pool of names) {
    const read = await readPoolView(target.app, target.tables.game, pool);
    checks.push(judge(`POOL#${pool}`, read.state === "ok" && read.value.extra.length === 0, read.state === "ok" ? `epoch ${read.value.writer_epoch}, task ${read.value.writer_task}` : "", read.state === "ok" ? `carries [${read.value.extra.join(", ")}], which this build never writes` : read.state === "absent" ? "absent: no task of this pool has ever started" : `${read.state}`));
  }
  /* The singleton role is A's current task's (the flip moves it; a role elsewhere is a deployment to repair first). */
  const role = snap.identity_writer;
  const aTask = snap.pools[input.from]?.task ?? null;
  const rollback = input.rollback === true;
  /* A rollback moves the routing back to the pool the roles never left: the role may be A's (the old holder of `to`) or
     B's current task, never a third pool's. */
  const holdsRole = (holder: RoleSnapshot | null): boolean => holder !== null && ((holder.pool === input.from && holder.task === aTask) || (rollback && holder.pool === input.to));
  checks.push(judge(rollback ? "the identity writer never left A, or is B's current task" : "the identity writer is A's current task", holdsRole(role), role === null ? "" : `epoch ${role.epoch}, ${role.task} of ${role.pool}`, role === null ? "no identity-writer role (absent or unreadable)" : `held by ${role.task} of ${role.pool}; A's current task is ${aTask}`));
  if (target.escrow.state === "ok") {
    const relayer = snap.relayer;
    checks.push(judge(rollback ? "the relayer role never left A, or is B's current task" : "the relayer role is A's current task", holdsRole(relayer), relayer === null ? "" : `epoch ${relayer.epoch}`, relayer === null ? "no relayer mirror" : `held by ${relayer.task} of ${relayer.pool}`));
  }
  /* APPGEN and the serving table's marker: the tasks' own startup rules (a flip into a table no task would start on is refused). */
  try {
    const adopted = await readAdoptedGeneration(target.ledger, target.tables.ledger);
    checks.push(judge("APPGEN", adopted === target.config.generation, `generation ${adopted}`, `APPGEN is ${String(adopted)}, the configuration's generation is ${target.config.generation}`));
    const marker = await readGenerationMarker(target.app, target.tables.game);
    const markerProblem = generationMarkerProblem(marker, { generation: target.config.generation, gameTable: target.config.gameTable });
    const appgen = await readAppGeneration(target.ledger, target.tables.ledger);
    const binding = marker === null || markerProblem !== null ? null : adoptionBindingProblem(marker, appgen?.adoption == null ? null : { game_table: appgen.adoption.game_table, restore_id: appgen.adoption.restore_id });
    checks.push(judge("SYSTEM/GENERATION (the tasks' startup rule)", markerProblem === null && binding === null, `generation ${marker?.generation}, ${marker?.origin}`, markerProblem ?? binding ?? ""));
  } catch (error) {
    checks.push(fail("APPGEN / SYSTEM/GENERATION", `could not be read: ${describe(error)}`));
  }
  /* The runtime documents: v2, each for its pool, same tables, the same route table naming A and B. */
  const docs = new Map<string, AwsRuntimeConfig>();
  for (const pool of names) {
    try {
      const doc = await deps.documents(pool);
      docs.set(pool, doc);
      const problems = [
        doc.format === AWS_RUNTIME_CONFIG_FORMAT_V2 ? null : `format ${doc.format} (LIVE-6 needs v2: the trusted route table)`,
        doc.pool === pool ? null : `it is pool ${doc.pool}'s document`,
        doc.gameTable === target.config.gameTable && doc.identityTable === target.config.identityTable && doc.ledger.arn === target.config.ledger.arn && doc.generation === target.config.generation ? null : "another generation or other tables than the configuration's",
        JSON.stringify(doc.escrow) === JSON.stringify(target.config.escrow) ? null : "another escrow configuration than the configuration's (a pool without the relayer's escrow could never take the relayer role)",
        names.every((p) => doc.routes[p] !== undefined) ? null : `its routes [${Object.keys(doc.routes).join(", ")}] do not name both ${input.from} and ${input.to}`,
      ].filter((p): p is string => p !== null);
      checks.push(judge(`runtime document ${pool}`, problems.length === 0, `v2; routes ${Object.entries(doc.routes).map(([p, e]) => `${p} -> ${e.wsPath}`).join(", ")}`, problems.join("; ")));
    } catch (error) {
      checks.push(fail(`runtime document ${pool}`, `not usable: ${describe(error)}`));
    }
  }
  const [docA, docB] = [docs.get(input.from), docs.get(input.to)];
  if (docA !== undefined && docB !== undefined) {
    const same = JSON.stringify(Object.entries(docA.routes).sort()) === JSON.stringify(Object.entries(docB.routes).sort());
    checks.push(judge("one route table", same, "A's and B's documents route alike", "A's and B's documents carry different route tables"));
  }

  /* The control plane, from fresh evidence. */
  if (input.evidence === null) {
    checks.push({ name: "control-plane evidence", status: input.apply ? "fail" : "skipped", detail: input.apply ? "--evidence <dir> (a fresh capture-evidence) is required to --apply a flip" : "not given (dry run): target health, services and ALB rules NOT checked" });
  } else {
    const dir = input.evidence;
    const manifest = readEvidence(dir, POOL_EVIDENCE_FILES.manifest);
    checks.push(...(manifest.ok ? checkManifest(manifest.value, { environment: target.config.environment, pools: names, now: context.now(), maxAgeMs: input.maxEvidenceAgeMs ?? DEFAULT_EVIDENCE_AGE_MS }) : [manifest.check]));
    const groups = readEvidence(dir, POOL_EVIDENCE_FILES.targetGroups);
    let arns: ReadonlyMap<string, string> = new Map();
    if (groups.ok) {
      const judged = checkPoolTargetGroups(groups.value, { environment: target.config.environment, pools: names });
      checks.push(...judged.checks);
      arns = judged.arns;
    } else checks.push(groups.check);
    /* A rollback's failing pool (from) may be mid-restart and unhealthy: its own settledness and health are reported, not
       required. Everything about the destination is required. */
    const relaxed = (checksOf: Check[], pool: string): Check[] => (rollback ? checksOf.map((c) => (c.status === "fail" && c.name.includes(pool) ? { ...c, status: "skipped" as const, detail: `(rollback: ${pool} is the failing pool) ${c.detail}` } : c)) : checksOf);
    const services = readEvidence(dir, POOL_EVIDENCE_FILES.services);
    if (services.ok) {
      checks.push(...relaxed(checkPoolServices(services.value, { environment: target.config.environment, pools: names, targetGroups: arns }), `-${input.from}:`));
      const b = serviceOf(services.value, target.config.environment, input.to);
      checks.push(judge(`${input.to} is running (not drained or retired)`, b !== null && b.desired === 1, "desired 1", `desired ${b?.desired ?? "?"}: a drained or retired pool is never made primary`));
    } else checks.push(services.check);
    for (const pool of names) {
      const health = readEvidence(dir, POOL_EVIDENCE_FILES.targetHealth(pool));
      const judged = health.ok ? checkTargetHealth(pool, health.value, 1) : health.check;
      checks.push(...(pool === input.from ? relaxed([judged], pool) : [judged]));
      const revisions = readRevisions(dir, pool);
      checks.push(revisions.ok ? checkIdentityLayout(pool, revisions.docs) : revisions.check);
    }
    const rules = readEvidence(dir, POOL_EVIDENCE_FILES.listenerRules);
    const routes: Record<string, string> = docA === undefined ? {} : Object.fromEntries(Object.entries(docA.routes).map(([p, e]) => [p, e.wsPath]));
    if (!rules.ok) checks.push(rules.check);
    else {
      /* A rollback may come before or after the Terraform /gs* move to B: either target is accepted then. */
      const asFrom = checkPoolListenerRules(rules.value, { primary: input.from, routes, targetGroups: arns });
      const asTo = rollback ? checkPoolListenerRules(rules.value, { primary: input.to, routes, targetGroups: arns }) : null;
      checks.push(...(asTo !== null && asFrom.some((c) => c.status === "fail") && asTo.every((c) => c.status !== "fail") ? asTo : asFrom));
    }
  }
  return { checks, before: snap };
}

/* ------------------------------------------------------------------ */
/* F3: the observation                                                  */
/* ------------------------------------------------------------------ */

/** Whether the roles have moved (see the header, F3); the checks say what is still missing. */
export function judgeRoles(record: Pick<FlipRecord, "from" | "to" | "expected_version" | "before"> & { readonly rollback?: boolean }, now: { readonly snap: FlipSnapshot; readonly routing: RoutingRecord | null }, escrow: boolean): Check[] {
  const { from, to } = record;
  const before = record.before;
  const b = now.snap.pools[to] ?? null;
  const a = now.snap.pools[from] ?? null;
  const beforeA = before?.pools[from] ?? null;
  const beforeB = before?.pools[to] ?? null;
  const role = now.snap.identity_writer;
  const checks: Check[] = [
    judge("routing still names B", now.routing !== null && now.routing.primary_pool === to && now.routing.routing_version === record.expected_version + 1, `primary ${to} at version ${record.expected_version + 1}`, now.routing === null ? "the routing could not be read" : `primary ${now.routing.primary_pool} at version ${now.routing.routing_version}: it moved again -- STOP`),
    judge(`${to} restarted (promotion)`, b !== null && beforeB !== null && b.epoch > beforeB.epoch, `POOL#${to} epoch ${beforeB?.epoch} -> ${b?.epoch} (${b?.task})`, `POOL#${to} still at epoch ${b?.epoch ?? "?"} (was ${beforeB?.epoch ?? "?"}): its task has not restarted yet`),
    ((check: Check): Check => (record.rollback === true && check.status === "fail" ? { ...check, status: "skipped", detail: `(rollback: the failing pool's restart is reported, not required) ${check.detail}` } : check))(
      judge(`${from} restarted (demotion)`, a !== null && beforeA !== null && a.epoch > beforeA.epoch, `POOL#${from} epoch ${beforeA?.epoch} -> ${a?.epoch} (${a?.task})`, `POOL#${from} still at epoch ${a?.epoch ?? "?"} (was ${beforeA?.epoch ?? "?"}): its task has not restarted yet`),
    ),
    judge("identity writer: B's current task", role !== null && b !== null && role.pool === to && role.task === b.task && (before?.identity_writer === null || before?.identity_writer === undefined || role.epoch > before.identity_writer.epoch), `epoch ${role?.epoch}, ${role?.task}`, role === null ? "no identity-writer role read" : `held by ${role.task} of ${role.pool} at epoch ${role.epoch}`),
    judge(`${from} holds no identity-writer role`, role === null || role.pool !== from, "none", `still held by ${from}`),
  ];
  if (escrow) {
    const relayer = now.snap.relayer;
    checks.push(judge("relayer: B's current task", relayer !== null && b !== null && relayer.pool === to && relayer.task === b.task, `epoch ${relayer?.epoch}, ${relayer?.task}`, relayer === null ? "no relayer mirror yet (the relayer role is taken once the escrow backend is verified; retried every 30 s)" : `held by ${relayer.task} of ${relayer.pool}`));
    checks.push(judge(`${from} holds no relayer role`, relayer === null || relayer.pool !== from, "none", `still held by ${from}`));
  }
  return checks;
}

function newRecord(input: FlipInput, environment: string, preflight: { readonly checks: Check[]; readonly before: FlipSnapshot | null }, at: number): FlipRecord {
  return {
    format: FLIP_EVIDENCE_FORMAT,
    environment,
    from: input.from,
    to: input.to,
    expected_version: input.expectVersion,
    note: input.note.trim(),
    ...(input.rollback === true ? { rollback: true } : {}),
    verdict: preflight.checks.some((c) => c.status === "fail") ? "refused" : "planned",
    preflight: { at, checks: preflight.checks },
    before: preflight.before,
    cas: null,
    window: null,
    observations: [],
    after: null,
  };
}

/** Observe until the roles settle or the bound passes (F3). Resumable: a record in `flipped` / `timeout` continues. */
/** Whether a record's CAS outcome is not known (see the header, "INTERRUPTED OR UNCERTAIN"). */
export const casUnsettled = (record: FlipRecord): boolean => record.window !== null && record.window.closed_at === null && (record.cas === null || record.verdict === "unknown");

/** Settle an uncertain CAS from SYSTEM/ROUTING itself (strong read). Never writes the routing. */
export async function settleFlipCas(deps: FlipDeps, record: FlipRecord): Promise<FlipRecord> {
  const { context } = deps;
  if (!casUnsettled(record)) return record;
  const read = await readAs(() => readRouting(context.target.app, context.target.tables.game));
  const at = context.now();
  if (read.state !== "ok") {
    const unknown: FlipRecord = { ...record, verdict: "unknown", cas: { at, run: record.cas?.run ?? null, outcome: "unknown", version: null, detail: `SYSTEM/ROUTING ${read.state}: the CAS's outcome cannot be settled yet` } };
    deps.persist?.(unknown);
    return unknown;
  }
  const routing = read.value;
  const moved = routing.primary_pool === record.to && routing.routing_version === record.expected_version + 1;
  const byOperator = routing.updated_by.startsWith("gamesDoctor/");
  const inWindow = record.window !== null && routing.updated_at >= record.window.opened_at - 60_000;
  if (moved && byOperator && inWindow) {
    const run = routing.updated_by.slice("gamesDoctor/".length);
    const flipped: FlipRecord = {
      ...record,
      verdict: "flipped",
      cas: { at: routing.updated_at, run, outcome: "applied", version: routing.routing_version, detail: `settled from SYSTEM/ROUTING: ${record.to} at version ${routing.routing_version}, set by gamesDoctor run ${run}${record.cas?.run != null && record.cas.run !== run ? ` (not this record's run ${record.cas.run}: an identical flip -- the routing is as this flip intended)` : ""}, claim ${routing.claim}` },
    };
    context.audit("operator.flip-settled", { from: record.from, to: record.to, routing_version: routing.routing_version, run });
    deps.persist?.(flipped);
    deps.progress?.(`  settled from SYSTEM/ROUTING: the CAS landed (${record.to} at ${routing.routing_version}); observing the role changes`);
    return flipped;
  }
  const notLanded = routing.primary_pool === record.from && routing.routing_version === record.expected_version;
  const unknown: FlipRecord = {
    ...record,
    verdict: "unknown",
    cas: {
      at,
      run: record.cas?.run ?? null,
      outcome: "unknown",
      version: null,
      detail: notLanded
        ? `the CAS has not landed: SYSTEM/ROUTING still names ${record.from} at version ${record.expected_version} -- re-run the flip with --expect-version ${record.expected_version} and a NEW --flip-record (it can never move the routing twice)`
        : `SYSTEM/ROUTING names ${routing.primary_pool} at version ${routing.routing_version} (set by ${routing.updated_by}): not this flip's outcome -- inspect before anything else`,
    },
  };
  deps.persist?.(unknown);
  return unknown;
}

export async function observeFlip(deps: FlipDeps, record: FlipRecord, options: { readonly observeMs?: number; readonly pollMs?: number } = {}): Promise<FlipRecord> {
  const { context } = deps;
  if (casUnsettled(record)) record = await settleFlipCas(deps, record);
  if (record.cas === null || !["flipped", "timeout", "roles-settled"].includes(record.verdict)) return record;
  const deadline = context.now() + (options.observeMs ?? DEFAULT_OBSERVE_MS);
  const escrow = context.target.escrow.state === "ok";
  let current = record;
  for (;;) {
    const now = await snapshot(context, [record.from, record.to]);
    const checks = judgeRoles(current, now, escrow);
    const settled = checks.every((c) => c.status !== "fail");
    const moved = checks[0].status === "fail" && now.routing !== null;
    current = { ...current, observations: [...current.observations.slice(-19), { at: now.snap.at, checks }], after: now.snap, verdict: settled ? "roles-settled" : current.verdict };
    deps.persist?.(current);
    if (settled) {
      deps.progress?.(`  roles settled: ${record.to} is the primary's task (identity writer${escrow ? " and relayer" : ""}); ${record.from} restarted holding nothing`);
      context.audit("operator.flip-roles-settled", { from: record.from, to: record.to, routing_version: record.expected_version + 1, window_expires_at: current.window?.expires_at ?? null });
      return current;
    }
    if (moved || context.now() >= deadline) {
      current = { ...current, verdict: "timeout" };
      deps.persist?.(current);
      context.audit("operator.flip-timeout", { from: record.from, to: record.to, missing: checks.filter((c) => c.status === "fail").map((c) => c.name) });
      return current;
    }
    deps.progress?.(`  waiting: ${checks.filter((c) => c.status === "fail").map((c) => c.name).join("; ")}`);
    await deps.sleep(options.pollMs ?? DEFAULT_POLL_MS);
  }
}

/** The flip (F0 .. F3). Returns the record in every case; the CLI maps its verdict to the exit code. */
export async function runFlip(deps: FlipDeps, input: FlipInput): Promise<FlipRecord> {
  const { context } = deps;
  const preflight = await flipPreflight(deps, input);
  let record = newRecord(input, context.target.config.environment, preflight, context.now());
  if (record.verdict === "refused" || !input.apply) {
    if (input.apply) deps.persist?.(record);
    return record;
  }
  /* L3: the baseline at the CAS, not at the preflight -- a task or a role that moved in between refuses the flip. */
  const again = await snapshot(context, [input.from, input.to]);
  const same = (x: FlipSnapshot | null, y: FlipSnapshot) => x !== null && JSON.stringify([x.pools, x.identity_writer, x.relayer]) === JSON.stringify([y.pools, y.identity_writer, y.relayer]);
  if (again.problems.length > 0 || !same(record.before, again.snap) || again.routing?.routing_version !== input.expectVersion) {
    record = { ...record, verdict: "refused", preflight: { ...record.preflight, checks: [...record.preflight.checks, fail("unchanged since the preflight", `a pool's task, a role or the routing changed since the preflight${again.problems.length > 0 ? ` (${again.problems.join("; ")})` : ""}: run the flip again`)] } };
    deps.persist?.(record);
    return record;
  }
  record = { ...record, before: again.snap };
  /* F1: the window opens BEFORE the CAS (from the CAS on, both role changes are expected). */
  const opened = context.now();
  record = { ...record, window: { opened_at: opened, expires_at: opened + FLIP_WINDOW_MS, closed_at: null } };
  deps.persist?.(record);
  context.audit("operator.flip-window", { phase: "open", from: input.from, to: input.to, routing_version: input.expectVersion, opened_at: opened, expires_at: opened + FLIP_WINDOW_MS });
  /* L6-5B: the window's alarm-action suppression, for exactly these two pools, up to expires_at -- published ahead, so it
     ends by itself whatever happens to this process. Before the CAS (from the CAS on, both role changes are expected). */
  const opening = await suppressFlipWindow(deps.suppression ?? null, context, record, "open");
  if (opening !== null && record.window !== null) {
    record = { ...record, window: { ...record.window, suppression: opening.outcome } };
    deps.persist?.(record);
  }
  /* F2: the CAS -- L6-3's set-primary (evidence first; a lost answer settled by the claim). */
  const result = await setPrimary(context, { pool: input.to, expectVersion: input.expectVersion, note: input.note, apply: true });
  const at = context.now();
  if (result.kind === "applied") {
    record = { ...record, verdict: "flipped", cas: { at, run: result.run, outcome: "applied", version: input.expectVersion + 1, detail: result.detail } };
    deps.persist?.(record);
    deps.progress?.(`  routing: ${input.to} is the primary at version ${input.expectVersion + 1} (run ${result.run}); observing the role changes`);
    /* Review M2: until /gs* forwards to B, HTTP identity calls (/gs/api/*) reach A -- a router now, which answers them 503.
       The Terraform move is valid from this instant (its precondition is only that the routing names B): do it NOW, while
       the observation runs, not after it. */
    deps.progress?.(`  NOW (in parallel): terraform apply with pools.${input.to}.primary = true -- the /gs* rule's target; until it lands, /gs/api/* on ${input.from}'s router answers 503`);
    return observeFlip(deps, record, input);
  }
  /* A conflict while the routing names B at N+1 may be this flip's own write landing late (or an identical flip): uncertain,
     never "refused" -- flip-observe settles it from the routing (review H1). */
  let uncertain = result.kind === "unknown";
  if (result.kind === "conflict") {
    const now = await readAs(() => readRouting(context.target.app, context.target.tables.game));
    uncertain = now.state !== "ok" || (now.value.primary_pool === input.to && now.value.routing_version === input.expectVersion + 1);
  }
  const closeWindow = !uncertain;
  record = {
    ...record,
    verdict: uncertain ? "unknown" : "refused",
    cas: { at, run: result.kind === "planned" ? null : result.run, outcome: result.kind, version: null, detail: result.kind === "refused" ? result.reason : result.kind === "planned" ? "" : result.detail },
    window: closeWindow && record.window !== null ? { ...record.window, closed_at: at } : record.window,
  };
  if (closeWindow) context.audit("operator.flip-window", { phase: "closed", from: input.from, to: input.to, why: `the CAS was ${result.kind}` });
  deps.persist?.(record);
  /* A close cancels only what THIS flip's open published (review M5: the encoding is additive); decided once, recorded. */
  if (closeWindow && record.window?.suppression === "published") {
    record = { ...record, window: { ...record.window, suppression: "closed" } };
    deps.persist?.(record);
    await suppressFlipWindow(deps.suppression ?? null, context, record, "close");
  }
  return record;
}

/**
 * LIVE-6 L6-5B: publish the window's suppression (open) or end it (close) -- `controlPlane/flipSuppression.ts`. Audited as
 * `operator.flip-suppression {phase, from, to, outcome, ...}`; NEVER throws and never changes the flip or the recovery:
 * a failed open means the alarms page during the flip (the safe direction); a failed close ends at `expires_at` anyway.
 */
export async function suppressFlipWindow(port: FlipSuppressionPort | null, context: MutationContext, record: FlipRecord, phase: "open" | "close"): Promise<SuppressionOutcome | null> {
  if (record.window === null) return null;
  const answer = await applySuppression(port, { environment: record.environment, pools: [record.from, record.to], opened_at: record.window.opened_at, expires_at: record.window.expires_at }, phase, context.now());
  context.audit("operator.flip-suppression", { phase, from: record.from, to: record.to, expires_at: record.window.expires_at, ...answer });
  return answer;
}

/** Close the window (the recovery pass settled): `AUDIT operator.flip-window {phase: "closed"}`. */
export function closeFlipWindow(context: MutationContext, record: FlipRecord, why: string): FlipRecord {
  if (record.window === null || record.window.closed_at !== null) return record;
  const at = context.now();
  context.audit("operator.flip-window", { phase: "closed", from: record.from, to: record.to, why });
  return { ...record, window: { ...record.window, closed_at: at } };
}
