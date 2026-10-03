// server/src/aws/deploy/hostcert/hostCertTestSupport.ts
//
// COST-2C TEST SUPPORT ONLY (imported by hostCert.test.ts; nothing in production imports it -- a source guard pins that).
// A simulated single host, control plane, fleet and DynamoDB table behaving as COST-1 SAYS the real host behaves --
// with fault switches for every way it could NOT. It is never live (`isLiveWorld` is false for it): whatever it answers,
// it cannot certify AL2023 / systemd.

import { createHash } from "crypto";

import { ConditionalCheckFailedException, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type { HostCertReaders } from "./controlPlane";
import { HOST_FRAME, UNPULLABLE_DIGEST, type HostOp } from "./hostOps";
import type { FleetView, HostCertWorld, HostRun, HostTransport } from "./transport";

export const DIGEST = `sha256:${"a".repeat(64)}`;
export const BUILD = "build-2026-10-02";
export const INSTANCE = "i-0123456789abcdef0";
export const NEW_INSTANCE = "i-0fedcba9876543210";
export const EIP = "203.0.113.10";
export const RELAYER = "juno1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";
export const GAME_TABLE = "gs-staging-game-g1";

/** Every way the simulated world can misbehave (all off: COST-1's assumed behaviour). */
export interface Faults {
  /** systemd restarts the service after a fence exit (RestartPreventExitStatus not honoured). */
  restartAfterFence?: boolean;
  /** systemd restarts the service once after a fence, and the restarted process loses again at once (NRestarts moves). */
  restartAfterFenceOnce?: boolean;
  /** gs-exit-hold does not write the HOLD. */
  holdNotWritten?: boolean;
  /** ExecStopPost runs without EXIT_CODE / EXIT_STATUS. */
  exitVarsUnset?: boolean;
  /** The recorder records nothing (its drop-in did not take effect). */
  recorderSilent?: boolean;
  /** The recorder records the stop twice (ambiguous). */
  recorderTwice?: boolean;
  /** A takeover does not increase the pool epoch. */
  epochNotIncreasing?: boolean;
  /** The relayer role is left with the old task (identity moved, relayer did not). */
  relayerStays?: boolean;
  /** The HOLD disappears by itself (no deploy). */
  holdVanishes?: boolean;
  /** A refused deploy clears the HOLD anyway. */
  refusedDeployClears?: boolean;
  /** After a reboot on HOLD the server starts anyway. */
  processAfterRebootWithHold?: boolean;
  /** After a reboot on HOLD a server process runs briefly (seen by ONE observation), then dies without taking the pool. */
  transientProcessAfterReboot?: boolean;
  /** The fenced exit status (default 3). */
  fenceStatus?: number;
  /** The incumbent is never fenced by the rival (two writers). */
  noFence?: boolean;
  /** `docker stop` of the rival fails: it keeps running. */
  rivalStopFails?: boolean;
  /** The recorder removal fails (cleanup). */
  cleanupFails?: boolean;
  /** These host operations fail at the transport (outcome unknown). */
  transportFails?: ReadonlySet<string>;
  /** observe answers truncated (no END line) from the Nth call on (1-based). */
  truncateObserveFrom?: number;
  /** A secret-shaped line in the journal. */
  secretInJournal?: boolean;
  /** The killed process exits with this status instead of 137. */
  crashStatus?: number;
  /** gs-stop's process exits with this status instead of 0. */
  stopStatus?: number;
  /** The readiness samples during gs-stop. */
  stopSamples?: readonly string[];
  /** The stale (old) host still serves (replacement). */
  staleServing?: boolean;
  /** The stale host still holds the EIP (preflight passes there). */
  staleHoldsEip?: boolean;
  /** Reads of the control plane fail (unavailable). */
  authorityUnavailable?: boolean;
  /** The pool writer is a different task than the host's banner (another writer). */
  foreignWriter?: boolean;
}

interface Proc {
  task: string;
}

export class FakeControlPlane {
  pool = { epoch: 7, task: "t-0000000000000001" as string | null };
  identity = { epoch: 4, task: "t-0000000000000001", pool: "p1" };
  relayer = { epoch: 9, task: "t-0000000000000001", pool: "p1", pool_epoch: 7 };
  fence = 9;
  routing = { primary_pool: "p1", routing_version: 1 };
  appgen = 1;
  money = 0;
  relayq = 0;
  heartbeats = new Map<string, { ready: boolean; at: number; epoch: number; started: number }>();
  constructor(readonly faults: Faults, readonly now: () => number) {
    this.heartbeats.set("t-0000000000000001", { ready: true, at: now(), epoch: 7, started: now() - 3_600_000 });
  }
  takeover(task: string, ready: boolean): void {
    if (!this.faults.epochNotIncreasing) this.pool.epoch += 1;
    this.pool.task = task;
    this.identity = { epoch: this.identity.epoch + 1, task, pool: "p1" };
    if (!this.faults.relayerStays) {
      this.relayer = { epoch: this.relayer.epoch + 1, task, pool: "p1", pool_epoch: this.pool.epoch };
      this.fence = this.relayer.epoch;
    }
    this.heartbeats.set(task, { ready, at: this.now(), epoch: this.pool.epoch, started: this.now() });
  }
  readers(): HostCertReaders {
    const fail = () => {
      if (this.faults.authorityUnavailable) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
    };
    return {
      rotation: {
        routing: async () => (fail(), this.routing),
        pool: async () => (fail(), { writer_epoch: this.pool.epoch, writer_task: this.pool.task }),
        relayerRole: async () => (fail(), { account: RELAYER, ...this.relayer, taken_at: 1 }),
        relayerFence: async () => (fail(), { epoch: this.fence }),
        taskStatus: async (_c, _t, task) => {
          fail();
          const h = this.heartbeats.get(task);
          if (h === undefined) return null;
          for (const [k, v] of this.heartbeats) if (k === task) v.at = this.now();
          return { task, pool: "p1", poolEpoch: h.epoch, generation: 1, environment: "staging", role: "primary", phase: "serving", ready: h.ready, reasons: "", relayer: "usable", escrow: "active", updatedAt: this.now(), startedAt: h.started };
        },
        relayQueue: async () => (this.relayq === 0 ? { state: "empty", pages_read: "all" } : { state: "open", entries: this.relayq, oldest: [] }),
      },
      recovery: {
        generationMarker: async () => ({ generation: 1, game_table: GAME_TABLE, origin: "bootstrap", restored_from_generation: null, restored_from_table: null, restore_point: null, restore_id: null, prepared_at: 1, prepared_by: "bootstrap", claim: "c" }),
        appGeneration: async () => ({ current_generation: this.appgen, adoption: null }),
        generationServingProblem: (m, a, e) => (a === null || a.current_generation !== e.generation ? "APPGEN is not the document's generation" : m === null || m.game_table !== e.gameTable ? "the marker names another table" : null),
        identityState: async () => ({ restore: null, self: null, servingProblem: null }),
        reviews: async () => [],
        adoptionRecord: async () => null,
      },
      identityRole: async () => (fail(), { ...this.identity, taken_at: 1 }),
    };
  }
}

let taskCounter = 100;
const newTask = (): string => `t-${(taskCounter++).toString(16).padStart(16, "0")}`;

/** One simulated host (COST-1's gs-server.service, gs-exit-hold, gs-preflight, gs-deploy, docker). */
export class FakeHost {
  bootId = "11111111-1111-1111-1111-111111111111";
  hold: string | null = null;
  release = { digest: DIGEST, build: BUILD };
  active = "active";
  sub = "running";
  result = "success";
  execMainCode = "0";
  execMainStatus = "0";
  nRestarts = 0;
  invocation = "inv-1";
  enabled = true;
  proc: Proc | null = { task: "t-0000000000000001" };
  startedAt: number;
  containers = new Map<string, { state: string; id: string }>([["gs-server", { state: "running", id: "c".repeat(64) }]]);
  dropIns: string[] = [];
  exits: string[] = [];
  journal: string[] = [];
  banners: string[] = [];
  observeCalls = 0;
  publicIp = EIP;
  log: string[] = [];

  constructor(readonly cp: FakeControlPlane | null, readonly faults: Faults, readonly now: () => number, readonly instanceId: string = INSTANCE) {
    this.startedAt = Math.floor(now() / 1000) - 3600;
    this.banners.push(`${this.startedAt + 2} pool p1, generation 1, task t-0000000000000001`);
  }

  private sec(): number {
    return Math.floor(this.now() / 1000);
  }

  private j(text: string): void {
    this.journal.push(`${this.sec()}.000000 ip-10-0-0-1 ${text}`);
  }

  dieAfterObserve = false;

  start(takeover = true): void {
    const task = newTask();
    this.proc = { task };
    this.active = "active";
    this.sub = "running";
    this.result = "success";
    this.execMainCode = "0";
    this.execMainStatus = "0";
    this.invocation = `inv-${task}`;
    this.startedAt = this.sec();
    this.containers.set("gs-server", { state: "running", id: createHash("sha256").update(task).digest("hex") });
    this.banners.push(`${this.sec()} pool p1, generation 1, task ${task}`);
    this.j("systemd[1]: Started gs-server.service - 18Cosmos single host: game server (AWS storage mode).");
    if (takeover) this.cp?.takeover(task, true);
  }

  private stopPost(code: string | null, status: string | null): void {
    if (this.dropIns.length > 0 && !this.faults.recorderSilent) {
      const unset = this.faults.exitVarsUnset === true || code === null;
      const line = `EXIT_CODE_SET=${unset ? "" : "yes"} EXIT_CODE=${unset ? "" : code} EXIT_STATUS_SET=${unset ? "" : "yes"} EXIT_STATUS=${unset ? "" : status} SERVICE_RESULT=${this.result} AT_MS=${this.now()} BOOT=${this.bootId}`;
      this.exits.push(line);
      if (this.faults.recorderTwice) this.exits.push(line);
    }
    if (code === "exited" && (status === "3" || status === "5") && !this.faults.holdNotWritten && !this.faults.exitVarsUnset) {
      this.hold = `exit ${status} at 2026-10-02T22:00:00Z`;
      this.j(`gs-exit-hold[42]: gs: HOLD: the server exited ${status} (a proven loss or a role change); it stays stopped, across reboots, until gs-deploy / gs-rollback`);
    }
  }

  /** The main process exits (by itself, a kill, or a stop). */
  exit(status: number, cause: "self" | "stop"): void {
    this.containers.delete("gs-server");
    this.proc = null;
    this.execMainCode = "1";
    this.execMainStatus = String(status);
    this.result = status === 0 ? "success" : "exit-code";
    this.j(`systemd[1]: gs-server.service: Main process exited, code=exited, status=${status}/n/a`);
    this.stopPost("exited", String(status));
    const fence = status === 3 || status === 5;
    if (cause === "stop") {
      this.active = "inactive";
      this.sub = "dead";
      return;
    }
    if (fence && this.faults.restartAfterFenceOnce) this.nRestarts += 1;
    if (status !== 0 && (!fence || this.faults.restartAfterFence)) {
      this.nRestarts += 1;
      this.start();
      return;
    }
    this.active = status === 0 ? "inactive" : "failed";
    this.sub = status === 0 ? "dead" : "failed";
  }

  preflightRefusal(): string | null {
    if (this.hold !== null) return `gs: REFUSED: on HOLD since ${this.hold}: another process or host may own the pool; investigate (gamesDoctor aws status), then gs-deploy / gs-rollback clears it`;
    if (this.publicIp !== EIP && !this.faults.staleHoldsEip) return "gs: REFUSED: this host's public address is not the serving Elastic IP";
    if (this.containers.get("gs-server")?.state === "running") return "gs: REFUSED: a gs-server container is already running (one server per host)";
    return null;
  }

  readyz(): string {
    return this.proc !== null && this.containers.get("gs-server")?.state === "running" ? "200" : "000";
  }

  private frame(op: HostOp, body: string[]): string {
    const text = body.length === 0 ? "" : `${body.join("\n")}\n`;
    return [`${HOST_FRAME} BEGIN ${op.kind} ${op.run}`, ...body, `${HOST_FRAME} END ${op.kind} ${op.run} ${body.length} ${createHash("sha256").update(text).digest("hex")}`, ""].join("\n");
  }

  observeBody(op: Extract<HostOp, { kind: "observe" }>): string[] {
    if (this.faults.holdVanishes && this.hold !== null && this.proc === null) this.hold = null;
    const b: string[] = [];
    const k = (key: string, v: string) => b.push(`K ${key} ${v}`.trimEnd());
    k("boot_id", this.bootId);
    k("os_id", "amzn");
    k("os_version_id", "2023");
    k("systemd_version", "systemd 252 (252.23-2.amzn2023)");
    k("instance_id", this.instanceId);
    k("public_ip", this.publicIp);
    k("expected_ip", EIP);
    k("environment", "staging");
    k("release_digest", this.release.digest);
    k("release_build", this.release.build);
    if (this.hold !== null) {
      k("hold", "present");
      k("hold_text", this.hold);
    } else k("hold", "absent");
    k("readyz", this.readyz());
    k("now_ms", String(this.now()));
    for (const [n, v] of Object.entries({ ActiveState: this.active, SubState: this.sub, Result: this.result, ExecMainCode: this.execMainCode, ExecMainStatus: this.execMainStatus, ExecMainPID: this.proc === null ? "0" : "4242", NRestarts: String(this.nRestarts), UnitFileState: this.enabled ? "enabled" : "disabled", InvocationID: this.invocation, ExecMainStartTimestamp: `@${this.startedAt}`, ExecMainExitTimestamp: "" })) b.push(`P ${n}=${v}`);
    k("docker", "ok");
    for (const [name, c] of this.containers) b.push(`C ${name}|${c.state}|111111111111.dkr.ecr.us-east-1.amazonaws.com/gs-staging-server@${DIGEST}|${c.id}`);
    for (const x of this.exits.slice(-20)) b.push(`X ${x}`);
    for (const dname of this.dropIns) b.push(`D ${dname}`);
    const since = op.sinceEpochSeconds;
    for (const line of this.journal.filter((l) => Number(l.split(".")[0]) >= since).slice(-40)) b.push(`J ${line}`);
    if (this.faults.secretInJournal) b.push("J 1759442400.000000 ip-10-0-0-1 gs-run[7]: gs: AKIAABCDEFGHIJKLMNOP leaked");
    const bsince = Math.min(since, this.startedAt - 5);
    for (const t of this.banners.filter((l) => Number(l.split(" ")[0]) >= bsince).slice(-10)) b.push(`T ${t}`);
    return b;
  }

  run(op: HostOp, world: FakeWorld): string {
    this.log.push(op.kind);
    const E = (code: number, ...more: string[]) => this.frame(op, [`E ${code}`, ...more]);
    switch (op.kind) {
      case "observe": {
        this.observeCalls += 1;
        const out = this.frame(op, this.observeBody(op));
        if (this.dieAfterObserve) {
          this.dieAfterObserve = false;
          this.exit(1, "stop");
          this.active = "failed";
        }
        if (this.faults.truncateObserveFrom !== undefined && this.observeCalls >= this.faults.truncateObserveFrom) return out.split("\n").slice(0, 6).join("\n");
        return out;
      }
      case "observe-unit": {
        const b = ["K systemd_version systemd 252 (252.23-2.amzn2023)", "K os_id amzn", "K os_version_id 2023"];
        for (const [name, sha] of Object.entries(world.expectedFiles)) b.push(`S ${sha} ${name}`);
        b.push("U [Service]", "U RestartPreventExitStatus=3 5", "H # gs-exit-hold");
        b.push("P Restart=on-failure", "P RestartPreventExitStatus=3 5", "P ExecStopPost={ path=/opt/gs/bin/gs-exit-hold ; argv[]=/opt/gs/bin/gs-exit-hold ; ignore_errors=no }");
        return this.frame(op, b);
      }
      case "recorder-install":
        if (this.dropIns.some((x) => x !== `90-gs-cert-${op.run}.conf`)) return E(91, "R another drill's recorder is installed");
        this.dropIns = [`90-gs-cert-${op.run}.conf`];
        return E(0);
      case "recorder-remove":
        if (this.faults.cleanupFails) return E(1);
        this.dropIns = [];
        this.exits = [];
        return E(0);
      case "stop": {
        const samples = this.faults.stopSamples ?? ["200", "503", "000"];
        const t = this.now();
        if (this.proc !== null) this.exit(this.faults.stopStatus ?? 0, "stop");
        return E(0, "O gs: draining", ...samples.map((s, i) => `S ${t + i * 200} ${s}`));
      }
      case "deploy": {
        if (op.digest === UNPULLABLE_DIGEST) return E(1, "O gs: REFUSED: the pull failed");
        if (this.proc !== null) this.exit(0, "stop");
        this.hold = null;
        this.release = { digest: op.digest, build: op.build };
        this.enabled = true;
        this.start();
        return E(0, "O gs: deployed: READY");
      }
      case "deploy-refused-probe":
        if (this.hold === null) return E(90, "R refused: there is no HOLD");
        if (this.faults.refusedDeployClears) this.hold = null;
        return E(1, `O gs: pulling gs-staging-server@${UNPULLABLE_DIGEST}`, "O gs: REFUSED: the pull failed (nothing was stopped)");
      case "kill-container":
        if (this.proc === null) return E(90, "R refused: gs-server is absent, not running");
        this.exit(this.faults.crashStatus ?? 137, "self");
        return E(0, `K killed_at_ms ${this.now()}`);
      case "reboot": {
        const b = [`K boot_id ${this.bootId}`];
        if (this.proc !== null) this.exit(0, "stop");
        this.containers.forEach((_c, name) => {
          if (name.startsWith("gs-cert-rival-")) this.containers.delete(name);
        });
        world.rival = null;
        this.bootId = `${(Math.floor(Math.random() * 0xffffff) + 0x100000).toString(16)}-2222-2222-2222-222222222222`;
        this.nRestarts = 0;
        if (this.enabled) {
          if (this.hold === null || this.faults.processAfterRebootWithHold) this.start();
          else if (this.faults.transientProcessAfterReboot) {
            this.start(false);
            this.dieAfterObserve = true;
          } else {
            this.stopPost(null, null);
            this.active = "failed";
            this.sub = "failed";
            this.result = "start-limit-hit";
          }
        }
        return E(0, ...b);
      }
      case "preflight-probe": {
        const refusal = this.preflightRefusal();
        return refusal === null ? E(0, "O gs: preflight passed") : E(1, `O ${refusal}`);
      }
      case "start-attempt":
        if (this.hold === null) return E(90, "R refused: there is no HOLD");
        this.stopPost(null, null);
        this.active = "failed";
        return E(1, "O Job for gs-server.service failed because the control process exited with error code.", "K active_state failed", "K server_container absent");
      case "rival-start": {
        if (this.proc === null) return E(90, "R refused: gs-server is not running");
        const task = newTask();
        world.rival = task;
        this.containers.set(`gs-cert-rival-${op.run}`, { state: "running", id: "d".repeat(64) });
        this.cp?.takeover(task, true);
        if (!this.faults.noFence) this.exit(this.faults.fenceStatus ?? 3, "self");
        return E(0);
      }
      case "rival-stop":
        if (this.faults.rivalStopFails) return E(1, "R the rival container is still present");
        this.containers.delete(`gs-cert-rival-${op.run}`);
        world.rival = null;
        return E(0);
    }
  }
}

/** A simulated fleet + host(s) + clock. */
export class FakeWorld implements HostCertWorld {
  t = Date.parse("2026-10-02T22:00:00Z");
  rival: string | null = null;
  readonly cp: FakeControlPlane;
  readonly hosts = new Map<string, FakeHost>();
  instances: Array<{ instanceId: string; state: string; publicIp: string | null; launchTime: string | null }> = [{ instanceId: INSTANCE, state: "running", publicIp: EIP, launchTime: null }];
  eipOwner: string | null = INSTANCE;
  ecs = 0;
  expectedFiles: Record<string, string> = {};
  readonly now = (): number => this.t;
  readonly sleep = async (ms: number): Promise<void> => {
    this.t += ms;
  };
  readonly host: HostTransport;
  readonly fleet: FleetView;

  constructor(readonly faults: Faults = {}) {
    this.cp = new FakeControlPlane(faults, this.now);
    this.hosts.set(INSTANCE, new FakeHost(this.cp, faults, this.now, INSTANCE));
    if (faults.foreignWriter) this.cp.pool.task = "t-00000000000000ff";
    const world = this;
    this.host = {
      label: "fake",
      async run(instanceId: string, op: HostOp): Promise<HostRun> {
        world.t += 1_000;
        if (faults.transportFails?.has(op.kind)) return { ok: false, detail: "DeliveryTimedOut", commandId: null };
        const h = world.hosts.get(instanceId);
        if (h === undefined) return { ok: false, detail: "Undeliverable", commandId: null };
        return { ok: true, exitCode: 0, stdout: h.run(op, world), stderr: "", commandId: "00000000-0000-0000-0000-000000000000" };
      },
    };
    this.fleet = {
      hostInstances: async () => ({ ok: true, value: this.instances }),
      instance: async (id) => ({ ok: true, value: this.instances.find((i) => i.instanceId === id) ?? null }),
      addressOwner: async (ip) => ({ ok: true, value: { publicIp: ip, instanceId: this.eipOwner, networkInterfaceId: "eni-1", allocationId: "eipalloc-1" } }),
      ecsRunningTasks: async () => ({ ok: true, value: { count: this.ecs, absent: this.ecs === 0 } }),
    };
  }

  /** A host replacement performed outside the tool (the guarded Terraform step): a new host serves, the old stops. */
  replaceHost(keepOld: "terminated" | "running"): FakeHost {
    const old = this.hosts.get(INSTANCE) as FakeHost;
    if (old.proc !== null) old.exit(0, "stop");
    old.publicIp = this.faults.staleHoldsEip ? EIP : "198.51.100.7";
    if (this.faults.staleServing) old.start();
    const fresh = new FakeHost(null, this.faults, this.now, NEW_INSTANCE);
    fresh.proc = null;
    fresh.containers.clear();
    (fresh as { cp: FakeControlPlane | null }).cp = this.cp;
    fresh.start();
    this.hosts.set(NEW_INSTANCE, fresh);
    if (keepOld === "terminated") this.hosts.delete(INSTANCE);
    this.instances = [...(keepOld === "running" ? [{ instanceId: INSTANCE, state: "running", publicIp: old.publicIp, launchTime: null }] : []), { instanceId: NEW_INSTANCE, state: "running", publicIp: EIP, launchTime: null }];
    this.eipOwner = NEW_INSTANCE;
    return fresh;
  }
}

/* ------------------------------------------------------------------ */
/* A minimal DynamoDB double: the lock item, FINKEYS / FINIDX#           */
/* ------------------------------------------------------------------ */

type Item = Record<string, AttributeValue>;

function evaluate(expression: string, item: Item | undefined, names: Record<string, string>, values: Record<string, AttributeValue>): boolean {
  const attr = (token: string): AttributeValue | undefined => item?.[names[token] ?? token];
  const val = (v: AttributeValue | undefined): string | undefined => (v === undefined ? undefined : (v.S ?? v.N));
  return expression.split(" OR ").some((disjunct) =>
    disjunct.split(" AND ").every((term) => {
      const ne = /^attribute_not_exists\((#?\w+)\)$/.exec(term.trim());
      if (ne !== null) return attr(ne[1]) === undefined;
      const m = /^(#?\w+) (=|<>|<) (:\w+)$/.exec(term.trim());
      if (m === null) throw new Error(`the fake cannot evaluate ${term}`);
      const a = val(attr(m[1]));
      const b = val(values[m[3]]);
      if (m[2] === "=") return a !== undefined && a === b;
      if (m[2] === "<>") return a !== b;
      return a !== undefined && b !== undefined && Number(a) < Number(b);
    }),
  );
}

export interface FakeTable {
  readonly items: Map<string, Item>;
  /** The next PutItem applies and then its answer is lost (throws). */
  loseNextAnswer: boolean;
  /** Every call fails (unavailable). */
  down: boolean;
  /** After this many successful PutItems, another operator "reclaims" the lock (its claim changes). */
  stealAfterPuts: number | null;
  puts: number;
  readonly client: DynamoDBClient;
}

export function fakeTable(): FakeTable {
  const t: FakeTable = {
    items: new Map(),
    loseNextAnswer: false,
    down: false,
    stealAfterPuts: null,
    puts: 0,
    client: {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (t.down) throw Object.assign(new Error("unavailable"), { name: "InternalServerError" });
        const input = command.input as { Key?: Item; Item?: Item; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, AttributeValue> };
        const name = command.constructor.name;
        if (name === "GetItemCommand") {
          const k = `${input.Key?.pk?.S}|${input.Key?.sk?.S}`;
          const it = t.items.get(k);
          return it === undefined ? {} : { Item: it };
        }
        if (name === "QueryCommand") {
          const pk = (input.ExpressionAttributeValues?.[":pk"] as AttributeValue | undefined)?.S;
          return { Items: [...t.items.entries()].filter(([k]) => k.startsWith(`${pk}|`)).map(([, v]) => v) };
        }
        if (name === "PutItemCommand") {
          const k = `${input.Item?.pk?.S}|${input.Item?.sk?.S}`;
          if (input.ConditionExpression !== undefined && !evaluate(input.ConditionExpression, t.items.get(k), input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {})) throw new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
          t.items.set(k, input.Item as Item);
          t.puts += 1;
          if (t.stealAfterPuts !== null && t.puts === t.stealAfterPuts) t.items.set(k, { ...(input.Item as Item), claim: { S: "stolen-by-another-operator" }, run: { S: "another-run1" } });
          if (t.loseNextAnswer) {
            t.loseNextAnswer = false;
            throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
          }
          return {};
        }
        throw new Error(`the fake table does not answer ${name}`);
      },
    } as unknown as DynamoDBClient,
  };
  return t;
}

/** Open money games in the fake table (FINKEYS + FINIDX#). */
export function addMoneyGame(t: FakeTable, identity: string, game: string): void {
  const k = "FINKEYS|FINKEYS";
  const prev = t.items.get(k)?.keys?.SS ?? [];
  t.items.set(k, { pk: { S: "FINKEYS" }, sk: { S: "FINKEYS" }, keys: { SS: [...new Set([...prev, identity])] } });
  t.items.set(`FINIDX#${identity}|GAME#${game}`, { pk: { S: `FINIDX#${identity}` }, sk: { S: `GAME#${game}` }, game_id: { S: game } });
}
