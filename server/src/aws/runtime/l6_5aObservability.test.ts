// server/src/aws/runtime/l6_5aObservability.test.ts
//
// LIVE-6 L6-5A: the AWS task's runtime observability -- the metric lines (CloudWatch EMF on stdout) and the diagnostic
// TASK# item -- over the same kind of scripted substrate as L5-7's suite (the real game server, identity service and, for
// the escrow cases, the real Juno backend on ESCROW-3B's offline chain). What is pinned:
//
//   schema       every record is valid EMF, deterministic, in one namespace, with only the Environment and Pool
//                dimensions; the catalog's kinds, units and scopes; unknown names, bad values and unknown properties
//                dropped; forbidden shapes (games, principals, ARNs, wallets, keys, digests) never leave the task
//   counts       one task loss -> one TaskLost, however many fences report it; one forced store restart -> one
//                StoreUncertain; a sweep pass -> one record (passed or failed), with its counts and never its game ids
//   readiness    a transition is written once; the same answer asked again (probes, ticks) writes nothing; a flapping
//                answer is capped per minute with the sum kept exact; a healthy non-primary router is Ready (never Unready)
//   KMS          the gate's counters are the only counters: a successful Sign, a withheld one (KMS never called), and
//                transient / refused / invalid-answer / other failures each land in their own metric, as deltas, sent
//                once -- a line that failed carries its delta to the next
//   relayer      takeover outcomes and state transitions (not-taken -> taken-loading -> usable; held -> usable)
//   harmless     a sink that throws, a TASK# writer that throws or never answers: the same startup, readiness,
//                authority, KMS answers, exit codes and shutdown order as without them
//   TASK#        the item's shape and TTL, its ordering condition, single flight, non-primary / stopping phases, and a source
//                guard: nothing in the server reads it
//   boundary     PROCESS mode never reaches this code; no frontend, protocol or rules file is touched

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { startAwsRuntime, type AwsGameStores, type AwsRuntime, type AwsRuntimeInput, type AwsSubstrate, type IdentityStoreHandle, type RelayerIntentView, type RelayerRoleLike, type RelayerTakeover } from "./awsRuntime";
import { gatedKmsClient } from "./kmsGate";
import { ledgerFencedHook } from "../ownership/relayerRole";
import { AWS_RUNTIME_CONFIG_FORMAT, parseAwsRuntimeConfig } from "./runtimeConfig";
import {
  buildEmfRecord,
  codeList,
  createEmfSink,
  KMS_METRIC_OF,
  kmsDeltas,
  lossCauseOf,
  METRIC_NAMESPACE,
  METRIC_PROPERTIES,
  METRIC_SCHEMA,
  METRICS,
  NO_METRICS,
  readinessObserver,
  safeText,
  transitionTracker,
  type MetricSink,
} from "./runtimeMetrics";
import { dynamoTaskStatusWriter, TASK_STATUS_TTL_SECONDS, taskStatusItem, taskStatusReporter, type TaskStatus, type TaskStatusWriter } from "./taskStatus";
import { PoolWriterNotCurrentError, type HeldProbe } from "../ownership/poolWriter";
import { bootstrapGenerationMarker } from "../game/generationMarker";
import { createSessionVerifier } from "../../identity/verifier";
import type { OpenMoneyGames, PoolGameOwnership, SweepReport } from "../ownership/poolGameOwnership";
import type { RoleTakeover } from "../ownership/roles";
import { createMemoryChainIntentStore } from "../../escrow/chainIntents";
import { createMemoryFinancialGameStore } from "../../escrow/financialGameStore";
import { openJunoBackend, type JunoBackend, type JunoBackendDeps } from "../../escrow/juno/junoBackend";
import { JUNO_BACKEND_CONFIG_FORMAT_V3, parseJunoBackendConfig, type JunoBackendConfig } from "../../escrow/juno/junoConfig";
import { bigIntTo32, decompressPublicKey, publicKeyOf, signDigest } from "../../escrow/juno/secp256k1";
import { SignerError, type KmsClient } from "../../escrow/juno/signer";
import { createMemorySigningJournal, type InspectableSigningJournal } from "../../escrow/signingJournal";
import { createMemoryWalletTicketStore } from "../../escrow/walletTickets";
import { ADMISSION_PUBKEY, ADMISSION_SECRET, CANONICAL_CHECKSUM, CHAIN_ID, CONTRACT, GAME_A, makeWorld, RELAYER_ADDRESS, RELAYER_SECRET, SETTLEMENT_SECRET, type World } from "../../escrow/escrow3bSupport";
import { createMemoryGrantStore } from "../../identity/grants";
import { createMemorySecurityJournal } from "../../identity/securityEvents";
import { createMemoryIdentityStore } from "../../identity/store";
import { createMemoryOpsRecorder, type MemoryOpsRecorder } from "../../persistence/opsRecorder";
import { createMemoryHoldStore } from "../../rooms/holdStore";
import { createMemoryRecordStore } from "../../rooms/recordStore";
import { controlledStore, quietConsole } from "../../rooms/testSupport";

quietConsole();

const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:210987654321:table/gs-test-ledger";
const ESCROW_PARAM = "arn:aws:ssm:us-east-1:123456789012:parameter/gs/test/juno-backend";
const KEY = (n: number) => `arn:aws:kms:us-east-1:123456789012:key/${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const RELAYER_KEY = KEY(1);
const SETTLEMENT_KEY = KEY(2);
const ADMISSION_KEY = KEY(3);
const PRINCIPAL = "pr_0123456789abcdefghjkmnpqrs";

const runtimeDoc = (over: Record<string, unknown> = {}) => ({
  format: AWS_RUNTIME_CONFIG_FORMAT,
  environment: "test",
  region: "us-east-1",
  pool: "p1",
  generation: 1,
  game_table: "gs-test-game-g1",
  identity_table: "gs-test-identity",
  ledger_table_arn: LEDGER_ARN,
  escrow: null,
  ...over,
});

function escrowConfig(): JunoBackendConfig {
  const parsed = parseJunoBackendConfig(
    {
      format: JUNO_BACKEND_CONFIG_FORMAT_V3,
      chain_id: CHAIN_ID,
      network_class: "testnet",
      rest_endpoints: ["https://rest.example"],
      contract_address: CONTRACT,
      code_checksum: CANONICAL_CHECKSUM,
      wasm_admin: null,
      denom: "ujunox",
      asset_symbol: "JUNOX",
      relayer: { address: RELAYER_ADDRESS, signer: { kind: "kms", key_ref: RELAYER_KEY } },
      settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "kms", key_ref: SETTLEMENT_KEY } },
      admission_key: { public_key_hex: ADMISSION_PUBKEY, signer: { kind: "kms", key_ref: ADMISSION_KEY } },
      trust: { operators: [RELAYER_ADDRESS], resolvers: [RELAYER_ADDRESS], min_challenge_window_secs: "60", min_liveness_window_secs: "3600", min_resolver_timeout_secs: "3600" },
      journal: { kind: "dynamodb", table_arn: LEDGER_ARN },
    },
    { serverMode: "production", dataDir: "/nonexistent" },
  );
  return { ...parsed, trust: { ...parsed.trust, resolvers: ["juno1resolver"] } };
}

/* ---------------- a KMS stand-in at the port, with scripted failures ---------------- */
const SPKI_PREFIX = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");
function spkiOf(secret: Buffer): Buffer {
  const { x, y } = decompressPublicKey(publicKeyOf(secret));
  return Buffer.concat([SPKI_PREFIX, Buffer.from([0x04]), bigIntTo32(x), bigIntTo32(y)]);
}
function derInteger(value: Buffer): Buffer {
  let body = value;
  while (body.length > 1 && body[0] === 0 && !(body[1] & 0x80)) body = body.subarray(1);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}
function derOf(compact: Buffer): Buffer {
  const body = Buffer.concat([derInteger(compact.subarray(0, 32)), derInteger(compact.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
type KmsMode = "ok" | "transient" | "refused" | "invalid-answer" | "other";
const kmsCallError = (failure: string) => Object.assign(new Error(`KMS ${failure} for ${KEY(1)} (injected)`), { name: "KmsCallError", failure, signatureMayExist: false });
function kmsStandIn() {
  const keys: Record<string, Buffer> = { [RELAYER_KEY]: RELAYER_SECRET, [SETTLEMENT_KEY]: SETTLEMENT_SECRET, [ADMISSION_KEY]: ADMISSION_SECRET };
  const state = { mode: "ok" as KmsMode, signCalls: 0 };
  const port: KmsClient = {
    async getPublicKey(ref) {
      return spkiOf(keys[ref]);
    },
    async signDigest(ref, digest) {
      state.signCalls += 1;
      if (state.mode === "other") throw new Error("socket hang up (injected)");
      if (state.mode !== "ok") throw kmsCallError(state.mode);
      return derOf(signDigest(keys[ref], Buffer.from(digest)));
    },
  };
  return { port, state };
}

/* ---------------- the scripted substrate ---------------- */
class FakeWriter {
  readonly pool = "p1";
  readonly epoch = 7;
  lostReason: string | null = null;
  ready = true;
  gate: () => Promise<void> = async () => undefined;
  constructor(
    readonly task: string,
    private readonly onLost: (reason: string) => void,
  ) {}
  get fence() {
    return { pool: this.pool, epoch: this.epoch, task: this.task };
  }
  get lost(): string | null {
    return this.lostReason;
  }
  markLost(reason: string): void {
    if (this.lostReason !== null) return;
    this.lostReason = reason;
    this.onLost(reason);
  }
  start(): void {}
  stop(): void {}
  watchGeneration(_probe: HeldProbe): void {}
  async beforeSideEffect(): Promise<void> {
    if (this.lostReason !== null) throw new PoolWriterNotCurrentError(`lost: ${this.lostReason}`, true);
    await this.gate();
  }
  readiness() {
    return { ready: this.lostReason === null && this.ready, lost: this.lostReason, lastGoodAgeMs: this.ready ? 1_000 : 30_000 };
  }
}

type Ledger = InspectableSigningJournal & { readonly relayer: string };
type SweepStep = "throws" | SweepReport;

interface HarnessOptions {
  readonly primary?: boolean;
  /** The ledger's adopted generation (default 1, the document's). */
  readonly adopted?: number;
  readonly poolFails?: boolean;
  readonly escrow?: boolean;
  readonly relayer?: Array<"taken" | "throws" | "not-primary">;
  /** The sweep's answers, in order (then an empty report). Mutable through `h.sweeps`. */
  readonly sweeps?: SweepStep[];
  /** The metric sink: "record" (default), "throws" (every line fails), or none at all. */
  readonly sink?: "record" | "throws" | "none";
  /** The TASK# writer: "record" (default), "throws", "hangs", or none. */
  readonly taskStatus?: "record" | "throws" | "hangs" | "none";
  /** L6-5B: the game table's SYSTEM/GENERATION -- a bootstrap table (default), a RESTORED one the ledger adopted, a
   *  restored one it did NOT adopt, or a marker for another generation. */
  readonly marker?: "bootstrap" | "restore" | "restore-unadopted" | "other-generation";
  /** L6-5B: the identity table's restore is incomplete -- L6-4's IdentityRestoreIncompleteError thrown by the identity
   *  load, or (review M4: the main path) by the identity-writer role's takeover, which carries the serving checks. */
  readonly identityRestoreIncomplete?: "load" | "takeover";
  /** L6-5B: wrap the opened Juno backend (to script its relayer's status or its restore view). */
  readonly wrapBackend?: (backend: JunoBackend) => JunoBackend;
}

interface Harness {
  readonly exits: number[];
  readonly lines: string[];
  readonly metricLines: string[];
  /** The metric sink's `write` fails for the next lines whose event is listed here (then works again). */
  readonly failNext: string[];
  readonly ops: MemoryOpsRecorder;
  readonly world: World;
  readonly kms: ReturnType<typeof kmsStandIn>;
  readonly sweeps: SweepStep[];
  readonly taskWrites: Array<{ status: TaskStatus; seq: number; at: number }>;
  readonly hooks: {
    identity?: { onFenced(detail: string): void; onRestartRequired(detail: string): void };
    journal?: { onFenced(detail: string): void };
    ledger?: (which: "generation" | "relayer", detail: string) => void;
    backendDeps?: JunoBackendDeps;
  };
  readonly clock: { offset: number };
  writer(): FakeWriter;
  records(): Array<Record<string, any>>;
  byEvent(event: string): Array<Record<string, any>>;
  sum(metric: string): number;
  input(over?: Partial<AwsRuntimeInput<FakeWriter, Ledger>>): AwsRuntimeInput<FakeWriter, Ledger>;
  start(over?: Partial<AwsRuntimeInput<FakeWriter, Ledger>>): Promise<AwsRuntime>;
}

function harness(options: HarnessOptions = {}): Harness {
  const exits: number[] = [];
  const lines: string[] = [];
  const metricLines: string[] = [];
  const failNext: string[] = [];
  const taskWrites: Harness["taskWrites"] = [];
  const ops = createMemoryOpsRecorder();
  const control = controlledStore();
  const memoryFinancial = createMemoryFinancialGameStore();
  /* LIVE-6 L6-7 (converged): the open-money-game index the escrow load reads -- as L5-7's harness derives it: every
     record not closed or cancelled (an unreadable one too). */
  const financial = Object.assign(memoryFinancial, {
    identityKeys: async () => [] as string[],
    openGames: async () => [] as string[],
    openMoneyGameIds: async () => {
      const open: string[] = [];
      for (const gameId of await memoryFinancial.list()) {
        const record = await memoryFinancial.load(gameId).catch(() => "unreadable" as const);
        if (record === "unreadable" || (record !== null && record.phase !== "closed" && record.phase !== "cancelled")) open.push(gameId);
      }
      return open.sort();
    },
  });
  const world = makeWorld();
  const kms = kmsStandIn();
  const hooks: Harness["hooks"] = {};
  const clock = { offset: 0 };
  const now = () => Date.now() + clock.offset;
  let writer: FakeWriter | null = null;
  const relayerAnswers = [...(options.relayer ?? [])];
  const sweeps: SweepStep[] = [...(options.sweeps ?? [])];
  const identityStore = Object.assign(createMemoryIdentityStore(), { grants: createMemoryGrantStore(), health: () => ({ loaded: true, fenced: null }) });

  const ownership: PoolGameOwnership = {
    mode: "pool",
    async claim() {
      return { kind: "claimed" };
    },
    release() {},
    onFenced() {},
    async sweepMoneyClaims(): Promise<SweepReport> {
      const next = sweeps.shift();
      if (next === "throws") throw Object.assign(new Error(`FINKEYS could not be read for ${GAME_A} (injected)`), { name: "ProvisionedThroughputExceededException" });
      return next ?? { claimed: [], owned: 0, elsewhere: 0, skipped: 0, failed: [] };
    },
    async settled() {},
  };

  const statusWriter: TaskStatusWriter | null =
    options.taskStatus === "none"
      ? null
      : {
          async write(status, seq, at) {
            if (options.taskStatus === "throws") throw new Error("AccessDeniedException: dynamodb:PutItem (injected)");
            if (options.taskStatus === "hangs") return new Promise(() => undefined);
            taskWrites.push({ status, seq, at });
            return "written";
          },
        };

  const substrate: AwsSubstrate<FakeWriter, Ledger> = {
    async adoptedGeneration() {
      return options.adopted ?? 1;
    },
    /* LIVE-6 L6-4 (converged): the game table's SYSTEM/GENERATION, the bootstrap marker of the document's generation. */
    async tableGeneration() {
      const boot = bootstrapGenerationMarker({ generation: options.marker === "other-generation" ? 2 : 1, gameTable: "gs-test-game-g1", by: "l5-8-bootstrap", now: 1 });
      if (options.marker !== "restore" && options.marker !== "restore-unadopted") return boot;
      return { ...boot, origin: "restore" as const, restored_from_generation: 0, restored_from_table: "gs-test-game-g0", restore_point: 1, restore_id: "l65b-restore-1" };
    },
    async adoptionBinding() {
      return options.marker === "restore" ? { game_table: "gs-test-game-g1", restore_id: "l65b-restore-1" } : null;
    },
    async takePool({ task, onLost }) {
      if (options.poolFails === true) throw Object.assign(new Error("pool p1 was taken by t-other at epoch 8 while this task was taking it (injected)"), { name: "PoolTakeoverLostError" });
      writer = new FakeWriter(task, onLost);
      return writer;
    },
    generationProbe: () => ({ check: async () => ({ held: true }) }),
    async takeIdentityWriterRole(): Promise<RoleTakeover> {
      if (options.identityRestoreIncomplete === "takeover") throw Object.assign(new Error("identity table gs-test-identity: its restore l65b-restore-1 is replaying, not complete (injected at the takeover)"), { name: "IdentityRestoreIncompleteError" });
      return options.primary === false ? { kind: "not-primary", primary: "p0" } : { kind: "taken", epoch: 3 };
    },
    openIdentityStore(_epoch, identityHooks): IdentityStoreHandle {
      hooks.identity = identityHooks;
      if (options.identityRestoreIncomplete === "load") {
        return Object.assign(Object.create(identityStore) as IdentityStoreHandle, {
          load: async () => {
            throw Object.assign(new Error("identity table gs-test-identity: its restore l65b-restore-1 is replaying, not complete (injected)"), { name: "IdentityRestoreIncompleteError" });
          },
        });
      }
      return identityStore;
    },
    securityJournal(journalHooks) {
      hooks.journal = journalHooks;
      return createMemorySecurityJournal();
    },
    async openLedger({ relayer, onFenced }) {
      hooks.ledger = onFenced;
      return Object.assign(createMemorySigningJournal(), { relayer });
    },
    async takeRelayerRole(w): Promise<RelayerTakeover> {
      const answer = relayerAnswers.shift() ?? "taken";
      if (answer === "throws") throw Object.assign(new Error(`the mirror's outcome is unknown for ${RELAYER_ADDRESS} (injected)`), { name: "RelayerRoleUnknownError" });
      if (answer === "not-primary") return { kind: "not-primary", primary: "p0" };
      const role: RelayerRoleLike = {
        account: RELAYER_ADDRESS,
        epoch: 5,
        current: () => w.lost === null,
        beforeSideEffect: async () => w.beforeSideEffect(),
        intentFence: () => ({ ConditionCheck: { TableName: "t", Key: {}, ConditionExpression: "x" } }) as TransactWriteItem,
        onIntentFenced: () => undefined,
      };
      return { kind: "taken", role };
    },
    gameStores(w, { relayQueue, relayerRole }): AwsGameStores {
      const intents = createMemoryChainIntentStore();
      void (relayerRole as RelayerIntentView | null);
      return {
        fence: w.fence,
        log: control.store,
        readLog: async (gameId) => control.logs.get(gameId) ?? [],
        readDeal: async () => ({ kind: "undealt" }),
        readLogFormat: async () => "current",
        records: createMemoryRecordStore(),
        holds: createMemoryHoldStore(),
        financial: financial as typeof financial & OpenMoneyGames,
        tickets: createMemoryWalletTicketStore(),
        intents: relayQueue === null ? null : intents,
        relayerIntents: relayQueue === null || relayerRole === null ? null : intents,
      };
    },
    ownership(_w, { onClaimed }) {
      return {
        ...ownership,
        async claim(gameId) {
          const answer = await ownership.claim(gameId);
          if (onClaimed !== undefined) await onClaimed(gameId);
          return answer;
        },
      };
    },
    kms: () => kms.port,
    /* LIVE-6 L6-1 (converged): the routing watch reads the routing (this pool keeps its role); a non-primary task's
       verifier and directory answer nothing (these tests never route a game). */
    async readRouting() {
      return { primary_pool: options.primary === false ? "p0" : "p1" };
    },
    identityVerifier() {
      return createSessionVerifier({ session: async () => null, principal: async () => null, family: async () => null, profile: async () => null });
    },
    gameDirectory() {
      return {
        async ownerOf() {
          return { kind: "absent" as const };
        },
        async primaryPool() {
          return options.primary === false ? "p0" : "p1";
        },
        records: { load: async () => null },
      };
    },
    ...(statusWriter === null ? {} : { taskStatus: () => statusWriter }),
  };

  const openBackend = async (deps: JunoBackendDeps): Promise<JunoBackend> => {
    hooks.backendDeps = deps;
    const backend = await openJunoBackend({ ...deps, rest: world.chain, verifyEveryMs: 60_000 });
    return options.wrapBackend === undefined ? backend : options.wrapBackend(backend);
  };

  const sink: MetricSink | undefined =
    options.sink === "none"
      ? undefined
      : createEmfSink({
          context: { environment: "test", pool: "p1" },
          now,
          write: (line) => {
            if (options.sink === "throws") throw new Error("EPIPE: stdout is gone (injected)");
            const event = (JSON.parse(line) as { event: string }).event;
            const at = failNext.indexOf(event);
            if (at >= 0) {
              failNext.splice(at, 1);
              throw new Error("EPIPE (injected)");
            }
            metricLines.push(line);
          },
        });

  const records = () => metricLines.map((line) => JSON.parse(line) as Record<string, any>);
  const input = (over: Partial<AwsRuntimeInput<FakeWriter, Ledger>> = {}): AwsRuntimeInput<FakeWriter, Ledger> => ({
    config: options.escrow === true ? parseAwsRuntimeConfig(runtimeDoc({ escrow: { config_parameter_arn: ESCROW_PARAM } })) : parseAwsRuntimeConfig(runtimeDoc()),
    escrowConfig: options.escrow === true ? escrowConfig() : null,
    server: { mode: "production", allowedOrigins: ["https://play.example"], trustedProxyHops: 1 },
    build: "l6-5a-test",
    port: 0,
    bindHost: "127.0.0.1",
    moneySwitch: undefined,
    task: "t-l65atest",
    substrate,
    ops,
    ...(sink === undefined ? {} : { metrics: sink }),
    now,
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
    exit: (code) => exits.push(code),
    timing: { sweepEveryMs: 3_600_000, sweepRetryMs: 5, relayerRetryMs: 3_600_000, failFastDelayMs: 5, drainEscrowMs: 500, drainOwnershipMs: 500, drainChainFactsMs: 500, drainIdentityMs: 2_000, statusEveryMs: 3_600_000 },
    openJunoBackend: openBackend,
    ...over,
  });

  return {
    exits,
    lines,
    metricLines,
    failNext,
    ops,
    world,
    kms,
    sweeps,
    taskWrites,
    hooks,
    clock,
    writer: () => {
      if (writer === null) throw new Error("no pool writer was taken");
      return writer;
    },
    records,
    byEvent: (event) => records().filter((record) => record.event === event),
    sum: (metric) => records().reduce((total, record) => total + (typeof record[metric] === "number" ? record[metric] : 0), 0),
    input,
    start: (over) => startAwsRuntime(input(over)),
  };
}

async function until(predicate: () => boolean, label: string, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function get(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET", timeout: 2_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function listening(runtime: AwsRuntime): Promise<number> {
  if (!runtime.http.listening) await new Promise((resolve) => runtime.http.once("listening", resolve));
  const address = runtime.http.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function closed(runtime: AwsRuntime): Promise<void> {
  if (runtime.server !== null) await runtime.server.close().catch(() => undefined);
  else await new Promise<void>((resolve) => runtime.http.close(() => resolve()));
}

/** Every EMF rule this schema relies on, checked on one parsed record. */
function assertValidEmf(record: Record<string, any>): void {
  const aws = record._aws;
  assert.ok(aws !== undefined && typeof aws === "object", "the _aws member");
  assert.ok(Number.isSafeInteger(aws.Timestamp) && aws.Timestamp > 1_600_000_000_000, "Timestamp in epoch milliseconds");
  assert.ok(Array.isArray(aws.CloudWatchMetrics) && aws.CloudWatchMetrics.length >= 1);
  for (const directive of aws.CloudWatchMetrics) {
    assert.equal(directive.Namespace, METRIC_NAMESPACE);
    assert.ok(directive.Metrics.length >= 1 && directive.Metrics.length <= 100);
    for (const set of directive.Dimensions) {
      assert.ok(set.length >= 1 && set.length <= 30);
      for (const name of set) {
        assert.ok(name === "Environment" || name === "Pool", `dimension ${name}`);
        assert.equal(typeof record[name], "string", `the dimension ${name} has a string value`);
      }
    }
    for (const metric of directive.Metrics) {
      const spec = (METRICS as Record<string, { unit: string; kind: string; scope: string }>)[metric.Name];
      assert.ok(spec !== undefined, `${metric.Name} is in the catalog`);
      assert.equal(metric.Unit, spec.unit);
      assert.equal(typeof record[metric.Name], "number", `${metric.Name} has a numeric value`);
      assert.ok(Number.isFinite(record[metric.Name]) && record[metric.Name] >= 0);
      assert.deepEqual(directive.Dimensions, spec.scope === "environment" ? [["Environment", "Pool"], ["Environment"]] : [["Environment", "Pool"]]);
    }
  }
  assert.equal(record.schema, METRIC_SCHEMA);
  const allowed = new Set<string>(["_aws", "Environment", "Pool", "event", "schema", ...Object.keys(METRICS), ...METRIC_PROPERTIES]);
  for (const name of Object.keys(record)) assert.ok(allowed.has(name), `member ${name} is allowed`);
}

/** Shapes that must never appear in a metric line (or a TASK# item). */
const FORBIDDEN = [/arn:/i, /210987654321/, /123456789012/, /juno1[0-9a-z]{20,}/, /g_[0-9a-z]{20,}/, /(?:pr|pf|se|sf|rk)_[0-9a-z]{8,}/, /[0-9a-f]{8}-[0-9a-f]{4}-/, /injected/, /gs-test-/, /Exception:/, /hang up/];
const assertClean = (text: string, where: string) => {
  for (const shape of FORBIDDEN) assert.ok(!shape.test(text), `${where}: ${shape} must not appear in ${text.slice(0, 400)}`);
};

/* ==================================================================
    THE SCHEMA
   ================================================================== */
describe("L6-5A schema: CloudWatch EMF, deterministic, low-cardinality", () => {
  test("the catalog: every counter is a Count; every metric has a kind, a unit and a scope; the forced-exit and failure counters are also environment-wide", () => {
    for (const [name, spec] of Object.entries(METRICS)) {
      assert.ok(/^[A-Z][A-Za-z]+$/.test(name), name);
      assert.ok(spec.kind === "counter" || spec.kind === "gauge", name);
      if (spec.kind === "counter") assert.equal(spec.unit, "Count", name);
      if (spec.kind === "gauge") assert.equal(spec.scope, "pool", `${name}: a gauge is never summed across pools`);
    }
    for (const name of ["TaskLost", "StoreUncertain", "MoneySweepPassFailed", "RelayerTakeoverNotTaken", "KmsSigns", "KmsSignWithheld", "KmsTransient", "KmsRefused", "KmsInvalidAnswer", "KmsOtherFailure"] as const) {
      assert.equal(METRICS[name].scope, "environment", name);
      assert.equal(METRICS[name].kind, "counter", name);
    }
    assert.ok(Object.keys(METRICS).length <= 100, "one directive can carry them all");
    assert.ok(!/^AWS\//.test(METRIC_NAMESPACE));
  });

  test("a record is valid EMF; the same inputs give the same bytes; members in a fixed order", () => {
    const record = { event: "money-sweep" as const, metrics: { MoneySweepSkipped: 1, MoneySweepPasses: 1, MoneySweepPassFailed: 0 }, properties: { why: "periodic", task: "t-1", build: "b1" } };
    const a = buildEmfRecord({ environment: "prod", pool: "p1" }, 1_760_000_000_123, record)!;
    const b = buildEmfRecord({ environment: "prod", pool: "p1" }, 1_760_000_000_123, { ...record, properties: { build: "b1", task: "t-1", why: "periodic" } })!;
    assert.equal(JSON.stringify(a), JSON.stringify(b), "property order never changes the bytes");
    assertValidEmf(JSON.parse(JSON.stringify(a)));
    assert.deepEqual(Object.keys(a), ["_aws", "Environment", "Pool", "event", "schema", "MoneySweepPasses", "MoneySweepPassFailed", "MoneySweepSkipped", "build", "task", "why"]);
    const directives = (a._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][]; Metrics: Array<{ Name: string }> }> }).CloudWatchMetrics;
    assert.deepEqual(
      directives.map((directive) => directive.Metrics.map((metric) => metric.Name)),
      [["MoneySweepPassFailed"], ["MoneySweepPasses", "MoneySweepSkipped"]],
      "environment-scoped metrics in their own directive, first",
    );
  });

  test("unknown metrics, bad values and unknown properties are dropped (never invented); nothing measurable -> no line", () => {
    const built = buildEmfRecord({ environment: "prod", pool: "p1" }, 1_760_000_000_000, {
      event: "task-status",
      metrics: { Ready: 1, Unready: Number.NaN, UnreadySeconds: -3, PoolWriterConfirmed: Infinity, ...({ GameCount: 4 } as object) },
      properties: { task: "t-1", ...({ game_id: GAME_A, principal: PRINCIPAL, reason: "a free text" } as object) },
    })!;
    assert.equal(built.Ready, 1);
    for (const gone of ["Unready", "UnreadySeconds", "PoolWriterConfirmed", "GameCount", "game_id", "principal", "reason"]) assert.ok(!(gone in built), gone);
    assert.equal(buildEmfRecord({ environment: "prod", pool: "p1" }, 1, { event: "task-status", metrics: {} }), null);
    const sink = createEmfSink({ context: { environment: "prod", pool: "p1" }, now: () => 1_760_000_000_000, write: () => assert.fail("nothing to write") });
    assert.equal(sink.emit({ event: "task-status", metrics: { Ready: -1 } }), false);
  });

  test("a value that looks like a game, a principal, an ARN, a wallet, a KMS key id or a digest never leaves the task, whatever a caller passes", () => {
    const leaky = [GAME_A, PRINCIPAL, "se_0123456789abcdefghjkmnpq", KEY(1), LEDGER_ARN, RELAYER_ADDRESS, "11111111-1111-4111-8111-111111111111", "a".repeat(64), "line one\nline two"];
    for (const value of leaky) {
      const text = safeText(`x ${value} y`);
      assertClean(text.replace(/injected/g, ""), `safeText(${value})`);
      assert.ok(!/\s/.test(text), "no whitespace");
      assert.ok(text.length <= 128);
    }
    assert.equal(codeList(["pool-writer-unconfirmed", "starting", "starting", "Not A Code", GAME_A]), "other,pool-writer-unconfirmed,starting");
    assert.equal(codeList([]), "none");
  });

  test("the sink never throws: a line that cannot be written is counted and the caller goes on", () => {
    const sink = createEmfSink({
      context: { environment: "prod", pool: "p1" },
      now: () => 1_760_000_000_000,
      write: () => {
        throw new Error("EPIPE");
      },
    });
    assert.equal(sink.emit({ event: "task-lost", metrics: { TaskLost: 1 } }), false);
    assert.equal(sink.failures(), 1);
    assert.equal(NO_METRICS.emit({ event: "task-lost", metrics: { TaskLost: 1 } }), false);
  });
});

/* ==================================================================
    FORCED EXITS: COUNTED ONCE
   ================================================================== */
describe("L6-5A forced exits: one event, one metric", () => {
  test("one task loss -> ONE TaskLost, however many fences then report it; written before the exit; the reason stays in the audit line only", async () => {
    const h = harness({ escrow: true });
    let linesAtExit = -1;
    const runtime = await h.start({
      exit: (code) => {
        h.exits.push(code);
        if (linesAtExit < 0) linesAtExit = h.metricLines.length;
      },
    });
    try {
      await until(() => runtime.steps.includes("escrow-started"), "the backend's start");
      h.writer().markLost("pool p1 is at epoch 8 (t-newer), not this task's 7");
      h.hooks.identity!.onFenced("the role is at epoch 4"); // every later report of the same loss
      h.hooks.journal!.onFenced("APPGEN is 2");
      h.hooks.ledger!("relayer", "a newer relayer holds epoch 6");
      h.hooks.identity!.onRestartRequired("a change applied in part"); // and a store asking for a restart after it
      assert.deepEqual(h.exits, [3]);
      const lost = h.byEvent("task-lost");
      assert.equal(lost.length, 1);
      assert.equal(lost[0].TaskLost, 1);
      assert.equal(h.sum("TaskLost"), 1);
      assert.equal(h.sum("StoreUncertain"), 0, "the loss was the termination; nothing else is counted for it");
      assert.ok(linesAtExit > 0 && h.records().slice(0, linesAtExit).some((record) => record.event === "task-lost"), "the line is written before the exit is asked for");
      assert.equal(lost[0].role, "primary");
      assert.equal(lost[0].epoch, 7);
      assert.ok(!("reason" in lost[0]));
      assert.ok(h.ops.lines.some((line) => line.event === "aws.task-lost"), "the AUDIT line is unchanged");
      runtime.statusTick();
      assert.equal(h.sum("TaskLost"), 1, "a later status tick counts nothing again");
    } finally {
      await closed(runtime);
    }
  });

  test("a primary's loss and a non-primary's loss are each counted once", async () => {
    for (const primary of [true, false]) {
      const h = harness({ primary });
      const runtime = await h.start();
      try {
        h.writer().markLost("a newer task took pool p1 (injected)");
        h.writer().markLost("again");
        assert.deepEqual(h.exits, [3]);
        assert.equal(h.sum("TaskLost"), 1, `primary=${primary}`);
        assert.equal(h.byEvent("task-lost")[0].role, primary ? "primary" : "non-primary");
      } finally {
        await closed(runtime);
      }
    }
  });

  test("one forced store restart -> ONE StoreUncertain (identity: `store` is a code, never the game or the text), whatever repeats after it", async () => {
    const h = harness();
    const runtime = await h.start();
    try {
      h.hooks.identity!.onRestartRequired(`a change applied in part for ${PRINCIPAL} (injected)`);
      h.hooks.identity!.onRestartRequired("again");
      h.writer().markLost("and then a loss");
      await until(() => h.exits.length > 0, "the exit");
      assert.deepEqual(h.exits, [4]);
      assert.equal(h.sum("StoreUncertain"), 1);
      assert.equal(h.sum("TaskLost"), 0, "the first forced exit wins, as its exit code does");
      const record = h.byEvent("store-uncertain")[0];
      assert.equal(record.store, "identity");
      assertClean(h.metricLines.join("\n"), "store-uncertain");
    } finally {
      await closed(runtime);
    }
  });
});

/* ==================================================================
    THE MONEY CLAIM SWEEP
   ================================================================== */
describe("L6-5A the money claim sweep: one record per pass", () => {
  test("failed passes and a completed one: MoneySweepPassFailed per failure, MoneySweepPasses with the pass's counts -- never a game id; the health gauges follow", async () => {
    const h = harness({ sweeps: ["throws", "throws", { claimed: [GAME_A], owned: 3, elsewhere: 1, skipped: 2, failed: [{ gameId: GAME_A, detail: `claim of ${GAME_A} unknown (injected)` }] }] });
    const runtime = await h.start();
    try {
      assert.equal(h.sum("MoneySweepPassFailed"), 2);
      assert.equal(h.sum("MoneySweepPasses"), 1);
      const pass = h.byEvent("money-sweep")[0];
      assert.deepEqual([pass.MoneySweepClaimed, pass.MoneySweepOwned, pass.MoneySweepElsewhere, pass.MoneySweepSkipped, pass.MoneySweepGamesFailed], [1, 3, 1, 2, 1]);
      assert.equal(pass.why, "startup");
      const failed = h.byEvent("money-sweep-failed")[0];
      assert.equal(failed.error_class, "ProvisionedThroughputExceededException");
      assertClean(h.metricLines.join("\n"), "sweep lines");
      runtime.statusTick();
      let status = h.byEvent("task-status").at(-1)!;
      assert.equal(status.MoneySweepConsecutiveFailures, 0, "reset by the completed pass");
      assert.ok(status.MoneySweepSecondsSinceSuccess <= 1);
      h.sweeps.push("throws", "throws", "throws");
      for (let i = 0; i < 3; i += 1) assert.equal(await runtime.sweepNow(), null);
      h.clock.offset += 400_000;
      runtime.statusTick();
      status = h.byEvent("task-status").at(-1)!;
      assert.equal(status.MoneySweepConsecutiveFailures, 3);
      assert.ok(status.MoneySweepSecondsSinceSuccess >= 400, "fresh failure is visible as age, not as routine zeroes");
      assert.equal(h.sum("MoneySweepPassFailed"), 5);
      assert.ok(await runtime.sweepNow());
      runtime.statusTick();
      assert.equal(h.byEvent("task-status").at(-1)!.MoneySweepConsecutiveFailures, 0);
    } finally {
      await runtime.shutdown();
    }
  });
});

/* ==================================================================
    READINESS: TRANSITIONS, NOT PROBES
   ================================================================== */
describe("L6-5A readiness: a transition is written once", () => {
  test("starting -> ready once; repeated probes and ticks of the same answer write nothing; unconfirmed and back: one each, BecameUnready on the way down", async () => {
    const h = harness();
    const runtime = await h.start();
    try {
      const port = await listening(runtime);
      const up = h.byEvent("readiness-transition");
      assert.equal(up.length, 1, "the startup's end");
      assert.deepEqual([up[0].from, up[0].to, up[0].to_reasons], ["not-ready", "ready", "none"]);
      assert.ok(String(up[0].from_reasons).includes("starting"));
      for (let i = 0; i < 25; i += 1) assert.equal((await get(port, "/gs/readyz")).status, 200);
      for (let i = 0; i < 5; i += 1) runtime.statusTick();
      runtime.readiness();
      assert.equal(h.byEvent("readiness-transition").length, 1, "no line per probe or tick");
      h.writer().ready = false;
      for (let i = 0; i < 10; i += 1) assert.equal((await get(port, "/gs/readyz")).status, 503);
      h.writer().ready = true;
      for (let i = 0; i < 10; i += 1) assert.equal((await get(port, "/gs/readyz")).status, 200);
      const all = h.byEvent("readiness-transition");
      assert.equal(all.length, 3);
      assert.deepEqual([all[1].to, all[1].to_reasons, all[1].BecameUnready], ["not-ready", "pool-writer-unconfirmed", 1]);
      assert.deepEqual([all[2].to, all[2].BecameUnready], ["ready", undefined]);
      assert.equal(h.sum("ReadinessTransitions"), 3);
      assert.equal(h.sum("BecameUnready"), 1);
    } finally {
      await runtime.shutdown();
    }
    const last = h.byEvent("readiness-transition").at(-1)!;
    assert.deepEqual([last.to, last.to_reasons], ["not-ready", "shutting-down"], "the shutdown is one transition");
  });

  test("gauges at a tick: Ready / Unready / UnreadySeconds (continuous), PoolWriterConfirmed and its check age", async () => {
    const h = harness();
    const runtime = await h.start();
    try {
      runtime.statusTick();
      let status = h.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.Ready, status.Unready, status.UnreadySeconds, status.Standby, status.PoolWriterConfirmed, status.PoolWriterCheckAgeSeconds], [1, 0, 0, 0, 1, 1]);
      h.writer().ready = false;
      runtime.statusTick();
      h.clock.offset += 90_000;
      runtime.statusTick();
      status = h.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.Ready, status.Unready, status.PoolWriterConfirmed, status.PoolWriterCheckAgeSeconds], [0, 1, 0, 30]);
      assert.ok(status.UnreadySeconds >= 90 && status.UnreadySeconds < 95, `unready for ${status.UnreadySeconds} s`);
      assert.equal(status.reasons, "pool-writer-unconfirmed");
      h.writer().ready = true;
      runtime.statusTick();
      status = h.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.Ready, status.Unready, status.UnreadySeconds], [1, 0, 0]);
    } finally {
      await runtime.shutdown();
    }
  });

  test("a NON-PRIMARY router (L6-1; L5-7's standby) is healthy: Ready 1, Unready 0, Standby 1 -- until something is wrong with it", async () => {
    const h = harness({ primary: false });
    const runtime = await h.start();
    try {
      runtime.statusTick();
      let status = h.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.Ready, status.Unready, status.Standby, status.role], [1, 0, 1, "non-primary"]);
      h.writer().ready = false;
      runtime.statusTick();
      status = h.byEvent("task-status").at(-1)!;
      assert.equal(status.Unready, 1, "a non-primary task that cannot confirm its pool is not fine");
      assert.equal(h.byEvent("readiness-transition").at(-1)!.to_reasons, "pool-writer-unconfirmed");
      assert.ok(!("RelayerHeld" in status) && !("KmsSigns" in status), "a non-primary task reports no relayer and no KMS");
    } finally {
      await runtime.shutdown();
    }
  });

  test("a flapping answer is capped per minute; the lines suppressed are carried, so the Sum stays exact", () => {
    const written: Array<{ represents: number }> = [];
    let now = 1_760_000_000_000;
    const tracker = transitionTracker<boolean>({ key: (state) => String(state), now: () => now, linesPerMinute: 5, onTransition: (_from, _to, represents) => (written.push({ represents }), true) });
    tracker.observe(true);
    for (let i = 0; i < 50; i += 1) tracker.observe(i % 2 === 0 ? false : true);
    assert.equal(written.length, 5, "the cap");
    assert.equal(tracker.suppressed(), 45);
    tracker.settle(40); // a status line carried 40 of them
    assert.equal(tracker.suppressed(), 5);
    for (let i = 0; i < 3; i += 1) tracker.observe(true); // the last state again (i = 49 was true): no change, nothing
    now += 60_000;
    tracker.observe(false);
    tracker.observe(true);
    assert.deepEqual(written.slice(5).map((entry) => entry.represents), [6, 1], "the next written line carries the 5 still pending");
    assert.equal(tracker.suppressed(), 0);
    assert.equal(written.reduce((total, entry) => total + entry.represents, 0) + 40, 52, "every one of the 52 transitions counted exactly once");
  });

  test("a transition line that could not be written stays pending (and its BecameUnready with it): carried by the next line", () => {
    const lines: Array<Record<string, any>> = [];
    let fail = true;
    const sink: MetricSink = {
      emit: (record) => {
        if (fail) return false;
        lines.push(record as unknown as Record<string, any>);
        return true;
      },
      failures: () => 0,
    };
    const observer = readinessObserver({ sink, now: () => 0, benign: () => false, properties: () => ({}) });
    observer.observe({ ready: true, reasons: [] });
    observer.observe({ ready: false, reasons: ["pool-writer-unconfirmed"] }); // its line fails
    assert.deepEqual(observer.pending(), { ReadinessTransitions: 1, BecameUnready: 1 });
    fail = false;
    observer.observe({ ready: true, reasons: [] });
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0].metrics.ReadinessTransitions, lines[0].metrics.BecameUnready], [2, 1]);
    assert.deepEqual(observer.pending(), { ReadinessTransitions: 0, BecameUnready: 0 });
    fail = true;
    observer.observe({ ready: false, reasons: ["lost"] });
    observer.settle(observer.pending()); // a status line carried it
    assert.deepEqual(observer.pending(), { ReadinessTransitions: 0, BecameUnready: 0 });
  });

  test("the observer takes any readiness model: codes are opaque, the benign predicate is the runtime's", () => {
    const lines: Array<Record<string, unknown>> = [];
    const sink: MetricSink = { emit: (record) => (lines.push(record as unknown as Record<string, unknown>), true), failures: () => 0 };
    let now = 0;
    const observer = readinessObserver({ sink, now: () => now, benign: (answer) => answer.reasons.includes("verifier-only"), properties: () => ({}) });
    observer.observe({ ready: false, reasons: ["verifier-only"] });
    observer.observe({ ready: false, reasons: ["verifier-only"] });
    assert.equal(observer.gauges({ ready: false, reasons: ["verifier-only"] }).Unready, 0);
    observer.observe({ ready: true, reasons: [] });
    now += 5_000;
    observer.observe({ ready: false, reasons: ["some-future-code", "Weird Text"] });
    now += 7_000;
    assert.deepEqual(observer.gauges({ ready: false, reasons: ["some-future-code"] }), { Ready: 0, Unready: 1, UnreadySeconds: 7 });
    assert.equal(lines.length, 2);
    assert.equal((lines[1].properties as Record<string, unknown>).to_reasons, "other,some-future-code");
  });
});

/* ==================================================================
    KMS: THE GATE'S COUNTERS, AS DELTAS
   ================================================================== */
describe("L6-5A KMS: kmsGate.ts's counters are the only counters", () => {
  test("the mapping, unit level: a success, a withheld Sign (KMS never called), and each failure class land in their own counter", async () => {
    const stand = kmsStandIn();
    let gateOpen = true;
    const gated = gatedKmsClient(stand.port, {
      gate: async () => {
        if (!gateOpen) throw new PoolWriterNotCurrentError("could not be shown current (injected)", false);
      },
      now: () => 1_760_000_000_000,
      warn: () => undefined,
    });
    const digest = Buffer.alloc(32, 9);
    await gated.client.signDigest(SETTLEMENT_KEY, digest);
    gateOpen = false;
    await assert.rejects(gated.client.signDigest(SETTLEMENT_KEY, digest), (error: unknown) => error instanceof SignerError && error.code === "unavailable" && error.detail.signatureMayExist === false);
    assert.equal(stand.state.signCalls, 1, "withheld: KMS was never called");
    gateOpen = true;
    for (const mode of ["transient", "refused", "invalid-answer", "other"] as const) {
      stand.state.mode = mode;
      await assert.rejects(gated.client.signDigest(SETTLEMENT_KEY, digest));
    }
    assert.deepEqual({ ...gated.counters, lastFailureAt: null }, { signs: 1, withheld: 1, transient: 1, refused: 1, invalidAnswer: 1, other: 1, lastFailureAt: null });
    assert.equal(gated.counters.lastFailureAt, 1_760_000_000_000);
    assert.deepEqual(kmsDeltas(gated.counters, null), { KmsSigns: 1, KmsSignWithheld: 1, KmsTransient: 1, KmsRefused: 1, KmsInvalidAnswer: 1, KmsOtherFailure: 1 });
    assert.deepEqual(Object.keys(KMS_METRIC_OF).sort(), ["invalidAnswer", "other", "refused", "signs", "transient", "withheld"]);
    assert.deepEqual(kmsDeltas(gated.counters, gated.counters), { KmsSigns: 0, KmsSignWithheld: 0, KmsTransient: 0, KmsRefused: 0, KmsInvalidAnswer: 0, KmsOtherFailure: 0 });
  });

  test("through the runtime: each class counted once, sent as a delta at the next tick, never again; a withheld Sign is not a KMS failure; no key ARN anywhere", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    try {
      await until(() => runtime.backend?.state() === "active", "the backend active");
      runtime.statusTick();
      const kms = h.hooks.backendDeps!.kms!;
      const digest = Buffer.alloc(32, 7);
      await kms.signDigest(SETTLEMENT_KEY, digest);
      await kms.signDigest(ADMISSION_KEY, digest);
      h.writer().gate = async () => {
        throw new PoolWriterNotCurrentError("could not be shown current just now (injected)", false);
      };
      const calls = h.kms.state.signCalls;
      await assert.rejects(kms.signDigest(ADMISSION_KEY, digest), (error: unknown) => error instanceof SignerError && error.code === "unavailable");
      assert.equal(h.kms.state.signCalls, calls, "withheld: never sent to KMS");
      h.writer().gate = async () => undefined;
      for (const mode of ["transient", "transient", "refused", "invalid-answer"] as const) {
        h.kms.state.mode = mode;
        await assert.rejects(kms.signDigest(SETTLEMENT_KEY, digest));
      }
      h.kms.state.mode = "ok";
      runtime.statusTick();
      const status = h.byEvent("task-status").at(-1)!;
      assert.deepEqual(
        [status.KmsSigns, status.KmsSignWithheld, status.KmsTransient, status.KmsRefused, status.KmsInvalidAnswer, status.KmsOtherFailure],
        [2, 1, 2, 1, 1, 0],
      );
      assert.equal(typeof status.kms_last_failure_at, "number");
      runtime.statusTick();
      const next = h.byEvent("task-status").at(-1)!;
      assert.deepEqual([next.KmsSigns, next.KmsSignWithheld, next.KmsTransient, next.KmsRefused, next.KmsInvalidAnswer], [0, 0, 0, 0, 0], "sent once");
      const totals = ["KmsSigns", "KmsSignWithheld", "KmsTransient", "KmsRefused", "KmsInvalidAnswer"].map((name) => h.sum(name));
      const counters = (runtime.status() as { aws: { kms: Record<string, number> } }).aws.kms;
      assert.deepEqual(totals, [counters.signs, counters.withheld, counters.transient, counters.refused, counters.invalidAnswer], "the sum of every delta is the gate's own counter");
      assertClean(h.metricLines.join("\n"), "KMS lines");
    } finally {
      h.writer().gate = async () => undefined;
      await runtime.shutdown();
    }
  });

  test("a status line that could not be written carries its KMS delta to the next one: never lost, never twice", async () => {
    let failNext = false;
    const written: string[] = [];
    const h = harness({ escrow: true });
    const sink = createEmfSink({
      context: { environment: "test", pool: "p1" },
      now: () => Date.now(),
      write: (line) => {
        if (failNext && line.includes('"task-status"')) {
          failNext = false;
          throw new Error("EPIPE (injected)");
        }
        written.push(line);
      },
    });
    const runtime = await h.start({ metrics: sink });
    try {
      await until(() => runtime.backend?.state() === "active", "the backend active");
      const kms = h.hooks.backendDeps!.kms!;
      await kms.signDigest(SETTLEMENT_KEY, Buffer.alloc(32, 1));
      failNext = true;
      runtime.statusTick(); // lost line
      await kms.signDigest(SETTLEMENT_KEY, Buffer.alloc(32, 2));
      runtime.statusTick();
      runtime.statusTick();
      const signs = written.map((line) => JSON.parse(line)).filter((record) => record.event === "task-status").reduce((total, record) => total + (record.KmsSigns ?? 0), 0);
      assert.equal(signs, (runtime.status() as { aws: { kms: { signs: number } } }).aws.kms.signs, "every Sign counted exactly once across the lines that were written");
      assert.equal(sink.failures(), 1);
    } finally {
      await runtime.shutdown();
    }
  });
});

/* ==================================================================
    THE RELAYER
   ================================================================== */
describe("L6-5A relayer: takeover outcomes and state transitions", () => {
  test("taken at startup: one RelayerTakeoverTaken; not-taken -> held -> usable; the gauges; open intents only once the relayer has loaded", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    try {
      await until(() => runtime.backend?.state() === "active", "the backend active");
      assert.equal(h.sum("RelayerTakeoverTaken"), 1);
      assert.deepEqual(
        h.byEvent("relayer-transition").map((record) => `${record.from}>${record.to}`),
        ["not-taken>held", "held>usable"],
      );
      runtime.statusTick();
      const status = h.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.RelayerHeld, status.RelayerUsable, status.EscrowActive, status.RelayerOpenIntents, status.relayer_state], [1, 1, 1, 0, "usable"]);
    } finally {
      await runtime.shutdown();
    }
  });

  test("not taken at startup, then a retry: RelayerTakeoverNotTaken (its class, never its text), then taken -> taken-loading -> usable", async () => {
    const h = harness({ escrow: true, relayer: ["throws"] });
    const runtime = await h.start();
    try {
      const notTaken = h.byEvent("relayer-takeover");
      assert.equal(notTaken.length, 1);
      assert.deepEqual([notTaken[0].RelayerTakeoverNotTaken, notTaken[0].outcome, notTaken[0].error_class, notTaken[0].when], [1, "not-taken", "RelayerRoleUnknownError", "startup"]);
      await until(() => runtime.backend?.state() === "active", "the backend active");
      runtime.statusTick();
      let status = h.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.RelayerHeld, status.RelayerUsable, status.EscrowActive, status.relayer_state], [0, 0, 1, "not-taken"], "unavailable: the primitive L6-5B alarms on");
      assert.ok(!("RelayerOpenIntents" in status), "no open-intent count from a task that does not hold the role (nothing prunes its view)");
      assert.equal(await runtime.retryRelayerRole(), true);
      assert.equal(h.sum("RelayerTakeoverTaken"), 1);
      assert.deepEqual(
        h.byEvent("relayer-transition").map((record) => `${record.from}>${record.to}`),
        ["not-taken>taken-loading", "taken-loading>usable"],
      );
      runtime.statusTick();
      status = h.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.RelayerHeld, status.RelayerUsable], [1, 1]);
      assertClean(h.metricLines.join("\n"), "relayer lines");
    } finally {
      await runtime.shutdown();
    }
  });

  test("not primary at the relayer takeover: RelayerTakeoverNotPrimary, state not-primary", async () => {
    const h = harness({ escrow: true, relayer: ["not-primary"] });
    const runtime = await h.start();
    try {
      assert.equal(h.sum("RelayerTakeoverNotPrimary"), 1);
      runtime.statusTick();
      assert.equal(h.byEvent("task-status").at(-1)!.relayer_state, "not-primary");
    } finally {
      await runtime.shutdown();
    }
  });
});

/* ==================================================================
    OBSERVABILITY IS NEVER A CORRECTNESS DEPENDENCY
   ================================================================== */
describe("L6-5A harmless: a failing sink or TASK# writer changes nothing", () => {
  const decisions = async (options: HarnessOptions) => {
    const h = harness({ escrow: true, ...options });
    const runtime = await h.start();
    await until(() => runtime.backend?.state() === "active", "the backend active");
    runtime.statusTick();
    const kms = h.hooks.backendDeps!.kms!;
    const signed = (await kms.signDigest(SETTLEMENT_KEY, Buffer.alloc(32, 3))).length > 0;
    h.writer().gate = async () => {
      throw new PoolWriterNotCurrentError("not current (injected)", false);
    };
    const withheld = await kms.signDigest(SETTLEMENT_KEY, Buffer.alloc(32, 3)).then(
      () => "signed",
      (error: unknown) => (error instanceof SignerError ? error.code : "other"),
    );
    h.writer().gate = async () => undefined;
    const readyAnswer = runtime.readiness();
    const authority = h.hooks.backendDeps!.relayerAuthority!.current();
    await runtime.shutdown();
    return { steps: [...runtime.steps], shutdownSteps: [...runtime.shutdownSteps], ready: readyAnswer.ready, reasons: [...readyAnswer.reasons], authority, signed, withheld, exits: [...h.exits] };
  };

  test("a sink whose every line throws, a TASK# writer that throws, one that never answers: the same startup, readiness, authority, KMS answers and shutdown", async () => {
    const reference = await decisions({ sink: "none", taskStatus: "none" });
    assert.deepEqual(reference.shutdownSteps, ["readiness-503", "timers-stopped", "periodic-drained", "money-stopped", "relayer-stopped", "server-closed", "escrow-drained", "ownership-settled", "chain-facts-settled", "identity-settled", "pool-writer-stopped", "ops-flushed"]);
    for (const options of [{ sink: "throws" as const }, { taskStatus: "throws" as const }, { taskStatus: "hangs" as const }, { sink: "throws" as const, taskStatus: "hangs" as const }]) {
      assert.deepEqual(await decisions(options), reference, JSON.stringify(options));
    }
  });

  test("with a sink that throws, a loss is still exit 3 at once and a store restart still exit 4", async () => {
    const lost = harness({ sink: "throws", taskStatus: "throws" });
    const a = await lost.start();
    try {
      lost.writer().markLost("a newer task (injected)");
      assert.deepEqual(lost.exits, [3]);
    } finally {
      await closed(a);
    }
    const uncertain = harness({ sink: "throws", taskStatus: "hangs" });
    const b = await uncertain.start();
    try {
      uncertain.hooks.identity!.onRestartRequired("applied in part");
      await until(() => uncertain.exits.length > 0, "the exit");
      assert.deepEqual(uncertain.exits, [4]);
    } finally {
      await closed(b);
    }
  });

  test("even a sink that breaks its contract (emit THROWS): the startup, readiness, KMS and the loss's exit 3 are unchanged", async () => {
    const h = harness({ escrow: true, sink: "none" });
    const broken: MetricSink = {
      emit: () => {
        throw new Error("a broken sink (injected)");
      },
      failures: () => 0,
    };
    const runtime = await h.start({ metrics: broken });
    try {
      await until(() => runtime.backend?.state() === "active", "the backend active");
      assert.equal(runtime.readiness().ready, true);
      runtime.statusTick();
      assert.ok((await h.hooks.backendDeps!.kms!.signDigest(SETTLEMENT_KEY, Buffer.alloc(32, 4))).length > 60);
      assert.equal(await runtime.retryRelayerRole(), true);
      assert.ok(await runtime.sweepNow());
      h.writer().markLost("a newer task (injected)");
      assert.deepEqual(h.exits, [3]);
    } finally {
      await closed(runtime);
    }
  });

  test("the audit lines are unchanged by L6-5A: the same events, the same fields", async () => {
    const withMetrics = harness({ escrow: true, sweeps: ["throws"] });
    const withoutMetrics = harness({ escrow: true, sweeps: ["throws"], sink: "none", taskStatus: "none" });
    for (const h of [withMetrics, withoutMetrics]) {
      const runtime = await h.start();
      await until(() => runtime.backend?.state() === "active", "the backend active");
      runtime.statusTick();
      h.writer().markLost("a newer task (injected)");
      await closed(runtime);
    }
    const shape = (h: Harness) => h.ops.lines.filter((line) => String(line.event).startsWith("aws.")).map((line) => `${String(line.event)}:${Object.keys(line).sort().join(",")}`);
    assert.deepEqual(shape(withMetrics), shape(withoutMetrics));
    assert.ok(shape(withMetrics).length >= 5);
  });
});

/* ==================================================================
    THE TASK# ITEM
   ================================================================== */
describe("L6-5A the TASK# item: diagnostic, ordered, never read", () => {
  const status = (over: Partial<TaskStatus> = {}): TaskStatus => ({
    task: "t-0123456789abcdef",
    pool: "p1",
    poolEpoch: 7,
    generation: 1,
    environment: "prod",
    build: "img-2026.09.30",
    role: "primary",
    phase: "serving",
    ready: true,
    reasons: [],
    relayer: "usable",
    escrow: "active",
    poolWriterCheckAgeMs: 1_500,
    startedAt: 1_760_000_000_000,
    ...over,
  });

  test("the item: its key, format, fields and TTL (last seen + 1 day), well under 4 KB", () => {
    const item = taskStatusItem(status(), 12, 1_760_000_123_456);
    assert.deepEqual(item.pk, { S: "TASK#t-0123456789abcdef" });
    assert.deepEqual(item.sk, { S: "TASK" });
    assert.deepEqual(item.fmt, { N: "1" });
    assert.deepEqual(item.seq, { N: "12" });
    assert.deepEqual(item.updated_at, { N: "1760000123456" });
    assert.deepEqual(item.ttl, { N: String(1_760_000_123 + TASK_STATUS_TTL_SECONDS) });
    assert.deepEqual(item.ready, { BOOL: true });
    assert.deepEqual(item.reasons, { S: "none" });
    assert.deepEqual(Object.keys(item).sort(), ["build", "environment", "escrow", "fmt", "generation", "phase", "pk", "pool", "pool_epoch", "pool_writer_check_age_ms", "ready", "reasons", "relayer", "role", "seq", "sk", "started_at", "task", "ttl", "updated_at"]);
    assert.ok(JSON.stringify(item).length < 4_096);
    assert.throws(() => taskStatusItem(status({ task: "has space" }), 1, 1), /task id/);
    const leaky = taskStatusItem(status({ reasons: [GAME_A, "starting"], relayer: `Error: ${RELAYER_ADDRESS}`, phase: `serving ${PRINCIPAL}` as never, escrow: LEDGER_ARN }), 1, 1);
    assertClean(JSON.stringify(leaky), "a TASK# item's free fields (codes only)");
    assert.deepEqual([leaky.reasons, leaky.relayer, leaky.phase, leaky.escrow], [{ S: "other,starting" }, { S: "other" }, { S: "other" }, { S: "other" }]);
    assert.deepEqual(taskStatusItem(status({ build: "img 1\n" }), 1, 1).build, { S: "img_1_" }, "an id keeps itself, printable only");
  });

  test("the DynamoDB writer: one conditional PutItem (only this task, only a newer seq); a refused condition is `stale`, anything else `failed` -- never thrown", async () => {
    const sent: Array<{ input: Record<string, any> }> = [];
    let answer: "ok" | "condition" | "error" = "ok";
    const client = {
      send: async (command: { input: Record<string, any> }) => {
        sent.push(command);
        if (answer === "condition") throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
        if (answer === "error") throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
        return {};
      },
    };
    const writer = dynamoTaskStatusWriter({ client: client as never, table: "gs-test-game-g1" });
    assert.equal(await writer.write(status(), 3, 1_760_000_000_000), "written");
    const input = sent[0].input;
    assert.equal(input.TableName, "gs-test-game-g1");
    assert.equal(input.ConditionExpression, "attribute_not_exists(pk) OR (#task = :task AND #seq < :seq)");
    assert.deepEqual(input.ExpressionAttributeValues, { ":task": { S: "t-0123456789abcdef" }, ":seq": { N: "3" } });
    assert.ok(!("ReturnValues" in input) && sent.length === 1, "one request, nothing read back");
    answer = "condition";
    assert.equal(await writer.write(status(), 2, 1_760_000_000_000), "stale");
    answer = "error";
    assert.equal(await writer.write(status(), 4, 1_760_000_000_000), "failed");
  });

  test("the reporter: seq grows, a tick while a write is out is skipped (single flight), a failure is counted and never thrown", async () => {
    const releases: Array<() => void> = [];
    const results: string[] = [];
    let fail = false;
    const writer: TaskStatusWriter = {
      write: (_status, seq) =>
        new Promise((resolve) => {
          releases.push(() => resolve(fail ? "failed" : "written"));
          results.push(String(seq));
        }),
    };
    let failures = 0;
    const reporter = taskStatusReporter({ writer, status: () => status(), now: () => 1_760_000_000_000, onFailure: () => (failures += 1) });
    const first = reporter.tick();
    assert.equal(await reporter.tick(), "skipped");
    releases.shift()!();
    assert.equal(await first, "written");
    fail = true;
    const second = reporter.tick();
    releases.shift()!();
    assert.equal(await second, "failed");
    assert.deepEqual(results, ["1", "2"]);
    assert.deepEqual(reporter.health(), { writes: 1, failures: 1, skipped: 1, lastWrittenAt: 1_760_000_000_000 });
    assert.equal(failures, 1);
    let statusFailures = 0;
    const throwing = taskStatusReporter({ writer, status: () => assert.fail("a status that cannot be built"), now: () => 0, onFailure: () => (statusFailures += 1) });
    assert.equal(await throwing.tick(), "failed");
    assert.equal(statusFailures, 1, "a status that cannot be built is a failure the metric counts too");
  });

  test("through the runtime: written from the pool takeover on (starting, then serving; primary), `stopping` at the shutdown; a non-primary task says non-primary; failures become TaskStatusWriteFailures", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    await until(() => runtime.backend?.state() === "active", "the backend active");
    runtime.statusTick();
    await new Promise((resolve) => setImmediate(resolve)); // the tick's write answered (single flight)
    await runtime.shutdown();
    const phases = h.taskWrites.map((write) => `${write.status.role}/${write.status.phase}/${write.status.ready}`);
    assert.equal(phases[0], "undecided/starting/false", "the first write, right after the pool was taken");
    assert.ok(phases.includes("primary/serving/true"), phases.join(" "));
    assert.equal(phases.at(-1), "primary/stopping/false");
    const seqs = h.taskWrites.map((write) => write.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.ok(h.taskWrites.every((write) => write.status.task === "t-l65atest" && write.status.poolEpoch === 7 && write.status.generation === 1));
    assert.equal(h.taskWrites.at(-2)!.status.relayer, "usable");

    const standby = harness({ primary: false });
    const s = await standby.start();
    s.statusTick();
    await new Promise((resolve) => setImmediate(resolve));
    await s.shutdown();
    assert.equal(standby.taskWrites.at(-2)!.status.role, "non-primary");
    assert.equal(standby.taskWrites.at(-1)!.status.phase, "stopping");

    const failing = harness({ taskStatus: "throws" });
    const f = await failing.start();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      f.statusTick();
      await new Promise((resolve) => setImmediate(resolve));
      f.statusTick();
      assert.ok(failing.sum("TaskStatusWriteFailures") >= 1);
      assert.ok(((f.status() as { aws: { observability: { task_status: { failures: number } } } }).aws.observability.task_status.failures) >= 2);
    } finally {
      await f.shutdown();
    }
  });

  test("SOURCE GUARD: nothing in the server reads a TASK# item -- the key is named only by its writer (and tests); the metric and status modules are reached only from the AWS runtime", () => {
    const root = path.resolve(__dirname, "../../../../../src") /* dist/server/src/aws/runtime -> server/src */;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          const relative = path.relative(root, full).split(path.sep).join("/");
          if (relative.endsWith(".test.ts")) continue;
          const text = fs.readFileSync(full, "utf8");
          const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // comments may name it; code may not
          if (/["'`]TASK#|taskStatusKey|taskStatusPk/.test(code) && relative !== "aws/runtime/taskStatus.ts") offenders.push(`${relative}: names the TASK# item`);
          for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
            const target = path.relative(root, path.resolve(path.dirname(full), match[1])).split(path.sep).join("/");
            if ((target === "aws/runtime/runtimeMetrics" || target === "aws/runtime/taskStatus") && !relative.startsWith("aws/runtime/")) offenders.push(`${relative}: imports ${target}`);
          }
          if ((relative === "aws/runtime/runtimeMetrics.ts" || relative === "aws/runtime/taskStatus.ts") && /from\s+"[^"]*frontend\//.test(text)) offenders.push(`${relative}: imports the frontend`);
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, []);
    const taskStatusSource = fs.readFileSync(path.join(root, "aws/runtime/taskStatus.ts"), "utf8");
    assert.ok(!/GetItemCommand|QueryCommand|ScanCommand|getItem\(/.test(taskStatusSource), "the writer never reads the item back");
  });

  test("PROCESS mode is untouched: start.ts still reaches the AWS code only through storageMode and awsMain", () => {
    const start = fs.readFileSync(path.resolve(__dirname, "../../../../../src/start.ts"), "utf8");
    assert.ok(!/runtimeMetrics|taskStatus/.test(start));
    const imports = [...start.matchAll(/(?:from\s+|import\()\s*"([^"]*aws\/runtime[^"]*)"/g)].map((match) => match[1]).sort();
    assert.deepEqual(imports, ["./aws/runtime/awsMain", "./aws/runtime/storageMode"]);
  });
});

/* ==================================================================
    THE REVIEW'S FIXES: CAUSES, REFUSALS, PENDING COUNTS, IDS KEPT
   ================================================================== */
describe("L6-5A causes, refused starts, pending counts and ids", () => {
  test("a loss's cause is a fixed code from the reporters' own texts; a pool superseded by a newer task of it is also TaskSuperseded (the rolling-deploy loss)", async () => {
    const texts: string[] = [];
    const hook = ledgerFencedHook({ markLost: (reason: string) => texts.push(reason) });
    hook("generation", "APPGEN is 2");
    hook("relayer", "epoch 6");
    assert.deepEqual(texts.map(lossCauseOf), ["generation-moved", "role-lost"]);
    assert.equal(lossCauseOf("pool p1 is at epoch 8 (t-newer), not this task's 7"), "pool-superseded");
    assert.equal(lossCauseOf("pool p1 is at epoch 6 (t-older), not this task's 7"), "other", "an epoch that went BACKWARDS is not a newer task");
    assert.equal(lossCauseOf("pool p1 is at epoch 7 (t-someone), not this task's 7"), "other", "another task at our epoch is not a newer task");
    assert.equal(lossCauseOf(`a write to ${GAME_A} was refused by the pool fence (the condition failed)`), "pool-fenced", "a fence cannot say forward or gone");
    assert.equal(lossCauseOf(`the claim of ${GAME_A} was refused by the pool fence: epoch 7 is no longer pool p1's newest`), "pool-fenced");
    assert.equal(lossCauseOf(`${GAME_A} is claimed by a newer task of pool p1 (epoch 9)`), "pool-superseded");
    assert.equal(lossCauseOf("the pool item POOL#p1 is gone (the table was restored or replaced)"), "pool-gone");
    assert.equal(lossCauseOf("the adopted app generation moved: APPGEN is 3"), "generation-moved");
    assert.equal(lossCauseOf("the relayer role is no longer this task's: the mirror moved"), "role-lost");
    assert.equal(lossCauseOf("something nobody wrote yet"), "other", "unknown -> other: an alarm treats it as unexpected");

    for (const [trip, cause, superseded] of [
      ["pool", "pool-superseded", 1],
      ["identity", "role-lost", 0],
      ["journal", "generation-moved", 0],
    ] as const) {
      const h = harness();
      const runtime = await h.start();
      try {
        if (trip === "pool") h.writer().markLost("pool p1 is at epoch 8 (t-newer), not this task's 7");
        if (trip === "identity") h.hooks.identity!.onFenced("the role is at epoch 4");
        if (trip === "journal") h.hooks.journal!.onFenced("APPGEN is 2");
        const record = h.byEvent("task-lost")[0];
        assert.equal(record.cause, cause, trip);
        /* L6-5B (review H1): written as 0 when not superseded -- the same Sum, and A1's subtraction always has both operands. */
        assert.equal(record.TaskSuperseded, superseded === 1 ? 1 : 0, trip);
        assert.equal(h.sum("TaskLost"), 1);
      } finally {
        await closed(runtime);
      }
    }
  });

  test("a refused start is ONE StartupRefused with its stage (never its message); a loss or restart that ends the startup is not a refusal", async () => {
    const mismatch = harness({ adopted: 2 });
    await assert.rejects(mismatch.start(), (error: unknown) => (error as { exitCode?: number }).exitCode === 2);
    assert.equal(mismatch.sum("StartupRefused"), 1);
    assert.equal(mismatch.byEvent("startup-refused")[0].stage, "config");
    assertClean(mismatch.metricLines.join("\n"), "a refusal");

    const pool = harness({ poolFails: true });
    await assert.rejects(pool.start(), (error: unknown) => (error as { exitCode?: number }).exitCode === 2);
    assert.deepEqual([pool.sum("StartupRefused"), pool.byEvent("startup-refused")[0].stage], [1, "generation"]);

    const restart = harness();
    await assert.rejects(
      restart.start({
        substrate: {
          ...(await (async () => {
            const inner = harness();
            return inner.input().substrate;
          })()),
          openIdentityStore(_epoch, hooks) {
            const store = Object.assign(createMemoryIdentityStore(), { grants: createMemoryGrantStore(), health: () => ({ loaded: true, fenced: null }) });
            const load = store.load.bind(store);
            store.load = async () => {
              hooks.onRestartRequired("the identity table disagrees (injected)");
              return load();
            };
            return store;
          },
        },
      }),
      (error: unknown) => (error as { exitCode?: number }).exitCode === 4,
    );
    assert.equal(restart.sum("StartupRefused"), 0, "exit 4 is counted as StoreUncertain, not as a refusal");
    assert.equal(restart.sum("StoreUncertain"), 1);

    /* A refusal path reached AFTER a loss (the game server cannot be built, and the pool was lost first): exit 3, one
       TaskLost, no StartupRefused. */
    const lostFirst = harness();
    await assert.rejects(
      lostFirst.start({
        createGameServer: () => {
          lostFirst.writer().markLost("pool p1 is at epoch 8 (t-newer), not this task's 7");
          throw new Error("the game server could not be built (injected)");
        },
      }),
      (error: unknown) => (error as { exitCode?: number }).exitCode === 3,
    );
    assert.deepEqual([lostFirst.sum("TaskLost"), lostFirst.sum("StartupRefused")], [1, 0]);
  });

  test("what is still pending rides on the forced exit's own record: a KMS Sign, then a loss -> the task-lost record carries it (one record)", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    try {
      await until(() => runtime.backend?.state() === "active", "the backend active");
      runtime.statusTick();
      await h.hooks.backendDeps!.kms!.signDigest(SETTLEMENT_KEY, Buffer.alloc(32, 8));
      h.writer().markLost("pool p1 is at epoch 8 (t-newer), not this task's 7");
      const lost = h.byEvent("task-lost");
      assert.equal(lost.length, 1);
      assert.equal(lost[0].KmsSigns, 1);
      assert.equal(h.sum("KmsSigns"), (runtime.status() as { aws: { kms: { signs: number } } }).aws.kms.signs);
    } finally {
      await closed(runtime);
    }
  });

  test("a status line lost at the start of the shutdown is carried by the shutdown's last record (counters-flush): the Sum stays exact", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    await until(() => runtime.backend?.state() === "active", "the backend active");
    runtime.statusTick();
    await h.hooks.backendDeps!.kms!.signDigest(SETTLEMENT_KEY, Buffer.alloc(32, 6));
    h.failNext.push("task-status"); // the shutdown's first tick fails to write
    await runtime.shutdown();
    const flush = h.byEvent("counters-flush");
    assert.equal(flush.length, 1);
    assert.equal(flush[0].KmsSigns, 1);
    assert.equal(h.sum("KmsSigns"), (runtime.status() as { aws: { kms: { signs: number } } }).aws.kms.signs);
    const quiet = harness();
    const r = await quiet.start();
    await r.shutdown();
    assert.equal(quiet.byEvent("counters-flush").length, 0, "nothing pending: no line");
  });

  test("a digest-shaped pool id, image-digest build and the task id stay themselves (dimensions and ids are never shape-redacted); free text still is", () => {
    const pool = "a".repeat(64);
    const build = `sha256:${"b".repeat(64)}`;
    const built = buildEmfRecord({ environment: "prod", pool }, 1_760_000_000_000, { event: "task-status", metrics: { Ready: 1 }, properties: { task: "t-0123456789abcdef", build, reasons: `x ${GAME_A}` } })!;
    assert.equal(built.Pool, pool);
    assert.equal(built.build, build);
    assert.equal(built.task, "t-0123456789abcdef");
    assert.ok(!String(built.reasons).includes(GAME_A));
    const item = taskStatusItem({ ...{ task: "t-1", pool, poolEpoch: 1, generation: 1, environment: "prod", build, role: "primary", phase: "serving", ready: true, reasons: [], relayer: "usable", escrow: "active", poolWriterCheckAgeMs: 0, startedAt: 0 } }, 1, 1);
    assert.deepEqual([item.pool, item.build], [{ S: pool }, { S: build }], "the TASK# item names the pool as POOL# does");
  });
});

/* ==================================================================
    A WHOLE RUN: EVERY LINE VALID, NOTHING FORBIDDEN
   ================================================================== */
describe("L6-5A a whole run's lines", () => {
  test("startup, sweeps (failed and passed), relayer retry, KMS (every class), readiness flaps, shutdown: every line valid EMF with only Environment and Pool as dimensions; no secret, id or error text", async () => {
    const h = harness({ escrow: true, relayer: ["throws"], sweeps: ["throws", { claimed: [GAME_A], owned: 1, elsewhere: 0, skipped: 0, failed: [] }] });
    const runtime = await h.start();
    try {
      await until(() => runtime.backend?.state() === "active", "the backend active");
      await runtime.retryRelayerRole();
      const kms = h.hooks.backendDeps!.kms!;
      await kms.signDigest(SETTLEMENT_KEY, Buffer.alloc(32, 5));
      for (const mode of ["transient", "refused", "invalid-answer", "other"] as const) {
        h.kms.state.mode = mode;
        await assert.rejects(kms.signDigest(SETTLEMENT_KEY, Buffer.alloc(32, 5)));
      }
      h.kms.state.mode = "ok";
      h.writer().ready = false;
      runtime.readiness();
      h.writer().ready = true;
      runtime.readiness();
      runtime.statusTick();
    } finally {
      await runtime.shutdown();
    }
    const records = h.records();
    assert.ok(records.length >= 8);
    const events = new Set(records.map((record) => record.event));
    for (const event of ["money-sweep", "money-sweep-failed", "readiness-transition", "relayer-transition", "relayer-takeover", "task-status"]) assert.ok(events.has(event), event);
    for (const record of records) {
      assertValidEmf(record);
      assert.equal(record.Environment, "test");
      assert.equal(record.Pool, "p1");
    }
    assertClean(h.metricLines.join("\n"), "the run's metric lines");
    assert.ok(!h.metricLines.some((line) => line.startsWith("AUDIT")), "a metric line is never an audit line");
  });
});

/* ==================================================================
   LIVE-6 L6-5B: the converged runtime's remaining conditions -- L6-7's relayer paging state, the generation / restore
   refusals and losses, the journal-ahead hold, post-restore safe mode. The same harness; the same rules (counted once,
   at the decision; gauges only from the task whose answer is authoritative; nothing identifying in a line).
   ================================================================== */

/** A backend whose relayer reports `status` over its real one, and whose service's restore view is `restore`. */
function scriptedBackend(backend: JunoBackend, script: { readonly relayer?: Partial<ReturnType<JunoBackend["relayer"]["status"]>>; readonly restore?: { readonly pending: number } }): JunoBackend {
  const relayer = new Proxy(backend.relayer, {
    get(target, name) {
      if (name === "status" && script.relayer !== undefined) return () => ({ ...target.status(), ...script.relayer });
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new Proxy(backend.service, {
    get(target, name) {
      if (name === "restoreStatus" && script.restore !== undefined) return () => ({ ...target.restoreStatus(), pending: script.restore?.pending ?? 0 });
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(backend, {
    get(target, name) {
      if (name === "relayer") return relayer;
      if (name === "service") return service;
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("L6-5B the relayer's paging state (L6-7) as gauges", () => {
  const paging = (now: number) => ({
    paging: {
      waiting: 3,
      paged: 1,
      oldest_since: now - 125_000,
      conditions: [{ condition: "deployment-unavailable" as const, game_id: GAME_A, intent_id: "i-0123456789abcdef", op: "settle", why: `the deployment of ${GAME_A} is not served here`, since: now - 125_000, paged: true }],
      truncated: false,
    },
    queue_mismatch: 2,
    troubled: 1,
  });

  test("from the usable holder: RelayerPaging / Waiting / QueueMismatch / Troubled / OldestWaitingSeconds -- counts only (no condition, game or intent in any line, no new dimension)", async () => {
    const h = harness({ escrow: true, wrapBackend: (b) => scriptedBackend(b, { relayer: paging(Date.now()) as never }) });
    const runtime = await h.start();
    try {
      await until(() => runtime.backend?.state() === "active", "the backend active");
      runtime.statusTick();
      const status = h.byEvent("task-status").at(-1)!;
      assert.equal(status.relayer_state, "usable");
      assert.deepEqual([status.RelayerPaging, status.RelayerWaiting, status.RelayerQueueMismatch, status.RelayerTroubled], [1, 3, 2, 1]);
      assert.ok(status.RelayerOldestWaitingSeconds >= 125 && status.RelayerOldestWaitingSeconds < 140, String(status.RelayerOldestWaitingSeconds));
      const directives: Array<{ Dimensions: string[][]; Metrics: Array<{ Name: string }> }> = status._aws.CloudWatchMetrics;
      const holding = directives.find((d) => d.Metrics.some((m) => m.Name === "RelayerPaging"))!;
      assert.deepEqual(holding.Dimensions, [["Environment", "Pool"]], "a gauge: [Environment, Pool] only (its alarm exists on every pool)");
      const text = h.metricLines.join("\n");
      assert.ok(!text.includes("deployment-unavailable") && !text.includes("i-0123456789abcdef"), "the condition codes and intents stay in L6-7's audit lines");
      assertClean(text, "the relayer paging lines");
    } finally {
      await runtime.shutdown();
    }
  });

  test("a task whose relayer is NOT usable (the role not taken) emits none of them, whatever its own view says (L6-7: only the holder pages)", async () => {
    const h = harness({ escrow: true, relayer: ["throws"], wrapBackend: (b) => scriptedBackend(b, { relayer: paging(Date.now()) as never }) });
    const runtime = await h.start();
    try {
      await until(() => runtime.backend?.state() === "active", "the backend active");
      runtime.statusTick();
      const status = h.byEvent("task-status").at(-1)!;
      assert.equal(status.relayer_state, "not-taken");
      for (const name of ["RelayerPaging", "RelayerWaiting", "RelayerQueueMismatch", "RelayerTroubled", "RelayerOldestWaitingSeconds"]) assert.ok(!(name in status), `${name} from a non-holder`);
    } finally {
      await runtime.shutdown();
    }
  });

  test("a healthy holder reports zeros (so a page clears), and none without escrow or on a non-primary task", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    try {
      await until(() => runtime.backend?.state() === "active", "the backend active");
      runtime.statusTick();
      const status = h.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.RelayerPaging, status.RelayerWaiting, status.RelayerQueueMismatch, status.RelayerTroubled, status.RelayerOldestWaitingSeconds], [0, 0, 0, 0, 0]);
    } finally {
      await runtime.shutdown();
    }
    for (const options of [{}, { primary: false }] as const) {
      const other = harness(options);
      const r = await other.start();
      try {
        r.statusTick();
        assert.ok(!("RelayerPaging" in other.byEvent("task-status").at(-1)!), JSON.stringify(options));
      } finally {
        await r.shutdown();
      }
    }
  });
});

describe("L6-5B generation and restore signals", () => {
  const refused = async (options: Parameters<typeof harness>[0]) => {
    const h = harness(options);
    await assert.rejects(h.start(), (error: unknown) => (error as { exitCode?: number }).exitCode === 2);
    const record = h.byEvent("startup-refused");
    assert.equal(record.length, 1, JSON.stringify(options));
    return { h, record: record[0] };
  };

  test("a refusal by the generation rules (APPGEN, SYSTEM/GENERATION) or the adoption binding is ALSO a StartupRefusedGeneration; an incomplete identity restore a StartupRefusedIdentityRestore; any other refusal neither", async () => {
    for (const [options, refusal] of [
      [{ adopted: 2 }, "generation"],
      [{ marker: "other-generation" }, "generation"],
      [{ marker: "restore-unadopted" }, "adoption"],
    ] as const) {
      const { h, record } = await refused(options);
      assert.deepEqual([record.StartupRefused, record.StartupRefusedGeneration, "StartupRefusedIdentityRestore" in record, record.refusal], [1, 1, false, refusal], JSON.stringify(options));
      const env = (record._aws.CloudWatchMetrics as Array<{ Dimensions: string[][]; Metrics: Array<{ Name: string }> }>).find((d) => d.Metrics.some((m) => m.Name === "StartupRefusedGeneration"))!;
      assert.deepEqual(env.Dimensions, [["Environment", "Pool"], ["Environment"]], "an environment-level copy: its alarm survives a pool change");
      assertClean(h.metricLines.join("\n"), "a generation refusal");
    }
    for (const where of ["takeover", "load"] as const) {
      const identity = await refused({ identityRestoreIncomplete: where });
      assert.deepEqual([identity.record.StartupRefused, identity.record.StartupRefusedIdentityRestore, "StartupRefusedGeneration" in identity.record, identity.record.refusal], [1, 1, false, "identity-restore"], where);
      assertClean(identity.h.metricLines.join("\n"), "an identity-restore refusal");
    }
    const pool = await refused({ poolFails: true });
    assert.deepEqual(["StartupRefusedGeneration" in pool.record, "StartupRefusedIdentityRestore" in pool.record, pool.record.refusal], [false, false, "other"]);
  });

  test("a loss to the generation fence (APPGEN moved) is TaskLost + GenerationLost, never TaskSuperseded; any other loss is never GenerationLost", async () => {
    const h = harness();
    const runtime = await h.start();
    try {
      h.writer().markLost("the adopted app generation moved (2, not this task's 1): an old-generation task is fenced (injected)");
      h.writer().markLost("again");
      assert.deepEqual(h.exits, [3]);
      const lost = h.byEvent("task-lost");
      assert.equal(lost.length, 1);
      assert.deepEqual([lost[0].TaskLost, lost[0].GenerationLost, lost[0].TaskSuperseded, lost[0].cause], [1, 1, 0, "generation-moved"], "TaskSuperseded 0 is written (review H1: A1's math never fills an empty series)");
    } finally {
      await closed(runtime);
    }
    const other = harness();
    const r = await other.start();
    try {
      other.writer().markLost("a newer task took pool p1 at epoch 8 (injected)");
      assert.ok(!("GenerationLost" in other.byEvent("task-lost")[0]));
    } finally {
      await closed(r);
    }
  });

  test("a journal-ahead hold, as the escrow service audits it, is ONE MoneyHeldJournalAhead; the audit line passes unchanged; another hold code is not counted", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    try {
      const ops = h.hooks.backendDeps!.ops!;
      ops.audit("settlement.held", { game_id: GAME_A, code: "journal-ahead", from: "funding" });
      ops.audit("settlement.held", { game_id: GAME_A, code: "binding-mismatch", from: "funding" });
      ops.audit("money.restore-verified", { game_id: GAME_A, detail: "x" });
      assert.equal(h.sum("MoneyHeldJournalAhead"), 1);
      const held = h.ops.lines.filter((line) => line.event === "settlement.held");
      assert.deepEqual(held.map((line) => [line.game_id, line.code]), [[GAME_A, "journal-ahead"], [GAME_A, "binding-mismatch"]], "the audit stream is exactly as the service wrote it");
      assert.ok(!h.metricLines.join("\n").includes(GAME_A), "the game stays in the audit line");
    } finally {
      await runtime.shutdown();
    }
  });

  test("post-restore safe mode: RestoreSafeMode 1 on a restored table (a state, not an alarm) and RestoreUnverifiedGames = the service's pending checks; a bootstrap table reports 0 and no count", async () => {
    const h = harness({ escrow: true, marker: "restore", wrapBackend: (b) => scriptedBackend(b, { restore: { pending: 2 } }) });
    const runtime = await h.start();
    try {
      await until(() => runtime.backend?.state() === "active", "the backend active");
      runtime.statusTick();
      const status = h.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.RestoreSafeMode, status.RestoreUnverifiedGames], [1, 2]);
      assert.ok(h.ops.lines.some((line) => line.event === "aws.restore-safe-mode"), "L6-2's audit is unchanged");
    } finally {
      await runtime.shutdown();
    }
    const boot = harness({ escrow: true });
    const r = await boot.start();
    try {
      r.statusTick();
      const status = boot.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.RestoreSafeMode, "RestoreUnverifiedGames" in status], [0, false]);
    } finally {
      await r.shutdown();
    }
    const noEscrow = harness({ marker: "restore" });
    const n = await noEscrow.start();
    try {
      n.statusTick();
      const status = noEscrow.byEvent("task-status").at(-1)!;
      assert.deepEqual([status.RestoreSafeMode, "RestoreUnverifiedGames" in status], [1, false], "no escrow service: no money game to verify");
    } finally {
      await n.shutdown();
    }
  });
});

describe("L6-5B the primary heartbeat and A1's operands", () => {
  test("`Primary` is reported only by the identity-writer's task (the primary), from its takeover on -- never by a non-primary router, so a heartbeat left on a demoted pool finds nothing (review M1)", async () => {
    const primary = harness();
    const p = await primary.start();
    try {
      p.statusTick();
      assert.equal(primary.byEvent("task-status").at(-1)!.Primary, 1);
    } finally {
      await p.shutdown();
    }
    const router = harness({ primary: false });
    const r = await router.start();
    try {
      r.statusTick();
      const status = router.byEvent("task-status").at(-1)!;
      assert.ok(!("Primary" in status) && status.Ready === 1, "a healthy router: Ready, but never Primary");
      assert.ok(router.byEvent("task-status").every((record) => !("Primary" in record)));
    } finally {
      await r.shutdown();
    }
  });

  test("every task-lost record carries BOTH of A1's operands (TaskSuperseded 0 or 1), whatever the cause", async () => {
    for (const reason of ["a newer task took pool p1 at epoch 8 (injected)", "the identity-writer role was taken over (injected)", "something else entirely (injected)"]) {
      const h = harness();
      const runtime = await h.start();
      try {
        h.writer().markLost(reason);
        const lost = h.byEvent("task-lost")[0];
        assert.ok(typeof lost.TaskLost === "number" && typeof lost.TaskSuperseded === "number", JSON.stringify(lost));
        const directive = (lost._aws.CloudWatchMetrics as Array<{ Dimensions: string[][]; Metrics: Array<{ Name: string }> }>).find((d) => d.Metrics.some((m) => m.Name === "TaskSuperseded"))!;
        assert.deepEqual(directive.Dimensions, [["Environment", "Pool"], ["Environment"]]);
      } finally {
        await closed(runtime);
      }
    }
  });
});
