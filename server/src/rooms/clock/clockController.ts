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
//                 overdue, a minute-30 finality, a train offer's unanswered expiry -- which closes the offer in the log,
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
//   remedies      a sealed money remedy is attested and relayed (`remedyPipeline.ts`) only once its seal is DURABLE,
//                 only while no system pause holds the table, and only from the clock's current authority; the relayer
//                 asks `remedyGate` before every new attempt.
//
// CONTINUITY. Every write stamps this process's AUTHORITY token (file mode: the data-directory lock's instance id; AWS:
// the generation, pool, pool epoch and task) and its trust instant. A record another authority wrote is a continuity
// break that was NOT proven continuous: the gap the previous authority left in the log (if any) is recovered from the
// log itself, then a Live table enters SYSTEM PAUSE (every timer frozen as of the last proven instant; unanimous resume),
// a Timed Async table's outage is credited, and a No-deadline table changes nothing. A reload in the SAME process (an
// eviction) keeps continuity: the process held the authority throughout, so the elapsed time is real. A stale actor
// (taken over) cannot write the clock (the HEAD fence / the lock check), so it can neither move a clock nor sign a remedy.

import type { GameStateResponse } from "../../../../frontend/src/gameEngine/gameState";
import { operatingRoundKeyOf, requiredDecisionOf, standingOfferOf } from "../../../../frontend/src/gameEngine/clockResponsibility";
import { logHash } from "../../../../frontend/src/gameEngine/logHash";
import { sellerPresident } from "../../../../frontend/src/gameEngine/trainSaleAuthority";
import type { ClockDeadlineClass, RoomClockView } from "../../../../frontend/src/utils/clockProtocol";
import { CLOCK_REFUSAL } from "../../../../frontend/src/utils/clockProtocol";
import type { RoomSession, ServerLogEntry } from "../../../../frontend/src/utils/roomSession";
import type { UndoPolicy } from "../../../../frontend/src/gameEngine/logRevert";
import type { OpsRecorder } from "../../persistence/opsRecorder";
import type { StoreWriteOutcome } from "../../persistence/storeResult";
import type { RemedyPort } from "../../escrow/remedyPipeline";
import type { ChainIntentRecord } from "../../escrow/chainIntents";
import type { GameActor, Tx } from "../gameActor";
import type { ClockConductHook, ClockEvidenceEvent } from "./clockEvidence";
import {
  acknowledge,
  advance,
  annulVote,
  choosePolicy,
  classifyMessage,
  clockViewOf,
  continuityBreak,
  escrowEnded,
  foldBatch,
  gate,
  heartbeat,
  newClockRecord,
  nextDue,
  pauseOp,
  propose,
  recoverGap,
  remedyProgress,
  sealNeutralFallback,
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
import { ClockUnreadableError, LIVE_CURE_MS, type ClockVote, type GameClockRecord } from "./clockRecord";
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
/** The remedy sweep: sealed-but-unconfirmed remedies are carried on (a lapsed attestation re-attested). */
export const CLOCK_REMEDY_SWEEP_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The server's own closing of an expired train offer (a `RescindTrainPurchase` as its proposer, in the game's task). */
export type CloseOffer = (game: GameActor, tx: Tx, input: { readonly proposer: string; readonly at: number; readonly offerKey: string }) => Promise<{ readonly ok: true; readonly first: number; readonly last: number; readonly before: ClockBoardFacts; readonly after: ClockBoardFacts } | { readonly ok: false; readonly why: string }>;

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
}

export type ClockAnswer = { readonly ok: true; readonly data?: Record<string, unknown> } | { readonly ok: false; readonly code: string; readonly reason: string };

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

/** The SERVER's own move when a Live train offer's response time ran out unanswered: the proposer's `RescindTrainPurchase`
 *  (the one legal message that withdraws a standing train offer; the engine has no expiry), speculated on the task's
 *  session with every entry stamped at the exact moment the response time ended. The caller commits the batch. */
export function rescindExpiredOffer(
  session: RoomSession,
  input: { readonly proposer: string; readonly at: number; readonly build: string; readonly host: string; readonly hostUndo: UndoPolicy["host_undo"] },
  stampAt?: <T>(at: number, fn: () => T) => T,
): { readonly ok: true; readonly batch: readonly ServerLogEntry[]; readonly before: ClockBoardFacts; readonly after: ClockBoardFacts; readonly board: GameStateResponse } | { readonly ok: false; readonly why: string } {
  const state = session.state;
  const offer = state.train_purchase_offer ?? null;
  if (offer === null || offer.accepted === true) return { ok: false, why: "no train offer stands" };
  const before = boardFactsOf(state);
  const start = session.entries.length;
  const submit = () =>
    session.submit({
      actor: input.proposer,
      build: input.build,
      msg: { RescindTrainPurchase: { seller_protocol_id: offer.seller_protocol_id } },
      baseIndex: session.nextIndex - 1,
      submissionId: `clock-expiry-${input.at}`,
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
  const name = (gameId: string, seat: string) => deps.nameOf?.(gameId, seat) ?? seat;
  let sweepHandle: unknown | null = null;

  function entryOf(gameId: string): Entry {
    let entry = entries.get(gameId);
    if (entry === undefined) {
      entry = { gameId, record: null, stored: null, checked: false, stale: true, unreadable: null, lost: false, writes: Promise.resolve(), loading: null, timer: null, timerDue: null, beat: null, pinned: false, pipeline: null, sealedRev: null };
      entries.set(gameId, entry);
    }
    return entry;
  }

  /* ---- the store: one write chain per table, always writing the newest decided record ---- */

  function flush(entry: Entry): Promise<boolean> {
    const run = entry.writes.then(async (): Promise<boolean> => {
      if (entry.lost) return false;
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
        if (entry.record === record) entry.record = stamped;
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

  /** Read the stored record into the entry (a load, or a reread after a write that did not settle). */
  async function reread(entry: Entry): Promise<void> {
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
        return;
      }
      throw error;
    }
    entry.unreadable = null;
    if (entry.record === null || stored === null) {
      entry.record = stored;
      entry.stored = stored?.revision ?? null;
    } else if (stored.authority === deps.authority && stored.revision <= entry.record.revision) {
      /* Our own write landed (or an earlier one did): the decided record stands; the next flush writes it. */
      entry.stored = stored.revision;
    } else {
      /* Someone else wrote this table's clock while this process held it in memory: this process no longer decides it. */
      entry.lost = true;
      entry.record = stored;
      entry.stored = stored.revision;
      deps.warn(`  clock: ${entry.gameId}: the stored clock was written by another authority (${stored.authority}); this process stops deciding it`);
      deps.ops.audit("clock.lost", { game_id: entry.gameId });
    }
    entry.stale = false;
  }

  /** The table's record as of now -- read, continuity-checked and brought in line with the committed log -- or `null`
   *  when the table has no clock it can use (undealt with no policy chosen, unreadable, lost). Inside a task. */
  async function ensure(game: GameActor, tx: Tx | null, checkMoney = false): Promise<GameClockRecord | null> {
    const entry = entryOf(game.gameId);
    if (entry.lost) return null;
    if (entry.stale || entry.record === null) {
      if (entry.loading === null) {
        entry.loading = reread(entry).finally(() => {
          entry.loading = null;
        });
      }
      await entry.loading;
      counters.loads += 1;
    }
    if (entry.unreadable !== null || entry.lost) return null;
    const view = game.view;
    const state = (tx?.session ?? null)?.state ?? null;
    const isDealt = state !== null ? dealt(state) : view.entries.length > 0;
    if (entry.record === null) {
      if (!isDealt || view.record === null || state === null || view.entries.length === 0) return null;
      /* A table in play before its clock existed (dealt by an earlier build, or its first write never landed): created
         now, folded as if dealt at the newest entry -- and, being unproven, a continuity break like any other. */
      const record = view.record;
      const mode = (record.variants as { mode?: string } | null)?.mode === "async" ? "async" : "live";
      const last = view.entries[view.entries.length - 1];
      const lastAt = stampOf(last) ?? now();
      const created = newClockRecord({ gameId: game.gameId, deadline: mode === "live" ? "live" : "no-deadline", paceSecs: null, money: record.money !== null, authority: `unknown:${game.gameId}`, now: lastAt });
      const facts = factsOfGame(game.gameId, state);
      entry.record = { ...foldBatch(created, { actor: "", first: last.index, last: last.index, at: lastAt, msg: "deal", revertTarget: null, before: facts, after: facts }, now()).record, authority: `unknown:${game.gameId}`, trusted_at: lastAt };
      entry.checked = false;
    }
    let firstCheck = false;
    if (!entry.checked) {
      await checkContinuity(entry, game, state);
      entry.checked = true;
      firstCheck = true;
    } else if (entry.record.phase !== "setup" && view.entries.length > 0) {
      const last = view.entries[view.entries.length - 1];
      if (last.index > entry.record.watermark && state !== null) {
        /* Same authority, but the log moved past the record (a fold that never ran): recovered from the log itself. */
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
    if (record.authority === deps.authority) return;
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
      record = recoverGap(record, { now: at, lastIndex: last.index, lastAt: lastAt ?? record.trusted_at, actors: actorsAfter(view.entries, record.watermark), facts: factsOfGame(game.gameId, state) }).record;
    }
    const preservedAt = Math.max(record.trusted_at, lastAt ?? 0);
    const reason = `server continuity was not proven: this table was last served by another server process (last proven at ${new Date(record.trusted_at).toISOString()})`;
    const step = continuityBreak(record, { now: at, preservedAt, reason, authority: deps.authority });
    if (step.record.system !== null && record.system === null) counters.systemPauses += 1;
    deps.ops.audit("clock.continuity-break", { game_id: game.gameId, prior_authority: String(entry.record?.authority ?? "").slice(0, 80), preserved_at: preservedAt, system_pause: step.record.system !== null, deadline: record.policy.class });
    applyStep(entry, { ...step, record: step.record }, game.gameId, true);
    await flush(entry);
  }

  /** Install a step's record (never by an older record over a newer one), report its evidence, schedule its effects. */
  function applyStep(entry: Entry, step: ClockStep, gameId: string, force = false): void {
    if (step.record === entry.record && !force) return;
    const current = entry.record;
    /* Revisions only ever rise (a store's CAS compares them): a step computed from an earlier record never reuses one. */
    entry.record = current !== null && step.record !== current && step.record.revision <= current.revision ? { ...step.record, revision: current.revision + 1 } : step.record;
    for (const event of step.events) report(gameId, event, entry.record);
    for (const effect of step.effects) effectOf(entry, effect, gameId);
  }

  function report(gameId: string, event: ClockEvidenceEvent, record: GameClockRecord): void {
    if (event.kind === "overdue") counters.overdues += 1;
    if (event.kind === "final") counters.finalities += 1;
    deps.ops.audit(`clock.${event.kind}`, { game_id: gameId, seq: event.seq, at: event.at, ...flat(event.f) });
    try {
      deps.conduct?.({ game_id: gameId, event, head: record.evidence.head });
    } catch (error) {
      deps.warn(`  clock: the conduct hook threw for ${gameId} -- ${describe(error)}`);
    }
  }

  function effectOf(entry: Entry, effect: ClockEffect, gameId: string): void {
    if (effect.kind === "fence-checkpoint") {
      try {
        deps.remedy?.()?.fence(gameId);
      } catch (error) {
        deps.warn(`  clock: ${gameId}: the fencing checkpoint could not be queued -- ${describe(error)}`);
      }
      return;
    }
    if (effect.kind === "remedy") {
      entry.sealedRev = entry.record?.revision ?? null;
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
    const timed = record !== null && !entry.lost && (record.phase === "active" || record.phase === "overdue") && record.system === null && record.pause.paused_at === null && record.policy.class !== "no-deadline";
    pinFor(entry, timed && record?.policy.class === "live");
    if (record === null || !timed) return;
    const due = nextDue(record);
    if (due !== null) {
      entry.timerDue = due;
      entry.timer = timers.set(() => {
        entry.timer = null;
        void deps.runOn(entry.gameId, "clock", (game, tx) => tick(game, tx)).catch((error) => deps.warn(`  clock: ${entry.gameId}: a timed transition failed -- ${describe(error)}`));
      }, Math.min(MAX_TIMER_MS, Math.max(0, due - now())));
    }
    const every = record.policy.class === "live" ? CLOCK_HEARTBEAT_LIVE_MS : CLOCK_HEARTBEAT_ASYNC_MS;
    entry.beat = timers.set(() => {
      entry.beat = null;
      if (entry.lost || entry.record === null || !deps.serving(entry.gameId)) return;
      /* The continuity proof -- this authority is still in control, now -- written in the table's own task (never
         beside a transition). */
      void deps
        .runOn(entry.gameId, "clock-heartbeat", async () => {
          if (entry.lost || entry.record === null) return;
          entry.record = heartbeat(entry.record, deps.authority, now());
          await flush(entry);
          arm(entry);
        })
        .catch((error) => deps.warn(`  clock: ${entry.gameId}: the heartbeat failed -- ${describe(error)}`));
    }, every);
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
  async function catchUp(entry: Entry, game: GameActor, tx: Tx): Promise<boolean> {
    let expired = false;
    for (let round = 0; round < 4; round += 1) {
      const record = entry.record;
      if (record === null) return expired;
      const step = advance(record, now(), positionOf(game));
      applyStep(entry, step, game.gameId);
      if (step.tradeExpiry === null) break;
      const due = step.tradeExpiry;
      counters.tradeExpiries += 1;
      const closed = await deps.closeOffer(game, tx, { proposer: due.proposer, at: due.at, offerKey: due.offerKey });
      expired = true;
      if (!closed.ok) {
        /* The offer is not standing after all (the record and the board disagree): re-derived from the board. */
        deps.warn(`  clock: ${game.gameId}: an expired train offer could not be closed (${closed.why}); the clock is re-derived from the board`);
        const view = game.view;
        const last = view.entries[view.entries.length - 1];
        if (last !== undefined && entry.record !== null) {
          applyStep(entry, recoverGap({ ...entry.record, watermark: Math.min(entry.record.watermark, last.index - 1) }, { now: now(), lastIndex: last.index, lastAt: due.at, actors: [], facts: factsOfGame(game.gameId, tx.session.state) }), game.gameId);
        }
        break;
      }
      const batch: ClockBatch = { actor: due.proposer, first: closed.first, last: closed.last, at: due.at, msg: "server-expiry", revertTarget: null, before: closed.before, after: closed.after };
      applyStep(entry, foldBatch(entry.record as GameClockRecord, batch, now()), game.gameId);
    }
    return expired;
  }

  /** A timer fired: process what is due, write, re-arm, re-broadcast. */
  async function tick(game: GameActor, tx: Tx): Promise<void> {
    const entry = entryOf(game.gameId);
    const record = await ensure(game, tx);
    if (record === null) return;
    await catchUp(entry, game, tx);
    await settle(entry, game.gameId);
  }

  /** Write, re-arm, re-broadcast, and carry a sealed money remedy on. */
  async function settle(entry: Entry, gameId: string): Promise<void> {
    await flush(entry);
    arm(entry);
    deps.onChange(gameId);
    if (entry.record?.remedy !== null && entry.record?.remedy !== undefined) void driveRemedy(gameId);
  }

  /* ---- the submit gate and the fold ---- */

  async function gateSubmit(game: GameActor, tx: Tx, input: { readonly actor: string; readonly msg: unknown }): Promise<GateResult | { readonly ok: false; readonly code: string; readonly reason: string }> {
    const entry = entryOf(game.gameId);
    const record = await ensure(game, tx);
    const cls = classifyMessage(input.msg);
    if (record === null) {
      if (entry.unreadable !== null || entry.lost) {
        const money = game.view.record?.money !== null && game.view.record?.money !== undefined;
        if (money) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "This table's clock is not available on the server right now, so no move can be taken." };
      }
      return { ok: true, now: now(), before: null, cls: cls.cls, revertTarget: cls.revertTarget };
    }
    const expired = await catchUp(entry, game, tx);
    if (expired) {
      await settle(entry, game.gameId);
      counters.refusals += 1;
      return { ok: false, code: CLOCK_REFUSAL.stale, reason: "The train offer expired unanswered. Check the board and try again." };
    }
    const current = entry.record as GameClockRecord;
    const state = tx.session.state;
    let trainRecipient: string | null = null;
    const body = typeof input.msg === "object" && input.msg !== null ? (input.msg as Record<string, unknown>).ProposeTrainPurchase : undefined;
    if (typeof body === "object" && body !== null && typeof (body as { seller_protocol_id?: unknown }).seller_protocol_id === "number") {
      trainRecipient = sellerPresident(state, (body as { seller_protocol_id: number }).seller_protocol_id);
    }
    const refusal = gate(current, { actor: input.actor, msg: cls.cls, closeRoom: cls.closeRoom, revertTarget: cls.revertTarget, trainRecipient, nameOf: (seat) => name(game.gameId, seat) });
    if (current !== record) await settle(entry, game.gameId);
    if (refusal !== null) {
      counters.refusals += 1;
      return { ok: false, code: refusal.code, reason: refusal.reason };
    }
    return { ok: true, now: now(), before: factsOfGame(game.gameId, state), cls: cls.cls, revertTarget: cls.revertTarget };
  }

  /** After a committed batch (in the same task): fold it and write the record before the task ends. */
  async function afterCommit(game: GameActor, input: { readonly gate: GateResult; readonly actor: string; readonly batch: readonly ServerLogEntry[]; readonly board: GameStateResponse }): Promise<void> {
    const entry = entryOf(game.gameId);
    if (entry.record === null || entry.lost || entry.unreadable !== null || input.batch.length === 0) {
      if (entry.record === null && input.gate.cls === "deal") await afterDeal(game, input);
      return;
    }
    if (input.gate.cls === "deal") return afterDeal(game, input);
    const before = input.gate.before ?? factsOfGame(game.gameId, input.board);
    const batch: ClockBatch = {
      actor: input.actor,
      first: input.batch[0].index,
      last: input.batch[input.batch.length - 1].index,
      at: stampOf(input.batch[0]) ?? input.gate.now,
      msg: input.gate.cls,
      revertTarget: input.gate.revertTarget,
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
      if (entry.stale) await reread(entry).catch(() => undefined);
      if (entry.record === null && entry.unreadable === null) {
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
      if (started !== null && started * 1000 > at) at = started * 1000;
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
        await reread(entry).catch(() => undefined);
        if (entry.record === null && entry.unreadable === null) {
          const rec = game.view.record;
          entry.record = newClockRecord({ gameId: game.gameId, deadline: input.deadline, paceSecs: input.paceSecs, money: rec?.money !== null && rec?.money !== undefined, authority: deps.authority, now: now() });
          entry.checked = true;
          await settle(entry, game.gameId);
          return { ok: true };
        }
      }
      if (entry.record === null) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "This table's clock is not available right now." };
      if (entry.record.money) return { ok: false, code: "wrong-state", reason: "A money table's deadline is fixed when the table is created." };
      return finish(entry, game.gameId, choosePolicy(entry.record, input.deadline, input.paceSecs, now()));
    }
    const record = await ensure(game, tx);
    if (record === null) return { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "This table's clock is not available right now." };
    if (input.type !== "clock-ack") {
      const expired = await catchUp(entry, game, tx);
      if (expired) await settle(entry, game.gameId);
    }
    const current = entry.record as GameClockRecord;
    const at = now();
    switch (input.type) {
      case "clock-ack":
        return finish(entry, game.gameId, acknowledge(current, seat, at));
      case "clock-pause":
        return finish(entry, game.gameId, pauseOp(current, seat, { action: input.action, kind: input.kind, id: input.id }, at));
      case "clock-sysresume":
        return finish(entry, game.gameId, systemResumeVote(current, seat, at));
      case "clock-annul":
        return finish(entry, game.gameId, annulVote(current, seat, input.yes, at));
      case "clock-propose":
      case "clock-vote": {
        const od = current.overdue;
        /* The approval was verified outside the task against THESE overdue facts; they must still be the ones standing. */
        if (input.verifiedFor !== null && (od === null || od.epoch !== input.verifiedFor.epoch || od.log_len !== input.verifiedFor.logLen)) {
          return { ok: false, code: CLOCK_REFUSAL.stale, reason: "The overdue changed while your approval was checked. Look again." };
        }
        const step = input.type === "clock-propose" ? propose(current, seat, input.kind, input.approval, at) : vote(current, seat, input.proposalId, input.yes, input.approval, at);
        return finish(entry, game.gameId, step);
      }
      default:
        return { ok: false, code: "bad-frame", reason: "That is not a clock operation." };
    }
  }

  async function finish(entry: Entry, gameId: string, step: ClockStep | ClockRefusal): Promise<ClockAnswer> {
    if ("code" in step) return { ok: false, code: step.code, reason: step.reason };
    applyStep(entry, step, gameId);
    await settle(entry, gameId);
    return { ok: true };
  }

  /* ---- money remedies ---- */

  /** Carry the sealed remedy on (serialized per table). Never from a system-paused table, a lost authority, a seal not
   *  yet durable, or a server with no remedy pipeline. */
  function driveRemedy(gameId: string): Promise<void> {
    const entry = entries.get(gameId);
    if (entry === undefined) return Promise.resolve();
    if (entry.pipeline !== null) return entry.pipeline;
    const run = (async () => {
      for (let pass = 0; pass < 3; pass += 1) {
        const record = entry.record;
        const remedy = record?.remedy ?? null;
        if (record === null || remedy === null || entry.lost) return;
        if (remedy.status === "confirmed" || remedy.status === "superseded") return;
        if (record.system !== null || record.authority !== deps.authority) return;
        if (entry.sealedRev !== null && (entry.stored === null || entry.stored < entry.sealedRev)) {
          if (!(await flush(entry))) return;
        }
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
        if (attempt.status === "refused") counters.remedyRefused += 1;
        const latest = entry.record;
        if (latest === null || latest.remedy === null || latest.remedy.kind !== remedy.kind || latest.remedy.epoch !== remedy.epoch) return;
        if (attempt.fallback === true) {
          const fallback = sealNeutralFallback(latest, now(), attempt.detail ?? "the foreclosure's approvals lapsed");
          if ("code" in fallback) return;
          applyStep(entry, fallback, gameId);
          await flush(entry);
          deps.onChange(gameId);
          continue;
        }
        applyStep(entry, remedyProgress(latest, attempt.status, attempt.detail, now(), attempt.attested), gameId);
        await flush(entry);
        deps.onChange(gameId);
        return;
      }
    })()
      .catch((error) => deps.warn(`  clock: ${gameId}: the remedy pipeline failed -- ${describe(error)}`))
      .finally(() => {
        entry.pipeline = null;
      });
    entry.pipeline = run;
    return run;
  }

  /** The relayer's question before a new attempt of a remedy intent (`EscrowServiceDeps.remedyGate`). */
  async function remedyGate(gameId: string, intent: ChainIntentRecord): Promise<{ readonly kind: "ok" } | { readonly kind: "wait"; readonly why: string }> {
    if (intent.op.kind !== "remedy") return { kind: "wait", why: "not a remedy intent" };
    const entry = entries.get(gameId);
    let record = entry?.record ?? null;
    if (record === null || entry?.stale === true) {
      try {
        record = await deps.store.load(gameId);
      } catch (error) {
        return { kind: "wait", why: `the table's clock cannot be read (${describe(error)})` };
      }
    }
    if (record === null || record.remedy === null) return { kind: "wait", why: "the table's clock has sealed no remedy" };
    const r = record.remedy;
    if (r.kind !== intent.op.remedy || String(r.epoch) !== intent.op.overdue_epoch || String(r.log_len) !== intent.op.log_len || r.strike !== intent.op.strike) return { kind: "wait", why: "the intent is not the table's sealed remedy decision" };
    if (record.system !== null) return { kind: "wait", why: "the table is in SYSTEM PAUSE: nothing not yet final is relayed until every player resumes" };
    if (record.authority !== deps.authority) return { kind: "wait", why: "this server is not the table clock's current authority" };
    if (entry?.lost === true) return { kind: "wait", why: "this server no longer decides the table's clock" };
    const port = deps.remedy?.() ?? null;
    if (port !== null && (await port.annulOpen(gameId).catch(() => false))) return { kind: "wait", why: "a unanimous annulment of this game is open: it supersedes the remedy" };
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

  return {
    counters,
    gateSubmit,
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
    /** A money table's deadline, fixed at its creation (before any CreateGame is built from it). */
    async createMoneyPolicy(gameId: string, deadline: ClockDeadlineClass, paceSecs: number | null): Promise<ClockAnswer> {
      const entry = entryOf(gameId);
      if (entry.stale) await reread(entry).catch(() => undefined);
      if (entry.record !== null) {
        return entry.record.policy.class === deadline && entry.record.policy.pace_secs === (deadline === "async-pace" ? paceSecs : null) ? { ok: true } : { ok: false, code: "wrong-state", reason: "This table's deadline is already fixed." };
      }
      try {
        entry.record = newClockRecord({ gameId, deadline, paceSecs, money: true, authority: deps.authority, now: now() });
      } catch (error) {
        return { ok: false, code: "bad-frame", reason: describe(error) };
      }
      entry.checked = true;
      const ok = await flush(entry);
      return ok ? { ok: true } : { ok: false, code: CLOCK_REFUSAL.unavailable, reason: "The table's deadline could not be recorded. Try again." };
    },
    /** An actor loaded (a first open, a restart, a reload): the clock is read and its continuity judged NOW, so a
     *  system pause is in force (and shown) before anyone moves. */
    loaded(gameId: string): void {
      void deps.runOn(gameId, "clock-load", async (game, tx) => {
        const entry = entryOf(gameId);
        const record = await ensure(game, tx, true);
        if (record === null) return;
        await catchUp(entry, game, tx);
        await settle(entry, gameId);
      }).catch((error) => deps.warn(`  clock: ${gameId}: the clock load failed -- ${describe(error)}`));
    },
    /** A money table's financial record changed: re-check its escrow's end in the table's task. */
    moneyChanged(gameId: string): void {
      if (!entries.has(gameId)) return;
      void deps.runOn(gameId, "clock-money", async (game, tx) => {
        const entry = entryOf(gameId);
        const record = await ensure(game, tx, true);
        if (record !== null) await settle(entry, gameId);
      }).catch(() => undefined);
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
  | { readonly type: "clock-sysresume"; readonly seat: string }
  | { readonly type: "clock-annul"; readonly seat: string; readonly yes: boolean }
  | { readonly type: "clock-propose"; readonly seat: string; readonly kind: "foreclose" | "annul"; readonly approval: ClockVote["approval"]; readonly verifiedFor: { readonly epoch: number; readonly logLen: number } | null }
  | { readonly type: "clock-vote"; readonly seat: string; readonly proposalId: number; readonly yes: boolean; readonly approval: ClockVote["approval"]; readonly verifiedFor: { readonly epoch: number; readonly logLen: number } | null };

/* ---- helpers ---- */

function stampOf(entry: ServerLogEntry | undefined): number | null {
  return entry !== undefined && typeof entry.at === "number" && Number.isSafeInteger(entry.at) && entry.at >= 0 ? entry.at : null;
}

function actorsAfter(entries: readonly ServerLogEntry[], watermark: number): string[] {
  const out = new Set<string>();
  for (const entry of entries) if (entry.index > watermark && entry.derived !== true && typeof entry.actor === "string") out.add(entry.actor);
  return [...out];
}

function flat(fields: ClockEvidenceEvent["f"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = Array.isArray(value) ? value.slice(0, 8) : value;
  return out;
}
