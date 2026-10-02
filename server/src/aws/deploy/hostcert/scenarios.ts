// server/src/aws/deploy/hostcert/scenarios.ts
//
// ==================================================================
//  COST-2C: THE MUTATING SINGLE-HOST CERTIFICATION DRILLS -- F7, F8, F9a, F9b AND THE REPLACEMENT, EACH
//  PRECHECK -> MUTATION -> OBSERVATION -> CLEANUP / RECOVERY -> POSTCHECK -> EVIDENCE -> PASS / FAIL / NOT EVALUATED
// ==================================================================
//
//   graceful-stop        F7   gs-stop -> readiness 503 BEFORE the process is gone -> exit 0 -> no HOLD, no restart;
//                             gs-deploy of the SAME digest -> a new process serves; generation and pool unchanged.
//   crash-restart        F8   `docker kill --signal KILL gs-server` -> a non-fence exit (137) -> no HOLD -> systemd
//                             restarts it (NRestarts + 1) -> the new process takes a STRICTLY newer POOL epoch, and the
//                             identity writer and the relayer move to it, consistently.
//   reboot-restart       F8   host reboot -> the shutdown's graceful exit -> the host returns and the service starts by
//                             itself -> newer epochs, roles moved, no HOLD.
//   duplicate-preflight  F9a  gs-preflight while gs-server runs REFUSES ("already running"); nothing moved (non-disruptive).
//   duplicate-fence      F9b  a rival container of the same image and env takes POOL#p1 -> the incumbent exits 3 (or 5)
//                             -> systemd does NOT restart it -> ExecStopPost got EXIT_CODE=exited EXIT_STATUS=3 ->
//                             /var/lib/gs/hold written -> preflight and `systemctl start` refused -> rival removed ->
//                             REBOOT: the HOLD survives, no process, no takeover -> a refused gs-deploy keeps the HOLD ->
//                             gs-deploy of the same release clears it -> ONE writer at a newer fence.
//   replacement-before   (replacement) the baseline of a guarded host replacement; holds the drill lock across it.
//   replacement-after    (replacement) after the operator's guarded replacement: one serving host owning the EIP, a
//                             newer epoch and roles on the new host, the stale host (when reachable) refusing its
//                             preflight and serving nothing, no duplicate writer, money state singular.
//
// THE LIVE-SAFETY CONTRACT (the precheck; any non-pass REFUSES -- nothing is mutated):
//   staging / non-mainnet only (the runtime document's environment `staging[-*]`, its escrow not mainnet); APPGEN = the
//   expected generation and the serving table its marker names (LIVE-6's `judgeGeneration`); SYSTEM/ROUTING names the
//   expected pool; ONE current host (exactly one single-host instance of the environment, it is --instance-id, it holds the
//   serving Elastic IP, no ECS task runs); the host serving the expected release with no HOLD, one gs-server container,
//   no other drill's recorder or rival; the unit and scripts the reviewed bytes; ONE consistent writer -- the host's own
//   process; for disruptive drills 0 open money games and RELAYQ empty; the drill lock (`drillLock.ts`); a run id; the
//   scenario-named acknowledgement. There is no --force.
//
// NOT CERTIFIED OFFLINE. Every scenario carries `real AL2023 host`: PASS only when the evidence came through the
// production world (`isLiveWorld`) from an Amazon Linux 2023 host. Through anything else it is NOT EVALUATED / REQUIRES
// REAL AL2023, so no offline run can ever PASS -- and the systemd exit-status contract stays OPEN until the live drill.

import type { CertCheck } from "./verdict";
import { decide, failed, passed, unknown, verdictOf, REQUIRES_REAL_AL2023, type Verdict } from "./verdict";
import { authorityEvidence, judgeOwnershipMoved, judgeOwnershipUnchanged, judgeQuiet, judgeSingleWriter, readAuthority, writerOf, type AuthoritySnapshot, type AuthorityTarget, type HostCertReaders } from "./controlPlane";
import { acquireLock, releaseLock, renewLock, type LockHolder } from "./drillLock";
import { exitOf, hostOpProblem, keyed, parseHostOutput, rivalName, textsOf, type HostLine, type HostOp } from "./hostOps";
import { down, foreignDropIns, judgeExit, judgeUnit, latestBanner, nRestarts, ourDropIn, parseObservation, rivals, runningServer, serverContainers, serving, type ExitExpectation, type HostState } from "./hostState";
import { isLiveWorld, type HostCertWorld } from "./transport";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { GenerationEvidence } from "../staging/recovery";
import { judgeGeneration } from "../staging/recovery";

export const HOST_CERT_FORMAT = "18COSMOS/COST-2C-HOST-CERT/v1";

export type Scenario = "graceful-stop" | "crash-restart" | "reboot-restart" | "duplicate-preflight" | "duplicate-fence" | "replacement-before" | "replacement-after";

export interface ScenarioSpec {
  readonly name: Scenario;
  readonly property: string;
  /** Takes the service down (downtime) or fences it. */
  readonly disruptive: boolean;
  /** Requires 0 open money games and RELAYQ empty. */
  readonly quiet: boolean;
  readonly leaseMs: number;
  readonly summary: string;
}

export const SCENARIOS: Readonly<Record<Scenario, ScenarioSpec>> = Object.freeze({
  "graceful-stop": { name: "graceful-stop", property: "F7", disruptive: true, quiet: false, leaseMs: 45 * 60_000, summary: "gs-stop -> exit 0, readiness first, no HOLD; redeploy the same digest" },
  "crash-restart": { name: "crash-restart", property: "F8", disruptive: true, quiet: true, leaseMs: 45 * 60_000, summary: "docker kill -> systemd restarts -> newer POOL epoch, roles moved, no HOLD" },
  "reboot-restart": { name: "reboot-restart", property: "F8", disruptive: true, quiet: true, leaseMs: 75 * 60_000, summary: "host reboot -> service returns by itself -> newer epochs, no HOLD" },
  "duplicate-preflight": { name: "duplicate-preflight", property: "F9a", disruptive: false, quiet: false, leaseMs: 20 * 60_000, summary: "gs-preflight while serving refuses before any second gs-server" },
  "duplicate-fence": { name: "duplicate-fence", property: "F9b", disruptive: true, quiet: true, leaseMs: 150 * 60_000, summary: "rival takes the pool -> exit 3 -> no restart -> HOLD across reboot -> only gs-deploy clears it -> one newer writer" },
  "replacement-before": { name: "replacement-before", property: "replacement", disruptive: true, quiet: true, leaseMs: 6 * 60 * 60_000, summary: "baseline before the guarded host replacement (holds the lock across it)" },
  "replacement-after": { name: "replacement-after", property: "replacement", disruptive: true, quiet: true, leaseMs: 6 * 60 * 60_000, summary: "after the replacement: one serving host, newer epochs, stale host refused, no duplicate writer" },
});

export interface Timing {
  readonly pollMs: number;
  readonly restartTimeoutMs: number;
  readonly fenceTimeoutMs: number;
  readonly rebootDownTimeoutMs: number;
  readonly readyTimeoutMs: number;
  /** After a fence: long enough for RestartSec=10 to have restarted it if anything would (it must not). */
  readonly settleMs: number;
  readonly baselineJournalMs: number;
}

export const DEFAULT_TIMING: Timing = Object.freeze({ pollMs: 5_000, restartTimeoutMs: 240_000, fenceTimeoutMs: 240_000, rebootDownTimeoutMs: 600_000, readyTimeoutMs: 420_000, settleMs: 40_000, baselineJournalMs: 14 * 24 * 3_600_000 });

export interface ReplacementBaseline {
  readonly run: string;
  readonly environment: string;
  readonly instance: string;
  readonly expected_ip: string;
  readonly task: string;
  readonly pool_epoch: number;
  readonly identity_epoch: number;
  readonly relayer_epoch: number | null;
  readonly lock: LockHolder;
  readonly finished_at_ms: number;
}

export interface DrillInput {
  readonly scenario: Scenario;
  readonly run: string;
  readonly environment: string;
  readonly generation: number;
  readonly pool: string;
  readonly gameTable: string;
  readonly instanceId: string;
  readonly digest: string;
  readonly build: string;
  readonly sourceCommit: string;
  readonly operator: string;
  readonly ecsCluster: string;
  readonly reclaimStaleLock: string | null;
  /** replacement-after: the before-phase's evidence (its lock, its baseline) and the old host, if reachable. */
  readonly replacementBefore?: ReplacementBaseline;
  readonly staleInstanceId?: string | null;
}

export interface DrillDeps {
  readonly world: HostCertWorld;
  readonly readers: HostCertReaders | undefined;
  readonly target: AuthorityTarget;
  /** LIVE-6's generation evidence (`readGenerationEvidence`), read live. */
  readonly generationEvidence: () => Promise<GenerationEvidence>;
  /** The runtime document's own words (it was loaded and matched to the flags by the command). */
  readonly document: { readonly environment: string; readonly pool: string; readonly generation: number; readonly gameTable: string; readonly escrowNetwork: "mainnet" | "testnet" | "local" | null };
  /** SHA-256 of the repository's unit and host scripts (`hostcert/commands.ts` reads infra/aws/modules/single-host/files). */
  readonly expectedFiles: Readonly<Record<string, string>>;
  readonly lock: { readonly client: DynamoDBClient; readonly table: string; readonly claim?: string };
  readonly timing?: Partial<Timing>;
}

type Phase = "precheck" | "mutation" | "observation" | "cleanup" | "postcheck";

export interface StepRecord {
  readonly phase: Phase;
  readonly step: string;
  readonly op: string;
  readonly at: string;
  readonly ok: boolean;
  readonly exit: number | null;
  readonly command_id: string | null;
  readonly detail: string;
}

export interface DrillResult {
  readonly verdict: Verdict;
  readonly refused: boolean;
  readonly record: Record<string, unknown>;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();
const secondsOf = (ms: number): number => Math.floor(ms / 1000);

/** What the evidence keeps of a host state (identifiers, states, codes; the filtered journal; nothing else). */
export function stateEvidence(s: HostState): Record<string, unknown> {
  return {
    boot_id: s.bootId,
    os: `${s.osId} ${s.osVersionId}`,
    systemd: s.systemdVersion,
    instance_id: s.instanceId,
    public_ip: s.publicIp,
    expected_ip: s.expectedIp,
    release: { digest: s.releaseDigest, build: s.releaseBuild },
    hold: s.hold.present ? s.hold.text ?? "present" : "absent",
    readyz: s.readyz,
    systemd_properties: s.props,
    containers: s.containers.map((c) => ({ name: c.name, state: c.state, image: c.image, id: c.id.slice(0, 12) })),
    exec_stop_post_observations: s.exits,
    drop_ins: s.dropIns,
    journal: s.journal,
    banner_tasks: s.banners,
    withheld_lines: s.withheld,
  };
}

/* ------------------------------------------------------------------ */
/* The drill's machinery                                                */
/* ------------------------------------------------------------------ */

class Drill {
  readonly checks: Record<Phase, CertCheck[]> = { precheck: [], mutation: [], observation: [], cleanup: [], postcheck: [] };
  readonly steps: StepRecord[] = [];
  readonly observations: Array<{ readonly label: string; readonly at: string; readonly state: Record<string, unknown> | string }> = [];
  readonly authorities: Array<{ readonly label: string; readonly snapshot: Record<string, unknown> }> = [];
  readonly facts: Record<string, unknown> = {};
  lock: LockHolder | null = null;
  lockLost = false;
  phase: Phase = "precheck";
  readonly timing: Timing;
  readonly live: boolean;

  constructor(readonly input: DrillInput, readonly deps: DrillDeps) {
    this.timing = { ...DEFAULT_TIMING, ...(deps.timing ?? {}) };
    this.live = isLiveWorld(deps.world);
  }

  get now(): number {
    return this.deps.world.now();
  }

  add(check: CertCheck | readonly CertCheck[]): void {
    for (const c of Array.isArray(check) ? check : [check as CertCheck]) this.checks[this.phase].push(c);
  }

  /** Run one host operation; its framed answer, or null (recorded: the step's outcome is unknown). */
  async host(step: string, op: HostOp, on: string = this.input.instanceId): Promise<readonly HostLine[] | null> {
    const at = this.now;
    const problem = hostOpProblem(op);
    if (problem !== null) {
      this.steps.push({ phase: this.phase, step, op: op.kind, at: isoOf(at), ok: false, exit: null, command_id: null, detail: `refused: ${problem}` });
      return null;
    }
    const r = await this.deps.world.host.run(on, op);
    if (!r.ok) {
      this.steps.push({ phase: this.phase, step, op: op.kind, at: isoOf(at), ok: false, exit: null, command_id: r.commandId, detail: r.detail });
      return null;
    }
    const parsed = parseHostOutput(r.stdout, op);
    if (!parsed.ok) {
      this.steps.push({ phase: this.phase, step, op: op.kind, at: isoOf(at), ok: false, exit: r.exitCode, command_id: r.commandId, detail: `the answer is not complete: ${parsed.problem}` });
      return null;
    }
    this.steps.push({ phase: this.phase, step, op: op.kind, at: isoOf(at), ok: true, exit: exitOf(parsed.lines), command_id: r.commandId, detail: textsOf(parsed.lines, "R").join("; ").slice(0, 300) || "-" });
    return parsed.lines;
  }

  /** Observe the host (read-only); the state, or null with the reason recorded. */
  async observe(label: string, sinceMs: number, on: string = this.input.instanceId): Promise<HostState | null> {
    const lines = await this.host(`observe: ${label}`, { kind: "observe", run: this.input.run, sinceEpochSeconds: secondsOf(sinceMs) }, on);
    if (lines === null) {
      this.observations.push({ label, at: isoOf(this.now), state: "NOT READ (see the step)" });
      return null;
    }
    const parsed = parseObservation(lines);
    if (!parsed.ok) {
      this.observations.push({ label, at: isoOf(this.now), state: `UNREADABLE: ${parsed.problem}` });
      return null;
    }
    this.observations.push({ label, at: isoOf(this.now), state: stateEvidence(parsed.state) });
    return parsed.state;
  }

  async authority(label: string): Promise<AuthoritySnapshot> {
    const snap = await readAuthority(this.deps.readers, this.deps.target, () => this.now);
    this.authorities.push({ label, snapshot: authorityEvidence(snap) });
    return snap;
  }

  /** Observe every `pollMs` until `until(state)` or the timeout. `every` sees EVERY observation (an invariant over time). */
  async poll(label: string, sinceMs: number, timeoutMs: number, until: (s: HostState) => boolean, every?: (s: HostState) => void): Promise<{ readonly state: HostState | null; readonly met: boolean; readonly reads: number; readonly unread: number }> {
    const deadline = this.now + timeoutMs;
    let last: HostState | null = null;
    let reads = 0;
    let unread = 0;
    for (;;) {
      const s = await this.observe(`${label} (poll ${reads + unread + 1})`, sinceMs);
      if (s === null) unread += 1;
      else {
        reads += 1;
        last = s;
        every?.(s);
        if (until(s)) return { state: s, met: true, reads, unread };
      }
      if (this.now >= deadline) return { state: last, met: false, reads, unread };
      await this.deps.world.sleep(this.timing.pollMs);
    }
  }

  /** Keep the lock ours before each mutation (a lost lock stops the mutations; cleanup still runs). */
  async keepLock(): Promise<boolean> {
    if (this.lock === null || this.lockLost) return false;
    const spec = SCENARIOS[this.input.scenario];
    const r = await renewLock(this.deps.lock.client, this.deps.lock.table, this.lock, this.now, spec.leaseMs);
    if (r.kind === "held") {
      this.lock = r.holder;
      return true;
    }
    this.lockLost = true;
    this.add(failed("the drill lock is still this run's", r.detail));
    return false;
  }

  /** A mutation step whose own result code must be `want` (any other: FAIL; unread: NOT EVALUATED). */
  async mutate(step: string, op: HostOp, want: number | ((code: number) => boolean) = 0): Promise<readonly HostLine[] | null> {
    if (!(await this.keepLock())) return null;
    const lines = await this.host(step, op);
    if (lines === null) {
      this.add(unknown(`${step}: done`, "the host operation's outcome is unknown (not delivered, timed out or truncated): nothing after it is judged as if it happened"));
      return null;
    }
    const code = exitOf(lines);
    const ok = code !== null && (typeof want === "number" ? code === want : want(code));
    this.add(decide(`${step}: done`, ok, `exit ${String(code)}`, `exit ${String(code)}${textsOf(lines, "R").length > 0 ? ` (${textsOf(lines, "R").join("; ")})` : ""}${textsOf(lines, "O").length > 0 ? `: ${textsOf(lines, "O").slice(-3).join(" | ")}` : ""}`));
    return lines;
  }
}

/* ------------------------------------------------------------------ */
/* The precheck (the live-safety contract)                              */
/* ------------------------------------------------------------------ */

interface Baseline {
  readonly state: HostState;
  readonly authority: AuthoritySnapshot;
  readonly task: string;
}

function convertGeneration(checks: ReturnType<typeof judgeGeneration>): CertCheck[] {
  /* LIVE-6's judge says pass / fail; an unreadable reading is a fail there -- here, in a PRECHECK, either refuses. */
  return checks.map((c) => (c.status === "pass" ? passed(c.name, c.detail) : failed(c.name, c.detail)));
}

async function precheck(d: Drill): Promise<Baseline | null> {
  const { input, deps } = d;
  const spec = SCENARIOS[input.scenario];
  const doc = deps.document;
  /* 1. Staging / non-mainnet, and the document is the one named. */
  d.add(decide("environment: staging only", /^staging(-[a-z0-9-]{1,24})?$/.test(input.environment) && doc.environment === input.environment, `environment ${input.environment} (the runtime document's)`, `environment ${input.environment} / document ${doc.environment}: host-cert runs only against staging`));
  d.add(decide("environment: not mainnet", doc.escrowNetwork !== "mainnet", doc.escrowNetwork === null ? "no escrow configured" : `escrow network ${doc.escrowNetwork}`, "the escrow configuration is MAINNET: refused"));
  d.add(decide("the runtime document is the expected generation / table / pool", doc.generation === input.generation && doc.gameTable === input.gameTable && doc.pool === input.pool, `g${doc.generation} ${doc.gameTable} ${doc.pool}`, `the document says g${doc.generation} ${doc.gameTable} ${doc.pool}; the flags g${input.generation} ${input.gameTable} ${input.pool}`));
  if (d.checks.precheck.some((c) => c.status !== "pass")) return null;
  /* 2. The drill lock (before anything else is read: the state cannot be changed by another drill between precheck and mutation). */
  if (input.scenario === "replacement-after") {
    const before = input.replacementBefore;
    if (before === undefined) {
      d.add(failed("the drill lock", "replacement-after needs the before-phase's evidence (--before <file>)"));
      return null;
    }
    d.lock = before.lock;
    if (!(await d.keepLock())) return null;
    d.add(passed("the drill lock", `held by this replacement since ${isoOf(before.lock.started_at)} (run ${before.run})`));
  } else {
    const r = await acquireLock(deps.lock.client, deps.lock.table, { run: input.run, scenario: input.scenario, instance: input.instanceId, operator: input.operator, sourceCommit: input.sourceCommit, leaseMs: spec.leaseMs, now: d.now, reclaim: input.reclaimStaleLock, ...(deps.lock.claim !== undefined ? { claim: deps.lock.claim } : {}) });
    if (r.kind !== "held") {
      d.add(r.kind === "refused" ? failed("the drill lock", r.detail) : unknown("the drill lock", r.detail));
      return null;
    }
    d.lock = r.holder;
    d.add(passed("the drill lock", `acquired until ${isoOf(r.holder.expires_at)}${input.reclaimStaleLock !== null ? ` (reclaimed from the stale run ${input.reclaimStaleLock})` : ""}`));
  }
  /* 3. The generation: APPGEN, SYSTEM/GENERATION, L6-4's startup rule (LIVE-6's own judge). */
  d.add(convertGeneration(judgeGeneration(await deps.generationEvidence(), { generation: input.generation, gameTable: input.gameTable, requireRestore: false })));
  /* 4. The host, read-only. */
  const state = await d.observe("baseline", d.now - d.timing.baselineJournalMs);
  if (state === null) {
    d.add(unknown("the host: observed", "the host could not be observed (see the step): refused"));
    return null;
  }
  const unit = await d.host("observe-unit: baseline", { kind: "observe-unit", run: input.run });
  if (unit === null) d.add(unknown("the unit: observed", "the unit and scripts could not be read: refused"));
  else {
    d.facts.unit = { systemd: keyed(unit, "systemd_version"), os: `${String(keyed(unit, "os_id"))} ${String(keyed(unit, "os_version_id"))}`, unit_file: textsOf(unit, "U"), gs_exit_hold: textsOf(unit, "H"), sha256: textsOf(unit, "S"), effective: textsOf(unit, "P"), drop_ins: textsOf(unit, "D") };
    d.add(judgeUnit("the unit", unit, deps.expectedFiles));
  }
  d.add(decide("the host: the instance named", state.instanceId === input.instanceId, state.instanceId, `IMDS says ${state.instanceId}, not ${input.instanceId}`));
  d.add(decide("the host: holds the serving Elastic IP", state.publicIp === state.expectedIp && state.expectedIp.length > 0, `public ${state.publicIp} = expected ${state.expectedIp}`, `public ${state.publicIp}, host.env expects ${state.expectedIp}`));
  d.add(decide("the host: its environment", state.environment === input.environment, state.environment, `host.env says ${state.environment}`));
  d.add(decide("the host: no HOLD", !state.hold.present, "no /var/lib/gs/hold", `on HOLD (${String(state.hold.text)}): resolve it first (gs-deploy after investigation); a drill never starts on HOLD`));
  d.add(decide("the host: serving", serving(state), `active/running, gs-server running, /gs/readyz 200`, `ActiveState ${state.props.ActiveState}/${state.props.SubState}, container ${runningServer(state) === null ? "not running" : "running"}, readyz ${state.readyz}`));
  d.add(decide("the host: one gs-server container", serverContainers(state).length === 1 && state.docker === "ok", "exactly one", `${serverContainers(state).length} gs-server container(s); docker ${state.docker}`));
  d.add(decide("the host: the expected release", state.releaseDigest === input.digest && state.releaseBuild === input.build, `${input.build} (${input.digest})`, `release.env is ${state.releaseBuild} (${state.releaseDigest}); --digest/--build name ${input.build} (${input.digest})`));
  d.add(decide("the host: no other drill in progress", rivals(state).length === 0 && foreignDropIns(state, input.run).filter((x) => x.startsWith("90-gs-cert-")).length === 0 && !ourDropIn(state, input.run), "no rival container, no gs-cert drop-in", `rival(s) ${rivals(state).map((r) => r.name).join(", ") || "none"}; drop-ins ${state.dropIns.join(", ") || "none"}`));
  d.add(decide("the host: no unexpected drop-in", foreignDropIns(state, input.run).filter((x) => !x.startsWith("90-gs-cert-")).length === 0, "none", `drop-ins ${foreignDropIns(state, input.run).join(", ")}: the unit is not the reviewed one`));
  const banner = latestBanner(state, 0);
  const started = /^@?([0-9]{9,12})$/.exec(state.props.ExecMainStartTimestamp ?? "");
  const bannerOk = banner !== null && started !== null && banner.atSeconds >= Number(started[1]) - 5 && banner.atSeconds <= Number(started[1]) + 900 && banner.pool === input.pool && banner.generation === input.generation;
  if (!bannerOk) d.add(unknown("the host: the serving process's task id", banner === null ? "no startup banner (pool .., generation .., task t-..) in the unit's journal since the process started: the host's process cannot be tied to its task (redeploy it, then retry)" : `the newest banner (${banner.task}, ${banner.pool} g${banner.generation} at ${banner.atSeconds}) is not the current process (started ${state.props.ExecMainStartTimestamp ?? "?"})`));
  else d.add(passed("the host: the serving process's task id", `${banner.task} (banner at ${banner.atSeconds}, process started ${started?.[1]})`));
  /* 5. ONE current host. */
  /* replacement-after: how many hosts exist is the REPLACEMENT'S RESULT -- judged as an observation (a FAIL, not a refusal). */
  if (input.scenario !== "replacement-after") {
    const fleet = await deps.world.fleet.hostInstances(input.environment);
    if (!fleet.ok) d.add(unknown("one host: the single-host instances", fleet.detail));
    else d.add(judgeOneHost(fleet.value, input.instanceId, null));
  }
  const eip = await deps.world.fleet.addressOwner(state.expectedIp);
  if (!eip.ok) d.add(unknown("one host: the Elastic IP's owner", eip.detail));
  else d.add(decide("one host: the Elastic IP is this instance's", eip.value !== null && eip.value.instanceId === input.instanceId, `${state.expectedIp} -> ${input.instanceId}`, eip.value === null ? `${state.expectedIp} is not an Elastic IP of this account / region` : `${state.expectedIp} is associated with ${String(eip.value.instanceId)}`));
  const ecs = await deps.world.fleet.ecsRunningTasks(input.ecsCluster);
  if (!ecs.ok) d.add(unknown("one host: no ECS task", ecs.detail));
  else d.add(decide("one host: no ECS task", ecs.value.count === 0, ecs.value.absent ? `cluster ${input.ecsCluster} retired` : `cluster ${input.ecsCluster}: 0 running`, `${ecs.value.count} ECS task(s) desired RUNNING in ${input.ecsCluster}: not a single-host deployment`));
  /* 6. ONE consistent writer -- the host's own process; 7. the money preconditions. */
  const authority = await d.authority("baseline");
  d.add(judgeSingleWriter(authority, { label: "baseline writer", pool: input.pool, environment: input.environment, generation: input.generation, task: bannerOk ? (banner as { task: string }).task : null, requireReady: true, now: d.now }));
  d.add(judgeQuiet(authority, { money: spec.quiet, relayQueue: spec.quiet }));
  if (d.checks.precheck.some((c) => c.status !== "pass")) return null;
  return { state, authority, task: (banner as { task: string }).task };
}

/* ------------------------------------------------------------------ */
/* Shared observation pieces                                            */
/* ------------------------------------------------------------------ */

/** Exactly one single-host instance besides a DECLARED stale one: `serving`, running. */
function judgeOneHost(instances: readonly { readonly instanceId: string; readonly state: string }[], serving: string, stale: string | null): CertCheck {
  const live = instances.filter((i) => i.state !== "terminated" && i.instanceId !== stale);
  return decide("one host: exactly one single-host instance", live.length === 1 && live[0].instanceId === serving && live[0].state === "running", `${serving} running${stale === null ? "" : ` (stale ${stale} judged separately)`}`, `instances: ${live.map((i) => `${i.instanceId} ${i.state}`).join(", ") || "none"}: not ONE host`);
}

/** The real-AL2023 check (every scenario): PASS only through the production world, from an Amazon Linux 2023 host. */
function realHost(d: Drill, state: HostState | null): CertCheck {
  if (!d.live) return unknown("real AL2023 host (the systemd contract)", `${REQUIRES_REAL_AL2023}: this evidence came through the "${d.deps.world.host.label}" transport, not the production SSM world; offline evidence never certifies the AL2023 / systemd behaviour`);
  if (state === null) return unknown("real AL2023 host (the systemd contract)", `${REQUIRES_REAL_AL2023}: the host was not observed`);
  return decide("real AL2023 host (the systemd contract)", state.osId === "amzn" && state.osVersionId === "2023" && state.systemdMajor !== null && state.systemdMajor >= 232 && /^i-[0-9a-f]{8,17}$/.test(state.instanceId), `${state.osId} ${state.osVersionId}, ${state.systemdVersion}, ${state.instanceId} over SSM`, `the host is ${state.osId} ${state.osVersionId} (${state.systemdVersion}), not Amazon Linux 2023`);
}

/** The host serves again with a NEW process (its banner since `sinceMs`), and that process is the one consistent writer
 *  whose ownership MOVED from `before`. */
async function judgeServingAgain(d: Drill, label: string, sinceMs: number, before: AuthoritySnapshot, oldTask: string): Promise<{ readonly state: HostState | null; readonly authority: AuthoritySnapshot | null; readonly task: string | null }> {
  const { input } = d;
  const wait = await d.poll(`${label}: serving`, sinceMs, d.timing.readyTimeoutMs, (s) => serving(s) && latestBanner(s, secondsOf(sinceMs) - 5) !== null);
  if (!wait.met || wait.state === null) {
    d.add(wait.state === null ? unknown(`${label}: the service is serving again`, `the host was never observed (${wait.unread} unread)`) : failed(`${label}: the service is serving again`, `not serving within ${d.timing.readyTimeoutMs / 1000} s: ActiveState ${wait.state.props.ActiveState}/${wait.state.props.SubState}, readyz ${wait.state.readyz}, banner ${latestBanner(wait.state, secondsOf(sinceMs) - 5)?.task ?? "none"}`));
    return { state: wait.state, authority: null, task: null };
  }
  const s = wait.state;
  const banner = latestBanner(s, secondsOf(sinceMs) - 5) as NonNullable<ReturnType<typeof latestBanner>>;
  d.add(passed(`${label}: the service is serving again`, `ready; new process ${banner.task}`));
  d.add(decide(`${label}: a new process`, banner.task !== oldTask, `${oldTask} -> ${banner.task}`, `the banner still names ${oldTask}`));
  d.add(decide(`${label}: no HOLD`, !s.hold.present, "no HOLD", `a HOLD exists: ${String(s.hold.text)}`));
  d.add(decide(`${label}: one gs-server container`, serverContainers(s).length === 1 && rivals(s).length === 0, "exactly one, no rival", `${serverContainers(s).length} gs-server, ${rivals(s).length} rival(s)`));
  d.add(decide(`${label}: the same release`, s.releaseDigest === input.digest && s.releaseBuild === input.build, input.digest, `release.env is ${s.releaseBuild} (${s.releaseDigest})`));
  /* The heartbeat of a fresh process may lag its readiness by one 30 s beat: read the authorities until consistent. */
  let authority = await d.authority(`${label}: after`);
  for (let i = 0; i < 8 && judgeSingleWriter(authority, writerExpect(d, label, banner.task)).some((c) => c.status !== "pass"); i += 1) {
    await d.deps.world.sleep(d.timing.pollMs);
    authority = await d.authority(`${label}: after (re-read ${i + 1})`);
  }
  d.add(judgeSingleWriter(authority, writerExpect(d, `${label}: writer`, banner.task)));
  d.add(judgeOwnershipMoved(`${label}: ownership`, before, authority));
  return { state: s, authority, task: banner.task };
}

const writerExpect = (d: Drill, label: string, task: string | null, requireReady = true) => ({ label, pool: d.input.pool, environment: d.input.environment, generation: d.input.generation, task, requireReady, now: d.now });

/** The recorder: install (mutation) and how many observations it already holds. */
async function installRecorder(d: Drill): Promise<boolean> {
  const lines = await d.mutate("install the ExecStopPost recorder (drill-only drop-in)", { kind: "recorder-install", run: d.input.run });
  return lines !== null && exitOf(lines) === 0;
}

/** Cleanup: the recorder removed (its observations were already captured); a failure is a cleanup FAIL. */
async function removeRecorder(d: Drill): Promise<void> {
  const lines = await d.host("remove the ExecStopPost recorder", { kind: "recorder-remove", run: d.input.run });
  d.add(lines === null ? failed("cleanup: the recorder removed", "the removal's outcome is unknown: check the host (gs-server.service.d/90-gs-cert-*.conf) by hand") : decide("cleanup: the recorder removed", exitOf(lines) === 0, "drop-in, recorder and observations removed; daemon reloaded", `exit ${String(exitOf(lines))}`));
}

/**
 * Cleanup: the service is serving the expected release. If it is not, and the DRILL is the known cause, ONE explicit
 * gs-deploy of the same release (the runbook's recovery: "remove the extra container, then gs-deploy the same release").
 * Never when the fleet is not exactly this one host (an unknown situation is left for the operator: FAIL).
 */
async function ensureServing(d: Drill, label: string, sinceMs: number): Promise<HostState | null> {
  const s = await d.observe(`${label}: state`, sinceMs);
  if (s !== null && serving(s) && !s.hold.present && rivals(s).length === 0) {
    d.add(passed(`${label}: the service serves`, "no recovery needed"));
    return s;
  }
  if (s !== null && rivals(s).length > 0) {
    const r = await d.host(`${label}: remove the rival`, { kind: "rival-stop", run: d.input.run });
    d.add(r === null || exitOf(r) !== 0 ? failed(`${label}: the rival removed`, "the rival container could not be removed: remove gs-cert-rival-* by hand, then gs-deploy") : passed(`${label}: the rival removed`, "gs-cert-rival stopped and gone"));
  }
  const fleet = await d.deps.world.fleet.hostInstances(d.input.environment);
  if (!fleet.ok || fleet.value.filter((i) => i.state !== "terminated").length !== 1) {
    d.add(failed(`${label}: recovery`, `the service is not serving and the fleet is ${fleet.ok ? `${fleet.value.length} instance(s)` : `unreadable (${fleet.detail})`}: NOT recovered automatically -- the operator investigates, then gs-deploy`));
    return s;
  }
  const lines = await d.host(`${label}: gs-deploy the same release`, { kind: "deploy", run: d.input.run, digest: d.input.digest, build: d.input.build });
  const after = await d.observe(`${label}: after recovery`, sinceMs);
  d.add(decide(`${label}: recovered by gs-deploy`, lines !== null && exitOf(lines) === 0 && after !== null && serving(after) && !after.hold.present, "gs-deploy of the same release: serving", `gs-deploy ${lines === null ? "outcome unknown" : `exit ${String(exitOf(lines))}`}; ${after === null ? "not observed" : `ActiveState ${after.props.ActiveState}, readyz ${after.readyz}, hold ${after.hold.present ? "PRESENT" : "absent"}`}`));
  return after;
}

/** The postcheck (every scenario): final health, the drill left nothing behind, one consistent writer. */
async function postcheck(d: Drill, sinceMs: number): Promise<void> {
  d.phase = "postcheck";
  const s = await d.observe("final", sinceMs);
  if (s === null) {
    d.add(unknown("final health: observed", "the host could not be observed"));
    return;
  }
  d.facts.final_health = { readyz: s.readyz, active: `${s.props.ActiveState}/${s.props.SubState}`, hold: s.hold.present ? s.hold.text : "absent", release: s.releaseBuild };
  d.add(decide("final health: serving", serving(s), "active/running, readyz 200", `ActiveState ${s.props.ActiveState}/${s.props.SubState}, readyz ${s.readyz}`));
  d.add(decide("final health: no HOLD", !s.hold.present, "none", String(s.hold.text)));
  d.add(decide("final health: the drill left nothing", !ourDropIn(s, d.input.run) && rivals(s).length === 0 && s.dropIns.filter((x) => x.startsWith("90-gs-cert-")).length === 0, "no recorder drop-in, no rival container", `drop-ins ${s.dropIns.join(", ") || "none"}; rivals ${rivals(s).map((r) => r.name).join(", ") || "none"}`));
  d.add(decide("final health: one gs-server container", serverContainers(s).length === 1, "exactly one", `${serverContainers(s).length}`));
  d.add(decide("final health: the expected release", s.releaseDigest === d.input.digest && s.releaseBuild === d.input.build, d.input.build, `${s.releaseBuild} (${s.releaseDigest})`));
  const banner = latestBanner(s, 0);
  const a = await d.authority("final");
  d.add(judgeSingleWriter(a, writerExpect(d, "final writer", banner?.task ?? null)));
  if (banner === null) d.add(unknown("final writer: tied to the host's process", "no startup banner in the journal window"));
}

/* ------------------------------------------------------------------ */
/* The scenarios                                                        */
/* ------------------------------------------------------------------ */

async function gracefulStop(d: Drill, base: Baseline): Promise<void> {
  const t0 = d.now;
  d.phase = "mutation";
  if (!(await installRecorder(d))) return;
  const before = await d.observe("before gs-stop", t0);
  if (before === null) return d.add(unknown("the state before gs-stop", "not observed"));
  const exitsBefore = before.exits.length;
  const restartsBefore = nRestarts(before);
  const tStop = d.now;
  const stop = await d.mutate("gs-stop (graceful SIGTERM drain)", { kind: "stop", run: d.input.run });
  d.phase = "observation";
  if (stop !== null) {
    /* Readiness first: the samples (code transitions) must show 503 from a live process BEFORE the process is gone. */
    const samples = textsOf(stop, "S").map((t) => /^([0-9]{10,16}) ([0-9]{3})$/.exec(t)).filter((m): m is RegExpExecArray => m !== null).map((m) => ({ at: Number(m[1]), code: m[2] }));
    d.facts.readiness_samples = samples;
    const first503 = samples.findIndex((x) => x.code === "503");
    const firstGone = samples.findIndex((x) => x.code === "000");
    const back200 = first503 >= 0 && samples.slice(first503).some((x) => x.code === "200");
    if (samples.length === 0 || samples[0].code !== "200") d.add(unknown("F7: readiness goes unavailable first", `the sampler did not see the server ready before the stop (${samples.map((x) => x.code).join(" -> ") || "no sample"})`));
    else if (back200) d.add(failed("F7: readiness goes unavailable first", `readiness came BACK to 200 after it went 503 (${samples.map((x) => x.code).join(" -> ")})`));
    else if (first503 >= 0 && (firstGone < 0 || first503 < firstGone)) d.add(passed("F7: readiness goes unavailable first", `${samples.map((x) => x.code).join(" -> ")} (503 at ${isoOf(samples[first503].at)})`));
    else d.add(unknown("F7: readiness goes unavailable first", `no 503 was sampled before the process was gone (${samples.map((x) => x.code).join(" -> ")}): too fast to observe at 0.2 s (NOT EVALUATED, never PASS)`));
  }
  const after = await d.observe("after gs-stop", tStop);
  if (after === null) d.add(unknown("F7: the stopped state", "not observed"));
  else {
    const exit = judgeExit("F7", after, exitsBefore, { kind: "graceful" });
    d.add(exit.checks);
    d.facts.exit_observed = exit.observed;
    d.add(decide("F7: stopped, not restarted", down(after) && nRestarts(after) === restartsBefore, `ActiveState ${after.props.ActiveState}, NRestarts ${String(nRestarts(after))}`, `ActiveState ${after.props.ActiveState}, NRestarts ${String(restartsBefore)} -> ${String(nRestarts(after))}, container ${runningServer(after) === null ? "gone" : "RUNNING"}`));
    d.add(decide("F7: ExecMainCode / ExecMainStatus = exited 0", after.props.ExecMainCode === "1" && after.props.ExecMainStatus === "0", "exited 0", `ExecMainCode ${after.props.ExecMainCode} ExecMainStatus ${after.props.ExecMainStatus}`));
  }
  d.phase = "mutation";
  const tDeploy = d.now;
  await d.mutate("gs-deploy the same digest", { kind: "deploy", run: d.input.run, digest: d.input.digest, build: d.input.build });
  d.phase = "observation";
  const again = await judgeServingAgain(d, "F7 redeploy", tDeploy, base.authority, base.task);
  if (again.authority !== null && base.authority.routing.state === "ok" && again.authority.routing.state === "ok") d.add(decide("F7: authorities remain this generation / pool", again.authority.routing.value.primary_pool === d.input.pool, `generation ${d.input.generation}, pool ${d.input.pool}`, `routing ${again.authority.routing.value.primary_pool}`));
  d.add(realHost(d, after));
}

async function crashRestart(d: Drill, base: Baseline): Promise<void> {
  const t0 = d.now;
  d.phase = "mutation";
  if (!(await installRecorder(d))) return;
  const before = await d.observe("before the kill", t0);
  if (before === null) return d.add(unknown("the state before the kill", "not observed"));
  const tKill = d.now;
  const kill = await d.mutate("docker kill --signal KILL gs-server (ungraceful)", { kind: "kill-container", run: d.input.run });
  if (kill === null || exitOf(kill) !== 0) return;
  d.phase = "observation";
  let holdSeen = false;
  const back = await d.poll("F8 after the kill", tKill, d.timing.restartTimeoutMs, (s) => serving(s) && latestBanner(s, secondsOf(tKill) - 5) !== null, (s) => {
    holdSeen = holdSeen || s.hold.present;
  });
  if (back.state === null) d.add(unknown("F8: the restart", "the host was never observed after the kill"));
  else {
    const exit = judgeExit("F8", back.state, before.exits.length, { kind: "crash" });
    d.add(exit.checks);
    d.facts.exit_observed = exit.observed;
    d.add(decide("F8: no HOLD at any observation", !holdSeen && !back.state.hold.present, "never on HOLD", "a HOLD appeared after an ordinary crash"));
    const rb = nRestarts(before);
    const ra = nRestarts(back.state);
    d.add(rb === null || ra === null ? unknown("F8: systemd restarted it (once)", "NRestarts unreadable") : decide("F8: systemd restarted it (once)", ra === rb + 1, `NRestarts ${rb} -> ${ra}`, `NRestarts ${rb} -> ${ra} (expected exactly one automatic restart)`));
  }
  await judgeServingAgain(d, "F8 restart", tKill, base.authority, base.task);
  d.add(realHost(d, back.state));
}

async function rebootRestart(d: Drill, base: Baseline): Promise<void> {
  const t0 = d.now;
  d.phase = "mutation";
  if (!(await installRecorder(d))) return;
  const before = await d.observe("before the reboot", t0);
  if (before === null) return d.add(unknown("the state before the reboot", "not observed"));
  const tReboot = d.now;
  const reboot = await d.mutate("reboot the host", { kind: "reboot", run: d.input.run });
  if (reboot === null || exitOf(reboot) !== 0) return;
  d.phase = "observation";
  await d.deps.world.sleep(30_000);
  const up = await d.poll("F8 reboot: host back", tReboot, d.timing.rebootDownTimeoutMs, (s) => s.bootId !== before.bootId);
  if (!up.met || up.state === null) {
    d.add(up.state === null ? unknown("F8 reboot: the host came back", `not observed within ${d.timing.rebootDownTimeoutMs / 1000} s`) : failed("F8 reboot: the host rebooted", `the boot id is still ${before.bootId}`));
    return;
  }
  d.add(passed("F8 reboot: the host rebooted", `boot ${before.bootId} -> ${up.state.bootId}`));
  const again = await judgeServingAgain(d, "F8 reboot", tReboot, base.authority, base.task);
  if (again.state !== null) {
    const shutdown = again.state.exits.slice(before.exits.length).filter((e) => e.boot === before.bootId);
    if (shutdown.length !== 1) d.add(unknown("F8 reboot: the shutdown's exit (ExecStopPost)", `${shutdown.length} recorder observation(s) from the old boot (one expected)`));
    else d.add(decide("F8 reboot: the shutdown's exit was not a fence exit", !(shutdown[0].code === "exited" && (shutdown[0].status === "3" || shutdown[0].status === "5")), `EXIT_CODE=${shutdown[0].code} EXIT_STATUS=${shutdown[0].status}`, `the shutdown exited ${shutdown[0].status}: a fence exit`));
    d.add(decide("F8 reboot: the unit is enabled", again.state.props.UnitFileState === "enabled", "enabled", `UnitFileState ${again.state.props.UnitFileState}`));
  }
  d.add(realHost(d, up.state));
}

async function duplicatePreflight(d: Drill, base: Baseline): Promise<void> {
  const t0 = d.now;
  d.phase = "mutation";
  const probe = await d.mutate("gs-preflight while gs-server runs", { kind: "preflight-probe", run: d.input.run }, (code) => code !== 0);
  d.phase = "observation";
  if (probe !== null) {
    const said = textsOf(probe, "O").join(" ");
    d.add(decide("F9a: the preflight refuses because a server runs", /already (running|restarting|paused)/.test(said) && /REFUSED/.test(said), said.slice(0, 200), `the preflight said: ${said.slice(0, 200) || "(nothing)"}`));
  }
  const s = await d.observe("after the preflight", t0);
  if (s === null) d.add(unknown("F9a: nothing else changed", "not observed"));
  else {
    const c0 = runningServer(base.state);
    const c1 = runningServer(s);
    d.add(decide("F9a: the same serving container, no second gs-server", c0 !== null && c1 !== null && c0.id === c1.id && serverContainers(s).length === 1, `container ${c1?.id.slice(0, 12)}`, `before ${c0?.id.slice(0, 12) ?? "none"}, after ${c1?.id.slice(0, 12) ?? "none"}, ${serverContainers(s).length} gs-server container(s)`));
    d.add(decide("F9a: the same systemd invocation", s.props.InvocationID === base.state.props.InvocationID && s.props.ExecMainPID === base.state.props.ExecMainPID && nRestarts(s) === nRestarts(base.state), `invocation ${s.props.InvocationID.slice(0, 12)}`, "the service was restarted or replaced"));
    d.add(decide("F9a: still serving", serving(s), "readyz 200", `readyz ${s.readyz}`));
  }
  const a = await d.authority("F9a after");
  d.add(judgeOwnershipUnchanged("F9a", base.authority, a));
  d.add(realHost(d, s));
}

async function duplicateFence(d: Drill, base: Baseline): Promise<void> {
  const { input } = d;
  const t0 = d.now;
  d.phase = "mutation";
  if (!(await installRecorder(d))) return;
  const before = await d.observe("before the rival", t0);
  if (before === null) return d.add(unknown("the state before the rival", "not observed"));
  const restartsBefore = nRestarts(before);
  const tRival = d.now;
  const rival = await d.mutate("start the rival (same image and env, no port, not under systemd)", { kind: "rival-start", run: input.run });
  if (rival === null || exitOf(rival) !== 0) return;
  d.phase = "observation";
  /* 1. The incumbent is fenced: it exits, systemd records a stop. */
  /* Until the incumbent is gone: the recorder saw a stop, or the serving container is no longer the incumbent's. */
  const incumbent = runningServer(before)?.id ?? null;
  const fenced = await d.poll("F9b fence", tRival, d.timing.fenceTimeoutMs, (s) => s.exits.length > before.exits.length || runningServer(s)?.id !== incumbent);
  if (!fenced.met || fenced.state === null) {
    d.add(fenced.state === null ? unknown("F9b: the incumbent was fenced", "the host was never observed after the rival started") : failed("F9b: the incumbent was fenced", `within ${d.timing.fenceTimeoutMs / 1000} s the incumbent did not exit (ActiveState ${fenced.state.props.ActiveState}, recorder ${fenced.state.exits.length - before.exits.length} new stop(s)): TWO writers may be running`));
    return;
  }
  const exit = judgeExit("F9b", fenced.state, before.exits.length, { kind: "fence" });
  d.add(exit.checks);
  d.facts.exit_observed = exit.observed;
  const fenceExit = exit.observed !== null && exit.observed.code === "exited" && (exit.observed.status === "3" || exit.observed.status === "5");
  /* 2. NOT restarted: still down after RestartSec + margin, NRestarts unchanged, no container. */
  await d.deps.world.sleep(d.timing.settleMs);
  const settled = await d.observe("F9b settled", tRival);
  if (settled === null) d.add(unknown("F9b: systemd did NOT restart it", "not observed after the settle period"));
  else {
    d.add(decide("F9b: systemd did NOT restart it", down(settled) && nRestarts(settled) === restartsBefore && settled.props.Result !== "success", `ActiveState ${settled.props.ActiveState} (${settled.props.Result}), NRestarts ${String(nRestarts(settled))}, no gs-server process`, `ActiveState ${settled.props.ActiveState}/${settled.props.SubState}, NRestarts ${String(restartsBefore)} -> ${String(nRestarts(settled))}, container ${runningServer(settled) === null ? "none" : "RUNNING"}: an AUTOMATIC RESTART after a fence takes the pool back`));
    d.add(decide("F9b: the HOLD is still there", settled.hold.present, String(settled.hold.text), "the HOLD disappeared without gs-deploy / gs-rollback"));
  }
  /* 3. The rival holds the pool: a strictly newer epoch, the roles with it. */
  const a1 = await d.authority("F9b after the fence");
  const rivalTask = writerOf(a1).task;
  d.add(judgeSingleWriter(a1, writerExpect(d, "F9b rival writer", null, false)));
  d.add(judgeOwnershipMoved("F9b fence", base.authority, a1));
  d.add(decide("F9b: the new writer is not the incumbent", rivalTask !== null && rivalTask !== base.task, `rival ${String(rivalTask)}`, `the writer is ${String(rivalTask)}`));
  if (!fenceExit) d.add(unknown("F9b: the HOLD steps (refusals, reboot, deploy)", "the incumbent's exit was not PROVEN 3/5 (see above): the HOLD recovery steps are not run -- NOT EVALUATED, and cleanup recovers the host"));
  else {
    /* 4. The HOLD refuses an ordinary preflight and start. */
    d.phase = "mutation";
    const pre = await d.mutate("gs-preflight on HOLD", { kind: "preflight-probe", run: input.run }, (c) => c !== 0);
    d.phase = "observation";
    if (pre !== null) d.add(decide("F9b: the preflight refuses on HOLD", /on HOLD/.test(textsOf(pre, "O").join(" ")), "REFUSED: on HOLD", `the preflight said: ${textsOf(pre, "O").join(" ").slice(0, 200)}`));
    d.phase = "mutation";
    const start = await d.mutate("systemctl start on HOLD", { kind: "start-attempt", run: input.run }, (c) => c !== 0 && c !== 90);
    d.phase = "observation";
    if (start !== null) d.add(decide("F9b: an ordinary start is refused on HOLD", keyed(start, "server_container") !== "running" && keyed(start, "active_state") !== "active", `active ${String(keyed(start, "active_state"))}, container ${String(keyed(start, "server_container"))}`, `after systemctl start: active ${String(keyed(start, "active_state"))}, container ${String(keyed(start, "server_container"))}`));
    const a2 = await d.authority("F9b after the refused start");
    d.add(judgeOwnershipUnchanged("F9b refused start", a1, a2));
    /* 5. The rival leaves; 6. REBOOT: the HOLD survives, nothing starts, nothing takes the pool. */
    d.phase = "mutation";
    await d.mutate("stop the rival (graceful)", { kind: "rival-stop", run: input.run });
    const preBoot = await d.observe("F9b before the reboot", tRival);
    d.phase = "observation";
    if (preBoot !== null) {
      d.add(decide("F9b: the rival is gone, the HOLD stays", rivals(preBoot).length === 0 && preBoot.hold.present && runningServer(preBoot) === null, `no rival; HOLD ${String(preBoot.hold.text)}`, `rivals ${rivals(preBoot).map((r) => r.name).join(", ") || "none"}; HOLD ${preBoot.hold.present ? "present" : "CLEARED without gs-deploy"}; gs-server ${runningServer(preBoot) === null ? "down" : "RUNNING"}`));
    }
    d.phase = "mutation";
    const tReboot = d.now;
    const rebootLines = preBoot === null || rivals(preBoot).length > 0 ? null : await d.mutate("reboot the host on HOLD", { kind: "reboot", run: input.run });
    const rebooted = rebootLines !== null && exitOf(rebootLines) === 0 ? rebootLines : null;
    d.phase = "observation";
    if (preBoot === null || rebooted === null) d.add(unknown("F9b: the HOLD survives a reboot", "the reboot was not made (see the steps)"));
    else {
      await d.deps.world.sleep(30_000);
      let processSeen = false;
      const up = await d.poll("F9b after the reboot", tReboot, d.timing.rebootDownTimeoutMs, (s) => s.bootId !== preBoot.bootId && down(s), (s) => {
        if (s.bootId !== preBoot.bootId) processSeen = processSeen || runningServer(s) !== null || s.readyz === "200";
      });
      if (up.state === null || up.state.bootId === preBoot.bootId) d.add(unknown("F9b: the HOLD survives a reboot", "the host was not observed after a reboot"));
      else {
        d.add(passed("F9b: the host rebooted", `boot ${preBoot.bootId} -> ${up.state.bootId}`));
        d.add(decide("F9b: the HOLD survives the reboot", up.state.hold.present, String(up.state.hold.text), "the HOLD is GONE after the reboot"));
        d.add(decide("F9b: no server process after the reboot", !processSeen && runningServer(up.state) === null && up.state.readyz !== "200", "no gs-server process, readyz not 200", "a gs-server process RAN after the reboot while on HOLD"));
        d.add(up.met ? passed("F9b: the service settled down after the reboot", `ActiveState ${up.state.props.ActiveState} (${up.state.props.Result})`) : unknown("F9b: the service settled down after the reboot", `still ${up.state.props.ActiveState}/${up.state.props.SubState} (no process seen)`));
      }
      const a3 = await d.authority("F9b after the reboot");
      d.add(judgeOwnershipUnchanged("F9b reboot", a1, a3));
      d.phase = "mutation";
      const pre2 = await d.mutate("gs-preflight after the reboot", { kind: "preflight-probe", run: input.run }, (c) => c !== 0);
      d.phase = "observation";
      if (pre2 !== null) d.add(decide("F9b: the preflight still refuses after the reboot", /on HOLD/.test(textsOf(pre2, "O").join(" ")), "REFUSED: on HOLD", textsOf(pre2, "O").join(" ").slice(0, 200)));
    }
    /* 7. A REFUSED deploy keeps the HOLD; 8. only the explicit gs-deploy clears it. */
    d.phase = "mutation";
    await d.mutate("a gs-deploy that cannot pull (refused)", { kind: "deploy-refused-probe", run: input.run, build: input.build }, (c) => c !== 0 && c !== 90);
    d.phase = "observation";
    const kept = await d.observe("F9b after the refused deploy", tRival);
    if (kept === null) d.add(unknown("F9b: a refused deploy keeps the HOLD", "not observed"));
    else d.add(decide("F9b: a refused deploy keeps the HOLD", kept.hold.present && runningServer(kept) === null, String(kept.hold.text), kept.hold.present ? "a gs-server process is running" : "the HOLD was CLEARED by a deploy that did not succeed"));
    d.phase = "mutation";
    const tDeploy = d.now;
    await d.mutate("gs-deploy the same release (clears the HOLD)", { kind: "deploy", run: input.run, digest: input.digest, build: input.build });
    d.phase = "observation";
    const again = await judgeServingAgain(d, "F9b recovery", tDeploy, a1, rivalTask ?? base.task);
    if (again.authority !== null) {
      d.add(judgeOwnershipMoved("F9b recovery from the baseline", base.authority, again.authority));
      if (again.state !== null) d.add(decide("F9b: no duplicate writer survives", rivals(again.state).length === 0 && serverContainers(again.state).length === 1, "one gs-server, no rival", `${serverContainers(again.state).length} gs-server, rivals ${rivals(again.state).map((r) => r.name).join(", ")}`));
    }
  }
  d.add(realHost(d, fenced.state));
}

/** The replacement's baseline: everything the after-phase compares against; the lock stays HELD across the replacement. */
async function replacementBefore(d: Drill, base: Baseline): Promise<void> {
  d.phase = "observation";
  d.facts.replacement_baseline = {
    run: d.input.run,
    environment: d.input.environment,
    instance: d.input.instanceId,
    expected_ip: base.state.expectedIp,
    task: base.task,
    pool_epoch: writerOf(base.authority).epoch,
    identity_epoch: base.authority.identity.state === "ok" ? base.authority.identity.value.epoch : null,
    relayer_epoch: base.authority.relayer.state === "ok" ? base.authority.relayer.value.epoch : null,
    lock: d.lock,
    finished_at_ms: d.now,
  };
  d.add(passed("replacement: the baseline is recorded", `old host ${d.input.instanceId}, task ${base.task}, POOL epoch ${String(writerOf(base.authority).epoch)}; the drill lock stays held for replacement-after`));
  d.add(unknown("replacement: certified", "the before-phase certifies nothing: run the guarded replacement, then `host-cert replacement-after --before <this record>`"));
}

async function replacementAfter(d: Drill, base: Baseline): Promise<void> {
  const { input } = d;
  const b = input.replacementBefore as ReplacementBaseline;
  d.phase = "observation";
  d.add(decide("replacement: a NEW host serves", input.instanceId !== b.instance, `${b.instance} -> ${input.instanceId}`, `--instance-id is the old host ${b.instance}`));
  d.add(decide("replacement: the same serving Elastic IP", base.state.expectedIp === b.expected_ip, b.expected_ip, `the new host expects ${base.state.expectedIp}, the old served ${b.expected_ip}`));
  d.add(decide("replacement: the new host's process is the writer", writerOf(base.authority).task === base.task && base.task !== b.task, `${b.task} -> ${base.task}`, `the writer is ${String(writerOf(base.authority).task)}`));
  const e = writerOf(base.authority).epoch;
  d.add(decide("replacement: POOL epoch strictly newer", e !== null && e > b.pool_epoch, `${b.pool_epoch} -> ${String(e)}`, `${b.pool_epoch} -> ${String(e)}`));
  if (base.authority.identity.state === "ok") d.add(decide("replacement: identity-writer epoch strictly newer", base.authority.identity.value.epoch > b.identity_epoch, `${b.identity_epoch} -> ${base.authority.identity.value.epoch}`, `${b.identity_epoch} -> ${base.authority.identity.value.epoch}`));
  if (base.authority.relayer.state === "ok" && b.relayer_epoch !== null) d.add(decide("replacement: relayer epoch strictly newer", base.authority.relayer.value.epoch > b.relayer_epoch, `${b.relayer_epoch} -> ${base.authority.relayer.value.epoch}`, `${b.relayer_epoch} -> ${base.authority.relayer.value.epoch}`));
  /* The stale host: gone, stopped, or -- when the owner kept it reachable -- refusing its preflight and serving nothing. */
  const stale = input.staleInstanceId ?? null;
  const fleet = await d.deps.world.fleet.hostInstances(input.environment);
  d.add(fleet.ok ? judgeOneHost(fleet.value, input.instanceId, stale) : unknown("one host: the single-host instances", fleet.detail));
  const old = await d.deps.world.fleet.instance(b.instance);
  if (!old.ok) d.add(unknown("replacement: the old host's state", old.detail));
  else d.add(passed("replacement: the old host's state", old.value === null ? "terminated / gone" : `${old.value.state} (public ${String(old.value.publicIp)})`));
  if (old.ok && old.value !== null && old.value.state === "running" && stale !== b.instance) d.add(failed("replacement: no second running host", `the old host ${b.instance} is RUNNING and was not declared --stale-instance-id: two hosts`));
  if (stale === null) d.add(unknown("replacement: the stale host's preflight refuses (not the serving EIP)", "no reachable stale host (--stale-instance-id): proven offline only (tests/host-scripts.test.sh); live proof needs the retained old instance running"));
  else if (stale !== b.instance) d.add(failed("replacement: the stale host", `--stale-instance-id ${stale} is not the replaced host ${b.instance}`));
  else {
    const s0 = await d.observe("stale host", d.now - 3_600_000, stale);
    if (s0 === null) d.add(unknown("replacement: the stale host observed", "not reachable over SSM"));
    else {
      d.add(decide("replacement: the stale host does not hold the serving EIP", s0.publicIp !== b.expected_ip, `stale public ${s0.publicIp}`, `the stale host STILL answers as ${s0.publicIp}`));
      d.add(decide("replacement: the stale host serves nothing", runningServer(s0) === null && s0.readyz !== "200" && rivals(s0).length === 0, "no gs-server process", "the stale host is STILL SERVING: two writers"));
      d.phase = "mutation";
      const pre = await d.host("gs-preflight on the stale host", { kind: "preflight-probe", run: input.run }, stale);
      d.phase = "observation";
      if (pre === null) d.add(unknown("replacement: the stale host's preflight refuses (not the serving EIP)", "the probe's outcome is unknown"));
      else d.add(decide("replacement: the stale host's preflight refuses (not the serving EIP)", exitOf(pre) !== 0 && /not the serving Elastic IP/.test(textsOf(pre, "O").join(" ")), "REFUSED: not the serving Elastic IP", `exit ${String(exitOf(pre))}: ${textsOf(pre, "O").join(" ").slice(0, 200)}`));
      const a = await d.authority("after the stale probe");
      d.add(judgeOwnershipUnchanged("replacement: the stale host did not reacquire POOL", base.authority, a));
    }
  }
  d.add(realHost(d, base.state));
}

/* ------------------------------------------------------------------ */
/* One drill                                                            */
/* ------------------------------------------------------------------ */

export async function runDrill(input: DrillInput, deps: DrillDeps): Promise<DrillResult> {
  const d = new Drill(input, deps);
  const started = d.now;
  const spec = SCENARIOS[input.scenario];
  let base: Baseline | null = null;
  let refused = false;
  try {
    base = await precheck(d);
    refused = base === null;
    if (base !== null) {
      if (input.scenario === "graceful-stop") await gracefulStop(d, base);
      else if (input.scenario === "crash-restart") await crashRestart(d, base);
      else if (input.scenario === "reboot-restart") await rebootRestart(d, base);
      else if (input.scenario === "duplicate-preflight") await duplicatePreflight(d, base);
      else if (input.scenario === "duplicate-fence") await duplicateFence(d, base);
      else if (input.scenario === "replacement-before") await replacementBefore(d, base);
      else await replacementAfter(d, base);
    }
  } catch (error) {
    d.add(failed(`${d.phase}: an unexpected error`, error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error)));
  }
  /* CLEANUP / RECOVERY: always, after any mutation (a failure here is always a FAIL). */
  d.phase = "cleanup";
  const mutated = d.steps.some((s) => s.phase === "mutation");
  try {
    if (!refused && mutated) {
      if (["graceful-stop", "crash-restart", "reboot-restart", "duplicate-fence"].includes(input.scenario)) await removeRecorder(d);
      await ensureServing(d, "cleanup", started);
    } else d.add(passed("cleanup", refused ? "refused before any mutation: nothing to clean" : "nothing was mutated"));
  } catch (error) {
    d.add(failed("cleanup: an unexpected error", error instanceof Error ? error.message.slice(0, 300) : String(error)));
  }
  if (!refused) {
    try {
      await postcheck(d, started);
    } catch (error) {
      d.add(failed("postcheck: an unexpected error", error instanceof Error ? error.message.slice(0, 300) : String(error)));
    }
  }
  /* The lock: released on completion -- except replacement-before, which hands it to replacement-after. */
  d.phase = "cleanup";
  if (d.lock !== null && !d.lockLost) {
    if (input.scenario === "replacement-before" && !refused && verdictOf([...d.checks.precheck, ...d.checks.cleanup]) !== "FAIL") d.add(passed("cleanup: the drill lock", `kept for replacement-after until ${isoOf(d.lock.expires_at)}`));
    else {
      const r = await releaseLock(deps.lock.client, deps.lock.table, d.lock, d.now, `${input.scenario} finished`);
      d.add(r.kind === "held" ? passed("cleanup: the drill lock released", "released") : failed("cleanup: the drill lock released", r.kind === "refused" ? r.detail : r.detail));
    }
  }
  const all = [...d.checks.precheck, ...d.checks.mutation, ...d.checks.observation, ...d.checks.cleanup, ...d.checks.postcheck];
  const verdict: Verdict = refused ? "NOT EVALUATED" : verdictOf(all);
  const record: Record<string, unknown> = {
    format: HOST_CERT_FORMAT,
    run_id: input.run,
    scenario: input.scenario,
    property: spec.property,
    disruptive: spec.disruptive,
    source_commit: input.sourceCommit,
    environment: input.environment,
    generation: input.generation,
    pool: input.pool,
    game_table: input.gameTable,
    instance_id: input.instanceId,
    stale_instance_id: input.staleInstanceId ?? null,
    release: { digest: input.digest, build: input.build },
    operator: input.operator,
    transport: { label: deps.world.host.label, live: d.live, ssm_command_ids: d.steps.map((s) => s.command_id).filter((x): x is string => x !== null) },
    real_al2023: d.live ? "observed through the production world (see the check)" : REQUIRES_REAL_AL2023,
    started_at: isoOf(started),
    finished_at: isoOf(d.now),
    refused,
    verdict,
    phases: {
      precheck: d.checks.precheck,
      mutation: { steps: d.steps.filter((s) => s.phase === "mutation"), checks: d.checks.mutation },
      observation: d.checks.observation,
      cleanup: { steps: d.steps.filter((s) => s.phase === "cleanup"), checks: d.checks.cleanup },
      postcheck: d.checks.postcheck,
    },
    steps: d.steps,
    before: base === null ? null : { task: base.task, authority: authorityEvidence(base.authority), hold: base.state.hold.present ? base.state.hold.text : "absent", systemd_properties: base.state.props },
    observations: d.observations,
    authorities: d.authorities,
    facts: d.facts,
    lock: d.lock === null ? null : { run: d.lock.run, scenario: d.lock.scenario, expires_at: isoOf(d.lock.expires_at), outcome: d.lock.outcome, lost: d.lockLost },
  };
  return { verdict, refused, record };
}
