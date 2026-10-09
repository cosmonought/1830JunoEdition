// server/src/gameServer.ts
//
// The process that hosts rooms. Everything it knows how to decide lives elsewhere.
//
// ==================================================================
//  DESIGN NOTE 1210: THE TRANSPORT DECIDES NOTHING
// ==================================================================
//
// THIS FILE IS DELIBERATELY THIN, and its thinness is the point rather than a stage it will grow out of.
// `RoomSession` gates, applies, appends and answers (#1209); `turnAuthority` says who may act (#1205);
// `RoomEngine` settles the board (#1201). What is left here is sockets, a room registry, and fan-out.
//
// IF A RULE EVER APPEARS IN THIS FILE IT IS IN THE WRONG PLACE. A rule the transport knows is a rule the
// replay harness cannot execute, the CLI cannot check, and the golden master cannot cover -- which is the
// exact property that made `App.tsx` the authority for so long, and the whole reason for this migration.
//
// ---------------------------------------------------------------------------
//  IDENTITY, AND WHY THIS FILE REFUSES TO GUESS AT IT
// ---------------------------------------------------------------------------
//
// EVERYTHING BUILT IN PHASE 2 RESTS ON THE SERVER KNOWING WHO IS SPEAKING. #1207 keeps the actor off the
// wire precisely so a client cannot claim to be somebody else, and `turnAuthority` then refuses actions on
// the strength of that identity. A transport that accepted a claimed id would quietly undo both, and it
// would do so while every test still passed.
//
// SO IDENTITY IS REQUIRED AND HAS NO DEFAULT. There is no fallback that trusts the connection, because a fallback
// is what gets reached for at four in the afternoon.
//
// LIVE-2B: AUTHENTICATION HAPPENS ONCE, AT THE HTTP UPGRADE (`identity/authenticateUpgrade.ts`), and no longer at
// `hello`. `claim` is gone from the wire. A socket carries a FROZEN context -- { principalId, sessionId,
// sessionExpiresAt, ipKey, openedAt } -- for its whole life, checked against the session on every frame (4401 when
// it expired or was revoked). Production authenticates the `__Host-gs_session` cookie; development authenticates
// `?dev_claim=` through the loopback-only development authenticator, and nothing else.
//
// LIVE-4 (L4-3): EVERY SOCKET IS ALSO A CLIENT OF SOME PROTOCOL. The upgrade reads the bundle's announcement
// (`cp` / `cr` / `cb`, `identity/authenticateUpgrade.ts`), and this file judges it with the canonical client verdict
// (`clientVerdict`) -- once at the connection (the client protocol), and per game at the hello, every submit, every log
// push, the room hello and every room-view push (the tab's rules against the game's pin) -- and answers with client
// protocol 1's frames (`reload`, close 4426; `route` once LIVE-6 supplies destinations, and until then exactly what a
// game this pool does not continue is answered). A protocol-1 socket's build is never compared. A socket that
// announced nothing is the legacy wire and keeps exactly its pre-LIVE-4 treatment: the exact build check on submit,
// no per-game rules check, and never a LIVE-4 frame or close code.
//
// LIVE-2D: ONE ROOM PROTOCOL, IN BOTH MODES. The legacy room protocol (`room-write`, `seat-pin`, `claim-seat`,
// `lobby-*`, and the `room`-keyed hello, room-hello, chat and presence) is DELETED -- its handlers, its room
// documents, its PINs and tokens and its staging lobby. What a socket may say about rooms is `room-op`,
// `rooms-watch`, and `hello` / `room-hello` / `chat-send` / `presence-set` by `gameId` (`rooms/roomHost.ts`); any
// legacy frame is an unknown kind to the closed schema (`bad-frame`), in development exactly as in production. The
// actor of every move is the seat the authenticated principal holds in the game's committed record -- never a
// claim, never a frame field.

import { randomBytes, randomInt } from "crypto";
import { createServer, type Server as HttpServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";

import { decideUpgrade, refuseUpgrade, type ConnectionContext } from "./identity/authenticateUpgrade";
import { DEV_PRINCIPAL_PREFIX, devClaimOf, type DevAuthenticator } from "./identity/devAuthenticator";
import { handleIdentityHttp } from "./identity/httpApi";
import { IdentityLimiter } from "./identity/limiter";
import type { GsMode } from "./identity/mode";
import { isLoopbackOrigin } from "./identity/origins";
import { IdentityService } from "./identity/sessions";
import { createMemoryIdentityStore } from "./identity/store";
import { createMemoryRecordStore, type RecordStore } from "./rooms/recordStore";
import { createRoomHost, factsFromRecord, GameUnavailableError, sessionBoardFacts, type RoomHost } from "./rooms/roomHost";
import { GAME_ID_PATTERN, seatOf, type GameRecord } from "./rooms/gameRecord";
/* LIVE-3C: restore, reconciliation, durable holds, the terminal seal, the operator's view. */
import { isMaintenanceHold, type CommittedView } from "./rooms/committedView";
import { createMemoryHoldStore, HoldUnreadableError, makeHold, type HoldStore } from "./rooms/holdStore";
import type { RoomHostClockConfig } from "./rooms/roomHost";
import type { ClockController } from "./rooms/clock/clockController";
import { classifyMessage } from "./rooms/clock/clockModel";
import { handleReadiness, type ReadinessAnswer } from "./ingress/readiness";
import { handleEdgeDiagnostic } from "./ingress/edgeDiagnostic";
import { admissibleAfterSeal, GAME_OVER_SENTENCE, NO_MONEY_SETTLEMENT, RECONCILING_SENTENCE, UNAVAILABLE_PLAYER_SENTENCE, type SettlementLifecycle } from "./rooms/lifecycle";
import { NO_MONEY_FACTS, type MoneyContinuationFacts } from "./escrow/moneyContinuation";
/* LIVE-4 (L4-2): this pool's capability and the continuation answers every game's session is given. */
import { thisDeploymentCapability } from "./deploymentCapability";
import { compatibilityDescriptor } from "./compatibilityDescriptor";
import { createContinuationWiring, type ContinuationWiring } from "./continuationWiring";
import type { DeploymentCapability } from "../../frontend/src/gameEngine/compat/deploymentCapability";
import type { ContinuationRuntime, ContinuationVerdict, PoolServingState } from "../../frontend/src/gameEngine/compat/continuationVerdict";
import { historyNotReadHere } from "../../frontend/src/gameEngine/compat/sessionContinuation";
/* LIVE-4 (L4-3): the client verdict, and client protocol 1's answers. */
import { clientVerdict, type ClientAnnouncement, type ClientVerdict } from "../../frontend/src/gameEngine/compat/clientCompatibility";
import { gameIdentityOfEntries } from "../../frontend/src/gameEngine/compat/continuationIdentity";
import { LEGACY_CLIENT_PROTOCOL } from "../../frontend/src/gameEngine/protocolVersions";
import {
  CLIENT_ANSWER_CLOSE_CODE,
  CLIENT_ANSWER_CLOSE_REASON,
  CLIENT_ANSWER_SENTENCES,
  clientAnswerFor,
  type ReloadFrame,
} from "../../frontend/src/utils/clientAnswers";
import { createMoneyLimiter, handleMoneyHttp } from "./escrow/moneyHttpApi";
import { createTrustFacts } from "./rooms/trustFacts";
import { createTrustLimiter, handleTrustHttp } from "./rooms/trustHttpApi";
import { createConductService } from "./conduct/conductService";
import { chainClockHooks, createConductClockFeed } from "./conduct/conductClockFacts";
import type { ConductCaseStore } from "./conduct/conductStore";
import { createConductLimiter, handleConductHttp } from "./conduct/conductHttpApi";
import { createLudumIpBudget, handleLudumHttp } from "./ludum/ingress";
import { createLudumPorts } from "./ludum/wiring";
import { ludumOriginProblem } from "./identity/mode";
import type { MoneyTables } from "./escrow/moneyTables";
import type { EscrowGameplaySeam } from "./rooms/roomHost";
import { reconcileLoaded } from "./rooms/reconcile";
import { NO_OPS, type OpsRecorder } from "./persistence/opsRecorder";
import type { IpKey } from "./identity/clientIp";
import type { UndoPolicy } from "../../frontend/src/gameEngine/logRevert";
import { BAD_FRAME_REASONS } from "../../frontend/src/gameEngine/messageSchema";
import { cryptoShuffle, NoMoneyRosterSource, type RosterSource } from "./rooms/roomService";

import { RoomSession, type ServerLogEntry } from "../../frontend/src/utils/roomSession";
import {
  DEVELOPMENT_CORPUS_POLICY,
  RULES_ENGINE_VERSION,
  SERVER_REPLAY_POLICY,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  type ReplayPolicy,
} from "../../frontend/src/gameEngine/rulesVersion";
/* #1500: the game machine, through its front door. Everything this server knows about 1830 comes from
   `frontend/src/gameEngine` -- one import, one surface, and no second implementation of any rule. */
import {
  DEFAULT_SANDBOX_SCENARIO,
  effectiveActions,
  logHash,
  sandboxReplayProviders,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
  validateSubmitEnvelope,
  waterfallForRoster,
  withEmptyRoster,
} from "../../frontend/src/gameEngine";
/* LIVE-2A: the closed control frames, the recursive gameplay parse, and the one text sanitizer. */
import {
  SUBMISSION_ID_PATTERN,
  parseClientFrame,
  parseGameplayMessage,
} from "../../frontend/src/gameEngine/messageSchema";
import type { ServerFrame, ServerMessage } from "../../frontend/src/utils/serverProtocol";
import type { SandboxLogMsg } from "../../frontend/src/gameEngine/gameSetup";
import type { LogStore } from "./fileLogStore";
import { COMMITTED, isStoreCorrupt, isStoreIncompatible, outcomeOf, type FenceScope } from "./persistence/storeResult";
/* LIVE-3A: every mutation of a game runs on that game's actor, and every read comes from its committed view. */
import {
  GameActor,
  HELD_REASON,
  UNAVAILABLE_REASON,
  newActorCounters,
  type ActorCounters,
  type BatchSettlement,
  type GameFaults,
  type GameStorePort,
  type Subscriber,
  type TaskOrigin,
  type Tx,
} from "./rooms/gameActor";
import { GameRegistry } from "./rooms/gameRegistry";
import { PROCESS_OWNERSHIP, type GameOwnership, type GameRoutedError } from "./rooms/gameOwnership";
/* LIVE-6 L6-1: where a game another pool owns is served (the trusted route table), and the frozen route frame. */
import { NO_ROUTES, ownershipRouteFrame, type PoolRoutes } from "./rooms/gameRoutes";
import { authorize } from "./rooms/roomAuthz";
/* LIVE-2A: the transport's limits and buckets (LIVE-2 §11.3, §12.2). */
import {
  HourlyBudget,
  SocketBuckets,
  excerpt,
  resolveLimits,
  type BucketName,
  type BucketSpec,
  type IngressLimitOverrides,
} from "./ingress/limits";

/* LIVE-2B: `ResolveIdentity` and `trustClaimedIdentity` are gone. Their successor is the upgrade gate
   (`identity/authenticateUpgrade.ts`): production authenticates the session cookie, development the loopback-only
   `?dev_claim=` authenticator (`identity/devAuthenticator.ts`), and both run before a WebSocket exists. */

/** LIVE-2D: the log subscription of a server-owned game -- `gameId` only (the schema refuses `room`). */
interface HelloFrame {
  kind: "hello";
  gameId: string;
  build: string;
  /** What this client has already applied, so a reconnect is answered rather than guessed at. */
  baseIndex?: number;
  /** LIVE-3A (L3-3): the id of the entry the client holds at `baseIndex` -- the anchor. */
  baseId?: unknown;
}

interface SubmitFrame {
  kind: "submit";
  build: string;
  msg: SandboxLogMsg;
  baseIndex: number;
  /** LIVE-3A (L3-3): the anchor, validated by `validateSubmitEnvelope`. */
  baseId?: string;
  submissionId?: string;
}

/** LIVE-2D: every other frame (`room-op`, `rooms-watch`, `room-hello`, `chat-send`, `presence-set`) is the room
 *  host's, by `gameId` (`rooms/roomHost.ts`); the closed schema has already refused anything else. */
interface RoomFrame {
  kind: "room-op" | "rooms-watch" | "room-hello" | "chat-send" | "presence-set";
  [field: string]: unknown;
}

type ClientFrame = HelloFrame | SubmitFrame | RoomFrame;

/* ==================================================================
    LIVE-0: LOOPBACK ONLY
   ==================================================================
   `http.listen(port)` with no host binds EVERY interface -- the local network, and anything else routed to
   this machine -- while the startup line said `127.0.0.1` (LIVE-1 B-8). Nothing on the playtest path needs
   more than loopback: two tabs here connect to 127.0.0.1, and a tunnelled playtest reaches this server only
   through `playtest-proxy.js`, which runs on this machine and forwards to 127.0.0.1. So it binds loopback,
   and `start.ts` prints this same constant, so the banner cannot say one thing while the socket does
   another. Where a deployment binds is LIVE-5's question, deliberately not a flag here. */
export const GAME_SERVER_BIND_HOST = "127.0.0.1";

/** LIVE-2B: who may open a socket, and how that is decided (LIVE-2 §4). Required; there is no default mode. */
export interface GameServerIdentity {
  mode: GsMode;
  /** Exact origins (LIVE-2 §4.3 step 4). Production: https only, at least one. Development: loopback only. */
  allowedOrigins: readonly string[];
  /** LUDUM: the Ludum site's exact origins -- credentialed CORS on `/gs/api/ludum/v1/*` ONLY, never added to
   *  `allowedOrigins`. Production: https only. Development: loopback only. Absent: none. */
  ludumOrigins?: readonly string[];
  /** LIVE-2 §12.1. Development: 0. */
  trustedProxyHops: number;
  /** Development only, and only as `createDevAuthenticator()` returned it. Refused in production. */
  devAuthenticator?: DevAuthenticator;
  /** Principals and sessions. An empty in-memory service when absent; `start.ts` passes the file-backed one. */
  service?: IdentityService;
  /** The production socket path, `/gs` when absent; development also accepts `/`. */
  wsPath?: string;
  /** The identity clock (expiry, rotation, limits). `Date.now` when absent; tests step it. */
  now?: () => number;
}

export interface GameServerOptions {
  port: number;
  build: string;
  /** Phase 3 final clocks: the table clock (`rooms/clock/`). Absent: no table is timed (hosts built without one -- the
   *  older suites and tools). `start.ts` and the AWS runtime always configure it. With a clock, the session stamps every
   *  entry from the clock's time (`clock.now`), and a move's entries carry the exact moment the clock judged it at. */
  clock?: RoomHostClockConfig;
  /** LIVE-2B: authentication at the upgrade (the successor of `resolveIdentity`). */
  identity: GameServerIdentity;
  /** LIVE-2C: the server-owned GameRecords and the join-code index. In memory when absent; `start.ts` passes the
   *  file adapter. */
  records?: RecordStore;
  /** LIVE-2C (LIVE-2 §8.3): where a start's roster comes from. `NoMoneyRosterSource` when absent. */
  rosterSource?: RosterSource;
  /** LIVE-2C: the start's shuffle -- `crypto.randomInt` Fisher-Yates when absent; tests inject a fixed one. */
  shuffle?: <T>(items: readonly T[]) => T[];
  /* ==================================================================
      DESIGN NOTE 1250: THE STORE IS AWAITED BEFORE ANYBODY IS TOLD
     ==================================================================
     Where a room's history lives. In memory when absent -- a test, the smoke run -- and on disk through
     `fileLogStore.ts` in `start.ts`. The append is awaited between `session.submit` and the answer, so the
     `applied` frame and the fan-out both describe entries the disk has synced; a write the store DEFINITELY did
     not take rolls the session back and the submitter is told `retry`, because a move the disk does not hold did
     not happen (#1209, read literally) -- and one whose outcome the store could not settle holds the room
     (LIVE-3B). LIVE-2D: the room's roster is its GameRecord (`records`), never a document in this store. */
  store?: LogStore;
  /** #1225: send per-field digests with every answer so a diverged client can name the field itself. A
   *  local-play diagnostic; `start.ts` turns it on wherever it turns on the insecure identity, because those
   *  are the same situation. */
  explainDivergence?: boolean;
  /** #1520: whether a stored room dealt BEFORE rules-engine versioning (no `rules_engine_version` on its
   *  deal) may be loaded under this engine. `"refuse"` when absent -- the deployment answer: such a room is
   *  held and every client is told. `"development-corpus"` is `start.ts`'s `--legacy-logs` opt-in for the
   *  local playtest rooms, announced at startup and again per room. A room pinned to a version this server
   *  does not carry is held under either setting. */
  legacyLogs?: ReplayPolicy["legacyLogs"];
  /** Called when entries become durable and visible, inside the publish that shows them (LIVE-3A). */
  onAppend?: (room: string, entries: readonly ServerLogEntry[]) => void;
  /** Test-only fault injection for the LIVE-3A regressions (LIVE-3D generalises it). Never set by `start.ts`. */
  faults?: GameFaults;
  /** LIVE-3B E-11: the store-call timeout inside an actor task (5 s when absent) and how long a late write may stay
   *  unsettled before a restart is asked for (60 s). Tests shorten both. */
  storeTimeoutMs?: number;
  storeRestartAfterMs?: number;
  /** LIVE-3B: a game holds a store outcome only a process restart can resolve (a write whose redo failed, or one
   *  that never settled). `start.ts` fails fast; without it the game simply stays held. */
  onRestartRequired?: (room: string, detail: string) => void;
  /** LIVE-2A: the transport's limits (LIVE-2 §11.3, §12.2), each overridable -- tests shorten the clocks and shrink
   *  the caps; `start.ts` takes the defaults. See `ingress/limits.ts`. */
  limits?: IngressLimitOverrides;
  /** LIVE-3C: the durable holds (`rooms/holdStore.ts`). In memory when absent -- a hold then lasts as long as the
   *  process; `start.ts` passes the file store, so a hold survives every restart until an operator's release. */
  holds?: HoldStore;
  /** LIVE-3C: the audit lines and the status snapshot (`persistence/opsRecorder.ts`). Nothing when absent. */
  ops?: OpsRecorder;
  /** Phase 3 (P3-N035): conduct reports. `store`: the durable case store (`start.ts` the file store, the AWS runtime the
   *  DynamoDB one); absent or null, every report is refused `unavailable` (never kept in memory only). `reviewers`: the
   *  canonical login keys of the accounts that may open the review panel (`GS_CONDUCT_REVIEWERS`; none when absent). */
  conduct?: {
    readonly store: ConductCaseStore | null;
    readonly reviewers?: ReadonlySet<string>;
    readonly reporterBudget?: BucketSpec;
    /** A READ-ONLY reader of a game's committed log, for re-verifying a case whose game is not resident here (no claim,
     *  no load, no repair, no write). Absent: such a case says "not loaded here; open the table". */
    readonly readLog?: (gameId: string) => Promise<readonly ServerLogEntry[] | null>;
  };
  /** LIVE-3C: the terminal seam ESCROW-3 plugs into (`rooms/lifecycle.ts`). No-money when absent. */
  settlement?: SettlementLifecycle;
  /** LIVE-4 (L4-2): THIS POOL'S DEPLOYMENT CAPABILITY, built once at startup (`start.ts`: `thisDeploymentCapability` over
   *  the configured Juno deployment, or none). Every game's continuation verdict, dealing identity and discovery line is
   *  judged against it; no build id enters it. Absent: this build's capability serving no escrow deployment -- no money
   *  game is continued then. */
  capability?: DeploymentCapability;
  /** LIVE-4 (integration): what this run read from the chain, at verification grade -- the money serving's own runtime
   *  (`MoneyServing.runtime()`, shared with the escrow service and the settlement coordinator), so every session judges a
   *  money table against the same chain facts the money seams do. Absent: none (`NO_CHAIN_FACTS`). */
  runtime?: ContinuationRuntime;
  /** LIVE-4 (L4-2): the settlement index's money facts (`escrow/settlementCoordinator.ts`), which the verdict judges
   *  for every money table at every rebuild -- replacing ESCROW-3A's build-keyed `moneyContinuation` policy (#1252's
   *  waiver). Absent: no financial record is known, so a money table reads as MISSING and is never continued (fail
   *  closed). */
  moneyFacts?: MoneyContinuationFacts;
  /** LIVE-4 (L4-2): this pool's serving state (`serveDecision`). Absent: primary -- every continued game is served,
   *  with no deadline. LIVE-6 supplies draining pools; tests use it to drive the session half of T-24. */
  pool?: () => PoolServingState;
  /** LIVE-4 (L4-2): a DRAINING pool's view of the current primary's own verdict for a game (LIVE-6). */
  primaryVerdict?: (gameId: string) => ContinuationVerdict | null;
  /** ESCROW-3B: the escrow service's gameplay seam (checkpoints) and the frozen-roster fact (`escrow/escrowService.ts`).
   *  Absent: no money game can exist here. */
  escrow?: EscrowGameplaySeam;
  /** ESCROW-4: the real-money table layer, bound late (it is built on this server's room port). Absent or null: no
   *  money table can be created, and `/gs/api/money/*` answers 404. */
  /** PHASE 3 FINAL: whether tables without an ante may be created, seated or started (`roomHost.ts` `freeTables`).
   *  Production passes `false`; absent: allowed (the internal machinery and the deterministic suites). */
  freeTables?: boolean;
  money?: () => MoneyTables | null;
  /** LIVE-3C: more for the status snapshot -- `start.ts` adds the identity store's health. */
  statusExtras?: () => Record<string, unknown>;
  /** LIVE-5 L5-3: who may write a game (`rooms/gameOwnership.ts`). Absent: PROCESS ownership -- the data directory's
   *  lock is the whole fence, exactly as before. POOL ownership (DynamoDB; L5-7 wires `aws/ownership/`): every load
   *  claims its game first, a write refused by an ownership fence drops the game's actor, an evicted idle no-money game
   *  is released, and the startup discovery writes nothing. */
  ownership?: GameOwnership;
  /** LIVE-5 L5-7: `/gs/readyz` (`ingress/readiness.ts`) -- AWS storage mode's readiness (the pool writer, the roles, the
   *  startup, shutting down). Absent: no such route; PROCESS mode is unchanged. `/gs/healthz` (liveness) is unchanged
   *  either way. */
  readiness?: () => ReadinessAnswer;
  /** LIVE-6 L6-6: `/gs/diag/edge` (`ingress/edgeDiagnostic.ts`) -- the staging certification's edge mirror (AWS storage
   *  mode with `GS_EDGE_DIAGNOSTIC=staging` only). Absent: no such route; every other start is unchanged. */
  edgeDiagnostic?: { readonly trustedProxyHops: number };
  /** LIVE-5 L5-7: the address the server listens on. Absent: `GAME_SERVER_BIND_HOST` (loopback, LIVE-0) -- every
   *  PROCESS-mode start. AWS storage mode binds its task's own interface (awsvpc), reached only through the load
   *  balancer. */
  bindHost?: string;
  /** LIVE-6 L6-1: the deployment's trusted route table (`rooms/gameRoutes.ts`, from the AWS runtime document). A game
   *  another pool owns (POOL ownership refused the claim) is answered, to a protocol-1 socket whose connection verdict is
   *  `ok` and whose principal the game's record lets read it, with LIVE-4's `route` frame naming that pool's configured
   *  path, then close 4426; and this server also answers upgrades on its own pool's configured socket path. Absent (PROCESS
   *  mode; an AWS document without routes): no destination exists, and every answer is exactly as before. */
  routes?: PoolRoutes;
}

/** LIVE-5 L5-3: what a game's log subscribers are told when another writer took the game from this task (POOL ownership
 *  only) -- then their socket closes 1012 and they reconnect, to whichever writer owns the game now. */
export const GAME_MOVED_SENTENCE = "This game moved to another game server. Reconnecting.";

/** A socket's log subscription: the game it said `hello` for, and its principal. The actor of a move is NOT here --
 *  it is the seat this principal holds in the record committed when each submit runs (LIVE-2C §14). */
interface Attached {
  room: string;
  principalId: string;
}

/* ==================================================================
    LIVE-3A: THE SENTENCES THE TRANSPORT OWNS
   ================================================================== */
/** §4.1: the store definitely did not take the move (nothing past the committed history), so it was not made. */
const RECORD_FAILED_REASON = "The server could not record that move, so it was not made. Try again.";
/** Phase 3 final clocks: a catch-up larger than this (serialized entries) is sent in pages of at most this size. */
export const CATCH_UP_PAGE_BYTES = 512 * 1024;
/** The next page is sent once less than this is buffered for the socket. */
export const CATCH_UP_LOW_WATER_BYTES = 1024 * 1024;
const CATCH_UP_DRAIN_POLL_MS = 5;
/** Frames that may wait behind one socket's catch-up pages before it is closed as a slow consumer. */
const CATCH_UP_QUEUE_BOUND = 4_096;
/** E-7: the game's queue is full. */
const BUSY_REASON = "The game server is busy with this game. Try again in a moment.";
/** E-8: the task was never run -- its deadline passed while it waited behind other work. */
const EXPIRED_REASON = "The game server did not get to that move in time, so it was not made. Try again.";
/** A room that could not be loaded from the store. */
const LOAD_FAILED_REASON = "The game server could not load this room right now. It will keep trying.";
/** E-9: a reference ties the sentence a player reads to the line in this window (LIVE-2 §11.5). */
const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const errorRef = (): string => Array.from(randomBytes(6), (byte) => REF_ALPHABET[byte % 32]).join("");

/* ==================================================================
    LIVE-4 L4-5 (D-43): THE HOSTED REVENUE SEED IS A CRYPTOGRAPHIC DRAW
   ==================================================================
   #1662 made this server the only author of a turn's `revenue_seed`: `normalizeForCommit` draws it at ingress (or finds
   this turn's earlier draw in the RAW log after an undo, #1051), the accepted `RunMultipleRoutes` commits it, and a
   replay reads the committed number and never draws. What was left was the DRAW ITSELF: no hosted session passed
   `mintSeed`, so every hosted seed fell to `randomTurnSeed` -- `Math.random`. Every session this server builds now
   draws here: Node's CSPRNG, uniform over the same unsigned 32-bit space `randomTurnSeed` covers (`randomInt` rejects
   rather than reducing modulo), so every extraction downstream reads the range it was written for.
   ONLY THE SOURCE OF A NEW SEED CHANGED. The committed seed, the raw-log reuse rule, the turn key and the seed ->
   revenue mapping are untouched, so no rules, hosted, financial or capability identity moves: a build-only change
   (LIVE-4 preflight §11, D4-16). The Firestore sandbox keeps its own draw -- it is not hosted. T-18
   (`rooms/live4CryptoSeed.test.ts`) pins that the production session factory passes THIS function. */
export const mintHostedRevenueSeed = (): number => randomInt(0, 2 ** 32);

/* ==================================================================
    LIVE-2A (LIVE-2 §11.4, §11.5): WHAT A MALFORMED OR THROWING FRAME IS TOLD
   ==================================================================
   A fixed sentence, never the frame's own text, never an exception's message: the reference ties the sentence a
   player reads to the full line in this window. */
const BAD_FRAME_CODE = "bad-frame";
const RATE_LIMITED_CODE = "rate-limited";
const INTERNAL_REASON = (ref: string) => `The server could not process that request. (ref ${ref})`;
const MOVE_INTERNAL_REASON = (ref: string) => `The server could not process that move, so it was not made. (ref ${ref})`;
const RATE_LIMITED_REASON = "Too many requests too quickly. Wait a moment and try again.";
const SUBMIT_RATE_LIMITED_REASON = "You are sending moves too quickly. Wait a moment and try again.";
/** Phase 3 final clocks (owner-policy correction): offer FREQUENCY (transport), never an offer limit of the game. */
export const OFFER_RATE_LIMITED_REASON = "You are making offers too quickly. Wait a moment and try again.";
const REVERT_BUDGET_REASON = "Too many undos in the last hour. Play on, and undo again later.";
/** LIVE-2C (LIVE-2 §6.3 #20): the deal of a server-owned game is the server's. */
const SERVER_DEALS_REASON = "The deal is made by the server \u2014 press Start.";
/** LIVE-2D (LIVE-2 §13.4 step 4): THE LEGACY ROOM HANDLERS COMPILED INTO THIS BUILD -- none. LIVE-2C registered
 *  `room-write`, `seat-pin`, `claim-seat`, `lobby-*` and the `room`-keyed hello, room-hello, chat and presence in
 *  development only and refused production while this list was not empty; LIVE-2D deleted every one of them, and the
 *  closed frame schema no longer knows their kinds. Kept, frozen and empty, as the invariant a test pins: a legacy
 *  handler that came back would have to be added here, in plain sight. */
export const LEGACY_ROOM_HANDLERS: readonly string[] = Object.freeze([]);

/** A direct answer to a submit names the submission it answers (L3-3); fan-out never does. */
const answering = <T extends object>(message: T, inReplyTo: string | undefined): T =>
  inReplyTo === undefined ? message : { ...message, inReplyTo };

/** LIVE-2A: the submission a frame names, for `inReplyTo` -- only when it is a well-formed, bounded id, so a reply
 *  never carries a stranger's arbitrary text back. */
const submissionIdOf = (frame: unknown): string | undefined => {
  const id = typeof frame === "object" && frame !== null ? (frame as { submissionId?: unknown }).submissionId : undefined;
  return typeof id === "string" && SUBMISSION_ID_PATTERN.test(id) ? id : undefined;
};

export function createGameServer(options: GameServerOptions): {
  http: HttpServer;
  close: () => Promise<void>;
  /** Phase 3 final clocks: the table clock (`null` when the server was built without one). */
  clock: ClockController | null;
  /** LIVE-3A: the executor's counters (expiries, store failures, resyncs...), for tests and the smoke run. */
  counters: Readonly<ActorCounters & { submitAhead: number; submitResync: number; internal: number }>;
  /** LIVE-2A: what the ingress limits refused, stripped and closed -- for tests and the smoke run. */
  ingress: Readonly<{
    badFrames: number;
    malformedClosed: number;
    rateLimited: number;
    rateLimitedByBucket: Readonly<Partial<Record<BucketName, number>>>;
    rateLimitClosed: number;
    pendingOverflowClosed: number;
    slowConsumerClosed: number;
    keepaliveTerminated: number;
    stripped: number;
    revertBudgetRefused: number;
    internal: number;
    /** Phase 3 final clocks: long catch-ups sent in pages, and the pages sent. */
    catchUpStreams: number;
    catchUpPages: number;
  }>;
  /** LIVE-2A: the limits this server runs with. */
  limits: Readonly<ReturnType<typeof resolveLimits>>;
  /** LIVE-2B: principals and sessions (the operator's revoke / disable reach the running process here). */
  identity: IdentityService;
  /** LIVE-2B: the identity limiters, their refusals by name, and the upgrade/socket counters. */
  identityLimiter: IdentityLimiter;
  upgrades: Readonly<{ accepted: number; refused: Readonly<Record<string, number>>; sessionClosed: number; malformedCooldowns: number; reaped: number }>;
  /** LIVE-4 (L4-3): what clients were told by their client verdict (tests and the operator read it). */
  clientAnswers: Readonly<{ connectionReload: number; gameReload: number; routeFailClosed: number; legacyRefused: number; routed: number }>;
  /** LIVE-2C: the GameRecord store and the server-owned room authority (tests read their counters). */
  records: RecordStore;
  rooms: RoomHost;
  /** LIVE-2C: how many game actors (each with its RoomSession) are resident -- the allocation-flood tests read it. */
  residentGames(): number;
  /** LIVE-5 L5-3 (tests): evict the actors idle as of `at` -- the registry's own sweep, run now. */
  evictIdleGames(at: number): string[];
  /** LIVE-5 L5-3: drop a quiescent resident actor of `gameId` before the money claim sweep claims the game back (false:
   *  it is not quiescent -- try again at the next pass). True when no actor is resident. */
  retakeResident(gameId: string): boolean;
  /** LIVE-5 L5-3: whether an actor of `gameId` is resident (the money claim sweep's `isResident`). */
  isResident(gameId: string): boolean;
  /** LIVE-6 L6-1: the resident games this task may give back when it stops for good in this role (a demotion): loaded,
   *  not fenced, NO-MONEY tables -- the games an eviction would release (a money game stays owned). */
  releasableResidentGames(): string[];
  /** LIVE-2B: the live socket indexes, for tests: how many sockets a session / principal / IP key / game holds. */
  socketCounts(): { total: number; bySession(id: string): number; byPrincipal(id: string): number; byIp(key: string): number; byGame(room: string): number };
  /** LIVE-3C: what every durable game is (discovery, refined by each load), the holds, and the operator's recorder. */
  lifecycle: {
    ready: Promise<void>;
    inventory: RoomHost["inventory"];
    discovery: RoomHost["discovery"];
    holds: HoldStore;
    ops: OpsRecorder;
    /** ESCROW-3A (brief §6): the money games the index knows, their records, and a game's ordinary load. */
    financialGameIds: RoomHost["financialGameIds"];
    financialRecords: RoomHost["financialRecords"];
    /** LIVE-4 (L4-2): this pool's capability (built once), its continuation answers, and the serving review (T-24). */
    capability: DeploymentCapability;
    continuation: ContinuationWiring;
    reviewServing(): Promise<number>;
    /** LIVE-4 (integration): the same review, on ANY pool (a primary included), re-asking every resident served game's
     *  continuation verdict -- run when the chain facts the verdict reads change (a verified contradiction), so a game the
     *  money side refuses stops being played at once. Derived: nothing is written. */
    reviewContinuation(): Promise<number>;
    loadGame(gameId: string): Promise<void>;
  };
} {
  /* ==================================================================
      LIVE-2B: THE IDENTITY CONFIGURATION IS CHECKED HERE TOO, NOT ONLY IN `start.ts`
     ==================================================================
     A misassembled server refuses to exist rather than run looser than its mode: production takes no development
     authenticator, no divergence explainer and no legacy-log admission, and only https origins; development takes
     only loopback origins and no proxy hops. */
  const identityOptions = options.identity;
  if (identityOptions === undefined || identityOptions === null) throw new Error("createGameServer: `identity` is required (LIVE-2B)");
  const mode = identityOptions.mode;
  const allowedOriginList = [...identityOptions.allowedOrigins];
  if (mode === "production") {
    if (identityOptions.devAuthenticator !== undefined) throw new Error("createGameServer: production mode refuses a development authenticator");
    if (options.explainDivergence === true) throw new Error("createGameServer: production mode refuses explainDivergence");
    if (options.legacyLogs === "development-corpus") throw new Error("createGameServer: production mode refuses legacy-log admission");
    if (allowedOriginList.length === 0 || allowedOriginList.some((origin) => !origin.startsWith("https://"))) {
      throw new Error("createGameServer: production mode needs https allowed origins");
    }
  } else if (mode === "development") {
    if (identityOptions.devAuthenticator === undefined || identityOptions.devAuthenticator.kind !== "development") {
      throw new Error("createGameServer: development mode needs createDevAuthenticator()");
    }
    if (identityOptions.trustedProxyHops !== 0) throw new Error("createGameServer: development mode refuses trusted proxy hops");
    if (allowedOriginList.length === 0 || !allowedOriginList.every(isLoopbackOrigin)) {
      throw new Error("createGameServer: development mode needs loopback allowed origins");
    }
  } else {
    throw new Error("createGameServer: identity.mode must be \"development\" or \"production\"");
  }
  const ludumOriginList = [...(identityOptions.ludumOrigins ?? [])];
  for (const origin of ludumOriginList) {
    const problem = ludumOriginProblem(origin, mode);
    if (problem !== null) throw new Error(`createGameServer: ludum origin refused: ${problem}`);
  }
  const identityNow = identityOptions.now ?? (() => Date.now());
  const identity = identityOptions.service ?? IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] });
  /* The configured reviewer USERNAMES are bound to the accounts that hold them, at startup, and reviewers are then
     recognised by their principal, server-side. A configured name NOBODY holds refuses the start: otherwise whoever
     registered it first (a typo, a name not yet made) would be bound as a reviewer at some later restart. Make the
     reviewer's account first, then name it. A name held by an inactive account binds nothing (said once). */
  const conductReviewers = new Set<string>();
  const unheldReviewers: string[] = [];
  let inactiveReviewers = 0;
  for (const key of options.conduct?.reviewers ?? []) {
    const holder = identity.usernameHolder(key);
    if (holder.kind === "active") conductReviewers.add(holder.principalId);
    else if (holder.kind === "inactive") inactiveReviewers += 1;
    else unheldReviewers.push(key);
  }
  if (unheldReviewers.length > 0) {
    throw new Error(`GS_CONDUCT_REVIEWERS names ${unheldReviewers.length} username(s) no account holds: make each reviewer's account first, then name it (or remove the name)`);
  }
  if (inactiveReviewers > 0) {
    // eslint-disable-next-line no-console
    console.warn(`  conduct: GS_CONDUCT_REVIEWERS names ${inactiveReviewers} username(s) whose account is not active: not reviewers this run`);
  }
  /** Who each LOG socket said it was at `hello`, and which room. Identity only: the subscription itself lives on
   *  the room's actor (LIVE-3A), which is what fan-out reads. */
  const sockets = new Map<WebSocket, Attached>();
  /* LIVE-2A: the transport's limits, and what they have refused. */
  const limits = resolveLimits(options.limits);
  const ingress = {
    badFrames: 0,
    malformedClosed: 0,
    rateLimited: 0,
    rateLimitedByBucket: {} as Partial<Record<BucketName, number>>,
    rateLimitClosed: 0,
    pendingOverflowClosed: 0,
    slowConsumerClosed: 0,
    keepaliveTerminated: 0,
    stripped: 0,
    revertBudgetRefused: 0,
    internal: 0,
    catchUpStreams: 0,
    catchUpPages: 0,
  };
  /** LIVE-2A (§12.2): reverts per seat per hour -- `${room}\u0000${actor}` -> own actions and others'. In memory;
   *  a restart forgets it, which costs at most one more hour's budget. */
  const revertBudgets = new Map<string, { self: HourlyBudget; others: HourlyBudget }>();
  const revertBudgetFor = (room: string, actor: string, which: "self" | "others"): HourlyBudget => {
    const key = `${room}\u0000${actor}`;
    let entry = revertBudgets.get(key);
    if (entry === undefined) {
      entry = {
        self: new HourlyBudget(limits.selfRevertsPerHour, () => Date.now()),
        others: new HourlyBudget(limits.hostRevertsOfOthersPerHour, () => Date.now()),
      };
      revertBudgets.set(key, entry);
    }
    return entry[which];
  };
  /** Rooms whose log has passed the alarm length, said once each (LIVE-2 §12.2: alarm at 5,000). */
  const logAlarmed = new Set<string>();
  let minted = 0;
  /* #1250: A PROCESS TAG ON EVERY MINTED ID. `id` is an entry's identity -- `effectiveActions` kills reverted
     entries by it (#1026) -- and a counter that restarts at 1 with the process would mint an id a stored log
     already holds. The tag makes ids unique across restarts; the counter inside it keeps #1238's evidence
     (a new tag says "restarted" the way `s58` said "did not"). */
  const processTag = Date.now().toString(36);

  /* ==================================================================
      LIVE-4 (L4-2): THIS POOL'S CAPABILITY, BUILT ONCE, AND THE ANSWERS EVERY SESSION IS GIVEN
     ==================================================================
     The capability is this pool's name and its whole semantic reach (`compatibilityKey` has no build id in it); it is
     validated here, once, so a descriptor this build could not canonicalize stops the start instead of failing inside
     a game's rebuild. Every session asks the canonical verdict through it -- at every rebuild, unconditionally -- with
     the game's money facts from the settlement index; nothing here reads a build. */
  const continuation: ContinuationWiring = createContinuationWiring({
    capability: options.capability ?? thisDeploymentCapability([]),
    policy: { legacyLogs: options.legacyLogs ?? "refuse" },
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    moneyFacts: options.moneyFacts ?? NO_MONEY_FACTS,
    /* The record as this server last committed it: whether a table is a money table is its record's (write-once). */
    recordOf: (gameId) => roomHost?.recordOf(gameId) ?? null,
    ...(options.pool !== undefined ? { pool: options.pool } : {}),
    ...(options.primaryVerdict !== undefined ? { primaryVerdict: options.primaryVerdict } : {}),
    now: identityNow,
  });
  /* LIVE-4 (L4-6): the operator's view of that one capability (its key, its axes, the build as a diagnostic), made once:
     the capability is immutable for the process, so the status snapshot repeats the same object. */
  const compatibility = compatibilityDescriptor(continuation.capability, { build_id: options.build });

  /* Phase 3 final clocks: one time base for the clock and every entry's stamp; a move is stamped with the exact time the
     clock judged it at (set only around a synchronous `RoomSession.submit`). */
  const clockTime = options.clock?.now ?? (() => Date.now());
  let stampNow: number | null = null;
  const stampAt = <T>(at: number, fn: () => T): T => {
    const prior = stampNow;
    stampNow = at;
    try {
      return fn();
    } finally {
      stampNow = prior;
    }
  };
  /** A room's session at the seed, nothing applied: what a game is loaded into. LIVE-4 (L4-2): with this pool's
   *  continuation answers for that game -- its verdict (asked at every rebuild), its dealing identity and its serving
   *  decision. (ESCROW-3A's `continuesDealtBuild`, asked only across builds, is gone.) */
  const newRoomSession = (gameId: string | null = null): RoomSession =>
    new RoomSession({
      ...(gameId === null ? {} : { continuation: continuation.sessionFor(gameId) }),
      providers: sandboxReplayProviders(),
      seed: {
        state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
        waterfall: waterfallForRoster(
          sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
          [],
        ),
      },
      build: options.build,
      /* #1026's transactional allocation was a fix for RACING BROWSERS. One writer needs no transaction, and
         an id only has to be unique within a room -- the index already carries the ordering. */
      mintId: () => `s${processTag}-${(minted += 1)}`,
      /* LIVE-4 L4-5 (D-43): the turn's revenue draw -- `crypto.randomInt`, never `randomTurnSeed`'s `Math.random`. */
      mintSeed: mintHostedRevenueSeed,
      /* Phase 3 final clocks: an entry's server stamp is the clock's decision time (`stampAt`), else the clock's now. */
      now: () => stampNow ?? clockTime(),
      explainDivergence: options.explainDivergence === true,
      replayPolicy: options.legacyLogs === "development-corpus" ? DEVELOPMENT_CORPUS_POLICY : SERVER_REPLAY_POLICY,
    });

  /** A stored log into a session, said in the window. */
  const restoreRoom = (code: string, session: RoomSession, stored: readonly ServerLogEntry[]): void => {
    /* RESTORED THROUGH `apply`, NEVER `submit` (#1203): a stored log already holds its derived entries. */
    session.restore(stored);
    // eslint-disable-next-line no-console
    console.log(
      `  restored ${code}: ${stored.length} entries from the store, log hash ${logHash(stored).slice(0, 16)}… (#1251)`,
    );
    /* LIVE-4 (L4-2): THE DEALING BUILD IS HISTORY, SAID AS SUCH. #1252 refused to continue a room dealt on another
       build; the continuation verdict decides now (below), from the deal's semantic identity. The build is still
       named -- it is which image a forensic replay would fetch -- and nothing compares it. */
    const dealt = session.dealtBuild();
    if (dealt !== null && dealt !== options.build) {
      // eslint-disable-next-line no-console
      console.log(`  ${code} was dealt on build "${dealt}"; this server is "${options.build}" (diagnostic only: continuation follows the game's rules and hosted protocol)`);
    }
    /* #1520: A HELD ROOM, SAID ONCE HERE. `restore` did not interpret a single entry: this pool's continuation verdict
       (LIVE-4) does not continue the game -- a rules pin or hosted protocol this pool does not carry, a deal it cannot
       read, a legacy log it refuses, a money table whose escrow it does not serve. The log on disk is exactly as it was
       found, nothing was written, and every hello and submit on this room is answered `incompatible` (with `why`)
       until a pool that continues it loads it. */
    const held = session.incompatible;
    if (held === null && session.replayCompatibility().kind === "legacy") {
      // eslint-disable-next-line no-console
      console.warn(
        `  ${code} is a LEGACY room (its deal carries no rules_engine_version) admitted under --legacy-logs ` +
          `development-corpus and replayed with engine version(s) [${SUPPORTED_RULES_ENGINE_VERSIONS.join(", ")}]. ` +
          `A deployment refuses this room (#1520).`,
      );
    }
    if (held !== null) {
      const pinned = held.compatibility.kind === "incompatible" || held.compatibility.kind === "compatible" ? String(held.compatibility.version) : "none (legacy)";
      const why = held.decision !== null ? held.decision.detail : held.verdict.kind === "continues" ? "" : held.verdict.detail;
      // eslint-disable-next-line no-console
      console.warn(
        `  ${code} is HELD, not rebuilt -- NOT CONTINUED here (${held.why}): ${why}. Pinned rules-engine version ${pinned}; ` +
          `this server supports [${SUPPORTED_RULES_ENGINE_VERSIONS.join(", ")}]. Derived: nothing was written (#1520, LIVE-4).`,
      );
    }
  };

  /* LIVE-2A (§11.3, §12.2): A SLOW CONSUMER IS CLOSED, NOT BUFFERED FOREVER. A socket that has stopped reading
     would otherwise hold every fan-out frame in this process's memory; past the cap it is closed 1013 and sent
     nothing more. */
  const slowConsumers = new WeakSet<WebSocket>();
  /* ==================================================================
      PHASE 3 FINAL CLOCKS (owner ruling, 2026-10-07): A LONG HISTORY IS CAUGHT UP IN PAGES
     ==================================================================
     A game's log has no length limit, so its catch-up has none either -- and one frame of it could pass the slow-
     consumer bound by itself (about 43,000 entries at ~200 bytes each), closing every socket that asked for it. To a
     client whose hello said `pages: 1`, a catch-up larger than `CATCH_UP_PAGE_BYTES` is sent as consecutive pages
     (`more: true`; the last carries the digest, the fields, `inReplyTo` and `inFlight`), each sent only once the socket
     has drained below `CATCH_UP_LOW_WATER_BYTES` -- so what is buffered for one socket stays bounded however long the
     game. Every other frame for that socket waits behind the pages, in order. A socket that stops draining is closed
     as a slow consumer, exactly as before. The client reassembles the pages into the one catch-up a short history is. */
  const pagedSockets = new WeakSet<WebSocket>();
  const catchUpStreams = new WeakMap<WebSocket, { readonly queue: object[] }>();
  const closeSlow = (socket: WebSocket, why: string) => {
    slowConsumers.add(socket);
    ingress.slowConsumerClosed += 1;
    // eslint-disable-next-line no-console
    console.warn(`  ingress: closed a slow consumer (${why}) -- 1013`);
    socket.close(1013, "slow consumer");
  };
  const pagesOf = (frame: { entries: readonly ServerLogEntry[] } & Record<string, unknown>): object[] | null => {
    const sizes = frame.entries.map((entry) => JSON.stringify(entry).length + 1);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (total <= CATCH_UP_PAGE_BYTES) return null;
    const pages: object[] = [];
    let start = 0;
    let bytes = 0;
    for (let at = 0; at < frame.entries.length; at += 1) {
      if (bytes > 0 && bytes + sizes[at] > CATCH_UP_PAGE_BYTES) {
        pages.push({ kind: "catch-up", entries: frame.entries.slice(start, at), digest: "", build: frame.build, more: true });
        start = at;
        bytes = 0;
      }
      bytes += sizes[at];
    }
    pages.push({ ...frame, entries: frame.entries.slice(start) });
    return pages;
  };
  const streamPages = async (socket: WebSocket, pages: readonly object[]): Promise<void> => {
    const stream = { queue: [] as object[] };
    catchUpStreams.set(socket, stream);
    ingress.catchUpStreams += 1;
    try {
      for (const page of pages) {
        let waited = 0;
        while (socket.readyState === socket.OPEN && socket.bufferedAmount > CATCH_UP_LOW_WATER_BYTES) {
          if (waited >= limits.pongTimeoutMs) {
            closeSlow(socket, `a catch-up page waited ${waited} ms for ${socket.bufferedAmount} bytes to drain`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, CATCH_UP_DRAIN_POLL_MS));
          waited += CATCH_UP_DRAIN_POLL_MS;
        }
        if (socket.readyState !== socket.OPEN || slowConsumers.has(socket)) return;
        sendNow(socket, page);
        ingress.catchUpPages += 1;
      }
    } finally {
      if (catchUpStreams.get(socket) === stream) catchUpStreams.delete(socket);
    }
    /* What waited behind the pages, in order (a queued catch-up starts its own stream; what follows it waits again). */
    for (const queued of stream.queue) send(socket, queued);
  };
  const send = (socket: WebSocket, message: ServerFrame | object) => {
    if (socket.readyState !== socket.OPEN || slowConsumers.has(socket)) return;
    const stream = catchUpStreams.get(socket);
    if (stream !== undefined) {
      if (stream.queue.length >= CATCH_UP_QUEUE_BOUND) {
        closeSlow(socket, `${stream.queue.length} frames waited behind a catch-up`);
        return;
      }
      stream.queue.push(message);
      return;
    }
    const frame = message as { kind?: unknown; entries?: unknown };
    if (frame.kind === "catch-up" && Array.isArray(frame.entries) && pagedSockets.has(socket)) {
      const pages = pagesOf(message as { entries: readonly ServerLogEntry[] } & Record<string, unknown>);
      if (pages !== null) {
        void streamPages(socket, pages);
        return;
      }
    }
    sendNow(socket, message);
  };
  const sendNow = (socket: WebSocket, message: ServerFrame | object) => {
    if (socket.readyState !== socket.OPEN || slowConsumers.has(socket)) return;
    if (socket.bufferedAmount > limits.maxOutboundBufferedBytes) {
      slowConsumers.add(socket);
      ingress.slowConsumerClosed += 1;
      // eslint-disable-next-line no-console
      console.warn(`  ingress: closed a slow consumer (${socket.bufferedAmount} bytes unsent) -- 1013`);
      socket.close(1013, "slow consumer");
      return;
    }
    socket.send(JSON.stringify(message));
  };

  /* ==================================================================
      LIVE-3A: ONE ACTOR PER GAME, AND THE STORE BEHIND IT
     ==================================================================
     `roomFor` is gone. A game is reached through `games.get`, which creates its actor once however many frames
     ask at the same moment (LIVE-3 P2), and every change to it -- a move, a room operation, the deal -- is a task on
     that actor (`rooms/gameActor.ts`). The store is today's `LogStore`, seen through the port the actor commits to;
     without one (a test, the smoke run) the game lives in memory, exactly as before. */
  const counters = { ...newActorCounters(), submitAhead: 0, submitResync: 0, internal: 0 };
  const store = options.store;
  /* LIVE-5 L5-3: PROCESS ownership unless a POOL ownership is given (then every load claims first, `gameActor.ts`). */
  const ownership: GameOwnership = options.ownership ?? PROCESS_OWNERSHIP;
  const pooled = ownership.mode === "pool";
  /* LIVE-3B: WRITES ANSWER WITH A CLASS -- committed, definitely not, or uncertain (persistence/storeResult.ts). A
     store with the classified methods (the file store) is asked directly; a legacy store that only resolves or
     rejects is read conservatively: a rejection is uncertain unless it threw `StoreDefiniteError`. */
  const storePort: GameStorePort = {
    loadLog: async (code, loadOptions) => (store ? await store.loadLog(code, loadOptions) : []),
    appendBatch: async (code, entries) => {
      if (!store || entries.length === 0) return COMMITTED;
      if (store.appendBatch) return store.appendBatch(code, entries);
      try {
        await store.appendLog(code, entries);
        return COMMITTED;
      } catch (error) {
        return outcomeOf(error);
      }
    },
    /* LIVE-2C: only a server-owned game id has a record. LIVE-2D: and only a server-owned game is ever loaded. */
    loadRecord: async (code) => (GAME_ID_PATTERN.test(code) ? await recordStore.load(code) : null),
    saveRecord: (record, expected) => recordStore.put(record, expected),
    /* LIVE-3C: the durable hold decides a game's load, whatever its files say now. An unreadable hold holds. */
    loadHold: async (code) => {
      try {
        const hold = await holdStore.load(code);
        /* LIVE-3C (review E11): a hold discovery found this run but could not write down holds all the same. LIVE-5 L5-3:
           NOT under POOL ownership. There discovery ran before any claim, from a snapshot another writer may have moved
           since (an operator's release, a deal in flight on the previous task): the load, AFTER its claim, decides from
           what it reads then -- the durable hold, and its own reconciliation of the record against the whole log, which
           writes any hold it finds. A startup snapshot is never enforced, and never written down, in its place. */
        if (hold !== null) return { code: hold.code, detail: hold.detail };
        return pooled ? null : (roomHost?.pendingHoldOf(code) ?? null);
      } catch (error) {
        if (error instanceof HoldUnreadableError) return { code: "hold-unreadable" as const, detail: error.message };
        throw error;
      }
    },
    persistHold: async (code, found) => {
      const created = await holdStore.create(
        makeHold({
          gameId: code,
          code: found.code,
          detail: found.detail,
          at: Date.now(),
          source: "load",
          build: options.build,
          rulesEngineVersion: RULES_ENGINE_VERSION,
          evidence: found.evidence,
        }),
      );
      if (created.outcome.kind === "committed" && created.existing === null) ops.audit("hold.created", { game_id: code, code: found.code, detail: found.detail, source: "load" });
      if (created.outcome.kind !== "committed") throw new Error(created.outcome.detail);
    },
  };
  const recordStore: RecordStore = options.records ?? createMemoryRecordStore();
  const holdStore: HoldStore = options.holds ?? createMemoryHoldStore();
  const ops: OpsRecorder = options.ops ?? NO_OPS;
  /** LIVE-3C: the board's end and close -- the reducer's, or the test seam's (`GameFaults.boardEnded`). */
  const boardFacts = (gameId: string, session: RoomSession): { ended: boolean; closed: boolean } => {
    const board = sessionBoardFacts(session);
    return options.faults?.boardEnded?.(gameId, session) ? { ...board, ended: true } : board;
  };
  let roomHost: RoomHost | null = null;
  /** LIVE-5 L5-3: THE FENCED REACTION's owner half. The actor has answered its task and runs nothing more; the ownership
   *  is told (a POOL fence: this task is lost; a GAME fence: a self-check now), and, once the current step is over, the
   *  actor is dropped: its log subscribers are told the game moved and their sockets close 1012, so they reconnect to
   *  whichever writer owns it now. The next ask builds a fresh actor, whose claim decides. */
  const onActorFenced = (actor: GameActor, scope: FenceScope, detail: string): void => {
    ownership.onFenced(actor.gameId, scope, detail);
    setImmediate(() => dropActor(actor));
  };
  /** Drop `actor` (retired: it runs nothing more) if it is still its game's resident one: its log subscribers are told the
   *  game moved and their sockets close 1012. */
  const dropActor = (actor: GameActor): void => {
    actor.retire();
    if (games.peek(actor.gameId) !== actor) return;
    for (const [socket, subscribed] of [...logSubscriptions]) {
      if (subscribed !== actor) continue;
      logSubscriptions.delete(socket);
      send(socket, { kind: "status", state: "unavailable", reason: GAME_MOVED_SENTENCE });
      if (socket.readyState === socket.OPEN) socket.close(1012, "game moved");
    }
    games.discard(actor.gameId, actor);
  };
  /** LIVE-5 L5-3: before the money claim sweep claims back a game this task did not own (released, taken by an operator
   *  run and given back), a RESIDENT actor of it -- whose memory is from before the game left this task -- must not be
   *  re-armed by the new claim: it is dropped, so the next load reads the game afresh after the claim. Only when it is
   *  quiescent (no task running, no store outcome unknown): a write of it still in flight must never find the game
   *  claimed again under the same fence. False: not now (the sweep skips the game this pass). */
  const retakeResident = (gameId: string): boolean => {
    const actor = games.peek(gameId);
    if (actor === undefined) return true;
    if (!actor.quiescent) return false;
    dropActor(actor);
    return true;
  };
  /** LIVE-5 L5-3: an evicted idle game is given back only when it is a loaded NO-MONEY table (a money game stays owned:
   *  its background work needs a fenced owner; a game whose record could not be read is kept, the safe direction). */
  const releasable = (actor: GameActor): boolean => {
    if (!actor.isLoaded || actor.fenced) return false;
    const record = actor.view.record;
    return record !== null && record.money === null;
  };
  const games = new GameRegistry({
    evictable: store !== undefined,
    now: () => Date.now(),
    /* LIVE-3C: stage two -- every load settles the game's reconciliation before any waiting caller acts on it. */
    onLoaded: (_gameId, actor) => roomHost?.onActorLoaded(actor),
    ...(pooled ? { onEvicted: (gameId: string, actor: GameActor) => (releasable(actor) ? ownership.release(gameId) : undefined) } : {}),
    create: (code) => {
      const actor: GameActor = new GameActor({
        gameId: code,
        build: options.build,
        explainDivergence: options.explainDivergence === true,
        store: storePort,
        newSession: () => newRoomSession(code),
        restore: (session, stored) => restoreRoom(code, session, stored),
        onEntriesPublished: (entries) => options.onAppend?.(code, entries),
        /* LIVE-2C: a committed record, published: indexes, re-authorized room views, the public list. */
        onRecordPublished: (record) => roomHost?.onRecordPublished(record as GameRecord),
        /* LIVE-4 (L4-2): the actor stopped serving the game (its serving review, or a rebuild it had not published). */
        onNotServed: (gameId, source) => roomHost?.onNotServed(gameId, source),
        now: () => Date.now(),
        // eslint-disable-next-line no-console
        warn: (line) => console.warn(line),
        counters,
        faults: options.faults,
        storeTimeoutMs: options.storeTimeoutMs,
        storeRestartAfterMs: options.storeRestartAfterMs,
        onRestartRequired: (gameId, detail) => options.onRestartRequired?.(gameId, detail),
        /* LIVE-3C: the record against the whole durable log and the replayed board (`rooms/reconcile.ts`). An
           unsupported rules-engine pin leaves the board uninterpreted (#1520): only what the log itself says is
           checked then. */
        onStoreAdopted: () => roomHost?.onStoreAdopted(code),
        reconcileAtLoad: ({ record, entries, session }) => {
          /* LIVE-4 (L4-2): a game whose HISTORY this pool does not read at all (another hosted protocol, a newer or an
             older build's format) is not judged by this pool's reading of it -- a hold concluded from a misreading
             would freeze the game for the pool that continues it. Derived; nothing is written
             (`HISTORY_NOT_READ_HERE`). Every other game is reconciled exactly as before. */
          if (historyNotReadHere(session.incompatible?.verdict)) return { kind: "ok" };
          const verdict = reconcileLoaded(record, { entries, board: session.incompatible === null ? boardFacts(code, session) : null });
          return verdict.kind === "hold" ? verdict : { kind: "ok" };
        },
        /* LIVE-5 L5-3: POOL ownership -- the claim is the load's first step; a fenced commit drops the actor. */
        ...(pooled ? { claim: () => ownership.claim(code), onFenced: (_gameId: string, scope: FenceScope, detail: string) => onActorFenced(actor, scope, detail) } : {}),
      });
      return actor;
    },
  });

  /** A task's origin: the socket, who it said it was, and -- for a submit -- the nonce `inFlight` reports. */
  const originFor = (socket: WebSocket, principal: string, submissionId?: string): TaskOrigin => ({
    key: socket,
    principal,
    submissionId,
    isOpen: () => socket.readyState === socket.OPEN,
    send: (frame) => send(socket, frame),
  });

  /** Which actor each log socket is subscribed to, so a second hello -- a resync, or another room -- replaces the
   *  subscription rather than adding one, and a close removes it. */
  const logSubscriptions = new Map<WebSocket, GameActor>();
  const unsubscribeLog = (socket: WebSocket) => {
    logSubscriptions.get(socket)?.unsubscribe(socket);
    logSubscriptions.delete(socket);
  };

  /* ==================================================================
      LIVE-3 §4: THE SUBMIT PIPELINE, AS ONE TASK ON THE ROOM'S ACTOR
     ==================================================================
     The frame has been parsed and shape-checked and the connection's identity is known (steps 0-1, in the
     socket's #1216 chain). From here every step reads the COMMITTED view and a private session that equals it:
       3a  a game held for an unknown store outcome takes no move (E-10)
       4-12 `RoomSession.submit`, unchanged: build, held room, ahead / anchor (new), deal pin, duplicate, stale,
           repair, authority, reducer and derived entries -- all SPECULATIVE on the private session
       13  the durable commit of everything the submit appended, as one batch -- the point of no return (E-13)
       15-17 publish: the committed view replaced, the submitter answered, the room fanned out, in one
           synchronous step, so fan-out order is commit order (LIVE-3 F-6) and nobody reads a move before the
           disk has it (F-1, F-3)
     A later submit can never build on an earlier one whose append is still pending: it does not start until
     that one has published or rolled back (E-1, LIVE-1's failure). */
  const submitOnActor = async (
    tx: Tx,
    game: GameActor,
    socket: WebSocket,
    attached: Attached,
    frame: SubmitFrame,
    inReplyTo: string | undefined,
  ): Promise<void> => {
    const answer = (message: object) => tx.reply(answering(message, inReplyTo));
    /* LIVE-4 (L4-3): THE TAB AGAINST THE GAME, FIRST -- in place of `RoomSession.submit`'s build compare for a
       protocol-1 socket (which is why that compare now runs for the legacy wire only): judged against the view
       committed NOW, so a submit queued before the deal is judged against the deal. */
    const refused = clientRefusalFor(socket, attached.room, tx.view);
    if (refused !== null) {
      unsubscribeLog(socket);
      refuseClient(socket, attached.room, refused, inReplyTo);
      return;
    }
    if (tx.view.hold?.reason === "uncertain") {
      answer({ kind: "refused", code: "unavailable", reason: UNAVAILABLE_REASON, build: options.build });
      return;
    }
    /* LIVE-3B (§8.5, §17 class 5): a log held `corrupt` takes no move until an operator repairs it offline.
       LIVE-3C: nor does a durably held game, whatever it is held for -- until an operator's verified release. */
    if (isMaintenanceHold(tx.view.hold)) {
      answer({ kind: "refused", code: "held", reason: HELD_REASON, build: options.build });
      return;
    }
    /* LIVE-3C: nor a game whose record is not reconciled with its log yet (its load's repair has not landed): no move is
       built on a record the log may contradict. The reconciliation is tried again; the move can be sent again. */
    if (host.awaitingReconciliation(game)) {
      /* Not UNAVAILABLE_REASON ("will appear if it was"): this move was never attempted, so nothing will appear.
         LIVE-2F/3D (C9-05): and so not `unavailable` either -- a client keeps an `unavailable` move in flight (it may
         have landed) and never settles it on this socket. `retry` is the never-ran answer (as E-8's). */
      answer({ kind: "refused", code: "retry", reason: RECONCILING_SENTENCE, build: options.build });
      return;
    }
    /* ==================================================================
        LIVE-2C: THE ACTOR IS THE SEAT, READ FROM THE RECORD COMMITTED NOW
       ==================================================================
       authenticated principal -> the current GameRecord -> its bound seat -> that seat's `player_id`, the actor. The
       frame never names one. LIVE-2D: there is no other kind of room -- the legacy claim and document host are gone. */
    const bound = host.seatActor(tx, attached.principalId);
    if (!bound.ok) {
      answer({ kind: "refused", code: bound.code, reason: bound.reason, build: options.build });
      return;
    }
    /* ==================================================================
        LIVE-3C: THE SEAL -- A GAME THAT HAS ENDED TAKES NO MORE GAMEPLAY
       ==================================================================
       Once the committed board is at GameEnd, the game's result is the log up to its seal (`rooms/lifecycle.ts`). The
       engine already refuses every move there but the room-close marker; the transport now says so itself, before
       anything is speculated, from the COMMITTED board -- so a terminal game's refusal does not depend on the reducer
       arm, on a resident actor, or on the record having caught up (a restart restores the board from the log, and the
       board says it ended). `RevertTo` passes to RV-3, which refuses it in the words the Undo button uses. */
    if (!tx.view.incompatible && boardFacts(tx.view.gameId, tx.session).ended && !admissibleAfterSeal(frame.msg)) {
      host.counters.terminalRefused += 1;
      answer({ kind: "refused", code: "wrong-state", reason: GAME_OVER_SENTENCE, build: options.build });
      return;
    }
    const actor = bound.actor;
    const hostId = bound.host;
    const undoPolicy: UndoPolicy = { host_undo: bound.policy };
    const wait = host.submitBudget(attached.room, actor);
    if (wait > 0) {
      ingress.rateLimited += 1;
      answer({ kind: "refused", code: RATE_LIMITED_CODE, reason: SUBMIT_RATE_LIMITED_REASON, retryAfterMs: wait, build: options.build });
      return;
    }
    /* ==================================================================
        LIVE-2A (LIVE-2 §12.2): UNDO HAS A BUDGET; THE LOG HAS NO LENGTH LIMIT
       ==================================================================
       The undo budget is read off the COMMITTED view, before anything is speculated, and its refusal appends
       nothing, consumes no nonce and moves no `baseIndex` -- the two properties §12.2 requires of every rate
       refusal: 30 reverts of the seat's own action and 10 of another seat's (the host's reach) per hour.
       Phase 3 final clocks (owner ruling, 2026-10-07): A LONG BUT VALID GAME NEVER BECOMES UNPLAYABLE BECAUSE OF ITS
       LENGTH. The former 10,000-entry cap is gone and nothing replaces it: the history is stored one entry per item
       (DynamoDB) or line (file), hashed cumulatively, loaded with a progress-bound deadline and caught up in pages,
       so no single object grows with it. Churn is bounded by FREQUENCY only (the submit, offer and undo buckets --
       transport, never game legality). The ALARM stays: an operator is told once when a game's log passes
       `logEntryAlarm` entries -- it changes nothing for the players. */
    const length = tx.view.entries.length;
    if (length >= limits.logEntryAlarm && !logAlarmed.has(attached.room)) {
      logAlarmed.add(attached.room);
      // eslint-disable-next-line no-console
      console.warn(`  ingress: ${attached.room}'s log has reached ${length} entries (an operator alarm at ${limits.logEntryAlarm}; there is no length limit)`);
    }
    /* Phase 3 final clocks (owner-policy correction): the history's length never changes which offers are legal and no
       round counts offers. Offer CHURN -- the one optional message a seat can repeat at will -- is bounded by
       FREQUENCY only, as transport: the ordinary `rate-limited` answer with its wait, after which the same offer is
       taken. Only an offer that lands spends it. */
    const offering = host.clock !== null && classifyMessage(frame.msg).cls === "propose";
    if (offering) {
      const offerWait = host.offerBudget(attached.room, actor);
      if (offerWait > 0) {
        ingress.rateLimited += 1;
        answer({ kind: "refused", code: RATE_LIMITED_CODE, reason: OFFER_RATE_LIMITED_REASON, retryAfterMs: offerWait, build: options.build });
        return;
      }
    }
    let revertBudget: HourlyBudget | null = null;
    if ("RevertTo" in frame.msg) {
      const index = frame.msg.RevertTo.index;
      const target = effectiveActions(tx.view.entries).find((entry) => entry.index === index);
      /* The budget a revert spends is the reach it uses: its own seat's action, or (the host's) another's. A target
         that does not exist spends the seat's own -- and is then refused by the authority, spending nothing. */
      revertBudget = revertBudgetFor(attached.room, actor, !target || target.actor === actor ? "self" : "others");
      const wait = revertBudget.retryAfter();
      if (wait > 0) {
        ingress.revertBudgetRefused += 1;
        answer({ kind: "refused", code: RATE_LIMITED_CODE, reason: REVERT_BUDGET_REASON, retryAfterMs: wait, build: options.build });
        return;
      }
    }

    /* ==================================================================
        PHASE 3 FINAL CLOCKS: THE TABLE CLOCK JUDGES THE MOVE FIRST, IN THIS TASK
       ==================================================================
       Every transition due by now happens first, each at its own moment (an overdue at 20:00, a finality at 30:00, a
       train offer's unanswered expiry -- which the server closes in the log and then refuses this submit, so it is
       judged on the new board). Then a pause, a system pause, an interruption, an ended game, a fenced undo or the
       two-decline limit refuses it, appending nothing. The move's entries are stamped with the time it was judged at. */
    const clockGate = host.clock === null ? null : await host.clock.gateSubmit(game, tx, { actor: bound.actor, msg: frame.msg });
    if (clockGate !== null && !clockGate.ok) {
      answer({ kind: "refused", code: clockGate.code, reason: clockGate.reason, build: options.build });
      return;
    }

    const session = tx.session;
    const before = session.entries.length;

    /* THE ACTOR COMES FROM THE CONNECTION, NEVER FROM THE FRAME (#1207). This line is the whole of the
       security posture; a `frame.actor` here would undo `turnAuthority` entirely. */
    /* ==================================================================
        DESIGN NOTE 1241: A THROWN SUBMIT IS ANSWERED, NOT SWALLOWED
       ==================================================================
       REPORTED: with Auto-Buy armed, every turn began with "Sending your last action — one moment" and
       the controls stayed grey until the client's six-second backstop (#1173) gave up. A throw inside
       `session.submit` was never answered; now it is refused and the client's latch released at once.
       LIVE-3A (E-9, F-13): AND NOTHING IT TOUCHED SURVIVES. The entry is pushed BEFORE the reducer runs, so a
       reducer that threw used to leave its entry on the log, where the append below stored it and the fan-out
       broadcast it as `applied` -- to everyone but the submitter, who was told `refused`. The private session
       is now rolled back to the committed view before anything is written, and the refusal carries a
       reference to the line printed here instead of the exception's own text. */
    let result: ServerMessage;
    try {
      const submitMove = (): ServerMessage => session.submit({
        actor,
        build: frame.build,
        /* LIVE-4 (L4-3): the socket's announced client protocol, as the upgrade read it: 0 (the legacy wire) keeps the
           exact build check; 1+ was judged above by its announcement, and its build is never compared. */
        clientProtocol: clientProtocolOf(socket),
        msg: frame.msg,
        baseIndex: frame.baseIndex,
        baseId: frame.baseId,
        submissionId: frame.submissionId,
        /* #1249: the host, so the messages that are the host's to send can be refused to everybody else.
           LIVE-2C/2D: from the GameRecord committed when this task runs -- the record's `host_player_id`. */
        host: hostId,
        seated: true,
        undoPolicy,
      });
      result = clockGate !== null ? stampAt(clockGate.now, submitMove) : submitMove();
    } catch (error) {
      tx.rollback();
      counters.internal += 1;
      const ref = errorRef();
      const reason = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.log(
        `  threw: ${actor} sent ${Object.keys(frame.msg)[0]} — ${reason} (ref ${ref}); rolled back, nothing recorded\n` +
          `    payload ${excerpt(frame.msg, limits.logExcerptBytes)}`,
      );
      answer({ kind: "refused", code: "internal", reason: MOVE_INTERNAL_REASON(ref), build: options.build });
      return;
    }

    /* ==================================================================
        DESIGN NOTE 1218: THE SERVER SAYS WHY, IN THE WINDOW THAT IS ALREADY OPEN
       ==================================================================
       A refusal, a build skew and a catch-up all reach the shell as "the action was not sent", and two
       of the three arrive with no explanation at all. THE SERVER KNOWS EXACTLY WHICH IT WAS and was
       throwing that away -- so diagnosing a stuck button meant opening DevTools, which is a different
       skill from playing a game and a poor thing to require of a playtester.
       ONLY THE NON-APPLIED ANSWERS ARE LOGGED. An applied move is the normal case and one line per
       action would bury the interesting ones. */
    if (result.kind !== "applied") {
      const code = (result as { code?: string }).code;
      if (code === "ahead") counters.submitAhead += 1;
      if (code === "resync") counters.submitResync += 1;
      const why =
        (result as { reason?: string }).reason ??
        (result.kind === "build-skew"
          ? `client ${(result as { clientBuild?: string }).clientBuild} vs server ${options.build}`
          : `client was at ${frame.baseIndex}, room is at ${session.nextIndex - 1}`);
      // eslint-disable-next-line no-console
      console.log(`  ${result.kind}${code ? ` (${code})` : ""}: ${actor} sent ${Object.keys(frame.msg)[0]} — ${why}`);
      if (code === "ahead" || code === "resync") {
        /* LIVE-3 §5.2: A DURABILITY TRIPWIRE. Under durable-before-visible no client can hold an entry the
           store does not; on one process with one store, any of these means history was lost or forked. */
        // eslint-disable-next-line no-console
        console.warn(
          `  resync: ${actor} in ${attached.room} claims index ${frame.baseIndex}; the room's durable ` +
            `history ends at ${(result as { watermark?: number }).watermark} -- counted as a durability alarm`,
        );
      }
    }

    /* Everything this submit appended -- a repair, the move, its derived burst -- is ONE batch (L3-4). Nothing
       appended (a refusal, a duplicate, a stale catch-up, `ahead`) is answered now, from the committed state. */
    const batch = session.entries.slice(before);
    if (batch.length === 0) {
      answer(result);
      return;
    }
    const board = boardFacts(attached.room, session);
    const endedAfter = board.ended;
    const closedAfter = board.closed;
    const boardAfter = session.state; // ESCROW-3B: the board this batch commits (the session is not read after the commit)
    /* Phase 3 final clocks: an offer may not exceed its direction's two declines this round (the board, after the
       proposal, names its answerer); refused before anything is committed. */
    if (clockGate !== null && host.clock !== null && result.kind === "applied" && clockGate.cls === "propose") {
      const blocked = host.clock.offerBlocked(game, { actor, board: boardAfter });
      if (blocked !== null) {
        tx.rollback();
        answer({ kind: "refused", code: blocked.code, reason: blocked.reason, build: options.build });
        return;
      }
    }
    const settled = await tx.commitBatch(batch, (settled) => submitDelivery(settled, batch, result, inReplyTo));
    /* ESCROW-3B: the committed board, for a money game's checkpoint seam. */
    if (settled.kind === "committed") host.afterGameplay(game, endedAfter, closedAfter, boardAfter);
    /* Phase 3 final clocks: the committed batch folded into the table clock (and written) before this task ends. */
    if (settled.kind === "committed" && clockGate !== null && host.clock !== null) {
      await host.clock.afterCommit(game, { gate: clockGate, actor, batch: settled.entries, board: boardAfter, applied: result.kind === "applied" });
    }
    if (settled.kind !== "committed" || result.kind !== "applied") return;
    /* LIVE-2A: a revert that landed spends its budget. */
    revertBudget?.record();
    /* An offer that landed spends its frequency budget. */
    if (offering) host.offerSpent(attached.room, actor);
  };

  /** What a settled batch owes its submitter and the room. */
  const submitDelivery = (
    settled: BatchSettlement,
    batch: readonly ServerLogEntry[],
    result: ServerMessage,
    inReplyTo: string | undefined,
  ): { reply: object; fanout?: object } => {
    if (settled.kind === "absent") {
      /* §4.1: definitely not durable -- the store holds nothing past the committed history. Nothing happened,
         and the nonce was forgotten with the rolled-back entries, so a retry is judged afresh. */
      return {
        reply: answering({ kind: "refused", code: "retry", reason: RECORD_FAILED_REASON, build: options.build }, inReplyTo),
      };
    }
    if (settled.kind === "unresolved") {
      return {
        reply: answering({ kind: "refused", code: "unavailable", reason: UNAVAILABLE_REASON, build: options.build }, inReplyTo),
      };
    }
    const { view, entries } = settled;
    const fields = view.fields ? { fields: { ...view.fields } } : {};
    /* FAN-OUT CARRIES WHAT WAS APPENDED, not the answer the submitter got -- a refusal is that client's
       business, and a catch-up is about how far behind IT was.
       #1223: THE WATCHERS' DIGEST IS COMPUTED, NOT BORROWED -- a refusal that carried repairs has no digest of
       its own, and an empty digest is "no verdict" (#232). The committed view's is the board as published.
       #1225: and the per-field digests with it, when the server explains itself. */
    const fanout = { kind: "applied", entries, digest: view.digest, ...fields, build: options.build };
    if (entries === batch) return { reply: answering(result, inReplyTo), fanout };
    /* THE STORE WAS READ BACK -- after a failed append, or a next view that could not be built (E-13) -- and
       what it holds is what stands. The submitter is told by whether its own entry, the one non-derived entry
       of the batch, is among the entries that stand: applied if so, and if not, the entries that DID land as
       history with a `retry`, never a refusal of a move the store holds (F-13's shape, one layer down). */
    const own = batch.find((entry) => !entry.derived);
    const landed = own !== undefined && entries.some((entry) => entry.id === own.id);
    const reply = landed
      ? { kind: "applied", entries, digest: view.digest, ...fields, build: options.build }
      : {
          kind: "refused",
          code: "retry",
          reason: RECORD_FAILED_REASON,
          catchUp: { entries, digest: view.digest, ...fields },
          build: options.build,
        };
    return { reply: answering(reply, inReplyTo), fanout };
  };

  /* ==================================================================
      LIVE-2B: THE IDENTITY SURFACES -- the HTTP API, the limiters, the socket indexes
     ================================================================== */
  const identityLimiter = new IdentityLimiter(limits.identity, identityNow);
  const allowedOrigins: ReadonlySet<string> = new Set(allowedOriginList);
  const upgrades = { accepted: 0, refused: {} as Record<string, number>, sessionClosed: 0, malformedCooldowns: 0, reaped: 0 };
  /** Each socket's trusted IP key (with its /48), for the room limits keyed by address. */
  const ipOfSocket = new Map<WebSocket, IpKey>();
  /** Every live socket's frozen context, and the indexes over it (LIVE-2 §4.4). In memory; they die with the process. */
  const contexts = new Map<WebSocket, ConnectionContext>();
  const socketsBySession = new Map<string, Set<WebSocket>>();
  const socketsByPrincipal = new Map<string, Set<WebSocket>>();
  const socketsByIp = new Map<string, Set<WebSocket>>();
  /** IPv6 /48 aggregates (not part of the frozen context, so kept beside it). */
  const socketsByAggregate = new Map<string, Set<WebSocket>>();
  const aggregateOf = new Map<WebSocket, string>();

  /* ==================================================================
      LIVE-4 (L4-3): EACH SOCKET'S CLIENT -- ITS ANNOUNCEMENT, FROZEN AT THE UPGRADE, JUDGED BY THE CANONICAL VERDICT
     ==================================================================
     The announcement is read once at the upgrade (`decideUpgrade`), beside the frozen identity context, and judged
     here with `clientVerdict` against THIS pool's capability -- the one `continuation` validated at startup:
       at the connection (no game)   `reload` (a protocol this pool does not accept, an unreadable announcement) is
                                     answered at once and the socket closed 4426; `legacy-refused` (protocol 0 once
                                     retired) is answered frame by frame with what a legacy bundle already treats as
                                     terminal; `legacy` and `ok` talk.
       per game (`ok` sockets only)  at the hello, every submit and every log push, the room hello and every room push:
                                     the tab's rules against the game's pin. A LEGACY socket is never asked this (it
                                     announced no rules: the known gap that retires with protocol 0, OD-L4-1).
     Nothing here reads a build: the announcement's `cb` is carried for the window and never compared. */
  interface SocketClient {
    readonly announcement: ClientAnnouncement;
    /** The connection-level verdict (no game in view). */
    readonly connection: ClientVerdict;
    /** Games whose check this socket passed on a deal that can no longer change (a dealt pin is immutable): not asked
     *  again. An undealt game is asked at every push, so the deal is judged the moment it is fanned out. */
    readonly settled: Set<string>;
  }
  const clientOf = new Map<WebSocket, SocketClient>();
  /** Sockets told `reload` for a game (and closed 4426): nothing they sent after it -- a queued room op, a submit -- is
   *  handled, exactly as for a socket told `reload` at the connection. Weak: it goes with the socket. */
  const toldToReload = new WeakSet<WebSocket>();
  /** A socket this server knows no announcement for is the legacy wire (never reached: every accepted upgrade has one). */
  const LEGACY_SOCKET_CLIENT: SocketClient = Object.freeze({
    announcement: Object.freeze({ kind: "legacy", protocol: LEGACY_CLIENT_PROTOCOL, build: null }),
    connection: Object.freeze({ kind: "legacy" }),
    settled: new Set<string>(),
  }) as SocketClient;
  const clientOfSocket = (socket: WebSocket): SocketClient => clientOf.get(socket) ?? LEGACY_SOCKET_CLIENT;
  /** The client protocol a submit is judged under (`RoomSession.submit` step 1): the announced one for a socket this
   *  pool talks to on protocol 1+, the legacy wire otherwise. */
  const clientProtocolOf = (socket: WebSocket): number => {
    const client = clientOfSocket(socket);
    return client.connection.kind === "ok" && client.announcement.kind === "announced" ? client.announcement.protocol : LEGACY_CLIENT_PROTOCOL;
  };
  /** The window's words for an announcement: bounded, and never a stranger's text (`cb` is a build id or nothing). */
  const describeClient = (announcement: ClientAnnouncement): string =>
    announcement.kind === "announced"
      ? `cp=${announcement.protocol} cr=${announcement.rules.join(",")} cb=${announcement.build ?? "-"}`
      : announcement.kind === "malformed"
        ? `cp=${announcement.protocol ?? "?"} (${announcement.problem}) cb=${announcement.build ?? "-"}`
        : `legacy (no cp) cb=${announcement.build ?? "-"}`;
  const clientAnswers = { connectionReload: 0, gameReload: 0, routeFailClosed: 0, legacyRefused: 0, routed: 0 };

  /** The game's rules pin as the client verdict reads it (the committed deal, canonically), and whether it can still
   *  change: an undealt game's can; a dealt, unpinned or damaged deal's cannot (a deal is never undone, RV-5). */
  const gamePinOf = (view: CommittedView): { pin: number | null; settled: boolean } => {
    try {
      const identity = gameIdentityOfEntries(view.entries);
      if (identity.kind === "dealt") return { pin: identity.gci.rules_engine_version, settled: true };
      return { pin: null, settled: identity.kind !== "undealt" };
    } catch {
      return { pin: null, settled: false }; // asked again at the next push
    }
  };

  /** What a per-game refusal sends, and whether the socket then closes 4426. */
  type ClientRefusal = { readonly kind: "reload"; readonly frame: ReloadFrame } | { readonly kind: "not-here"; readonly pin: number | null };

  /**
   * LIVE-4 (L4-3): THE PER-GAME CLIENT CHECK for a socket this pool talks to on protocol 1+ -- `null` when it may be
   * served this game now. A legacy socket is never checked (OD-L4-1). A game this pool does not continue (or holds for
   * maintenance) is answered as such, whatever the tab: nothing of its history is served or interpreted, so the tab's
   * rules do not matter -- and a stale tab never makes a game "incompatible". Otherwise the tab's announced rules
   * against the game's pin: `reload` when this release's bundle carries the pin; `route` when it does not -- which
   * before LIVE-6 has no destination, so it is answered exactly as a game this pool does not continue ("cannot continue
   * here"), and no destination is made up.
   */
  const clientRefusalFor = (socket: WebSocket, gameId: string, view: CommittedView): ClientRefusal | null => {
    const client = clientOfSocket(socket);
    if (client.connection.kind !== "ok") return null;
    if (client.settled.has(gameId)) return null;
    if (view.incompatible !== null || isMaintenanceHold(view.hold)) return null;
    const { pin, settled } = gamePinOf(view);
    /* The one mapping (`clientAnswerFor`). No route destination exists before LIVE-6: `destination: null`. */
    const answer = clientAnswerFor(clientVerdict(client.announcement, continuation.capability, pin), { gameId, destination: null });
    if (answer.kind === "reload") return { kind: "reload", frame: answer.frame };
    if (answer.kind === "route" || answer.kind === "not-continued-here") return { kind: "not-here", pin };
    if (settled) client.settled.add(gameId);
    return null;
  };

  /** The fail-closed answer for a route with no destination (before LIVE-6): the `incompatible` frame a game this pool
   *  does not continue is answered with -- a legacy-shaped frame every client already treats as terminal. */
  const notHereFrame = (pin: number | null, inReplyTo?: string): object => ({
    kind: "incompatible",
    reason: CLIENT_ANSWER_SENTENCES["route-unavailable"],
    why: "client-rules",
    pinnedRulesEngineVersion: pin,
    supportedRulesEngineVersions: continuation.capability.rules.supported,
    build: options.build,
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
  });

  /** Deliver a per-game refusal: `reload` then close 4426 (terminal for a protocol-1 link); the fail-closed answer for a
   *  route with nowhere to go (its link ends by itself, as for any game this pool does not continue). */
  const refuseClient = (socket: WebSocket, gameId: string, refusal: ClientRefusal, inReplyTo?: string): void => {
    if (refusal.kind === "reload") {
      /* Said once: a nested push (a view broadcast that drops one socket and re-broadcasts presence) may reach the same
         socket again before its close lands. */
      if (toldToReload.has(socket)) return;
      toldToReload.add(socket);
      clientAnswers.gameReload += 1;
      // eslint-disable-next-line no-console
      console.log(`  client: ${describeClient(clientOfSocket(socket).announcement)} -- reload (${refusal.frame.code}) for ${gameId}; closed ${CLIENT_ANSWER_CLOSE_CODE}`);
      send(socket, answering(refusal.frame, inReplyTo));
      if (socket.readyState === socket.OPEN) socket.close(CLIENT_ANSWER_CLOSE_CODE, CLIENT_ANSWER_CLOSE_REASON);
      return;
    }
    clientAnswers.routeFailClosed += 1;
    // eslint-disable-next-line no-console
    console.log(`  client: ${describeClient(clientOfSocket(socket).announcement)} -- route for ${gameId} has no destination before LIVE-6; answered as not continued here`);
    send(socket, notHereFrame(refusal.pin, inReplyTo));
  };

  /* ==================================================================
      LIVE-6 L6-1: A GAME ANOTHER POOL OWNS -- ITS ROUTE, WHEN THERE IS ONE TO GIVE
     ==================================================================
     The claim was refused by the ownership store (`GameRoutedError` names the owner the table evaluated), so nothing of
     the game was read or served here. When the trusted route table (`options.routes`) gives that pool a destination, a
     protocol-1 socket whose frozen connection verdict is `ok` is told where the game is served -- LIVE-4's route frame,
     then close 4426 -- but only after its principal is authorized to read the game from the record read NOW (an
     outsider of a private game, or an id with no game, gets exactly what no game answers), and only while its session
     still holds. Anything else -- the legacy wire, an operator run, a pool with no destination, a record that could not
     be read -- is answered exactly as before (false: the caller's `unavailable`). The destination is never this pool,
     never an operator run, never a host, and never anything the client sent (`rooms/gameRoutes.ts`). */
  const routes: PoolRoutes = options.routes ?? NO_ROUTES;
  const answerRouted = async (socket: WebSocket, gameId: string, routed: GameRoutedError, op: "read-log" | "read-view"): Promise<boolean> => {
    const client = clientOfSocket(socket);
    if (client.connection.kind !== "ok") return false; // the legacy wire keeps its pre-LIVE-6 answer
    const destination = routes.destinationOf(routed.ownerPool);
    if (destination === null) return false;
    const frame = ownershipRouteFrame(gameId, destination);
    if (frame === null) return false;
    const ctx = contexts.get(socket);
    if (ctx === undefined) return false;
    let record: GameRecord | null = null;
    try {
      record = GAME_ID_PATTERN.test(gameId) ? await recordStore.load(gameId) : null;
    } catch (error) {
      /* A record nobody can read is answered as no game at all (`resolveGame`'s rule); a read that FAILED is not a
         verdict: the caller's answer, as before. */
      if (!isStoreCorrupt(error) && !isStoreIncompatible(error)) return false;
    }
    const now = identityNow();
    const verdict = record === null ? { ok: false as const, code: "not-found", reason: "There is no such game." } : authorize(op, { record, facts: factsFromRecord(record), principalId: ctx.principalId, now, held: false });
    if (socket.readyState !== socket.OPEN) return true;
    /* The session is asked again after the read: a revocation that landed while it was in flight is honoured first. */
    const holds = identity.socketVerdict(ctx, now);
    if (holds !== "ok") {
      closeForSession(socket, holds);
      return true;
    }
    if (!verdict.ok) {
      send(socket, { kind: "error", code: verdict.code, reason: verdict.reason });
      return true;
    }
    clientAnswers.routed += 1;
    // eslint-disable-next-line no-console
    console.log(`  client: ${describeClient(client.announcement)} -- ${gameId} is owned by pool ${routed.ownerPool}: routed to ${frame.wsPath ?? frame.bundlePath}; closed ${CLIENT_ANSWER_CLOSE_CODE}`);
    /* Like a reload: the link ends here, and nothing it sent after this frame is handled. */
    toldToReload.add(socket);
    send(socket, frame);
    socket.close(CLIENT_ANSWER_CLOSE_CODE, CLIENT_ANSWER_CLOSE_REASON);
    return true;
  };

  /** The legacy wire's sentence when protocol 0 is no longer accepted (only in a pool whose capability retired it). */
  const LEGACY_REFUSED_SENTENCE = "This page is out of date for this game server. Reload the page to continue.";
  /**
   * LIVE-4 (L4-3): `legacy-refused` -- a socket that announced nothing, on a pool that no longer accepts protocol 0.
   * Answered ONLY with frames a legacy bundle already understands, each terminal (or harmless) in it: a hello or submit
   * gets `incompatible` (the legacy log link stops and says the sentence), a room op a refused `room-ack`, any other room
   * frame an `error` whose sentence the legacy client shows as-is. Never `reload`, `route` or 4426, and the socket is not
   * closed (a legacy bundle reconnects after a close) -- nor reaped for having no subscription.
   */
  const answerLegacyRefused = (socket: WebSocket, frame: { kind: string; requestId?: unknown; submissionId?: unknown }): void => {
    clientAnswers.legacyRefused += 1;
    switch (frame.kind) {
      case "hello":
      case "submit":
        send(
          socket,
          answering(
            {
              kind: "incompatible",
              reason: LEGACY_REFUSED_SENTENCE,
              why: "client-protocol",
              pinnedRulesEngineVersion: null,
              supportedRulesEngineVersions: continuation.capability.rules.supported,
              build: options.build,
            },
            frame.kind === "submit" ? submissionIdOf(frame) : undefined,
          ),
        );
        return;
      case "room-op":
        send(socket, { kind: "room-ack", requestId: frame.requestId, ok: false, code: "unavailable", reason: LEGACY_REFUSED_SENTENCE });
        return;
      case "presence-set":
        return;
      default:
        send(socket, { kind: "error", code: "unavailable", reason: LEGACY_REFUSED_SENTENCE });
    }
  };
  /** Which games a socket reads -- its room view and its log -- and the reverse (LIVE-2 §4.4). */
  const socketsByGame = new Map<string, Set<WebSocket>>();
  const gamesOfSocket = new Map<WebSocket, Set<string>>();
  const addTo = (index: Map<string, Set<WebSocket>>, key: string, socket: WebSocket) => {
    let set = index.get(key);
    if (set === undefined) {
      set = new Set();
      index.set(key, set);
    }
    set.add(socket);
  };
  const removeFrom = (index: Map<string, Set<WebSocket>>, key: string, socket: WebSocket) => {
    const set = index.get(key);
    if (set === undefined) return;
    set.delete(socket);
    if (set.size === 0) index.delete(key);
  };
  const reindexGames = (socket: WebSocket) => {
    for (const room of gamesOfSocket.get(socket) ?? []) removeFrom(socketsByGame, room, socket);
    const rooms = new Set<string>();
    const logRoom = sockets.get(socket)?.room;
    if (logRoom !== undefined) rooms.add(logRoom);
    const ownedRoom = roomHost?.viewGameOf(socket);
    if (ownedRoom !== undefined) rooms.add(ownedRoom);
    if (rooms.size === 0 || !contexts.has(socket)) {
      gamesOfSocket.delete(socket);
      return;
    }
    gamesOfSocket.set(socket, rooms);
    for (const room of rooms) addTo(socketsByGame, room, socket);
  };
  /** A session that ended for a security reason, or expired: every socket on it closes 4401 (LIVE-2 §4.4). */
  const closeForSession = (socket: WebSocket, why: "expired" | "revoked") => {
    if (socket.readyState !== socket.OPEN && socket.readyState !== socket.CONNECTING) return;
    upgrades.sessionClosed += 1;
    socket.close(4401, why === "expired" ? "session expired" : "session ended");
  };
  /* LIVE-2C: THE ACTIVATION SEAM is at the server-owned room boundary (`rooms/roomHost.ts`): create, join and
     take-seat make the principal durable BEFORE the task that writes a GameRecord naming it. */

  /* ==================================================================
      LIVE-2E: A PROFILE IS REQUIRED TO PLAY
     ==================================================================
     A cookie principal plays only once it has a profile (`identity.isProfiled`). A DEVELOPMENT principal
     (`pr_dev_<claim>`, loopback only) has a synthetic development profile named for its claim -- in development mode
     only, and never stored, exactly like the principal itself -- so local play runs the same gate and the same room
     model. In production a `pr_dev_` principal cannot exist (no cookie maps to one), and this answers `false` anyway. */
  const developmentProfiles = mode === "development" && (identityOptions.devAuthenticator ?? null) !== null;
  const hasProfile = (principalId: string): boolean =>
    principalId.startsWith(DEV_PRINCIPAL_PREFIX) ? developmentProfiles : identity.isProfiled(principalId);
  const profileNameOf = (principalId: string): string | null =>
    principalId.startsWith(DEV_PRINCIPAL_PREFIX) ? (developmentProfiles ? devClaimOf(principalId) : null) : identity.profileName(principalId);
  identity.setHooks({
    onSessionsEnded: (sessionIds) => {
      for (const sessionId of sessionIds) for (const socket of [...(socketsBySession.get(sessionId) ?? [])]) closeForSession(socket, "revoked");
    },
    onStoreFailure: (what, error) => {
      // eslint-disable-next-line no-console
      console.error(`  identity store: ${what} was not recorded -- ${excerpt(error instanceof Error ? error.message : String(error), 300)}`);
    },
  });

  /* ==================================================================
      LIVE-2C: THE SERVER-OWNED ROOM AUTHORITY (rooms/roomHost.ts)
     ================================================================== */
  /* Phase 3 (P3-N035): conduct reports -- their own durable store, read by reviewers only, writing nothing else. */
  const conductSeats: { current: ((gameId: string) => readonly string[]) | null } = { current: null };
  /** CONSOLIDATED FINAL INTEGRATION (the cross-pool reviewer rule): a table's AUTHORITATIVE roster -- the durable,
   *  shared GameRecord, read through the record store every pool reads (never only this pool's index), with this
   *  pool's resident view beside it. Seats, kicked principals and the creator are parties. `null`: not readable now. */
  const tableRosterOf = async (gameId: string): Promise<readonly string[] | null> => {
    if (!GAME_ID_PATTERN.test(gameId)) return [];
    let record: GameRecord | null;
    try {
      record = await recordStore.load(gameId);
    } catch {
      return null;
    }
    const roster = new Set<string>(conductSeats.current?.(gameId) ?? []);
    if (record !== null) {
      for (const seat of record.seats) roster.add(seat.principal_id);
      for (const principal of record.kicked_principals) roster.add(principal);
      roster.add(record.created_by_principal);
    }
    return [...roster];
  };
  /* The clock lane's reporting hook (`ClockConductHook`): every durable clock evidence event, kept per table in this
     process so a report carries the clock's own facts (`conduct/conductClockFacts.ts`; never a clock re-derived). */
  const conductClockFeed = createConductClockFeed();
  const conduct = createConductService({
    store: options.conduct?.store ?? null,
    build: options.build,
    now: identityNow,
    // eslint-disable-next-line no-console
    warn: (line) => console.warn(line),
    ...(options.ops !== undefined ? { ops: options.ops } : {}),
    ...(options.conduct?.reporterBudget !== undefined ? { reporterBudget: options.conduct.reporterBudget } : {}),
    /* Who is on a case's table roster NOW (a reviewer seated there, kicked from it or its creator is a party too): the
       durable record every pool reads -- never only this pool's index. */
    tableRosterOf,
  });
  const host: RoomHost = createRoomHost({
    build: options.build,
    conduct,
    /* LIVE-5 L5-3: under POOL ownership the startup discovery writes nothing (it runs before any claim). */
    ...(pooled ? { discoveryReadOnly: true } : {}),
    records: recordStore,
    games,
    identity,
    limits,
    now: identityNow,
    send: (socket, frame) => send(socket, frame),
    contextOf: (socket) => contexts.get(socket),
    ipOf: (socket) => ipOfSocket.get(socket),
    loadChat: async (gameId) => (options.store?.loadChat ? await options.store.loadChat(gameId) : []),
    appendChat: async (gameId, entry) => {
      if (options.store?.appendChat) await options.store.appendChat(gameId, entry);
    },
    rosterSource: options.rosterSource ?? new NoMoneyRosterSource(),
    shuffle: options.shuffle ?? ((items) => cryptoShuffle(items)),
    onSubscriptionChange: (socket) => reindexGames(socket),
    readersOf: (gameId) => socketsByGame.get(gameId) ?? [],
    profileNameOf,
    errorRef,
    // eslint-disable-next-line no-console
    warn: (line) => console.warn(line),
    /* LIVE-3C */
    holds: holdStore,
    logs: {
      listGameLogs: options.store?.listGameLogs?.bind(options.store),
      /* Without a store there are no durable logs at all: every head is known to be empty. A store that cannot peek at
         its logs leaves every head UNKNOWN, and discovery believes no record's lifecycle then (`lifecycle.ts`). */
      readHead: options.store ? options.store.readHead?.bind(options.store) : async () => ({ present: false, size: 0, first: null }),
    },
    ops,
    settlement: options.settlement ?? NO_MONEY_SETTLEMENT,
    /* LIVE-4 (L4-2): this pool's continuation answers (discovery reads the gameplay half from a log's first line), and
       the settlement index the room host refreshes a new money table into before its first session exists. */
    continuation,
    moneyFacts: options.moneyFacts ?? NO_MONEY_FACTS,
    ...(options.escrow !== undefined ? { escrow: options.escrow } : {}),
    ...(options.money !== undefined ? { money: options.money } : {}),
    ...(options.freeTables !== undefined ? { freeTables: options.freeTables } : {}),
    boardFacts,
    /* Phase 3 final clocks */
    ...(options.clock !== undefined ? { clock: { ...options.clock, now: clockTime, conduct: chainClockHooks(options.clock.conduct, conductClockFeed.hook) } } : {}),
    conductClockFeed,
    stampAt,
    /* LIVE-4 (L4-3): the room channel's client check. A game this pool does not continue is shown as such by its view
       (`holdKind: "incompatible"`, with its reason), so only a `reload` refuses a room socket. */
    clientMayRead: (socket, gameId, view) => {
      const refused = clientRefusalFor(socket, gameId, view);
      if (refused === null || refused.kind !== "reload") return true;
      refuseClient(socket, gameId, refused);
      return false;
    },
    /* LIVE-6 L6-1: a room hello for a game another pool owns. */
    answerRouted: (socket, gameId, routed) => answerRouted(socket, gameId, routed, "read-view"),
    statusExtras: () => ({
      store: { restart_required: counters.restartRequired, uncertain: counters.storeUncertain, held_corrupt: counters.heldCorrupt, held_durable: counters.heldDurable, timeouts: counters.storeTimeouts },
      actors: { resident: games.size },
      /* LIVE-4 (L4-6): what compatibility identity this process is actually serving -- the key of the ONE capability
         every session verdict, money seam and client verdict is judged against (`continuation.capability`), its axes,
         and the build id as a diagnostic beside it (never an input to the key). Operator-facing only: nothing reads it
         back and no game mechanic depends on it. */
      compatibility,
      /* LIVE-4 (L4-3 handoff): how often the client verdict answered a reload, a route (fail-closed before LIVE-6) or a
         retired legacy wire. */
      client_answers: { ...clientAnswers },
      ...(options.statusExtras ? options.statusExtras() : {}),
    }),
  });
  conductSeats.current = (gameId) => host.seatPrincipalsOf(gameId);
  roomHost = host;

  /** LIVE-2C (LIVE-2 §14.3 item 5): a log subscriber of a server-owned game is re-authorized on EVERY push, so a
   *  socket that lost read access (kicked, dropped at the deal) stops receiving at once, before its close lands. */
  const ownedSubscriberFor = (socket: WebSocket, gameId: string, principalId: string, game: GameActor): Subscriber => ({
    /* The actor keys in-flight and late answers by the log's actor: the seat's `player_id`, read from the record
       committed at the moment it asks (a watcher that has no seat is keyed by nothing any entry carries). */
    get principal() {
      return host.playerIdOf(gameId, principalId) ?? principalId;
    },
    isOpen: () => socket.readyState === socket.OPEN,
    send: (frame) => {
      const gate = host.canReadLog(socket, gameId);
      if (!gate.ok) {
        if (socket.readyState === socket.OPEN) {
          send(socket, { kind: "error", code: gate.code, reason: gate.reason });
          socket.close(4410, "room access lost");
        }
        return;
      }
      /* LIVE-4 (L4-3): AND THE TAB AGAINST THE GAME, re-checked on every push while the game is undealt -- the publish
         replaced the committed view before this fan-out (E-5), so a deal is judged in the very push that carries it. A
         protocol-1 subscriber whose rules do not include the new pin gets ONE answer instead of the deal and is
         unsubscribed; nothing further reaches it. */
      const refused = clientRefusalFor(socket, gameId, game.view);
      if (refused !== null) {
        unsubscribeLog(socket);
        if (sockets.get(socket)?.room === gameId) {
          sockets.delete(socket);
          reindexGames(socket);
        }
        refuseClient(socket, gameId, refused);
        return;
      }
      send(socket, frame);
    },
  });

  /* LUDUM v1 (docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §2.1, §9): `/gs/api/ludum/v1/*` -- credentialed CORS for the
     Ludum ∪ Play origins on this prefix only, read-only, never a cookie; the real ports over the record index, the money
     layer's financial records and its chain reads. Dispatched BEFORE the money handler (below). */
  const ludumIngress = {
    corsOrigins: new Set<string>([...ludumOriginList, ...allowedOriginList]) as ReadonlySet<string>,
    playOrigin: allowedOriginList[0],
    trustedProxyHops: identityOptions.trustedProxyHops,
    identity,
    limiter: identityLimiter,
    ipBudget: createLudumIpBudget(identityNow, limits.identity),
    ports: createLudumPorts({ records: () => host.records(), money: () => options.money?.() ?? null, now: identityNow }),
    now: identityNow,
    onError: (what: string, error: unknown) => {
      const ref = errorRef();
      // eslint-disable-next-line no-console
      console.error(`  ludum: ${what} failed (ref ${ref}) -- ${excerpt(error instanceof Error ? error.message : String(error), 300)}`);
      return ref;
    },
  };
  /* ESCROW-4: `/gs/api/money/*` (its own per-session budget; the same ingress rules as the identity routes). */
  const moneyLimiter = createMoneyLimiter(identityNow);
  /* P3-ACCT: `/gs/api/trust/*` -- factual trust indicators, derived from the durable records (`rooms/trustFacts.ts`). */
  const trustLimiter = createTrustLimiter(identityNow);
  /* Phase 3 (P3-N035): `/gs/api/conduct/*` -- the review routes (reviewers only; reporting is the table's room op). */
  const conductLimiter = createConductLimiter(identityNow);
  /** A game's committed log, for re-verifying a case's pointer -- READ-ONLY: a resident game's committed view, else the
   *  configured read-only reader. Never `games.get` (that claims and loads a game, and a load can repair or hold it): a
   *  reviewer opening a case must not move any game. Null: "not readable here now". */
  const committedLogOf = async (gameId: string): Promise<readonly ServerLogEntry[] | null> => {
    const resident = games.peek(gameId);
    if (resident !== undefined) {
      const view = resident.view;
      if (view.record === null || view.incompatible !== null || isMaintenanceHold(view.hold)) return null;
      return view.entries;
    }
    if (options.conduct?.readLog === undefined) return null;
    try {
      return await options.conduct.readLog(gameId);
    } catch {
      return null;
    }
  };
  const trustFacts = createTrustFacts({
    profileFacts: (principalId) => (principalId.startsWith(DEV_PRINCIPAL_PREFIX) ? null : identity.trustProfileFacts(principalId)),
    tablesOf: (principalId) => host.tablesOf(principalId),
    financial: async (gameId) => (options.money?.() ?? null)?.financialRecord(gameId) ?? null,
    now: identityNow,
  });
  const http = createServer((req, res) => {
    /* LIVE-5 L5-7: readiness first (AWS storage mode only): it reads no body and no identity. */
    if (options.readiness !== undefined && handleReadiness(req, res, options.readiness)) return;
    /* LIVE-6 L6-6: the staging edge mirror (mounted only by the AWS runtime's staging switch): no body, no identity. */
    if (options.edgeDiagnostic !== undefined && handleEdgeDiagnostic(req, res, options.edgeDiagnostic)) return;
    /* LUDUM v1: its own prefix, before every other `/gs/api/*` handler. */
    if (handleLudumHttp(req, res, ludumIngress)) return;
    if (
      handleMoneyHttp(
        req,
        res,
        {
          allowedOrigins,
          trustedProxyHops: identityOptions.trustedProxyHops,
          identity,
          maxBodyBytes: limits.identity.maxApiBodyBytes,
          now: identityNow,
          money: options.money ?? (() => null),
          onError: (what, error) => {
            const ref = errorRef();
            // eslint-disable-next-line no-console
            console.error(`  money: ${what} failed (ref ${ref}) -- ${excerpt(error instanceof Error ? error.message : String(error), 300)}`);
            return ref;
          },
        },
        moneyLimiter,
      )
    ) {
      return;
    }
    if (
      handleTrustHttp(
        req,
        res,
        {
          allowedOrigins,
          trustedProxyHops: identityOptions.trustedProxyHops,
          identity,
          maxBodyBytes: limits.identity.maxApiBodyBytes,
          now: identityNow,
          facts: trustFacts,
          readableSeats: (gameId, principalId) => host.readableSeats(gameId, principalId, { moneyOnly: true }),
          onError: (what, error) => {
            const ref = errorRef();
            // eslint-disable-next-line no-console
            console.error(`  trust: ${what} failed (ref ${ref}) -- ${excerpt(error instanceof Error ? error.message : String(error), 300)}`);
            return ref;
          },
        },
        trustLimiter,
      )
    ) {
      return;
    }
    if (
      handleConductHttp(
        req,
        res,
        {
          allowedOrigins,
          trustedProxyHops: identityOptions.trustedProxyHops,
          identity,
          maxBodyBytes: limits.identity.maxApiBodyBytes,
          now: identityNow,
          service: conduct,
          reviewers: conductReviewers,
          readLog: committedLogOf,
          onError: (what, error) => {
            const ref = errorRef();
            // eslint-disable-next-line no-console
            console.error(`  conduct: ${what} failed (ref ${ref}) -- ${excerpt(error instanceof Error ? error.message : String(error), 300)}`);
            return ref;
          },
        },
        conductLimiter,
      )
    ) {
      return;
    }
    if (
      handleIdentityHttp(req, res, {
        mode,
        allowedOrigins,
        trustedProxyHops: identityOptions.trustedProxyHops,
        identity,
        limiter: identityLimiter,
        limits: limits.identity,
        now: identityNow,
        onError: (what, error) => {
          const ref = errorRef();
          // eslint-disable-next-line no-console
          console.error(`  identity: ${what} failed (ref ${ref}) -- ${excerpt(error instanceof Error ? error.message : String(error), 300)}`);
          return ref;
        },
      })
    ) {
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("1830 game server\n");
  });

  /* ==================================================================
      LIVE-2A (LIVE-2 §11.3): THE FRAME IS BOUNDED BEFORE IT IS READ
     ==================================================================
     `maxPayload` 32 KiB: a larger frame is closed 1009 by `ws` itself and not a byte of it is parsed -- LIVE-1's
     probe committed a 3 MB field. `perMessageDeflate: false`: no compression is negotiated, so there is no
     deflate bomb to inflate. */
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxPayloadBytes, perMessageDeflate: false });

  /* ==================================================================
      LIVE-2B (LIVE-2 §4.3): EVERY SOCKET IS AUTHENTICATED BEFORE IT EXISTS
     ==================================================================
     `decideUpgrade` runs path, capacity, IP, Origin, authentication and the principal cap in that order, with no
     await anywhere, and `handleUpgrade` completes synchronously on the same tick -- so the socket is registered in
     the indexes before any other upgrade can be counted against them. A refusal is a minimal HTTP response and a
     destroyed socket: no WebSocket object, no `connection` event, nothing to clean up. */
  http.on("upgrade", (request, raw, head) => {
    raw.on("error", () => raw.destroy()); // a peer that resets mid-handshake must not become an uncaught error
    let decision: ReturnType<typeof decideUpgrade>;
    try {
      decision = decideUpgrade(request, {
        mode,
        wsPath: identityOptions.wsPath ?? "/gs",
        /* LIVE-6 L6-1: this pool's own route path (the trusted table's), when there is one. */
        alsoWsPaths: routes.ownWsPaths,
        allowedOrigins,
        allowedOriginList,
        trustedProxyHops: identityOptions.trustedProxyHops,
        identity,
        devAuthenticator: identityOptions.devAuthenticator ?? null,
        limiter: identityLimiter,
        limits: limits.identity,
        counts: {
          global: () => contexts.size,
          forIp: (key) => socketsByIp.get(key)?.size ?? 0,
          forAggregate: (aggregate) => socketsByAggregate.get(aggregate)?.size ?? 0,
          forPrincipal: (principalId) => socketsByPrincipal.get(principalId)?.size ?? 0,
          forSession: (sessionId) => socketsBySession.get(sessionId)?.size ?? 0,
        },
        now: identityNow,
        hasProfile,
      });
    } catch (error) {
      const ref = errorRef();
      // eslint-disable-next-line no-console
      console.error(`  upgrade: the gate failed (ref ${ref}) -- refused 503`, error instanceof Error ? error.message : String(error));
      refuseUpgrade(raw, 503, 5_000);
      return;
    }
    if (!decision.ok) {
      const key = `${decision.step}:${decision.status}`;
      upgrades.refused[key] = (upgrades.refused[key] ?? 0) + 1;
      refuseUpgrade(raw, decision.status, decision.retryAfterMs);
      return;
    }
    const { ctx, ip, client } = decision;
    /* LIVE-4 (L4-3): the connection-level client verdict, judged once against this pool's capability. A throw here
       (a capability that no longer validates -- `continuation` validated it at startup) is the legacy wire's answer:
       never a LIVE-4 frame for a socket nobody judged. */
    let connection: ClientVerdict;
    try {
      connection = clientVerdict(client, continuation.capability, null);
    } catch {
      connection = { kind: "legacy" };
    }
    wss.handleUpgrade(request, raw, head, (socket) => {
      upgrades.accepted += 1;
      contexts.set(socket, ctx);
      clientOf.set(socket, { announcement: client, connection, settled: new Set<string>() });
      addTo(socketsBySession, ctx.sessionId, socket);
      addTo(socketsByPrincipal, ctx.principalId, socket);
      addTo(socketsByIp, ctx.ipKey, socket);
      ipOfSocket.set(socket, ip);
      if (ip.aggregate !== null) {
        aggregateOf.set(socket, ip.aggregate);
        addTo(socketsByAggregate, ip.aggregate, socket);
      }
      wss.emit("connection", socket, request);
    });
  });

  /* LIVE-2B (LIVE-2 §4.4): THE 60-SECOND SWEEP -- idle sockets whose session expired or was revoked close 4401, the
     identity write-behind is flushed, and full limiter buckets are forgotten. */
  const identitySweep = setInterval(() => {
    const now = identityNow();
    for (const [socket, ctx] of contexts) {
      const verdict = identity.socketVerdict(ctx, now);
      if (verdict !== "ok") closeForSession(socket, verdict);
    }
    identityLimiter.prune();
    moneyLimiter.prune();
    roomHost?.prune();
    void identity.sweep(now).catch(() => undefined); // a store failure is reported by the identity hook
  }, limits.identity.sweepIntervalMs);
  identitySweep.unref?.();

  /* LIVE-2A (§12.2): KEEPALIVE. A ping every 25 s; a socket that has not answered one in 60 s is half-open and is
     terminated, so it holds no subscription, no queue slot and no presence entry (LIVE-1 R-7). */
  const lastPong = new Map<WebSocket, number>();
  const keepalive = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      const heard = lastPong.get(client) ?? now;
      if (now - heard > limits.pongTimeoutMs) {
        ingress.keepaliveTerminated += 1;
        client.terminate();
        continue;
      }
      try {
        client.ping();
      } catch {
        /* a socket mid-close; its close handler cleans up */
      }
    }
  }, limits.pingIntervalMs);
  keepalive.unref?.();

  /** Which bucket each frame kind draws on (LIVE-2 §12.2, per socket in LIVE-2A). */
  const BUCKET_FOR: Readonly<Record<string, BucketName>> = Object.freeze(
    Object.assign(Object.create(null) as Record<string, BucketName>, {
      submit: "submit",
      "chat-send": "chat",
      "presence-set": "presence",
      hello: "hello",
      "room-hello": "control",
      /* LIVE-2C: the server-owned room protocol -- LIVE-2D: the only one. */
      "room-op": "roomOps",
      "rooms-watch": "control",
    }),
  );

  wss.on("connection", (socket) => {
    /* LIVE-2B: THE FROZEN CONTEXT, set by the upgrade before this event -- never from a frame. */
    const ctx = contexts.get(socket) as ConnectionContext;
    /* LIVE-4 (L4-3): THE CLIENT, judged at the upgrade. A protocol-1 client this pool cannot talk to is told so at once
       -- `reload`, then close 4426 -- and nothing it sends is handled; its close below cleans up like any other. */
    const client = clientOfSocket(socket);
    const connectionAnswer = clientAnswerFor(client.connection);
    if (connectionAnswer.kind === "reload") {
      clientAnswers.connectionReload += 1;
      // eslint-disable-next-line no-console
      console.log(`  client: ${describeClient(client.announcement)} -- reload (${connectionAnswer.frame.code}); closed ${CLIENT_ANSWER_CLOSE_CODE}`);
      send(socket, connectionAnswer.frame);
      socket.close(CLIENT_ANSWER_CLOSE_CODE, CLIENT_ANSWER_CLOSE_REASON);
    }
    /** LIVE-2C (LIVE-2 §12.2): a socket that authenticated but never subscribed to anything is closed after 60 s.
     *  LIVE-4 (L4-3): not a legacy socket this pool refuses -- a close would only make a legacy bundle reconnect. */
    const reapTimer = setTimeout(() => {
      if (client.connection.kind === "legacy-refused") return;
      const subscribed = sockets.has(socket) || host.hasSubscription(socket);
      if (!subscribed && socket.readyState === socket.OPEN) {
        upgrades.reaped += 1;
        socket.close(1000, "no subscription");
      }
    }, limits.rooms.unsubscribedReapMs);
    reapTimer.unref?.();
    /** LIVE-2 §4.4: on EVERY inbound frame, a session that has expired or been revoked closes the socket 4401. */
    const sessionHolds = (): boolean => {
      const verdict = identity.socketVerdict(ctx, identityNow());
      if (verdict === "ok") return true;
      closeForSession(socket, verdict);
      return false;
    };
    /** LIVE-2 §11.4 item 2: a malformed-flood close counts against the socket's IP key; three in ten minutes and
     *  that key's upgrades are refused for five. */
    const recordMalformedClose = () => {
      if (identityLimiter.cooldowns.record(ctx.ipKey)) {
        upgrades.malformedCooldowns += 1;
        // eslint-disable-next-line no-console
        console.warn(`  ingress: an address closed ${limits.identity.malformedClosesForCooldown} times for malformed frames -- its upgrades are refused for ${Math.round(limits.identity.malformedCooldownMs / 1000)} s`);
      }
    };
    /* ==================================================================
        DESIGN NOTE 1216: TWO FRAMES, ONE SOCKET, AND THE HANDLER THAT YIELDED
       ==================================================================
       REPORTED: "Clicking Host Game completely bypassed the waiting room and went straight to a game... At
       the bottom of the Auction tab screen there are no Players listed."

       THE ROOM WAS NEVER CREATED. The client opens its socket, sends `room-hello`, and immediately sends the
       queued `room-write` that hosts the room -- back to back, because nothing tells it to wait. The
       WebSocket delivers them in that order and this handler ran them in that order too, but the FIRST one
       AWAITS `resolveIdentity`. An `async` function that awaits yields the thread, so the second frame's
       handler started while the first was still suspended, found the socket not yet registered, and answered
       "say room-hello first". The write was dropped. The client then heard `{doc: null}`, `sandboxRoom` was
       null rather than "waiting", and the render fell straight through the waiting room into the game.

       SO FRAMES FROM ONE SOCKET ARE APPLIED IN THE ORDER THEY WERE SENT, by chaining each onto the last.
       `ws` delivers in order; it is the async handler that broke the guarantee, and awaiting a promise per
       socket restores it. Per socket rather than globally: one slow client must not stall the room.

       AND THE LOG PATH HAD THE SAME LATENT RACE -- `hello` also awaits `resolveIdentity`, and a client that
       submits before its catch-up arrives would have been told "say hello first". Nothing did that yet. The
       fix covers both because the queue is above the frame kinds, not inside one of them.

       THE SMOKE TEST IS WHY THIS REACHED A BROWSER, and that is the lesson worth keeping. It awaited the
       reply to `room-hello` before writing, so it was POLITE IN A WAY NO REAL CLIENT IS -- it tested a
       sequence the app never performs. `smokeTest.ts` now sends the pair back to back, exactly as the
       browser does. A harness that waits where the product does not is a harness that proves the wrong
       thing. */
    let inOrder: Promise<void> = Promise.resolve();

    /* LIVE-2A: this socket's own bounds -- its pending frames, its buckets, and its keepalive. */
    let pendingFrames = 0;
    const buckets = new SocketBuckets(limits, () => Date.now());
    lastPong.set(socket, Date.now());
    socket.on("pong", () => lastPong.set(socket, Date.now()));
    /* LIVE-2A: `ws` closes an oversize frame 1009 ITSELF and then reports it as an `error` on the socket -- which,
       with no listener, would throw out of the event loop and take the whole server down with one frame. Said in
       the window; the close that follows cleans up. */
    socket.on("error", (error) => {
      // eslint-disable-next-line no-console
      console.warn(`  ingress: socket error -- ${excerpt(error instanceof Error ? error.message : String(error), 200)}`);
      /* LIVE-2 §11.4 item 3: an oversize frame (1009) counts as malformed for the cooldown. */
      if ((error as { code?: unknown }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") recordMalformedClose();
    });

    /** A frame that is not one this server accepts: counted against the socket's malformed budget, logged as a
     *  bounded excerpt, and answered with a fixed sentence -- `refused` for a submit, so the shell's latch releases
     *  (#1449), `error` otherwise. */
    const badFrame = (raw: unknown, kind: string | null, reason: string, submissionId: string | undefined): void => {
      if (socket.readyState !== socket.OPEN) return; // closing already: nothing more is counted or answered
      ingress.badFrames += 1;
      // eslint-disable-next-line no-console
      console.log(`  bad-frame: ${reason} -- ${excerpt(String(raw), limits.logExcerptBytes)}`);
      if (buckets.take("malformed") > 0) {
        ingress.malformedClosed += 1;
        // eslint-disable-next-line no-console
        console.warn("  ingress: closed a socket for a malformed-frame flood -- 1008");
        socket.close(1008, "malformed frames");
        recordMalformedClose();
        return;
      }
      if (kind === "submit") {
        send(socket, answering({ kind: "refused", code: BAD_FRAME_CODE, reason, build: options.build }, submissionId));
      } else {
        send(socket, { kind: "error", code: BAD_FRAME_CODE, reason });
      }
    };

    /** Over a bucket: answered in the frame each caller already listens for, never appended, never nonce-consuming. */
    const rateLimited = (frame: ClientFrame, bucket: BucketName, retryAfterMs: number): void => {
      if (socket.readyState !== socket.OPEN) return; // closing already: nothing more is counted or answered
      ingress.rateLimited += 1;
      ingress.rateLimitedByBucket[bucket] = (ingress.rateLimitedByBucket[bucket] ?? 0) + 1;
      buckets.consecutiveLimited += 1;
      if (buckets.consecutiveLimited >= limits.maxConsecutiveRateLimited) {
        ingress.rateLimitClosed += 1;
        // eslint-disable-next-line no-console
        console.warn(`  ingress: closed a socket after ${buckets.consecutiveLimited} consecutive rate-limited frames -- 4429`);
        socket.close(4429, "rate limited");
        return;
      }
      switch (frame.kind) {
        case "room-op":
          /* LIVE-2C: a named operation is answered in its own ack, with the retry hint. */
          send(socket, { kind: "room-ack", requestId: frame.requestId, ok: false, code: RATE_LIMITED_CODE, reason: RATE_LIMITED_REASON, retryAfterMs });
          return;
        case "submit":
          send(
            socket,
            answering(
              { kind: "refused", code: RATE_LIMITED_CODE, reason: SUBMIT_RATE_LIMITED_REASON, retryAfterMs, build: options.build },
              submissionIdOf(frame),
            ),
          );
          return;
        case "presence-set":
          return; // a hint over its rate is dropped; the next one supersedes it anyway
        default:
          send(socket, { kind: "error", code: RATE_LIMITED_CODE, reason: RATE_LIMITED_REASON, retryAfterMs });
      }
    };

    const handleFrame = async (raw: unknown): Promise<void> => {
      /* LIVE-4 (L4-3): a client told `reload` -- at the connection, or for a game -- is closing; nothing it sent is
         handled (a room op queued behind the refused room-hello would otherwise still run). */
      if (client.connection.kind === "reload" || toldToReload.has(socket)) return;
      /* LIVE-2B: checked again when the frame's turn comes -- a revocation while it waited behind others counts. */
      if (!sessionHolds()) return;
      /* ==================================================================
          DESIGN NOTE 1449: THE PARSE IS NOT THE CHECK
         ==================================================================
         `JSON.parse` answers "was that JSON", and the `as` answered nothing at all -- a cast is a promise
         to the compiler that the wire never made. What followed was twelve `if (frame.kind === ...)`
         tests, so a frame that was a number, an array, or an object with no `kind` fell through all
         twelve and was dropped in silence: no answer to the client, no line in the window.
         TWO CHECKS, AT DIFFERENT DEPTHS. This one is thin on purpose -- "is this addressed to something
         that exists" -- because the lobby, chat and roster frames never reach the reducer or the log. The
         gameplay frame gets the real one, at the `submit` branch below, where a malformed message would
         otherwise become a permanent log entry. */
      /* ==================================================================
          LIVE-2A (LIVE-2 §11.1-§11.4): CLOSED FRAMES, FIXED ANSWERS, A BUDGET FOR MALFORMED ONES
         ==================================================================
         Every control frame now has a CLOSED schema (`parseClientFrame`): an unknown field, a field of the wrong
         shape, an overlong one, or a `__proto__` / `constructor` / `prototype` key anywhere is `bad-frame` -- with a
         fixed sentence that never echoes the frame's own kind, keys or text. Ten malformed frames a minute close the
         socket 1008. Then each kind draws on its bucket (§12.2); twenty consecutive `rate-limited` answers close
         it 4429. Only then is anything about the frame believed. */
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        badFrame(raw, null, "That frame is not JSON.", undefined);
        return;
      }
      const checked = parseClientFrame(parsed);
      if (!checked.ok) {
        badFrame(raw, checked.kind, checked.reason, submissionIdOf(parsed));
        return;
      }
      const frame = checked.frame as unknown as ClientFrame;
      const bucket = BUCKET_FOR[frame.kind];
      const wait = bucket === undefined ? 0 : buckets.take(bucket);
      if (wait > 0) {
        rateLimited(frame, bucket as BucketName, wait);
        return;
      }
      buckets.consecutiveLimited = 0;

      /* LIVE-2E: DEFENCE IN DEPTH -- and P3-ACCT (owner, 2026-10-05: public first): THE SIGNED-OUT ALLOW-LIST. A socket
         whose principal has no profile (a visitor who has not signed in) may send exactly the PUBLIC READS: the public
         list (`rooms-watch`), a table's view (`room-hello`) and a table's log (`hello`) -- each still authorized per
         frame against the record (`roomAuthz.ts`: a private table is `not-found` to it; a visitor holds no seat, so a
         public one is read as any watcher reads it: Watch is read-only, OD-19 -- the one exception, a principal from
         before profiles that still holds seats ("has-tables"), reads its OWN seated tables as their seat-holder, and
         still can act on none of them). Every other frame -- create, join, a seat, a
         move, chat, presence, "Your tables", any room op -- is answered `profile-required` before any game is looked
         up, so nothing about a table's existence is said. A profile is never taken away (a disabled one ends every
         session, 4401). */
      const publicRead = frame.kind === "rooms-watch" || frame.kind === "room-hello" || frame.kind === "hello";
      if (!hasProfile(ctx.principalId) && !publicRead) {
        const reason = "Log in or create an account to do that.";
        if (frame.kind === "room-op") {
          send(socket, { kind: "room-ack", requestId: (frame as unknown as { requestId: string }).requestId, ok: false, code: "profile-required", reason });
        } else if (frame.kind === "submit") {
          send(socket, answering({ kind: "refused", code: "profile-required", reason, build: options.build }, submissionIdOf(frame)));
        } else if (frame.kind !== "presence-set") {
          send(socket, { kind: "error", code: "profile-required", reason });
        }
        return;
      }

      /* LIVE-4 (L4-3): protocol 0 retired on this pool -- answered only with what a legacy bundle understands. */
      if (client.connection.kind === "legacy-refused") {
        answerLegacyRefused(socket, frame as unknown as { kind: string; requestId?: unknown; submissionId?: unknown });
        return;
      }

      /* ==================================================================
          LIVE-2D: ONE ROOM PROTOCOL, BY `gameId`
         ==================================================================
         The legacy room frames are not in the closed schema any more, so they never get this far: `parseClientFrame`
         answered them `bad-frame` above, exactly like any kind this server has never heard of -- in development as in
         production. There is no compatibility translation and no legacy registry to fall through to. */
      const routedGame = (frame as unknown as { gameId?: unknown }).gameId;
      const gameId = typeof routedGame === "string" ? routedGame : null;
      if (frame.kind === "room-op") {
        await host.handleRoomOp(socket, frame as unknown as { requestId: string; gameId?: string; op: Record<string, unknown> });
        return;
      }
      if (frame.kind === "rooms-watch") {
        await host.handleRoomsWatch(socket, (frame as unknown as { on: boolean }).on);
        return;
      }
      if (frame.kind === "room-hello" && gameId !== null) {
        await host.handleRoomHello(socket, gameId);
        return;
      }
      if (frame.kind === "chat-send" && gameId !== null) {
        await host.handleChat(socket, gameId, (frame as unknown as { text: string }).text);
        return;
      }
      if (frame.kind === "presence-set" && gameId !== null) {
        host.handlePresence(socket, gameId, (frame as unknown as { state: unknown }).state);
        return;
      }
      if (frame.kind === "hello" && gameId !== null) {
        /* LIVE-2C: the log of a server-owned game -- read access per §6.3 #6, re-checked on every push. An unknown
           id is answered from the negative cache or one store read: it never allocates a session (§11.4 item 4). */
        let game: GameActor | null;
        try {
          game = await host.actorFor(gameId);
        } catch (error) {
          /* LIVE-3C: the store could not be read just now -- said as such, and tried again at the next hello. */
          if (error instanceof GameUnavailableError) {
            /* LIVE-6 L6-1: owned by another pool -- its route, when there is one to give (see `answerRouted`). */
            if (error.routed !== null && (await answerRouted(socket, gameId, error.routed, "read-log"))) return;
            /* ... to a principal the game already lets read it; anybody else is told what no game at all answers. */
            send(socket, { kind: "error", ...host.unavailableFor(gameId, ctx.principalId) });
            return;
          }
          throw error;
        }
        if (game === null) {
          send(socket, { kind: "error", code: "not-found", reason: "There is no such game." });
          return;
        }
        const gate = host.canReadLog(socket, gameId);
        if (!gate.ok) {
          send(socket, { kind: "error", code: gate.code, reason: gate.reason });
          return;
        }
        /* The viewer cap counts log readers too (review L5): a watcher cannot pass it by skipping the room view. */
        if (sockets.get(socket)?.room !== gameId && !host.viewerRoomFor(socket, gameId)) {
          send(socket, { kind: "error", code: "room-full", reason: "This table has as many watchers as it takes." });
          return;
        }
        /* LIVE-4 (L4-3): THE TAB AGAINST THE GAME, before a single entry is sent: a protocol-1 tab whose rules do not
           include the game's pin gets no catch-up -- `reload` (and 4426), or, with nowhere to route it before LIVE-6,
           the answer a game this pool does not continue gets. After the read gate, so it says nothing to a stranger. */
        const refused = clientRefusalFor(socket, gameId, game.view);
        if (refused !== null) {
          refuseClient(socket, gameId, refused);
          return;
        }
        sockets.set(socket, { room: gameId, principalId: ctx.principalId });
        reindexGames(socket);
        const helloFrame = frame as unknown as { baseIndex?: unknown; baseId?: unknown; pages?: unknown };
        /* Phase 3 final clocks: a client that reassembles paged catch-ups says so in its hello. */
        if (helloFrame.pages === 1) pagedSockets.add(socket);
        else pagedSockets.delete(socket);
        const fromIndex = Number.isInteger(helloFrame.baseIndex) && (helloFrame.baseIndex as number) >= -1 ? (helloFrame.baseIndex as number) : -1;
        const baseId = typeof helloFrame.baseId === "string" ? helloFrame.baseId : undefined;
        unsubscribeLog(socket);
        const subscribed = game.subscribe(socket, ownedSubscriberFor(socket, gameId, ctx.principalId, game), fromIndex, baseId);
        if (subscribed.kind === "subscribed") {
          logSubscriptions.set(socket, game);
          return;
        }
        if (subscribed.kind === "held") {
          send(socket, subscribed.frame);
          return;
        }
        counters.helloResync += 1;
        send(socket, { kind: "error", code: "resync", reason: subscribed.reason, watermark: subscribed.watermark });
        return;
      }

      if (frame.kind === "submit") {
        /* LIVE-3A (L3-3): EVERY DIRECT ANSWER NAMES THE SUBMISSION IT ANSWERS, the refusals before the actor
           included. The actor serializes a room, so another player's fan-out now reaches this socket before
           its own queued answer, and a client matching replies first-in-first-out took the other player's
           index for its own (LIVE-3 P4). */
        const inReplyTo = submissionIdOf(frame);
        const answer = (message: object) => send(socket, answering(message, inReplyTo));
        const attached = sockets.get(socket);
        if (!attached) {
          answer({ kind: "error", reason: "say hello first" });
          return;
        }
        /* ==================================================================
            DESIGN NOTE 1449: REFUSED BEFORE THE SESSION, NOT INSIDE IT
           ==================================================================
           MEASURED, not supposed: `{}`, `[]`, `{Nonsense:{}}`, `{BuyStock:{}}`, a `protocol_id` of
           `"x"` or `NaN`, a `percentage` of `Infinity`, a fractional hex and two discriminants in one
           object were every one of them answered `applied` and appended a permanent entry to the room's
           log. The reducer no-opped most of them, which is why nobody noticed: the BOARD was unchanged and
           the HISTORY was not, and `logHash` commits over the history.
           SO THE REFUSAL HAS TO LAND HERE, before the room's actor. Inside `RoomSession.submit` the append is
           the commit point (#1209) and the authority runs before it -- but the authority asks whose turn
           it is, which is a question about a message that has already been assumed to be one. A frame
           that is not a move must not reach a function whose job is deciding whose move it is.
           THE EXISTING TRANSPORT CARRIES IT. `refused` is what the shell already understands and already
           surfaces (#1218), so a malformed frame is answered the same way an illegal one is. */
        /* LIVE-2A (§11.1, §11.2): PARSE, DON'T VALIDATE. What reaches the actor is `parseGameplayMessage`'s NEW
           object, rebuilt from the declared fields alone -- nested waypoints, the deal's players, the variants,
           `token_cities` pairs -- so an undeclared field (or a megabyte of one) can never become part of the
           permanent, hashed log. `submissionId` is required and bounded. A malformed submit spends the socket's
           malformed budget like any other malformed frame, and its payload is logged as a bounded excerpt. */
        const envelope = validateSubmitEnvelope(frame);
        const shape = envelope.ok ? parseGameplayMessage(frame.msg) : envelope;
        if (!shape.ok) {
          badFrame(JSON.stringify(frame.msg) ?? "", "submit", shape.reason, inReplyTo);
          return;
        }
        if (!("value" in shape)) return; // the envelope's own verdict carries no message; unreachable when ok
        if (shape.stripped > 0) {
          ingress.stripped += shape.stripped;
          // eslint-disable-next-line no-console
          console.log(`  ingress: stripped ${shape.stripped} undeclared field(s) from a ${shape.kind} (LIVE-2 §11.2)`);
        }
        const parsedFrame: SubmitFrame = { ...frame, msg: shape.value as unknown as SandboxLogMsg };
        /* LIVE-2C (§6.3 #20): the deal is built by `start-game`; a client's is refused. LIVE-2D: every game is
           server-owned, so no client ever deals. */
        if ("SetupGame" in parsedFrame.msg) {
          answer({ kind: "refused", code: BAD_FRAME_CODE, reason: SERVER_DEALS_REASON, build: options.build });
          return;
        }

        let game: GameActor;
        try {
          game = await games.get(attached.room);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`  store: could not load ${attached.room} for a submit`, error);
          answer({ kind: "refused", code: "unavailable", reason: LOAD_FAILED_REASON, build: options.build });
          return;
        }
        /* LIVE-3 §4 STEPS 2-17 ARE ONE TASK ON THE ROOM'S ACTOR (`submitOnActor`). It starts only after every
           task queued before it has published or rolled back, and nothing it does is visible until the store
           has it. Awaited here, so this socket's frames stay in the order it sent them (#1216). */
        /* LIVE-2C (RV-1): the seat gate BEFORE the actor, against the committed record -- and again inside the task,
           against the record committed when it runs, and a third time at `RoomSession.submit` step 1b. */
        const committedRecord = game.view.record;
        const seatNow = committedRecord === null ? null : seatOf(committedRecord, attached.principalId);
        if (seatNow === null) {
          answer({ kind: "refused", code: "not-seated", reason: "You do not have a seat in this game.", build: options.build });
          return;
        }
        const originKey = seatNow.player_id;
        const outcome = await game.run("submit", (tx) => submitOnActor(tx, game, socket, attached, parsedFrame, inReplyTo), {
          origin: originFor(socket, originKey, inReplyTo),
        });
        if (outcome.kind === "busy") {
          answer({ kind: "refused", code: "busy", reason: BUSY_REASON, build: options.build });
        } else if (outcome.kind === "expired") {
          // E-8: never ran, so nothing happened and the game is not held -- the client may simply act again.
          answer({ kind: "refused", code: "retry", reason: EXPIRED_REASON, build: options.build });
        } else if (outcome.kind === "failed") {
          // The task threw outside its own guard; the actor rolled it back (E-9). Said, with a reference.
          counters.internal += 1;
          const ref = errorRef();
          // eslint-disable-next-line no-console
          console.error(`  threw: a submit task for ${attached.room} failed (ref ${ref}); rolled back`, outcome.error);
          answer({ kind: "refused", code: "internal", reason: MOVE_INTERNAL_REASON(ref), build: options.build });
        }
        return;
      }
    };

    socket.on("message", (raw) => {
      /* LIVE-2B (LIVE-2 §4.4): EVERY INBOUND FRAME first asks whether the socket's session still holds. */
      if (!sessionHolds()) return;
      /* LIVE-2A (§11.3): AT MOST 64 FRAMES IN FLIGHT PER SOCKET. The in-order chain below is a queue, and a queue
         a client can lengthen at will is memory a client can take; past the cap the socket is closed 1008. */
      if (pendingFrames >= limits.maxPendingFrames) {
        if (socket.readyState === socket.OPEN) {
          ingress.pendingOverflowClosed += 1;
          // eslint-disable-next-line no-console
          console.warn(`  ingress: closed a socket with ${pendingFrames} frames in flight -- 1008`);
          socket.close(1008, "too many frames in flight");
        }
        return;
      }
      pendingFrames += 1;
      inOrder = inOrder.then(async () => {
        try {
          await handleFrame(raw);
        } catch (error) {
          /* LIVE-2A (§11.5): EVERY HANDLER'S THROW IS ANSWERED WITH A REFERENCE, NEVER ITS TEXT. */
          ingress.internal += 1;
          const ref = errorRef();
          // eslint-disable-next-line no-console
          console.error(`  threw: a frame handler failed (ref ${ref})`, error);
          send(socket, { kind: "error", code: "internal", reason: INTERNAL_REASON(ref) });
        } finally {
          pendingFrames -= 1;
        }
      });
      /* A THROWN HANDLER MUST NOT POISON THE CHAIN. Without this, one bad frame would reject `inOrder` and
         every later frame on this socket would be skipped silently -- a socket that stops working with no
         error anywhere, which is the hardest kind of fault to find. */
      inOrder = inOrder.catch(() => undefined);
    });

    socket.on("close", () => {
      /* NOTHING IS ROLLED BACK ON A DISCONNECT, and #1209 is why: the append is the commit point and the
         response is only news. A player who vanishes mid-burst has still made their move, and the burst
         finishes itself on the next submission.
         LIVE-3A (E-8): A RUNNING TASK FINISHES -- its commit stands, and a reconnecting hello reports it in
         `inFlight` until it does. What this socket QUEUED and had not started is cancelled now, so it never
         runs after the player has gone and a reconnecting hello never reports it as pending. */
      lastPong.delete(socket);
      games.forEach((game) => game.cancelQueuedFrom(socket));
      unsubscribeLog(socket);
      sockets.delete(socket);
      /* #1215: the seat stays the player's. A closed tab is not a player leaving the table -- they refresh, they lose
         wifi, they come back -- and the seat is the principal's in the GameRecord, whatever its sockets do.
         #1361a: PRESENCE DOES NOT OUTLIVE THE SOCKET -- `dropSocket` clears it with the room view (roomHost.ts).
         LIVE-2C: out of the server-owned room subscriptions and the reap. A close handler has no caller to answer:
         nothing may escape it, and the identity cleanup below must always run (review H1). */
      clearTimeout(reapTimer);
      try {
        host.dropSocket(socket);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`  rooms: dropping a closed socket's room subscriptions failed (ref ${errorRef()})`, error);
      }
      ipOfSocket.delete(socket);
      /* LIVE-2B: out of every identity index. LIVE-4 (L4-3): and its client. */
      contexts.delete(socket);
      clientOf.delete(socket);
      reindexGames(socket);
      removeFrom(socketsBySession, ctx.sessionId, socket);
      removeFrom(socketsByPrincipal, ctx.principalId, socket);
      removeFrom(socketsByIp, ctx.ipKey, socket);
      const aggregate = aggregateOf.get(socket);
      if (aggregate !== undefined) removeFrom(socketsByAggregate, aggregate, socket);
      aggregateOf.delete(socket);
    });
  });

  http.listen(options.port, options.bindHost ?? GAME_SERVER_BIND_HOST);

  return {
    http,
    counters,
    ingress,
    limits,
    identity,
    identityLimiter,
    upgrades,
    /* LIVE-4 (L4-3): what clients were told -- connection-level reloads, per-game reloads, routes answered as not
       continued here (no destination before LIVE-6), and legacy frames answered on a pool that retired protocol 0. */
    clientAnswers,
    records: recordStore,
    rooms: host,
    /** Phase 3 final clocks: the table clock (null when not configured). */
    clock: host.clock,
    residentGames: () => games.size,
    /** LIVE-5 L5-3 (tests): evict the actors idle as of `at` -- the registry's own sweep, run now. */
    evictIdleGames: (at: number) => games.evictIdle(at),
    /** LIVE-5 L5-3: the money claim sweep's `beforeRetake` and `isResident` (L5-7 wires them). */
    retakeResident,
    isResident: (gameId: string) => games.peek(gameId) !== undefined,
    releasableResidentGames: () => {
      const out: string[] = [];
      games.forEach((actor, gameId) => {
        if (releasable(actor)) out.push(gameId);
      });
      return out;
    },
    lifecycle: {
      ready: host.indexReady,
      inventory: host.inventory,
      discovery: host.discovery,
      holds: holdStore,
      ops,
      /* ESCROW-3A (brief §6): the money games this server's index knows, and a game's ordinary load (LIVE-3C's
         reconciliation) -- what the settlement coordinator's startup walk needs. */
      financialGameIds: host.financialGameIds,
      financialRecords: host.financialRecords,
      loadGame: async (gameId: string) => {
        await host.actorFor(gameId);
      },
      /* LIVE-4 (L4-2): this pool's capability (built once) and the serving review the sweep runs (tests drive it). */
      capability: continuation.capability,
      continuation,
      reviewServing: () => host.reviewServing(),
      reviewContinuation: () => host.reviewServing({ continuation: true }),
    },
    socketCounts: () => ({
      total: contexts.size,
      bySession: (id: string) => socketsBySession.get(id)?.size ?? 0,
      byPrincipal: (id: string) => socketsByPrincipal.get(id)?.size ?? 0,
      byIp: (key: string) => socketsByIp.get(key)?.size ?? 0,
      byGame: (room: string) => socketsByGame.get(room)?.size ?? 0,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(keepalive);
        clearInterval(identitySweep);
        host.clock?.close();
        games.close();
        for (const socket of contexts.keys()) socket.close(1001, "server stopping");
        try {
          host.flushStatus();
        } catch {
          /* best effort: the status snapshot never stops a close */
        }
        void identity
          .flush(identityNow())
          .catch(() => undefined) // reported by the identity hook
          .then(() => ops.flush().catch(() => undefined))
          .then(() => wss.close(() => http.close(() => resolve())));
      }),
  };
}
