// server/src/aws/runtime/awsRuntime.ts
//
// ==================================================================
//  LIVE-5 L5-7: THE AWS STORAGE MODE'S RUNTIME -- THE CERTIFIED L5-2 ... L5-6 SUBSTRATE, COMPOSED IN ITS ONE SAFE ORDER
// ==================================================================
//
// This module decides ORDER and REACTION; it builds nothing of its own. Every durable mechanism is the certified
// substrate's (`aws/game`, `aws/identity`, `aws/ledger`, `aws/kms`, `aws/ownership`), reached through the `AwsSubstrate`
// port (`awsSubstrate.ts` is the real one; the tests pass a scripted one and check the order). `start.ts` reaches it only
// with `GS_STORAGE=aws` (`awsMain.ts`); PROCESS mode never loads it.
//
// THE STARTUP ORDER (README §6-§7, preflight §13), each step only after the one before it succeeded:
//
//   1. config      the runtime document and the escrow configuration were read and checked (SSM; `awsMain.ts`), the
//                  clients made by `awsClients.ts` (explicit regions, the task role's credentials).
//      generation  the ledger's adopted app generation (APPGEN) must be the document's `generation`, AND (LIVE-6 L6-4) the
//                  game table's own marker (`SYSTEM/GENERATION`) must hold that same generation and name the document's
//                  table -- READ ONLY, before the pool is taken: a task pointed at a superseded, unadopted or unprepared
//                  game table must not fence the real one, and restored data of one generation is never served under
//                  signing authority of another. The configured generation is FIXED for the task's life: nothing here
//                  (or in the probe, the ledger or the SEC# journal) ever adopts a generation it merely read.
//   2. pool        `PoolWriter.take` -- from this write on every older task of the pool is fenced from every game this task
//                  claims. `onLost` is this runtime's loss (exit 3). Then `writer.start()` (the 2 s self-check) and
//                  `watchGeneration(generationProbe)`. Nothing Dynamo-backed does authoritative work before this.
//   3. identity    PRIMARY ONLY: `takeIdentityWriterRole` (routing hint -> the role's epoch with the routing and pool
//                  conditions inside its own transaction), THEN `createDynamoIdentityStore({ epoch })`, THEN the load --
//                  `IdentityService.open(store, { security: { journal, grants: store.grants } })`: the SEC# journal on the
//                  ledger (the adopted generation), the durable grants. Its `onFenced` (and the journal's) is the pool
//                  writer's loss; its `onRestartRequired` is `failFast` (exit 4), like every held store. `not-primary`: the
//                  task becomes a STANDBY (below) -- it never opens a writable identity copy.
//   4. relayer     PRIMARY ONLY, with escrow configured: the ledger opened for the relayer account with
//                  `onFenced: ledgerFencedHook(writer)`, then `takeRelayerRole(writer, { ledger, now })`. `taken`: the role
//                  is the relayer's authority. Anything else: NO relayer authority now (the relayer runs no pass, signs
//                  nothing, broadcasts nothing) and the takeover is retried every 30 s while the backend is active -- each
//                  retry mints anew; a role is published only after the relayer has loaded AFTER its takeover. A fence is
//                  never read back and passed as `held`.
//   5. stores      every L5-2 adapter built with `writer.fence` (the owner's intent store game-fenced; the relayer's view
//                  ROLE_RL-fenced, L5-6); the Juno backend CONSTRUCTED (its KMS keys opened through the pool writer's gate,
//                  `kmsGate.ts`; NO preload -- claim-time `refreshRoster` replaces it) but not started;
//                  `createPoolGameOwnership({ onClaimed: escrow.service.refreshRoster })`; the settlement coordinator;
//                  the real GameServer with that ownership (the claim is each load's first step, L5-3).
//   6. sweep       discovery (read-only in POOL mode), then the money claim sweep (`sweepMoneyClaims`, with the
//                  deployment's continuation verdict, `retakeResident`, `isResident`, `lifecycle.loadGame`) -- one pass that
//                  completes, BEFORE any escrow money work -- then every 60 s. The task is READY from here on.
//   7. escrow      `backend.start()`: the deployment verified, then the escrow load and the relayer's load (after the
//                  takeover, before any pass); then the settlement coordinator's startup walk, as in PROCESS mode.
//
// READINESS (`/gs/readyz`): ready only while serving (startup done, not stopping), the pool writer is not lost and has a
// good self-check younger than 25 s (an unknown read makes it lapse), this is the primary with identity loaded, and no
// store has asked for a restart. Liveness (`/gs/healthz`) is unchanged and separate. Financial activeness (the escrow
// state) and the relayer role are reported beside it, not part of it (preflight §13: separate flags).
//
// A NON-PRIMARY TASK (LIVE-6 L6-1; L5-7's standby): it holds its pool (so a newer task of the pool fences it and it exits),
// takes no role, opens no identity writer and no writable identity copy, opens no ledger, builds no store that writes,
// claims no game and does no money work. It SERVES what needs no write (`routerServer.ts`): sockets authenticated by the
// IDENTITY VERIFIER (strongly consistent reads of the durable identity records, `identity/verifier.ts`), and, for a game,
// LIVE-4's `route` frame to the pool that serves it (the owner from a strong read of the game's HEAD, the path from the
// trusted route table). Its `/gs/readyz` is 200 while its pool is held and freshly checked (it may be sent sockets: its
// load-balancer rule only ever sends it its own pool's path).
//
// ROUTING CHANGES (L6-1): every `routingWatchMs` (5 s) the task reads `SYSTEM/ROUTING` strongly. A PROVEN change of this
// task's serving role -- a well-formed routing naming THIS pool on a non-primary task (promotion), or ANOTHER pool on the
// primary (demotion) -- ends the task with the graceful shutdown and exit 5 (`EXIT_ROLE_CHANGED`): the restart re-decides
// the role through this one certified startup order, so a promoted task takes the identity-writer role (inside a
// transaction conditioned on the routing and its pool epoch) BEFORE it loads identity, and a demoted one comes back
// holding nothing. A routing that cannot be read, or names no pool, proves nothing: no reaction. (Demotion is also, as
// before, a loss: a newer primary's role takeover fences this task, exit 3.) The operator's flip procedure is L6-2's.
//
// LOSS IS FAIL-FAST, never a graceful shutdown: the pool writer's `onLost` (a newer task, a role taken, the generation
// moved, a pool fence refused by the table) stops every timer and the relayer at once and exits 3; a store that cannot
// settle a write exits 4 after 1.5 s (the frames already queued reach their tables). Neither waits for anything, and
// neither keeps serving.
//
// GRACEFUL SHUTDOWN (SIGTERM from ECS, SIGINT, the IPC `shutdown` message), in this order -- `shutdownSteps` records it:
//   1. readiness answers 503 `shutting-down` at once (the ALB stops sending players);
//   2. the periodic work stops: the money claim sweep, the relayer takeover retry, the liveness and chain sweeps -- and a
//      sweep or retry already in flight finishes (bounded) before anything it could touch closes;
//   3. no new money work: the money tables stop, the settlement coordinator stops;
//   4. the Juno backend stops -- the relayer's timer and the verification timer (no new pass, no new signature); a start
//      still verifying or loading is waited for (bounded) and stopped again, so nothing of it outlives this step;
//   5. the game server closes: sockets 1001, every actor closed, the identity write-behind flushed, HTTP closed;
//   6. the escrow service's in-flight jobs drain (bounded);
//   7. every claim and release asked of the ownership settles (bounded);
//   8. the chain-facts holds still being written finish (bounded);
//   9. `identity.settled()` -- every committed security change's confirmation appended (bounded);
//  10. the pool writer's self-check stops (it kept gating every side effect until here);
//  11. the audit lines are flushed; the caller exits 0.
// A loss or a restart request DURING the drain stops it at once, and the process ends with that exit (3 / 4) -- never 0
// (`exitCode()`). No release of the pool is needed: the replacement's takeover fences this task (preflight §13). An
// actor's write already in flight is not awaited (as in PROCESS mode): the fences make it land before the replacement's
// claim and load, or be refused.

import type { Server } from "http";

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { compatibilityKey, type DeploymentCapability } from "../../../../frontend/src/gameEngine/compat/deploymentCapability";
import type { GameIdentityFacts } from "../../../../frontend/src/gameEngine/compat/continuationIdentity";
import type { FormatFact } from "../../../../frontend/src/gameEngine/compat/continuationVerdict";
import type { ServerLogEntry } from "../../../../frontend/src/utils/roomSession";
import { APP_NAME } from "../../../../frontend/src/config";
import { listenForChainFacts } from "../../continuationWiring";
import type { ChainIntentStore } from "../../escrow/chainIntents";
import type { FinancialGameStore } from "../../escrow/financialGameStore";
import { openJunoBackend, type JunoBackend } from "../../escrow/juno/junoBackend";
import { pinOf, type JunoBackendConfig } from "../../escrow/juno/junoConfig";
import type { RelayerAuthority, RelayerSideEffect } from "../../escrow/juno/relayer";
import type { KmsClient } from "../../escrow/juno/signer";
import { moneyContinuationVerdict, THIS_DEPLOYMENT } from "../../escrow/moneyContinuation";
import { noMoneyServing } from "../../escrow/moneyServing";
import { createMoneyTables, MONEY_TABLES_SWITCH, type MoneyTables } from "../../escrow/moneyTables";
import { createSettlementCoordinator } from "../../escrow/settlementCoordinator";
import { serverPrefixReplay } from "../../escrow/settlementEvidence";
import type { InspectableSigningJournal } from "../../escrow/signingJournal";
import { createWalletTicketLedger, type WalletTicketStore } from "../../escrow/walletTickets";
import type { LogStore } from "../../fileLogStore";
import { createGameServer } from "../../gameServer";
import type { SensitiveAuthGrantStore } from "../../identity/grants";
import type { GsMode } from "../../identity/mode";
import type { SecurityEventJournal } from "../../identity/securityEvents";
import { IdentityService } from "../../identity/sessions";
import type { IdentityStore } from "../../identity/store";
import type { ReadinessAnswer } from "../../ingress/readiness";
import type { SessionVerifier } from "../../identity/verifier";
import { createRouterServer, type RouterServer } from "../../routerServer";
import { poolRoutes, type GameDirectory, type PoolRoutes } from "../../rooms/gameRoutes";
import type { GameRecord } from "../../rooms/gameRecord";
import { thisDeploymentCapability } from "../../deploymentCapability";
import type { OpsRecorder } from "../../persistence/opsRecorder";
import { seatOf } from "../../rooms/gameRecord";
import type { HoldStore } from "../../rooms/holdStore";
import type { RecordStore } from "../../rooms/recordStore";
import { NoMoneyRosterSource } from "../../rooms/roomService";
import type { WriterFence } from "../game/gameTable";
import { adoptionBindingProblem, generationMarkerProblem, type AdoptionBinding, type GenerationMarker } from "../game/generationMarker";
import type { OpenMoneyGames, PoolGameOwnership, SweepReport } from "../ownership/poolGameOwnership";
import type { HeldProbe, PoolWriter } from "../ownership/poolWriter";
import { ledgerFencedHook, NO_RELAYER_ROLE } from "../ownership/relayerRole";
import type { RoleTakeover } from "../ownership/roles";
import { gatedKmsClient, type KmsCounters } from "./kmsGate";
import type { AwsRuntimeConfig } from "./runtimeConfig";

export const EXIT_REFUSED = 2;
export const EXIT_LOST = 3;
export const EXIT_STORE_UNCERTAIN = 4;
/** LIVE-6 L6-1: the routing proved this task's serving role changed (promotion or demotion): restart into the new one. */
export const EXIT_ROLE_CHANGED = 5;

/** A startup that cannot go on: the caller prints it and exits with `exitCode` -- 2 (refused: ECS starts the task again),
 *  or the loss's 3 / the store's 4 when one ended the startup (never masked as a refusal), or 0 when a stop was asked for
 *  before the task served anything. */
export class AwsStartupError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_REFUSED,
  ) {
    super(message);
    this.name = "AwsStartupError";
  }
}

/* ------------------------------------------------------------------ */
/* The substrate port                                                  */
/* ------------------------------------------------------------------ */

/** What the runtime asks of the pool writer (the real one is L5-3's `PoolWriter`). */
export type PoolWriterPort = Pick<PoolWriter, "pool" | "task" | "epoch" | "fence" | "lost" | "markLost" | "start" | "stop" | "watchGeneration" | "beforeSideEffect" | "readiness">;

/** The relayer role as the runtime uses it (the real one is L5-6's `RelayerRole`). */
export interface RelayerRoleLike extends RelayerAuthority {
  readonly account: string;
  readonly epoch: number;
  intentFence(): TransactWriteItem;
  onIntentFenced(): void;
}

export type RelayerTakeover = { readonly kind: "taken"; readonly role: RelayerRoleLike } | { readonly kind: "not-primary"; readonly primary: string | null };

/** The relayer's view of the intents takes its role fence from here (L5-6 `createDynamoIntentStore({ relayerRole })`). */
export interface RelayerIntentView {
  readonly fence: () => TransactWriteItem;
  readonly onFenced: (detail: string) => void;
}

/** The identity writer's store (the real one is L5-4's `DynamoIdentityStore`). */
export type IdentityStoreHandle = IdentityStore & { readonly grants: SensitiveAuthGrantStore; health(): object };

/** Every game-table store of this task, each built with the pool writer's fence. */
export interface AwsGameStores {
  /** The fence every store here was built with (`writer.fence`). */
  readonly fence: WriterFence;
  /** The actors' log store. */
  readonly log: LogStore;
  /** The escrow's reads of a sealed game's log: a SEPARATE read-only instance (it never appends, and never touches the
   *  actors' instance's memory of what it validated). */
  readonly readLog: (gameId: string) => Promise<readonly ServerLogEntry[]>;
  /** The deal's identity and the log's format class, read-only from the stored lines (`dealIdentity.ts`'s readers). */
  readonly readDeal: (gameId: string) => Promise<GameIdentityFacts>;
  readonly readLogFormat: (gameId: string) => Promise<FormatFact>;
  readonly records: RecordStore;
  readonly holds: HoldStore;
  readonly financial: FinancialGameStore & OpenMoneyGames;
  readonly tickets: WalletTicketStore;
  /** The owner's intent store, game-fenced (null without escrow: there is no relay queue). */
  readonly intents: ChainIntentStore | null;
  /** The relayer's view, ROLE_RL-fenced (null without escrow). */
  readonly relayerIntents: ChainIntentStore | null;
}

export interface AwsSubstrate<W extends PoolWriterPort = PoolWriterPort, L extends InspectableSigningJournal = InspectableSigningJournal> {
  /** Step 1, read only: the ledger's adopted app generation (`null`: none adopted). */
  adoptedGeneration(): Promise<number | null>;
  /** Step 1, read only (LIVE-6 L6-4): the game table's `SYSTEM/GENERATION` marker (`null`: none). */
  tableGeneration(): Promise<GenerationMarker | null>;
  /** Step 1, read only (LIVE-6 L6-4): which table and restore APPGEN's adoption names (`null`: the bootstrap APPGEN). */
  adoptionBinding(): Promise<AdoptionBinding | null>;
  /** Step 2: take this task's pool (`PoolWriter.take`). Rejects when it was not taken. */
  takePool(options: { readonly task: string; readonly now: () => number; readonly onLost: (reason: string) => void; readonly warn: (line: string) => void }): Promise<W>;
  /** The adopted generation as a held probe (`generationProbe`). */
  generationProbe(): HeldProbe;
  /** Step 3: the identity-writer role (`takeIdentityWriterRole`). */
  takeIdentityWriterRole(writer: W): Promise<RoleTakeover>;
  /** Step 3: the identity writer's store for the role's epoch (`createDynamoIdentityStore`) -- only after the role. */
  openIdentityStore(epoch: number, hooks: { readonly onFenced: (detail: string) => void; readonly onRestartRequired: (detail: string) => void; readonly warn: (line: string) => void }): IdentityStoreHandle;
  /** Step 3: the SEC# journal on the ledger, under the adopted generation (`createDynamoSecurityJournal`). */
  securityJournal(hooks: { readonly onFenced: (detail: string) => void }): SecurityEventJournal;
  /** Step 4: the signing ledger for the relayer account (`openDynamoSigningLedger`). */
  openLedger(options: { readonly relayer: string; readonly onFenced: (which: "generation" | "relayer", detail: string) => void }): Promise<L>;
  /** Step 4: the relayer role (`takeRelayerRole`). */
  takeRelayerRole(writer: W, ledger: L): Promise<RelayerTakeover>;
  /** Step 5: every game-table store, with `writer.fence`. */
  gameStores(writer: W, options: { readonly relayQueue: string | null; readonly relayerRole: RelayerIntentView | null }): AwsGameStores;
  /** Step 5: per-game ownership (`createPoolGameOwnership`). */
  ownership(writer: W, options: { readonly onClaimed?: (gameId: string) => Promise<void>; readonly warn: (line: string) => void }): PoolGameOwnership;
  /** The KMS port for the configuration's one KMS region (`kmsDigestClient(createKmsClient(...))`). */
  kms(region: string): KmsClient;
  /** LIVE-6 L6-1: `SYSTEM/ROUTING`, strongly consistent (`readRouting`); `null`: none. Throws when unreadable. */
  readRouting(): Promise<{ readonly primary_pool: string } | null>;
  /** LIVE-6 L6-1, NON-PRIMARY ONLY: the identity verifier over the identity table (read-only; never the writer). */
  identityVerifier(): SessionVerifier;
  /** LIVE-6 L6-1, NON-PRIMARY ONLY: a game's owner, the primary pool, a game's record -- strong reads, nothing else. */
  gameDirectory(writer: W): RouterDirectory;
}

/** What a non-primary task reads to route a game (`aws/ownership/gameDirectory.ts`). */
export interface RouterDirectory extends GameDirectory {
  readonly records: { load(gameId: string): Promise<GameRecord | null> };
}

/* ------------------------------------------------------------------ */
/* The runtime                                                         */
/* ------------------------------------------------------------------ */

export interface AwsRuntimeTiming {
  readonly sweepEveryMs: number;
  /** While the startup's first sweep pass cannot complete (a read of FINKEYS failed), it is tried again this often. */
  readonly sweepRetryMs: number;
  readonly relayerRetryMs: number;
  readonly livenessEveryMs: number;
  readonly chainSweepEveryMs: number;
  readonly failFastDelayMs: number;
  readonly drainEscrowMs: number;
  readonly drainOwnershipMs: number;
  readonly drainChainFactsMs: number;
  readonly drainIdentityMs: number;
  /** The in-flight periodic work (a money claim sweep, a relayer-role retry) and the escrow start still verifying. */
  readonly drainPeriodicMs: number;
  readonly drainEscrowStartMs: number;
  /** LIVE-6 L6-1: how often `SYSTEM/ROUTING` is read for a change of this task's serving role. */
  readonly routingWatchMs: number;
}

/** The drains are bounded so the whole graceful stop fits Fargate's `stopTimeout` (120 s, L5-8). */
export const AWS_RUNTIME_TIMING: AwsRuntimeTiming = Object.freeze({
  sweepEveryMs: 60_000,
  sweepRetryMs: 5_000,
  relayerRetryMs: 30_000,
  livenessEveryMs: 5 * 60_000,
  chainSweepEveryMs: 5 * 60_000,
  failFastDelayMs: 1_500,
  drainEscrowMs: 20_000,
  drainOwnershipMs: 10_000,
  drainChainFactsMs: 5_000,
  drainIdentityMs: 60_000,
  drainPeriodicMs: 10_000,
  drainEscrowStartMs: 10_000,
  routingWatchMs: 5_000,
});

export interface AwsRuntimeInput<W extends PoolWriterPort, L extends InspectableSigningJournal> {
  readonly config: AwsRuntimeConfig;
  /** The Juno backend configuration (checked by `checkEscrowConfigForAws`), or null: no escrow. */
  readonly escrowConfig: JunoBackendConfig | null;
  readonly server: { readonly mode: GsMode; readonly allowedOrigins: readonly string[]; readonly trustedProxyHops: number };
  readonly build: string;
  readonly port: number;
  readonly bindHost: string;
  /** `ESCROW_MONEY_TABLES` (as in PROCESS mode). */
  readonly moneySwitch: string | undefined;
  /** This process's task id (random per process; diagnostic in the pool and role items). */
  readonly task: string;
  readonly substrate: AwsSubstrate<W, L>;
  readonly ops: OpsRecorder;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
  readonly error: (line: string) => void;
  /** The process's exit. The first call wins (the caller makes it idempotent). */
  readonly exit: (code: number) => void;
  readonly timing?: Partial<AwsRuntimeTiming>;
  /** A stop (SIGTERM...) was asked for while the task was still starting: the startup ends (exit 0: nothing was served). */
  readonly stopRequested?: () => boolean;
  /** Tests: the backend and server constructors (the real ones by default). */
  readonly openJunoBackend?: typeof openJunoBackend;
  readonly createGameServer?: typeof createGameServer;
  /** Tests: the ingress limits of the servers (the defaults in production). */
  readonly limits?: import("../../ingress/limits").IngressLimitOverrides;
}

export interface AwsRuntime {
  /** LIVE-6 L6-1: `non-primary` is L5-7's standby, now serving routes. */
  readonly role: "primary" | "non-primary";
  readonly task: string;
  /** The startup steps, in the order they happened (and, later, `escrow-started`). */
  readonly steps: readonly string[];
  /** The graceful shutdown's steps, in order (empty until one runs). */
  readonly shutdownSteps: readonly string[];
  readonly http: Server;
  /** The game server (null for a non-primary task). */
  readonly server: ReturnType<typeof createGameServer> | null;
  /** LIVE-6 L6-1: the non-primary task's server (null for the primary). */
  readonly router: RouterServer | null;
  readonly identity: IdentityService | null;
  readonly backend: JunoBackend | null;
  readiness(): ReadinessAnswer;
  /** One money claim sweep pass now (the timer's own; single-flight). `null`: it could not run or did not complete. */
  sweepNow(): Promise<SweepReport | null>;
  /** One relayer-role retry now (the timer's own). True: the role is held and published. */
  retryRelayerRole(): Promise<boolean>;
  /** The graceful shutdown (see the header); resolves when drained, then the caller exits with `exitCode()` (0). It never
   *  runs after a loss or a restart request, and it stops draining at once if one happens while it runs. */
  shutdown(): Promise<void>;
  /** The exit code this task must end with: null while nothing forced one; 3 after a loss, 4 after a store asked for a
   *  restart, 5 (L6-1) once the routing proved its serving role changed. The caller's exit after a graceful shutdown uses
   *  it (a forced exit never becomes 0). */
  exitCode(): number | null;
  /** LIVE-6 L6-1: one read of the routing for a change of this task's serving role now (the watch's own). */
  checkRouting(): Promise<void>;
  status(): Record<string, unknown>;
}

const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 400);

interface Timer {
  cancel(): void;
}

function every(ms: number, run: () => void): Timer {
  const handle = setInterval(run, ms);
  (handle as { unref?: () => void }).unref?.();
  return { cancel: () => clearInterval(handle) };
}

async function bounded(label: string, work: Promise<unknown> | undefined, ms: number, warn: (line: string) => void): Promise<boolean> {
  if (work === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const done = await Promise.race([
    work.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
  if (timer !== null) clearTimeout(timer);
  if (!done) warn(`  aws: shutdown -- ${label} did not finish within ${ms} ms; going on`);
  return done;
}

export async function startAwsRuntime<W extends PoolWriterPort, L extends InspectableSigningJournal>(input: AwsRuntimeInput<W, L>): Promise<AwsRuntime> {
  const { config, substrate, escrowConfig } = input;
  const timing: AwsRuntimeTiming = { ...AWS_RUNTIME_TIMING, ...(input.timing ?? {}) };
  const steps: string[] = [];
  const shutdownSteps: string[] = [];
  const timers: Timer[] = [];
  const step = (name: string, line?: string) => {
    steps.push(name);
    if (line !== undefined) input.log(`  aws: ${line}`);
  };

  let phase: "starting" | "serving" | "stopping" = "starting";
  /** Read through a function: the closures below must see the phase as it is when they run. */
  const isStopping = (): boolean => phase === "stopping";
  let terminal: null | "lost" | "uncertain" = null;
  /** LIVE-6 L6-1: the routing proved this task's serving role changed; the graceful shutdown runs, then exit 5. */
  let roleChanged: string | null = null;
  let writer: W | null = null;
  let backend: JunoBackend | null = null;
  let shutdownPromise: Promise<void> | null = null;
  /** The graceful shutdown of whichever server this task runs (set once it exists): what a role change runs. */
  let runtimeShutdown: () => Promise<void> = () => Promise.resolve();

  /** What a startup that ends early must close (the pool writer's self-check, the game server): run once. */
  const closers: Array<() => void> = [];
  const closeOpened = () => {
    for (const close of closers.splice(0).reverse()) {
      try {
        close();
      } catch {
        /* closing never throws past here */
      }
    }
  };
  const stopWork = () => {
    for (const timer of timers.splice(0)) timer.cancel();
    try {
      backend?.stop();
    } catch {
      /* stopping never throws past here */
    }
  };

  /** The pool writer's `onLost` (and every loss routed to it): FAIL-FAST, exit 3. */
  const lose = (reason: string) => {
    if (terminal !== null) return;
    terminal = "lost";
    input.error(
      `\nLOST: ${reason}\nThis task no longer holds its pool, a role it took, or its app generation. It stops at once -- no graceful drain, ` +
        `nothing more served from memory -- and exits (${EXIT_LOST}); its replacement takes over afresh.`,
    );
    input.ops.audit("aws.task-lost", { reason: reason.slice(0, 300) });
    stopWork();
    input.exit(EXIT_LOST);
  };

  /** A store that cannot settle a write (identity, a game store): exit 4 after the queued frames go out (PROCESS mode's rule). */
  const failFast = (where: string, detail: string) => {
    if (terminal !== null) return;
    terminal = "uncertain";
    input.error(
      `\nSTORE UNCERTAIN in ${where}: ${detail}\nThe server could not settle a write's outcome. It stops now rather than write anything behind it; ` +
        `its replacement loads what the tables really hold (exit ${EXIT_STORE_UNCERTAIN}).`,
    );
    input.ops.audit("aws.store-uncertain", { where, detail: detail.slice(0, 300) });
    stopWork();
    /* Not unref'd: this exit must happen, and at its own time (the queued frames first), whatever else is still open. */
    setTimeout(() => input.exit(EXIT_STORE_UNCERTAIN), timing.failFastDelayMs);
  };

  function refuse(message: string): never {
    stopWork();
    closeOpened();
    /* A loss or a restart request that came first keeps its code (3 / 4): a refusal never masks it as a 2. */
    throw new AwsStartupError(message, forcedExit() ?? EXIT_REFUSED);
  }
  const forcedExit = (): number | null => (terminal === "lost" ? EXIT_LOST : terminal === "uncertain" ? EXIT_STORE_UNCERTAIN : null);
  /** A loss (or a restart request) during startup ends it -- with ITS exit code, never masked as a refusal; so does a stop
   *  asked for before the task served anything (exit 0). */
  const assertAlive = (): void => {
    const forced = forcedExit();
    const stop = input.stopRequested?.() === true;
    if (forced === null && !stop) return;
    stopWork();
    closeOpened();
    if (forced !== null) throw new AwsStartupError(`the task ${terminal === "lost" ? "was lost" : "must restart"} during its startup`, forced);
    throw new AwsStartupError("a stop was asked for during the startup; nothing was served", 0);
  };

  /* ---------------- 1. config, clients, generation ---------------- */
  step(
    "config",
    `${config.environment}: pool ${config.pool}, generation ${config.generation}, region ${config.region}; tables game ${config.gameTable}, identity ${config.identityTable}, ` +
      `ledger ${config.ledger.table} (account ${config.ledger.account}, ${config.ledger.region}); escrow ${escrowConfig === null ? "none (money games stay off)" : `${escrowConfig.chainId} (${escrowConfig.networkClass}), KMS keys in ${escrowConfig.kmsRegion ?? "?"}`}; task ${input.task}`,
  );
  /* LIVE-6 L6-1: the trusted route table (empty for a v1 document: no destination exists). */
  let routes: PoolRoutes;
  try {
    routes = poolRoutes(config.pool, config.routes);
  } catch (error) {
    return refuse(`the route table cannot be used (${describe(error)})`);
  }
  assertAlive(); // a stop asked for before anything was touched ends here
  let adopted: number | null;
  try {
    adopted = await substrate.adoptedGeneration();
  } catch (error) {
    return refuse(`the ledger's adopted app generation (APPGEN) could not be read (${describe(error)})`);
  }
  if (adopted === null) refuse("the ledger has no adopted app generation (APPGEN): an operator initialises it before the first start (L5-8 / runbook)");
  if (adopted !== config.generation) {
    refuse(`the ledger's adopted app generation is ${String(adopted)}, not this task's ${config.generation}: a task pointed at a superseded or unadopted game table does not start (it would fence nothing it may use)`);
  }
  /* LIVE-6 L6-4: the game table's own generation, the same number, naming this table -- still before the pool. */
  let marker: GenerationMarker | null;
  try {
    marker = await substrate.tableGeneration();
  } catch (error) {
    return refuse(`the game table's generation marker (SYSTEM/GENERATION) could not be read (${describe(error)})`);
  }
  const markerProblem = generationMarkerProblem(marker, { generation: config.generation, gameTable: config.gameTable });
  if (markerProblem !== null) refuse(`${markerProblem}: a task never serves one generation's game data under another's signing authority`);
  /* ... and the ledger ADOPTED this very table (several copies may be prepared as one generation; one is adopted). */
  let binding: AdoptionBinding | null;
  try {
    binding = await substrate.adoptionBinding();
  } catch (error) {
    return refuse(`the ledger's APPGEN adoption could not be read (${describe(error)})`);
  }
  const bindingProblem = adoptionBindingProblem(marker as GenerationMarker, binding);
  if (bindingProblem !== null) refuse(`${bindingProblem}; this task serves nothing`);
  step("generation", `the ledger's adopted app generation is ${config.generation}, as configured, and the game table ${config.gameTable} holds that generation (${(marker as GenerationMarker).origin})`);
  /* LIVE-6 L6-2: the post-restore safe mode's signal (L6-4 §12.2: the marker's `origin: restore`). */
  const restoredTable = (marker as GenerationMarker).origin === "restore";
  if (restoredTable) input.ops.audit("aws.restore-safe-mode", { generation: config.generation, restore_id: (marker as GenerationMarker).restore_id });

  /* ---------------- 2. the pool writer FIRST ---------------- */
  assertAlive(); // never take the pool (fencing the serving task) for a task that is already asked to stop
  try {
    writer = await substrate.takePool({ task: input.task, now: input.now, onLost: lose, warn: input.warn });
  } catch (error) {
    return refuse(`pool ${config.pool} was not taken (${describe(error)}); this task serves nothing`);
  }
  const w: W = writer;
  w.start();
  closers.push(() => w.stop());
  w.watchGeneration(substrate.generationProbe());
  step("pool", `pool ${w.pool} TAKEN at epoch ${w.epoch} by task ${w.task}: every older task of the pool is fenced from every game this task claims; self-check every 2 s (the pool, each held role, the generation)`);
  input.ops.audit("aws.pool-taken", { pool: w.pool, epoch: w.epoch });

  /* ---------------- 3. the identity writer (primary only), THEN its store, THEN the load ---------------- */
  let identityRole: RoleTakeover;
  assertAlive();
  try {
    identityRole = await substrate.takeIdentityWriterRole(w);
  } catch (error) {
    assertAlive();
    return refuse(`the identity-writer role was neither taken nor explained (${describe(error)})`);
  }
  assertAlive();

  if (identityRole.kind === "not-primary") {
    return startNonPrimary(identityRole.primary);
  }
  step("identity-writer", `identity-writer role TAKEN at epoch ${identityRole.epoch} (this pool is primary); a newer primary's takeover makes this task lost`);
  input.ops.audit("aws.identity-writer", { epoch: identityRole.epoch });
  const identityStore = substrate.openIdentityStore(identityRole.epoch, {
    onFenced: (detail) => w.markLost(`the identity-writer role was taken over (${detail})`),
    onRestartRequired: (detail) => failFast("the identity store", detail),
    warn: input.warn,
  });
  let identity: IdentityService;
  try {
    identity = await IdentityService.open(identityStore, {
      security: {
        journal: substrate.securityJournal({ onFenced: (detail) => w.markLost(`the security-event journal was refused: the adopted generation moved (${detail})`) }),
        grants: identityStore.grants,
      },
    });
  } catch (error) {
    assertAlive();
    return refuse(`identity could not be loaded (${describe(error)})`);
  }
  assertAlive();
  const sizes = identity.sizes();
  step("identity-loaded", `identity LOADED after the role (${sizes.principals} principals, ${sizes.profiles} profiles, ${sizes.sessions} sessions, ${sizes.grants} live grants); security events journal-first on the ledger`);

  /* ---------------- 4. the relayer role (primary only, with escrow), after the identity writer ---------------- */
  let ledger: L | null = null;
  const relayer: { role: RelayerRoleLike | null; published: boolean; state: string; retrying: Promise<boolean> | null } = { role: null, published: false, state: escrowConfig === null ? "not-configured" : "not-taken", retrying: null };
  const takeRelayer = async (when: "startup" | "retry"): Promise<RelayerRoleLike | null> => {
    if (ledger === null) return null;
    try {
      const answer = await substrate.takeRelayerRole(w, ledger);
      if (answer.kind === "taken") {
        relayer.state = "held";
        input.log(`  aws: relayer role TAKEN at epoch ${answer.role.epoch} for ${answer.role.account} (${when}): the ledger's fence minted, then the game-table mirror; both watched by the self-check`);
        input.ops.audit("aws.relayer-role", { outcome: "taken", epoch: answer.role.epoch, when });
        return answer.role;
      }
      relayer.state = "not-primary";
      input.warn(`  aws: relayer role NOT taken (${when}): the routing names ${answer.primary ?? "no pool"} primary -- this task relays nothing`);
      input.ops.audit("aws.relayer-role", { outcome: "not-primary", when });
    } catch (error) {
      relayer.state = "not-taken";
      input.warn(`  aws: relayer role NOT taken (${when}) -- ${describe(error)}; no relayer authority now (no pass, no signature, no broadcast); tried again every ${Math.round(timing.relayerRetryMs / 1000)} s, each time a new mint`);
      input.ops.audit("aws.relayer-role", { outcome: "not-taken", when, error: (error as { name?: string } | null)?.name ?? "error" });
    }
    return null;
  };
  if (escrowConfig !== null) {
    try {
      ledger = await substrate.openLedger({ relayer: escrowConfig.relayer.address, onFenced: ledgerFencedHook(w) });
    } catch (error) {
      assertAlive();
      return refuse(`the signing ledger could not be opened (${describe(error)})`);
    }
    assertAlive();
    step("ledger", `signing ledger OPENED under generation ${config.generation} for relayer ${escrowConfig.relayer.address} (a refused fence is this task's loss)`);
    assertAlive();
    relayer.role = await takeRelayer("startup");
    assertAlive();
    /* Taken before the backend exists: its load (the relayer's, inside the escrow load) runs after the takeover. */
    relayer.published = relayer.role !== null;
    step("relayer-role");
  }
  /** The relayer's authority: the role this task holds and has PUBLISHED, else none (L5-6's `NO_RELAYER_ROLE`). */
  const authority: RelayerAuthority = {
    current: () => relayer.published && relayer.role !== null && relayer.role.current(),
    beforeSideEffect: (what: RelayerSideEffect) => (relayer.published && relayer.role !== null ? relayer.role.beforeSideEffect(what) : NO_RELAYER_ROLE.beforeSideEffect(what)),
  };
  const relayerView: RelayerIntentView | null =
    escrowConfig === null
      ? null
      : {
          fence: () => {
            if (!relayer.published || relayer.role === null) throw new Error("this task holds no relayer role: the relayer's view of the intents writes nothing");
            return relayer.role.intentFence();
          },
          onFenced: () => relayer.role?.onIntentFenced(),
        };

  /* ---------------- 5. the stores, the backend (constructed), ownership, the game server ---------------- */
  const stores = substrate.gameStores(w, { relayQueue: escrowConfig?.relayer.address ?? null, relayerRole: relayerView });
  step("stores", `game-table stores built with the pool writer's fence (pool ${stores.fence.pool}, epoch ${stores.fence.epoch})${escrowConfig === null ? "" : "; the owner's intent store game-fenced, the relayer's view ROLE_RL-fenced"}`);

  const serverRef: { current: ReturnType<typeof createGameServer> | null } = { current: null };
  const moneyRef: { current: MoneyTables | null } = { current: null };
  const ticketLedger = createWalletTicketLedger({
    store: stores.tickets,
    standing: (context) => identity.securityStanding(context),
    holdsSeat: (gameId, principalId, playerId) => {
      const record = serverRef.current?.lifecycle.financialRecords().find((entry) => entry.game_id === gameId);
      return record !== undefined && seatOf(record, principalId)?.player_id === playerId;
    },
    now: input.now,
  });

  let kms: { readonly client: KmsClient; readonly counters: Readonly<KmsCounters> } | null = null;
  if (escrowConfig !== null) {
    if (escrowConfig.kmsRegion === null) return refuse("the escrow configuration names no KMS region");
    /* The relayer's two options go together (L5-6): a substrate that gave either store as null is refused, never
       papered over (the backend would otherwise fall back to the game-fenced store while holding a role). */
    if (ledger === null || stores.intents === null || stores.relayerIntents === null) return refuse("the escrow's ledger, owner intent store and relayer view must all exist (the substrate gave none for at least one)");
    kms = gatedKmsClient(substrate.kms(escrowConfig.kmsRegion), { gate: () => w.beforeSideEffect(), now: input.now, warn: input.warn });
    identity.setHooks({
      onSecurityEvent: (event) => {
        void ticketLedger
          .gamesOfPrincipal(event.principalId)
          .then(async (games) => {
            for (const gameId of games) {
              const decided = await backend?.service.servingDecision(gameId, { where: "security event" }).catch(() => null);
              if (decided === undefined || decided === null || decided.verdict.kind !== "continues") continue;
              const ended = await ticketLedger.revokeForSecurityEvent(gameId);
              if (ended > 0) input.ops.audit("wallet-ticket.revoked", { game_id: gameId, kind: event.kind, tickets: ended });
            }
          })
          .catch(() => undefined)
          .finally(() => moneyRef.current?.onSecurityEvent(event.principalId));
      },
    });
    try {
      backend = await (input.openJunoBackend ?? openJunoBackend)({
        config: escrowConfig,
        serverMode: "production",
        financial: stores.financial,
        intents: stores.intents,
        journal: ledger,
        tickets: ticketLedger,
        readLog: stores.readLog,
        readDeal: stores.readDeal,
        readLogFormat: stores.readLogFormat,
        replay: serverPrefixReplay(input.build),
        now: input.now,
        warn: input.warn,
        log: input.log,
        ops: input.ops,
        walletProofs: ticketLedger,
        kms: kms.client,
        /* POOL mode: no startup preload -- each game's roster facts come from its claim's strong read (onClaimed). */
        preload: false,
        relayerAuthority: authority,
        relayerIntents: stores.relayerIntents,
        /* LIVE-6 L6-2: a RESTORED game table (its marker's origin, step 1) serves its money games read-only until each is
           verified in this process (F1 + the chain); the check re-runs at every start, so a restart never bypasses it. */
        ...(restoredTable ? { restoreSafeMode: true } : {}),
      });
    } catch (error) {
      assertAlive();
      return refuse(`the Juno backend could not be opened (${describe(error)})`);
    }
    assertAlive();
    step("escrow-backend", `Juno backend OPENED (KMS keys by ARN, public keys checked against the configuration; every Sign behind the pool writer's gate), NOT started; no roster preload (claim-time refresh)`);
  }
  const opened = backend;

  const ownership = substrate.ownership(w, {
    ...(opened !== null ? { onClaimed: (gameId: string) => opened.service.refreshRoster(gameId) } : {}),
    warn: input.warn,
  });
  step("ownership", "per-game ownership: every load claims its game FIRST (claim-time roster refresh); a routed game is not read");

  const settlement = createSettlementCoordinator({
    store: stores.financial,
    replay: serverPrefixReplay(input.build),
    now: input.now,
    warn: input.warn,
    ops: input.ops,
    serving: opened?.service.serving ?? noMoneyServing({ ops: input.ops, warn: input.warn }),
    readDeal: stores.readDeal,
    readLogFormat: stores.readLogFormat,
    ...(opened !== null ? { artifactFormats: (gameId, record) => opened.service.artifactFormatsOf(gameId, record) } : {}),
    ...(opened !== null ? { onIntentPrepared: (gameId: string) => opened.service.onIntentPrepared(gameId) } : {}),
  });
  try {
    await settlement.load();
  } catch (error) {
    assertAlive();
    return refuse(`the settlement index could not be read (${describe(error)})`);
  }
  const serving = settlement.serving;
  let capability: DeploymentCapability;
  try {
    capability = serving.capability;
    compatibilityKey(capability);
  } catch (error) {
    return refuse(`this server's deployment capability cannot be built (${describe(error)})`);
  }

  let initialSweepDone = false;
  let lastSweep: Record<string, string | number | null> | null = null;
  let sweepFailures = 0;

  const readiness = (): ReadinessAnswer => {
    const reasons: string[] = [];
    if (terminal === "lost") reasons.push("lost");
    if (terminal === "uncertain") reasons.push("store-uncertain");
    if (phase === "stopping") reasons.push("shutting-down");
    else if (phase === "starting") reasons.push("starting");
    const pool = w.readiness();
    if (pool.lost !== null) reasons.push("pool-writer-lost");
    else if (!pool.ready) reasons.push("pool-writer-unconfirmed");
    if (phase !== "stopping" && !initialSweepDone) reasons.push("money-sweep-pending");
    return {
      ready: reasons.length === 0,
      reasons: [...new Set(reasons)],
      detail: { role: "primary", pool: w.pool, epoch: w.epoch, identity_writer: "held", relayer: relayer.published ? "held" : relayer.state, escrow: opened?.state() ?? "not-configured" },
    };
  };

  const statusExtras = () => ({
    aws: {
      role: "primary",
      pool: w.pool,
      epoch: w.epoch,
      task: w.task,
      generation: config.generation,
      readiness: readiness(),
      pool_writer: w.readiness(),
      identity: identityStore.health(),
      relayer: { state: relayer.published ? "held" : relayer.state, epoch: relayer.role?.epoch ?? null },
      escrow: opened?.state() ?? "not-configured",
      money_sweep: { last: lastSweep, failures: sweepFailures },
      kms: kms === null ? null : { ...kms.counters },
    },
  });

  const noMoneyRoster = new NoMoneyRosterSource();
  let server: ReturnType<typeof createGameServer>;
  try {
    server = (input.createGameServer ?? createGameServer)({
      port: input.port,
      bindHost: input.bindHost,
      build: input.build,
      settlement,
      rosterSource: {
        plan: (record, ctx) =>
          record.money === null
            ? noMoneyRoster.plan(record, ctx)
            : opened !== null
              ? opened.service.rosterSource.plan(record, ctx)
              : Promise.resolve({ refusal: "wrong-state" as const, code: "wrong-state" as const, reason: "This server has no Juno escrow configured." }),
      },
      money: () => moneyRef.current,
      ...(opened !== null ? { escrow: { onGameplayCommitted: (event) => opened.service.onGameplayCommitted(event), isRosterFrozen: (gameId) => opened.service.isRosterFrozen(gameId), restoreGate: (gameId) => opened.service.restoreGate(gameId) } } : {}),
      capability,
      runtime: serving.runtime(),
      moneyFacts: settlement,
      identity: { mode: input.server.mode, allowedOrigins: input.server.allowedOrigins, trustedProxyHops: input.server.trustedProxyHops, service: identity },
      store: stores.log,
      records: stores.records,
      legacyLogs: "refuse",
      onRestartRequired: (room, detail) => failFast(room, detail),
      holds: stores.holds,
      ops: input.ops,
      statusExtras,
      ownership,
      readiness,
      routes,
      ...(input.limits !== undefined ? { limits: input.limits } : {}),
    });
  } catch (error) {
    return refuse(`the game server could not be built (${describe(error)})`);
  }
  serverRef.current = server;
  closers.push(() => void server.close().catch(() => undefined));
  step("game-server", `game server built with POOL ownership, listening on ${input.bindHost}:${input.port}; /gs/readyz answers from the pool writer's readiness`);
  const chainFacts = listenForChainFacts({ onChainFacts: (listener) => serving.onChainFacts(listener), lifecycle: server.lifecycle, settlement });
  if (opened !== null && escrowConfig !== null) {
    moneyRef.current = createMoneyTables(
      {
        enabled: input.moneySwitch === MONEY_TABLES_SWITCH,
        service: opened.service,
        pin: pinOf(escrowConfig),
        symbol: escrowConfig.symbol,
        rest: opened.rest,
        tickets: ticketLedger,
        financial: stores.financial,
        appName: APP_NAME,
        now: input.now,
        warn: input.warn,
        ops: input.ops,
      },
      server.rooms.moneyPort,
    );
    moneyRef.current.start();
    input.log(
      `  money: real-money tables are ${input.moneySwitch === MONEY_TABLES_SWITCH ? (escrowConfig.networkClass === "mainnet" ? "REFUSED (mainnet)" : `ENABLED on ${escrowConfig.chainId} (${escrowConfig.networkClass}) once the backend is verified`) : "OFF (ESCROW_MONEY_TABLES is not set)"}`,
    );
  }

  /* ---------------- 6. discovery, then the money claim sweep BEFORE any escrow money work ---------------- */
  let sweeping: Promise<SweepReport | null> | null = null;
  const sweepNow = (why: "startup" | "periodic" | "manual" = "manual"): Promise<SweepReport | null> => {
    if (terminal !== null || phase === "stopping") return Promise.resolve(null);
    sweeping ??= (async (): Promise<SweepReport | null> => {
      try {
        const report = await ownership.sweepMoneyClaims({
          financial: stores.financial,
          continues: (record) => moneyContinuationVerdict(record.continuation, THIS_DEPLOYMENT).continues,
          beforeRetake: (gameId) => server.retakeResident(gameId),
          isResident: (gameId) => server.isResident(gameId),
          onSwept: (gameId) => server.lifecycle.loadGame(gameId),
        });
        lastSweep = { at: input.now(), why, claimed: report.claimed.length, owned: report.owned, elsewhere: report.elsewhere, skipped: report.skipped, failed: report.failed.length };
        if (report.claimed.length > 0 || report.failed.length > 0) {
          const line = `  aws: money claim sweep (${why}): ${report.claimed.length} claimed, ${report.owned} owned, ${report.elsewhere} elsewhere, ${report.skipped} not continued here, ${report.failed.length} to retry`;
          if (report.failed.length > 0) input.warn(`${line} -- ${report.failed.slice(0, 5).map((failed) => `${failed.gameId}: ${failed.detail.slice(0, 160)}`).join("; ")}`);
          else input.log(line);
        }
        input.ops.audit("aws.money-sweep", { why, claimed: report.claimed.length, owned: report.owned, elsewhere: report.elsewhere, skipped: report.skipped, failed: report.failed.length });
        return report;
      } catch (error) {
        sweepFailures += 1;
        input.warn(`  aws: money claim sweep (${why}) FAILED -- ${describe(error)}; tried again`);
        input.ops.audit("aws.money-sweep-failed", { why, error: (error as { name?: string } | null)?.name ?? "error" });
        return null;
      }
    })().finally(() => {
      sweeping = null;
    });
    return sweeping;
  };

  try {
    await server.lifecycle.ready;
  } catch (error) {
    assertAlive();
    return refuse(`discovery failed (${describe(error)})`);
  }
  assertAlive();
  step("discovery", "discovery done (read-only: POOL mode writes nothing until a load's claim)");
  for (;;) {
    assertAlive();
    if ((await sweepNow("startup")) !== null) break;
    await new Promise((resolve) => setTimeout(resolve, timing.sweepRetryMs));
  }
  assertAlive();
  initialSweepDone = true;
  step("money-sweep", "the first money claim sweep COMPLETED before any escrow money work; again every 60 s");
  timers.push(every(timing.sweepEveryMs, () => void sweepNow("periodic")));
  phase = "serving";
  step("ready");
  /* LIVE-6 L6-1: a proven flip of the routing to another pool demotes this task: graceful stop, exit 5 (see the header). */
  const checkRouting = routingWatch((primary) => (primary !== w.pool ? `the routing names ${primary} primary, not this pool` : null));
  timers.push(every(timing.routingWatchMs, () => void checkRouting()));
  void checkRouting(); // once at once: a flip during the startup is not left for a whole interval

  /* ---------------- 7. escrow: verify, load (the relayer's load after its takeover), then the settlement walk ---------------- */
  const retryRelayerRole = async (): Promise<boolean> => {
    if (terminal !== null || phase === "stopping" || ledger === null || opened === null) return false;
    if (relayer.published) return true;
    /* Only once the escrow load has finished (it ran the relayer's own load, and never runs again): a role published now
       is loaded HERE, after its takeover, with no other load of the relayer running. */
    if (opened.state() !== "active") return false;
    relayer.retrying ??= (async () => {
      if (relayer.role === null) relayer.role = await takeRelayer("retry");
      const role = relayer.role;
      if (role === null || terminal !== null || isStopping()) return false;
      relayer.state = "taken-loading"; // held, not yet published: no pass until the relayer has loaded after the takeover
      try {
        await opened.relayer.load();
      } catch (error) {
        input.warn(`  aws: the relayer's load after its takeover failed -- ${describe(error)}; the role stays unpublished (no pass) and the load is tried again`);
        return false;
      }
      if (terminal !== null || isStopping()) return false; // never published while stopping
      relayer.published = true;
      relayer.state = "held";
      opened.relayer.wake();
      input.log(`  aws: relayer role PUBLISHED at epoch ${role.epoch}: the relayer loaded after its takeover and may pass`);
      return true;
    })().finally(() => {
      relayer.retrying = null;
    });
    return relayer.retrying;
  };

  const escrowStartup = (async () => {
    if (opened !== null) {
      await opened.start().catch((error) => input.warn(`  escrow: the Juno backend did not start -- ${describe(error)}; it retries with its verification`));
      steps.push("escrow-started");
    }
    if (terminal !== null || isStopping()) return; // no settlement walk once the task is stopping
    const report = await settlement.reconcileAtStartup({ financialGameIds: server.lifecycle.financialGameIds(), loadGame: server.lifecycle.loadGame });
    await settlement.sweepLiveness(server.lifecycle.financialRecords());
    if (report.financialGames > 0 || report.failed.length > 0) {
      input.log(`  settlement: ${report.financialGames} money games -- ${report.loaded} loaded, ${report.alreadyPrepared} already prepared, ${report.failed.length} could not be read (ESCROW-3A)`);
    }
  })().catch((error) => input.warn(`  settlement: the startup walk failed -- ${describe(error)}; each money game is announced at its next load`));
  void escrowStartup;
  timers.push(every(timing.livenessEveryMs, () => void settlement.sweepLiveness(server.lifecycle.financialRecords()).catch(() => undefined)));
  if (opened !== null) {
    timers.push(every(timing.chainSweepEveryMs, () => void opened.service.sweepChain().catch(() => undefined)));
    timers.push(every(timing.relayerRetryMs, () => void retryRelayerRole().catch(() => undefined)));
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise;
    shutdownPromise = (async () => {
      if (terminal !== null) return; // a loss or a restart request is fail-fast: never a graceful drain
      phase = "stopping";
      /** A loss or a restart request DURING the drain ends it at once: its own exit (3 / 4) is the task's, never 0. */
      const forced = () => terminal !== null;
      const did = (name: string) => shutdownSteps.push(name);
      input.log("  aws: graceful shutdown -- readiness answers 503; periodic work, money and the relayer stop; sockets close; stores and identity drain");
      input.ops.audit("aws.shutdown", { pool: w.pool, epoch: w.epoch });
      did("readiness-503");
      for (const timer of timers.splice(0)) timer.cancel();
      did("timers-stopped");
      await bounded("the periodic work in flight", Promise.all([sweeping ?? Promise.resolve(), relayer.retrying ?? Promise.resolve()]), timing.drainPeriodicMs, input.warn);
      if (forced()) return;
      did("periodic-drained");
      moneyRef.current?.stop();
      settlement.stop();
      did("money-stopped");
      opened?.stop();
      /* A start still verifying (or loading) when the stop came would install its retry timer after it: it is waited for
         (bounded) and stopped again, so no verification or load outlives this step. */
      await bounded("the escrow start in flight", escrowStartup, timing.drainEscrowStartMs, input.warn);
      opened?.stop();
      if (forced()) return;
      did("relayer-stopped");
      /* LIVE-6 L6-1: a DEMOTION gives back the no-money games it holds (the games an eviction would release) once its
         sockets are closed, so the new primary claims them at their next load -- under this task's own fence (a release
         names the exact writer; a commit still in flight either landed before it or is refused by it). A money game stays
         owned: a pool that continues it takes it only through L6-2's procedures. */
      const giveBack = roleChanged !== null ? server.releasableResidentGames() : [];
      await server.close().catch(() => undefined);
      if (forced()) return;
      did("server-closed");
      if (roleChanged !== null) {
        for (const gameId of giveBack) ownership.release(gameId);
        input.log(`  aws: role change -- ${giveBack.length} resident no-money game(s) released for the new primary; money games stay owned (L6-2)`);
        did("no-money-released");
      }
      await bounded("the escrow jobs", opened?.service.idle(), timing.drainEscrowMs, input.warn);
      if (forced()) return;
      did("escrow-drained");
      await bounded("the game claims and releases", ownership.settled(), timing.drainOwnershipMs, input.warn);
      if (forced()) return;
      did("ownership-settled");
      await bounded("the chain-facts holds", chainFacts.settled(), timing.drainChainFactsMs, input.warn);
      if (forced()) return;
      did("chain-facts-settled");
      await bounded("identity's confirmations (identity.settled())", identity.settled(), timing.drainIdentityMs, input.warn);
      if (forced()) return;
      did("identity-settled");
      w.stop();
      did("pool-writer-stopped");
      await input.ops.flush().catch(() => undefined);
      did("ops-flushed");
    })();
    return shutdownPromise;
  };
  runtimeShutdown = shutdown;

  return {
    role: "primary",
    task: input.task,
    steps,
    shutdownSteps,
    http: server.http,
    server,
    identity,
    backend: opened,
    readiness,
    sweepNow: () => sweepNow("manual"),
    retryRelayerRole,
    shutdown,
    exitCode,
    status: statusExtras,
    router: null,
    checkRouting,
  };

  /* ---------------- LIVE-6 L6-1: the routing watch, and the change of role it proves ---------------- */
  /** The exit this task ends with: a loss or a store's restart request first (3 / 4), then a proven role change (5). */
  function exitCode(): number | null {
    return forcedExit() ?? (roleChanged !== null ? EXIT_ROLE_CHANGED : null);
  }

  /** One strong read of the routing; `changed(primary)` names the change it proves, or null. A read that fails, an item
   *  this build cannot read, or no routing at all proves nothing (no reaction; said once per streak). Single-flight. */
  function routingWatch(changed: (primary: string) => string | null): () => Promise<void> {
    let running: Promise<void> | null = null;
    let quiet = false;
    return () => {
      running ??= (async () => {
        if (terminal !== null || phase !== "serving" || roleChanged !== null) return;
        let routing: { readonly primary_pool: string } | null;
        try {
          routing = await substrate.readRouting();
        } catch (error) {
          if (!quiet) input.warn(`  aws: the routing could not be read (${describe(error)}); no change of role is concluded from it`);
          quiet = true;
          return;
        }
        if (routing === null) {
          if (!quiet) input.warn("  aws: the routing names no primary pool; no change of role is concluded from it");
          quiet = true;
          return;
        }
        quiet = false;
        const change = changed(routing.primary_pool);
        if (change !== null) changeRole(change, routing.primary_pool);
      })().finally(() => {
        running = null;
      });
      return running;
    };
  }

  /** A proven change of this task's serving role: the graceful shutdown, then exit 5 -- never during a loss, a restart
   *  request or a shutdown already under way (those keep their own exit). */
  function changeRole(detail: string, primary: string): void {
    if (terminal !== null || phase !== "serving" || roleChanged !== null || shutdownPromise !== null) return;
    roleChanged = detail;
    input.warn(`\n  aws: ROLE CHANGE -- ${detail}. This task stops gracefully and exits ${EXIT_ROLE_CHANGED}; its restart takes the role the routing now names, through the one startup order.`);
    input.ops.audit("aws.routing-changed", { pool: config.pool, primary, detail: detail.slice(0, 200) });
    void runtimeShutdown()
      .catch((error) => input.warn(`  aws: the role change's graceful shutdown failed -- ${describe(error)}; exiting ${EXIT_ROLE_CHANGED} all the same`))
      .finally(() => {
        if (terminal === null) input.exit(EXIT_ROLE_CHANGED);
      });
  }

  /* ---------------- the non-primary task: not the primary pool's (LIVE-6 L6-1; L5-7's standby) ---------------- */
  function startNonPrimary(primary: string | null): AwsRuntime {
    const verifier = substrate.identityVerifier();
    const directory = substrate.gameDirectory(w);
    const capability = thisDeploymentCapability(escrowConfig === null ? [] : [pinOf(escrowConfig)]);
    step(
      "non-primary",
      `this pool is NOT primary (the routing names ${primary ?? "no pool"}): NON-PRIMARY -- no identity writer, no relayer, no ledger, no game claimed, no money work, ` +
        `nothing written; sockets authenticated by the identity verifier (strong reads of the identity records), games answered with a route ` +
        `(${Object.keys(config.routes).length === 0 ? "this configuration has no route table: every game is answered unavailable" : `route table: ${Object.entries(config.routes).map(([pool, entry]) => `${pool} -> ${entry.wsPath}`).join(", ")}`})`,
    );
    input.ops.audit("aws.non-primary", { primary: primary ?? null });
    const nonPrimaryReadiness = (): ReadinessAnswer => {
      const reasons: string[] = [];
      if (terminal === "lost") reasons.push("lost");
      if (phase === "stopping") reasons.push("shutting-down");
      const pool = w.readiness();
      if (pool.lost !== null) reasons.push("pool-writer-lost");
      else if (!pool.ready) reasons.push("pool-writer-unconfirmed");
      return {
        ready: reasons.length === 0,
        reasons: [...new Set(reasons)],
        detail: { role: "non-primary", serving: "route", pool: w.pool, epoch: w.epoch, identity: "verifier", identity_writer: "not-primary", relayer: "not-primary", escrow: "not-started" },
      };
    };
    let router: RouterServer;
    try {
      router = createRouterServer({
        port: input.port,
        bindHost: input.bindHost,
        build: input.build,
        identity: { allowedOrigins: input.server.allowedOrigins, trustedProxyHops: input.server.trustedProxyHops, verifier },
        capability,
        routes,
        directory,
        records: directory.records,
        readiness: nonPrimaryReadiness,
        ...(input.limits !== undefined ? { limits: input.limits } : {}),
        log: input.log,
        warn: input.warn,
      });
    } catch (error) {
      return refuse(`the non-primary server could not be built (${describe(error)})`);
    }
    closers.push(() => void router.close().catch(() => undefined));
    phase = "serving";
    /* Promotion: a proven routing naming THIS pool (see the header). */
    const checkNonPrimaryRouting = routingWatch((named) => (named === w.pool ? `the routing names this pool (${w.pool}) primary` : null));
    timers.push(every(timing.routingWatchMs, () => void checkNonPrimaryRouting()));
    void checkNonPrimaryRouting(); // once at once: a flip during the startup is not left for a whole interval
    const nonPrimaryShutdown = (): Promise<void> => {
      if (shutdownPromise !== null) return shutdownPromise;
      shutdownPromise = (async () => {
        if (terminal !== null) return;
        phase = "stopping";
        shutdownSteps.push("readiness-503");
        for (const timer of timers.splice(0)) timer.cancel();
        shutdownSteps.push("timers-stopped");
        /* 1012 when the task restarts into another role: the clients reconnect, and are answered by whoever serves now. */
        await router.close(roleChanged !== null ? 1012 : 1001);
        if (terminal !== null) return;
        shutdownSteps.push("server-closed");
        w.stop();
        shutdownSteps.push("pool-writer-stopped");
        await input.ops.flush().catch(() => undefined);
        shutdownSteps.push("ops-flushed");
      })();
      return shutdownPromise;
    };
    runtimeShutdown = nonPrimaryShutdown;
    return {
      role: "non-primary",
      task: input.task,
      steps,
      shutdownSteps,
      http: router.http,
      server: null,
      router,
      identity: null,
      backend: null,
      readiness: nonPrimaryReadiness,
      sweepNow: async () => null,
      retryRelayerRole: async () => false,
      shutdown: nonPrimaryShutdown,
      exitCode,
      checkRouting: checkNonPrimaryRouting,
      status: () => ({ aws: { role: "non-primary", pool: w.pool, epoch: w.epoch, task: w.task, primary, readiness: nonPrimaryReadiness(), pool_writer: w.readiness(), router: { ...router.counters }, routes: Object.fromEntries(Object.entries(config.routes).map(([pool, entry]) => [pool, entry.wsPath])) } }),
    };
  }
}
