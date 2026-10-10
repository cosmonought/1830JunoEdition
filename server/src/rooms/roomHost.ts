// server/src/rooms/roomHost.ts
//
// ==================================================================
//  LIVE-2C: THE SERVER-OWNED ROOM PROTOCOL, WIRED TO THE GAME ACTORS
// ==================================================================
//
// The transport half of `roomService.ts`: frames in (`room-op`, `room-hello {gameId}`, `chat-send {gameId}`,
// `presence-set {gameId}`, `rooms-watch`), answers and fan-out out (`room-ack`, `room`, `chat`, `presence`, `rooms`,
// `error`). The authority is `roomAuthz.ts`, asked per frame against the CURRENT committed record; the mutation is a
// task on the game's actor (LIVE-3A), so check and mutate happen in one step, the record is durable before anyone
// sees it, and a room op is serialized with every submit of the same game.
//
// THE CONCURRENCY CONTRACT (LIVE-2 §14.3), as the actor gives it:
//   one tick         a task computes the next record from `tx.view.record` with no await before `commitRecord`
//                    (the only awaits before it are a join-code claim, inside the same task, where nothing else runs)
//   deal latch       start-game is one task: nothing else of this game runs while its deal is being appended
//   write queue      the actor IS the per-game queue; `commitRecord` is conditional on `record_version` (OCC)
//   single flight    `GameRegistry.get` loads each game once; a game with queued work or subscribers is not evicted
//   re-check         every push (room views here, log fan-out through `canReadLog`) re-authorizes against the
//                    record as committed at that moment, so a socket that lost access stops receiving at once
//
// ACTIVATION BEFORE REFERENCE (LIVE-2B §2 -> LIVE-2C §7): create, join and take-seat make the principal durable
// BEFORE the actor task that writes a record naming it. Activation that succeeds while the room op then fails
// leaves a harmless activated principal with no seat; the inverse cannot happen.

import { effectiveActions, dealEntryOf, revertTargetOf } from "../../../frontend/src/gameEngine/logRevert";
import { resolveVariants } from "../../../frontend/src/gameEngine/gameVariants";
import { sanitizeText } from "../../../frontend/src/gameEngine/messageSchema";
import type { RoomChatEntry } from "../../../frontend/src/utils/roomProtocol";
import type { ConductService } from "../conduct/conductService";
import { conductClockEvidenceOf, type ConductClockEvidence, type ConductClockFeed } from "../conduct/conductClockFacts";
import type { GameClockRecord } from "./clock/clockRecord";
import type { PresenceState } from "../../../frontend/src/utils/presence";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import type { ServerMessage } from "../../../frontend/src/utils/serverProtocol";
import type { WebSocket } from "ws";

import type { RoomSession } from "../../../frontend/src/utils/roomSession";
import type { GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import { RULES_ENGINE_VERSION, SUPPORTED_RULES_ENGINE_VERSIONS } from "../../../frontend/src/gameEngine/rulesVersion";

import type { LogHeadRead } from "../fileLogStore";
import type { ConnectionContext } from "../identity/authenticateUpgrade";
import type { IpKey } from "../identity/clientIp";
import type { IdentityService } from "../identity/sessions";
import { IpBuckets, KeyedBuckets, type IngressLimits } from "../ingress/limits";
import { NO_OPS, type OpsRecorder } from "../persistence/opsRecorder";
import { isStoreCorrupt, isStoreIncompatible } from "../persistence/storeResult";
import { isMaintenanceHold, type CommittedView } from "./committedView";
import { countByClass, discoverGames, summaryLine, type DiscoveredGame, type DiscoveryReport } from "./discovery";
import type { GameActor, Tx } from "./gameActor";
import { GameRoutedError } from "./gameOwnership";
import {
  effectiveStatus,
  isTerminal,
  mintGameId,
  mintJoinCode,
  mintPlayerId,
  parseJoinCode,
  roomSummaryOf,
  roomViewFor,
  seatOf,
  type GameMoneyTerms,
  type GameRecord,
  type HoldKind,
  type LogFacts,
  type PublicSeatName,
  type RoomSummary,
  myTableSummaryOf,
  type MyTableState,
  type MyTableSummary,
} from "./gameRecord";
import { createMemoryHoldStore, type HoldStore } from "./holdStore";
import { createClockController, rescindExpiredOffer, type ClockAnswer, type ClockController, type ClockOpInput, type ClockTimers, type ClockVerifiedFor, type CloseOffer } from "./clock/clockController";
import { projectedFinalityMs, secsUpOf } from "./clock/clockModel";
import type { ClockStore } from "./clock/clockStore";
import type { ClockConductHook } from "./clock/clockEvidence";
import type { RemedyPort } from "../escrow/remedyPipeline";
import { CLOCK_REFUSAL, NO_DEADLINE_DISCLOSURE } from "../../../frontend/src/utils/clockProtocol";
import type { MoneyContinuationFacts } from "../escrow/moneyContinuation";
import type { ContinuationWiring } from "../continuationWiring";
import { disabledMoneyView, disabledStake, type MoneyRoomPort, type MoneyTables } from "../escrow/moneyTables";
import {
  ARCHIVE_SWEEP_BUDGET,
  FROZEN_GAME_SENTENCE,
  GAME_OVER_SENTENCE,
  GONE_SENTENCES,
  HELD_PLAYER_SENTENCE,
  NO_MONEY_SETTLEMENT,
  UNAVAILABLE_PLAYER_SENTENCE,
  archiveDueAt,
  classOfRecord,
  sealOf,
  type GameClass,
  type HoldCode,
  type SettlementLifecycle,
} from "./lifecycle";
import type { RecordStore } from "./recordStore";
import { dealInfoOf, reconcileLoaded } from "./reconcile";
import { authorize, roleOf, type RoomOp } from "./roomAuthz";
import {
  assertDeal,
  buildSetupGame,
  cancelRoom,
  setAnte,
  createRecord,
  joinByCode,
  kick,
  leave,
  releaseSeat,
  rotateCode,
  setProfile,
  setReady,
  setVisibility,
  takeSeat,
  transferHost,
  waitingBlock,
  type OpEnv,
  type OpOutcome,
  type RosterSource,
} from "./roomService";

const CHAT_HISTORY_LIMIT = 200;
/** Timed Async (money): how long a completing YES waits for the chain to pass its second and answer every approver's
 *  key at it (CometBFT block time trails real time by about a block). Unanswered: nothing is decided (try again). */
const ASYNC_COMPLETION_KEY_CHECK_MS = 20_000;
const MAX_CHAT_LENGTH = 500;

/** ESCROW-3B: what the room host tells the escrow service, and asks it. Money games are disabled, so in production the
 *  service knows no frozen roster and both are inert. */
export interface EscrowGameplaySeam {
  /** A committed batch (or a load) of a game: synchronous, inside the committing task, never throws. */
  onGameplayCommitted(input: { readonly gameId: string; readonly entries: readonly ServerLogEntry[]; readonly board: GameStateResponse }): void;
  /** The game's financial roster is frozen (from the start-intent task on): no seat of it may change. */
  isRosterFrozen(gameId: string): boolean;
  /** LIVE-6 L6-2: POST-RESTORE SAFE MODE (preflight §13 step 8 / §17.2; L6-4 §12.2). On a game table restored from a
   *  backup (its SYSTEM/GENERATION says origin `restore`), a MONEY table is read-only until its financial history is
   *  verified against the ledger and the chain in THIS process (`EscrowService.restoreGate`): the sentence to refuse
   *  with, or null (serve). Absent: never read-only (not a restored table). Asked synchronously; it starts the check. */
  restoreGate?(gameId: string): string | null;
}

/** ESCROW-3B: the ops that would change a frozen financial roster's seats (or the table itself before the deal). */
const FROZEN_ROSTER_OPS: ReadonlySet<string> = new Set(["join", "take-seat", "release-seat", "leave", "set-profile", "kick", "cancel-room"]);
export const FROZEN_ROSTER_SENTENCE = "This table's players are locked in with the escrow: seats can no longer change.";
/** ESCROW-4 (R-J1, W-2, W-3): the ops a real-money table decides again in the task, against the ledger and the chain. */
const MONEY_SEAT_OPS: ReadonlySet<string> = new Set(["kick", "release-seat", "transfer-host", "cancel-room", "set-ante"]);
export const MONEY_UNAVAILABLE_SENTENCE = "This table's money can't be checked on this server right now, so its seats can't change.";

export interface RoomHostDeps {
  build: string;
  /** LIVE-5 L5-3: POOL ownership (DynamoDB) -- the startup discovery writes nothing (`discovery.ts` `readOnly`). */
  discoveryReadOnly?: boolean;
  records: RecordStore;
  /** LIVE-4 (L4-2): `forEach` visits every resident actor (the serving review walks them). */
  games: { get(gameId: string): Promise<GameActor>; peek(gameId: string): GameActor | undefined; forEach?(visit: (actor: GameActor, gameId: string) => void): void };
  identity: IdentityService;
  limits: IngressLimits;
  now: () => number;
  send: (socket: WebSocket, frame: object) => void;
  contextOf: (socket: WebSocket) => ConnectionContext | undefined;
  ipOf: (socket: WebSocket) => IpKey | undefined;
  loadChat: (gameId: string) => Promise<readonly RoomChatEntry[]>;
  appendChat: (gameId: string, entry: RoomChatEntry) => Promise<void>;
  rosterSource: RosterSource;
  shuffle: <T>(items: readonly T[]) => T[];
  /** The socket's room subscriptions changed (the gameServer's `socketsByGame` index). */
  onSubscriptionChange: (socket: WebSocket) => void;
  /** Every socket reading `gameId` now -- its view or its log (the gameServer's `socketsByGame` index). */
  readersOf: (gameId: string) => Iterable<WebSocket>;
  errorRef: () => string;
  warn: (line: string) => void;
  /** LIVE-2E: a principal's profile name, to seed a new seat's nickname (presentation only; `null` when none). */
  profileNameOf?: (principalId: string) => string | null;
  /** LIVE-3C: the durable holds (in memory when absent -- a hold then lasts only as long as the process). */
  holds?: HoldStore;
  /** LIVE-3C: the game logs, as startup discovery enumerates and peeks at them (read-only). */
  logs?: { listGameLogs?(): Promise<string[]>; readHead?(gameId: string): Promise<LogHeadRead> };
  /** LIVE-3C: the audit lines and the status snapshot (nothing when absent). */
  ops?: OpsRecorder;
  /** LIVE-3C: the terminal seam ESCROW-3 plugs into (no-money when absent). */
  settlement?: SettlementLifecycle;
  /** LIVE-4 (L4-2): this pool's continuation answers (`continuationWiring.ts`). Discovery classifies a deal's first
   *  line with its gameplay half; each game's session asks the full verdict itself (it was given `sessionFor`). Absent
   *  (a host built without a server): discovery uses this code's own gameplay half. */
  continuation?: ContinuationWiring;
  /** LIVE-4 (L4-2): the settlement index, refreshed with a new money table's financial record before the table's first
   *  session exists and again before its deal (the verdict must never meet a money table the index has not seen). */
  moneyFacts?: MoneyContinuationFacts;
  /** ESCROW-3B: the escrow service's seam (none when absent: no money game can exist). */
  escrow?: EscrowGameplaySeam;
  /** ESCROW-4: the real-money table layer (`escrow/moneyTables.ts`), bound late (it needs this host's port). Absent or
   *  null: no money table can be created, and an existing one is shown by its terms only, its seats locked. */
  money?: () => MoneyTables | null;
  /** PHASE 3 FINAL (owner ruling 2026-10-06: PLAYER GAMES ARE ANTED GAMES): whether a table WITHOUT an ante may be
   *  created, joined with a seat or started. `false` in every production entry point (`start.ts` in production mode,
   *  `awsRuntime.ts`): the player product has no free game. Absent / true: the internal machinery -- development mode,
   *  the deterministic suites and historical fixtures -- keeps its free tables. Watching is never affected. */
  freeTables?: boolean;
  /** LIVE-3C: whether a session's board has ended or closed (the reducer's `GameEnd` / `room_closed`; a test seam
   *  may say so of a game that has not -- a stored game that reaches GameEnd needs a whole game played). */
  boardFacts?: (gameId: string, session: RoomSession) => { ended: boolean; closed: boolean };
  /** LIVE-3C: more for the status snapshot (the identity store's health, the log store's counters). */
  statusExtras?: () => Record<string, unknown>;
  /** LIVE-4 (L4-3): whether this socket's CLIENT may be shown this game now -- its announced rules against the game's
   *  pin (the canonical client verdict, judged by the server). When it may not, the server has already answered it
   *  (`reload`, then close 4426) and this host shows it nothing more of the game. A legacy socket always may (it
   *  announced no rules). Absent (a host built without a server): no client check. */
  clientMayRead?: (socket: WebSocket, gameId: string, view: CommittedView) => boolean;
  /** LIVE-6 L6-1: a room hello for a game another pool owns (the claim was refused, nothing of it was read): answer the
   *  route, when there is one to answer (true: answered -- the route frame, or the read authorization's refusal).
   *  False, or absent: the answer is exactly as before (`unavailableFor`). */
  answerRouted?: (socket: WebSocket, gameId: string, routed: GameRoutedError) => Promise<boolean>;
  /** Phase 3 final clocks: the table clock (`clock/clockController.ts`). Absent: no table is timed (the pre-lane
   *  behaviour, kept for hosts built without one -- tests and tools). `start.ts` and the AWS runtime always give one. */
  clock?: RoomHostClockConfig;
  /** Phase 3 final clocks: run `fn` with every entry the session mints stamped `at` (the clock's decision time). */
  stampAt?: <T>(at: number, fn: () => T) => T;
  /** Phase 3 (P3-N035): where a seated player's conduct report goes (`conduct/conductService.ts`). Absent: every report
   *  is refused `unavailable` -- never kept in memory only. It writes its own store and nothing else. */
  conduct?: ConductService;
  /** Consolidated final integration: the clock lane's durable evidence events as the reporting hook kept them in this
   *  process (`conduct/conductClockFacts.ts`). With the table's stored clock record, a report's clock facts. */
  conductClockFeed?: ConductClockFeed;
}

/** Phase 3 final clocks: what the room host needs to run the table clock. */
export interface RoomHostClockConfig {
  readonly store: ClockStore;
  /** This process's continuity token (file mode: the lock's instance id; AWS: generation / pool / epoch / task). */
  readonly authority: string;
  /** The clock's time (`deps.now` when absent) and timers (real when absent) -- tests control both. */
  readonly now?: () => number;
  readonly timers?: ClockTimers;
  /** The money remedy pipeline, bound late (the Juno backend is built before the server). */
  readonly remedy?: () => RemedyPort | null;
  /** The escrow's terminal route when a money table's financial record is closed (`null`: not terminal). */
  readonly moneyTerminal?: (gameId: string) => Promise<string | null>;
  /** A bound money game's chain Start (seconds), for the first obligation's clamp. */
  readonly moneyStartedAtSecs?: (gameId: string) => Promise<number | null>;
  /** The player-reporting lane's hook (safe conduct evidence). */
  readonly conduct?: ClockConductHook;
}

/** The board's own end and close, read off a session. */
export function sessionBoardFacts(session: RoomSession): { ended: boolean; closed: boolean } {
  const state = session.state as { current_round_type?: string | null; room_closed?: boolean };
  return { ended: state.current_round_type === "GameEnd", closed: state.room_closed === true };
}

/** The facts the log gives, read inside a task (the board is the session's, equal to the committed view). */
export function factsFromTx(tx: Tx, board: { ended: boolean; closed: boolean } = sessionBoardFacts(tx.session)): LogFacts {
  return factsFromEntries(tx.view.entries, board.ended, board.closed);
}

/** LIVE-3C: the facts a HELD game's record gives -- a held game's view holds no history, so what the room shows about
 *  it (dealt, ended, closed) comes from the record alone, never from an absent log. */
export function factsFromRecord(record: Readonly<GameRecord>): LogFacts {
  const dealt = record.started_at !== null || record.status === "active" || record.status === "completed";
  return {
    dealt,
    dealAt: record.started_at,
    turnOrder: record.turn_order,
    rulesEngineVersion: record.rules_engine_version,
    ended: record.status === "completed",
    closed: record.closed_at !== null,
  };
}

/* ==================================================================
    PHASE 3 FINAL CLOCKS: THE DEAL OF A LONG HISTORY, FOUND ONCE
   ==================================================================
   Every read gate (a push, a presence hint, a chat line, a view) asks which deal stands, and a history has no length
   limit (owner ruling, 2026-10-07), so the answer is carried forward per history -- keyed by its FIRST entry object,
   which every committed view of one game shares -- and only the entries appended since it was last asked are read.
   Only a `RevertTo` that reaches the deal (or anything, while none stands) or a new `SetupGame` can change it; either
   recomputes it from the whole effective log, exactly as before. A history that is not the remembered one (shorter,
   or another entry where the remembered last one stood) is recomputed too. */
interface DealMemo {
  readonly length: number;
  readonly lastIndex: number;
  readonly lastId: string;
  readonly deal: ServerLogEntry | null;
}
const dealMemos = new WeakMap<object, DealMemo>();

function mayMoveTheDeal(entry: ServerLogEntry, deal: ServerLogEntry | null): boolean {
  if (entry.payload.includes("SetupGame")) return true;
  if (!entry.payload.includes("RevertTo")) return false;
  const target = revertTargetOf(entry);
  return target !== null && (deal === null || target <= deal.index);
}

/** `dealEntryOf(effectiveActions(entries))`, reading only what was appended since the history was last asked. */
export function standingDealOf(entries: readonly ServerLogEntry[]): ServerLogEntry | null {
  const first = entries[0];
  if (first === undefined) return null;
  const memo = dealMemos.get(first);
  let deal: ServerLogEntry | null;
  const anchor = memo === undefined ? undefined : entries[memo.length - 1];
  if (memo !== undefined && anchor !== undefined && anchor.index === memo.lastIndex && anchor.id === memo.lastId && entries.length >= memo.length) {
    deal = memo.deal;
    for (let at = memo.length; at < entries.length; at += 1) {
      if (mayMoveTheDeal(entries[at], deal)) {
        deal = dealEntryOf(effectiveActions(entries));
        break;
      }
    }
  } else {
    deal = dealEntryOf(effectiveActions(entries));
  }
  const last = entries[entries.length - 1];
  dealMemos.set(first, { length: entries.length, lastIndex: last.index, lastId: last.id, deal });
  return deal;
}

export function factsFromEntries(entries: readonly ServerLogEntry[], ended: boolean, closed: boolean): LogFacts {
  const deal = standingDealOf(entries);
  if (deal === null) return { dealt: false, dealAt: null, turnOrder: null, rulesEngineVersion: null, ended: false, closed: false };
  let turnOrder: string[] | null = null;
  let rulesEngineVersion: number | null = null;
  try {
    const payload = JSON.parse(deal.payload) as { SetupGame?: { players?: Array<{ id?: unknown }>; rules_engine_version?: unknown } };
    turnOrder = (payload.SetupGame?.players ?? []).map((player) => String(player.id));
    rulesEngineVersion = typeof payload.SetupGame?.rules_engine_version === "number" ? payload.SetupGame.rules_engine_version : null;
  } catch {
    /* a deal the engine accepted is readable; nothing to add if not */
  }
  return { dealt: true, dealAt: (deal as { at?: number }).at ?? null, turnOrder, rulesEngineVersion, ended, closed };
}

/** Facts outside a task: the log's deal, and the record's cached end (synced by the server from the board).
 *  LIVE-3C: a game under a maintenance hold serves no history, so its facts are the record's. */
export function factsFromView(view: CommittedView, record: GameRecord): LogFacts {
  if (isMaintenanceHold(view.hold)) return factsFromRecord(record);
  return factsFromEntries(view.entries, record.status === "completed", record.closed_at !== null);
}

/** LIVE-3C: what a room shows about why it will not take a change -- the RoomView's `holdKind`.
 *  LIVE-4 (L4-2): NO BUILD INPUT. #1252 made a game dealt on another build `read-only`; continuation now follows the
 *  game's semantic identity, so a game this pool does not continue (or no longer serves) is `incompatible` -- DERIVED
 *  from the session's verdict, whatever build dealt it -- and one it continues is played, on any build. `read-only`
 *  is never produced (it stays in the client's union so an older server's view still reads). */
export function holdKindOf(view: CommittedView): HoldKind {
  if (isMaintenanceHold(view.hold)) return "maintenance";
  if (view.incompatible !== null || view.hold?.reason === "version") return "incompatible";
  if (view.hold?.reason === "uncertain") return "unavailable";
  return null;
}

/** LIVE-4 (L4-2): why a view is not continued here, in the verdict's (or the serving decision's) words -- the
 *  `incompatible` frame's `why` -- or `null`. The one version hold with no frame is the load's for a GameRecord a newer
 *  build wrote (`gameActor.ts`): the canonical `newer-format`. */
export function notContinuedWhyOf(view: CommittedView): string | null {
  if (view.incompatible === null && view.hold?.reason !== "version") return null;
  const why = (view.incompatible as { why?: unknown } | null)?.why;
  return typeof why === "string" ? why : "newer-format";
}

/** LIVE-4 (L4-3): the player's sentence for why a view is not continued here -- its `incompatible` frame's `reason` (the
 *  session's `notContinuedSentence` / `notServedSentence`), or `null`. */
export function notContinuedReasonOf(view: CommittedView): string | null {
  const frame = view.incompatible as { kind?: unknown; reason?: unknown } | null;
  return frame !== null && frame.kind === "incompatible" && typeof frame.reason === "string" && frame.reason !== "" ? frame.reason : null;
}

/** LIVE-3C: the sentence a `gone` answer carries, by what ended the table. */
export function goneSentence(record: Readonly<GameRecord> | null): string {
  if (record === null) return GONE_SENTENCES.gone;
  if (record.archived_at !== null) return GONE_SENTENCES.archived;
  if (record.status === "cancelled") return GONE_SENTENCES.cancelled;
  if (record.status === "expired" || (record.status === "waiting" && record.expires_at !== null)) return GONE_SENTENCES.expired;
  return GONE_SENTENCES.gone;
}

/** LIVE-2F/3D (C9-01): what "Your tables" calls each class of game; a class not named here is not listed (gone). */
const MY_TABLE_STATE: Partial<Record<GameClass, MyTableState>> = Object.freeze({
  waiting: "waiting",
  active: "playing",
  completed: "finished",
  unreconciled: "resume",
  held: "paused",
  unavailable: "unavailable",
  incompatible: "cannot-continue",
  /* LIVE-4 (L4-2): no `read-only` row -- that class (a game dealt on another build, #1252) is never produced now; a
     game this pool does not continue is `incompatible`, shown "cannot continue". */
});
/** The most "Your tables" answers with (live tables first, then the most recently finished). */
export const MY_TABLES_LIMIT = 50;
/** How often, and how many, unread games "Your tables" asks the record store for again (review IR-02). */
export const MY_TABLES_REINDEX_MS = 30_000;
export const MY_TABLES_REINDEX_BUDGET = 50;

export function createRoomHost(deps: RoomHostDeps) {
  const rooms = deps.limits.rooms;
  const identityLimits = deps.limits.identity;
  const factor = identityLimits.ipv6AggregateFactor;
  const keys = identityLimits.maxTrackedKeys;
  const now = deps.now;

  /* ---- the limiters keyed by principal, game and seat (LIVE-2 §12.2) ---- */
  const createsPrincipal = new KeyedBuckets(rooms.createsPerPrincipal, now, keys);
  const createsIp = new IpBuckets(rooms.createsPerIp, now, factor, keys);
  const createsGlobal = new KeyedBuckets(rooms.createsGlobal, now, 1);
  const joinFailPrincipal = new KeyedBuckets(rooms.joinFailuresPerPrincipal, now, keys);
  const joinFailIp = new IpBuckets(rooms.joinFailuresPerIp, now, factor, keys);
  const joinFailGlobal = new KeyedBuckets(rooms.joinFailuresGlobal, now, 1);
  const membership = new KeyedBuckets(rooms.membershipOpsPerPrincipal, now, keys);
  /* Phase 3 final clocks: each clock op is a durable write in the game's task -- budgeted like a membership op. */
  const clockOps = new KeyedBuckets(rooms.membershipOpsPerPrincipal, now, keys);
  const submitsSeat = new KeyedBuckets(rooms.submitsPerSeat, now, keys);
  const submitsGame = new KeyedBuckets(rooms.submitsPerGame, now, keys);
  const offersSeat = new KeyedBuckets(rooms.offersPerSeat, now, keys);
  const offersSeatSustained = new KeyedBuckets(rooms.offersPerSeatSustained, now, keys);
  const chatSeat = new KeyedBuckets(rooms.chatPerSeat, now, keys);
  const rotations = new KeyedBuckets(rooms.codeRotationsPerGame, now, keys);
  const denied: Record<string, number> = {};
  const deny = (name: string) => void (denied[name] = (denied[name] ?? 0) + 1);

  /* ---- what the server knows about games ---- */
  /** Every record, as last committed (the startup scan, then each publish): the public list and the per-principal
   *  caps read it. Authority is still the actor's committed view; this is an index. */
  const recordIndex = new Map<string, GameRecord>();
  const unknownGames = new Map<string, number>();
  /** Creates in flight per principal: counted against the hosted-room cap before their record exists. */
  const pendingCreates = new Map<string, number>();
  const counters = {
    created: 0,
    unknownGameLookups: 0,
    negativeCacheHits: 0,
    sessionsAllocated: 0,
    reaped: 0,
    viewPushesRefused: 0,
    logPushesRefused: 0,
    /* LIVE-3C */
    repaired: 0,
    archived: 0,
    unavailable: 0,
    terminalRefused: 0,
  };
  const holds = deps.holds ?? createMemoryHoldStore();
  const ops = deps.ops ?? NO_OPS;
  /* Phase 3 final clocks: the table clock, run INSIDE each game's serialization (see `clock/clockController.ts`). */
  const clockPins = new Map<string, GameActor>();
  const clock: ClockController | null =
    deps.clock === undefined
      ? null
      : createClockController({
          store: deps.clock.store,
          authority: deps.clock.authority,
          now: deps.clock.now ?? (() => now()),
          ...(deps.clock.timers !== undefined ? { timers: deps.clock.timers } : {}),
          ops,
          warn: (line) => deps.warn(line),
          runOn: async (gameId, label, task) => {
            let game: GameActor | null;
            try {
              game = await actorFor(gameId);
            } catch {
              return false;
            }
            if (game === null) return false;
            const actor = game;
            const outcome = await actor.run("room-op", (tx) => task(actor, tx), { quiet: label !== "clock" });
            if (outcome.kind === "failed") throw outcome.error;
            return outcome.kind === "ran";
          },
          onChange: (gameId) => broadcastView(gameId),
          serving: (gameId) => {
            const game = peekLoaded(gameId);
            return game !== undefined && !game.fenced;
          },
          pin: (gameId, on) => {
            if (on) {
              const game = peekLoaded(gameId);
              if (game === undefined || clockPins.get(gameId) === game) return;
              clockPins.get(gameId)?.unpin();
              game.pin();
              clockPins.set(gameId, game);
            } else {
              clockPins.get(gameId)?.unpin();
              clockPins.delete(gameId);
            }
          },
          closeOffer: (game, tx, input) => closeExpiredOffer(game, tx, input),
          /* LIVE-3C: a held, incompatible or unreconciled table takes no move -- its clock does not run either. So does a
             RESTORED money table whose L6-2 restore check has not passed (`restoreGate`: every move and money write is
             refused until it does) -- consolidated final integration, independent review: otherwise its clock ran on a
             table nobody could move at (strikes, a minute-30 seal, a Timed Async expiry). When the gate opens, the
             stall rule judges the held time as for any hold. */
          held: (gameId) => {
            const game = peekLoaded(gameId);
            if (game === undefined) return false;
            if (game.view.hold !== null || game.view.incompatible !== null || unreconciled.has(gameId)) return true;
            const record = game.view.record;
            return record !== null && record.money !== null && (deps.escrow?.restoreGate?.(gameId) ?? null) !== null;
          },
          ...(deps.clock.remedy !== undefined ? { remedy: deps.clock.remedy } : {}),
          ...(deps.clock.moneyTerminal !== undefined ? { moneyTerminal: deps.clock.moneyTerminal } : {}),
          ...(deps.clock.moneyStartedAtSecs !== undefined ? { moneyStartedAtSecs: deps.clock.moneyStartedAtSecs } : {}),
          ...(deps.clock.conduct !== undefined ? { conduct: deps.clock.conduct } : {}),
          nameOf: (gameId, seat) => peekLoaded(gameId)?.view.record?.seats.find((entry) => entry.player_id === seat)?.nickname ?? "A player",
        });
  clock?.startSweep();
  const settlement = deps.settlement ?? NO_MONEY_SETTLEMENT;
  /** LIVE-4 (L4-2): what the view says about the game -- the session's verdict decided it; no build is compared. */
  const kindOf = (view: CommittedView): HoldKind => holdKindOf(view);
  /** LIVE-4 (L4-2): each not-continued game is audited once per run, when it is first concluded so (derived: a line,
   *  never a hold). */
  const auditedNotContinued = new Set<string>();
  const auditNotContinued = (gameId: string, why: string, detail: string | null, source: "discovery" | "load" | "serving" | "rebuild"): void => {
    if (auditedNotContinued.has(gameId)) return;
    auditedNotContinued.add(gameId);
    ops.audit("game.not-continued", { game_id: gameId, why, detail, source });
  };
  const boardOf = (gameId: string, session: RoomSession) => (deps.boardFacts ? deps.boardFacts(gameId, session) : sessionBoardFacts(session));

  /* ==================================================================
      LIVE-3C: STARTUP DISCOVERY BEFORE ANY GAME IS SERVED
     ==================================================================
     Every durable game is enumerated and classified (`discovery.ts`) before this host resolves a single game id:
     `resolveGame` and every path through it wait for `indexReady`. A game discovery holds is held before anybody can
     load it; a record that cannot be read is left out of the index (and answered as no such game); one bad game never
     hides the others. */
  let discovery: DiscoveryReport | null = null;
  /* ==================================================================
      LIVE-3C: TWO STAGES -- DISCOVERED, THEN RECONCILED (lifecycle.ts)
     ==================================================================
     `unreconciled` holds every game whose record this process has NOT yet reconciled against its whole log: the
     started games discovery found (it reads only the first line), and any record found lazily after it. A game leaves
     the set only when its load has scanned and replayed the whole log AND reconcileLoaded agrees (with any repair it
     asked for committed) -- or when the load held it or found it incompatible, which is a conclusion too. Until then
     its record is NOT believed: it is left out of the public list, never archived, and every op on it is refused (its
     reads all go through the actor, whose load is the reconciliation). `concluded` keeps a fail-closed conclusion for
     a game whose actor has since been evicted, so it is not re-read from the stale discovery line. */
  const unreconciled = new Set<string>();
  const concluded = new Map<string, { cls: GameClass; code: string | null; detail: string | null } | "healthy">();
  /* LIVE-3C (review E11): a hold discovery found but could not WRITE down is still a hold for this run -- the load
     and every op honour it through `pendingHoldOf`, exactly as if the file existed. */
  const discoveryHolds = new Map<string, { code: HoldCode; detail: string }>();
  const indexReady: Promise<void> = (async () => {
    try {
      discovery = await discoverGames({
        records: deps.records,
        logs: deps.logs ?? {},
        holds,
        build: deps.build,
        rulesEngineVersion: RULES_ENGINE_VERSION,
        /* LIVE-4 (L4-2): the pool's gameplay verdict on each deal's first line (never a build comparison). */
        ...(deps.continuation !== undefined ? { gameplayVerdict: deps.continuation.gameplayVerdictOf, rulesSupported: deps.continuation.capability.rules.supported } : {}),
        now,
        warn: deps.warn,
        ops,
        ...(deps.discoveryReadOnly === true ? { readOnly: true } : {}),
      });
    } catch (error) {
      deps.warn(`  discovery: the startup scan failed -- ${error instanceof Error ? error.message : String(error)}; games are resolved one by one as they are asked for`);
      return;
    }
    for (const game of discovery.games.values()) {
      if (game.record !== null) recordIndex.set(game.gameId, game.record);
      if (game.cls === "held" && game.code !== null) discoveryHolds.set(game.gameId, { code: game.code as HoldCode, detail: game.detail ?? "" });
      /* Whatever loaded meanwhile (nothing can: every path waits for this) has already settled itself. */
      if (game.cls === "unreconciled" && deps.games.peek(game.gameId) === undefined) unreconciled.add(game.gameId);
    }
    deps.warn(summaryLine(discovery));
    for (const error of discovery.storeErrors) deps.warn(`  discovery: STORE -- ${error}`);
    for (const game of discovery.games.values()) {
      if (game.cls === "held" || game.cls === "incompatible" || game.cls === "unavailable" || game.cls === "attention") {
        deps.warn(`  discovery: ${game.gameId} ${game.cls.toUpperCase()}${game.code ? ` (${game.code})` : ""}${game.detail ? `: ${game.detail}` : ""}`);
      }
      /* LIVE-4 (L4-2): a game this pool does not continue, audited once (derived: no hold file is ever written for it). */
      if (game.cls === "incompatible") auditNotContinued(game.gameId, game.code ?? "not-continued", game.detail, "discovery");
    }
    publishStatus();
  })();

  /* ---- subscriptions ---- */
  const viewSubs = new Map<string, Set<WebSocket>>();
  const viewGameOf = new Map<WebSocket, string>();
  const listWatchers = new Set<WebSocket>();
  const presence = new Map<string, Map<string, PresenceState>>();
  const chats = new Map<string, RoomChatEntry[]>();
  let chatMinted = 0;
  const chatTag = Date.now().toString(36);

  const principalOf = (socket: WebSocket) => deps.contextOf(socket)?.principalId ?? null;

  /** The resident actor ONLY once it has loaded: a loading actor has no committed view (its `view` throws), so to
   *  every read here it is not resident yet (review H1: a list timer or a close handler must never meet one). */
  const peekLoaded = (gameId: string): GameActor | undefined => {
    const game = deps.games.peek(gameId);
    return game !== undefined && game.isLoaded ? game : undefined;
  };

  /* ---- M4: a game with view subscribers stays resident (the actor's own idleness counts only log readers) ---- */
  const pinned = new Map<string, GameActor>();
  function pinFor(gameId: string, game: GameActor): void {
    const current = pinned.get(gameId);
    if (current === game) return;
    /* LIVE-5 L5-3: a pin still held on a DROPPED actor (the fenced reaction) moves to its successor. Before L5-3 the pinned
       actor was always the resident one (a pinned actor is never evicted), so this never ran. */
    current?.unpin();
    game.pin();
    pinned.set(gameId, game);
  }
  function unpinFor(gameId: string): void {
    const game = pinned.get(gameId);
    if (game === undefined) return;
    pinned.delete(gameId);
    game.unpin();
  }

  /** Whether `gameId` names a game, without loading an actor for one that does not (LIVE-2 §11.4 item 4).
   *  LIVE-3C: waits for startup discovery; a record that cannot be read -- damaged, or written by a newer build -- is
   *  answered exactly as no game at all (nobody can be authorized against a record nobody can read, and the answer must
   *  not say that a private game exists); a read that FAILED rejects `GameUnavailableError`. */
  async function resolveGame(gameId: string): Promise<boolean> {
    await indexReady;
    if (recordIndex.has(gameId) || peekLoaded(gameId)?.view.record) return true;
    const until = unknownGames.get(gameId);
    if (until !== undefined && until > now()) {
      counters.negativeCacheHits += 1;
      return false;
    }
    counters.unknownGameLookups += 1;
    let record: GameRecord | null;
    try {
      record = await deps.records.load(gameId);
    } catch (error) {
      if (isStoreCorrupt(error) || isStoreIncompatible(error)) return false;
      counters.unavailable += 1;
      throw new GameUnavailableError(gameId, error);
    }
    if (record === null) {
      unknownGames.set(gameId, now() + rooms.unknownGameTtlMs);
      /* Over the bound: the oldest entries go first (insertion order), and the walk stops once under it. */
      for (const id of unknownGames.keys()) {
        if (unknownGames.size <= rooms.maxUnknownGames) break;
        unknownGames.delete(id);
      }
      return false;
    }
    unknownGames.delete(gameId);
    /* Found after discovery (or discovery could not run): stage one until its load reconciles it -- never believed from
       the record meanwhile (the caller loads it at once). A slower lookup never overwrites what a load or a publish
       has put in the index since (review: a stale read landing after the repair). */
    if (!recordIndex.has(gameId) && deps.games.peek(gameId) === undefined) {
      unreconciled.add(gameId);
      recordIndex.set(gameId, record);
    }
    return true;
  }

  /** The loaded actor for a KNOWN game, or `null` (an unknown id never allocates a session). LIVE-3C: a load that
   *  FAILED (the store could not be read just now -- not a verdict on the game) rejects `GameUnavailableError`; the
   *  registry drops the failed actor, so the next ask tries again. */
  async function actorFor(gameId: string): Promise<GameActor | null> {
    if (!(await resolveGame(gameId))) return null;
    const resident = deps.games.peek(gameId) !== undefined;
    let game: GameActor;
    try {
      game = await deps.games.get(gameId);
    } catch (error) {
      counters.unavailable += 1;
      deps.warn(`  store: ${gameId} could not be loaded -- ${error instanceof Error ? error.message : String(error)}; it is answered "unavailable" and tried again at the next ask`);
      throw new GameUnavailableError(gameId, error);
    }
    if (game.view.record === null) return null;
    if (!resident) counters.sessionsAllocated += 1;
    return game;
  }

  /** LIVE-3C: STAGE TWO, AT EVERY LOAD (the registry calls this before any waiting caller resumes, so the task it
   *  queues runs ahead of every op or submit they queue). The load itself has already scanned the whole log, replayed
   *  it and run reconcileLoaded (`gameActor.ts`): a disagreement is a maintenance hold in the view, an unsupported pin
   *  is `incompatible`. What is left is a record that agrees -- or only LAGS its log (a crash between the deal, the
   *  end or the close and the record's follow-up write): that repair is committed by a task of its own, and only once
   *  it lands is the game reconciled. */
  function onActorLoaded(game: GameActor): void {
    /* LIVE-5 L5-3: viewers pinned a DROPPED actor of this game (the fenced reaction, or a claim-back): their pin moves to
       this successor, so a watched game stays resident. Never runs otherwise (a pinned actor is never evicted). */
    const stale = pinned.get(game.gameId);
    if (stale !== undefined && stale !== game) pinFor(game.gameId, game);
    let view: CommittedView;
    try {
      view = game.view;
    } catch (error) {
      deps.warn(`  records: ${game.gameId} loaded without a committed view -- ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const record = view.record;
    if (record === null) return;
    if (isMaintenanceHold(view.hold) || view.incompatible !== null || view.hold?.reason === "version") {
      settle(game.gameId, classOfView(game.gameId, view));
      return;
    }
    if (view.hold !== null) return; // a store fault: neither reconciled nor held -- the next load decides
    /* Phase 3 final clocks: the clock is read and its continuity judged at the load, before anyone moves -- a table that
       was served by another process is SYSTEM-PAUSED now (and shown so), never silently resumed. */
    clock?.loaded(game.gameId);
    if (!factsFromView(view, record).dealt) {
      settle(game.gameId, null); // no history: the load's own reconciliation (an empty log) was the whole of it
      return;
    }
    syncRecord(game, "load");
    /* ESCROW-3B: a money game's newest committed position, at load -- a boundary crossed just before a crash (with no
       move since) is still checkpointed, so a stall after a restart pays by the board it stalled on. */
    if (deps.escrow?.isRosterFrozen(game.gameId)) {
      void game
        .run("room-op", async (tx) => {
          if (tx.view.hold === null && tx.view.incompatible === null) callEscrow(game.gameId, tx.view.entries, tx.session.state);
        })
        .catch(() => undefined);
    }
  }

  /** A game's reconciliation is concluded for this run: healthy (`null`: its record, which this process now writes, is
   *  believed) or a fail-closed class kept for after its actor is evicted. */
  function settle(gameId: string, failClosed: { cls: GameClass; code: string | null; detail: string | null } | null): void {
    const was = unreconciled.delete(gameId);
    const before = concluded.get(gameId);
    /* LIVE-4 (L4-2): #1252's `read-only` conclusion (C4-01: a game dealt on another build) is gone -- a game dealt on
       another build whose semantic identity this pool continues is HEALTHY, played and counted in caps like any other.
       A game this pool does not continue arrives here concluded `incompatible` (its view says so), keeps no cap, and is
       audited once: derived, never a hold. */
    if (failClosed !== null && failClosed.cls === "incompatible") auditNotContinued(gameId, failClosed.code ?? "not-continued", failClosed.detail, "load");
    /* A game concluded anything else is continued (or held) now: a later "not continued" is news, and audited again. */
    else auditedNotContinued.delete(gameId);
    /* A conclusion replaces discovery's line for good (review: a start-time read failure is not sticky once a load
       has succeeded): healthy means the record -- reconciled, and written only by this process since -- is believed. */
    if (failClosed === null || failClosed.cls === "active" || failClosed.cls === "completed" || failClosed.cls === "waiting") concluded.set(gameId, "healthy");
    else concluded.set(gameId, failClosed);
    if (was || before !== concluded.get(gameId)) {
      scheduleList();
      publishStatus();
    }
  }

  /** LIVE-3C: an op or a move on a game whose record is not reconciled yet is refused (and the reconciliation tried
   *  again as a task of its own). Only reachable when the load's repair could not be committed. */
  function awaitingReconciliation(game: GameActor): boolean {
    if (!unreconciled.has(game.gameId)) return false;
    syncRecord(game, "load");
    return true;
  }

  /** LIVE-3C (review): entries of unknown outcome were adopted from the store (a late commit, a read-back). No record
   *  sync followed them, so one is queued now -- exactly as after any committed batch (RL-1: tasks already queued run
   *  on the board, which the terminal gate and every authorization read). If it cannot land, the game is
   *  unreconciled (`syncRecord`) and every op on it is refused until it does. */
  function onStoreAdopted(gameId: string): void {
    const game = peekLoaded(gameId);
    if (game === undefined || game.view.record === null) return;
    syncRecord(game, "adopted");
  }

  /** LIVE-3C (review E8): what a caller is told when a game could not be LOADED just now. With its record indexed,
   *  `unavailable` only to a principal that record already lets read it -- anybody else is told exactly what a game
   *  that does not exist answers, so a failing private game is not told apart from no game at all. With no record to
   *  authorize against (its own read is what failed), `unavailable`: a missing file reads as nothing, so only a
   *  store fault -- nothing a caller can cause -- says an id is there. */
  function unavailableFor(gameId: string, principalId: string | null): { code: string; reason: string } {
    const record = recordIndex.get(gameId) ?? null;
    const unavailable = { code: "unavailable", reason: UNAVAILABLE_PLAYER_SENTENCE };
    if (record === null) return unavailable;
    const verdict = authorize("read-view", { record, facts: factsFromRecord(record), principalId: principalId ?? "", now: now(), held: false });
    if (!verdict.ok && verdict.code === "not-found") return { code: "not-found", reason: "There is no such game." };
    return unavailable;
  }

  /** P3-ACCT (trust indicators): the seats of a table `principalId` may READ (its view, as any watcher would: a private
   *  table is `null` to an outsider, exactly as a table that does not exist). Server-side only: the principals here
   *  never leave the server -- the caller turns them into public facts keyed by the seat's public `player_id`. */
  function readableSeats(gameId: string, principalId: string | null, options: { moneyOnly?: boolean } = {}): ReadonlyArray<{ readonly playerId: string; readonly principalId: string }> | null {
    const record = peekLoaded(gameId)?.view.record ?? recordIndex.get(gameId) ?? null;
    if (record === null) return null;
    /* P3-ACCT (review L4): the trust facts are for deciding whether to sit at a REAL-MONEY table; a free table answers
       exactly as a missing one (nothing about it, or its players, is said). */
    if (options.moneyOnly === true && record.money === null) return null;
    const verdict = authorize("read-view", { record, facts: factsFromRecord(record), principalId: principalId ?? "", now: now(), held: false });
    if (!verdict.ok) return null;
    return record.seats.map((seat) => ({ playerId: seat.player_id, principalId: seat.principal_id }));
  }

  /** Phase 3 (P3-N035): who is seated at a table now (server-side only: a conduct reviewer seated there is a party). */
  function seatPrincipalsOf(gameId: string): readonly string[] {
    const record = peekLoaded(gameId)?.view.record ?? recordIndex.get(gameId) ?? null;
    return record === null ? [] : record.seats.map((seat) => seat.principal_id);
  }

  /** P3-ACCT (trust indicators): every table the index knows that `principalId` holds a seat at (server-side only). */
  function tablesOf(principalId: string): GameRecord[] {
    return [...recordIndex.values()].filter((record) => seatOf(record, principalId) !== null);
  }

  /** A hold discovery found this run but could not write down (the load honours it as if its file existed). */
  function pendingHoldOf(gameId: string): { code: HoldCode; detail: string } | null {
    return discoveryHolds.get(gameId) ?? null;
  }

  /** The seat's `player_id` for `principalId` in `gameId`'s committed record, or `null` (the actor's in-flight and
   *  late-answer bookkeeping keys a server-owned game's submissions by the log's actor, never by the principal). */
  function playerIdOf(gameId: string, principalId: string): string | null {
    const record = peekLoaded(gameId)?.view.record;
    return record ? (seatOf(record, principalId)?.player_id ?? null) : null;
  }

  /** The authorization overlay "held" (stage Hd for a dealt game): an incompatible pin (#1520) or, LIVE-3C, a
   *  maintenance hold. */
  const heldOf = (view: CommittedView) => view.incompatible !== null || isMaintenanceHold(view.hold);

  /** LIVE-3C: a `gone` refusal says what ended the table (cancelled, expired, archived) -- to a principal the table has
   *  already said it may read, never to an outsider (who is answered `not-found` first). */
  function withGoneReason<T extends { ok: boolean; code?: string; reason?: string }>(verdict: T, record: Readonly<GameRecord> | null): T {
    return !verdict.ok && verdict.code === "gone" ? { ...verdict, reason: goneSentence(record) } : verdict;
  }

  /** Authorize `op` for `principal` against the game's committed record, outside any task (reads, pushes). */
  function authorizeNow(game: GameActor, principalId: string | null, op: RoomOp) {
    const view = game.view;
    const record = view.record;
    return withGoneReason(
      authorize(op, {
        record,
        facts: record === null ? factsFromEntries([], false, false) : factsFromView(view, record),
        principalId,
        now: now(),
        held: heldOf(view),
      }),
      record,
    );
  }

  /* ---- projections and pushes ---- */

  const onlineIn = (gameId: string, record: GameRecord) => (playerId: string) => {
    const seat = record.seats.find((entry) => entry.player_id === playerId);
    if (seat === undefined) return false;
    for (const socket of viewSubs.get(gameId) ?? []) if (principalOf(socket) === seat.principal_id) return true;
    return false;
  };

  /** ESCROW-4: a real-money table's projection for this viewer (terms only when the money layer is unavailable). */
  const moneyViewOf = (record: GameRecord, principalId: string | null) => {
    if (record.money === null) return null;
    return deps.money?.()?.viewFor(record, principalId) ?? disabledMoneyView(record, principalId);
  };

  function viewFrame(game: GameActor, principalId: string): object | null {
    const view = game.view;
    const record = view.record;
    if (record === null) return null;
    const facts = factsFromView(view, record);
    const money = moneyViewOf(record, principalId);
    return {
      kind: "room",
      gameId: record.game_id,
      view: roomViewFor(record, facts, principalId, {
        now: now(),
        held: heldOf(view),
        holdKind: kindOf(view),
        /* LIVE-4 (L4-3): the reason the standing notice says -- the session's own sentence, as its frame says it. */
        holdReason: notContinuedReasonOf(view),
        online: onlineIn(record.game_id, record),
        /* ESCROW-4: a real-money table starts from the chain's funding (the money view says when; never `ready`). */
        canStart: record.money === null ? !facts.dealt && waitingBlock(record) === null && view.hold === null : !facts.dealt && view.hold === null && money?.start.canStart === true,
        money,
        /* Phase 3 final clocks: the table clock, the same for every viewer (absent while held or not yet read). */
        clock: clock === null || view.hold !== null || view.incompatible !== null ? null : clock.viewOf(record.game_id),
      }),
    };
  }

  function dropView(socket: WebSocket, options: { quiet?: boolean } = {}): void {
    const gameId = viewGameOf.get(socket);
    if (gameId === undefined) return;
    viewGameOf.delete(socket);
    const set = viewSubs.get(gameId);
    set?.delete(socket);
    if (set !== undefined && set.size === 0) {
      viewSubs.delete(gameId);
      unpinFor(gameId);
    }
    const principalId = principalOf(socket);
    const game = peekLoaded(gameId);
    const seat = game?.view.record && principalId !== null ? seatOf(game.view.record, principalId) : null;
    /* LIVE-2E: PRESENCE IS THE SEAT'S, NOT THE SOCKET'S. A player with two tabs or two devices is one seat; closing
       one of them must not make the seat look gone while another of its sockets still reads the table. The hint is
       cleared only when the LAST socket of that principal leaves -- and everybody else's `online` is recomputed. */
    const stillHere = principalId !== null && [...(viewSubs.get(gameId) ?? [])].some((other) => principalOf(other) === principalId);
    if (seat && !stillHere && presence.get(gameId)?.delete(seat.player_id)) broadcastPresence(gameId);
    /* Not from an eviction: that path's record change is pushed by its own publish, and a nested push there would
       only repeat it. */
    if (seat && !stillHere && !options.quiet && viewSubs.has(gameId)) broadcastView(gameId);
    deps.onSubscriptionChange(socket);
  }

  /** Lost read access (kicked, dropped at the deal, a room gone private): told once, closed 4410 (§6.2). */
  function evict(socket: WebSocket, code: string, reason: string): void {
    dropView(socket, { quiet: true });
    deps.send(socket, { kind: "error", code, reason });
    if (socket.readyState === socket.OPEN) socket.close(4410, "room access lost");
  }

  /** LIVE-4 (L4-3): whether this socket's client may be shown `game` now (the server answered it when not). */
  function clientMayRead(socket: WebSocket, gameId: string, game: GameActor): boolean {
    return deps.clientMayRead === undefined || deps.clientMayRead(socket, gameId, game.view);
  }

  /** Push the room's view to every subscriber, each re-authorized against the record committed NOW. */
  function broadcastView(gameId: string): void {
    const game = peekLoaded(gameId);
    if (game === undefined) return;
    for (const socket of [...(viewSubs.get(gameId) ?? [])]) {
      const principalId = principalOf(socket);
      const verdict = authorizeNow(game, principalId, "read-view");
      if (!verdict.ok) {
        counters.viewPushesRefused += 1;
        evict(socket, verdict.code, verdict.reason);
        continue;
      }
      /* LIVE-4 (L4-3): and the tab against the game -- a deal this tab cannot play is judged in the push that shows
         it dealt; the tab was answered (`reload`) and gets no more of this room. */
      if (!clientMayRead(socket, gameId, game)) {
        counters.viewPushesRefused += 1;
        dropView(socket, { quiet: true });
        continue;
      }
      const frame = viewFrame(game, principalId as string);
      if (frame !== null) deps.send(socket, frame);
    }
  }

  function chatFrame(gameId: string) {
    return { kind: "chat", gameId, messages: chats.get(gameId) ?? [] };
  }

  function presenceFrame(gameId: string) {
    return { kind: "presence", gameId, now: now(), entries: [...(presence.get(gameId)?.values() ?? [])] };
  }

  function pushToReaders(gameId: string, frame: object): void {
    const game = peekLoaded(gameId);
    if (game === undefined) return;
    for (const socket of [...(viewSubs.get(gameId) ?? [])]) {
      const verdict = authorizeNow(game, principalOf(socket), "read-view");
      if (!verdict.ok) {
        counters.viewPushesRefused += 1;
        evict(socket, verdict.code, verdict.reason);
        continue;
      }
      if (!clientMayRead(socket, gameId, game)) {
        counters.viewPushesRefused += 1;
        dropView(socket, { quiet: true });
        continue;
      }
      deps.send(socket, frame);
    }
  }

  function broadcastPresence(gameId: string): void {
    pushToReaders(gameId, presenceFrame(gameId));
  }

  /* ---- the public list: coalesced ---- */
  /* PLAY LOBBY: a seat's public name is its ACCOUNT display name (unique), never its cosmetic nickname; a seat whose
     principal has no profile name reads "A player". With no identity wired (tests), the nickname. */
  const publicSeatName: PublicSeatName = (seat) =>
    deps.profileNameOf === undefined ? seat.nickname : (deps.profileNameOf(seat.principal_id) ?? "A player");
  /* PLAY LOBBY: a listed table's deadline, from its clock record -- the controller's when it holds it, else read once
     from the clock store (the list is pushed again when it arrives). Never guessed: unknown is left out. */
  const lobbyClocks = new Map<string, NonNullable<RoomSummary["clock"]>>();
  const lobbyClockReads = new Set<string>();
  function lobbyClockOf(gameId: string): RoomSummary["clock"] | null {
    if (clock === null) return null;
    const held = clock.recordOf(gameId);
    if (held !== null) return { deadline: held.policy.class, paceSecs: held.policy.class === "async-pace" ? held.policy.pace_secs : null };
    const known = lobbyClocks.get(gameId);
    if (known !== undefined) return known;
    if (!lobbyClockReads.has(gameId)) {
      lobbyClockReads.add(gameId);
      clock.deadlineOf(gameId).then(
        (read) => {
          if (read === null) return;
          lobbyClocks.set(gameId, { deadline: read.deadline, paceSecs: read.deadline === "async-pace" ? read.paceSecs : null });
          scheduleList();
        },
        () => lobbyClockReads.delete(gameId),
      );
    }
    return null;
  }
  function summaries(): RoomSummary[] {
    const out: RoomSummary[] = [];
    for (const record of recordIndex.values()) {
      /* LIVE-3C: ONLY WHAT IS KNOWN. A game not yet reconciled this run is left out -- its record says "playing" or
         "waiting" and nobody has checked that against its log -- and so is one concluded held, incompatible,
         unavailable or needing attention (nobody can join or play it). It appears once its first load (anybody's
         reconnect, room view or code) has reconciled it. */
      const now_ = classifyNow(record.game_id).cls;
      if (now_ !== "waiting" && now_ !== "active") continue;
      const resident = peekLoaded(record.game_id);
      const facts = resident ? factsFromView(resident.view, record) : factsFromEntries([], false, false);
      const dealtFromRecord = record.started_at !== null || record.status === "active" || record.status === "completed";
      const stake = record.money === null ? null : (deps.money?.()?.stakeFor(record) ?? disabledStake(record));
      const summary = roomSummaryOf(record, resident ? facts : { ...facts, dealt: dealtFromRecord, ended: record.status === "completed" }, now(), stake, {
        nameOf: publicSeatName,
        clock: record.visibility === "public" ? lobbyClockOf(record.game_id) : null,
      });
      if (summary !== null) out.push(summary);
    }
    /* Only listed tables keep a remembered deadline. */
    const listed = new Set(out.map((summary) => summary.gameId));
    for (const gameId of [...lobbyClocks.keys()]) if (!listed.has(gameId)) lobbyClocks.delete(gameId);
    for (const gameId of [...lobbyClockReads]) if (!listed.has(gameId) && !recordIndex.has(gameId)) lobbyClockReads.delete(gameId);
    return out.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  let listTimer: ReturnType<typeof setTimeout> | null = null;
  let listSentAt = 0;
  function scheduleList(): void {
    if (listWatchers.size === 0 || listTimer !== null) return;
    const wait = Math.max(0, listSentAt + rooms.listCoalesceMs - Date.now());
    listTimer = setTimeout(() => {
      listTimer = null;
      listSentAt = Date.now();
      /* A timer has no caller to answer: nothing it meets may escape it (review H1). */
      try {
        const frame = { kind: "rooms", rooms: summaries() };
        for (const socket of listWatchers) deps.send(socket, frame);
      } catch (error) {
        deps.warn(`  rooms: the public list could not be built -- ${error instanceof Error ? error.message : String(error)}`);
      }
    }, wait);
    listTimer.unref?.();
  }

  /** Called inside the actor's publish of a changed record (synchronous, after the store has it). */
  function onRecordPublished(record: GameRecord): void {
    const previous = recordIndex.get(record.game_id);
    recordIndex.set(record.game_id, record);
    unknownGames.delete(record.game_id);
    /* A kick takes effect before anything else is pushed: the kicked principal's sockets are closed FIRST, so not even
       the view that records the kick reaches them (and a public room's kicked watcher is not re-served as a viewer). */
    const kicked = record.kicked_principals.filter((id) => !(previous?.kicked_principals ?? []).includes(id));
    if (kicked.length > 0) {
      for (const socket of [...(viewSubs.get(record.game_id) ?? [])]) {
        /* LIVE-2D: said as `kicked` -- the principal was seated here, so naming the kick tells it nothing it did not
           know, and the player reads "the host removed you" rather than "that table is not available". */
        if (kicked.includes(principalOf(socket) ?? "")) evict(socket, "kicked", "The host removed you from that game.");
      }
    }
    const seats = presence.get(record.game_id);
    if (seats !== undefined) {
      const live = new Set(record.seats.map((seat) => seat.player_id));
      for (const playerId of [...seats.keys()]) if (!live.has(playerId)) seats.delete(playerId);
    }
    broadcastView(record.game_id);
    scheduleList();
  }

  /* ---- the actor task that runs an op ---- */

  type Refusal = { ok: false; code: string; reason: string };
  type Ran<T> = { ok: true; value: T } | Refusal;

  const UNAVAILABLE = "The game server could not record that change, so it was not made. Try again.";
  const BUSY = "The game server is busy with this game. Try again in a moment.";

  /** Mint and claim a fresh join code (index first, LIVE-2 §14.5): up to five tries on a collision. */
  async function claimFreshCode(gameId: string): Promise<string | null> {
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = mintJoinCode();
        if ((await deps.records.claimCode(code, gameId)) === "claimed") return code;
      }
      deps.warn(`  records: five fresh join codes for ${gameId} were all taken -- the random source is suspect`);
    } catch (error) {
      /* §14.5: the index write failed -- nothing refers to the code yet, so the op is refused and nothing else moves. */
      deps.warn(`  records: the join-code index refused a claim for ${gameId} -- ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  const releaseLater = (code: string | undefined, gameId: string) => {
    if (code === undefined) return;
    void deps.records.releaseCode(code, gameId).catch((error) =>
      deps.warn(`  records: could not release a join code of ${gameId} -- ${error instanceof Error ? error.message : String(error)} (an orphan entry resolves to nothing)`),
    );
  };

  /** Run one op as a task on the game's actor. In order: an outsider is answered `not-found` before anything else
   *  (§6.2 -- before the hold, the TTL and the index, so none of them tells a private room exists); the waiting-room
   *  TTL, made durable; the op's fresh join code, claimed only once the op is authorized (no index writes on behalf
   *  of someone who may not rotate); the op against the committed record; the conditional, durable commit.
   *  `opName` null: a server task (the expiry sweep), which has no caller to authorize. */
  async function runOp(
    game: GameActor,
    principalId: string,
    opName: RoomOp | null,
    op: (env: OpEnv, freshCode: string | null) => OpOutcome,
    /** Whether the op needs a fresh join code -- judged against the record committed when the task runs. */
    needsCode: (record: GameRecord) => boolean = () => false,
    /** ESCROW-4: the seat a `kick` names (the money table's seat lock is judged for it). */
    moneyTarget: string | null = null,
  ): Promise<Ran<OpOutcome & { ok: true }>> {
    const outcome = await game.run("room-op", async (tx): Promise<Ran<OpOutcome & { ok: true }>> => {
      const record = tx.view.record;
      if (record === null) return { ok: false, code: "not-found", reason: "There is no such game." };
      const maintenance = isMaintenanceHold(tx.view.hold);
      const facts = maintenance ? factsFromRecord(record) : factsFromTx(tx, boardOf(record.game_id, tx.session));
      const at = now();
      const held = heldOf(tx.view);
      const verdict = opName === null ? null : authorize(opName, { record, facts, principalId, now: at, held });
      if (verdict !== null && !verdict.ok && verdict.code === "not-found") return { ok: false, code: verdict.code, reason: verdict.reason };
      /* LIVE-3C: NOTHING ABOUT A HELD GAME CHANGES -- not its seats, host, code or lifecycle, not by any op, not by the
         expiry or archive sweeps (`opName` null). A `leave` only unsubscribes (the seat and admission stay exactly as
         the record holds them), so "Back to the lobby" still works; everything else is told the one held sentence. */
      if (maintenance) {
        if (opName === "leave" && verdict !== null && verdict.ok) return { ok: true, value: { ok: true, record: null, effects: { unsubscribeOnly: true } } };
        return { ok: false, code: "held", reason: HELD_PLAYER_SENTENCE };
      }
      if (tx.view.hold !== null && tx.view.hold.reason !== "version") return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      /* LIVE-3C (review E1): a server task (the expiry and archive sweeps) never acts on a game this build cannot
         interpret -- its record's lifecycle claims could not be checked against a board nobody replayed. */
      if (opName === null && (tx.view.incompatible !== null || tx.view.hold?.reason === "version")) return { ok: false, code: "held", reason: HELD_PLAYER_SENTENCE };
      /* LIVE-2F/3D (C4-05): NOR IS ONE THIS POOL DOES NOT CONTINUE CHANGED BY A PLAYER. It is kept exactly as it was
         (its host too): a `leave` only unsubscribes. LIVE-4 (L4-2): "does not continue" is the session's verdict (or
         its serving decision) -- a deal made on another build is no longer a reason; its semantic identity is. */
      if (opName !== null && (tx.view.incompatible !== null || tx.view.hold?.reason === "version")) {
        if (opName === "leave" && verdict !== null && verdict.ok) return { ok: true, value: { ok: true, record: null, effects: { unsubscribeOnly: true } } };
        return { ok: false, code: "wrong-state", reason: FROZEN_GAME_SENTENCE };
      }
      /* LIVE-6 L6-2: A RESTORED MONEY TABLE IS READ-ONLY UNTIL ITS HISTORY IS VERIFIED (post-restore safe mode): no seat,
         ticket, freeze or table op of it runs -- a `leave` only unsubscribes -- and no server task either (`opName` null:
         the expiry / archive sweeps, the chain mirror's `extendExpiry` / `mirrorCancelled`; review M1). No-money tables are
         served as ever. */
      if (record.record_schema === 2) {
        const restoring = deps.escrow?.restoreGate?.(record.game_id) ?? null;
        if (restoring !== null) {
          if (opName === "leave" && verdict !== null && verdict.ok) return { ok: true, value: { ok: true, record: null, effects: { unsubscribeOnly: true } } };
          return { ok: false, code: "held", reason: restoring };
        }
      }
      /* ESCROW-3B (brief §16): A FROZEN FINANCIAL ROSTER IS FINAL. From the start-intent task on, no seat of a money
         table moves -- no seat taken or released, no kick, no rename, no cancel from the server; a `leave` only
         unsubscribes (the seat, its principal, its player_id and its money are unchanged). */
      if (opName !== null && FROZEN_ROSTER_OPS.has(opName) && deps.escrow?.isRosterFrozen(record.game_id) === true) {
        if (opName === "leave" && verdict !== null && verdict.ok) return { ok: true, value: { ok: true, record: null, effects: { unsubscribeOnly: true } } };
        return { ok: false, code: "wrong-state", reason: FROZEN_ROSTER_SENTENCE };
      }
      /* LIVE-3C: NOTHING IS WRITTEN ON AN UNRECONCILED RECORD (its load's repair has not landed): refused, and the
         reconciliation tried again as a task of its own -- so no op, and no sweep, builds on a record the log may
         contradict. */
      if (awaitingReconciliation(game)) return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      /* ESCROW-4: A REAL-MONEY TABLE'S SEATS ARE MONEY. Before the deal, Leave is an unsubscribe (a seat is given up only
         by release-seat, and only when nothing of it can be on Juno); kick, release, host transfer and cancel are decided
         again HERE -- in this task, against the ledger and the chain (R-J1, W-2, W-3) -- so an admission, a link or a
         deposit and a seat change never interleave. Without a working money layer nothing of a seat moves. */
      if (record.money !== null && opName !== null && (verdict === null || verdict.ok) && !facts.dealt) {
        if (opName === "leave") return { ok: true, value: { ok: true, record: null, effects: { unsubscribeOnly: true } } };
        if (MONEY_SEAT_OPS.has(opName)) {
          const money = deps.money?.() ?? null;
          const refused = money === null ? { code: "money-unavailable", reason: MONEY_UNAVAILABLE_SENTENCE } : await money.seatOpRefusal(record, opName, principalId, moneyTarget);
          if (refused !== null) return { ok: false, code: refused.code, reason: refused.reason };
        }
      }
      /* THE WAITING-ROOM TTL (§5.3), made durable by the first op (or sweep) that finds it passed. ESCROW-3B (review
         #8): never for a table whose financial roster is frozen -- expiring it would be the server cancelling it. */
      if (record.status === "waiting" && effectiveStatus(record, facts, at) === "expired" && deps.escrow?.isRosterFrozen(record.game_id) !== true) {
        const expired = { ...record, status: "expired" as const, join_code: null, expires_at: record.expires_at, record_version: record.record_version + 1, last_activity_at: at };
        const settled = await tx.commitRecord(expired, () => ({}));
        if (settled.kind === "committed") {
          releaseLater(record.join_code ?? undefined, record.game_id);
          ops.audit("record.expired", { game_id: record.game_id });
        }
        return { ok: false, code: "gone", reason: GONE_SENTENCES.expired };
      }
      let fresh: string | null = null;
      if (needsCode(record)) {
        if (verdict !== null && !verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason };
        fresh = await claimFreshCode(record.game_id);
        if (fresh === null) return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      }
      /* LIVE-2E: a seat taken here starts with the profile's name (the room's own `set-profile` still decides it). */
      const seed = deps.profileNameOf?.(principalId) ?? null;
      const env: OpEnv = { record, facts, principalId, now: at, held, mintPlayerId: () => mintPlayerId(), ...(seed !== null ? { defaultNickname: seed } : {}) };
      const result = op(env, fresh);
      if (!result.ok || result.record === null) {
        releaseLater(fresh ?? undefined, record.game_id);
        return result.ok ? { ok: true, value: result } : withGoneReason(result, record);
      }
      const settled = await tx.commitRecord(result.record, (s) => ({
        after: () => {
          if (s.kind !== "committed") return;
          for (const evicted of result.effects?.evicted ?? []) {
            for (const socket of [...(viewSubs.get(record.game_id) ?? [])]) {
              if (principalOf(socket) === evicted) evict(socket, "not-found", "You no longer have access to that game.");
            }
          }
        },
      }));
      if (settled.kind !== "committed") {
        /* A definite failure wrote nothing, so the fresh claim is released. An UNKNOWN outcome may have landed -- the
           record on disk may hold the fresh code -- so its claim is kept (the game is held until a restart). */
        if (settled.kind === "failed") releaseLater(fresh ?? undefined, record.game_id);
        return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      }
      if (fresh !== null || result.effects?.releaseCode !== undefined) {
        releaseLater(result.effects?.releaseCode, record.game_id);
      }
      return { ok: true, value: result };
    });
    if (outcome.kind === "ran") return outcome.value;
    if (outcome.kind === "busy") return { ok: false, code: "busy", reason: BUSY };
    if (outcome.kind === "expired") return { ok: false, code: "retry", reason: "The game server did not get to that in time. Try again." };
    const ref = deps.errorRef();
    deps.warn(`  threw: a room op failed (ref ${ref}) -- ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
    return { ok: false, code: "internal", reason: `The server could not process that request. (ref ${ref})` };
  }

  /* ---- counting the caps across games ---- */

  /** Seats being claimed (join / take-seat in flight) per principal: counted like creates in flight (review L2). */
  const pendingSeats = new Map<string, number>();
  const adjust = (map: Map<string, number>, key: string, by: number) => {
    const next = (map.get(key) ?? 0) + by;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };

  function capsOf(principalId: string): { hosted: number; seated: number } {
    let hosted = pendingCreates.get(principalId) ?? 0;
    let seated = hosted + (pendingSeats.get(principalId) ?? 0);
    for (const record of recordIndex.values()) {
      if (isTerminal(record.status) || record.status === "completed" || record.archived_at !== null) continue;
      /* LIVE-3C: a held or incompatible table is frozen, not open -- it takes nobody's cap (review). An unreconciled
         record's own claim is used here, and only here: a cap is an abuse bound, not a statement about the game. */
      const frozen = classifyNow(record.game_id).cls;
      /* LIVE-2F/3D (C4-01) / LIVE-4 (L4-2): an incompatible one is a game this pool does not continue (its verdict, or
         its serving decision) -- it takes no cap either. A game dealt on another build that this pool DOES continue is
         an ordinary live table now, and counts. */
      if (frozen === "held" || frozen === "incompatible") continue;
      if (record.status === "waiting" && record.expires_at !== null && now() >= record.expires_at && record.started_at === null) continue;
      const seat = seatOf(record, principalId);
      if (seat === null) continue;
      seated += 1;
      if (seat.player_id === record.host_player_id) hosted += 1;
    }
    return { hosted, seated };
  }

  /* ---- the frames ---- */

  const ack = (socket: WebSocket, requestId: string, result: { ok: true; data?: Record<string, unknown> } | { ok: false; code: string; reason: string }) =>
    deps.send(socket, result.ok ? { kind: "room-ack", requestId, ok: true, ...(result.data ? { data: result.data } : {}) } : { kind: "room-ack", requestId, ok: false, code: result.code, reason: result.reason });

  const MEMBERSHIP_OPS = new Set(["join", "take-seat", "release-seat", "leave", "set-ready", "set-profile", "set-ante"]);
  /** Each game op's row in the authorization table (runOp answers an outsider `not-found` before anything else). */
  const OP_NAMES: Readonly<Record<string, RoomOp>> = Object.freeze({
    "take-seat": "take-seat",
    "release-seat": "release-seat",
    leave: "leave",
    "set-ready": "set-ready",
    "set-profile": "set-profile",
    "set-visibility": "set-visibility",
    "rotate-code": "rotate-code",
    kick: "kick",
    "transfer-host": "transfer-host",
    "cancel-room": "cancel-room",
    "set-ante": "set-ante",
  });

  async function activated(principalId: string): Promise<boolean> {
    try {
      await deps.identity.activate(principalId, now());
      return true;
    } catch (error) {
      const ref = deps.errorRef();
      deps.warn(`  identity: could not make a principal durable before a room change (ref ${ref}) -- ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** PHASE 3 FINAL: a table without an ante, where this server serves no free game (watching it stays open). */
  const ANTE_REQUIRED = { ok: false as const, code: "ante-required", reason: "Every game here is a real-money game with an ante. This table has no ante, so it can be watched but not joined or started." };
  const freeTableRefused = (record: GameRecord | null): boolean => deps.freeTables === false && record !== null && record.money === null;

  async function handleCreate(socket: WebSocket, ctx: ConnectionContext, requestId: string, op: Record<string, unknown>): Promise<void> {
    await indexReady;
    const ip = deps.ipOf(socket);
    /* ESCROW-4: a stake opens a REAL-MONEY table -- only where the money layer is configured, enabled by the operator,
       verified against the chain and not on mainnet; its terms come from the server's pinned deployment (the host picks
       only the ante and the exact player count; the escrow's pace is the table's own `variants.mode`). A zero stake,
       or none, is an ordinary table. */
    const stakeRaw = op.stake;
    let moneyTerms: GameMoneyTerms | null = null;
    /* Phase 3 final clocks: the table's deadline class. A Live table is always Live; an Async table may name its pace
       (or No-deadline) now -- a MONEY Async table must, since its escrow is created from it -- and a No-deadline money
       table's host acknowledges the indefinite-lock disclosure with the create (before any ante). */
    const asyncTable = resolveVariants(op.variants as never).mode === "async";
    const isMoney = stakeRaw !== undefined && !(typeof stakeRaw === "string" && /^0+$/.test(stakeRaw));
    const deadline = op.deadline === undefined ? null : (op.deadline as "live" | "async-pace" | "no-deadline");
    const paceSecs = typeof op.paceSecs === "number" ? op.paceSecs : null;
    if (!asyncTable && deadline !== null && deadline !== "live") return ack(socket, requestId, { ok: false, code: "bad-frame", reason: "A Live table always plays the Live action clock." });
    if (asyncTable && deadline === "live") return ack(socket, requestId, { ok: false, code: "bad-frame", reason: "An Async table chooses a pace or no deadline." });
    if (deadline === "async-pace" && paceSecs === null) return ack(socket, requestId, { ok: false, code: "bad-frame", reason: "Choose 12 hours, 24 hours, 2 days, 3 days or 7 days." });
    if (isMoney && asyncTable) {
      if (clock === null) return ack(socket, requestId, { ok: false, code: "money-games-disabled", reason: "This server can't time an Async table with stakes." });
      if (deadline === null) return ack(socket, requestId, { ok: false, code: "bad-frame", reason: "Choose the table's pace (12 hours to 7 days) or No deadline before opening it with stakes." });
      if (deadline === "no-deadline" && op.noDeadlineAck !== true) return ack(socket, requestId, { ok: false, code: "acknowledge-no-deadline", reason: `${NO_DEADLINE_DISCLOSURE} Acknowledge this before opening the table.` });
    }
    if (isMoney && clock !== null && (deadline ?? "live") !== "no-deadline") {
      /* A TIMED money table's deadline is enforced on chain only through a dedicated REMEDY signer: without one, every
         remedy would be refused (fail closed) and an abandoned table's funds would wait on a unanimous annulment or the
         exceptional review. Such a table is not opened. */
      const port = deps.clock?.remedy?.() ?? null;
      if (port === null || !port.configured) return ack(socket, requestId, { ok: false, code: "money-games-disabled", reason: "This server can't enforce a timed deadline with stakes right now, so the table was not opened." });
    }
    if (isMoney) {
      const money = deps.money?.() ?? null;
      if (money === null) return ack(socket, requestId, { ok: false, code: "money-games-disabled", reason: "Games with stakes are not open on this server." });
      const prepared = await money.prepareCreate({ stake: stakeRaw, exactPlayers: op.exactPlayers, variants: resolveVariants(op.variants as never) });
      if (!prepared.ok) return ack(socket, requestId, { ok: false, code: prepared.code, reason: prepared.reason });
      moneyTerms = prepared.terms;
    }
    /* PHASE 3 FINAL: no free game in the player product -- a table is created with an ante, or not at all. */
    if (moneyTerms === null && deps.freeTables === false) {
      return ack(socket, requestId, { ok: false, code: "ante-required", reason: "Every game here is a real-money game: set an ante to host a table." });
    }
    const waits = [createsPrincipal.peek(ctx.principalId), ip ? createsIp.peek(ip) : 0, createsGlobal.peek("global")];
    if (waits.some((wait) => wait > 0)) {
      deny("room-create");
      return ack(socket, requestId, { ok: false, code: "rate-limited", reason: "Too many new tables too quickly. Try again later." });
    }
    const caps = capsOf(ctx.principalId);
    if (caps.hosted >= rooms.maxHostedRooms) return ack(socket, requestId, { ok: false, code: "limit-reached", reason: `You already host ${rooms.maxHostedRooms} open tables.` });
    if (caps.seated >= rooms.maxSeatedGames) return ack(socket, requestId, { ok: false, code: "limit-reached", reason: `You already sit at ${rooms.maxSeatedGames} open tables.` });
    createsPrincipal.take(ctx.principalId);
    if (ip) createsIp.take(ip);
    createsGlobal.take("global");
    pendingCreates.set(ctx.principalId, (pendingCreates.get(ctx.principalId) ?? 0) + 1);
    let code: string | null = null;
    let gameId = "";
    try {
      if (!(await activated(ctx.principalId))) return ack(socket, requestId, { ok: false, code: "unavailable", reason: "The server could not record who you are, so the table was not made. Try again." });
      do gameId = mintGameId();
      while (recordIndex.has(gameId) || deps.games.peek(gameId) !== undefined);
      const hostPlayerId = mintPlayerId();
      code = await claimFreshCode(gameId);
      if (code === null) return ack(socket, requestId, { ok: false, code: "unavailable", reason: UNAVAILABLE });
      const claimed = code;
      /* ESCROW-4: the financial record FIRST (a money GameRecord never exists without one; an orphan financial record of
         a create that then failed is inert: unbound, funding, no table). */
      if (moneyTerms !== null) {
        const opened = await (deps.money?.() as MoneyTables).openFinancial(gameId);
        if (!opened.ok) {
          releaseLater(claimed, gameId);
          return ack(socket, requestId, { ok: false, code: opened.code, reason: opened.reason });
        }
        /* Phase 3 final clocks: the deadline is recorded BEFORE the table exists, so no escrow is ever created (or bound)
           from a table whose deadline was not fixed. */
        if (clock !== null) {
          const fixed = await clock.createPolicy(gameId, { deadline: deadline ?? "live", paceSecs: deadline === "async-pace" ? paceSecs : null, money: true, ackSeat: deadline === "no-deadline" ? hostPlayerId : null });
          if (!fixed.ok) {
            releaseLater(claimed, gameId);
            return ack(socket, requestId, { ok: false, code: fixed.code, reason: fixed.reason });
          }
        }
        /* LIVE-4 (L4-2): into the settlement index BEFORE the table's first session is made, so the continuation verdict
           that session asks sees the money facts (identity, pin) of the record just written -- never a money table the
           index has not seen. */
        await deps.moneyFacts?.refresh(gameId);
      }
      let unresolved = false;
      let game: GameActor;
      try {
        game = await deps.games.get(gameId);
      } catch (error) {
        releaseLater(claimed, gameId); // nothing refers to the code: never leave it claimed
        throw error;
      }
      counters.sessionsAllocated += 1;
      const outcome = await game.run("room-op", async (tx) => {
        if (tx.view.record !== null) return { ok: false as const, code: "internal", reason: "That table already exists." };
        const result = createRecord({
          gameId,
          joinCode: claimed,
          principalId: ctx.principalId,
          now: now(),
          visibility: op.visibility === "private" ? "private" : "public",
          exactPlayers: (op.exactPlayers as number | null) ?? null,
          variants: resolveVariants(op.variants as never),
          /* LIVE-2E: a create that names nobody is the profile's name, not "Host". */
          nickname: typeof op.nickname === "string" && op.nickname.trim() !== "" ? op.nickname : (deps.profileNameOf?.(ctx.principalId) ?? op.nickname),
          color: (op.color as string | null | undefined) ?? null,
          hostPlayerId,
          money: moneyTerms,
        });
        if (!result.ok || result.record === null) return result.ok ? { ok: false as const, code: "internal", reason: "No table." } : result;
        const settled = await tx.commitRecord(result.record, () => ({}));
        if (settled.kind === "unresolved") unresolved = true;
        if (settled.kind !== "committed") return { ok: false as const, code: "unavailable", reason: UNAVAILABLE };
        return result;
      });
      if (outcome.kind === "failed") {
        const ref = deps.errorRef();
        deps.warn(`  threw: a create failed (ref ${ref}) -- ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
      }
      const result = outcome.kind === "ran" ? outcome.value : { ok: false as const, code: "unavailable", reason: UNAVAILABLE };
      if (!result.ok) {
        /* An unknown outcome may have landed a record naming the code: the claim is kept (the game is held). */
        if (!unresolved) releaseLater(code, gameId);
        return ack(socket, requestId, result);
      }
      counters.created += 1;
      /* A free Async table that named its deadline at the create: recorded now (the host may still change it before
         play). A failure here changes nothing (the table plays No-deadline unless the host chooses again). */
      if (clock !== null && moneyTerms === null && asyncTable && deadline !== null) {
        await clock.createPolicy(gameId, { deadline, paceSecs: deadline === "async-pace" ? paceSecs : null, money: false }).catch(() => undefined);
      }
      return ack(socket, requestId, { ok: true, data: result.data });
    } finally {
      pendingCreates.set(ctx.principalId, (pendingCreates.get(ctx.principalId) ?? 1) - 1);
    }
  }

  async function handleJoin(socket: WebSocket, ctx: ConnectionContext, requestId: string, op: Record<string, unknown>): Promise<void> {
    const ip = deps.ipOf(socket);
    const failed = () => {
      joinFailPrincipal.take(ctx.principalId);
      if (ip) joinFailIp.take(ip);
      joinFailGlobal.take("global");
      return ack(socket, requestId, { ok: false, code: "invalid-or-expired", reason: "That code does not open a table right now." });
    };
    if (joinFailPrincipal.peek(ctx.principalId) > 0 || (ip && joinFailIp.peek(ip) > 0) || joinFailGlobal.peek("global") > 0) {
      deny("join-failures");
      return ack(socket, requestId, { ok: false, code: "rate-limited", reason: "Too many codes that did not work. Wait a few minutes." });
    }
    const code = parseJoinCode(op.code);
    if (code === null) return failed();
    const gameId = await deps.records.lookupCode(code);
    if (gameId === null) return failed();
    let game: GameActor | null;
    try {
      game = await actorFor(gameId);
    } catch (error) {
      /* LIVE-3C: the table could not be opened just now -- not a failed code, so nothing is charged to the budget. */
      if (error instanceof GameUnavailableError) return ack(socket, requestId, { ok: false, code: "unavailable", reason: UNAVAILABLE_PLAYER_SENTENCE });
      throw error;
    }
    if (game === null) return failed();
    const record = game.view.record as GameRecord;
    /* The code must still be THIS record's (an orphan, rotated or released entry is never authoritative), and a
       private room past its deal admits nobody new -- all answered alike. */
    if (record.join_code !== code || !authorizeNow(game, ctx.principalId, "join").ok) return failed();
    /* PHASE 3 FINAL: no seat at a table without an ante (a valid code is not a failed one: nothing is charged). */
    if (op.takeSeat === true && seatOf(record, ctx.principalId) === null && freeTableRefused(record)) return ack(socket, requestId, ANTE_REQUIRED);
    if (op.takeSeat === true && seatOf(record, ctx.principalId) === null && capsOf(ctx.principalId).seated >= rooms.maxSeatedGames) {
      return ack(socket, requestId, { ok: false, code: "limit-reached", reason: `You already sit at ${rooms.maxSeatedGames} open tables.` });
    }
    /* ACTIVATION BEFORE REFERENCE: only a join that may write this principal into the record (a seat, or a private
       room's admission) makes it durable; a public room's watcher owns nothing and stays provisional. */
    const mayName = op.takeSeat === true || record.visibility === "private";
    const claimingSeat = op.takeSeat === true;
    if (claimingSeat) adjust(pendingSeats, ctx.principalId, 1);
    try {
      if (mayName && !(await activated(ctx.principalId))) return ack(socket, requestId, { ok: false, code: "unavailable", reason: "The server could not record who you are. Try again." });
      const result = await runOp(game, ctx.principalId, "join", (env) => {
        if (env.record.join_code !== code) return { ok: false, code: "invalid-or-expired", reason: "That code does not open a table right now." };
        const joined = joinByCode(env, op.takeSeat === true);
        /* The room went private between the check above and this task: the admission would name a principal that
           was not made durable -- refused, and the client simply joins again. */
        if (joined.ok && joined.record !== null && !mayName) return { ok: false, code: "retry", reason: "The table changed while you were joining. Try again." };
        return joined;
      });
      if (!result.ok && (result.code === "invalid-or-expired" || result.code === "not-found" || result.code === "gone")) return failed();
      return ack(socket, requestId, result.ok ? { ok: true, data: result.value.data } : result);
    } finally {
      if (claimingSeat) adjust(pendingSeats, ctx.principalId, -1);
    }
  }

  /** `room-op` (LIVE-2 §6.3): create and join need no game; every other op names one. */
  async function handleRoomOp(socket: WebSocket, frame: { requestId: string; gameId?: string; op: Record<string, unknown> }): Promise<void> {
    const ctx = deps.contextOf(socket);
    if (ctx === undefined) return;
    const { requestId, op } = frame;
    const type = op.type as string;
    if (MEMBERSHIP_OPS.has(type)) {
      const wait = membership.take(ctx.principalId);
      if (wait > 0) {
        deny("membership-ops");
        return ack(socket, requestId, { ok: false, code: "rate-limited", reason: "Too many changes too quickly. Wait a moment." });
      }
    }
    if (type === "create") return handleCreate(socket, ctx, requestId, op);
    if (type === "join") return handleJoin(socket, ctx, requestId, op);
    if (type === "my-tables") return handleMyTables(socket, ctx, requestId);
    if (frame.gameId === undefined) return ack(socket, requestId, { ok: false, code: "bad-frame", reason: "That operation names no game." });
    let game: GameActor | null;
    try {
      game = await actorFor(frame.gameId);
    } catch (error) {
      if (error instanceof GameUnavailableError) return ack(socket, requestId, { ok: false, ...unavailableFor(frame.gameId, ctx.principalId) });
      throw error;
    }
    if (game === null) return ack(socket, requestId, { ok: false, code: "not-found", reason: "There is no such game." });
    if (type === "start-game") return ack(socket, requestId, await startGame(game, ctx.principalId));
    if (type === "report-player") return handleReport(socket, ctx, requestId, game, op);
    if (CLOCK_OP_TYPES.has(type)) {
      if (clockOps.take(ctx.principalId) > 0) {
        deny("clock-ops");
        return ack(socket, requestId, { ok: false, code: "rate-limited", reason: "Too many changes too quickly. Wait a moment." });
      }
      return ack(socket, requestId, await clockRoomOp(game, ctx.principalId, op));
    }
    const opName = OP_NAMES[type] ?? null;
    let claimingSeat = false;
    if (type === "take-seat") {
      /* Authorized FIRST (review L3/L4): an outsider learns nothing from the cap, and nobody is made durable for a
         seat they may not take. */
      const verdict = authorizeNow(game, ctx.principalId, "take-seat");
      if (!verdict.ok) return ack(socket, requestId, verdict);
      const record = game.view.record as GameRecord;
      /* PHASE 3 FINAL: no new seat at a table without an ante -- decided AFTER the authorization (security review,
         INFO 5): an outsider of a private table is answered exactly as before (as if it did not exist). */
      if (freeTableRefused(record) && seatOf(record, ctx.principalId) === null) return ack(socket, requestId, ANTE_REQUIRED);
      if (seatOf(record, ctx.principalId) === null) {
        if (capsOf(ctx.principalId).seated >= rooms.maxSeatedGames) {
          return ack(socket, requestId, { ok: false, code: "limit-reached", reason: `You already sit at ${rooms.maxSeatedGames} open tables.` });
        }
        claimingSeat = true;
        adjust(pendingSeats, ctx.principalId, 1);
      }
    }
    try {
      if (type === "take-seat" && !(await activated(ctx.principalId))) {
        return ack(socket, requestId, { ok: false, code: "unavailable", reason: "The server could not record who you are. Try again." });
      }
      /* A code rotation rewrites the join index: budgeted per game, charged only to its host (review L6). */
      if (type === "rotate-code" || (type === "set-visibility" && op.visibility === "private")) {
        if (authorizeNow(game, ctx.principalId, opName as RoomOp).ok && rotations.take(frame.gameId) > 0) {
          deny("code-rotations");
          return ack(socket, requestId, { ok: false, code: "rate-limited", reason: "The code has changed too often. Try again later." });
        }
      }
      const needsCode = (record: GameRecord) => type === "rotate-code" || (type === "set-visibility" && op.visibility === "private" && record.visibility !== "private");
      /* PLAY WAITING ROOM: a new ante is checked as a create's stake is before the table's task runs; whether it may
         still change is decided inside the task (MONEY_SEAT_OPS -> `seatOpRefusal`). */
      let anteStake: string | null = null;
      if (type === "set-ante") {
        const verdict = authorizeNow(game, ctx.principalId, "set-ante");
        if (!verdict.ok) return ack(socket, requestId, verdict);
        const money = deps.money?.() ?? null;
        if (money === null) return ack(socket, requestId, { ok: false, code: "money-unavailable", reason: MONEY_UNAVAILABLE_SENTENCE });
        const checked = await money.checkAnte(op.stake);
        if (!checked.ok) return ack(socket, requestId, { ok: false, code: checked.code, reason: checked.reason });
        anteStake = checked.stake;
      }
      const result = await runOp(game, ctx.principalId, opName, (env, fresh) => {
        switch (type) {
          case "take-seat":
            return takeSeat(env);
          case "release-seat":
            return releaseSeat(env);
          case "leave":
            return leave(env);
          case "set-ready":
            return setReady(env, op.ready === true);
          case "set-profile":
            return setProfile(env, { nickname: op.nickname, color: op.color });
          case "set-visibility":
            return setVisibility(env, op.visibility === "private" ? "private" : "public", fresh ?? "");
          case "rotate-code":
            return rotateCode(env, fresh as string);
          case "kick":
            return kick(env, String(op.playerId));
          case "transfer-host":
            return transferHost(env, String(op.toPlayerId));
          case "cancel-room":
            return cancelRoom(env);
          case "set-ante":
            return setAnte(env, anteStake as string);
          default:
            return { ok: false, code: "bad-frame", reason: "That is not a room operation." };
        }
      }, needsCode, type === "kick" ? String(op.playerId) : null);
      if (result.ok && result.value.effects?.unsubscribeOnly && viewGameOf.get(socket) === frame.gameId) dropView(socket);
      return ack(socket, requestId, result.ok ? { ok: true, ...(result.value.data ? { data: result.value.data } : {}) } : result);
    } finally {
      if (claimingSeat) adjust(pendingSeats, ctx.principalId, -1);
    }
  }

  /* ---- Phase 3 final clocks: the server's own move, and the clock's room ops ---- */

  /** A Live train offer's 10-minute response time ran out unanswered: the SERVER closes it, in the game's own task, as
   *  the proposer's rescission (the one legal message that withdraws a standing offer; the engine has no expiry), its
   *  entries stamped at the exact moment the response time ended. The clock folds it as an expiry: the proposer resumes
   *  exactly the time it had, the direction counts one decline, and no undo may reach back across it. */
  const closeExpiredOffer: CloseOffer = async (game, tx, input) => {
    const record = tx.view.record;
    if (record === null) return { ok: false, why: "the table has no record" };
    const rescinded = rescindExpiredOffer(tx.session, { proposer: input.proposer, at: input.at, offerKey: input.offerKey, build: deps.build, host: record.host_player_id, hostUndo: record.policy.host_undo }, deps.stampAt);
    if (!rescinded.ok) {
      tx.rollback();
      return { ok: false, why: rescinded.why, kind: "engine" };
    }
    const settled = await tx.commitBatch(rescinded.batch, (s) =>
      s.kind === "committed" ? { fanout: { kind: "applied", entries: s.entries, digest: s.view.digest, ...(s.view.fields ? { fields: { ...s.view.fields } } : {}), build: deps.build } } : {},
    );
    if (settled.kind !== "committed") return { ok: false, why: "the expiry could not be committed", kind: "store" };
    ops.audit("clock.trade-expired", { game_id: game.gameId, proposer: input.proposer, at: input.at, index: rescinded.batch[0]?.index ?? null });
    afterGameplay(game, rescinded.after.over, rescinded.after.closed, rescinded.board);
    return { ok: true, first: rescinded.batch[0].index, last: rescinded.batch[rescinded.batch.length - 1].index, before: rescinded.before, after: rescinded.after };
  };

  const CLOCK_OP_TYPES: ReadonlySet<string> = new Set(["clock-policy", "clock-pause", "clock-sysresume", "clock-propose", "clock-vote", "clock-annul", "clock-ack"]);

  /** A table-clock op: the caller's own seat (the host's for the deadline), checked; a money YES's approval verified
   *  OUTSIDE the game's task (a quorum chain read) against the overdue standing now, then applied INSIDE it (which
   *  re-checks that overdue is still the one standing). */
  async function clockRoomOp(game: GameActor, principalId: string, op: Record<string, unknown>): Promise<ClockAnswer> {
    if (clock === null) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "This server keeps no table clock." };
    if (awaitingReconciliation(game)) return { ok: false, code: "unavailable", reason: UNAVAILABLE_PLAYER_SENTENCE };
    const view = game.view;
    const record = view.record;
    if (record === null) return { ok: false, code: "not-found", reason: "There is no such game." };
    if (view.hold !== null || view.incompatible !== null) return { ok: false, code: "wrong-state", reason: "This table is held; its clock cannot change now." };
    const seat = seatOf(record, principalId)?.player_id ?? null;
    const type = String(op.type);
    if (seat === null) return { ok: false, code: "forbidden", reason: "Only a seated player can do that." };
    let input: ClockOpInput;
    switch (type) {
      case "clock-policy":
        if (seat !== record.host_player_id) return { ok: false, code: "forbidden", reason: "Only the host chooses the table's deadline." };
        if (record.money !== null) return { ok: false, code: "wrong-state", reason: "A money table's deadline is fixed when the table is created." };
        if ((record.variants as { mode?: string }).mode !== "async" && op.deadline !== "live") return { ok: false, code: "bad-frame", reason: "A Live table always plays the Live action clock." };
        if ((record.variants as { mode?: string }).mode === "async" && op.deadline === "live") return { ok: false, code: "bad-frame", reason: "An Async table chooses a pace or no deadline." };
        input = { type: "clock-policy", seat, deadline: op.deadline as "live" | "async-pace" | "no-deadline", paceSecs: typeof op.paceSecs === "number" ? op.paceSecs : null };
        break;
      case "clock-ack":
        input = { type: "clock-ack", seat };
        break;
      case "clock-pause":
        input = { type: "clock-pause", seat, action: op.action as "request" | "yes" | "no", kind: op.kind as "pause" | "resume", id: typeof op.id === "number" ? op.id : null };
        break;
      case "clock-sysresume":
        /* The YES names the break the player looked at (`since`, required by the schema). */
        input = { type: "clock-sysresume", seat, since: typeof op.since === "number" ? op.since : -1 };
        break;
      case "clock-annul":
        input = { type: "clock-annul", seat, yes: op.yes === true };
        break;
      case "clock-propose":
      case "clock-vote": {
        const yes = type === "clock-propose" ? true : op.yes === true;
        let approval: { approve_until: number; signature: string } | null = null;
        let verifiedFor: ClockVerifiedFor | null = null;
        let stale: readonly string[] = [];
        let renew = false;
        /* Timed Async, the completing YES: the instant its approvals were confirmed at (the decision is stamped there). */
        let checked: { at: number; seq: number } | null = null;
        if (yes && record.money !== null) {
          if (typeof op.approveUntil !== "number" || typeof op.signature !== "string") return { ok: false, code: "bad-frame", reason: "On a money table, a YES needs your signed approval." };
          const standing = clock.recordOf(game.gameId);
          const od = standing?.overdue ?? null;
          if (standing === null || od === null || standing.phase !== "overdue") return { ok: false, code: "wrong-state", reason: "Nobody is overdue." };
          /* Every check the record alone can answer comes BEFORE any chain read (a junk request costs the server nothing). */
          if (od.seat === seat || !standing.seats.includes(seat)) return { ok: false, code: "forbidden", reason: "Only the other seated players can do this." };
          if (standing.system !== null) return { ok: false, code: CLOCK_REFUSAL.systemPaused, reason: "The game is paused by the server; nothing is voted until every player resumes." };
          const proposal = type === "clock-vote" ? od.proposal : null;
          if (type === "clock-vote" && (proposal === null || proposal.id !== op.proposalId)) return { ok: false, code: CLOCK_REFUSAL.stale, reason: "That proposal is no longer open." };
          if (type === "clock-propose" && od.proposal !== null) return { ok: false, code: "wrong-state", reason: "A proposal is already open: vote on it first." };
          if (type === "clock-propose" && standing.policy.class === "live" && op.kind !== "foreclose") return { ok: false, code: "bad-frame", reason: "On a Live table the vote is only about foreclosure." };
          const kind = type === "clock-propose" ? (op.kind as "foreclose" | "annul") : (proposal as NonNullable<typeof proposal>).kind;
          const remedyKind = standing.policy.class === "live" ? 2 : kind === "foreclose" ? 5 : 4;
          const port = deps.clock?.remedy?.() ?? null;
          if (port === null) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "This server cannot check a money approval right now." };
          const at = now();
          /* Live: the approval must outlive minute 30 AS IT STANDS (a pause in the cure window moves it later). */
          const finalNotBeforeMs = projectedFinalityMs(standing, at) ?? od.at + clock.cureMs;
          const facts = { remedy: remedyKind as 2 | 4 | 5, defaultingSeat: od.seat, strike: od.strike, epoch: od.epoch, logLen: od.log_len, logHash: od.log_hash, overdueMs: od.at };
          const why = await port.verifyApproval(game.gameId, { ...facts, approvingSeat: seat, approveUntil: op.approveUntil, signature: op.signature, finalNotBeforeMs, nowMs: at });
          if (why !== null) {
            /* The player is told what to do; the chain's own wording stays in the server's lines. */
            ops.audit("clock.approval-refused", { game_id: game.gameId, why: why.slice(0, 200) });
            return { ok: false, code: "bad-approval", reason: why.startsWith("the escrow cannot be read") ? "Juno could not be read to check your approval. Try again in a moment." : why };
          }
          /* The other standing YES approvals, re-checked under their seats' CURRENT keys: one that no longer verifies is
             set aside (that seat is asked again) rather than completing a consensus that could not land. */
          /* (Including this seat's own standing YES: one that no longer verifies is RENEWED by this vote.) */
          const standingYes = (proposal?.votes ?? []).filter((v) => v.yes && v.approval !== null).map((v) => ({ seat: v.seat, approveUntil: (v.approval as { approve_until: number }).approve_until, signature: (v.approval as { signature: string }).signature }));
          const found = await port.staleApprovals(game.gameId, facts, standingYes);
          if (found === null) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "The escrow could not be read to check the other approvals. Try again." };
          renew = found.includes(seat);
          stale = found.filter((s) => s !== seat);
          approval = { approve_until: op.approveUntil, signature: op.signature };
          verifiedFor = { epoch: od.epoch, logLen: od.log_len, proposalId: proposal?.id ?? null, kind };
          /* TIMED ASYNC: a YES that COMPLETES the N-1 set makes the decision final at once, and the seal is judged on
             chain at that very second (owner ruling, 2026-10-07: approvals valid at finality decide it). So the decision
             is stamped at `checked.at`, and every approval of the set -- this one included -- is first checked under the
             key its seat held at that second, read only once the chain has a block past it (a rotation stamped at or
             before it is then seen; one after it is irrelevant). Unread in time: nothing is decided (try again). */
          const needed = standing.seats.filter((s) => s !== od.seat);
          const yesAfter = new Set([...standingYes.map((v) => v.seat).filter((s) => !stale.includes(s)), seat]);
          if (standing.policy.class === "async-pace" && needed.length > 0 && needed.every((s) => yesAfter.has(s))) {
            checked = { at, seq: standing.evidence.seq };
            const set = [...standingYes.filter((v) => v.seat !== seat), { seat, approveUntil: op.approveUntil, signature: op.signature }];
            const atFinal = await port.staleApprovals(game.gameId, facts, set, { atSecs: secsUpOf(at), timeoutMs: ASYNC_COMPLETION_KEY_CHECK_MS });
            if (atFinal === null) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "Juno could not confirm every approver's key for this decision just now, so nothing was decided. Try again in a moment." };
            if (atFinal.includes(seat)) return { ok: false, code: "bad-approval", reason: "Your seat's consent key changed: sign your approval again from this device." };
            stale = [...new Set([...stale, ...atFinal])].sort();
          }
        }
        input =
          type === "clock-propose"
            ? { type: "clock-propose", seat, kind: op.kind as "foreclose" | "annul", approval, verifiedFor, stale, ...(checked !== null ? { checked } : {}) }
            : { type: "clock-vote", seat, proposalId: typeof op.proposalId === "number" ? op.proposalId : 0, yes, approval, verifiedFor, stale, renew, ...(checked !== null ? { checked } : {}) };
        break;
      }
      default:
        return { ok: false, code: "bad-frame", reason: "That is not a clock operation." };
    }
    const outcome = await game.run("room-op", (tx) => clock.op(game, tx, input));
    if (outcome.kind === "ran") return outcome.value;
    return { ok: false, code: "unavailable", reason: UNAVAILABLE_PLAYER_SENTENCE };
  }

  /* ---- start (§8) ---- */

  /** The deal, inside a task that holds the game (the host's Start, or ESCROW-4's deal after the chain's Start): the
   *  roster source's plan (a money table's re-checks the chain), `assertDeal`, the append. */
  async function dealInTask(tx: Tx, record: GameRecord): Promise<{ ok: true; data?: Record<string, unknown> } | Refusal> {
    const plan = await deps.rosterSource.plan(record, { shuffle: deps.shuffle, now: now() });
    if ("refusal" in plan) return { ok: false, code: plan.code === "wrong-state" ? "wrong-state" : "not-ready", reason: plan.reason, ...({ block: plan.code } as object) } as Refusal;
    /* LIVE-4 (L4-2): a money table's financial record, read again into the settlement index: the session stamps the
       deal with THAT record's money identity and refuses it unless this pool continues the table (`RoomSession`). */
    if (record.money !== null) await deps.moneyFacts?.refresh(record.game_id);
    /* `build` is the dealing server's, stamped for history; the rules pin and hosted protocol are the session's stamp. */
    const deal = buildSetupGame(plan, deps.build);
    assertDeal(record, deal);
    const session = tx.session;
    const before = session.entries.length;
    const answer: ServerMessage = session.submit({
      actor: record.host_player_id,
      build: deps.build,
      msg: deal,
      baseIndex: session.nextIndex - 1,
      submissionId: `start-${record.record_version}`,
      host: record.host_player_id,
      seated: true,
      undoPolicy: { host_undo: record.policy.host_undo },
    });
    if (answer.kind !== "applied") {
      tx.rollback();
      return { ok: false, code: "wrong-state", reason: (answer as { reason?: string }).reason ?? "The game could not be dealt." };
    }
    const batch = session.entries.slice(before);
    const dealtBoard = session.state; // the board being committed (the session is not read after the commit)
    const settled = await tx.commitBatch(batch, (s) =>
      s.kind === "committed" ? { fanout: { kind: "applied", entries: s.entries, digest: s.view.digest, ...(s.view.fields ? { fields: { ...s.view.fields } } : {}), build: deps.build } } : {},
    );
    if (settled.kind !== "committed") return { ok: false, code: "unavailable", reason: UNAVAILABLE };
    /* ESCROW-3B: the deal is the first checkpoint position of a money game. */
    callEscrow(record.game_id, settled.view.entries, dealtBoard);
    /* Phase 3 final clocks: play begins -- the table's deadline is fixed and the first obligation's clock starts. */
    if (clock !== null) {
      const dealtAt = typeof batch[0]?.at === "number" ? (batch[0].at as number) : now();
      const actor = deps.games.peek(record.game_id);
      if (actor !== undefined) await clock.afterCommit(actor, { gate: { ok: true, now: dealtAt, before: null, cls: "deal", revertTarget: null }, actor: record.host_player_id, batch, board: dealtBoard });
    }
    return { ok: true, data: { started: true } };
  }

  async function startGame(game: GameActor, principalId: string): Promise<{ ok: true; data?: Record<string, unknown> } | Refusal> {
    const outcome = await game.run("room-op", async (tx): Promise<{ ok: true; data?: Record<string, unknown> } | Refusal> => {
      const record = tx.view.record;
      if (record === null) return { ok: false, code: "not-found", reason: "There is no such game." };
      const maintenance = isMaintenanceHold(tx.view.hold);
      const facts = maintenance ? factsFromRecord(record) : factsFromTx(tx, boardOf(record.game_id, tx.session));
      const seat = seatOf(record, principalId);
      /* Idempotent (§8.2 step 2): a second press, or a lost ack, is told the game already started. */
      if (!maintenance && facts.dealt && seat !== null && (seat.player_id === record.host_player_id || record.money !== null)) return { ok: true, data: { alreadyStarted: true } };
      const verdict = withGoneReason(authorize("start-game", { record, facts, principalId, now: now(), held: heldOf(tx.view) }), record);
      if (!verdict.ok && verdict.code === "not-found") return { ok: false, code: verdict.code, reason: verdict.reason };
      /* LIVE-3C: a held table is not dealt, whatever the host presses. */
      if (maintenance) return { ok: false, code: "held", reason: HELD_PLAYER_SENTENCE };
      /* PHASE 3 FINAL: a table without an ante is never dealt where this server serves no free game. */
      if (!facts.dealt && freeTableRefused(record)) return ANTE_REQUIRED;
      /* ESCROW-4: at a real-money table a funded non-host may start after the host's grace (OD-4-7): the money layer
         decides who, from the chain. Every other refusal of the table's own rules stands. */
      const moneyNonHost = record.money !== null && !verdict.ok && verdict.code === "forbidden" && seat !== null;
      if (!verdict.ok && !moneyNonHost) return { ok: false, code: verdict.code, reason: verdict.reason };
      if (tx.view.hold !== null) return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      if (awaitingReconciliation(game)) return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      if (record.money !== null) {
        /* ESCROW-4: THE REVERSIBLE FREEZE (3B), in this task: preconditions from a fresh chain read, the roster frozen,
           the Start intent written; the relayer sends it; the deal follows the chain's confirmation (a server task).
           A press after the chain's Start deals at once. Nothing here is decided by a client. */
        const money = deps.money?.() ?? null;
        if (money === null) return { ok: false, code: "money-unavailable", reason: MONEY_UNAVAILABLE_SENTENCE };
        const started = await money.startInTask(record, principalId);
        if (started.kind === "refused") return { ok: false, code: started.code, reason: started.reason };
        if (started.kind === "starting") return { ok: true, data: { starting: true } };
      }
      return dealInTask(tx, record);
    });
    if (outcome.kind === "failed") {
      /* A deal that broke `assertDeal`, or a roster source that threw: a server bug, never the host's -- logged. */
      const ref = deps.errorRef();
      deps.warn(`  threw: start-game failed for ${game.gameId} (ref ${ref}) -- ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
      return { ok: false, code: "internal", reason: `The server could not deal this game. (ref ${ref})` };
    }
    if (outcome.kind !== "ran") return { ok: false, code: outcome.kind === "busy" ? "busy" : "unavailable", reason: outcome.kind === "busy" ? BUSY : UNAVAILABLE };
    /* ESCROW-4: a money table's "starting" is not a deal (the record follows the deal, later). */
    if (outcome.value.ok && outcome.value.data?.starting !== true) syncRecord(game, "deal");
    return outcome.value;
  }

  /* ==================================================================
      ESCROW-4: THE MONEY LAYER'S PORT -- EVERY TABLE MUTATION STAYS HERE, IN THE GAME'S ACTOR
     ================================================================== */

  /** Run a money task inside the game's actor ("room-op"): serialized with every seat op and submit of the game. */
  async function runMoneyTask<T>(gameId: string, task: (record: GameRecord) => Promise<T>): Promise<{ ok: true; value: T } | Refusal> {
    let game: GameActor | null;
    try {
      game = await actorFor(gameId);
    } catch (error) {
      if (error instanceof GameUnavailableError) return { ok: false, code: "unavailable", reason: UNAVAILABLE_PLAYER_SENTENCE };
      throw error;
    }
    if (game === null) return { ok: false, code: "not-found", reason: "There is no such game." };
    const actor = game;
    const outcome = await actor.run("room-op", async (tx): Promise<{ ok: true; value: T } | Refusal> => {
      const record = tx.view.record;
      if (record === null) return { ok: false, code: "not-found", reason: "There is no such game." };
      if (isMaintenanceHold(tx.view.hold)) return { ok: false, code: "held", reason: HELD_PLAYER_SENTENCE };
      if (tx.view.hold !== null || awaitingReconciliation(actor)) return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      /* LIVE-6 L6-2 (security review, LOW 1): no money write of a RESTORED table runs before its history is verified --
         the same gate as its seat ops (`runOp`). The money routes ask it first (`moneyTables.ts` restoreHeld); this is
         the actor's own backstop for every money task. */
      if (record.record_schema === 2) {
        const restoring = deps.escrow?.restoreGate?.(record.game_id) ?? null;
        if (restoring !== null) return { ok: false, code: "held", reason: restoring };
      }
      return { ok: true, value: await task(record) };
    });
    if (outcome.kind === "ran") return outcome.value;
    if (outcome.kind === "busy") return { ok: false, code: "busy", reason: BUSY };
    if (outcome.kind === "failed") {
      const ref = deps.errorRef();
      deps.warn(`  threw: a money task failed for ${gameId} (ref ${ref}) -- ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
      return { ok: false, code: "internal", reason: `The server could not process that request. (ref ${ref})` };
    }
    return { ok: false, code: "unavailable", reason: UNAVAILABLE };
  }

  /** A server task on a money table (no caller): the op against the record committed when it runs. */
  async function serverMoneyOp(gameId: string, change: (record: GameRecord, at: number) => { record: GameRecord | null; releaseCode?: string }): Promise<void> {
    const game = await actorFor(gameId);
    if (game === null) return;
    await runOp(game, "", null, (env) => {
      const next = change(env.record, env.now);
      return { ok: true, record: next.record, effects: next.releaseCode !== undefined ? { releaseCode: next.releaseCode } : {} };
    });
  }

  const moneyPort: MoneyRoomPort = {
    runTask: runMoneyTask,
    recordOf: (gameId) => {
      const resident = peekLoaded(gameId)?.view.record ?? null;
      return resident ?? recordIndex.get(gameId) ?? null;
    },
    refresh: (gameId) => {
      broadcastView(gameId);
      scheduleList();
    },
    hasViewers: (gameId) => (viewSubs.get(gameId)?.size ?? 0) > 0,
    moneyRecords: () => [...recordIndex.values()].filter((record) => record.money !== null),
    /* W-5: a bound table's waiting room outlives the chain's funding deadline (never shortened). */
    extendExpiry: (gameId, until) =>
      serverMoneyOp(gameId, (record, at) =>
        record.money !== null && record.status === "waiting" && record.started_at === null && (record.expires_at ?? 0) < until
          ? { record: { ...record, expires_at: until, record_version: record.record_version + 1, last_activity_at: at } }
          : { record: null },
      ),
    /* The escrow was cancelled on chain: the room says so (its code released), exactly as a host's cancel would. */
    mirrorCancelled: (gameId) =>
      /* L6-2: gated before its audit line (the op itself is refused by the restore gate in `runOp` too). */
      (deps.escrow?.restoreGate?.(gameId) ?? null) !== null
        ? Promise.resolve()
        : serverMoneyOp(gameId, (record, at) =>
        record.money !== null && record.status === "waiting" && record.started_at === null
          ? {
              record: { ...record, status: "cancelled", cancelled_at: at, join_code: null, expires_at: null, record_version: record.record_version + 1, last_activity_at: at },
              ...(record.join_code !== null ? { releaseCode: record.join_code } : {}),
            }
          : { record: null },
      ).then(() => ops.audit("money.room-mirrored-cancel", { game_id: gameId })),
    /* The chain confirmed the Start: deal now (idempotent -- a dealt table, or one whose plan refuses, is left). */
    dealStarted: async (gameId) => {
      /* L6-2 (review M1): no deal on a restored money table before its history is verified (the next observation deals). */
      if ((deps.escrow?.restoreGate?.(gameId) ?? null) !== null) return;
      const game = await actorFor(gameId);
      if (game === null) return;
      const outcome = await game.run("room-op", async (tx) => {
        const record = tx.view.record;
        if (record === null || record.money === null || tx.view.hold !== null || awaitingReconciliation(game)) return null;
        const facts = factsFromTx(tx, boardOf(record.game_id, tx.session));
        if (facts.dealt || record.status !== "waiting") return null;
        return dealInTask(tx, record);
      });
      if (outcome.kind === "ran" && outcome.value !== null && outcome.value.ok && outcome.value.data?.started === true) {
        syncRecord(game, "deal");
        ops.audit("money.dealt-after-start", { game_id: gameId });
      } else if (outcome.kind === "ran" && outcome.value !== null && !outcome.value.ok) {
        deps.warn(`  money: ${gameId}'s Start is confirmed but the deal was refused (${outcome.value.code}): ${outcome.value.reason}`);
      }
    },
  };

  /** The settlement seam, contained: it must not throw (it runs inside a publish), and if it does, the game is not
   *  harmed -- the next load announces the seal again (at least once). */
  function callSettlement(input: Parameters<SettlementLifecycle["onGameplayClosed"]>[0]): void {
    try {
      settlement.onGameplayClosed(input);
    } catch (error) {
      deps.warn(`  settlement: onGameplayClosed threw for ${input.gameId} -- ${error instanceof Error ? error.message : String(error)}; the next load announces it again`);
    }
  }

  /** The record's cached, log-derived fields (§5.2, §14.4): after the deal, at GameEnd and at CloseRoom -- and at
   *  load when the record lags its log. A task of its own (a task commits once, E-6); the log wins. */
  function syncRecord(game: GameActor, why: "load" | "deal" | "gameplay" | "adopted"): void {
    void game
      .run("room-op", async (tx) => {
        const record = tx.view.record;
        /* A held, uncertain or incompatible game is never repaired: what it holds is exactly what was found. An
           UNCERTAIN store hold only defers it (review R1): the game is unreconciled, so once the hold clears, the
           first op or move is refused and retries this sync instead of running on a record that may lag. */
        if (record !== null && tx.view.hold?.reason === "uncertain") unreconciled.add(record.game_id);
        if (record === null || tx.view.hold !== null) return;
        const board = boardOf(record.game_id, tx.session);
        const facts = factsFromTx(tx, board);
        if (!facts.dealt) {
          settle(record.game_id, null);
          return;
        }
        /* LIVE-3C: THE SAME TABLE THE LOAD RECONCILED BY (`reconcile.ts`), so a repair writes exactly the log-implied
           fields the record lags on -- and a record that no longer reconciles is left alone (it is held at its next
           load; a running game's record cannot move away from its log, since every op after the deal is refused). */
        const verdict = reconcileLoaded(record, { entries: tx.view.entries, board });
        if (verdict.kind === "hold") {
          /* Unreachable after a load (which applies the same table and would have held it): if it happens anyway the
             game stays unreconciled, and every op on it is refused. */
          deps.warn(`  records: ${record.game_id} does not reconcile with its log (${verdict.code}): ${verdict.detail} -- left exactly as it is`);
          return;
        }
        if (verdict.kind !== "repair") {
          settle(record.game_id, null);
          /* The settlement seam is AT LEAST ONCE (lifecycle.ts): a load that finds a completed game tells it again. */
          if (why === "load" && board.ended && record.status === "completed") {
            const seal = sealOf(tx.view.entries, true);
            if (seal !== null) callSettlement({ gameId: record.game_id, record, seal, recovered: true, entries: tx.view.entries });
          }
          return;
        }
        const seal = sealOf(tx.view.entries, board.ended);
        const releaseCode = record.visibility === "private" && record.join_code !== null ? record.join_code : undefined;
        const seated = new Set(record.seats.map((seat) => seat.principal_id));
        const next: GameRecord = {
          ...record,
          record_version: record.record_version + 1,
          status: facts.ended ? "completed" : "active",
          started_at: record.started_at ?? facts.dealAt ?? now(),
          /* The seal's time: when gameplay ended, from the log (log-implied, LIVE-3 §14.3). */
          completed_at: facts.ended ? (seal !== null && seal.at > 0 ? seal.at : (record.completed_at ?? now())) : record.completed_at,
          closed_at: facts.closed ? (record.closed_at ?? now()) : record.closed_at,
          turn_order: facts.turnOrder ?? record.turn_order,
          rules_engine_version: facts.rulesEngineVersion ?? record.rules_engine_version,
          expires_at: null,
          join_code: releaseCode !== undefined ? null : record.join_code,
          admitted: record.visibility === "private" ? record.admitted.filter((entry) => seated.has(entry.principal_id)) : record.admitted,
          last_activity_at: now(),
        };
        const sealed = record.status !== "completed" && next.status === "completed" && seal !== null ? seal : null;
        /* A load that repairs an already-completed record (its end time) re-announces the seal, as any load of one does. */
        const reannounce = sealed === null && why === "load" && next.status === "completed" && seal !== null ? seal : null;
        const settled = await tx.commitRecord(next, (s) => ({
          after: () => {
            /* THE TERMINAL SEAM (lifecycle.ts): gameplay closed, durably -- settlement eligible. Nothing for no-money. */
            if (s.kind !== "committed") return;
            if (sealed !== null) callSettlement({ gameId: record.game_id, record: next, seal: sealed, recovered: why === "load", entries: tx.view.entries });
            else if (reannounce !== null) callSettlement({ gameId: record.game_id, record: next, seal: reannounce, recovered: true, entries: tx.view.entries });
          },
        }));
        if (settled.kind === "committed") {
          settle(record.game_id, null);
          releaseLater(releaseCode, record.game_id);
          if (why === "load" || why === "adopted") {
            counters.repaired += 1;
            deps.warn(`  records: ${record.game_id} repaired from its log ${why === "load" ? "at load" : "after adopting stored entries"} (${verdict.fields.join(", ")}) -- record.repaired`);
            ops.audit("record.repaired", { game_id: record.game_id, fields: verdict.fields, record_version: next.record_version, ...(why === "adopted" ? { after: "adoption" } : {}) });
          }
          if (sealed !== null) ops.audit("game.sealed", { game_id: record.game_id, log_len: sealed.log_len, at: sealed.at });
        } else {
          /* LIVE-3C (review E4): whatever asked for it -- the load, the deal, GameEnd, CloseRoom -- the record now lags
             its log, so the game is UNRECONCILED again: every op and move on it is refused, and each refusal retries. */
          unreconciled.add(record.game_id);
          publishStatus();
          scheduleList();
          deps.warn(`  records: the record of ${record.game_id} could not follow its log (${settled.reason}); it is unreconciled -- every op on it is refused until a repair lands`);
        }
      })
      .then((outcome) => {
        if (outcome.kind === "ran") return;
        /* A sync that never ran (expired, busy, threw) leaves the record lagging just the same. */
        if (!game.isLoaded) return;
        unreconciled.add(game.gameId);
        publishStatus();
        scheduleList();
        if (outcome.kind === "failed") deps.warn(`  threw: a record sync failed for ${game.gameId} -- ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
      })
      .catch(() => undefined);
  }

  /** After a committed gameplay batch on a server-owned game: the board may have ended or closed. ESCROW-3B: `board`
   *  is the committed board (the committing task still holds its session) for a money game's checkpoint seam. */
  function afterGameplay(game: GameActor, ended: boolean, closed: boolean, board?: GameStateResponse): void {
    const record = game.view.record;
    if (record === null) return;
    if ((ended && record.status !== "completed") || (closed && record.closed_at === null) || record.status === "waiting") syncRecord(game, "gameplay");
    if (board !== undefined) callEscrow(game.gameId, game.view.entries, board);
  }

  /** ESCROW-3B: the escrow seam, contained -- it must not throw (it runs in a committing task); a money game only. */
  function callEscrow(gameId: string, entries: readonly ServerLogEntry[], board: GameStateResponse): void {
    const escrow = deps.escrow;
    if (escrow === undefined) return;
    try {
      if (!escrow.isRosterFrozen(gameId)) return;
      escrow.onGameplayCommitted({ gameId, entries, board });
    } catch (error) {
      deps.warn(`  escrow: the gameplay seam threw for ${gameId} -- ${error instanceof Error ? error.message : String(error)}; the next committed batch tries again`);
    }
  }

  /* ---- reads ---- */

  async function handleRoomHello(socket: WebSocket, gameId: string): Promise<void> {
    const principalId = principalOf(socket);
    let game: GameActor | null;
    try {
      game = await actorFor(gameId);
    } catch (error) {
      if (error instanceof GameUnavailableError) {
        /* LIVE-6 L6-1: owned by another pool -- its route, when the server has one to answer. */
        if (error.routed !== null && deps.answerRouted !== undefined && (await deps.answerRouted(socket, gameId, error.routed))) return;
        return deps.send(socket, { kind: "error", ...unavailableFor(gameId, principalId) });
      }
      throw error;
    }
    if (game === null) return deps.send(socket, { kind: "error", code: "not-found", reason: "There is no such game." });
    /* LIVE-3C: a view is built only from a RECONCILED record -- the load's repair task (queued first) has run. */
    if (unreconciled.has(gameId)) await game.run("room-op", () => undefined);
    /* ESCROW-4: a real-money table's first view carries what the chain says (a bounded wait on a cold cache). */
    if (game.view.record?.money != null) await deps.money?.()?.prepareView(gameId).catch(() => undefined);
    const verdict = authorizeNow(game, principalId, "read-view");
    if (!verdict.ok) return deps.send(socket, { kind: "error", code: verdict.code, reason: verdict.reason });
    if (viewGameOf.get(socket) !== gameId && !viewerRoomFor(socket, gameId)) {
      return deps.send(socket, { kind: "error", code: "room-full", reason: "This table has as many watchers as it takes." });
    }
    /* LIVE-4 (L4-3): the tab against the game, after the read gate (a stranger learns nothing from it): a protocol-1 tab
       whose rules do not include the game's pin is answered `reload` (and closed 4426) and shown nothing. */
    if (!clientMayRead(socket, gameId, game)) {
      if (viewGameOf.get(socket) === gameId) dropView(socket, { quiet: true });
      return;
    }
    if (viewGameOf.get(socket) !== gameId) {
      dropView(socket);
      viewGameOf.set(socket, gameId);
      let set = viewSubs.get(gameId);
      if (set === undefined) {
        set = new Set();
        viewSubs.set(gameId, set);
      }
      set.add(socket);
      pinFor(gameId, game);
      deps.onSubscriptionChange(socket);
    }
    const frame = viewFrame(game, principalId as string);
    if (frame !== null) deps.send(socket, frame);
    if (!chats.has(gameId)) {
      try {
        chats.set(gameId, [...(await deps.loadChat(gameId))].slice(-CHAT_HISTORY_LIMIT));
      } catch (error) {
        deps.warn(`  store: could not load the transcript for ${gameId} -- ${error instanceof Error ? error.message : String(error)}`);
        chats.set(gameId, []);
      }
      /* The transcript load awaited: access is judged again before anything more is sent (review I2). */
      const again = authorizeNow(game, principalId, "read-view");
      if (!again.ok || viewGameOf.get(socket) !== gameId) return;
    }
    deps.send(socket, chatFrame(gameId));
    deps.send(socket, presenceFrame(gameId));
    broadcastView(gameId); // `online` changed for everyone else
  }

  /** Whether one more non-seated reader fits (§12.2 viewer cap): counted over EVERY socket reading the game -- its
   *  view or its log (review L5) -- and only for a watcher (V) or a member (M); a seat always fits.
   *  LIVE-2E: COUNTED BY PRINCIPAL, NOT BY SOCKET. One person's tabs and devices are one watcher: they cannot fill the
   *  table's watcher seats by opening tabs, and a watcher's own second socket (its log, a second tab) always fits
   *  once its first did. */
  function viewerRoomFor(socket: WebSocket, gameId: string): boolean {
    const record = peekLoaded(gameId)?.view.record;
    if (!record) return true;
    const mine = principalOf(socket);
    const role = roleOf(record, mine);
    if (role !== "V" && role !== "M") return true;
    const viewers = new Set<string>();
    for (const other of new Set([...(viewSubs.get(gameId) ?? []), ...deps.readersOf(gameId)])) {
      if (other === socket) continue;
      const theirs = principalOf(other);
      if (theirs === null) continue;
      if (theirs === mine) return true; // already one of the table's watchers
      const theirRole = roleOf(record, theirs);
      if (theirRole === "V" || theirRole === "M") viewers.add(theirs);
    }
    return viewers.size < record.policy.max_viewers;
  }

  /** Whether `socket` may read `gameId`'s log NOW -- the hello gate and every log push (§14.3 item 5). */
  function canReadLog(socket: WebSocket, gameId: string): { ok: true } | Refusal {
    const game = peekLoaded(gameId);
    if (game === undefined || game.view.record === null) return { ok: false, code: "not-found", reason: "There is no such game." };
    const verdict = authorizeNow(game, principalOf(socket), "read-log");
    return verdict.ok ? { ok: true } : { ok: false, code: verdict.code, reason: verdict.reason };
  }

  async function handleChat(socket: WebSocket, gameId: string, text: string): Promise<void> {
    const principalId = principalOf(socket);
    if (viewGameOf.get(socket) !== gameId || principalId === null) return deps.send(socket, { kind: "error", code: "forbidden", reason: "Open the table first." });
    const game = peekLoaded(gameId);
    if (game === undefined) return deps.send(socket, { kind: "error", code: "unavailable", reason: "That table is not open right now. Try again." });
    const verdict = authorizeNow(game, principalId, "chat");
    if (!verdict.ok) return deps.send(socket, { kind: "error", code: verdict.code, reason: verdict.reason });
    /* LIVE-3C (review E3): a held game is frozen -- its transcript too. */
    if (isMaintenanceHold(game.view.hold)) return deps.send(socket, { kind: "error", code: "held", reason: HELD_PLAYER_SENTENCE });
    const record = game.view.record as GameRecord;
    const seat = seatOf(record, principalId);
    if (seat === null) return;
    if (chatSeat.take(`${gameId}\u0000${seat.player_id}`) > 0) {
      deny("chat");
      return deps.send(socket, { kind: "error", code: "rate-limited", reason: "You are chatting too quickly. Wait a moment." });
    }
    const clean = sanitizeText(text.trim(), MAX_CHAT_LENGTH).trim();
    if (!clean) return;
    const entry: RoomChatEntry = { id: `c${chatTag}-${(chatMinted += 1)}`, author: seat.player_id, displayName: seat.nickname, text: clean, at: now() };
    chats.set(gameId, [...(chats.get(gameId) ?? []), entry].slice(-CHAT_HISTORY_LIMIT));
    try {
      await deps.appendChat(gameId, entry);
    } catch (error) {
      deps.warn(`  store: could not save a chat line for ${gameId} -- ${error instanceof Error ? error.message : String(error)}`);
    }
    pushToReaders(gameId, chatFrame(gameId));
  }

  function handlePresence(socket: WebSocket, gameId: string, state: unknown): void {
    const principalId = principalOf(socket);
    if (viewGameOf.get(socket) !== gameId || principalId === null) return;
    const game = peekLoaded(gameId);
    if (game === undefined) return;
    const verdict = authorizeNow(game, principalId, "presence");
    if (!verdict.ok) return deps.send(socket, { kind: "error", code: verdict.code, reason: verdict.reason });
    const seat = seatOf(game.view.record as GameRecord, principalId);
    if (seat === null) return;
    const seats = presence.get(gameId) ?? new Map<string, PresenceState>();
    if (state && typeof state === "object") seats.set(seat.player_id, { ...(state as PresenceState), playerId: seat.player_id, at: now() });
    else seats.delete(seat.player_id);
    presence.set(gameId, seats);
    broadcastPresence(gameId);
  }

  async function handleRoomsWatch(socket: WebSocket, on: boolean): Promise<void> {
    if (!on) {
      listWatchers.delete(socket);
      return;
    }
    await indexReady;
    listWatchers.add(socket);
    deps.send(socket, { kind: "rooms", rooms: summaries() });
  }

  /* ==================================================================
      PHASE 3 (P3-N035): A SEATED PLAYER REPORTS ANOTHER SEAT OF THIS TABLE
     ==================================================================
     Authorized like every room op, from the COMMITTED record (`report`: seated only -- a watcher, visitor, outsider or
     kicked principal is refused exactly as for any op it may not do, and a private table stays `not-found` to an
     outsider). The rest -- the reported seat, the category, the note, the evidence -- is the conduct service's, over the
     committed view this pool serves: the record, the committed log, the table's stored chat and, for a real-money table,
     its financial standing. Nothing here writes a record, a log entry, a seat, a profile or any money. The answer is the
     service's sentence: received, or already received -- never a case id, a status or anything about other reports. */
  async function handleReport(socket: WebSocket, ctx: ConnectionContext, requestId: string, game: GameActor, op: Record<string, unknown>): Promise<void> {
    const verdict = authorizeNow(game, ctx.principalId, "report");
    if (!verdict.ok) return ack(socket, requestId, verdict);
    if (deps.conduct === undefined || !deps.conduct.enabled) return ack(socket, requestId, { ok: false, code: "unavailable", reason: "Reports cannot be received on this server right now. Try again later." });
    const view = game.view;
    const record = view.record as GameRecord;
    const held = heldOf(view);
    let chat: readonly RoomChatEntry[] | null = chats.get(record.game_id) ?? null;
    if (chat === null) {
      try {
        chat = [...(await deps.loadChat(record.game_id))].slice(-CHAT_HISTORY_LIMIT);
      } catch {
        chat = null;
      }
    }
    let money: { phase: string | null; held: boolean } | null = null;
    if (record.money !== null) {
      try {
        const financial = (await deps.money?.()?.financialRecord(record.game_id)) ?? null;
        money = financial === null ? null : { phase: financial.phase, held: financial.hold !== null };
      } catch {
        money = null;
      }
    }
    /* The table clock's own facts (consolidated final integration): the clock lane's durable record -- its evidence window
       and strike ledger -- and the evidence events its reporting hook delivered in this process, merged by the lane's
       sequence number and projected safely (`conductClockFacts.ts`). Read only: nothing here runs or judges a clock. */
    let clockFacts: ConductClockEvidence | null = null;
    if (deps.clock !== undefined) {
      let stored: GameClockRecord | null | "unreadable";
      try {
        stored = await deps.clock.store.load(record.game_id);
      } catch {
        stored = "unreadable";
      }
      clockFacts = conductClockEvidenceOf({ record: stored, recent: deps.conductClockFeed?.recent(record.game_id) ?? [] });
    }
    const answer = await deps.conduct.report({
      record,
      facts: factsFromView(view, record),
      clock: clockFacts,
      /* A held or incompatible game serves no history: the case says so rather than pretending the log was empty. */
      entries: held ? [] : view.entries,
      ...(held ? { unreadableHistory: "The game was held or could not be continued on this server, so its log was not read into the report." } : {}),
      reporterPrincipalId: ctx.principalId,
      reportedPlayerId: op.playerId,
      category: op.category,
      note: op.note,
      chat,
      money,
    });
    if (!answer.ok && answer.retryAfterMs !== undefined) return deps.send(socket, { kind: "room-ack", requestId, ok: false, code: answer.code, reason: answer.reason, retryAfterMs: answer.retryAfterMs });
    if (!answer.ok) return ack(socket, requestId, { ok: false, code: answer.code, reason: answer.reason });
    return ack(socket, requestId, { ok: true, data: { received: answer.received, message: answer.message } });
  }

  /** LIVE-2F/3D (C9-01): "Your tables" -- every table whose record seats this principal, by what it is NOW
   *  (`classifyNow`: stage one's line for a table not reconciled yet, never the record's claim). Cancelled, expired and
   *  archived tables are gone and not listed; nor is anything a kicked or unseated principal could only watch. */
  async function handleMyTables(socket: WebSocket, ctx: ConnectionContext, requestId: string): Promise<void> {
    await indexReady;
    await reindexUnread();
    const tables: MyTableSummary[] = [];
    for (const record of recordIndex.values()) {
      if (seatOf(record, ctx.principalId) === null) continue;
      const cls = classifyNow(record.game_id).cls;
      /* LIVE-4 (L4-2): a game this pool does not continue is listed as `cannot-continue` (derived from its verdict); the
         build-pinned `watch-only` line (#1252, review IR-05) is never produced now. */
      const state = MY_TABLE_STATE[cls];
      if (state === undefined) continue;
      const money = record.money === null ? null : (deps.money?.()?.myTableFor(record, ctx.principalId) ?? { anteGross: record.money.ante_gross, symbol: record.money.symbol, exponent: record.money.exponent, networkClass: record.money.network_class, status: "link-wallet" as const, actionNeeded: false });
      const summary = myTableSummaryOf(record, ctx.principalId, state, money);
      if (summary !== null) tables.push(summary);
    }
    const live = (table: MyTableSummary) => (table.state === "finished" ? 1 : 0);
    tables.sort((a, b) => live(a) - live(b) || b.lastActivityMs - a.lastActivityMs);
    ack(socket, requestId, { ok: true, data: { tables: tables.slice(0, MY_TABLES_LIMIT) } });
  }

  /** LIVE-2F/3D (independent review IR-02): a game whose files discovery could not READ at startup (a failed or timed
   *  out read of its record, hold or log head) was never indexed -- so no list, and no "Your tables", could ever name
   *  it again this run, though its seats are intact. "Your tables" asks for those records again (throttled, bounded;
   *  through `resolveGame`, so a record found is stage one -- unreconciled -- exactly as any lazy lookup indexes it). */
  let reindexAfter = 0;
  async function reindexUnread(): Promise<void> {
    const at = now();
    if (at < reindexAfter) return;
    reindexAfter = at + MY_TABLES_REINDEX_MS;
    let ids: string[];
    if (discovery === null) {
      try {
        ids = await deps.records.list();
      } catch {
        return;
      }
    } else {
      ids = [...(discovery as DiscoveryReport).games.values()].filter((game) => game.record === null && game.cls === "unavailable").map((game) => game.gameId);
    }
    for (const gameId of ids.filter((id) => !recordIndex.has(id)).slice(0, MY_TABLES_REINDEX_BUDGET)) {
      try {
        await resolveGame(gameId);
      } catch {
        // still unreadable: asked again at the next pass
      }
    }
  }

  /** The seat behind a gameplay submit, from the record committed NOW (inside the submit's task). */
  function seatActor(tx: Tx, principalId: string): { ok: true; actor: string; host: string; policy: GameRecord["policy"]["host_undo"] } | Refusal {
    const record = tx.view.record;
    if (record === null) return { ok: false, code: "not-found", reason: "There is no such game." };
    const facts = isMaintenanceHold(tx.view.hold) ? factsFromRecord(record) : factsFromTx(tx, boardOf(record.game_id, tx.session));
    const verdict = withGoneReason(authorize("submit", { record, facts, principalId, now: now(), held: heldOf(tx.view) }), record);
    if (!verdict.ok) {
      /* LIVE-2F/3D (C2-01): BEFORE THE DEAL NOTHING IS GAMEPLAY. A seated player's submit in a waiting game is the
         table's own `wrong-state` and is never handed to the session: the seeded, undealt board accepts some messages
         (offer answers, `BeginOperatingRound`, `PassTurn`), and an entry committed there would precede the server's
         deal -- corrupting the dealt board and holding the table `deal-misplaced` at its next load. The only way a
         server-owned game is dealt is `start-game`, which does not come through here. */
      return { ok: false, code: verdict.code, reason: verdict.reason };
    }
    /* LIVE-6 L6-2: post-restore safe mode -- a restored MONEY game takes no move until its history is verified (a move
       made on a history the chain or the ledger contradicts could never be settled: preflight §13 step 8). */
    if (record.record_schema === 2) {
      const restoring = deps.escrow?.restoreGate?.(record.game_id) ?? null;
      if (restoring !== null) return { ok: false, code: "held", reason: restoring };
    }
    const seat = seatOf(record, principalId) as NonNullable<ReturnType<typeof seatOf>>;
    return { ok: true, actor: seat.player_id, host: record.host_player_id, policy: record.policy.host_undo };
  }

  /** Per-seat and per-game submit budgets (§12.2): `0` granted, else the wait. */
  function submitBudget(gameId: string, playerId: string): number {
    const seatWait = submitsSeat.peek(`${gameId}\u0000${playerId}`);
    const gameWait = submitsGame.peek(gameId);
    if (seatWait > 0 || gameWait > 0) {
      deny(seatWait > 0 ? "submits-seat" : "submits-game");
      return Math.max(seatWait, gameWait);
    }
    submitsSeat.take(`${gameId}\u0000${playerId}`);
    submitsGame.take(gameId);
    return 0;
  }

  /** Phase 3 final clocks (owner-policy correction): the per-seat offer FREQUENCY budget -- `0` when an offer may be
   *  tried now, else the wait. Transport only: it never says an offer is illegal, and no count of offers per round
   *  exists. Asking spends nothing; an offer that LANDED spends one token of each bucket (`offerSpent`). */
  function offerBudget(gameId: string, playerId: string): number {
    const key = `${gameId}\u0000${playerId}`;
    const wait = Math.max(offersSeat.peek(key), offersSeatSustained.peek(key));
    if (wait > 0) deny("offers-seat");
    return wait;
  }

  function offerSpent(gameId: string, playerId: string): void {
    const key = `${gameId}\u0000${playerId}`;
    offersSeat.take(key);
    offersSeatSustained.take(key);
  }

  function hasSubscription(socket: WebSocket): boolean {
    return viewGameOf.has(socket) || listWatchers.has(socket);
  }

  function dropSocket(socket: WebSocket): void {
    dropView(socket);
    listWatchers.delete(socket);
  }

  /* ==================================================================
      LIVE-3C: TERMINAL MATERIAL AGES OUT -- MARKED, NEVER DELETED, BY THE SERVER
     ==================================================================
     A completed game stays readable for 30 days after its seal, a cancelled or expired table for 7 (OD-L3-2, LIVE-2
     §12.2); then it is ARCHIVED: `archived_at` is set (and a code it still holds released) in one conditional record
     write on the game's own actor, so it can never race a move, a reconnect or a room op of that game -- a reader
     before it is served, a reader after it is told `gone`. Nothing is deleted or moved here: the offline tool
     (`tools/gamesDoctor.ts gc`) moves archived games to `archive/` 90 days later, with the lock held. A held game is
     never archived (`runOp` refuses every change to it), and a money game never by this rule (`retentionOf`). */
  const SWEEP_EXEMPT: ReadonlySet<GameClass> = new Set<GameClass>(["held", "incompatible", "unavailable", "attention"]);
  function sweepArchive(): void {
    const at = now();
    let budget = ARCHIVE_SWEEP_BUDGET;
    for (const record of recordIndex.values()) {
      if (budget === 0) break;
      const due = archiveDueAt(record, settlement.retentionOf(record));
      if (due === null || at < due) continue;
      /* Frozen or uninterpretable games are never candidates, so they cannot starve the budget (review E7). */
      if (SWEEP_EXEMPT.has(classifyNow(record.game_id).cls)) continue;
      budget -= 1;
      void (async () => {
        const game = await actorFor(record.game_id);
        if (game === null) return;
        const ran = await runOp(game, "", null, (env) => {
          const current = env.record;
          const dueNow = archiveDueAt(current, settlement.retentionOf(current));
          if (dueNow === null || env.now < dueNow) return { ok: true, record: null };
          return {
            ok: true,
            record: { ...current, record_version: current.record_version + 1, archived_at: env.now, join_code: null, last_activity_at: env.now },
            effects: current.join_code !== null ? { releaseCode: current.join_code } : {},
          };
        });
        if (ran.ok && ran.value.record !== null) {
          counters.archived += 1;
          ops.audit("record.archived", { game_id: record.game_id, status: record.status });
          publishStatus();
        }
      })().catch((error) => deps.warn(`  records: could not archive ${record.game_id} -- ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /** §5.3: the 24 h waiting-room TTL, made durable for a bounded number of lapsed rooms per sweep (reads already
   *  answer `gone` from the effective status; this releases their codes and frees their hosts' caps for good). */
  function sweepExpired(): void {
    const at = now();
    let budget = 20;
    for (const record of recordIndex.values()) {
      if (budget === 0) break;
      if (record.status !== "waiting" || record.started_at !== null || record.expires_at === null || at < record.expires_at) continue;
      if (SWEEP_EXEMPT.has(classifyNow(record.game_id).cls)) continue;
      if (deps.escrow?.isRosterFrozen(record.game_id) === true) continue; // ESCROW-3B: a frozen financial roster never expires

      budget -= 1;
      void (async () => {
        const game = await actorFor(record.game_id);
        if (game !== null) await runOp(game, "", null, () => ({ ok: true, record: null }));
      })().catch((error) => deps.warn(`  records: could not expire ${record.game_id} -- ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /* ==================================================================
      LIVE-3C: THE INVENTORY -- what every durable game is now (brief §15)
     ==================================================================
     Discovery's classification, refined by what a resident game's committed view says (a hold found at its load, an
     uncertain write, a record that moved on). Counts and reasons only: never a principal, never a secret. */
  /** A LOADED game's class, from its committed view -- the whole log, replayed and reconciled at its load. */
  function classOfView(gameId: string, view: CommittedView): { gameId: string; cls: GameClass; code: string | null; detail: string | null } {
    const hold = view.hold;
    if (isMaintenanceHold(hold)) return { gameId, cls: "held", code: hold?.code ?? "log-corrupt", detail: hold?.detail ?? null };
    /* LIVE-4 (L4-2): not continued (or no longer served) here -- its code is the verdict's `why`, never a build; a rules
       pin this pool does not play keeps #1520's direction code, as discovery named it. */
    const notContinued = notContinuedWhyOf(view);
    if (notContinued !== null) return { gameId, cls: "incompatible", code: notContinued === "rules-not-supported" ? rulesDirectionOf(view) : notContinued, detail: hold?.detail ?? null };
    if (hold?.reason === "uncertain") return { gameId, cls: "unavailable", code: hold.restart ? "store-restart-required" : "store-uncertain", detail: hold.detail };
    const record = view.record;
    if (record === null) return { gameId, cls: "attention", code: null, detail: "loaded with no record" };
    if (unreconciled.has(gameId)) return { gameId, cls: "unreconciled", code: "repair-pending", detail: "loaded; the record's repair from its log has not landed" };
    /* The lifecycle the LOG implies (a record's own follow-up write may be a task behind it, RL-1). */
    return { gameId, cls: record.archived_at !== null ? "archived" : effectiveStatus(record, factsFromView(view, record), now()), code: null, detail: null };
  }

  /** LIVE-4 (L4-2): #1520's direction code for a deal whose rules pin this pool does not play -- `rules-version-newer`
   *  or `-older` against the pool's own rules (the capability's), as discovery says it -- or the verdict's word when
   *  the deal's pin is one the pool plays (a money identity's rules, not the deal's, are the ones it does not). */
  function rulesDirectionOf(view: CommittedView): string {
    const first = view.entries[0];
    const pin = first !== undefined ? (dealInfoOf(first)?.pin ?? null) : null;
    const supported = deps.continuation?.capability.rules.supported ?? SUPPORTED_RULES_ENGINE_VERSIONS;
    if (pin === null || supported.includes(pin)) return "rules-not-supported";
    return pin > Math.max(...supported) ? "rules-version-newer" : "rules-version-older";
  }

  /** What a game is NOW. Loaded: its view. Not loaded: stage one if it has not been reconciled this run (discovery's
   *  line, its record's claim NOT believed); a fail-closed conclusion this run reached; else its record -- which this
   *  process reconciled (or created) and has written every change to since. */
  function classifyNow(gameId: string): { gameId: string; cls: GameClass; code: string | null; detail: string | null } {
    const record = recordIndex.get(gameId) ?? null;
    const game = peekLoaded(gameId);
    if (game !== undefined) return classOfView(gameId, game.view);
    const found = (discovery as DiscoveryReport | null)?.games.get(gameId);
    if (unreconciled.has(gameId)) {
      return found?.cls === "unreconciled"
        ? { gameId, cls: found.cls, code: found.code, detail: found.detail }
        : { gameId, cls: "unreconciled", code: "not-loaded", detail: record ? `the record says ${record.status}; not loaded since this server started` : null };
    }
    const reached = concluded.get(gameId);
    if (reached === "healthy") return record !== null ? { gameId, cls: classOfRecord(record, now()), code: null, detail: null } : { gameId, cls: "attention", code: null, detail: null };
    if (reached !== undefined) return { gameId, ...reached };
    const sticky = found !== undefined && (found.cls === "held" || found.cls === "incompatible" || found.cls === "attention" || found.cls === "unavailable");
    if (found !== undefined && (sticky || record === null)) return { gameId, cls: found.cls, code: found.code, detail: found.detail };
    if (record !== null) return { gameId, cls: classOfRecord(record, now()), code: null, detail: null };
    return { gameId, cls: "attention", code: null, detail: null };
  }

  function inventory() {
    const ids = new Set<string>([...recordIndex.keys(), ...(((discovery as DiscoveryReport | null)?.games.keys()) ?? [])]);
    const games = [...ids].sort().map(classifyNow);
    return { games, byClass: countByClass(games) };
  }

  /** The operator's status snapshot (`ops/status.json`), rewritten on every change of note -- COALESCED here too: a
   *  thousand games reconnecting after a restart settle a thousand reconciliations, and the inventory behind the
   *  snapshot is built once per turn of the event loop, not once per game. `flushStatus` writes a pending one now. */
  let statusPending: ReturnType<typeof setImmediate> | null = null;
  function publishStatus(): void {
    if (statusPending !== null) return;
    statusPending = setImmediate(() => {
      statusPending = null;
      try {
        writeStatus();
      } catch (error) {
        deps.warn(`  ops: the status snapshot could not be built -- ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    statusPending.unref?.();
  }
  function flushStatus(): void {
    if (statusPending === null) return;
    clearImmediate(statusPending);
    statusPending = null;
    writeStatus();
  }

  function writeStatus(): void {
    const report = discovery as DiscoveryReport | null;
    const { games, byClass } = inventory();
    const listed = (cls: GameClass) => games.filter((game) => game.cls === cls).map(({ gameId, code, detail }) => ({ game_id: gameId, code, detail }));
    ops.status({
      rules_engine_version: RULES_ENGINE_VERSION,
      games: { total: games.length, by_class: byClass },
      held: listed("held"),
      incompatible: listed("incompatible"),
      /* LIVE-4 (L4-2): the games this pool does not continue, each with its verdict's `why` -- derived, never held. (The
         build-pinned `read_only` list is gone with #1252.) */
      not_continued: games.filter((game) => game.cls === "incompatible").map(({ gameId, code }) => ({ game_id: gameId, why: code })),
      unavailable: listed("unavailable"),
      attention: listed("attention"),
      unreconciled: games.filter((game) => game.cls === "unreconciled").length,
      discovery:
        report === null
          ? null
          : {
              started_at: report.startedAt,
              took_ms: report.finishedAt - report.startedAt,
              holds_created: report.holdsCreated,
              store_errors: report.storeErrors,
              index: report.index === null ? null : { rebuilt: report.index.rebuilt, added: report.index.added, repointed: report.index.repointed, orphans: report.index.orphans },
            },
      rooms: { ...counters },
      ...(deps.statusExtras ? deps.statusExtras() : {}),
    });
  }

  function prune(): void {
    sweepExpired();
    sweepArchive();
    /* LIVE-4 (L4-2): the serving review (a no-op on a primary pool). */
    void reviewServing().catch((error) => deps.warn(`  serving: the review failed -- ${error instanceof Error ? error.message : String(error)}`));
    publishStatus();
    for (const gameId of [...chats.keys()]) if (!viewSubs.has(gameId)) chats.delete(gameId);
    for (const gameId of [...presence.keys()]) if (!viewSubs.has(gameId)) presence.delete(gameId);
    for (const buckets of [createsPrincipal, createsGlobal, joinFailPrincipal, joinFailGlobal, membership, clockOps, submitsSeat, submitsGame, offersSeat, offersSeatSustained, chatSeat, rotations]) buckets.prune();
    createsIp.prune();
    joinFailIp.prune();
    const cutoff = now();
    for (const [gameId, until] of unknownGames) if (until <= cutoff) unknownGames.delete(gameId);
  }

  /* ==================================================================
      LIVE-4 (L4-2): THE SERVING REVIEW -- THE TIMER HALF OF T-24
     ==================================================================
     `serveDecision` is asked by every session at every rebuild and before every submit; this is the third place: a
     periodic pass (the 60-second sweep, `prune`) over every RESIDENT game still served, so one that crossed its pool's
     drain deadline stops being served at once -- its view republished as not served, every reader told, its caps
     freed (the actor's `onNotServed`, below) -- without waiting for a submit and without reloading its actor. A primary
     pool (every pool until LIVE-6) never declines a game it continues, so the pass is skipped outright there. ONE PASS
     AT A TIME (a slow pass is never overlapped by the next), a game already not served is not visited, and the review
     is not activity (it never keeps an idle actor resident). Derived: nothing is written. Resolves with how many games
     stopped being served. */
  let reviewing: Promise<number> | null = null;
  /* LIVE-4 (integration): `continuation: true` is the pass run when the chain facts every verdict reads have changed
     (`start.ts`: the money serving's chain-facts listener). It runs on a primary too -- the question is no longer only
     "does this pool still serve it" but "does this pool still continue it".
     LIVE-4 (L4-7): AND IT IS QUEUED ON EVERY RESIDENT GAME AT ONCE -- in the same synchronous step as the chain-facts
     change that asked for it -- never one game after another, and never behind a pass already running. Before L4-7 the
     pass awaited each game's review before queueing the next one's, so a game late in the pass kept ADMITTING NEW moves
     (moves that arrived after this process knew of the contradiction) for as long as the earlier games' queues took to
     drain. Now every game's review task is queued before any later task can be, so the one exact boundary is the actor
     queue's own: a move queued BEFORE the contradiction was recorded may still commit (already admitted: the log stays
     canonical and every money seam re-asks the verdict before it writes); a move queued after it is refused. The review
     task is idempotent (one way), so a second request only queues a second no-op. */
  function reviewServing(options: { readonly continuation?: boolean } = {}): Promise<number> {
    if (options.continuation === true) return reviewContinuationNow();
    if (deps.continuation !== undefined && !deps.continuation.hasServingPolicy()) return Promise.resolve(0);
    if (reviewing !== null) return reviewing;
    reviewing = (async () => {
      const resident: GameActor[] = [];
      deps.games.forEach?.((actor) => resident.push(actor));
      let stopped = 0;
      for (const game of resident) {
        if (!game.isLoaded) continue;
        const view = game.view;
        if (view.hold !== null || view.incompatible !== null) continue; // already not served (or held): nothing to review
        try {
          if (await game.reviewServing()) stopped += 1;
        } catch (error) {
          deps.warn(`  serving: the review of ${game.gameId} failed -- ${error instanceof Error ? error.message : String(error)}; it is asked again at the next pass`);
        }
      }
      return stopped;
    })().finally(() => {
      reviewing = null;
    });
    return reviewing;
  }

  /** LIVE-4 (L4-7): the continuation review, queued on every resident served game NOW (synchronously: `GameActor.run`
   *  queues inside the call), then awaited together. A game still loading is skipped: its load's rebuild asks the verdict
   *  after this change, with the new facts. Resolves with how many games stopped being served. */
  function reviewContinuationNow(): Promise<number> {
    const queued: Array<Promise<boolean>> = [];
    deps.games.forEach?.((game) => {
      if (!game.isLoaded) return;
      const view = game.view;
      if (view.hold !== null || view.incompatible !== null) return; // already not served (or held): nothing to review
      queued.push(
        game.reviewServing({ continuation: true }).catch((error) => {
          deps.warn(`  serving: the continuation review of ${game.gameId} failed -- ${error instanceof Error ? error.message : String(error)}; it is asked again at the next change`);
          return false;
        }),
      );
    });
    return Promise.all(queued).then((stopped) => stopped.filter((value) => value).length);
  }

  /** LIVE-4 (L4-2): an actor stopped serving `gameId` -- its serving review concluded "no", or a rebuild it had not
   *  published (a rollback after a refused deal, a failed task) asked the pool afresh and was told "no". The game is
   *  re-classified from its view (not continued: derived, its caps freed), audited once, and every room reader is sent
   *  the new view. Nothing is written. */
  function onNotServed(gameId: string, source: "serving" | "rebuild"): void {
    const resident = peekLoaded(gameId);
    if (resident === undefined) return;
    const conclusion = classOfView(gameId, resident.view);
    if (conclusion.cls === "incompatible") auditNotContinued(gameId, conclusion.code ?? "not-continued", conclusion.detail, source);
    settle(gameId, conclusion);
    broadcastView(gameId);
    scheduleList();
    publishStatus();
  }

  /** LIVE-4 (L4-2): `gameId`'s record as this server last committed it (resident first, then the index), or null. */
  function recordOf(gameId: string): GameRecord | null {
    const resident = peekLoaded(gameId)?.view.record ?? null;
    return resident ?? recordIndex.get(gameId) ?? null;
  }

  return {
    indexReady,
    counters,
    denied,
    resolveGame,
    actorFor,
    recordOf,
    reviewServing,
    onNotServed,
    playerIdOf,
    sweepExpired,
    viewerRoomFor,
    canReadLog,
    seatActor,
    submitBudget,
    offerBudget,
    offerSpent,
    afterGameplay,
    syncRecord,
    onRecordPublished,
    handleRoomOp,
    handleRoomHello,
    handleChat,
    handlePresence,
    handleRoomsWatch,
    hasSubscription,
    dropSocket,
    prune,
    viewGameOf: (socket: WebSocket) => viewGameOf.get(socket),
    unknownGameCount: () => unknownGames.size,
    recordIndexSize: () => recordIndex.size,
    /* LIVE-3C */
    onActorLoaded,
    onStoreAdopted,
    awaitingReconciliation,
    unavailableFor,
    pendingHoldOf,
    isReconciled: (gameId: string) => !unreconciled.has(gameId),
    sweepArchive,
    inventory,
    publishStatus,
    flushStatus,
    discovery: (): DiscoveryReport | null => discovery,
    boardOf,
    /* ESCROW-4: the port the money layer is built on. */
    moneyPort,
    /* Phase 3 final clocks: the table clock (null when this host keeps none). */
    clock,
    /* P3-ACCT: the trust indicators' reads (server-side only). */
    readableSeats,
    seatPrincipalsOf,
    tablesOf,
    /* ESCROW-3A (brief §6): the money games the index knows (never a replay; the coordinator loads them). */
    financialGameIds: (): string[] => [...recordIndex.values()].filter((record) => settlement.retentionOf(record).kind === "financial").map((record) => record.game_id),
    financialRecords: (): GameRecord[] => [...recordIndex.values()].filter((record) => settlement.retentionOf(record).kind === "financial"),
    /** LUDUM (Lane A, read-only): every record the index knows, as a snapshot (`ludum/wiring.ts`'s `LudumPorts.records`). */
    records: (): GameRecord[] => [...recordIndex.values()],
    /** PLAY LOBBY: the public list as it would be pushed now (the player-history route answers only for these). */
    publicRooms: (): RoomSummary[] => summaries(),
  };
}

export type RoomHost = ReturnType<typeof createRoomHost>;

/** LIVE-3C: the store could not be read just now -- not a verdict on the game. Answered `unavailable`, tried again at
 *  the next ask (the registry drops a failed load). */
export class GameUnavailableError extends Error {
  /** LIVE-6 L6-1: the load failed because another pool owns the game (its claim was refused): the owner the table named. */
  readonly routed: GameRoutedError | null;
  constructor(
    readonly gameId: string,
    cause: unknown,
  ) {
    super(`${gameId} could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "GameUnavailableError";
    this.routed = cause instanceof GameRoutedError ? cause : null;
  }
}

export { GAME_OVER_SENTENCE, UNAVAILABLE_PLAYER_SENTENCE };
export type { DiscoveredGame };
