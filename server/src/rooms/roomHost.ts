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

import { effectiveActions, dealEntryOf } from "../../../frontend/src/gameEngine/logRevert";
import { resolveVariants } from "../../../frontend/src/gameEngine/gameVariants";
import { sanitizeText } from "../../../frontend/src/gameEngine/messageSchema";
import type { RoomChatEntry } from "../../../frontend/src/utils/roomProtocol";
import type { PresenceState } from "../../../frontend/src/utils/presence";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import type { ServerMessage } from "../../../frontend/src/utils/serverProtocol";
import type { WebSocket } from "ws";

import type { RoomSession } from "../../../frontend/src/utils/roomSession";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";

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
  type GameRecord,
  type HoldKind,
  type LogFacts,
  type RoomSummary,
} from "./gameRecord";
import { createMemoryHoldStore, type HoldStore } from "./holdStore";
import {
  ARCHIVE_SWEEP_BUDGET,
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
const MAX_CHAT_LENGTH = 500;

export interface RoomHostDeps {
  build: string;
  records: RecordStore;
  games: { get(gameId: string): Promise<GameActor>; peek(gameId: string): GameActor | undefined };
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
  /** LIVE-3C: whether a session's board has ended or closed (the reducer's `GameEnd` / `room_closed`; a test seam
   *  may say so of a game that has not -- a stored game that reaches GameEnd needs a whole game played). */
  boardFacts?: (gameId: string, session: RoomSession) => { ended: boolean; closed: boolean };
  /** LIVE-3C: more for the status snapshot (the identity store's health, the log store's counters). */
  statusExtras?: () => Record<string, unknown>;
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

export function factsFromEntries(entries: readonly ServerLogEntry[], ended: boolean, closed: boolean): LogFacts {
  const deal = dealEntryOf(effectiveActions(entries));
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

/** LIVE-3C: what a room shows about why it will not take a change -- the RoomView's `holdKind`. `build` is this
 *  server's (a game dealt on another build is read-only, #1252). */
export function holdKindOf(view: CommittedView, build: string): HoldKind {
  if (isMaintenanceHold(view.hold)) return "maintenance";
  if (view.incompatible !== null || view.hold?.reason === "version") return "incompatible";
  if (view.hold?.reason === "uncertain") return "unavailable";
  const first = view.entries[0];
  if (first !== undefined && first.index === 0) {
    const deal = dealInfoOf(first);
    if (deal && deal.build !== null && deal.build !== build) return "read-only";
  }
  return null;
}

/** LIVE-3C: the sentence a `gone` answer carries, by what ended the table. */
export function goneSentence(record: Readonly<GameRecord> | null): string {
  if (record === null) return GONE_SENTENCES.gone;
  if (record.archived_at !== null) return GONE_SENTENCES.archived;
  if (record.status === "cancelled") return GONE_SENTENCES.cancelled;
  if (record.status === "expired" || (record.status === "waiting" && record.expires_at !== null)) return GONE_SENTENCES.expired;
  return GONE_SENTENCES.gone;
}

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
  const submitsSeat = new KeyedBuckets(rooms.submitsPerSeat, now, keys);
  const submitsGame = new KeyedBuckets(rooms.submitsPerGame, now, keys);
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
  const settlement = deps.settlement ?? NO_MONEY_SETTLEMENT;
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
        now,
        warn: deps.warn,
        ops,
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
    if (pinned.has(gameId)) return;
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
    if (!factsFromView(view, record).dealt) {
      settle(game.gameId, null); // no history: the load's own reconciliation (an empty log) was the whole of it
      return;
    }
    syncRecord(game, "load");
  }

  /** A game's reconciliation is concluded for this run: healthy (`null`: its record, which this process now writes, is
   *  believed) or a fail-closed class kept for after its actor is evicted. */
  function settle(gameId: string, failClosed: { cls: GameClass; code: string | null; detail: string | null } | null): void {
    const was = unreconciled.delete(gameId);
    const before = concluded.get(gameId);
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

  function viewFrame(game: GameActor, principalId: string): object | null {
    const view = game.view;
    const record = view.record;
    if (record === null) return null;
    const facts = factsFromView(view, record);
    return {
      kind: "room",
      gameId: record.game_id,
      view: roomViewFor(record, facts, principalId, {
        now: now(),
        held: heldOf(view),
        holdKind: holdKindOf(view, deps.build),
        online: onlineIn(record.game_id, record),
        canStart: !facts.dealt && waitingBlock(record) === null && view.hold === null,
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
      deps.send(socket, frame);
    }
  }

  function broadcastPresence(gameId: string): void {
    pushToReaders(gameId, presenceFrame(gameId));
  }

  /* ---- the public list: coalesced ---- */
  function summaries(): RoomSummary[] {
    const out: RoomSummary[] = [];
    for (const record of recordIndex.values()) {
      /* LIVE-3C: ONLY WHAT IS KNOWN. A game not yet reconciled this run is left out -- its record says "playing" or
         "waiting" and nobody has checked that against its log -- and so is one concluded held, incompatible,
         unavailable or needing attention (nobody can join or play it). It appears once its first load (anybody's
         reconnect, room view or code) has reconciled it. */
      const now_ = classifyNow(record.game_id).cls;
      if (now_ !== "waiting" && now_ !== "active" && now_ !== "read-only") continue;
      const resident = peekLoaded(record.game_id);
      const facts = resident ? factsFromView(resident.view, record) : factsFromEntries([], false, false);
      const dealtFromRecord = record.started_at !== null || record.status === "active" || record.status === "completed";
      const summary = roomSummaryOf(record, resident ? facts : { ...facts, dealt: dealtFromRecord, ended: record.status === "completed" }, now());
      if (summary !== null) out.push(summary);
    }
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
      /* LIVE-3C: NOTHING IS WRITTEN ON AN UNRECONCILED RECORD (its load's repair has not landed): refused, and the
         reconciliation tried again as a task of its own -- so no op, and no sweep, builds on a record the log may
         contradict. */
      if (awaitingReconciliation(game)) return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      /* THE WAITING-ROOM TTL (§5.3), made durable by the first op (or sweep) that finds it passed. */
      if (record.status === "waiting" && effectiveStatus(record, facts, at) === "expired") {
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

  const MEMBERSHIP_OPS = new Set(["join", "take-seat", "release-seat", "leave", "set-ready", "set-profile"]);
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

  async function handleCreate(socket: WebSocket, ctx: ConnectionContext, requestId: string, op: Record<string, unknown>): Promise<void> {
    await indexReady;
    const ip = deps.ipOf(socket);
    /* LIVE-2's invariant: no money games. A stake is refused unless it is zero -- no chain concept is read here. */
    const stakeRaw = op.stake;
    if (stakeRaw !== undefined && !(typeof stakeRaw === "string" && /^0+$/.test(stakeRaw))) {
      return ack(socket, requestId, { ok: false, code: "money-games-disabled", reason: "Games with stakes are not open on this server." });
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
      code = await claimFreshCode(gameId);
      if (code === null) return ack(socket, requestId, { ok: false, code: "unavailable", reason: UNAVAILABLE });
      const claimed = code;
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
          hostPlayerId: mintPlayerId(),
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
    const opName = OP_NAMES[type] ?? null;
    let claimingSeat = false;
    if (type === "take-seat") {
      /* Authorized FIRST (review L3/L4): an outsider learns nothing from the cap, and nobody is made durable for a
         seat they may not take. */
      const verdict = authorizeNow(game, ctx.principalId, "take-seat");
      if (!verdict.ok) return ack(socket, requestId, verdict);
      const record = game.view.record as GameRecord;
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
          default:
            return { ok: false, code: "bad-frame", reason: "That is not a room operation." };
        }
      }, needsCode);
      if (result.ok && result.value.effects?.unsubscribeOnly && viewGameOf.get(socket) === frame.gameId) dropView(socket);
      return ack(socket, requestId, result.ok ? { ok: true, ...(result.value.data ? { data: result.value.data } : {}) } : result);
    } finally {
      if (claimingSeat) adjust(pendingSeats, ctx.principalId, -1);
    }
  }

  /* ---- start (§8) ---- */

  async function startGame(game: GameActor, principalId: string): Promise<{ ok: true; data?: Record<string, unknown> } | Refusal> {
    const outcome = await game.run("room-op", async (tx): Promise<{ ok: true; data?: Record<string, unknown> } | Refusal> => {
      const record = tx.view.record;
      if (record === null) return { ok: false, code: "not-found", reason: "There is no such game." };
      const maintenance = isMaintenanceHold(tx.view.hold);
      const facts = maintenance ? factsFromRecord(record) : factsFromTx(tx, boardOf(record.game_id, tx.session));
      const seat = seatOf(record, principalId);
      /* Idempotent (§8.2 step 2): a second press, or a lost ack, is told the game already started. */
      if (!maintenance && facts.dealt && seat !== null && seat.player_id === record.host_player_id) return { ok: true, data: { alreadyStarted: true } };
      const verdict = withGoneReason(authorize("start-game", { record, facts, principalId, now: now(), held: heldOf(tx.view) }), record);
      if (!verdict.ok && verdict.code === "not-found") return { ok: false, code: verdict.code, reason: verdict.reason };
      /* LIVE-3C: a held table is not dealt, whatever the host presses. */
      if (maintenance) return { ok: false, code: "held", reason: HELD_PLAYER_SENTENCE };
      if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason };
      if (tx.view.hold !== null) return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      if (awaitingReconciliation(game)) return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      const plan = await deps.rosterSource.plan(record, { shuffle: deps.shuffle, now: now() });
      if ("refusal" in plan) return { ok: false, code: plan.code === "wrong-state" ? "wrong-state" : "not-ready", reason: plan.reason, ...({ block: plan.code } as object) } as Refusal;
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
      const settled = await tx.commitBatch(batch, (s) =>
        s.kind === "committed" ? { fanout: { kind: "applied", entries: s.entries, digest: s.view.digest, ...(s.view.fields ? { fields: { ...s.view.fields } } : {}), build: deps.build } } : {},
      );
      if (settled.kind !== "committed") return { ok: false, code: "unavailable", reason: UNAVAILABLE };
      return { ok: true, data: { started: true } };
    });
    if (outcome.kind === "failed") {
      /* A deal that broke `assertDeal`, or a roster source that threw: a server bug, never the host's -- logged. */
      const ref = deps.errorRef();
      deps.warn(`  threw: start-game failed for ${game.gameId} (ref ${ref}) -- ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
      return { ok: false, code: "internal", reason: `The server could not deal this game. (ref ${ref})` };
    }
    if (outcome.kind !== "ran") return { ok: false, code: outcome.kind === "busy" ? "busy" : "unavailable", reason: outcome.kind === "busy" ? BUSY : UNAVAILABLE };
    if (outcome.value.ok) syncRecord(game, "deal");
    return outcome.value;
  }

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
            if (seal !== null) callSettlement({ gameId: record.game_id, record, seal, recovered: true });
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
            if (sealed !== null) callSettlement({ gameId: record.game_id, record: next, seal: sealed, recovered: why === "load" });
            else if (reannounce !== null) callSettlement({ gameId: record.game_id, record: next, seal: reannounce, recovered: true });
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

  /** After a committed gameplay batch on a server-owned game: the board may have ended or closed. */
  function afterGameplay(game: GameActor, ended: boolean, closed: boolean): void {
    const record = game.view.record;
    if (record === null) return;
    if ((ended && record.status !== "completed") || (closed && record.closed_at === null) || record.status === "waiting") syncRecord(game, "gameplay");
  }

  /* ---- reads ---- */

  async function handleRoomHello(socket: WebSocket, gameId: string): Promise<void> {
    const principalId = principalOf(socket);
    let game: GameActor | null;
    try {
      game = await actorFor(gameId);
    } catch (error) {
      if (error instanceof GameUnavailableError) return deps.send(socket, { kind: "error", ...unavailableFor(gameId, principalId) });
      throw error;
    }
    if (game === null) return deps.send(socket, { kind: "error", code: "not-found", reason: "There is no such game." });
    /* LIVE-3C: a view is built only from a RECONCILED record -- the load's repair task (queued first) has run. */
    if (unreconciled.has(gameId)) await game.run("room-op", () => undefined);
    const verdict = authorizeNow(game, principalId, "read-view");
    if (!verdict.ok) return deps.send(socket, { kind: "error", code: verdict.code, reason: verdict.reason });
    if (viewGameOf.get(socket) !== gameId && !viewerRoomFor(socket, gameId)) {
      return deps.send(socket, { kind: "error", code: "room-full", reason: "This table has as many watchers as it takes." });
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

  /** The seat behind a gameplay submit, from the record committed NOW (inside the submit's task). */
  function seatActor(tx: Tx, principalId: string): { ok: true; actor: string; host: string; policy: GameRecord["policy"]["host_undo"] } | Refusal {
    const record = tx.view.record;
    if (record === null) return { ok: false, code: "not-found", reason: "There is no such game." };
    const facts = isMaintenanceHold(tx.view.hold) ? factsFromRecord(record) : factsFromTx(tx, boardOf(record.game_id, tx.session));
    const verdict = withGoneReason(authorize("submit", { record, facts, principalId, now: now(), held: heldOf(tx.view) }), record);
    if (!verdict.ok) {
      /* Before the deal a seated player's move is `wrong-state` in the table; the session answers it better. */
      const seat = seatOf(record, principalId);
      if (verdict.code === "wrong-state" && seat !== null) return { ok: true, actor: seat.player_id, host: record.host_player_id, policy: record.policy.host_undo };
      return { ok: false, code: verdict.code, reason: verdict.reason };
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
    if (view.incompatible !== null || hold?.reason === "version") return { gameId, cls: "incompatible", code: "rules-version", detail: hold?.detail ?? null };
    if (hold?.reason === "uncertain") return { gameId, cls: "unavailable", code: hold.restart ? "store-restart-required" : "store-uncertain", detail: hold.detail };
    const record = view.record;
    if (record === null) return { gameId, cls: "attention", code: null, detail: "loaded with no record" };
    if (unreconciled.has(gameId)) return { gameId, cls: "unreconciled", code: "repair-pending", detail: "loaded; the record's repair from its log has not landed" };
    if (holdKindOf(view, deps.build) === "read-only") return { gameId, cls: "read-only", code: "build-pinned", detail: null };
    /* The lifecycle the LOG implies (a record's own follow-up write may be a task behind it, RL-1). */
    return { gameId, cls: record.archived_at !== null ? "archived" : effectiveStatus(record, factsFromView(view, record), now()), code: null, detail: null };
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
      read_only: listed("read-only"),
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
    publishStatus();
    for (const gameId of [...chats.keys()]) if (!viewSubs.has(gameId)) chats.delete(gameId);
    for (const gameId of [...presence.keys()]) if (!viewSubs.has(gameId)) presence.delete(gameId);
    for (const buckets of [createsPrincipal, createsGlobal, joinFailPrincipal, joinFailGlobal, membership, submitsSeat, submitsGame, chatSeat, rotations]) buckets.prune();
    createsIp.prune();
    joinFailIp.prune();
    const cutoff = now();
    for (const [gameId, until] of unknownGames) if (until <= cutoff) unknownGames.delete(gameId);
  }

  return {
    indexReady,
    counters,
    denied,
    resolveGame,
    actorFor,
    playerIdOf,
    sweepExpired,
    viewerRoomFor,
    canReadLog,
    seatActor,
    submitBudget,
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
  };
}

export type RoomHost = ReturnType<typeof createRoomHost>;

/** LIVE-3C: the store could not be read just now -- not a verdict on the game. Answered `unavailable`, tried again at
 *  the next ask (the registry drops a failed load). */
export class GameUnavailableError extends Error {
  constructor(
    readonly gameId: string,
    cause: unknown,
  ) {
    super(`${gameId} could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "GameUnavailableError";
  }
}

export { GAME_OVER_SENTENCE, UNAVAILABLE_PLAYER_SENTENCE };
export type { DiscoveredGame };
