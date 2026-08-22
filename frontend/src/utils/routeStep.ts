// frontend/src/utils/routeStep.ts
//
// Whether the Run Routes step may be stepped past.
//
// Design note #707: A CORPORATION THAT CAN RUN MUST RUN.
//
// REPORTED: "On 'Run Routes' subpanel, there is a 'Skip Run Routes' button even when a corporation has trains
// and a valid route. This button must be removed or greyed out -- I was able to skip Run Routes with both a
// train and a valid route, but the game is very strict that players MUST run routes if they can."
//
// THIS IS #278 ONE STEP EARLIER, and #278's own note is where the gap was recorded: it ends "Skip remains
// correct on Track, Tokens and Routes." Its argument was that "once a route runs for more than $0 the money
// EXISTS and the rules give it two destinations" -- and the step before it decides whether that money exists
// at all. A corporation that declines a run it could have made has not chosen a fallback; it has declined an
// obligation, and every consequence #278 protects (the declaration, the market move) is quietly voided
// upstream of the protection.
//
// SKIP IS STILL RIGHT ON TRACK AND TOKENS, which is what makes this a distinction rather than a purge. Laying
// no tile to keep $120 for a train is an ordinary strong play (#674); placing no station is likewise a choice.
// Declining to run at all is not.
//
// WHAT IS COMPULSORY IS RUNNING, NOT RUNNING WELL. Reported of the first draft: "corporations are not required
// to run the best route they can reach." A president may run a shorter route than the one available -- to hold
// a share price down, to keep a rival off a city, or for no reason at all. The obligation is to run.
// THAT MAKES `maxRouteRevenue` AN EXISTENCE PROOF, NOT A TARGET, and the distinction has to survive in the
// wording as well as the logic: a message naming the maximum would read as a requirement to earn it. The
// figure gates the button and never appears in the sentence.
//
// THE PROBE IS `assignRouteSet`, the same search Auto Route runs -- so the button withdraws exactly when Auto
// Route would have found something, and the two cannot disagree about whether a run exists. Design note #414
// built that probe and #484a settled its vocabulary, including the part that matters most here:
//
//   `null` MEANS "COULD NOT TELL", AND NEVER BLOCKS. A corporation whose roster the chain has not reported, or
//   whose tokens are absent from the response, is not a corporation known to have a route. Withdrawing Skip on
//   an unknown would strand a player on a step they cannot complete -- the exact failure mode #703 records for
//   the train limit, where a guess took a legal move away.
//
//   `0` IS AN ANSWER, NOT IGNORANCE. A corporation with trains that reach nothing worth running has genuinely
//   nothing to run, and Skip is how it leaves the step.
//
// See docs/ai_architecture/state_machine.md, routeStep.ts #707.

import type { OperatingSubPhase } from "./operatingCursor";

export interface RouteStepInput {
  /** The step the acting corporation is on. */
  orSubPhase: OperatingSubPhase | null;
  /** `App`'s `maxRouteRevenue`: the best total `assignRouteSet` can find, `0` for "nothing to run", and
   *  `null` for "could not tell". */
  maxRouteRevenue: number | null;
  /** How the reason names the corporation. */
  ticker?: string | null;
}

/** Why this corporation may not step past Run Routes, or `null` if it may.
 *
 *  A REASON RATHER THAN A BOOLEAN, because #619 settled that a control withdrawn without explanation is a
 *  control the player cannot reason about: "say the obligation, do not only refuse it". The caller renders the
 *  string where the button was.
 *
 *  IT NAMES NO FIGURE. The first draft read "must run -- 1830 requires the best route it can reach, worth
 *  $180", and both halves of that were wrong: the rules do not require the BEST route, and quoting the
 *  maximum turns an existence proof into a target. What is owed is a run; which run is the president's. */
export function routeRunObligation(input: RouteStepInput): string | null {
  const { orSubPhase, maxRouteRevenue, ticker } = input;
  if (orSubPhase !== "Routes") return null;
  // See the module note: null is ignorance and must not block; 0 is a real answer that permits Skip.
  if (maxRouteRevenue === null || maxRouteRevenue <= 0) return null;
  const who = ticker ?? "This corporation";
  return `${who} has a route it can run, so it must. Which route is up to you.`;
}

/** The same question as a predicate, for a caller that only gates on it. Derived from the reason so the two
 *  cannot answer differently -- the hazard `dividendStep.ts` #486a describes for a second boolean. */
export function mustRunRoutes(input: RouteStepInput): boolean {
  return routeRunObligation(input) !== null;
}
