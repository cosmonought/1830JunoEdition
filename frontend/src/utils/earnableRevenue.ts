// frontend/src/utils/earnableRevenue.ts
//
// Whether a corporation can earn anything this turn -- and, separately, whether we are in a position to say.
//
// ==================================================================
//  DESIGN NOTE 1018: A ZERO THAT MEANS "I DID NOT LOOK" IS NOT A ZERO
// ==================================================================
//
// REPORTED: "On the very first Operating Round in which a corporation's trains were able to run, clicking
// 'Run Trains' instantly auto-skipped the player directly to the 'Buy Trains' subphase. Audit the auto-skip
// evaluation logic to ensure it doesn't eagerly skip the route phase before the initial state is fully
// processed."
//
// THE SKIP IS DISPATCHED ONCE AND IS THEN UNREVISABLE. `autoSkippedRef` marks a `(turn, corporation, step)`
// key the moment it fires, which is right -- #774 added it because every seated browser was appending its own
// advance -- and it means the FIRST answer this predicate gives is the only one it will ever give. An input
// that is still settling does not get corrected; it gets committed.
//
// AND THE PREDICATE HAD NO WAY TO DECLINE. `assignRouteSet` returns `{ totalRevenue: 0, reason }` for three
// different situations -- no token to start from, no train to run, and a genuine search that found nothing --
// and `maxRouteRevenue` returned `result.totalRevenue`, discarding the reason. So "I could not evaluate this"
// and "there is nothing to earn" arrived at the auto-skip as the same number, and the auto-skip skips on that
// number. That is #232's rule broken in the direction that costs a player their turn: `undefined` means "the
// chain did not say", never "there are none".
//
// THE BOARD IS THE INPUT THAT SETTLES LAST. `mapGrid` initialises to `MOCK_MAP_GRID`, whose `tiles` is `[]`
// -- a value indistinguishable from a real board with nothing laid on it. A route search over a bare board
// correctly finds nothing, and on the first Operating Round where trains exist there is always track: by then
// an empty grid means "not loaded", not "not built". So an empty board is an ADMISSION OF IGNORANCE here
// rather than an answer, which is the one addition that turns the reported symptom off.
//
// THREE STATES, NOT TWO, AND THE AUTO-SKIP ACTS ON ONE OF THEM. `"unknown"` is not a soft `"cannot-earn"`:
// the whole point is that it must not dispatch anything. Holding a player on a step they could have skipped
// costs them a click; skipping a step they could have run costs them their entire turn's income, and #414's
// own note draws the same asymmetry for the case it was fixing.

import type { MapGridResponse } from "../components/hexContractTypes";

export type EarnableVerdict =
  /** It can run something. Do not skip. */
  | { kind: "can-earn" }
  /** It provably cannot. This -- and only this -- is a reason to skip the step. */
  | { kind: "cannot-earn"; reason: string }
  /** Not answerable yet. Do not skip, do not withhold, ask again next render. */
  | { kind: "unknown"; why: string };

export interface EarnableInput {
  /** The corporation's fleet, straight off the chain. `null`/`undefined` means it has not said. */
  ownedTrains: readonly string[] | null | undefined;
  /** Where its routes may start. `null`/`undefined` means the chain has not said. */
  stationTokenCount: number | null | undefined;
  /** The board the search would run over. */
  mapGrid: MapGridResponse;
  /** The pathfinder's answer, run lazily -- it is the expensive part and three of the guards below settle the
   *  question without it. */
  searchRevenue: () => number | null;
}

export function earnableRevenueVerdict(input: EarnableInput): EarnableVerdict {
  const { ownedTrains, stationTokenCount, mapGrid, searchRevenue } = input;

  /* #293's rule, kept: `undefined` is "this chain does not say", and skipping a step on a guess takes the
     player's turn away from them. */
  if (ownedTrains == null) {
    return { kind: "unknown", why: "the chain has not reported this corporation's trains" };
  }
  if (ownedTrains.length === 0) {
    return { kind: "cannot-earn", reason: "it owns no trains, so there is no route to run" };
  }

  if (stationTokenCount == null) {
    return { kind: "unknown", why: "the chain has not reported this corporation's stations" };
  }
  /* A corporation the chain reported with an empty token list has nowhere to start, and #484a's rule is that
     this IS the answer rather than an absence of one. */
  if (stationTokenCount === 0) {
    return { kind: "cannot-earn", reason: "it has no station on the board to run from" };
  }

  /* ==================================================================
     THE GUARD THE REPORT IS ABOUT
     ==================================================================
     An empty board answers every route search with zero, and it answers a loaded board's questions and an
     unloaded one's identically. On the turn this bug was reported -- the first one where trains can run --
     track has certainly been laid, so `tiles.length === 0` at that moment is a statement about the client,
     not about the game.
     WORTH NOTHING ON A FRESH BOARD, DELIBERATELY: before any tile exists no corporation owns a train either,
     so the arm above has already returned by the time this could matter. */
  if (mapGrid.tiles.length === 0) {
    return { kind: "unknown", why: "the board has not loaded yet" };
  }

  const revenue = searchRevenue();
  /* `null` is the search declining -- #414's "could not tell, never zero". Passed straight through as
     ignorance rather than flattened into a refusal, which is the whole of this module. */
  if (revenue === null) {
    return { kind: "unknown", why: "the route search could not answer" };
  }
  if (revenue === 0) {
    return { kind: "cannot-earn", reason: "its trains cannot reach a route that earns anything" };
  }
  return { kind: "can-earn" };
}

/** The reason to SKIP, or `null`. `unknown` answers `null` -- see the note above on why that asymmetry is the
 *  point rather than a convenience. */
export function skipReasonFor(verdict: EarnableVerdict): string | null {
  return verdict.kind === "cannot-earn" ? verdict.reason : null;
}
