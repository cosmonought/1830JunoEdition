// frontend/src/gameEngine/trainDiscard.ts
//
// The excess-train obligation: who must discard, in what order, and what a `DiscardTrain` may do.
//
// ==================================================================
//  DESIGN NOTE 1530: THE PRESIDENT CHOOSES, AND THE GAME WAITS
// ==================================================================
//
// RULEBOOK (1830-RE, Lookout 2018):
//   2.0   "A phase change occurs immediately following the purchase of the first train of a new type. So,
//         any new limit on how many trains a railroad can own goes into effect after that train is purchased.
//         This may result in the forced discard of a train by the railroad that just purchased a train."
//   6.6.1 "If a railroad finds itself with an excess train, the president must choose a train to discard.
//         A discarded train goes to the Bank Pool and its railroad receives no payment for it. If multiple
//         railroads must discard at the same time, the trains are discarded in order of the companies' share
//         values -- with the highest valued railroad deciding first."
//   6.6   "The bank pool may hold trains discarded by railroads. These trains may be purchased for face value
//         (on the train card). The payment goes to the bank."
//   6.0   the operating-order tie-break for equal share values (same block: top token first; different
//         columns: rightmost first; same column: highest first).
//
// WHAT WAS HERE BEFORE (audit C6, Batch 4 #1513): `applyPhaseChange` trimmed every over-limit fleet itself,
// cheapest-first, in the same reducer step as the purchase -- the half of 6.6.1 the rulebook gives to the
// president was decided by a sort. Batch 4 put the trimmed train in the Bank Pool and deferred the choice to
// this batch, behind the rules-engine version boundary (#1520), because a log that records the choice is a
// different program from one that does not.
//
// THE OBLIGATION IS DERIVED, NOT STORED. "Over the limit" is a fact the state already carries -- the fleet,
// the reprieve marks, the phase -- and a corporation is only ever over it between a phase change and its
// discards, because every other way a train arrives is refused at the limit (`trainPurchaseRefusal`, the
// trade gate). So `pendingTrainDiscards` reads the board and answers: nothing is persisted that could drift
// from it, a rebuild owes exactly what the play owed, and "resume the interrupted flow" needs no bookkeeping
// -- the cursor never moved; the gate simply stops refusing once nothing is over the limit.
//
// THE ORDER IS 6.0's, RECOMPUTED ON DEMAND. 6.6.1 orders by share value; 6.6.1 says nothing about ties; 6.0
// is the rulebook's one statement of how equal share values are ordered, and `buildOperatingOrder` is this
// engine's implementation of it (#646/#647/#1196). Recomputing it per call is the same as snapshotting it at
// the phase change, because while a discard is pending the ONLY action the reducer accepts is a discard, and a
// discard moves no share price. A dynamic order therefore cannot differ from a snapshotted one; it is simply
// the one with nothing extra to persist. (`buildOperatingOrder` admits floated corporations with a president,
// which every corporation owning a train is.)
//
// COUNTED THE WAY EVERY LIMIT CHECK COUNTS (#1034): `countableTrainCount` subtracts reprieved trains (Gentle
// Rust) and ghost trains (Yellow Sign) -- both exempt from the limit by their variants' own rulings. The old
// trim exempted the reprieve and not the ghost; the ghost's own expiry (`expireGhostTrains`, #1046, at the
// round boundary) is unchanged by this note and out of its scope. Only a COUNTABLE train may be discarded:
// discarding a reprieved one would spend a train and leave the obligation standing.
// [UR-6 (UR audit Appendix B item 7; Gentle Rust Appendix B item 15): `expireGhostTrains` is DELETED (#1672), and the
// Yellow Sign's exemption is the gilding (`carcosan_trains`), for the gold-trimmed train's whole Carcosa lifetime --
// `countableTrainCount` reads that, not `ghost_trains`, which is provenance only.]
//
// THE GATE: while any corporation is over the limit, every message but `DiscardTrain` and the room's own
// `CloseRoom` is refused by identity in `applySandboxActionCore`, before any arm and before the identity and
// obligation gates of Batches 3 and 4 -- because those gates read a cursor, and the cursor is not the
// authority while a discard is owed. `RevertTo` never reaches the reducer (it is an instruction about the
// log, #1026) and keeps its behaviour. The game's own derived actions are not owed either: `nextDerivedAction`
// answers `null` while a discard is pending, so a server settling the board waits for the president rather
// than walking the turn past them.
//
// AUTHORISATION (Batch 2 ingress, #1205/#1249): `DiscardTrain` is not a seat's action -- after a phase change
// the president who must decide is usually not the one operating. `turnRefusal` gives it its own owner: the
// president of the corporation that must decide NEXT, and nobody else; and the reducer's arm asks the same
// question of the entry's own `actor` (#549), so a hand-built message meets the answer twice.

import type { GameStateResponse, PublicCompanyState } from "./gameState";
import type { SandboxLogMsg } from "./gameSetup";
import { derivePhase } from "./gamePhase";
import { countableTrainCount } from "./trainLimit";
import { buildOperatingOrder } from "./operatingOrder";

/** One corporation that must discard, and what it may discard. */
export interface TrainDiscardDue {
  companyId: number;
  ticker: string;
  president: string | null;
  /** The current train limit (the phase's). */
  limit: number;
  /** Trains that count against the limit -- the ones the president may choose among. */
  choices: readonly string[];
  /** How many discards this corporation still owes. */
  excess: number;
}

export interface PendingTrainDiscards {
  limit: number;
  /** Every over-limit corporation in the order they decide (6.6.1 + 6.0). */
  queue: readonly TrainDiscardDue[];
  /** The corporation that must decide next -- always `queue[0]`. */
  required: TrainDiscardDue;
}

/** The trains that count against the limit, as a multiset walk over the fleet (#1034: reprieved and ghost
 *  trains are exempt, each mark spending one matching train). */
export function countableTrainsOf(company: PublicCompanyState): string[] {
  const owned = company.owned_trains;
  if (owned == null) return [];
  // #1672 (S9-2): gilded for its whole Carcosa lifetime, not exempt for one Operating Round.
  const exempt = [...(company.pending_rust_trains ?? []), ...(company.carcosan_trains ?? [])];
  const countable: string[] = [];
  for (const model of owned) {
    const at = exempt.indexOf(model);
    if (at >= 0) exempt.splice(at, 1);
    else countable.push(model);
  }
  return countable;
}

/** How many trains this corporation holds above the limit, or 0. */
export function excessTrainCount(company: PublicCompanyState, limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  const countable = countableTrainCount(company.owned_trains, company.pending_rust_trains, company.carcosan_trains);
  return Math.max(0, countable - limit);
}

/** The outstanding excess-train obligations, or `null` when no corporation is over its limit.
 *
 *  Derived from the board on every call (see the header). The phase's limit is the one in force NOW -- the
 *  purchase that turned the phase has already been applied by the time anybody asks. */
export function pendingTrainDiscards(state: GameStateResponse): PendingTrainDiscards | null {
  const phase = derivePhase(state);
  // #232: a board that reports no fleets has nothing over any limit -- and no limit to be over.
  if (!phase || !phase.known) return null;
  const limit = phase.trainLimit;
  if (!Number.isFinite(limit)) return null;

  const over = new Map<number, TrainDiscardDue>();
  for (const company of state.public_companies ?? []) {
    const excess = excessTrainCount(company, limit);
    if (excess === 0) continue;
    over.set(company.company_id, {
      companyId: company.company_id,
      ticker: company.ticker,
      president: company.president ?? null,
      limit,
      choices: countableTrainsOf(company),
      excess,
    });
  }
  if (over.size === 0) return null;

  /* 6.6.1's order with 6.0's tie-break. A corporation the operating order cannot place (no president, not
     floated -- neither can own a train, so this is defensive) decides after every placed one, by id. */
  const order = buildOperatingOrder(state);
  const queue: TrainDiscardDue[] = [];
  for (const companyId of order) {
    const due = over.get(companyId);
    if (due) {
      queue.push(due);
      over.delete(companyId);
    }
  }
  for (const due of Array.from(over.values()).sort((a, b) => a.companyId - b.companyId)) queue.push(due);
  return { limit, queue, required: queue[0] };
}

/** The reducer's own check (asked in `applySandboxActionCore`, so a refusal comes back by identity) and the
 *  shell's explanation. `actor` is the log entry's author when the log names one (#549); `null`/`undefined`
 *  asks nothing about the sender -- the authority (`turnRefusal`) already did, with the same rule. */
export function discardTrainRefusal(
  state: GameStateResponse,
  msg: { protocol_id: number; model_type: string },
  actor?: string | null,
): string | null {
  const pending = pendingTrainDiscards(state);
  if (pending === null) return "No corporation is over its train limit, so there is no train to discard.";
  const { required } = pending;
  if (msg.protocol_id !== required.companyId) {
    const named = state.public_companies.find((company) => company.company_id === msg.protocol_id);
    const waiting = pending.queue.find((due) => due.companyId === msg.protocol_id);
    return waiting
      ? `${required.ticker} decides first — it has the higher share value. ${named?.ticker ?? "That corporation"} discards after it.`
      : `${named?.ticker ?? "That corporation"} is not over its train limit; ${required.ticker} is the one that must discard.`;
  }
  if (actor != null && required.president !== null && actor !== required.president) {
    return `Only ${required.ticker}'s president can choose which train ${required.ticker} discards.`;
  }
  if (!required.choices.includes(msg.model_type)) {
    return `${required.ticker} holds no ${msg.model_type}-train it could discard.`;
  }
  return null;
}

/** #1530: what the pending obligation refuses -- every message but the discard itself and the room's close.
 *  `null` when nothing is pending or the message is the one the game is waiting for. */
export function pendingDiscardBlock(state: GameStateResponse, msg: SandboxLogMsg): string | null {
  if ("DiscardTrain" in msg || "CloseRoom" in msg) return null;
  const pending = pendingTrainDiscards(state);
  if (pending === null) return null;
  const { required } = pending;
  const who = required.president ? `${required.ticker}'s president` : required.ticker;
  return (
    `${required.ticker} holds ${required.excess} train${required.excess === 1 ? "" : "s"} more than the limit of ` +
    `${required.limit}; ${who} must discard before anything else happens.`
  );
}
