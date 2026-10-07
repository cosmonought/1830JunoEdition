// server/src/rooms/clock/clockController.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS: THE CONTROLLER -- THE STATE MACHINE RUN INSIDE EACH GAME'S SERIALIZATION
// ==================================================================
//
// The pure model (`clockModel.ts`) decides; this module runs it at the right moments, keeps it durable, and is the
// only writer of a table's clock record:
//
//   gateSubmit    IN THE SUBMIT TASK, before the move is speculated: the record is read back and its CONTINUITY
//                 checked (once per process), every transition due by now is processed at its own exact moment (an
//                 overdue, a minute-30 finality, a Live offer's unanswered expiry -- which closes the offer in the log,
//                 as the server's own move, and refuses the submit that found it so it is judged on the new board),
//                 then the gate says whether this move may be taken (a pause, a system pause, an interruption, an ended
//                 game, a fenced undo, the two-decline limit). The SAME time `now` stamps the move's entries, so a cure
//                 at 29:59.999 and a finality at 30:00 are ordered exactly as they happened in the game's serialization.
//   afterCommit   IN THE SAME TASK, after the batch is durable: the batch is folded (responsibility, refresh, offers,
//                 cures, declines, snapshots) and the record written BEFORE the task ends.
//   ops           room ops (deadline choice, pause / resume, system resume, N-1 proposals and votes, a free table's
//                 annulment, the No-deadline acknowledgement) each in an actor task of their own.
//   timers        the next due transition and (Live) the continuity heartbeat, each fired as an actor task, so a table
//                 nobody is watching still reaches its overdue and its finality in real time. A Live table whose clock
//                 runs is PINNED resident (never evicted while timed).
//   remedies      a sealed money remedy (an ENDED game's) is attested and relayed (`remedyPipeline.ts`) only once its
//                 seal is DURABLE and only from the clock's current authority -- revalidated at every attempt, never
//                 changed, never gated by a player vote (owner, 2026-10-06); the relayer asks `remedyGate` before every
//                 new attempt.
//
// CONTINUITY. Every write stamps this process's AUTHORITY token (file mode: the data-directory lock's instance id; AWS:
// the generation, pool, pool epoch and task) and its trust instant. A record another authority wrote is a continuity
// break that was NOT proven continuous: the gap the previous authority left in the log (if any) is recovered from the
// log itself, then a Live table still in play enters SYSTEM PAUSE (every timer frozen as of the last proven instant;
// unanimous resume), a Timed Async table's outage is credited, a No-deadline table changes nothing, and an ENDED table
// (its remedy sealed) only carries the sealed remedy on -- no pause, no vote. A reload in the SAME process (an
// eviction) keeps continuity: the process held the authority throughout, so the elapsed time is real. A stale actor
// (taken over) cannot write the clock (the HEAD fence / the lock check), so it can neither move a clock nor sign a remedy.

import type { GameStateResponse } from "../../../../frontend/src/gameEngine/gameState";
import { operatingRoundKeyOf, requiredDecisionOf, standingOfferOf } from "../../../../frontend/src/gameEngine/clockResponsibility";
import { logHash } from "../../../../frontend/src/gameEngine/logHash";
import { sellerPresident } from "../../../../frontend/src/gameEngine/trainSaleAuthority";
import type { ClockDeadlineClass, RoomClockView } from "../../../../frontend/src/utils/clockProtocol";
import { CLOCK_REFUSAL, declinesReachedSentence } from "../../../../frontend/src/utils/clockProtocol";
import type { RoomSession, ServerLogEntry } from "../../../../frontend/src/utils/roomSession";
import type { UndoPolicy } from "../../../../frontend/src/gameEngine/logRevert";
import type { OpsRecorder } from "../../persistence/opsRecorder";
import type { StoreWriteOutcome } from "../../persistence/storeResult";
import { intentCarriesDecision, sealedRemedyProblem, type RemedyPort } from "../../escrow/remedyPipeline";
import type { ChainIntentRecord } from "../../escrow/chainIntents";
import type { GameActor, Tx } from "../gameActor";
import { nextHead, type ClockConductHook, type ClockEvidenceEvent } from "./clockEvidence";
import {
  acknowledge,
  advance,
  annulVote,
  choosePolicy,
  classifyMessage,
  clockViewOf,
  continuityBreak,
  declineKey,
  escrowEnded,
  foldBatch,
  gate,
  heartbeat,
  newClockRecord,
  nextDue,
  pauseOp,
  propose,
  recoverGap,
  isRequiredClass,
  remedyBlocked,
  remedyProgress,
  stampAuthority,
  systemResumeVote,
  vote,
  type ClockBatch,
  type ClockBoardFacts,
  type ClockEffect,
  type ClockMsgClass,
  type ClockRefusal,
  type ClockStep,
} from "./clockModel";
import { ClockUnreadableError, LIVE_CURE_MS, LIVE_DECLINES_PER_OR, type ClockVote, type GameClockRecord } from "./clockRecord";
import type { ClockStore } from "./clockStore";

/* ==================================================================
    PORTS
   ================================================================== */

/** Injected so tests run on controlled time. */
export interface ClockTimers {
  set(fire: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const REAL_CLOCK_TIMERS: ClockTimers = {
  set(fire, ms) {
    const handle = setTimeout(fire, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Live: how often an authority re-proves it is in continuous control of a running clock (the outage a system pause
 *  credits is measured from the last proof, so this bounds how much a crash can hand back). */
export const CLOCK_HEARTBEAT_LIVE_MS = 10_000;
/** Timed Async: the same, coarser (the paces are hours to days). */
export const CLOCK_HEARTBEAT_ASYNC_MS = 5 * 60_000;
/** A RUNNING clock whose last proof of continuity (a heartbeat or any write by this authority) is older than this was
 *  not in this process's continuous control: the process stalled (suspended, frozen, starved) and no timer, vote or
 *  move could have been served meanwhile -- a continuity break like a restart (Live: SYSTEM PAUSE as of the last proof;
 *  Async: the gap credited). Never decided from time nobody could act in. Six missed heartbeats. */
export const CLOCK_CONTINUITY_GAP_LIVE_MS = 6 * CLOCK_HEARTBEAT_LIVE_MS;
export const CLOCK_CONTINUITY_GAP_ASYNC_MS = 6 * CLOCK_HEARTBEAT_ASYNC_MS;
/** The remedy sweep: sealed-but-unconfirmed remedies are carried on (a lapsed attestation re-attested). */
export const CLOCK_REMEDY_SWEEP_MS = 30_000;
/** A refused remedy is asked again no sooner than this, doubling to `CLOCK_REMEDY_BACKOFF_MAX_MS`. */
export const CLOCK_REMEDY_BACKOFF_MIN_MS = 30_000;
export const CLOCK_REMEDY_BACKOFF_MAX_MS = 10 * 60_000;
/** A timed transition whose task could not run (or whose write did not land) is retried after this, doubling. */
export const CLOCK_RETRY_MIN_MS = 1_000;
export const CLOCK_RETRY_MAX_MS = 30_000;
/** A HELD table (LIVE-3C: incompatible, held, or awaiting reconciliation) runs no clock task; this is how often it is
 *  looked at again. Its timers do not advance and no continuity is proven meanwhile, so when the hold lifts the stall
 *  check treats the held time as a continuity break (Live: SYSTEM PAUSE; Async: credited) -- never charged. */
export const CLOCK_HELD_RECHECK_MS = 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The server's own closing of an expired train offer (a `RescindTrainPurchase` as its proposer, in the game's task).
 *  A failure says whether the ENGINE found no offer to close (`engine`: the board disagrees with the clock) or the
 *  commit did not land (`store`: nothing changed; retried). */
export type CloseOffer = (
  game: GameActor,
  tx: Tx,
  input: { readonly proposer: string; readonly at: number; readonly offerKey: string },
) => Promise<{ readonly ok: true; readonly first: number; readonly last: number; readonly before: ClockBoardFacts; readonly after: ClockBoardFacts } | { readonly ok: false; readonly why: string; readonly kind?: "engine" | "store" }>;

export interface ClockControllerDeps {
  readonly store: ClockStore;
  /** This process's continuity token (see the header). */
  readonly authority: string;
  now(): number;
  readonly timers?: ClockTimers;
  readonly ops: OpsRecorder;
  warn(line: string): void;
  /** Run a task on a game's actor (loading it when needed). False: it could not run. */
  runOn(gameId: string, label: string, task: (game: GameActor, tx: Tx) => Promise<void>): Promise<boolean>;
  /** The table's room views changed (re-broadcast). */
  onChange(gameId: string): void;
  /** Whether this process still serves the game. */
  serving(gameId: string): boolean;
  /** Keep a timed table's actor resident (`true`) or let it go (`false`). */
  pin?(gameId: string, on: boolean): void;
  readonly closeOffer: CloseOffer;
  /** Money: the remedy pipeline, bound late (`null`/absent: no money remedies on this server -- refused, fail closed). */
  remedy?(): RemedyPort | null;
  /** Money: the escrow's terminal route when its financial record is closed on chain (`null`: not terminal). */
  moneyTerminal?(gameId: string): Promise<string | null>;
  /** Money: the chain's Start time (seconds) of a bound game, for the first obligation's clamp (`null`: unknown). */
  moneyStartedAtSecs?(gameId: string): Promise<number | null>;
  /** A player's display name, for the owner's copy. */
  nameOf?(gameId: string, seat: string): string;
  /** The reporting hook (player-reporting lane): every durable evidence event. */
  readonly conduct?: ClockConductHook;
  /** The server's own reading of whether a board ended / closed (its test seam). */
  boardEnd?(gameId: string, state: GameStateResponse): { readonly ended: boolean; readonly closed: boolean } | null;
  /** Whether the table is HELD (LIVE-3C: held, incompatible or awaiting reconciliation): nobody can move, so its clock
   *  neither advances nor proves continuity, and nothing of it is relayed. */
  held?(gameId: string): boolean;
  /** Whether the table is FROZEN: it takes no more moves for good (its log reached the ingress cap). Its timers stop
   *  (nobody can make the owed move), but its votes, annulment and any sealed remedy carry on. */
  frozen?(gameId: string): boolean;
}

export type ClockAnswer = { readonly ok: true; readonly data?: Record<string, unknown> } | { readonly ok: false; readonly code: string; readonly reason: string };

/** A clock op decided but not yet durable: the server keeps it and writes it on its next attempt. */
const NOT_RECORDED: ClockAnswer = { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "The server could not record that yet; it is retrying. Check the table in a moment." };

export interface GateResult {
  readonly ok: true;
  /** The time the move is judged at and its entries are stamped with. */
  readonly now: number;
  readonly before: ClockBoardFacts | null;
  readonly cls: ClockMsgClass;
  readonly revertTarget: number | null;
}

interface Entry {
  readonly gameId: string;
  record: GameClockRecord | null;
  /** The revision the store is known to hold (`null`: none). */
  stored: number | null;
  /** Continuity checked in this process. */
  checked: boolean;
  /** A write did not settle: reread before the next decision. */
  stale: boolean;
  unreadable: ClockUnreadableError | null;
  /** The record was written by someone else meanwhile: this process no longer decides this table. */
  lost: boolean;
  writes: Promise<void>;
  loading: Promise<void> | null;
  timer: unknown | null;
  timerDue: number | null;
  beat: unknown | null;
  pinned: boolean;
  pipeline: Promise<void> | null;
  /** The revision at which the current remedy was sealed (its seal is durable once `stored >= sealedRev`). */
  sealedRev: number | null;
  /** The last read failed (not unreadable: the store did not answer): nothing is decided until it is read. */
  readFailed: string | null;
  /** Evidence events and effects decided but not yet DURABLE: reported / carried out only once their record is stored. */
  pending: Array<{ readonly event: ClockEvidenceEvent; readonly head: string }>;
  pendingEffects: Array<{ readonly effect: ClockEffect; readonly revision: number }>;
  /** Timed transitions that could not run: the next attempt no earlier than `retryAt` (backing off). */
  retries: number;
  retryAt: number | null;
  /** A refused remedy is asked again no earlier than this. */
  remedyRetryAt: number;
  remedyBackoffMs: number;
  /** The trust instant of the last record this process STORED (or read): continuity is proven only by what is durable,
   *  never by an in-memory heartbeat whose write did not land. */
  provenAt: number | null;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What a committed board says, for the clock. */
export function boardFactsOf(state: GameStateResponse, end?: { readonly ended: boolean; readonly closed: boolean } | null): ClockBoardFacts {
  const seats = Array.isArray(state.player_addresses) ? state.player_addresses.filter((seat) => typeof seat === "string" && seat !== "") : [];
  const over = end?.ended ?? state.current_round_type === "GameEnd";
  const closed = end?.closed ?? state.room_closed === true;
  return {
    over,
    closed,
    seats,
    decision: over || closed ? null : requiredDecisionOf(state, state.waterfall ?? null),
    offer: over || closed ? null : standingOfferOf(state),
    orKey: operatingRoundKeyOf(state),
  };
}

/** The proposer's own withdrawal of the standing offer of `slot` (the one legal message that withdraws it; the engine
 *  has no expiry), or `null` when the board holds no such offer. */
function rescindMessageFor(state: GameStateResponse, slot: string): Record<string, unknown> | null {
  if (slot === "train") {
    const offer = state.train_purchase_offer ?? null;
    return offer === null ? null : { RescindTrainPurchase: { seller_protocol_id: offer.seller_protocol_id } };
  }
  const purchase = state.private_purchase_offer ?? null;
  if (slot === "private" && purchase !== null) return { RescindPrivatePurchase: { private_id: purchase.private_id } };
  if (slot === "funding" && purchase !== null) return { RescindFundingPrivateOffer: { private_id: purchase.private_id } };
  const trade = state.private_trade_offer ?? null;
  if (slot === "trade" && trade !== null) return { RescindPrivateTrade: { private_id: trade.private_id } };
  return null;
}

/** The SERVER's own move when a Live offer's response time ran out unanswered: the proposer's rescission of THAT offer
 *  (`RescindTrainPurchase`, `RescindPrivatePurchase`, `RescindPrivateTrade` or `RescindFundingPrivateOffer`),
 *  speculated on the task's session with every entry stamped at the exact moment the response time ended. The caller
 *  commits the batch. */
export function rescindExpiredOffer(
  session: RoomSession,
  input: { readonly proposer: string; readonly at: number; readonly offerKey?: string; readonly build: string; readonly host: string; readonly hostUndo: UndoPolicy["host_undo"] },
  stampAt?: <T>(at: number, fn: () => T) => T,
): { readonly ok: true; readonly batch: readonly ServerLogEntry[]; readonly before: ClockBoardFacts; readonly after: ClockBoardFacts; readonly board: GameStateResponse } | { readonly ok: false; readonly why: string } {
  const state = session.state;
  const before = boardFactsOf(state);
  const standing = before.offer;
  if (standing === null) return { ok: false, why: "no offer stands" };
  /* Only THE offer whose response time ran out is closed: a different offer standing now is never rescinded. */
  if (input.offerKey !== undefined && standing.key !== input.offerKey) return { ok: false, why: "a different offer stands" };
  const rescind = rescindMessageFor(state, standing.slot);
  if (rescind === null) return { ok: false, why: "the standing offer has no withdrawal message" };
  const start = session.entries.length;
  const submit = () =>
    session.submit({
      actor: standing.proposer ?? input.proposer,
      build: input.build,
      msg: rescind as never,
      baseIndex: session.nextIndex - 1,
      /* Outside the client submission-id pattern ([A-Za-z0-9_-]): no player can pre-empt or replay the server's own move. */
      submissionId: `clock:expiry:${input.at}`,
      host: input.host,
      seated: true,
      undoPolicy: { host_undo: input.hostUndo },
    });
  let answer: ReturnType<RoomSession["submit"]>;
  try {
    answer = stampAt !== undefined ? stampAt(input.at, submit) : submit();
  } catch (error) {
    return { ok: false, why: describe(error) };
  }
  if (answer.kind !== "applied") return { ok: false, why: (answer as { reason?: string }).reason ?? answer.kind };
  const batch = session.entries.slice(start);
  if (batch.length === 0) return { ok: false, why: "nothing was appended" };
  const board = session.state;
  return { ok: true, batch, before, after: boardFactsOf(board), board };
}

const dealt = (state: GameStateResponse): boolean => Array.isArray(state.player_addresses) && state.player_addresses.length > 0;

/* ==================================================================
    THE CONTROLLER
   ================================================================== */

export function createClockController(deps: ClockControllerDeps) {
  const timers = deps.timers ?? REAL_CLOCK_TIMERS;
  const entries = new Map<string, Entry>();
  const counters = { loads: 0, breaks: 0, systemPauses: 0, overdues: 0, finalities: 0, tradeExpiries: 0, writes: 0, writeFailures: 0, remedyAttempts: 0, remedyRefused: 0, refusals: 0 };
  const now = () => deps.now();
  /** When this authority began serving: a restart's outage ends here for a table nobody opened since (Async). */
  const startedAt = deps.now();
  const name = (gameId: string, seat: string) => deps.nameOf?.(gameId, seat) ?? seat;
  let sweepHandle: unknown | null = null;
  /** Closed (the server is stopping): nothing more is written, armed or relayed by this controller. */
  let closed = false;

  function entryOf(gameId: string): Entry {
    let entry = entries.get(gameId);
    if (entry === undefined) {
      entry = {
        gameId,
        record: null,
        stored: null,
        checked: false,
        stale: true,
        unreadable: null,
        lost: false,
        writes: Promise.resolve(),
        loading: null,
        timer: null,
        timerDue: null,
        beat: null,
        pinned: false,
        pipeline: null,
        sealedRev: null,
        readFailed: null,
        pending: [],
        pendingEffects: [],
        retries: 0,
        retryAt: null,
        remedyRetryAt: 0,
        remedyBackoffMs: 0,
        provenAt: null,
      };
      entries.set(gameId, entry);
    }
    return entry;
  }

  /* ---- the store: one write chain per table, always writing the newest decided record ---- */

  function flush(entry: Entry): Promise<boolean> {
    const run = entry.writes.then(async (): Promise<boolean> => {
      if (entry.lost || closed) return false;
      const record = entry.record;
      if (record === null) return true;
      if (entry.stored === record.revision && record.authority === deps.authority) return true;
      const stamped = stampAuthority(record, deps.authority, now());
      let outcome: StoreWriteOutcome;
      try {
        outcome = await deps.store.save(stamped, entry.stored);
      } catch (error) {
        outcome = { kind: "uncertain", detail: describe(error) };
      }
      if (outcome.kind === "committed") {
        counters.writes += 1;
        entry.stored = stamped.revision;
        entry.provenAt = stamped.trusted_at;
        if (entry.record === record) entry.record = stamped;
        deliver(entry, stamped);
        return true;
      }
      counters.writeFailures += 1;
      entry.stale = true;
      deps.warn(`  clock: ${entry.gameId}: the clock write (revision ${stamped.revision}) did not land (${outcome.kind}: ${outcome.detail}); reread before the next decision`);
      deps.ops.audit("clock.write-failed", { game_id: entry.gameId, revision: stamped.revision, outcome: outcome.kind });
      return false;
    });
    entry.writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Read the stored record into the entry (a load, or a reread after a write that did not settle). False: the store did
   *  not answer (`readFailed`) or the record cannot be read (`unreadable`) -- nothing is fabricated in its place. */
  async function reread(entry: Entry): Promise<boolean> {
    let stored: GameClockRecord | null;
    try {
      stored = await deps.store.load(entry.gameId);
    } catch (error) {
      if (error instanceof ClockUnreadableError) {
        if (entry.unreadable === null) {
          deps.warn(`  clock: ${entry.gameId}: the stored clock cannot be read (${error.message}); it is left exactly as found`);
          deps.ops.audit("clock.unreadable", { game_id: entry.gameId, format: error.format });
        }
        entry.unreadable = error;
        return false;
      }
      if (entry.readFailed === null) deps.warn(`  clock: ${entry.gameId}: the stored clock could not be read (${describe(error)}); nothing is decided until it is`);
      entry.readFailed = describe(error).slice(0, 200);
      return false;
    }
    entry.unreadable = null;
    entry.readFailed = null;
    if (entry.record === null || stored === null) {
      if (entry.record !== null && stored === null && entry.stored !== null) {
        /* The store held a record and now holds none: someone removed it -- this process no longer decides the table. */
        markLost(entry, null, "the stored clock disappeared");
      } else {
        entry.record = stored;
        entry.stored = stored?.revision ?? null;
        entry.provenAt = stored?.trusted_at ?? null;
        entry.pending = [];
        entry.pendingEffects = [];
      }
    } else if (stored.revision === entry.stored) {
      /* Nothing landed since what this process last knew the store held: the decided record stands (the next flush
         writes it). */
    } else if (stored.authority === deps.authority && stored.revision <= entry.record.revision) {
      /* Our own write landed (or an earlier one did): the decided record stands; the next flush writes it. A read that
         raced a later write of ours never steps what is known stored backwards. */
      entry.stored = Math.max(entry.stored ?? -1, stored.revision);
      entry.provenAt = Math.max(entry.provenAt ?? 0, stored.trusted_at);
      if (stored.revision === entry.record.revision) deliver(entry, stored);
    } else {
      markLost(entry, stored, `the stored clock was written by another authority (${stored.authority})`);
    }
    entry.stale = false;
    return true;
  }

  /** Someone else wrote this table's clock while this process held it in memory: this process no longer decides it
   *  (moves are refused here; nothing it decided but did not store is reported or carried out). */
  function markLost(entry: Entry, stored: GameClockRecord | null, why: string): void {
    entry.lost = true;
    entry.record = stored;
    entry.stored = stored?.revision ?? null;
    entry.provenAt = stored?.trusted_at ?? null;
    entry.pending = [];
    entry.pendingEffects = [];
    /* Nothing of it is decided here any more: it keeps no table resident. */
    pinFor(entry, false);
    deps.warn(`  clock: ${entry.gameId}: ${why}; this process stops deciding it`);
    deps.ops.audit("clock.lost", { game_id: entry.gameId });
  }

  /** The record at `stored` is durable: report its evidence and carry out its effects. */
  function deliver(entry: Entry, stored: GameClockRecord): void {
    const seq = stored.evidence.seq;
    const ready = entry.pending.filter((p) => p.event.seq <= seq);
    entry.pending = entry.pending.filter((p) => p.event.seq > seq);
    for (const p of ready) report(entry.gameId, p.event, p.head);
    const effects = entry.pendingEffects.filter((p) => p.revision <= stored.revision);
    entry.pendingEffects = entry.pendingEffects.filter((p) => p.revision > stored.revision);
    for (const p of effects) carryOut(entry.gameId, p.effect);
  }

  /** The table's record as of now -- read, continuity-checked and brought in line with the committed log -- or `null`
   *  when the table has no clock it can use (undealt with no policy chosen, unreadable, lost). Inside a task. */
  async function ensure(game: GameActor, tx: Tx | null, checkMoney = false): Promise<GameClockRecord | null> {
    const entry = entryOf(game.gameId);
    if (entry.lost) return null;
    if (entry.stale || entry.record === null) {
      if (entry.loading === null) {
        entry.loading = reread(entry)
          .then(() => undefined)
          .finally(() => {
            entry.loading = null;
          });
      }
      await entry.loading;
      counters.loads += 1;
    }
    if (entry.unreadable !== null || entry.lost || entry.readFailed !== null) return null;
    const view = game.view;
    const state = (tx?.session ?? null)?.state ?? null;
    const isDealt = state !== null ? dealt(state) : view.entries.length > 0;
    const unfolded = entry.record !== null && entry.record.phase === "setup" && isDealt && state !== null && view.entries.length > 0;
    if ((entry.record === null || unfolded) && isDealt && view.record !== null && state !== null && view.entries.length > 0) {
      /* A table in play whose clock never saw the deal (dealt by an earlier build, or the deal's clock write never
         landed): begun now from the log, as if dealt at the newest entry (keeping a recorded deadline) -- and, being
         unproven, a continuity break like any other (Live: SYSTEM PAUSE before anyone moves). */
      const record = view.record;
      const mode = (record.variants as { mode?: string } | null)?.mode === "async" ? "async" : "live";
      const last = view.entries[view.entries.length - 1];
      const lastAt = stampOf(last) ?? now();
      const prior = entry.record;
      const created =
        prior !== null
          ? { ...prior, authority: `unknown:${game.gameId}`, trusted_at: Math.min(prior.trusted_at, lastAt) }
          : newClockRecord({ gameId: game.gameId, deadline: mode === "live" ? "live" : "no-deadline", paceSecs: null, money: record.money !== null, authority: `unknown:${game.gameId}`, now: lastAt });
      const facts = factsOfGame(game.gameId, state);
      const begun = foldBatch(created, { actor: "", first: last.index, last: last.index, at: lastAt, msg: "deal", revertTarget: null, before: facts, after: facts }, now());
      queue(entry, begun.events, begun.record);
      entry.record = { ...begun.record, authority: `unknown:${game.gameId}`, trusted_at: lastAt };
      entry.checked = false;
    } else if (entry.record === null) {
      return null;
    }
    let firstCheck = false;
    if (!entry.checked) {
      await checkContinuity(entry, game, state);
      entry.checked = true;
      firstCheck = true;
    } else if (entry.record !== null) {
      await checkStall(entry, game.gameId);
    }
    if (entry.record !== null && entry.record.phase !== "setup" && view.entries.length > 0) {
      const last = view.entries[view.entries.length - 1];
      if (last.index > entry.record.watermark && state !== null) {
        /* The log moved past the record (a fold that never ran -- this authority's own, or one found at the first
           check): recovered from the log itself. */
        applyStep(entry, recoverGap(entry.record, { now: now(), lastIndex: last.index, lastAt: stampOf(last) ?? now(), actors: actorsAfter(view.entries, entry.record.watermark), facts: factsOfGame(game.gameId, state) }), game.gameId);
      }
    }
    if ((firstCheck || checkMoney) && entry.record !== null && entry.record.money && deps.moneyTerminal !== undefined && entry.record.phase !== "ended" && entry.record.phase !== "setup") {
      const route = await deps.moneyTerminal(game.gameId).catch(() => null);
      if (route !== null && entry.record !== null) applyStep(entry, escrowEnded(entry.record, now(), route), game.gameId);
    }
    return entry.record;
  }

  async function checkContinuity(entry: Entry, game: GameActor, state: GameStateResponse | null): Promise<void> {
    let record = entry.record as GameClockRecord;
    if (record.authority === deps.authority) {
      /* This process's own record (an eviction and reload). A LIVE clock is pinned resident while it runs, so finding one
         reloaded means it was not (held, or a failure): its continuity is judged by the stall rule, never assumed. An
         Async table is evicted while idle by design -- the elapsed time was real (anyone could have loaded it and acted),
         so it is proven now and its due transitions are processed at their own moments. */
      if (record.policy.class === "live") {
        await checkStall(entry, game.gameId);
        return;
      }
      entry.record = heartbeat(record, deps.authority, now());
      /* Proven NOW by this process's own continuity (the stall rule measures from here, not from the unload). */
      entry.provenAt = entry.record.trusted_at;
      return;
    }
    const view = game.view;
    const last = view.entries.length > 0 ? view.entries[view.entries.length - 1] : null;
    const at = now();
    if (record.phase === "setup") {
      /* Nothing is timed before play: the record is simply adopted by this authority. */
      entry.record = stampAuthority(record, deps.authority, at);
      await flush(entry);
      return;
    }
    counters.breaks += 1;
    const lastAt = last === null ? null : stampOf(last);
    if (last !== null && last.index > record.watermark && state !== null) {
      const recovered = recoverGap(record, { now: at, lastIndex: last.index, lastAt: lastAt ?? record.trusted_at, actors: actorsAfter(view.entries, record.watermark), facts: factsOfGame(game.gameId, state) });
      queue(entry, recovered.events, recovered.record);
      for (const effect of recovered.effects) entry.pendingEffects.push({ effect, revision: recovered.record.revision });
      record = recovered.record;
    }
    const preservedAt = Math.max(record.trusted_at, lastAt ?? 0);
    const reason = `server continuity was not proven: this table was last served by another server process (last proven at ${new Date(record.trusted_at).toISOString()})`;
    const step = continuityBreak(record, { now: at, preservedAt, reason, authority: deps.authority, resumeFrom: startedAt });
    if (step.record.system !== null && record.system === null) counters.systemPauses += 1;
    deps.ops.audit("clock.continuity-break", { game_id: game.gameId, prior_authority: String(entry.record?.authority ?? "").slice(0, 80), preserved_at: preservedAt, system_pause: step.record.system !== null, deadline: record.policy.class });
    applyStep(entry, { ...step, record: step.record }, game.gameId, true);
    await flush(entry);
  }

  /** A running clock not proven continuous since its last proof (this process stalled): a continuity break as of that
   *  proof -- never a transition decided from time in which nobody could have acted. */
  async function checkStall(entry: Entry, gameId: string): Promise<void> {
    const record = entry.record;
    if (record === null || record.authority !== deps.authority) return;
    /* A frozen table runs no timer for good: there is no continuity to prove. */
    if (isFrozen(gameId)) return;
    /* (An Async overdue runs nothing: no timer, so no continuity to prove.) */
    const running = (record.phase === "active" || (record.phase === "overdue" && record.policy.class === "live")) && record.system === null && record.pause.paused_at === null && record.policy.class !== "no-deadline";
    if (!running) return;
    const limit = record.policy.class === "live" ? CLOCK_CONTINUITY_GAP_LIVE_MS : CLOCK_CONTINUITY_GAP_ASYNC_MS;
    const at = now();
    /* The last DURABLE proof: a heartbeat whose write did not land proves nothing (a store outage in which no move can
       be recorded is a continuity break like any other once it outlasts the limit). */
    const proof = Math.min(record.trusted_at, entry.provenAt ?? record.trusted_at);
    const gap = at - proof;
    if (gap <= limit) return;
    counters.breaks += 1;
    const reason = `server continuity was not proven: this server did not durably run the table's clock for ${Math.floor(gap / 1000)} s (last proven at ${new Date(proof).toISOString()})`;
    const step = continuityBreak(record, { now: at, preservedAt: proof, reason, authority: deps.authority });
    if (step.record.system !== null && record.system === null) counters.systemPauses += 1;
    deps.ops.audit("clock.continuity-break", { game_id: gameId, cause: "stall", gap_ms: gap, preserved_at: proof, system_pause: step.record.system !== null, deadline: record.policy.class });
    applyStep(entry, step, gameId, true);
    await flush(entry);
  }

  /** Install a step's record (never by an older record over a newer one); its evidence and effects wait for the record
   *  to be DURABLE (`deliver`). */
  function applyStep(entry: Entry, step: ClockStep, gameId: string, force = false): void {
    if (step.record === entry.record && !force) return;
    const current = entry.record;
    /* Revisions only ever rise (a store's CAS compares them): a step computed from an earlier record never reuses one. */
    entry.record = current !== null && step.record !== current && step.record.revision <= current.revision ? { ...step.record, revision: current.revision + 1 } : step.record;
    queue(entry, step.events, entry.record, current?.evidence.head ?? null);
    for (const effect of step.effects) {
      if (effect.kind === "remedy") entry.sealedRev = entry.record.revision;
      else entry.pendingEffects.push({ effect, revision: entry.record.revision });
    }
    void gameId;
  }

  /** Queue a step's events, each with the evidence head right AFTER it (a consumer can verify the chain event by
   *  event); when the step's base head is unknown, every event carries the step's final head. */
  function queue(entry: Entry, events: readonly ClockEvidenceEvent[], record: GameClockRecord, startHead: string | null = null): void {
    let heads: string[] | null = null;
    if (startHead !== null && events.length > 0) {
      let head = startHead;
      heads = [];
      for (const event of events) {
        head = nextHead(head, event);
        heads.push(head);
      }
      if (head !== record.evidence.head) heads = null;
    }
    events.forEach((event, i) => entry.pending.push({ event, head: heads?.[i] ?? record.evidence.head }));
    if (entry.pending.length > 4_096) entry.pending.splice(0, entry.pending.length - 4_096);
  }

  function report(gameId: string, event: ClockEvidenceEvent, head: string): void {
    if (event.kind === "overdue") counters.overdues += 1;
    if (event.kind === "final") counters.finalities += 1;
    deps.ops.audit(`clock.${event.kind}`, { game_id: gameId, seq: event.seq, at: event.at, ...flat(event.f) });
    try {
      deps.conduct?.({ game_id: gameId, event, head });
    } catch (error) {
      deps.warn(`  clock: the conduct hook threw for ${gameId} -- ${describe(error)}`);
    }
  }

  function carryOut(gameId: string, effect: ClockEffect): void {
    if (effect.kind === "fence-checkpoint") {
      try {
        deps.remedy?.()?.fence(gameId);
      } catch (error) {
        deps.warn(`  clock: ${gameId}: the fencing checkpoint could not be queued -- ${describe(error)}`);
      }
    }
  }

  /* ---- time ---- */

  function arm(entry: Entry): void {
    const record = entry.record;
    if (entry.timer !== null) timers.clear(entry.timer);
    entry.timer = null;
    entry.timerDue = null;
    if (entry.beat !== null) timers.clear(entry.beat);
    entry.beat = null;
    if (closed) return;
    /* What runs: an active obligation, or a Live overdue's cure window (an Async overdue runs nothing and is never kept
       resident for it). */
    const timed =
      record !== null &&
      !entry.lost &&
      (record.phase === "active" || (record.phase === "overdue" && record.policy.class === "live")) &&
      record.system === null &&
      record.pause.paused_at === null &&
      record.policy.class !== "no-deadline";
    if (timed && (isHeld(entry.gameId) || isFrozen(entry.gameId))) {
      /* HELD: nobody can move, so nothing advances and no continuity is proven; looked at again later. A Live table
         stays resident meanwhile (its held time is judged by the stall rule when the hold lifts). */
      pinFor(entry, true);
      entry.timer = timers.set(() => {
        entry.timer = null;
        if (!closed && !entry.lost && deps.serving(entry.gameId)) arm(entry);
      }, CLOCK_HELD_RECHECK_MS);
      return;
    }
    /* A running clock keeps its table resident (Live and Timed Async): its heartbeat keeps the continuity proof fresh,
       so a later restart credits only the real outage, and its due transitions fire on time. So does a SEALED remedy
       not yet final (or superseded) on chain: the sweep keeps carrying it on -- re-attested if its attestation expires,
       retried after a refusal -- without anyone opening the table (the owner's ruling: no player is needed). */
    pinFor(entry, timed || remedyUnfinished(record, entry));
    if (record === null || !timed) return;
    const due = nextDue(record);
    if (due !== null) {
      const at = Math.max(due, entry.retryAt ?? 0);
      entry.timerDue = at;
      entry.timer = timers.set(() => {
        entry.timer = null;
        void track(deps.runOn(entry.gameId, "clock", (game, tx) => tick(game, tx)))
          .then((ran) => {
            if (!ran) retryLater(entry, "the table's task could not run");
          })
          .catch((error) => {
            deps.warn(`  clock: ${entry.gameId}: a timed transition failed -- ${describe(error)}`);
            retryLater(entry, describe(error));
          });
      }, Math.min(MAX_TIMER_MS, Math.max(0, at - now())));
    }
    const every = record.policy.class === "live" ? CLOCK_HEARTBEAT_LIVE_MS : CLOCK_HEARTBEAT_ASYNC_MS;
    const beat = (): void => {
      entry.beat = null;
      if (entry.lost || entry.record === null || !deps.serving(entry.gameId)) return;
      /* The next proof is scheduled now (a slow write never stretches the cadence); a re-arm replaces it. */
      entry.beat = timers.set(beat, every);
      /* The continuity proof -- this authority is still in control, now -- written in the table's own task (never
         beside a transition), and only after the stall check: a heartbeat never papers over a gap. */
      void track(
        deps.runOn(entry.gameId, "clock-heartbeat", async (game, tx) => {
          if (entry.lost || entry.record === null || isHeld(game.gameId) || isFrozen(game.gameId)) return;
          const before = entry.record;
          const record = await ensure(game, tx);
          if (record === null) return;
          if (record.system !== null && before.system === null) {
            await settle(entry, entry.gameId);
            return;
          }
          /* A transition a lost timer never ran is carried here too (at its own moment). */
          await catchUp(entry, game, tx, now());
          const after = entry.record;
          if (after === null) return;
          if (after !== record) {
            await settle(entry, entry.gameId);
            return;
          }
          entry.record = heartbeat(after, deps.authority, now());
          await flush(entry);
        }),
      ).catch((error) => deps.warn(`  clock: ${entry.gameId}: the heartbeat failed -- ${describe(error)}`));
    };
    entry.beat = timers.set(beat, every);
  }

  /** A timed transition could not run (its task, or its write): try again, backing off, never sooner than due. */
  function retryLater(entry: Entry, why: string): void {
    if (closed || entry.lost) return;
    entry.retries = Math.min(entry.retries + 1, 16);
    const delay = Math.min(CLOCK_RETRY_MAX_MS, CLOCK_RETRY_MIN_MS * 2 ** (entry.retries - 1));
    entry.retryAt = now() + delay;
    if (entry.retries === 1 || entry.retries % 8 === 0) deps.warn(`  clock: ${entry.gameId}: a timed transition will be retried in ${delay} ms (${why.slice(0, 200)})`);
    arm(entry);
  }

  function isHeld(gameId: string): boolean {
    try {
      return deps.held?.(gameId) === true;
    } catch {
      return true;
    }
  }

  function isFrozen(gameId: string): boolean {
    try {
      return deps.frozen?.(gameId) === true;
    } catch {
      return true;
    }
  }

  /** Every clock task this controller started and has not seen finish (`idle`). */
  const inFlight = new Set<Promise<unknown>>();
  function track<T>(task: Promise<T>): Promise<T> {
    inFlight.add(task);
    void task.then(
      () => inFlight.delete(task),
      () => inFlight.delete(task),
    );
    return task;
  }

  function remedyUnfinished(record: GameClockRecord | null, entry: Entry): boolean {
    return record !== null && !entry.lost && record.remedy !== null && record.remedy.status !== "confirmed" && record.remedy.status !== "superseded";
  }

  function pinFor(entry: Entry, on: boolean): void {
    if (entry.pinned === on) return;
    entry.pinned = on;
    try {
      deps.pin?.(entry.gameId, on);
    } catch (error) {
      deps.warn(`  clock: ${entry.gameId}: pinning failed -- ${describe(error)}`);
    }
  }

  function positionOf(game: GameActor): () => { readonly len: number; readonly hash: string } {
    return () => {
      const entriesNow = game.view.entries;
      return { len: entriesNow.length, hash: logHash(entriesNow, entriesNow.length) };
    };
  }

  function factsOfGame(gameId: string, state: GameStateResponse): ClockBoardFacts {
    return boardFactsOf(state, deps.boardEnd?.(gameId, state) ?? null);
  }

  /** Every transition due by now, at its own moment; a train offer's expiry closes the offer in the log first. Returns
   *  whether an expiry was committed in this task (the caller then does not use `tx.session` again). */
  async function catchUp(entry: Entry, game: GameActor, tx: Tx, at: number): Promise<boolean> {
    let expired = false;
    for (let round = 0; round < 4; round += 1) {
      const record = entry.record;
      if (record === null) return expired;
      const step = advance(record, at, positionOf(game));
      applyStep(entry, step, game.gameId);
      if (step.tradeExpiry === null) break;
      /* A close that failed is retried only after its backoff (a submit meanwhile is judged on the record as it is). */
      if (entry.retryAt !== null && at < entry.retryAt) break;
      const due = step.tradeExpiry;
      counters.tradeExpiries += 1;
      const closed = await deps.closeOffer(game, tx, { proposer: due.proposer, at: due.at, offerKey: due.offerKey });
      if (closed.ok || closed.kind === "store") expired = true;
      if (!closed.ok && closed.kind === "store") {
        /* The expiry could not be committed: nothing changed in the log; the clock stays as it was and the expiry is
           retried (no move is taken meanwhile: the submit that found it is refused). */
        deps.warn(`  clock: ${game.gameId}: an expired train offer could not be committed (${closed.why}); retried`);
        retryLater(entry, closed.why);
        break;
      }
      if (!closed.ok) {
        /* The offer is not standing after all (the record and the board disagree): re-derived from the board -- and the
           next attempt backs off (a board that still shows the offer must not spin the timer). */
        deps.warn(`  clock: ${game.gameId}: an expired train offer could not be closed (${closed.why}); the clock is re-derived from the board`);
        retryLater(entry, closed.why);
        const view = game.view;
        const last = view.entries[view.entries.length - 1];
        if (last !== undefined && entry.record !== null) {
          applyStep(entry, recoverGap({ ...entry.record, watermark: Math.min(entry.record.watermark, last.index - 1) }, { now: now(), lastIndex: last.index, lastAt: due.at, actors: [], facts: factsOfGame(game.gameId, tx.session.state) }), game.gameId);
        }
        break;
      }
      const batch: ClockBatch = { actor: due.proposer, first: closed.first, last: closed.last, at: due.at, msg: "server-expiry", revertTarget: null, before: closed.before, after: closed.after };
      applyStep(entry, foldBatch(entry.record as GameClockRecord, batch, now()), game.gameId);
      entry.retries = 0;
      entry.retryAt = null;
    }
    return expired;
  }

  /** A timer fired: process what is due, write, re-arm, re-broadcast. */
  async function tick(game: GameActor, tx: Tx): Promise<void> {
    const entry = entryOf(game.gameId);
    if (isHeld(game.gameId) || isFrozen(game.gameId)) {
      arm(entry);
      return;
    }
    const record = await ensure(game, tx);
    if (record === null) {
      if (entry.readFailed !== null) retryLater(entry, entry.readFailed);
      return;
    }
    const retryBefore = entry.retryAt;
    await catchUp(entry, game, tx, now());
    const written = await settle(entry, game.gameId);
    if (!written) retryLater(entry, "the clock write did not land");
    else if (entry.retryAt === retryBefore && entry.retryAt !== null) {
      /* This attempt went through (no new retry was asked for): the backoff starts over. */
      entry.retries = 0;
      entry.retryAt = null;
      arm(entry);
    }
  }

  /** Write, re-arm, re-broadcast, and carry a sealed money remedy on. False: the write did not land (the decided record
   *  is kept and written by the next attempt; nothing of it was reported or carried out). */
  async function settle(entry: Entry, gameId: string): Promise<boolean> {
    const written = await flush(entry);
    arm(entry);
    deps.onChange(gameId);
    if (written && entry.record?.remedy !== null && entry.record?.remedy !== undefined) void driveRemedy(gameId);
    return written;
  }

  /* ---- the submit gate and the fold ---- */

  async function gateSubmit(game: GameActor, tx: Tx, input: { readonly actor: string; readonly msg: unknown }): Promise<GateResult | { readonly ok: false; readonly code: string; readonly reason: string }> {
    const entry = entryOf(game.gameId);
    const record = await ensure(game, tx);
    const cls = classifyMessage(input.msg);
    if (record === null) {
      /* No clock to judge by. A store that did not answer, or a clock another server now decides: no move is taken
         here (a move would be judged without its clock). An unreadable clock refuses a money table's moves (its
         remedies depend on it); a free table plays on untimed. */
      const money = game.view.record?.money !== null && game.view.record?.money !== undefined;
      if (entry.readFailed !== null || entry.lost || (entry.unreadable !== null && money)) {
        return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "This table's clock is not available on the server right now, so no move can be taken." };
      }
      return { ok: true, now: now(), before: null, cls: cls.cls, revertTarget: cls.revertTarget };
    }
    /* ONE instant judges this move: every transition due by it is processed, the gate asks at it, and the move's
       entries are stamped with it -- a cure and a finality are ordered exactly as they happened. */
    const at = Math.max(now(), record.updated_at);
    const expired = await catchUp(entry, game, tx, at);
    if (expired) {
      await settle(entry, game.gameId);
      counters.refusals += 1;
      return { ok: false, code: CLOCK_REFUSAL.stale, reason: "The offer expired unanswered. Check the board and try again." };
    }
    const current = entry.record as GameClockRecord;
    const state = tx.session.state;
    let trainRecipient: string | null = null;
    const body = typeof input.msg === "object" && input.msg !== null ? (input.msg as Record<string, unknown>).ProposeTrainPurchase : undefined;
    if (typeof body === "object" && body !== null && typeof (body as { seller_protocol_id?: unknown }).seller_protocol_id === "number") {
      trainRecipient = sellerPresident(state, (body as { seller_protocol_id: number }).seller_protocol_id);
    }
    const refusal = gate(current, { actor: input.actor, msg: cls.cls, closeRoom: cls.closeRoom, revertTarget: cls.revertTarget, trainRecipient, nameOf: (seat) => name(game.gameId, seat) });
    /* A move is judged only against a STORED clock: an overdue (a strike) decided but not yet durable must not be cured
       -- or played past -- by a move a crash could then separate from it. */
    const durable = entry.stored === current.revision ? true : await settle(entry, game.gameId);
    if (refusal !== null) {
      counters.refusals += 1;
      return { ok: false, code: refusal.code, reason: refusal.reason };
    }
    if (!durable && !cls.closeRoom) {
      counters.refusals += 1;
      return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "The server could not record the game clock just now, so no move was taken. Try again in a moment." };
    }
    return { ok: true, now: at, before: factsOfGame(game.gameId, state), cls: cls.cls, revertTarget: cls.revertTarget };
  }

  /** After a PROPOSAL was speculated (before it is committed): a LIVE qualifying offer -- one that parks the proposer's
   *  own running action clock and hands the answer to another seat (the board names both), and any Live train offer
   *  (the owner's train rule) -- may not follow two declines in its direction this Operating Round. Async keeps no
   *  decline limit; an offer that suspends nothing of the proposer's (an off-turn or a self-addressed one) is not
   *  counted or blocked. */
  function offerBlocked(game: GameActor, input: { readonly actor: string; readonly board: GameStateResponse }): { readonly code: string; readonly reason: string } | null {
    const record = entries.get(game.gameId)?.record ?? null;
    if (record === null || record.phase === "setup" || record.phase === "ended" || record.policy.class !== "live") return null;
    const facts = factsOfGame(game.gameId, input.board);
    const offer = facts.offer;
    if (offer === null || offer.proposer !== input.actor || offer.answerer === null || offer.answerer === offer.proposer) return null;
    if (facts.decision?.seat !== offer.answerer) return null;
    const holder = record.obligation;
    const suspends = holder !== null && holder.seat === offer.proposer && holder.timer !== null;
    if (!suspends && offer.slot !== "train") return null;
    const orKey = operatingRoundKeyOf(input.board);
    if (record.declines.or_key !== orKey) return null;
    const count = record.declines.counts[declineKey(offer.proposer, offer.answerer)] ?? 0;
    if (count < LIVE_DECLINES_PER_OR) return null;
    const who = name(game.gameId, offer.answerer);
    counters.refusals += 1;
    return { code: CLOCK_REFUSAL.declines, reason: offer.slot === "train" ? declinesReachedSentence(who) : `${who} has declined two offers from you this operating round.` };
  }

  /** After a committed batch (in the same task): fold it and write the record before the task ends. */
  async function afterCommit(game: GameActor, input: { readonly gate: GateResult; readonly actor: string; readonly batch: readonly ServerLogEntry[]; readonly board: GameStateResponse; readonly applied?: boolean }): Promise<void> {
    const entry = entryOf(game.gameId);
    if (entry.record === null || entry.lost || entry.unreadable !== null || input.batch.length === 0) {
      if (entry.record === null && input.gate.cls === "deal") await afterDeal(game, input);
      return;
    }
    if (input.gate.cls === "deal") return afterDeal(game, input);
    const before = input.gate.before ?? factsOfGame(game.gameId, input.board);
    /* A submit that was REFUSED but committed repair entries (a crash's interrupted burst) is the server's, not the
       submitter's: it neither cures nor refreshes anyone's clock. The batch is keyed by its own move (the first entry
       a player made), so an undo of that move finds its snapshot. */
    const applied = input.applied !== false;
    const own = input.batch.find((entry) => entry.derived !== true) ?? input.batch[0];
    const batch: ClockBatch = {
      actor: applied ? input.actor : "",
      first: applied ? own.index : input.batch[0].index,
      last: input.batch[input.batch.length - 1].index,
      at: stampOf(input.batch[0]) ?? input.gate.now,
      msg: applied ? input.gate.cls : "optional",
      revertTarget: applied ? input.gate.revertTarget : null,
      before,
      after: factsOfGame(game.gameId, input.board),
    };
    applyStep(entry, foldBatch(entry.record, batch, now()), game.gameId);
    await settle(entry, game.gameId);
  }

  /** The deal: the table's clock begins (its deadline fixed now). A money table's first obligation never starts before
   *  the chain's Start (the escrow's overdue floor). */
  async function afterDeal(game: GameActor, input: { readonly gate: GateResult; readonly actor: string; readonly batch: readonly ServerLogEntry[]; readonly board: GameStateResponse }): Promise<void> {
    const entry = entryOf(game.gameId);
    if (entry.record === null && entry.unreadable === null && !entry.lost) {
      /* A record that could not be READ is never replaced by a fresh one: the next ensure begins it from the log. */
      if (entry.stale && !(await reread(entry))) return;
      if (entry.record === null && entry.unreadable === null && !entry.lost) {
        const record = game.view.record;
        const mode = (record?.variants as { mode?: string } | null | undefined)?.mode === "async" ? "async" : "live";
        entry.record = newClockRecord({ gameId: game.gameId, deadline: mode === "live" ? "live" : "no-deadline", paceSecs: null, money: record?.money !== null && record?.money !== undefined, authority: deps.authority, now: now() });
      }
    }
    if (entry.record === null || entry.unreadable !== null || entry.lost || input.batch.length === 0) return;
    entry.checked = true;
    let at = stampOf(input.batch[0]) ?? input.gate.now;
    if (entry.record.money && deps.moneyStartedAtSecs !== undefined) {
      const started = await deps.moneyStartedAtSecs(game.gameId).catch(() => null);
      if (started !== null && Number.isSafeInteger(started) && started * 1000 > at) at = started * 1000;
    }
    const facts = factsOfGame(game.gameId, input.board);
    const batch: ClockBatch = { actor: input.actor, first: input.batch[0].index, last: input.batch[input.batch.length - 1].index, at, msg: "deal", revertTarget: null, before: facts, after: facts };
    applyStep(entry, foldBatch(entry.record, batch, now()), game.gameId);
    await settle(entry, game.gameId);
  }

  /* ---- room ops ---- */

  async function op(game: GameActor, tx: Tx, input: ClockOpInput): Promise<ClockAnswer> {
    const entry = entryOf(game.gameId);
    const seat = input.seat;
    if (input.type === "clock-policy") {
      /* Before play the record may not exist yet: the host's first choice creates it. */
      if (game.view.entries.length > 0) return { ok: false, code: "wrong-state", reason: "The table's deadline is fixed once play begins." };
      if (entry.record === null && entry.unreadable === null && !entry.lost) {
        if (!(await reread(entry))) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "This table's clock is not available right now." };
        if (entry.record === null && entry.unreadable === null && !entry.lost) {
          const rec = game.view.record;
          entry.record = newClockRecord({ gameId: game.gameId, deadline: input.deadline, paceSecs: input.paceSecs, money: rec?.money !== null && rec?.money !== undefined, authority: deps.authority, now: now() });
          entry.checked = true;
          return (await settle(entry, game.gameId)) ? { ok: true } : NOT_RECORDED;
        }
      }
      if (entry.record === null) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "This table's clock is not available right now." };
      if (entry.record.money) return { ok: false, code: "wrong-state", reason: "A money table's deadline is fixed when the table is created." };
      return finish(entry, game.gameId, choosePolicy(entry.record, input.deadline, input.paceSecs, now()));
    }
    if (isHeld(game.gameId)) return { ok: false, code: "wrong-state", reason: "This table is held; its clock cannot change now." };
    const record = await ensure(game, tx);
    if (record === null) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "This table's clock is not available right now." };
    const at = Math.max(now(), record.updated_at);
    /* A frozen table's timers do not run (nobody can make the owed move): its ops act on the clock as it stands. */
    if (input.type !== "clock-ack" && !isFrozen(game.gameId)) {
      const expired = await catchUp(entry, game, tx, at);
      if (expired) await settle(entry, game.gameId);
    }
    const current = entry.record as GameClockRecord;
    switch (input.type) {
      case "clock-ack":
        return finish(entry, game.gameId, acknowledge(current, seat, at, game.view.record?.seats?.map((s) => s.player_id) ?? []));
      case "clock-pause":
        return finish(entry, game.gameId, pauseOp(current, seat, { action: input.action, kind: input.kind, id: input.id }, at));
      case "clock-sysresume":
        return finish(entry, game.gameId, systemResumeVote(current, seat, at, input.since));
      case "clock-annul":
        return finish(entry, game.gameId, annulVote(current, seat, input.yes, at));
      case "clock-propose":
      case "clock-vote": {
        const od = current.overdue;
        /* The approval was verified outside the task against THESE overdue facts (and, for a vote, THIS proposal); they
           must still be the ones standing. */
        const v = input.verifiedFor;
        if (v !== null && (od === null || od.epoch !== v.epoch || od.log_len !== v.logLen || (input.type === "clock-vote" && (od.proposal === null || od.proposal.id !== v.proposalId || od.proposal.kind !== v.kind)))) {
          return { ok: false, code: CLOCK_REFUSAL.stale, reason: "The overdue changed while your approval was checked. Look again." };
        }
        const step =
          input.type === "clock-propose"
            ? propose(current, seat, input.kind, input.approval, at, input.stale)
            : vote(current, seat, input.proposalId, input.yes, input.approval, at, { kind: v?.kind ?? null, stale: input.stale, renew: input.renew === true });
        return finish(entry, game.gameId, step);
      }
      default:
        return { ok: false, code: "bad-frame", reason: "That is not a clock operation." };
    }
  }

  async function finish(entry: Entry, gameId: string, step: ClockStep | ClockRefusal): Promise<ClockAnswer> {
    if ("code" in step) return { ok: false, code: step.code, reason: step.reason };
    applyStep(entry, step, gameId);
    if (step.events.length === 0 && step.record.revision === entry.stored) return { ok: true };
    return (await settle(entry, gameId)) ? { ok: true } : NOT_RECORDED;
  }

  /* ---- money remedies ---- */

  /** Carry the sealed remedy on (serialized per table): the SAME sealed decision, revalidated by the pipeline at every
   *  attempt (the sealed evidence, the FP4 intents, the REMEDY key, the contract's state, the approvals' horizons, the
   *  attestation's expiry -- an expired attestation of the decision is attested again, never changed). A sealed remedy
   *  belongs to an ENDED game: no SYSTEM PAUSE and no player vote gates it (the owner's ruling, policy correction
   *  2026-10-06). Never from a lost authority, a seal not yet durable, a held table, or a server with no pipeline. */
  function driveRemedy(gameId: string): Promise<void> {
    const entry = entries.get(gameId);
    if (entry === undefined) return Promise.resolve();
    if (entry.pipeline !== null) return entry.pipeline;
    const run = (async () => {
      const first = entry.record;
      if (closed || first === null || first.remedy === null || entry.lost) return;
      if (first.remedy.status === "confirmed" || first.remedy.status === "superseded") return;
      if (isHeld(gameId)) return;
      /* A refused (or fenced) remedy is asked again only after its backoff, whoever asks. */
      if (now() < entry.remedyRetryAt) return;
      /* FENCE AND OWNERSHIP, revalidated against the STORE at every attempt (a restart, a takeover, a retry): the record
         this process decided is durable under ITS authority, and no other authority wrote since -- a process another one
         took over stops here, signing and writing nothing. */
      if (entry.stale && !(await reread(entry))) return;
      if (entry.lost) return;
      /* Only a table whose continuity this process judged (its load, in the table's task) is carried on here; one only
         read for a view is loaded first. */
      if (!entry.checked) {
        kickLoad(gameId);
        return;
      }
      if (entry.record !== null && (entry.stored === null || entry.stored < entry.record.revision || entry.record.authority !== deps.authority)) {
        if (!(await flush(entry))) return;
      }
      if (!(await reread(entry)) || entry.lost) return;
      const record = entry.record as GameClockRecord | null;
      const remedy = record?.remedy ?? null;
      if (record === null || remedy === null || record.authority !== deps.authority || entry.stored !== record.revision) return;
      if (remedy.status === "confirmed" || remedy.status === "superseded") return;
      const port = deps.remedy?.() ?? null;
      counters.remedyAttempts += 1;
      let attempt: Awaited<ReturnType<RemedyPort["attest"]>>;
      if (port === null) attempt = { status: "refused", detail: "this server has no remedy pipeline (no Juno backend): the remedy is not attested", attested: false };
      else {
        try {
          attempt = await port.attest(gameId, remedy);
        } catch (error) {
          attempt = { status: remedy.status, detail: `the remedy attempt failed (${describe(error)}); retried`, attested: false };
        }
      }
      /* A standing refusal (an unlandable decision included), or an attestation the FP4 fence holds back, is asked again
         only after a backoff (doubling): a refusal is a standing condition, not a blip. */
      const stuck = attempt.status === "refused" || (!attempt.attested && (attempt.status === "sealed" || attempt.status === "submitted") && attempt.detail !== null);
      if (attempt.status === "refused") counters.remedyRefused += 1;
      if (stuck) {
        entry.remedyBackoffMs = Math.min(CLOCK_REMEDY_BACKOFF_MAX_MS, Math.max(CLOCK_REMEDY_BACKOFF_MIN_MS, entry.remedyBackoffMs * 2));
        entry.remedyRetryAt = now() + entry.remedyBackoffMs;
      } else {
        entry.remedyBackoffMs = 0;
        entry.remedyRetryAt = 0;
      }
      const latest = entry.record;
      if (latest === null || latest.remedy === null || latest.remedy.kind !== remedy.kind || latest.remedy.epoch !== remedy.epoch || latest.remedy.evidence_hash !== remedy.evidence_hash) return;
      const step =
        attempt.unlandable !== undefined && attempt.unlandable.length > 0
          ? remedyBlocked(latest, attempt.unlandable, attempt.detail ?? "the sealed decision's approvals can no longer land: owner decision required", now())
          : remedyProgress(latest, attempt.status, attempt.detail, now(), attempt.attested);
      applyStep(entry, step, gameId);
      await flush(entry);
      /* A remedy now final (or superseded) on chain no longer keeps its table resident. */
      arm(entry);
      deps.onChange(gameId);
    })()
      .catch((error) => deps.warn(`  clock: ${gameId}: the remedy pipeline failed -- ${describe(error)}`))
      .finally(() => {
        entry.pipeline = null;
      });
    entry.pipeline = run;
    return run;
  }

  const kicked = new Map<string, number>();
  function kickLoad(gameId: string): void {
    const last = kicked.get(gameId) ?? -Infinity;
    if (closed || now() - last < CLOCK_REMEDY_SWEEP_MS) return;
    kicked.set(gameId, now());
    if (kicked.size > 4_096) kicked.delete(kicked.keys().next().value as string);
    loadedTask(gameId);
  }

  /** The relayer's question before a new attempt of a remedy intent (`EscrowServiceDeps.remedyGate`). */
  async function remedyGate(gameId: string, intent: ChainIntentRecord): Promise<{ readonly kind: "ok" } | { readonly kind: "wait"; readonly why: string }> {
    if (intent.op.kind !== "remedy") return { kind: "wait", why: "not a remedy intent" };
    const entry = entries.get(gameId);
    /* Judged on the DURABLE record, read now (never a cached one): what is relayed is only what is stored, under this
       process's authority. */
    let record: GameClockRecord | null;
    try {
      record = await deps.store.load(gameId);
    } catch (error) {
      return { kind: "wait", why: `the table's clock cannot be read (${describe(error)})` };
    }
    if (record === null || record.remedy === null) return { kind: "wait", why: "the table's clock has sealed no remedy" };
    const r = record.remedy;
    /* The intent must carry exactly the sealed decision (its evidence hash included), and the sealed decision must be
       exactly what its evidence proves -- revalidated at every attempt, after a restart as before it. */
    if (!intentCarriesDecision(intent, r)) return { kind: "wait", why: "the intent is not the table's sealed remedy decision" };
    const sealedProblem = sealedRemedyProblem(gameId, r);
    if (sealedProblem !== null) return { kind: "wait", why: sealedProblem };
    /* A sealed remedy belongs to an ENDED game: a system pause (of a game still playable) never gates it. */
    if (record.phase !== "ended") return { kind: "wait", why: "the table's game has not ended: no remedy is relayed" };
    if (record.authority !== deps.authority) {
      /* After a restart the table may not be open here yet (or its adoption not yet stored): open it, so the sealed
         remedy is carried on without waiting for a player. */
      if (entry === undefined || entry.record === null || !entry.lost) kickLoad(gameId);
      return { kind: "wait", why: "this server is not the table clock's current authority" };
    }
    if (entry?.lost === true) return { kind: "wait", why: "this server no longer decides the table's clock" };
    if (isHeld(gameId)) return { kind: "wait", why: "the table is held" };
    const port = deps.remedy?.() ?? null;
    if (port === null) return { kind: "wait", why: "this server has no remedy pipeline" };
    let annulling: boolean;
    try {
      annulling = await port.annulOpen(gameId);
    } catch (error) {
      return { kind: "wait", why: `whether an annulment is open could not be read (${describe(error)})` };
    }
    if (annulling) return { kind: "wait", why: "a unanimous annulment of this game is open: it supersedes the remedy" };
    return { kind: "ok" };
  }

  /* ---- the periodic sweep: remedies to carry on, entries no longer served ---- */

  function startSweep(): void {
    if (sweepHandle !== null) return;
    const loop = () => {
      sweepHandle = timers.set(() => {
        for (const [gameId, entry] of [...entries]) {
          if (!deps.serving(gameId) && entry.pipeline === null) {
            drop(gameId);
            continue;
          }
          const remedy = entry.record?.remedy ?? null;
          if (remedy !== null && remedy.status === "refused" && now() < entry.remedyRetryAt) continue;
          if (remedy !== null && (remedy.status === "sealed" || remedy.status === "submitted" || remedy.status === "refused")) {
            void (async () => {
              const port = deps.remedy?.() ?? null;
              if (remedy.status === "submitted" && port !== null) {
                const where = await port.progress(gameId, remedy).catch(() => "open" as const);
                if (where === "open") return;
                if (where === "confirmed") {
                  const latest = entry.record;
                  if (latest !== null) applyStep(entry, remedyProgress(latest, "confirmed", null, now()), gameId);
                  await flush(entry);
                  arm(entry);
                  deps.onChange(gameId);
                  return;
                }
              }
              await driveRemedy(gameId);
            })().catch((error) => deps.warn(`  clock: ${gameId}: the remedy sweep failed -- ${describe(error)}`));
          }
        }
        loop();
      }, CLOCK_REMEDY_SWEEP_MS);
    };
    loop();
  }

  function drop(gameId: string): void {
    const entry = entries.get(gameId);
    if (entry === undefined) return;
    if (entry.timer !== null) timers.clear(entry.timer);
    if (entry.beat !== null) timers.clear(entry.beat);
    pinFor(entry, false);
    entries.delete(gameId);
  }

  /** The projection for a RoomView (`null`: no clock to show yet). Starts a background read for a table not loaded. */
  function viewOf(gameId: string): RoomClockView | null {
    const entry = entries.get(gameId);
    if (entry === undefined || entry.record === null) {
      if (entry === undefined || (entry.loading === null && entry.unreadable === null && !entry.lost && entry.stale)) {
        const fresh = entryOf(gameId);
        fresh.loading = reread(fresh)
          .then(() => deps.onChange(gameId))
          .catch(() => undefined)
          .finally(() => {
            fresh.loading = null;
          });
      }
      return null;
    }
    return clockViewOf(entry.record, now());
  }

  /** An actor loaded (a first open, a restart, a reload): the clock is read and its continuity judged NOW, so a
   *  system pause is in force (and shown) before anyone moves. */
  function loadedTask(gameId: string): void {
      void track(deps.runOn(gameId, "clock-load", async (game, tx) => {
        const entry = entryOf(gameId);
        /* A (re)loaded actor is a new object: a timed table's residency pin is taken again on it. */
        entry.pinned = false;
        const record = await ensure(game, tx, true);
        if (record === null) return;
        if (!isHeld(gameId) && !isFrozen(gameId)) await catchUp(entry, game, tx, now());
        await settle(entry, gameId);
      })).catch((error) => deps.warn(`  clock: ${gameId}: the clock load failed -- ${describe(error)}`));
  }

  return {
    counters,
    gateSubmit,
    offerBlocked,
    afterCommit,
    op,
    tick,
    remedyGate,
    driveRemedy,
    viewOf,
    /** The record as the controller holds it (tests, the operator's view). */
    recordOf: (gameId: string): GameClockRecord | null => entries.get(gameId)?.record ?? null,
    /** The table's deadline class as recorded (the money layer binds an async chain game to it). */
    async deadlineOf(gameId: string): Promise<{ readonly deadline: ClockDeadlineClass; readonly paceSecs: number | null } | null> {
      const entry = entries.get(gameId);
      let record = entry?.record ?? null;
      if (record === null) record = await deps.store.load(gameId).catch(() => null);
      return record === null ? null : { deadline: record.policy.class, paceSecs: record.policy.pace_secs };
    },
    /** A table's deadline at its creation (a money table's is fixed then, before any CreateGame is built from it). A
     *  No-deadline money table's host acknowledgement (`ackSeat`) is recorded with it, before the host's ante. */
    async createPolicy(gameId: string, input: { readonly deadline: ClockDeadlineClass; readonly paceSecs: number | null; readonly money: boolean; readonly ackSeat?: string | null }): Promise<ClockAnswer> {
      const { deadline, paceSecs, money } = input;
      const entry = entryOf(gameId);
      if (entry.stale) await reread(entry).catch(() => undefined);
      if (entry.unreadable !== null || entry.lost) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "The table's deadline could not be recorded. Try again." };
      if (entry.record !== null) {
        return entry.record.policy.class === deadline && entry.record.policy.pace_secs === (deadline === "async-pace" ? paceSecs : null) && entry.record.money === money ? { ok: true } : { ok: false, code: "wrong-state", reason: "This table's deadline is already fixed." };
      }
      let record: GameClockRecord;
      try {
        record = newClockRecord({ gameId, deadline, paceSecs, money, authority: deps.authority, now: now() });
      } catch (error) {
        return { ok: false, code: "bad-frame", reason: describe(error) };
      }
      if (deadline === "no-deadline" && typeof input.ackSeat === "string" && input.ackSeat !== "") {
        const acked = acknowledge(record, input.ackSeat, now());
        if (!("code" in acked)) record = acked.record;
      }
      entry.record = record;
      entry.checked = true;
      const ok = await flush(entry);
      return ok ? { ok: true } : { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "The table's deadline could not be recorded. Try again." };
    },
    async createMoneyPolicy(gameId: string, deadline: ClockDeadlineClass, paceSecs: number | null): Promise<ClockAnswer> {
      return this.createPolicy(gameId, { deadline, paceSecs, money: true });
    },
    /** Whether a seat may ante at this table as far as the No-deadline disclosure goes: `not-required` (the table has a
     *  deadline), `acknowledged`, `missing`, or `unknown` (its clock cannot be read: refuse). */
    async ackStatus(gameId: string, seat: string): Promise<"not-required" | "acknowledged" | "missing" | "unknown" | "unenforceable"> {
      const entry = entries.get(gameId);
      let record = entry !== undefined && !entry.stale ? entry.record : null;
      if (record === null) {
        try {
          record = await deps.store.load(gameId);
        } catch {
          return "unknown";
        }
      }
      if (record === null) return "unknown";
      /* A TIMED money table whose deadline this server cannot enforce now (no REMEDY signer): no deposit is approved. */
      if (record.money && record.policy.class !== "no-deadline") {
        const port = deps.remedy?.() ?? null;
        if (port === null || !port.configured) return "unenforceable";
      }
      if (record.policy.class !== "no-deadline") return "not-required";
      return record.acks[seat] !== undefined ? "acknowledged" : "missing";
    },
    /** An actor loaded (a first open, a restart, a reload): the clock is read and its continuity judged NOW, so a
     *  system pause is in force (and shown) before anyone moves. */
    loaded(gameId: string): void {
      loadedTask(gameId);
    },
    /** A money table's financial record changed: re-check its escrow's end in the table's task. */
    moneyChanged(gameId: string): void {
      /* A money change (a remedy intent resolved -- an expired attestation mooted, say) for a table not open here: open
         it, so a sealed remedy is carried on (rate-limited per table). */
      if (!entries.has(gameId)) {
        void deps.store
          .load(gameId)
          .then((stored) => {
            if (stored !== null && stored.remedy !== null && stored.remedy.status !== "confirmed" && stored.remedy.status !== "superseded") kickLoad(gameId);
          })
          .catch(() => undefined);
        return;
      }
      void track(deps.runOn(gameId, "clock-money", async (game, tx) => {
        const entry = entryOf(gameId);
        const record = await ensure(game, tx, true);
        if (record !== null) await settle(entry, gameId);
      })).catch(() => undefined);
    },
    /** Every clock task this controller started (timers, heartbeats, loads) has finished, and every write settled
     *  (tests: controlled time waits for this before moving on). */
    async idle(): Promise<void> {
      for (let round = 0; round < 64 && inFlight.size > 0; round += 1) await Promise.allSettled([...inFlight]);
      for (const entry of entries.values()) {
        await entry.writes;
        if (entry.pipeline !== null) await entry.pipeline.catch(() => undefined);
      }
    },
    /** Settled writes and remedy passes (tests). */
    async settled(gameId: string): Promise<void> {
      const entry = entries.get(gameId);
      if (entry === undefined) return;
      await entry.writes;
      if (entry.pipeline !== null) await entry.pipeline;
      await entry.writes;
    },
    startSweep,
    drop,
    close(): void {
      closed = true;
      if (sweepHandle !== null) timers.clear(sweepHandle);
      sweepHandle = null;
      for (const gameId of [...entries.keys()]) drop(gameId);
    },
    size: () => entries.size,
    /** The Live cure window, for tests and tools. */
    cureMs: LIVE_CURE_MS,
  };
}

export type ClockController = ReturnType<typeof createClockController>;

export type ClockOpInput =
  | { readonly type: "clock-policy"; readonly seat: string; readonly deadline: ClockDeadlineClass; readonly paceSecs: number | null }
  | { readonly type: "clock-ack"; readonly seat: string }
  | { readonly type: "clock-pause"; readonly seat: string; readonly action: "request" | "yes" | "no"; readonly kind: "pause" | "resume"; readonly id: number | null }
  | { readonly type: "clock-sysresume"; readonly seat: string; readonly since: number | null }
  | { readonly type: "clock-annul"; readonly seat: string; readonly yes: boolean }
  | {
      readonly type: "clock-propose";
      readonly seat: string;
      readonly kind: "foreclose" | "annul";
      readonly approval: ClockVote["approval"];
      readonly verifiedFor: ClockVerifiedFor | null;
      /** Money: the seats whose standing YES approvals no longer verify under their CURRENT consent key. */
      readonly stale: readonly string[];
    }
  | {
      readonly type: "clock-vote";
      readonly seat: string;
      readonly proposalId: number;
      readonly yes: boolean;
      readonly approval: ClockVote["approval"];
      readonly verifiedFor: ClockVerifiedFor | null;
      readonly stale: readonly string[];
      /** Money: this seat's own standing YES no longer verifies (its consent key moved): the new approval replaces it. */
      readonly renew?: boolean;
    };

/** The overdue (and, for a vote, the proposal) a money approval was verified against, outside the task. */
export interface ClockVerifiedFor {
  readonly epoch: number;
  readonly logLen: number;
  readonly proposalId: number | null;
  readonly kind: "foreclose" | "annul";
}

/* ---- helpers ---- */

function stampOf(entry: ServerLogEntry | undefined): number | null {
  return entry !== undefined && typeof entry.at === "number" && Number.isSafeInteger(entry.at) && entry.at >= 0 ? entry.at : null;
}

/** The seats whose entries past `watermark` were REQUIRED actions (a move or an answer -- never an offer, a rescission or
 *  a private's optional power): who acted in a gap the record never folded. */
function actorsAfter(entries: readonly ServerLogEntry[], watermark: number): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.index <= watermark || entry.derived === true || typeof entry.actor !== "string") continue;
    let msg: unknown = null;
    try {
      msg = JSON.parse(entry.payload);
    } catch {
      msg = null;
    }
    if (isRequiredClass(classifyMessage(msg).cls)) out.add(entry.actor);
  }
  return [...out];
}

function flat(fields: ClockEvidenceEvent["f"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = Array.isArray(value) ? value.slice(0, 8) : value;
  return out;
}
