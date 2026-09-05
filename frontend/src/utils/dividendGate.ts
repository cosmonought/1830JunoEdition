// frontend/src/utils/dividendGate.ts
//
// When a dividend declaration is legal. One corporation, one declaration, at the step that owns the choice.
//
// ==================================================================
//  DESIGN NOTE 774: A ONCE-PER-TURN GUARD THAT ONE BROWSER KEPT
// ==================================================================
//
// REPORTED: "B&O parred at $100. After the first OR (no train to run), its share price moved two cells left
// rather than one."
//
// ONE WITHHOLD IS ONE CELL AND THE PROJECTION WAS NEVER WRONG. Par $100 is cell (6,10); one step left is
// (5,10), $90. `projectDividendCellMove` walks exactly one column and clamps. So the token did not take a
// bigger step -- it took two steps, which means two `DeclareDividends` messages reached the log.
//
// THE SECOND ONE CAME FROM THE OTHER PLAYER'S BROWSER. A trainless corporation is auto-skipped past Routes
// and the game declares a forced $0 withhold on its behalf (#668). The effect that does it is gated on
// `spectator`, the sub-phase and the revenue -- all of which are SHARED state, replayed identically on every
// client -- and not on whose turn it is. Every seated player's browser therefore satisfied the condition and
// appended its own declaration. Two players, two messages, two cells.
//
// THE TURN GATE DID NOT CATCH IT BECAUSE IT IS EXEMPT BY DESIGN. `runGameplayAction` refuses a dispatch when
// `!isMyTurnRef.current`, but skips that check for `automatic: true` -- the flag the two derived dispatches
// set. That exemption is correct in itself: those messages are the game acting, not the player.
//
// AND THE GUARD THAT WAS SUPPOSED TO STOP IT IS A `Set` IN ONE TAB. `forcedWithholdRef` keys on the turn and
// the step, and #653 fixed its scope carefully -- but no per-browser ref can enforce a property of a SHARED
// APPEND-ONLY LOG. It stops one client dispatching twice. It cannot see the other client at all.
//
// SO THE RULE MOVES TO THE AUTHORITY, which is this module. The reducer already tracks the cursor that
// answers the question: `settleOperatingCursor` steps `operating_sub_phase` from "Dividends" to "Hardware"
// the moment the first declaration lands, so the second arrives at a step that no longer owns the choice. The
// check is not a duplicate-detector bolted on -- it is the ordinary 1830 rule that dividends are declared at
// the Dividends step, finally enforced instead of assumed.
//
// THIS IS THE SESSION'S DOMINANT BUG IN A NEW DRESS -- #723, #736, #712, #748, #756, #757 -- a rule stated in
// a predicate and never enforced in the authority. The Auto-Pass effect already knew: its own note says "it
// is THIS player's -- `isMyTurn` is the same predicate the turn gate uses" and it returns early. The two
// Operating Round effects never learned it, and only a second browser could show the difference.

import type { GameStateResponse } from "./gameState";
import type { OperatingSubPhase } from "../components/OperatingSubPhaseStepper";

/** The step at which the pay-or-withhold choice belongs. */
export const DIVIDEND_SUB_PHASE: OperatingSubPhase = "Dividends";

/** The corporation whose turn it is, or `null` when the queue cannot answer.
 *  Mirrors `actingSeatIndex`'s lookup rather than re-deriving one: the acting corporation is a position in
 *  `active_operating_order`, and two ways of reading one cursor is how they come to disagree. */
export function operatingCorporationId(state: GameStateResponse): number | null {
  if (state.current_round_type !== "OperatingRound") return null;
  return state.active_operating_order[state.active_corporation_index] ?? null;
}

/* ==================================================================
    DESIGN NOTE 1182: THE CHECK DIVIDENDS ALREADY MADE, FOR THE REST OF THE TURN
   ==================================================================
   REPORTED, with the log: an Operating Round in which one client laid a tile, ran two routes and tried to
   declare dividends for B&O while the board had C&O operating -- and then did it again a turn later with NNH
   against NYC. Every action APPLIED except the last, which printed "Only the operating corporation declares
   dividends" and left the board unchanged.
   THAT ASYMMETRY IS THE DAMAGE, and it is this file's fault in the mildest way: `dividendRefusal` below has
   asked "is this corporation the one operating" since #748, and nothing else ever did. So a client whose
   operating queue disagreed with the board silently rewrote the map and the treasuries, and was stopped only
   at the one arm that happened to check.
   WHY THE QUEUES DISAGREE IS A DIFFERENT NOTE. `buildOperatingOrder` filters on floated-with-a-president and
   sorts on three keys read from the client-local market chart, so any divergence in that chart (#1177) or in
   who has floated reorders the turn. This does not fix that; it makes the consequence a refusal instead of a
   corruption.
   IT IS NOT #1174. That check compared the log entry's ACTOR -- a client identity, resolved through the seat
   cursor -- and #549 forbids the reducer to read the cursor at all. This compares the corporation carried IN
   THE MESSAGE against the corporation the state says is operating: both sides are functions of the log, every
   client reaches the same verdict from the same prefix, and `dividendRefusal` has been doing exactly this in
   this file the whole time without ever being a divergence source.
   A REASON, NOT A BOOLEAN, so the log can say which rule fired -- #619 and #712's rule, and the reason the
   reported line was legible enough to diagnose from. */
export function wrongCorporationRefusal(
  state: GameStateResponse,
  companyId: number,
  what: string,
): string | null {
  const acting = operatingCorporationId(state);
  /* `null` MEANS THE QUEUE CANNOT ANSWER -- outside an Operating Round, or with an empty order -- and a
     refusal there would block the auction and the Stock Round, where these messages also travel. Silence is
     the honest answer to a question this state cannot be asked. */
  if (acting === null || acting === companyId) return null;
  return `Only the operating corporation may ${what}.`;
}

/** Why this dividend declaration must not be applied, or `null` if it may be.
 *
 *  Written as a REASON rather than a boolean for #748's reason: a refusal a player cannot see is
 *  indistinguishable from a bug, and the shell logs this string.
 *
 *  ORDER MATTERS ONLY FOR THE MESSAGE, not for the outcome -- the round check first, because "not in an
 *  Operating Round" explains a stray message better than "wrong step" does. */
export function dividendRefusal(
  state: GameStateResponse,
  companyId: number,
): string | null {
  if (state.current_round_type !== "OperatingRound") {
    return "Dividends are declared during an Operating Round.";
  }

  const acting = operatingCorporationId(state);
  if (acting !== null && acting !== companyId) {
    /* A declaration for a corporation that is not the one operating. Not the reported bug, but the same
       message arriving out of order, and the arm below would happily credit the wrong treasury. */
    return "Only the operating corporation declares dividends.";
  }

  const step = state.operating_sub_phase;
  /* AN UNKNOWN CURSOR IS ALLOWED THROUGH, deliberately. `operating_sub_phase` is optional on the response
     and a seeded or legacy state can arrive without one; refusing there would brick a board on the strength
     of a missing field rather than a broken rule. The duplicate this module exists to stop always has a
     cursor, because the message that created the duplicate is the one that moved it. */
  if (step === undefined) return null;

  if (step !== DIVIDEND_SUB_PHASE) {
    /* THE REPORTED BUG, and it reads as an ordinary rule because it is one. After the first declaration the
       cursor is on Hardware, so a second declaration for the same turn lands here. */
    return `${companyId} has already settled its dividends this turn.`;
  }

  return null;
}

/** Convenience for the market atom, which asks the same question about a company id and wants a boolean.
 *  Design note #748a: the CHART must refuse whatever the BOARD refuses. That atom advances first and
 *  independently, so without this the refused declaration would still walk the token -- and the visible
 *  symptom would be exactly the one that was reported, a price move with nothing behind it. */
export function dividendRefused(state: GameStateResponse | null | undefined, companyId: number): boolean {
  if (!state) return false;
  return dividendRefusal(state, companyId) !== null;
}
