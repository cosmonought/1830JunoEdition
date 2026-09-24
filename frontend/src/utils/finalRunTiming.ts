// frontend/src/utils/finalRunTiming.ts
//
// ==================================================================
//  DESIGN NOTE 1702 (GR-3): WHEN A FINAL RUN TRAIN GOES, SAID FROM THE BOARD
// ==================================================================
//
// AUTHORITY: `VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md` rev 2 (GR-S15 ... GR-S19) and the GR-1 representation
// in `gameEngine/gentleRustGrace.ts` (DN 1699). This module DISPLAYS that authority; it decides nothing.
//
// A Final Run train (a Gentle Rust reprieve, `pending_rust_trains`) is owed exactly one Operating Turn that BEGINS
// after it rusted, and is removed after that turn's Run Routes. Which turn that is depends on the board, not on
// what the shell last saw:
//   * THE CORPORATION IS OPERATING and the mark was written before its turn began -> the grace turn is the turn in
//     progress: "removed after this turn's Run Routes" (`graceTurnReprieves`).
//   * THE CORPORATION IS OPERATING and the mark was written during this very turn -- it bought the train that
//     rusted its own fleet in Buy Trains -> the turn in progress began before the rust and does not count: the
//     train survives into its NEXT Operating Turn (`pending_rust_doomed_this_turn`, read through
//     `reprievesDoomedThisTurn`). The field exists precisely to tell these two apart.
//   * THE CORPORATION IS NOT OPERATING -> whatever wrote the mark, its grace turn is its next Operating Turn,
//     which is always the safe framing for a corporation that is not the one in its turn.
// "Operating" is `corporationInItsTurn` -- the reducer's own cursor lookup -- never the UI's idea of whose panel
// is open, the event history, a modal that just appeared, or the phase number.
//
// NO COUNTDOWN. Nothing is stored; every surface asks this on the board it is drawing.

import type { GameStateResponse } from "../gameEngine/gameState";
import { corporationInItsTurn, graceTurnReprieves, reprievesDoomedThisTurn } from "../gameEngine/gentleRustGrace";

export interface FinalRunSchedule {
  /** Marks whose Final Run is the corporation's Operating Turn now in progress: removed after THIS turn's Run
   *  Routes. Empty for every corporation that is not operating. Multiset, by model. */
  thisTurn: readonly string[];
  /** Marks whose Final Run is the corporation's NEXT Operating Turn: removed after THAT turn's Run Routes. */
  nextTurn: readonly string[];
  /** Whether the `nextTurn` marks were written during the corporation's own turn in progress (it rusted its own
   *  trains in Buy Trains). Wording only -- "next Operating Turn" is true either way. */
  doomedThisTurn: boolean;
}

const NONE: FinalRunSchedule = { thisTurn: [], nextTurn: [], doomedThisTurn: false };

/** When each of `companyId`'s Final Run trains is removed, read from the board. */
export function finalRunScheduleFor(
  state: GameStateResponse | null | undefined,
  companyId: number | null | undefined,
): FinalRunSchedule {
  if (!state || companyId == null) return NONE;
  const company = (state.public_companies ?? []).find((entry) => entry.company_id === companyId);
  const marks = company?.pending_rust_trains ?? [];
  if (!company || marks.length === 0) return NONE;
  if (corporationInItsTurn(state) === companyId) {
    const doomed = reprievesDoomedThisTurn(company);
    return { thisTurn: graceTurnReprieves(company), nextTurn: [...doomed], doomedThisTurn: doomed.length > 0 };
  }
  return { thisTurn: [], nextTurn: [...marks], doomedThisTurn: false };
}

/* ------------------------------------------------------------------ */
/* The copy. One place, so the chip, the badge and the tests agree.   */
/* ------------------------------------------------------------------ */

/** SR-1's two predicates, never shortened to "doesn't count" (audit §3.1). */
export const FINAL_RUN_LIMIT_AND_OWNERSHIP =
  "It does not count against the train limit, but it is still one of the corporation's trains until it is removed.";

/** The chip tooltip for a Final Run train. `when` is which turn it is owed, or `null` when the surface cannot
 *  say -- the wording then names the rule rather than a turn, and is true in every case. */
export function finalRunChipTooltip(when: "this-turn" | "next-turn" | null): string {
  const lead = "Final Run (Gentle Rust): this train has already rusted.";
  const timing =
    when === "this-turn"
      ? "It stays usable this turn and is removed after this turn's Run Routes."
      : when === "next-turn"
        ? "It stays usable through this corporation's next Operating Turn and is removed after that turn's Run Routes."
        : "It stays usable through its corporation's first Operating Turn that begins after the rust, and is removed after that turn's Run Routes.";
  return `${lead} ${timing} ${FINAL_RUN_LIMIT_AND_OWNERSHIP}`;
}

/** "2-trains", "2-trains and 3-trains" -- the tiers of a set of marks, sorted and without repeats. */
function tiersOf(models: readonly string[]): string {
  const tiers = Array.from(new Set(models)).sort().map((tier) => `${tier}-trains`);
  return tiers.length <= 1 ? (tiers[0] ?? "") : `${tiers.slice(0, -1).join(", ")} and ${tiers[tiers.length - 1]}`;
}

/** The Final Run badge's detail for the operating corporation's bar (#1004/#1033's badge, GR-3 U-2): which of its
 *  Final Run trains go after THIS turn's Run Routes and which survive into its NEXT Operating Turn. */
export function finalRunBadgeDetail(schedule: FinalRunSchedule): string | null {
  const parts: string[] = [];
  if (schedule.thisTurn.length > 0) {
    parts.push(
      `Its ${tiersOf(schedule.thisTurn)} on a Final Run have already rusted: under Gentle Rust they stay usable this turn and are removed after this turn's Run Routes.`,
    );
  }
  if (schedule.nextTurn.length > 0) {
    parts.push(
      schedule.doomedThisTurn
        ? `Its ${tiersOf(schedule.nextTurn)} rusted during this turn's Buy Trains: under Gentle Rust they survive into this corporation's next Operating Turn and are removed after that turn's Run Routes.`
        : `Its ${tiersOf(schedule.nextTurn)} on a Final Run have already rusted: under Gentle Rust they stay usable through this corporation's next Operating Turn and are removed after that turn's Run Routes.`,
    );
  }
  if (parts.length === 0) return null;
  parts.push("Final Run trains do not count against the train limit, but they are still the corporation's trains until removed.");
  return parts.join(" ");
}
