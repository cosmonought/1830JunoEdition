// frontend/src/gameEngine/actionOutcome.ts
//
// Whether an action the authority was handed changed anything -- the ONE answer the server's transport and the
// shell's receipt both read.
//
// ==================================================================
//  DESIGN NOTE 1685 (Stage 10.2, S10-1): A REFUSAL IS AN UNCHANGED BOARD, COMPARED BY CONTENT
// ==================================================================
//
// THE REDUCER HAS NO REFUSAL RESULT AND DOES NOT NEED ONE. Every gate (#712, #757, #1019, ...) refuses by
// returning the board it was handed, and #778 read that as `after === before`. That identity held while the
// reducer was the whole transition. Since #1197 / #1340 the chart and the auction ride on the state, and the
// layers above the core (`applySandboxActionAfterAuction`'s `{ ...state, market_positions }`, the queue settle,
// the shell's own `{ ...after, market_positions, waterfall }` hand-in) build a fresh object for EVERY charted
// action, refused or not. On a charted board -- every room, every replay -- identity said "applied" for
// everything, so:
//
//   * the server answered `applied` to a reducer refusal and appended it to the durable log (S10-1);
//   * the shell's REFUSED receipt (#778) could not fire, and #899's CloseRoom silence (#1248) could not either.
//
// THE CRITERION IS THEREFORE CONTENT, NOT IDENTITY: the authoritative atoms, compared in `canonicalJson`'s form
// (the digest's own canonicalisation, #1206 -- sorted keys, `undefined` omitted, `null` kept, `-0` normalised).
// Exact text equality, not the 64-bit digest, so a collision cannot turn an applied move into a refusal.
//
// WHICH ATOMS. A `RoomEngine` holds exactly four things (`replayLog.ts`):
//   1. `state`       -- the whole `GameStateResponse`, INCLUDING `market_positions` (#1196) and `waterfall`
//                       (#1340), the two atoms that used to live outside it;
//   2. `grid`        -- the tile grid, moved before the reducer and only when `layTileRefusal` answers `null`
//                       (#1683, Stage 10.1: a refused lay touches no atom);
//   3. `emitted`     -- the #1208 derived-key guard, written only for a `derived` entry (never for a submission);
//   4. `unparseable` -- indices whose payload did not parse (a submission is minted from a validated message).
// So for a SUBMITTED entry, "changed nothing" is exactly: state canonically equal AND grid canonically equal.
// Atoms 3 and 4 cannot move for a submission. The shell holds the same two atoms (the board it hands the
// reducer, carrying the chart and auction mirrors, and `mapGridRef`) and asks the same function.
//
// WHY NOT A REFUSAL LIST. The reducer's gates are dozens and growing; a list of "messages the reducer might
// decline" beside them is #1184's shape. The only list here is its opposite and it is short: the messages for
// which an unchanged board is NOT a refusal (`UNCHANGED_IS_NOT_A_REFUSAL`). Everything else that changes
// nothing was declined by some rule, whichever one it was.

import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { canonicalJson } from "./stateDigest";
import { harmlessDuplicateAnswer } from "./harmlessDuplicate"; // #1687

/** The authoritative atoms a message can move: the board (chart and auction on it) and the tile grid. */
export interface AuthoritativeAtoms {
  state: GameStateResponse;
  /** Absent when the caller holds no grid; then only the board is compared. */
  grid?: MapGridResponse;
}

function sameContent(a: unknown, b: unknown): boolean {
  return a === b || canonicalJson(a) === canonicalJson(b);
}

/** #1685: whether the atoms after an action hold exactly what they held before it. Identity first (the cheap
 *  and common answer on an uncharted board), then canonical content. */
export function atomsUnchanged(before: AuthoritativeAtoms, after: AuthoritativeAtoms): boolean {
  if (before.grid !== undefined || after.grid !== undefined) {
    if (!sameContent(before.grid ?? null, after.grid ?? null)) return false;
  }
  return sameContent(before.state, after.state);
}

/* ==================================================================
    DESIGN NOTE 1685a: THE MESSAGES FOR WHICH "NOTHING CHANGED" IS NOT A REFUSAL
   ==================================================================
   Inventoried for Stage 10.2 against every arm that returns its board on purpose (Stage-10.2 write-up, Part B):

     CloseRoom -- #899 / #1248. Every client's countdown and any player's button send it; the first at GameEnd
                  sets `room_closed` and the rest find it set. A duplicate is the design working. On the server
                  it stays APPLIED and appended, exactly as before 10.2 (ingress admits it only at GameEnd,
                  #1249); the shell prints nothing for it (`silentWhenUnchanged`).
     RevertTo  -- an instruction about the LOG, never a step (#1026 / #1233). `RoomSession` rebuilds for it
                  before this question is asked; the shell resolves it before the reducer. Its effect is on
                  the history, so an unchanged board says nothing about it.
     Chat      -- not a move at all: it has its own frame (#1361a), is not in the gameplay schema and never
                  reaches the reducer or `RoomSession.submit`. Named so the shell's legacy transport cannot
                  mistake a stray one for a refusal.

   AND ONE STATE-AWARE CLASS (#1687, `harmlessDuplicate.ts`): a consent answer -- `AnswerPrivatePurchase`,
   `AnswerTrainPurchase`, `AnswerPrivateTrade`, `AnswerFundingPrivateOffer` -- sent when the board it was judged
   on has NOTHING TO ANSWER (#662 / #701 / #1541: "a harmless duplicate", never an error). Asked of the board
   BEFORE the message, never of the message type alone: the same answer while its offer stands is judged in
   full and, if it changes nothing, is a refusal. Such a duplicate stays APPLIED and appended, exactly as before
   10.2, like `CloseRoom`'s race loser.

   DELIBERATELY NOT ON THE LIST (they were on #778's, and 10.2 moves them): `SetupGame` (a deal that changes
   nothing was refused -- an undealable roster -- and must not pin a room's build or rules version, which both
   read the log's deal); `UndoLastAction` and `ExecuteOperatingRound` (chain-era messages with no-op arms: a
   room's undo is `RevertTo`, and appending a message that did nothing would make it the player's "last
   action" for `undoReachFor`); `AcceptTrainOffer` / `RejectTrainOffer` / `RescindTrainOffer` /
   `ProposeTrainOffer` (the chain-era offer register -- refused outright on a pinned board by
   `legacyOfferMessageRefusal`, a no-op arm only on a legacy board). A stored copy of any of these still replays
   as the no-op it always was; only a NEW log stops recording them. */
export const UNCHANGED_IS_NOT_A_REFUSAL: readonly string[] = ["CloseRoom", "RevertTo", "Chat"];

/** Whether an unchanged board, after this message, means a rule declined it. `before` is the board the message
 *  was judged on; without it the state-aware class (#1687) cannot be recognised, and only the three message-wide
 *  exemptions apply. */
export function unchangedMeansRefused(msg: unknown, before?: GameStateResponse): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  if (UNCHANGED_IS_NOT_A_REFUSAL.some((key) => key in msg)) return false;
  if (before !== undefined && harmlessDuplicateAnswer(before, msg)) return false;
  return true;
}

/** #1685: the single definition of "the authority declined this action" -- asked by `RoomSession.submit` (on
 *  the engine's atoms, through `RoomEngine.submit`) and by the shell's receipt (`actionWasRefused`). */
export function authorityDeclined(msg: unknown, before: AuthoritativeAtoms, after: AuthoritativeAtoms): boolean {
  return unchangedMeansRefused(msg, before.state) && atomsUnchanged(before, after);
}
