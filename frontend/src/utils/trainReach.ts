// frontend/src/utils/trainReach.ts
//
// How far a train may run, asked once.
//
// ==================================================================
//  DESIGN NOTE 881: ONE QUESTION, FOUR ANSWERS, THREE OF THEM DIFFERENT
// ==================================================================
//
// FOUND BY AUDIT rather than by report, while ranking `App.tsx`'s callbacks for extractable rules. Four
// places decided how many revenue centres a train may visit, and no two agreed:
//
//   `trainDrafts`        `cap !== 999 && centres > cap`, with `maxDistance ?? SMALLEST_TRAIN_CAPACITY` (2)
//   `handleRouteHexClick` `cap !== null && centres > cap`, with `maxDistance ?? null` -- no sentinel at all
//   `handleAutoRoute`     `maxDistance ?? 4`
//   `routeAutoTrace`      `maxRevenueCentres >= 999 ? MAX_PATH_HEXES : ...`
//
// THE DIESEL BUG IS THE VISIBLE ONE: the click path has no `999` test, so it would refuse a Diesel a
// thousand-and-first stop while the draft path exempts it. Unreachable in play -- nobody clicks a thousand
// hexes -- which is exactly why it survived.
//
// TWO MORE UNDERNEATH IT. The sentinel is tested as `!== 999` in one place and `>= 999` in another, so a
// hypothetical 1000-reach train would be flagged as over-long by the first and treated as unlimited by the
// second. And an UNKNOWN train -- a model this build's catalog does not carry -- is worth 2 stops to the
// flag, 4 to the auto-router, and infinity to the click.
//
// ==================================================================
//  THE ASYMMETRY IS REAL AND IS KEPT, DELIBERATELY
// ==================================================================
//
// The obvious tidy-up is one number for all four. That would be wrong, because the two questions have
// opposite failure costs and the codebase has already reasoned about both ends:
//
//   REFUSING A CLICK on ignorance stops a player drafting a route that may be perfectly legal, and they are
//   given no way to find out why. `trackReach.ts` #0's rule -- "UNKNOWN OPENS THE BOARD UP" -- is the same
//   judgement: the cost of being wrong is a thing wrongly forbidden.
//   CLEARING THE FLAG on ignorance lets an over-long route reach the dispatch unchallenged. #285 said it
//   directly: "an absent figure is ignorance and must not read as one [an unlimited]".
//
// So an unknown train is UNLIMITED when deciding what a player may draw, and SMALLEST when deciding whether
// what they drew is too long. A player can then draft a route the panel marks over-long, which reads as the
// app saying "I don't know this train, and this looks too far" -- and that is the honest state to be in.
// What they cannot do is be silently refused, or silently allowed to run it.

import { SMALLEST_TRAIN_CAPACITY } from "./gameConstants";

/** The Diesel's "unlimited", as the catalog spells it. */
export const UNLIMITED_REACH = 999;

/** Whether a reach figure means "no limit".
 *
 *  `>=`, NOT `===`. The catalog writes exactly 999 today; a table that ever wrote 1000 to mean the same
 *  thing would be flagged as over-long by an equality test, which is the failure mode of a magic number
 *  compared literally in four places. */
export function isUnlimitedReach(reach: number | null | undefined): boolean {
  return reach !== null && reach !== undefined && reach >= UNLIMITED_REACH;
}

/** The reach to plan WITH -- drawing a route, or budgeting a search.
 *
 *  Unknown means unlimited: see the note above. `routeAutoTrace` bounds an unlimited budget by
 *  `MAX_PATH_HEXES` at its own end, so handing it this is safe as well as consistent. */
export function reachForDrafting(maxDistance: number | null | undefined): number {
  return maxDistance ?? UNLIMITED_REACH;
}

/** Whether a route of `centres` revenue centres is too long for this train.
 *
 *  Unknown means the SMALLEST real train, so a route nobody can vouch for is flagged rather than waved
 *  through. An unlimited train never overruns. */
export function overrunsReach(centres: number, maxDistance: number | null | undefined): boolean {
  if (isUnlimitedReach(maxDistance)) return false;
  const cap = maxDistance ?? SMALLEST_TRAIN_CAPACITY;
  return centres > cap;
}
