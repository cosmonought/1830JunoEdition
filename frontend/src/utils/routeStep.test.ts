// frontend/src/utils/routeStep.test.ts
//
// ==================================================================
//  DESIGN NOTE 707 (harness): MUST RUN, MAY SKIP, CANNOT TELL
// ==================================================================
//
// REPORTED: "On 'Run Routes' subpanel, there is a 'Skip Run Routes' button even when a corporation has trains
// and a valid route ... the game is very strict that players MUST run routes if they can."
//
// The fix is one condition, so what is worth testing is the SHAPE OF THE THREE ANSWERS rather than the
// condition itself. Two of them look like "do not block" and are true for opposite reasons, and collapsing
// them is how this comes back:
//
//   a positive figure  -> MUST run. Withdraw Skip.
//   zero               -> a real answer: trains that reach nothing. Skip is how the corporation leaves.
//   null               -> ignorance. The chain has not reported a roster, or the probe could not run.
//                         Withdrawing Skip here would strand a player on a step they cannot complete.
//
// The `null` case is the one a future simplification will want to fold into `<= 0` or into `!maxRouteRevenue`,
// and either would trap somebody. #703 records the same mistake made with the train limit: a guess took a
// legal move away. So it gets its own cases, and they say why.
//
// AND THE SCOPE IS TESTED, because #278 withdrew Skip on Dividends and left it correct on Track and Tokens --
// declining to lay track is an ordinary strong play (#674); declining to run at all is not.
//
// WHAT IS COMPULSORY IS RUNNING, NOT RUNNING WELL. Reported of the first draft: "corporations are not required
// to run the best route they can reach." A president may run a shorter route than the one available, and the
// obligation is only to run something. `maxRouteRevenue` is therefore an EXISTENCE PROOF and never a target,
// which is a claim about the wording as much as the logic -- so the sentence is asserted not to quote it.

import { mustRunRoutes, routeRunObligation, type RouteStepInput } from "./routeStep";

function at(over: Partial<RouteStepInput> = {}): RouteStepInput {
  return { orSubPhase: "Routes", maxRouteRevenue: 180, ticker: "B&O", ...over };
}

describe("a corporation that can run must run", () => {
  it("withdraws Skip when a route earns something", () => {
    // THE REPORT: trains, a valid route, and a Skip button.
    expect(mustRunRoutes(at())).toBe(true);
  });

  it("says what is owed without saying which route pays it", () => {
    /* #619: say the obligation, do not only refuse it -- and say the RIGHT obligation. The first draft read
       "must run — 1830 requires the best route it can reach, worth $180", which required a maximum the rules
       do not, and named a figure that turned an existence proof into a target. */
    expect(routeRunObligation(at())).toBe(
      "B&O has a route it can run, so it must. Which route is up to you.",
    );
  });

  it("quotes no revenue figure at all", () => {
    /* THE REGRESSION GUARD, stated over the whole string rather than as an equality, so a reworded sentence
       that reintroduces the number still fails. `maxRouteRevenue` gates this message and must never appear
       in it. */
    for (const revenue of [180, 90, 1000]) {
      const line = routeRunObligation(at({ maxRouteRevenue: revenue }));
      expect(line).not.toContain(String(revenue));
      expect(line).not.toContain("$");
      expect(line).not.toMatch(/best/i);
    }
  });

  it("still names an obligation without a ticker to name it with", () => {
    expect(routeRunObligation(at({ ticker: null }))).toContain("This corporation has a route");
  });
});

describe("the two ways of not blocking are not the same way", () => {
  it("permits Skip when the trains reach nothing worth running", () => {
    /* ZERO IS AN ANSWER. #484a: a corporation the chain reported with an empty token list "has nowhere to
       start: that is the answer, not ignorance." There is genuinely nothing to run, and Skip is the exit. */
    expect(mustRunRoutes(at({ maxRouteRevenue: 0 }))).toBe(false);
    expect(routeRunObligation(at({ maxRouteRevenue: 0 }))).toBeNull();
  });

  it("permits Skip when the probe could not answer", () => {
    /* NULL IS IGNORANCE. A roster the chain has not reported is not a roster known to have a route, and
       withdrawing the only exit from a step on a guess strands the player. */
    expect(mustRunRoutes(at({ maxRouteRevenue: null }))).toBe(false);
  });

  it("does not treat ignorance as zero", () => {
    /* The assertion that survives a refactor to `!maxRouteRevenue`, which would pass every test above and
       still be correct here -- so this one states the DISTINCTION rather than the outcome. Both permit Skip,
       and they must stay two branches because only one of them is a fact about the board. */
    const unknown = at({ maxRouteRevenue: null });
    const nothing = at({ maxRouteRevenue: 0 });
    expect(routeRunObligation(unknown)).toBeNull();
    expect(routeRunObligation(nothing)).toBeNull();
    // A negative total is not a thing the probe returns, but if it ever were it is not an obligation either.
    expect(routeRunObligation(at({ maxRouteRevenue: -1 }))).toBeNull();
  });
});

describe("the rule is about Run Routes and nothing else", () => {
  it("leaves Skip alone on Track", () => {
    /* #674: "not laying track to keep $120 for a train ... [is an] ordinary strong play". The revenue figure
       is irrelevant off the Routes step and must not leak into one where declining is legal. */
    expect(mustRunRoutes(at({ orSubPhase: "Track" }))).toBe(false);
  });

  it("leaves Skip alone on Tokens", () => {
    expect(mustRunRoutes(at({ orSubPhase: "Tokens" }))).toBe(false);
  });

  it("says nothing on Dividends, which #278 already governs", () => {
    /* Two rules, one step apart, and neither should reach into the other's: #278 removes Skip on Dividends by
       its own condition, and a second source doing it too would be a fact in two places. */
    expect(routeRunObligation(at({ orSubPhase: "Dividends" }))).toBeNull();
  });

  it("says nothing outside an Operating Round step", () => {
    expect(mustRunRoutes(at({ orSubPhase: null }))).toBe(false);
  });
});

describe("the predicate and the reason cannot disagree", () => {
  it("agrees on every case above", () => {
    const cases: RouteStepInput[] = [
      at(),
      at({ maxRouteRevenue: 0 }),
      at({ maxRouteRevenue: null }),
      at({ orSubPhase: "Track" }),
      at({ orSubPhase: "Tokens" }),
      at({ orSubPhase: "Dividends" }),
      at({ orSubPhase: null }),
    ];
    for (const input of cases) {
      expect(mustRunRoutes(input)).toBe(routeRunObligation(input) !== null);
    }
  });
});
