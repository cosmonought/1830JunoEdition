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
    DESIGN NOTE 1182: WRITTEN, SHIPPED, AND REVERTED WITHIN A DAY
   ==================================================================
   REPORTED, from the log: an Operating Round in which one client laid a tile, ran routes and declared
   dividends for a corporation the board was not operating. Everything applied except the declaration, which
   `dividendRefusal` below refused. I extended that same check to the tile lay, the route run and the station
   token so a divergent client would be refused everywhere rather than only at the last step.
   THREE REPORTS FOLLOWED, AND EVERY ONE IS A THING THAT VANISHED RATHER THAN A THING THAT WAS WRONG:
     "my corporation's station tokens only show on my screen; all anyone else sees is my home station token"
        -- home stations arrive as `PlaceHomeStation`, which I had not touched; placed ones arrive as
        `PlaceStationToken`, which I had. The unguarded arm rendered everywhere, the guarded one only where
        the check happened to pass.
     "on the Run Routes subphase of other players' corporations, the train chips are not displaying the value
        of their runs" -- the watcher's chips read `last_run_breakdown`, which the refused `RunMultipleRoutes`
        arm never wrote. Presence carries a live figure only while the president is plotting, so a watcher
        looking at a finished run had nothing to fall back on.
   THAT IS THE SIGNATURE OF THIS CLASS OF MISTAKE. A refusal keyed on a diverging value does not announce
   itself; it deletes things from some screens and not others, and each deletion looks like its own bug in its
   own subsystem. Three reports, three subsystems, one line of reasoning.
   MY JUSTIFICATION WAS WRONG, and this is the part worth keeping. I argued the check was safe because "both
   sides come out of the log" -- the corporation travels in the message, and the cursor is rebuilt by the
   replay. The second half is false. `active_corporation_index` is only meaningful against
   `active_operating_order`, which `buildOperatingOrder` sorts on three keys read from the CLIENT-LOCAL market
   chart. So the comparison silently depended on the one value this room had already proved can differ between
   clients, and a refusal keyed on it makes a board's CONTENTS depend on that disagreement.
   WHICH IS #1174's MISTAKE IN A DIFFERENT HAT. That one read `active_player_index` and #549 caught it in the
   suite; this one read `active_corporation_index` and no test caught it, because the divergence it depends on
   cannot be reproduced by replaying one log in one process. The lesson is not "do not read the cursor" -- it
   is that a refusal may only compare things that are IDENTICAL ON EVERY CLIENT BY CONSTRUCTION, and the
   operating queue is not one of them until it is derived from the log alone.
   `dividendRefusal` BELOW IS LEFT EXACTLY AS IT WAS. It has the same weakness in principle and it has been
   shipping since #748 without producing a report -- the difference is that a refused declaration is a visible
   failure the table can talk about, while a refused tile or token is a board that quietly differs. Removing
   it is the audit's call, not a patch's.
   THE REAL FIX IS UPSTREAM: make the operating order a function of the log rather than of each client's
   chart. Until then, a divergent queue is a bug to fix at the source, not a thing to refuse actions over. */

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
