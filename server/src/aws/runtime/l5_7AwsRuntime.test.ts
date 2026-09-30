// server/src/aws/runtime/l5_7AwsRuntime.test.ts
//
// LIVE-5 L5-7: the AWS storage mode's runtime -- its ORDER and its REACTIONS -- over a scripted substrate (the certified
// L5-2 ... L5-6 pieces are replaced by recorders; their own behaviour is their suites', and the real composition runs on
// DynamoDB Local in `persistence/conformance/awsRuntime.dynamoLocal.test.ts`). The real game server, the real identity
// service and -- for the escrow cases -- the real Juno backend on ESCROW-3B's offline chain are used as built.
//
//   startup      the generation check before the pool; a pool takeover that fails refuses the start (nothing else runs);
//                the identity-writer role before the identity store, the store before its load; the ledger and the
//                relayer role after identity, before the backend; the backend constructed without a preload; the first
//                money claim sweep before the backend starts (and so before the relayer's load); the stores built with
//                the pool writer's fence; the claim before a game's first read; a non-primary task a standby that takes
//                no role and serves no player
//   escrow/KMS   production KMS keys open (no "no KMS client is wired"); every Sign passes the pool writer's gate, and a
//                withheld Sign never reaches KMS; the relayer role retried only once the backend is active, published only
//                after the relayer's load
//   readiness    `/gs/readyz` follows the pool writer's readiness and the startup; `/gs/healthz` is liveness, unchanged
//   loss         the pool writer's loss, the identity writer's fence and the ledger's fence are exit 3 at once, with no
//                graceful drain; a store that must restart is exit 4
//   shutdown     the documented order, and it waits for `identity.settled()`
//   config       the references and the runtime document fail closed; the escrow configuration must name the same ledger
//                and KMS keys only; SSM SecureString refused; a secret never prints
//   process      `GS_STORAGE` absent is PROCESS mode, and `start.ts` loads no AWS code for it

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { inspect } from "util";

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { AwsStartupError, startAwsRuntime, type AwsGameStores, type AwsRuntime, type AwsRuntimeInput, type AwsSubstrate, type IdentityStoreHandle, type RelayerIntentView, type RelayerRoleLike, type RelayerTakeover } from "./awsRuntime";
import { gatedKmsClient } from "./kmsGate";
import { loadAwsStartup } from "./awsMain";
import { ConfigSourceError, SecretValue, secretsManagerSource, ssmParameterSource, type ParameterSource } from "./configSource";
import { createConsoleOpsRecorder } from "./consoleOps";
import { AWS_RUNTIME_CONFIG_FORMAT, awsStartupReferences, checkEscrowConfigForAws, parseAwsRuntimeConfig, parseAwsRuntimeConfigText, AwsRuntimeConfigError } from "./runtimeConfig";
import { storageKindOf } from "./storageMode";
import { parseSecretArn, parseSsmParameterArn } from "../arns";
import { PoolTakeoverLostError, PoolWriterNotCurrentError, type HeldProbe } from "../ownership/poolWriter";
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
import { ADMISSION_PUBKEY, ADMISSION_SECRET, CANONICAL_CHECKSUM, CHAIN_ID, CONTRACT, makeWorld, RELAYER_ADDRESS, RELAYER_SECRET, SETTLEMENT_SECRET, type World } from "../../escrow/escrow3bSupport";
import { createMemoryGrantStore } from "../../identity/grants";
import { createMemorySecurityJournal } from "../../identity/securityEvents";
import { createMemoryIdentityStore } from "../../identity/store";
import { createMemoryOpsRecorder, type MemoryOpsRecorder } from "../../persistence/opsRecorder";
import { createMemoryHoldStore } from "../../rooms/holdStore";
import { createMemoryRecordStore } from "../../rooms/recordStore";
import { ALICE, BOB, controlledStore, quietConsole, seedGame, storedLog } from "../../rooms/testSupport";

quietConsole();

const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:210987654321:table/gs-test-ledger";
const RUNTIME_PARAM = "arn:aws:ssm:us-east-1:123456789012:parameter/gs/test/runtime";
const ESCROW_PARAM = "arn:aws:ssm:us-east-1:123456789012:parameter/gs/test/juno-backend";
const KEY = (n: number, region = "us-east-1") => `arn:aws:kms:${region}:123456789012:key/${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const RELAYER_KEY = KEY(1);
const SETTLEMENT_KEY = KEY(2);
const ADMISSION_KEY = KEY(3);

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
const CONFIG = parseAwsRuntimeConfig(runtimeDoc());

/** A v3 production Juno configuration: three KMS keys by ARN, the SAME ledger as the runtime's. */
const escrowRaw = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});
function escrowConfig(): JunoBackendConfig {
  const parsed = parseJunoBackendConfig(escrowRaw(), { serverMode: "production", dataDir: "/nonexistent" });
  /* The offline chain's resolver (as ESCROW-3B's review suite does). */
  return { ...parsed, trust: { ...parsed.trust, resolvers: ["juno1resolver"] } };
}

/* ---------------- a KMS stand-in at the port (secp256k1 in memory) ---------------- */
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
function kmsStandIn(keys: Record<string, Buffer> = { [RELAYER_KEY]: RELAYER_SECRET, [SETTLEMENT_KEY]: SETTLEMENT_SECRET, [ADMISSION_KEY]: ADMISSION_SECRET }) {
  const calls: string[] = [];
  const port: KmsClient = {
    async getPublicKey(ref) {
      calls.push(`GetPublicKey ${ref}`);
      const secret = keys[ref];
      if (secret === undefined) throw Object.assign(new Error(`no key ${ref}`), { name: "KmsCallError", failure: "refused", signatureMayExist: false });
      return spkiOf(secret);
    },
    async signDigest(ref, digest) {
      calls.push(`Sign ${ref}`);
      return derOf(signDigest(keys[ref], Buffer.from(digest)));
    },
  };
  return { port, calls };
}

/* ---------------- the scripted substrate ---------------- */
class FakeWriter {
  readonly pool = "p1";
  readonly epoch = 7;
  lostReason: string | null = null;
  ready = true;
  generation: HeldProbe | null = null;
  gate: () => Promise<void> = async () => undefined;
  gateCalls = 0;
  constructor(
    private readonly events: string[],
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
    this.events.push("writer:lost");
    this.onLost(reason);
  }
  start(): void {
    this.events.push("writer:start");
  }
  stop(): void {
    this.events.push("writer:stop");
  }
  watchGeneration(probe: HeldProbe): void {
    this.generation = probe;
    this.events.push("writer:watch-generation");
  }
  async beforeSideEffect(): Promise<void> {
    this.gateCalls += 1;
    if (this.lostReason !== null) throw new PoolWriterNotCurrentError(`lost: ${this.lostReason}`, true);
    await this.gate();
  }
  readiness() {
    return { ready: this.lostReason === null && this.ready, lost: this.lostReason, lastGoodAgeMs: this.ready ? 0 : 30_000 };
  }
}

type Ledger = InspectableSigningJournal & { readonly relayer: string };

interface HarnessOptions {
  readonly primary?: boolean;
  readonly adopted?: number | null | "throws";
  readonly poolFails?: boolean;
  readonly escrow?: boolean;
  /** The relayer takeover's answers, in order (then "taken"). */
  readonly relayer?: Array<"taken" | "throws" | "not-primary">;
  readonly sweepThrows?: number;
  readonly kmsKeys?: Record<string, Buffer>;
  /** The identity store asks for a restart while it loads (a store that must restart DURING the startup). */
  readonly restartDuringIdentityLoad?: boolean;
  /** Every chain call waits for this gate (a verification still in flight). */
  readonly chainGate?: Promise<void>;
}

interface Harness {
  readonly events: string[];
  readonly exits: number[];
  readonly lines: string[];
  readonly ops: MemoryOpsRecorder;
  readonly control: ReturnType<typeof controlledStore>;
  readonly records: ReturnType<typeof createMemoryRecordStore>;
  readonly financial: ReturnType<typeof createMemoryFinancialGameStore> & OpenMoneyGames;
  readonly world: World;
  readonly kms: ReturnType<typeof kmsStandIn>;
  readonly hooks: {
    identity?: { onFenced(detail: string): void; onRestartRequired(detail: string): void };
    journal?: { onFenced(detail: string): void };
    ledger?: (which: "generation" | "relayer", detail: string) => void;
    relayerView?: RelayerIntentView | null;
    backendDeps?: JunoBackendDeps;
    listCallsAtOpen?: { before: number; after: number };
    /** The relayer authority's `current()` at each relayer load (it must be false while a retry's load runs). */
    authorityAtLoad: boolean[];
    chainCalls: number;
  };
  writer(): FakeWriter;
  input(over?: Partial<AwsRuntimeInput<FakeWriter, Ledger>>): AwsRuntimeInput<FakeWriter, Ledger>;
  start(over?: Partial<AwsRuntimeInput<FakeWriter, Ledger>>): Promise<AwsRuntime>;
}

function harness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const exits: number[] = [];
  const lines: string[] = [];
  const ops = createMemoryOpsRecorder();
  const control = controlledStore();
  const loadLog = control.store.loadLog.bind(control.store);
  control.store.loadLog = async (room) => {
    events.push(`log:load:${room}`);
    return loadLog(room);
  };
  const records = createMemoryRecordStore();
  let lists = 0;
  const memoryFinancial = createMemoryFinancialGameStore();
  const listFinancial = memoryFinancial.list.bind(memoryFinancial);
  const financial = Object.assign(memoryFinancial, {
    list: async () => {
      lists += 1;
      return listFinancial();
    },
    identityKeys: async () => [] as string[],
    openGames: async () => [] as string[],
    /* LIVE-6 L6-7: the open money games (the scripted store has no index: its records not closed or cancelled). */
    openMoneyGameIds: async () => {
      const open: string[] = [];
      for (const gameId of await listFinancial()) {
        const record = await memoryFinancial.load(gameId).catch(() => "unreadable" as const);
        if (record === "unreadable" || (record !== null && record.phase !== "closed" && record.phase !== "cancelled")) open.push(gameId);
      }
      return open.sort();
    },
  });
  const world = makeWorld();
  const kms = kmsStandIn(options.kmsKeys);
  const hooks: Harness["hooks"] = { authorityAtLoad: [], chainCalls: 0 };
  let writer: FakeWriter | null = null;
  const relayerAnswers = [...(options.relayer ?? [])];
  let sweepThrows = options.sweepThrows ?? 0;

  const identityStore = Object.assign(createMemoryIdentityStore(), { grants: createMemoryGrantStore(), health: () => ({ loaded: true, fenced: null }) });
  const identityLoad = identityStore.load.bind(identityStore);
  identityStore.load = async () => {
    events.push("identity:load");
    if (options.restartDuringIdentityLoad === true) hooks.identity?.onRestartRequired("the identity table disagrees with this writer (injected)");
    return identityLoad();
  };

  const ownership: PoolGameOwnership = {
    mode: "pool",
    async claim(gameId) {
      events.push(`claim:${gameId}`);
      return { kind: "claimed" };
    },
    release(gameId) {
      events.push(`release:${gameId}`);
    },
    onFenced() {
      /* recorded by L5-3's own suite */
    },
    async sweepMoneyClaims(): Promise<SweepReport> {
      events.push("sweep");
      if (sweepThrows > 0) {
        sweepThrows -= 1;
        throw new Error("FINKEYS could not be read (injected)");
      }
      return { claimed: [], owned: 0, elsewhere: 0, skipped: 0, failed: [] };
    },
    async settled() {
      events.push("ownership:settled");
    },
  };

  const substrate: AwsSubstrate<FakeWriter, Ledger> = {
    async adoptedGeneration() {
      events.push("generation:read");
      if (options.adopted === "throws") throw new Error("AccessDeniedException: not allowed (injected)");
      return options.adopted === undefined ? 1 : options.adopted;
    },
    async takePool({ task, onLost }) {
      events.push("pool:take");
      if (options.poolFails === true) throw new PoolTakeoverLostError("pool p1 was taken by t-other at epoch 8 while this task was taking it");
      writer = new FakeWriter(events, task, onLost);
      return writer;
    },
    generationProbe: () => ({ check: async () => ({ held: true }) }),
    async takeIdentityWriterRole(): Promise<RoleTakeover> {
      events.push("identity:role");
      return options.primary === false ? { kind: "not-primary", primary: "p0" } : { kind: "taken", epoch: 3 };
    },
    openIdentityStore(epoch, identityHooks): IdentityStoreHandle {
      events.push(`identity:store(${epoch})`);
      hooks.identity = identityHooks;
      return identityStore;
    },
    securityJournal(journalHooks) {
      hooks.journal = journalHooks;
      return createMemorySecurityJournal();
    },
    async openLedger({ relayer, onFenced }) {
      events.push("ledger:open");
      hooks.ledger = onFenced;
      return Object.assign(createMemorySigningJournal(), { relayer });
    },
    async takeRelayerRole(w): Promise<RelayerTakeover> {
      events.push("relayer:take");
      const answer = relayerAnswers.shift() ?? "taken";
      if (answer === "throws") throw new Error("RelayerRoleUnknownError: the mirror's outcome is unknown (injected)");
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
      events.push("stores");
      hooks.relayerView = relayerRole;
      const intents = createMemoryChainIntentStore();
      return {
        fence: w.fence,
        log: control.store,
        readLog: async (gameId) => control.logs.get(gameId) ?? [],
        readDeal: async () => ({ kind: "undealt" }),
        readLogFormat: async () => "current",
        records,
        holds: createMemoryHoldStore(),
        financial,
        tickets: createMemoryWalletTicketStore(),
        intents: relayQueue === null ? null : intents,
        relayerIntents: relayQueue === null || relayerRole === null ? null : intents,
      };
    },
    ownership(_w, { onClaimed }) {
      events.push("ownership");
      const claim = ownership.claim.bind(ownership);
      return {
        ...ownership,
        async claim(gameId) {
          const answer = await claim(gameId);
          if (onClaimed !== undefined) await onClaimed(gameId);
          return answer;
        },
      };
    },
    kms(region) {
      events.push(`kms(${region})`);
      return kms.port;
    },
  };

  const openBackend = async (deps: JunoBackendDeps): Promise<JunoBackend> => {
    events.push("backend:open");
    hooks.backendDeps = deps;
    const before = lists;
    const gate = options.chainGate;
    const rest =
      gate === undefined
        ? world.chain
        : (new Proxy(world.chain, {
            get(target, name, receiver) {
              const value = Reflect.get(target, name, receiver);
              if (typeof value !== "function") return value;
              return async (...args: unknown[]) => {
                hooks.chainCalls += 1;
                await gate;
                return (value as (...a: unknown[]) => unknown).apply(target, args);
              };
            },
          }) as typeof world.chain);
    const backend = await openJunoBackend({ ...deps, rest, verifyEveryMs: 60_000 });
    hooks.listCallsAtOpen = { before, after: lists };
    const start = backend.start.bind(backend);
    const relayerLoad = backend.relayer.load.bind(backend.relayer);
    backend.relayer.load = async () => {
      events.push("relayer:load");
      hooks.authorityAtLoad.push(deps.relayerAuthority?.current() ?? false);
      return relayerLoad();
    };
    return Object.assign(backend, {
      start: async () => {
        events.push("backend:start");
        return start();
      },
    });
  };

  const input = (over: Partial<AwsRuntimeInput<FakeWriter, Ledger>> = {}): AwsRuntimeInput<FakeWriter, Ledger> => ({
    config: options.escrow === true ? parseAwsRuntimeConfig(runtimeDoc({ escrow: { config_parameter_arn: ESCROW_PARAM } })) : CONFIG,
    escrowConfig: options.escrow === true ? escrowConfig() : null,
    server: { mode: "production", allowedOrigins: ["https://play.example"], trustedProxyHops: 1 },
    build: "l5-7-test",
    port: 0,
    bindHost: "127.0.0.1",
    moneySwitch: undefined,
    task: "t-l57test",
    substrate,
    ops,
    now: () => Date.now(),
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
    exit: (code) => exits.push(code),
    timing: { sweepEveryMs: 3_600_000, sweepRetryMs: 5, relayerRetryMs: 3_600_000, failFastDelayMs: 5, drainEscrowMs: 500, drainOwnershipMs: 500, drainChainFactsMs: 500, drainIdentityMs: 2_000 },
    openJunoBackend: openBackend,
    ...over,
  });

  return {
    events,
    exits,
    lines,
    ops,
    control,
    records,
    financial,
    world,
    kms,
    hooks,
    writer: () => {
      if (writer === null) throw new Error("no pool writer was taken");
      return writer;
    },
    input,
    start: (over) => startAwsRuntime(input(over)),
  };
}

const portOf = (runtime: AwsRuntime): number => {
  const address = runtime.http.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

async function listening(runtime: AwsRuntime): Promise<number> {
  if (!runtime.http.listening) await new Promise((resolve) => runtime.http.once("listening", resolve));
  return portOf(runtime);
}

function get(port: number, pathname: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method, timeout: 2_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function until(predicate: () => boolean, label: string, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const before = (events: readonly string[], a: string, b: string) => {
  const i = events.indexOf(a);
  const j = events.indexOf(b);
  assert.ok(i >= 0, `${a} happened (${events.join(" > ")})`);
  assert.ok(j >= 0, `${b} happened (${events.join(" > ")})`);
  assert.ok(i < j, `${a} before ${b} (${events.join(" > ")})`);
};

async function closed(runtime: AwsRuntime): Promise<void> {
  if (runtime.server !== null) await runtime.server.close().catch(() => undefined);
  else await new Promise<void>((resolve) => runtime.http.close(() => resolve()));
}

/* ==================================================================
    STARTUP ORDER
   ================================================================== */
describe("L5-7 startup: the one order", () => {
  test("the generation is checked before the pool; the pool writer is taken FIRST, started and watching the generation, before any role or store", async () => {
    const h = harness();
    const runtime = await h.start();
    try {
      assert.deepEqual(h.events.slice(0, 5), ["generation:read", "pool:take", "writer:start", "writer:watch-generation", "identity:role"]);
      assert.equal(runtime.role, "primary");
      assert.ok(h.writer().generation !== null, "the generation is under the self-check");
      assert.deepEqual(runtime.steps.slice(0, 5), ["config", "generation", "pool", "identity-writer", "identity-loaded"]);
    } finally {
      await runtime.shutdown();
    }
  });

  test("AWS mode cannot start if the PoolWriter takeover fails: refused (exit 2 by the caller), and nothing else runs", async () => {
    const h = harness({ poolFails: true });
    await assert.rejects(h.start(), (error: unknown) => error instanceof AwsStartupError && /pool p1 was not taken/.test(error.message) && /serves nothing/.test(error.message));
    assert.deepEqual(h.events, ["generation:read", "pool:take"], "no role, no store, no server");
    assert.deepEqual(h.exits, [], "a refusal is the caller's exit 2, never a loss's exit 3");
  });

  test("a generation that is not the configured one, missing, or unreadable refuses the start BEFORE the pool is taken (a mis-pointed task fences nobody)", async () => {
    for (const [adopted, pattern] of [
      [2, /adopted app generation is 2, not this task's 1/],
      [null, /no adopted app generation/],
      ["throws", /could not be read/],
    ] as const) {
      const h = harness({ adopted });
      await assert.rejects(h.start(), (error: unknown) => error instanceof AwsStartupError && pattern.test(error.message), String(adopted));
      assert.deepEqual(h.events, ["generation:read"], `nothing after the check (${String(adopted)})`);
    }
  });

  test("the identity-writer role is taken BEFORE the identity store is made for its epoch, and the store is loaded only after that", async () => {
    const h = harness();
    const runtime = await h.start();
    try {
      before(h.events, "identity:role", "identity:store(3)");
      before(h.events, "identity:store(3)", "identity:load");
      assert.ok(runtime.identity !== null);
      /* The store's fence and restart hooks are the runtime's: loss (exit 3) and fail-fast (exit 4). */
      assert.ok(h.hooks.identity !== undefined && h.hooks.journal !== undefined);
    } finally {
      await runtime.shutdown();
    }
  });

  test("a NON-primary task becomes a standby: no identity writer store, no ledger, no relayer, no stores, no claims; /gs/readyz 503 not-primary; no socket is accepted", async () => {
    const h = harness({ primary: false, escrow: true });
    const runtime = await h.start();
    try {
      assert.equal(runtime.role, "standby");
      assert.deepEqual(h.events.filter((event) => !event.startsWith("writer:")), ["generation:read", "pool:take", "identity:role"], "nothing after the routing answered not-primary");
      assert.equal(runtime.identity, null);
      assert.equal(runtime.server, null);
      assert.equal(await runtime.sweepNow(), null, "a standby claims nothing");
      const port = await listening(runtime);
      const ready = await get(port, "/gs/readyz");
      assert.equal(ready.status, 503);
      const body = JSON.parse(ready.body);
      assert.equal(body.ready, false);
      assert.ok(body.reasons.includes("not-primary"));
      assert.equal(body.identity_writer, "not-primary");
      assert.equal((await get(port, "/gs/healthz")).status, 200, "liveness is unchanged");
      assert.equal((await get(port, "/gs")).status, 503, "no player is served");
      /* An upgrade is refused: the socket is closed without a 101. */
      const upgraded = await new Promise<number | "closed">((resolve) => {
        const request = http.request({ host: "127.0.0.1", port, path: "/gs", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
        request.on("upgrade", () => resolve(101));
        request.on("response", (response) => resolve(response.statusCode ?? 0));
        request.on("error", () => resolve("closed"));
        request.end();
      });
      assert.notEqual(upgraded, 101);
    } finally {
      await runtime.shutdown();
    }
  });

  test("every game store is built with the pool writer's fence; the claim is a game's FIRST step, before its log is read", async () => {
    const h = harness();
    const runtime = await h.start();
    try {
      const fence = runtime.status() as { aws: { pool: string; epoch: number } };
      assert.equal(fence.aws.epoch, 7);
      assert.ok(h.events.includes("stores"));
      before(h.events, "pool:take", "stores");
      /* A dealt game, loaded the way a player's hello or the sweep's hand-on loads it. */
      const gameId = await seedGame(h.records, [ALICE, BOB], { dealt: true });
      h.control.logs.set(gameId, storedLog(0));
      h.events.length = 0;
      await runtime.server!.lifecycle.loadGame(gameId);
      before(h.events, `claim:${gameId}`, `log:load:${gameId}`);
    } finally {
      await runtime.shutdown();
    }
  });

  test("the first money claim sweep COMPLETES before the task is ready; a failed pass is tried again (never skipped)", async () => {
    const h = harness({ sweepThrows: 2 });
    const runtime = await h.start();
    try {
      assert.equal(h.events.filter((event) => event === "sweep").length, 3, "two failed passes, then one that completed");
      const ready = runtime.steps.indexOf("ready");
      assert.ok(runtime.steps.indexOf("money-sweep") >= 0 && runtime.steps.indexOf("money-sweep") < ready);
      assert.ok(h.lines.some((line) => /money claim sweep \(startup\) FAILED/.test(line)));
      assert.equal(runtime.readiness().ready, true);
    } finally {
      await runtime.shutdown();
    }
  });
});

/* ==================================================================
    ESCROW, KMS AND THE RELAYER ROLE (the real Juno backend on the offline chain)
   ================================================================== */
describe("L5-7 escrow: the ledger, the relayer role, KMS and the order around the backend", () => {
  test("the ledger and the relayer role come after the identity writer and before the backend; the backend is built WITHOUT a preload; the sweep precedes its start; the relayer loads after its takeover", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    try {
      await until(() => runtime.steps.includes("escrow-started"), "the backend's start");
      await until(() => h.events.includes("relayer:load"), "the relayer's load");
      const e = h.events;
      before(e, "identity:load", "ledger:open");
      before(e, "ledger:open", "relayer:take");
      before(e, "relayer:take", "stores");
      before(e, "stores", "backend:open");
      before(e, "backend:open", "ownership");
      before(e, "sweep", "backend:start");
      before(e, "backend:start", "relayer:load");
      assert.equal(h.hooks.backendDeps?.preload, false, "POOL mode passes preload: false");
      assert.deepEqual(h.hooks.listCallsAtOpen && h.hooks.listCallsAtOpen.after - h.hooks.listCallsAtOpen.before, 0, "constructing the backend read no financial record: escrow.preload() never ran");
      assert.ok(h.hooks.backendDeps?.relayerAuthority !== undefined && h.hooks.backendDeps?.relayerIntents !== undefined, "both relayer options, together");
      assert.equal(runtime.backend?.state(), "active", "verified on the offline chain, then loaded");
      assert.equal((runtime.status() as { aws: { relayer: { state: string } } }).aws.relayer.state, "held");
      assert.equal(runtime.readiness().detail.relayer, "held");
    } finally {
      await runtime.shutdown();
    }
  });

  test("production KMS keys OPEN in AWS mode (no 'no KMS client is wired'): each public key read by its ARN in the configured region, checked against the configuration", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    try {
      assert.ok(h.events.includes("kms(us-east-1)"), "the configuration's one KMS region");
      assert.deepEqual(h.kms.calls.filter((call) => call.startsWith("GetPublicKey")).sort(), [`GetPublicKey ${ADMISSION_KEY}`, `GetPublicKey ${RELAYER_KEY}`, `GetPublicKey ${SETTLEMENT_KEY}`].sort());
      assert.ok(h.hooks.backendDeps?.kms !== undefined && h.hooks.backendDeps.kms !== h.kms.port, "the backend signs through the gated port, not the raw one");
    } finally {
      await runtime.shutdown();
    }
  });

  test("every KMS Sign passes the pool writer's side-effect gate first; a withheld Sign never reaches KMS and is `unavailable` with no possible signature", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    try {
      const kms = h.hooks.backendDeps!.kms!;
      const digest = Buffer.alloc(32, 7);
      const gatesBefore = h.writer().gateCalls;
      const signed = await kms.signDigest(SETTLEMENT_KEY, digest);
      assert.ok(signed.length > 60, "a DER signature");
      assert.equal(h.writer().gateCalls, gatesBefore + 1, "the gate ran before the Sign");
      h.writer().gate = async () => {
        throw new PoolWriterNotCurrentError("could not be shown current just now (injected)", false);
      };
      const signsBefore = h.kms.calls.filter((call) => call.startsWith("Sign")).length;
      await assert.rejects(kms.signDigest(ADMISSION_KEY, digest), (error: unknown) => error instanceof SignerError && error.code === "unavailable" && error.detail.signatureMayExist === false);
      assert.equal(h.kms.calls.filter((call) => call.startsWith("Sign")).length, signsBefore, "KMS was never asked");
      assert.equal((runtime.status() as { aws: { kms: { withheld: number } } }).aws.kms.withheld, 1);
    } finally {
      h.writer().gate = async () => undefined;
      await runtime.shutdown();
    }
  });

  test("a relayer takeover that failed leaves NO relayer authority; it is retried only once the backend is active, and the role is published only after the relayer's load", async () => {
    const h = harness({ escrow: true, relayer: ["throws"] });
    const runtime = await h.start();
    try {
      const authority = h.hooks.backendDeps!.relayerAuthority!;
      assert.equal(authority.current(), false, "no authority: the relayer runs no pass");
      await assert.rejects(authority.beforeSideEffect("sign"), PoolWriterNotCurrentError);
      assert.throws(() => h.hooks.relayerView!.fence(), /holds no relayer role/, "the relayer's view writes nothing without a role");
      assert.match(h.lines.join("\n"), /relayer role NOT taken \(startup\)/);
      await until(() => runtime.backend?.state() === "active", "the backend active");
      const loadsBefore = h.events.filter((event) => event === "relayer:load").length;
      assert.equal(await runtime.retryRelayerRole(), true);
      const takes = h.events.lastIndexOf("relayer:take");
      const load = h.events.lastIndexOf("relayer:load");
      assert.ok(takes >= 0 && load > takes, "the relayer loaded AFTER the retry's takeover");
      assert.equal(h.events.filter((event) => event === "relayer:load").length, loadsBefore + 1);
      assert.equal(authority.current(), true, "published after its load");
      assert.equal(h.hooks.authorityAtLoad.at(-1), false, "while the retry's load ran, the relayer had NO authority (no pass could run on a guard computed before the takeover)");
      await runtime.shutdown();
      assert.equal(await runtime.retryRelayerRole(), false, "no relayer work once stopping");
      assert.doesNotThrow(() => h.hooks.relayerView!.fence());
    } finally {
      await runtime.shutdown();
    }
  });

  test("the relayer retry does nothing while the backend is not active (its own load has not run yet)", async () => {
    const h = harness({ escrow: true, relayer: ["throws"] });
    h.world.chain.unavailable = true; // the chain unreachable: the backend stays unverified
    const runtime = await h.start();
    try {
      await until(() => runtime.steps.includes("escrow-started"), "the backend's start attempt");
      assert.notEqual(runtime.backend?.state(), "active");
      const takes = h.events.filter((event) => event === "relayer:take").length;
      assert.equal(await runtime.retryRelayerRole(), false);
      assert.equal(h.events.filter((event) => event === "relayer:take").length, takes, "no takeover while the backend is not active");
    } finally {
      await runtime.shutdown();
    }
  });
});

/* ==================================================================
    READINESS
   ================================================================== */
describe("L5-7 readiness: /gs/readyz follows the pool writer, not HTTP", () => {
  test("ready only while the pool writer is current and freshly checked; unknown -> 503 pool-writer-unconfirmed; lost -> 503; /gs/healthz stays 200 throughout", async () => {
    const h = harness();
    const runtime = await h.start();
    try {
      const port = await listening(runtime);
      let ready = await get(port, "/gs/readyz");
      assert.equal(ready.status, 200, ready.body);
      const body = JSON.parse(ready.body);
      assert.deepEqual(body.reasons, []);
      assert.equal(body.pool, "p1");
      assert.equal(body.epoch, 7);
      h.writer().ready = false; // a self-check that could not tell: the last good check ages
      ready = await get(port, "/gs/readyz");
      assert.equal(ready.status, 503);
      assert.deepEqual(JSON.parse(ready.body).reasons, ["pool-writer-unconfirmed"]);
      assert.equal((await get(port, "/gs/readyz", "HEAD")).status, 503);
      assert.equal((await get(port, "/gs/healthz")).status, 200, "liveness is not readiness");
      h.writer().ready = true;
      assert.equal((await get(port, "/gs/readyz")).status, 200);
      assert.equal((await get(port, "/gs/readyz", "POST")).status, 405);
      h.writer().markLost("a newer task took pool p1 (injected)");
      ready = await get(port, "/gs/readyz");
      assert.equal(ready.status, 503);
      assert.ok(JSON.parse(ready.body).reasons.includes("pool-writer-lost"));
      assert.equal((await get(port, "/gs/healthz")).status, 200);
    } finally {
      await closed(runtime);
    }
  });

  test("the public body carries only fixed codes and ids -- no error text, table, ARN or account", async () => {
    const h = harness({ escrow: true, relayer: ["throws"] });
    const runtime = await h.start();
    try {
      const port = await listening(runtime);
      h.writer().ready = false;
      const text = (await get(port, "/gs/readyz")).body;
      for (const leak of ["arn:", "210987654321", "gs-test", "Error", "injected", "juno1"]) assert.ok(!text.includes(leak), `${leak} not in ${text}`);
    } finally {
      h.writer().ready = true;
      await runtime.shutdown();
    }
  });
});

/* ==================================================================
    LOSS AND FAIL-FAST
   ================================================================== */
describe("L5-7 loss: exit 3 at once, never a graceful drain", () => {
  test("the pool writer's loss exits 3, stops the periodic work and the relayer, serves no more (a later shutdown does nothing)", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    try {
      await until(() => runtime.steps.includes("escrow-started"), "the backend's start");
      h.writer().markLost("pool p1 is at epoch 8 (t-newer), not this task's 7");
      assert.deepEqual(h.exits, [3]);
      assert.equal(runtime.readiness().ready, false);
      assert.ok(runtime.readiness().reasons.includes("lost"));
      assert.equal(await runtime.sweepNow(), null, "no more sweeps");
      assert.equal(await runtime.retryRelayerRole(), false, "no more relayer work");
      assert.equal(h.hooks.backendDeps!.relayerAuthority!.current(), false, "the relayer's authority is gone with the pool");
      await runtime.shutdown();
      assert.deepEqual([...runtime.shutdownSteps], [], "no graceful drain after a loss");
      assert.ok(!h.events.includes("ownership:settled"));
      assert.ok(h.ops.lines.some((line) => line.event === "aws.task-lost"));
    } finally {
      await closed(runtime);
    }
  });

  test("the identity writer fenced, the security journal fenced, the ledger fenced: each is the pool writer's loss -> exit 3", async () => {
    for (const trip of ["identity", "journal", "ledger"] as const) {
      const h = harness({ escrow: true });
      const runtime = await h.start();
      try {
        if (trip === "identity") h.hooks.identity!.onFenced("the role is at epoch 4");
        if (trip === "journal") h.hooks.journal!.onFenced("APPGEN is 2");
        if (trip === "ledger") h.hooks.ledger!("relayer", "a newer relayer holds epoch 6");
        assert.equal(h.writer().lost !== null, true, trip);
        assert.deepEqual(h.exits, [3], trip);
      } finally {
        await closed(runtime);
      }
    }
  });

  test("a store that cannot settle a write (identity's onRestartRequired) is exit 4 after the short delay -- and never a graceful drain", async () => {
    const h = harness();
    const runtime = await h.start();
    try {
      h.hooks.identity!.onRestartRequired("a change applied in part");
      await until(() => h.exits.length > 0, "the exit");
      assert.deepEqual(h.exits, [4]);
      assert.ok(runtime.readiness().reasons.includes("store-uncertain"));
      await runtime.shutdown();
      assert.deepEqual([...runtime.shutdownSteps], []);
    } finally {
      await closed(runtime);
    }
  });
});

/* ==================================================================
    FORCED EXITS NEVER BECOME GRACEFUL (the review's M1 / L1 / L2)
   ================================================================== */
describe("L5-7 a forced exit keeps its code", () => {
  test("a store's restart request, then a stop: the task's exit code stays 4 (the caller exits with exitCode(), never 0)", async () => {
    const h = harness();
    const runtime = await h.start({ timing: { failFastDelayMs: 150 } });
    try {
      h.hooks.identity!.onRestartRequired("a change applied in part");
      assert.equal(runtime.exitCode(), 4);
      await runtime.shutdown(); // the SIGTERM that arrives inside the fail-fast window
      assert.deepEqual([...runtime.shutdownSteps], [], "no drain");
      assert.equal(runtime.exitCode(), 4, "awsMain's stop leaves the forced exit alone (it exits 0 only when exitCode() is null)");
      assert.deepEqual(h.exits, [], "the forced exit keeps its own timing: the queued frames go out first");
      await until(() => h.exits.length > 0, "the fail-fast exit");
      assert.deepEqual(h.exits, [4]);
    } finally {
      await closed(runtime);
    }
  });

  test("a loss DURING the graceful drain stops the drain at once; the exit is the loss's 3", async () => {
    const h = harness();
    const runtime = await h.start();
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const identity = runtime.identity!;
    let asked = false;
    identity.settled = () => {
      asked = true;
      return pending;
    };
    const done = runtime.shutdown();
    await until(() => asked, "the identity drain");
    h.writer().markLost("a newer task took pool p1 during the drain (injected)");
    release();
    await done;
    assert.deepEqual(h.exits, [3]);
    assert.equal(runtime.exitCode(), 3);
    assert.ok(!runtime.shutdownSteps.includes("identity-settled") && !runtime.shutdownSteps.includes("pool-writer-stopped"), "the drain stopped where the loss found it");
  });

  test("a store's restart request DURING the startup ends it with exit 4, never masked as a refusal's 2", async () => {
    const h = harness({ restartDuringIdentityLoad: true });
    await assert.rejects(h.start(), (error: unknown) => error instanceof AwsStartupError && error.exitCode === 4);
  });

  test("a stop asked for before the startup began takes NOTHING: no pool, no role (the serving task is never fenced by a task that is stopping)", async () => {
    const h = harness();
    await assert.rejects(h.start({ stopRequested: () => true }), (error: unknown) => error instanceof AwsStartupError && error.exitCode === 0);
    assert.deepEqual(h.events, [], "not even the generation was read");
  });

  test("a stop asked for while the startup is still sweeping ends the startup (exit 0: nothing was served)", async () => {
    const h = harness({ sweepThrows: 1_000_000 });
    let stop = false;
    const starting = h.start({ stopRequested: () => stop });
    await until(() => h.events.filter((event) => event === "sweep").length >= 2, "the startup sweep retrying");
    stop = true;
    await assert.rejects(starting, (error: unknown) => error instanceof AwsStartupError && error.exitCode === 0);
  });
});

/* ==================================================================
    GRACEFUL SHUTDOWN
   ================================================================== */
describe("L5-7 graceful shutdown", () => {
  test("a backend start still verifying when the stop comes is waited for and stopped again: nothing of it outlives the shutdown (the review's M2)", async () => {
    let open: () => void = () => undefined;
    const chainGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const h = harness({ escrow: true, chainGate });
    const runtime = await h.start();
    await until(() => h.hooks.chainCalls > 0, "the verification in flight");
    const done = runtime.shutdown();
    await until(() => runtime.shutdownSteps.includes("money-stopped"), "the shutdown reaching the backend");
    assert.ok(!runtime.shutdownSteps.includes("relayer-stopped"), "it waits for the start in flight");
    open();
    await done;
    assert.ok(runtime.steps.includes("escrow-started"), "the start finished inside the shutdown's bounded wait");
    const calls = h.hooks.chainCalls;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(h.hooks.chainCalls, calls, "no verification, load or retry timer after the shutdown");
    assert.equal(runtime.exitCode(), null);
  });

  test("a backend start still verifying past the shutdown's bounded wait neither loads nor installs its retry timer afterwards (the review's M2, beyond the bound)", async () => {
    let open: () => void = () => undefined;
    const chainGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const h = harness({ escrow: true, chainGate });
    const runtime = await h.start({ timing: { drainEscrowStartMs: 30 } });
    await until(() => h.hooks.chainCalls > 0, "the verification in flight");
    await runtime.shutdown();
    assert.ok(runtime.shutdownSteps.includes("ops-flushed"), "the shutdown finished without the start");
    assert.ok(h.lines.some((line) => /the escrow start in flight did not finish/.test(line)));
    open(); // the verification answers only now, after the shutdown
    await new Promise((resolve) => setTimeout(resolve, 200));
    const calls = h.hooks.chainCalls;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(h.hooks.chainCalls, calls, "no retry timer was installed after the stop");
    assert.notEqual(runtime.backend?.state(), "active", "the escrow load never ran after the stop");
    assert.ok(!h.events.includes("relayer:load"), "nor the relayer's");
  });

  test("the documented order; readiness 503 at once; it WAITS for identity.settled() before the pool writer stops", async () => {
    const h = harness({ escrow: true });
    const runtime = await h.start();
    await until(() => runtime.steps.includes("escrow-started"), "the backend's start");
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const identity = runtime.identity!;
    const settled = identity.settled.bind(identity);
    let asked = false;
    identity.settled = () => {
      asked = true;
      return pending.then(() => settled());
    };
    const done = runtime.shutdown();
    assert.equal(runtime.readiness().ready, false);
    assert.ok(runtime.readiness().reasons.includes("shutting-down"));
    await until(() => asked, "identity.settled() asked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(!runtime.shutdownSteps.includes("identity-settled") && !runtime.shutdownSteps.includes("pool-writer-stopped"), "still waiting for identity");
    release();
    await done;
    assert.deepEqual(
      [...runtime.shutdownSteps],
      ["readiness-503", "timers-stopped", "periodic-drained", "money-stopped", "relayer-stopped", "server-closed", "escrow-drained", "ownership-settled", "chain-facts-settled", "identity-settled", "pool-writer-stopped", "ops-flushed"],
    );
    assert.deepEqual(h.exits, [], "the caller exits 0 after it");
    before(h.events, "ownership:settled", "writer:stop");
  });
});

/* ==================================================================
    CONFIGURATION: FAIL CLOSED
   ================================================================== */
const PROD_ENV = { GS_STORAGE: "aws", GS_AWS_CONFIG_PARAMETER: RUNTIME_PARAM };

function parameters(values: Record<string, string>): ParameterSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(arn) {
      reads.push(arn);
      const value = values[arn];
      if (value === undefined) throw new ConfigSourceError(`the SSM parameter ${arn} could not be read (ParameterNotFound)`);
      return { value, version: 3, arn };
    },
  };
}

describe("L5-7 configuration: the references and the documents fail closed", () => {
  test("GS_STORAGE: absent is file (PROCESS mode, unchanged); file and aws are the only values; environment and flag must agree", () => {
    assert.deepEqual(storageKindOf([], {}), { ok: true, kind: "file" });
    assert.deepEqual(storageKindOf([], { GS_STORAGE: "file" }), { ok: true, kind: "file" });
    assert.deepEqual(storageKindOf(["--storage", "aws"], {}), { ok: true, kind: "aws" });
    assert.equal(storageKindOf([], { GS_STORAGE: "dynamo" }).ok, false);
    assert.equal(storageKindOf(["--storage=file"], { GS_STORAGE: "aws" }).ok, false);
  });

  test("the references: production only; no data directory, no escrow file, no credentials in the environment; the parameter ARN required and strict", () => {
    assert.equal(awsStartupReferences([], PROD_ENV, "production").ok, true);
    const refused = (env: Record<string, string>, argv: string[] = [], mode: "development" | "production" = "production") => {
      const answer = awsStartupReferences(argv, { ...PROD_ENV, ...env }, mode);
      assert.equal(answer.ok, false, JSON.stringify(env));
      return (answer as { reason: string }).reason;
    };
    assert.match(refused({}, [], "development"), /only with GS_MODE=production/);
    assert.match(refused({ DATA_DIR: "/data" }), /DATA_DIR/);
    assert.match(refused({}, ["--data", "/data"]), /DATA_DIR/);
    assert.match(refused({ ESCROW_JUNO_CONFIG: "/etc/juno.json" }), /ESCROW_JUNO_CONFIG/);
    const credentialReason = refused({ AWS_ACCESS_KEY_ID: "AKIACANARYCANARY0000", AWS_SECRET_ACCESS_KEY: "canary-secret-value-l57" });
    assert.match(credentialReason, /AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY are set/);
    assert.ok(!credentialReason.includes("canary") && !credentialReason.includes("AKIACANARY"), "a credential's VALUE is never in a message");
    assert.match(refused({ GS_AWS_CONFIG_PARAMETER: "" }), /GS_AWS_CONFIG_PARAMETER: the runtime configuration must be named by an SSM parameter ARN/);
    for (const bad of ["/gs/test/runtime", "arn:aws:ssm:us-east-1:123456789012:parameter/gs/test/runtime:3", "arn:aws:secretsmanager:us-east-1:123456789012:secret:x-abcdef", "arn:aws:ssm:gs-local:123456789012:parameter/x"]) {
      assert.match(refused({ GS_AWS_CONFIG_PARAMETER: bad }), /GS_AWS_CONFIG_PARAMETER/, bad);
    }
    assert.match(awsStartupReferences([], { GS_STORAGE: "aws" }, "production").ok ? "" : (awsStartupReferences([], { GS_STORAGE: "aws" }, "production") as { reason: string }).reason, /required/);
  });

  test("the runtime document: every field required, nothing unknown, every value checked -- a damaged document never starts a task", () => {
    assert.equal(CONFIG.pool, "p1");
    assert.equal(CONFIG.ledger.region, "us-east-1");
    const problems = (doc: unknown) => {
      try {
        parseAwsRuntimeConfig(doc);
        return "";
      } catch (error) {
        assert.ok(error instanceof AwsRuntimeConfigError, String(error));
        return error.message;
      }
    };
    assert.match(problems(runtimeDoc({ format: "18COSMOS/AWS-RUNTIME/v2" })), /format must be/);
    assert.match(problems(runtimeDoc({ extra: 1 })), /unknown field extra/);
    const { generation: _g, ...noGeneration } = runtimeDoc();
    assert.match(problems(noGeneration), /generation is required/);
    assert.match(problems(runtimeDoc({ region: "gs-local" })), /region must be an AWS region/);
    assert.match(problems(runtimeDoc({ pool: "op:run-1" })), /operator run/);
    assert.match(problems(runtimeDoc({ generation: 0 })), /generation/);
    assert.match(problems(runtimeDoc({ generation: 1.5 })), /generation/);
    assert.match(problems(runtimeDoc({ game_table: "gs-test-identity" })), /two tables/);
    assert.match(problems(runtimeDoc({ ledger_table_arn: "gs-test-ledger" })), /ledger_table_arn/);
    assert.match(problems(runtimeDoc({ ledger_table_arn: "arn:aws:dynamodb:us-east-1:210987654321:table/gs-test-game-g1" })), /must name the ledger/);
    assert.match(problems(runtimeDoc({ escrow: { config_parameter_arn: ESCROW_PARAM, file: "/x" } })), /unknown field escrow.file/);
    assert.match(problems(runtimeDoc({ escrow: "yes" })), /escrow must be null/);
    assert.throws(() => parseAwsRuntimeConfigText("{not json"), /not JSON/);
    assert.equal(parseAwsRuntimeConfig(runtimeDoc({ escrow: { config_parameter_arn: ESCROW_PARAM } })).escrow?.configParameter.region, "us-east-1");
  });

  test("the escrow configuration an AWS task runs: the SAME ledger, KMS keys only -- a file journal, another ledger or a development key is refused", async () => {
    const config = parseAwsRuntimeConfig(runtimeDoc({ escrow: { config_parameter_arn: ESCROW_PARAM } }));
    assert.deepEqual(checkEscrowConfigForAws(escrowConfig(), config), []);
    const other = parseJunoBackendConfig(escrowRaw({ journal: { kind: "dynamodb", table_arn: "arn:aws:dynamodb:us-east-1:210987654321:table/gs-other-ledger" } }), { serverMode: "production", dataDir: "/nonexistent" });
    assert.match(checkEscrowConfigForAws(other, config).join("; "), /one task, one ledger/);
    const file = parseJunoBackendConfig(escrowRaw({ journal: { kind: "file", dir: path.resolve("/journal") } }), { serverMode: "production", dataDir: "/nonexistent" });
    assert.match(checkEscrowConfigForAws(file, config).join("; "), /FILE signing journal/);
    /* Through the loader, from SSM: each refusal names the parameter and the problem. */
    const load = (escrowValue: string) =>
      loadAwsStartup({ argv: [], env: PROD_ENV, serverMode: "production", parameters: parameters({ [RUNTIME_PARAM]: JSON.stringify(runtimeDoc({ escrow: { config_parameter_arn: ESCROW_PARAM } })), [ESCROW_PARAM]: escrowValue }) });
    const startup = await load(JSON.stringify(escrowRaw()));
    assert.equal(startup.escrowConfig?.kmsRegion, "us-east-1");
    await assert.rejects(load(JSON.stringify(escrowRaw({ journal: { kind: "dynamodb", table_arn: "arn:aws:dynamodb:us-east-1:210987654321:table/gs-other-ledger" } }))), /cannot run on AWS storage -- .*one ledger/);
    await assert.rejects(
      load(JSON.stringify(escrowRaw({ relayer: { address: RELAYER_ADDRESS, signer: { kind: "development", key_file: "/keys/relayer.key" } } }))),
      /not usable -- .*development signer is refused in production/,
    );
    await assert.rejects(load("{"), /not usable -- it is not JSON/);
    await assert.rejects(load(JSON.stringify(escrowRaw({ settlement_key: { signer_key_id: 1, public_key_hex: publicKeyOf(SETTLEMENT_SECRET).toString("hex"), signer: { kind: "kms", key_ref: "arn:aws:kms:us-east-1:123456789012:alias/settle" } } }))), /ALIAS ARN/);
  });

  test("the loader: a missing or unreadable parameter, a damaged document -- refused with the reason; the runtime document is read from exactly the referenced ARN", async () => {
    await assert.rejects(loadAwsStartup({ argv: [], env: PROD_ENV, serverMode: "production", parameters: parameters({}) }), /runtime configuration .* is not usable -- .*ParameterNotFound/);
    await assert.rejects(loadAwsStartup({ argv: [], env: PROD_ENV, serverMode: "production", parameters: parameters({ [RUNTIME_PARAM]: JSON.stringify(runtimeDoc({ region: "nowhere" })) }) }), /region must be an AWS region/);
    const source = parameters({ [RUNTIME_PARAM]: JSON.stringify(runtimeDoc()) });
    const startup = await loadAwsStartup({ argv: [], env: PROD_ENV, serverMode: "production", parameters: source });
    assert.deepEqual(source.reads, [RUNTIME_PARAM], "no escrow: one parameter");
    assert.equal(startup.escrowConfig, null);
    assert.equal(startup.configVersion, 3);
    await assert.rejects(loadAwsStartup({ argv: [], env: { ...PROD_ENV, DATA_DIR: "/d" }, serverMode: "production", parameters: source }), /DATA_DIR/);
  });

  test("SSM: only a plain String parameter, named as asked, with a version -- a SecureString is refused (a secret never goes in the configuration)", async () => {
    const answer = (parameter: Record<string, unknown>) => ({ send: async () => ({ Parameter: parameter }) }) as never;
    const read = (parameter: Record<string, unknown>) => ssmParameterSource({ client: () => answer(parameter) }).read(RUNTIME_PARAM);
    const good = { Name: "/gs/test/runtime", ARN: RUNTIME_PARAM, Type: "String", Value: "{}", Version: 4 };
    assert.deepEqual(await read(good), { value: "{}", version: 4, arn: RUNTIME_PARAM });
    await assert.rejects(read({ ...good, Type: "SecureString", Value: "canary-l57-secure" }), (error: unknown) => error instanceof ConfigSourceError && /SecureString/.test(error.message) && !error.message.includes("canary"));
    await assert.rejects(read({ ...good, Type: "StringList" }), /not a plain String/);
    await assert.rejects(read({ ...good, ARN: "arn:aws:ssm:us-east-1:123456789012:parameter/other", Name: "/other" }), /names/);
    await assert.rejects(read({ ...good, Version: undefined }), /no version/);
    await assert.rejects(read({ ...good, Value: "x".repeat(9_000) }), /larger than/);
    await assert.rejects(ssmParameterSource({ client: () => ({ send: async () => Promise.reject(Object.assign(new Error("denied"), { name: "AccessDeniedException" })) }) as never }).read(RUNTIME_PARAM), /could not be read \(AccessDeniedException: denied\)/);
    await assert.rejects(ssmParameterSource().read("not-an-arn"), ConfigSourceError);
  });

  test("a secret never prints: its string, JSON and inspection forms are [secret]; Secrets Manager's value is read by its complete ARN into memory only", async () => {
    const CANARY = "canary-l57-secret-value-9f3c";
    const secret = new SecretValue(Buffer.from(CANARY));
    assert.equal(`${secret}`, "[secret]");
    assert.equal(JSON.stringify({ secret }), '{"secret":"[secret]"}');
    assert.equal(inspect({ secret }).includes(CANARY), false);
    assert.equal(secret.reveal(), CANARY);
    const arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:gs/test/rpc-key-AbCdEf";
    assert.ok(!("problem" in parseSecretArn(arn)));
    assert.ok("problem" in parseSecretArn("arn:aws:secretsmanager:us-east-1:123456789012:secret:gs/test/rpc-key"), "a partial ARN is refused");
    const source = secretsManagerSource({ client: () => ({ send: async () => ({ ARN: arn, SecretString: CANARY }) }) as never });
    const value = await source.read(arn);
    assert.equal(value.reveal(), CANARY);
    assert.ok(!inspect(value).includes(CANARY));
    await assert.rejects(secretsManagerSource({ client: () => ({ send: async () => ({ ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:other-AbCdEf", SecretString: CANARY }) }) as never }).read(arn), (error: unknown) => error instanceof ConfigSourceError && !error.message.includes(CANARY));
    assert.ok(!("problem" in parseSsmParameterArn(RUNTIME_PARAM)));
  });

  test("no secret, credential or configuration value appears in the startup lines, the audit lines, the status or /gs/readyz", async () => {
    const CANARY = "canary-l57-never-printed";
    const previous = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = CANARY; // were anything to print the environment, it would show here
    const h = harness({ escrow: true });
    const out: string[] = [];
    const ops = createConsoleOpsRecorder({ build: "b", task: "t-l57test", pool: "p1", now: () => 1, write: (line) => out.push(line) });
    const runtime = await h.start({ ops });
    try {
      await until(() => runtime.steps.includes("escrow-started"), "the backend's start");
      const port = await listening(runtime);
      const everything = [...h.lines, ...out, JSON.stringify(runtime.status()), (await get(port, "/gs/readyz")).body].join("\n");
      assert.ok(!everything.includes(CANARY));
      for (const secret of [RELAYER_SECRET, SETTLEMENT_SECRET, ADMISSION_SECRET]) assert.ok(!everything.includes(secret.toString("hex")), "no key material");
      assert.ok(out.some((line) => line.startsWith("AUDIT ") && line.includes('"aws.pool-taken"')), "audit lines go to stdout, prefixed");
    } finally {
      if (previous === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previous;
      await runtime.shutdown();
    }
  });
});

/* ==================================================================
    THE KMS GATE ALONE, AND PROCESS MODE
   ================================================================== */
describe("L5-7 the KMS gate and PROCESS mode", () => {
  test("the gate: the digest is copied before it waits; a KMS failure is counted by class; getPublicKey is never gated", async () => {
    let open: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      open = resolve;
    });
    const seen: Buffer[] = [];
    const lines: string[] = [];
    const kms: KmsClient = {
      getPublicKey: async () => spkiOf(SETTLEMENT_SECRET),
      signDigest: async (_ref, digest) => {
        seen.push(Buffer.from(digest));
        throw Object.assign(new Error("throttled"), { name: "KmsCallError", failure: "transient", signatureMayExist: false });
      },
    };
    let gates = 0;
    const gated = gatedKmsClient(kms, { gate: () => (gates += 1, waiting), now: () => 5, warn: (line) => lines.push(line) });
    await gated.client.getPublicKey(SETTLEMENT_KEY);
    assert.equal(gates, 0);
    const digest = Buffer.alloc(32, 1);
    const pending = gated.client.signDigest(SETTLEMENT_KEY, digest);
    digest.fill(9); // the caller's buffer changes while the gate waits
    open();
    await assert.rejects(pending, /throttled/);
    assert.deepEqual(seen[0], Buffer.alloc(32, 1), "KMS was asked for the bytes as they were when Sign was called");
    assert.equal(gated.counters.transient, 1);
    assert.equal(lines.length, 1, "the first failure of a class is said once");
  });

  test("PROCESS mode loads no AWS code: start.ts reads the storage mode from a module that imports nothing, and loads the AWS entry only for GS_STORAGE=aws", () => {
    const root = path.resolve(__dirname, "../../../../../src"); // dist/server/src/aws/runtime -> server/src
    const start = fs.readFileSync(path.join(root, "start.ts"), "utf8");
    const statics = [...start.matchAll(/^import[^;]*from\s+["']([^"']+)["'];?$/gm)].map((match) => match[1]);
    assert.ok(statics.includes("./aws/runtime/storageMode"));
    assert.ok(!statics.some((name) => /aws\/(runtime\/(awsMain|awsRuntime|awsSubstrate|runtimeConfig|configSource)|game|identity|ownership|ledger|kms|awsClients)/.test(name)), statics.join(", "));
    assert.match(start, /await import\("\.\/aws\/runtime\/awsMain"\)/);
    const storageMode = fs.readFileSync(path.join(root, "aws/runtime/storageMode.ts"), "utf8");
    assert.equal(/^import /m.test(storageMode), false, "storageMode.ts imports nothing");
  });
});
