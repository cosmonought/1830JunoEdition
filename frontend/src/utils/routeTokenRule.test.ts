// frontend/src/utils/routeTokenRule.test.ts
//
// ==================================================================
//  DESIGN NOTE 474 (harness): CONTAINS A TOKEN, DOES NOT START AT ONE
// ==================================================================
//
// The reported flaw was a validator requiring a route to begin at or contain
// the corporation's HOME station. The audit found the manual validator
// checked no token at all -- it filtered on revenue, train distance and
// terminus -- so a run drawn entirely across another company's network
// priced up and dispatched.
//
// Both errors are covered here, and they need different tests:
//
//   THE MISSING RULE is caught by asserting a tokenless route is refused.
//   That test fails against the old code, which accepted everything.
//
//   THE WRONG RULE is caught by asserting a route whose token sits in the
//   MIDDLE is accepted, and that a NON-home token counts. Both pass against
//   an implementation that checks "any token" and fail against one that
//   checks the first hex or the home hex -- which is the distinction the
//   report is about and the one a casual test would miss, because a route
//   that happens to start at the home station satisfies every version of
//   the rule at once.

import { routeIncludesOwnedToken, routeTokenBlockReason } from "./routeWaypoints";

/** A short run: three hexes in a line. */
const ROUTE = [
  { q: 1, r: 1 },
  { q: 2, r: 1 },
  { q: 3, r: 1 },
];

/** Pretend the corporation's home is (1,1) and a later token is at (3,1). */
const HOME: readonly [number, number] = [1, 1];
const MIDDLE: readonly [number, number] = [2, 1];
const FAR: readonly [number, number] = [3, 1];
const ELSEWHERE: readonly [number, number] = [9, 9];

describe("routeIncludesOwnedToken", () => {
  it("accepts a token at the START of the run", () => {
    expect(routeIncludesOwnedToken(ROUTE, [HOME])).toBe(true);
  });

  it("accepts a token in the MIDDLE of the run", () => {
    // The case a "must begin at a token" rule would refuse, and the one
    // 1830 explicitly allows.
    expect(routeIncludesOwnedToken(ROUTE, [MIDDLE])).toBe(true);
  });

  it("accepts a token at the END of the run", () => {
    expect(routeIncludesOwnedToken(ROUTE, [FAR])).toBe(true);
  });

  it("accepts a NON-home token with no home token on the route", () => {
    // A corporation that has placed a second token can run nowhere near
    // where it started -- most of what the extra tokens are for. A "must
    // contain the HOME station" rule refuses this.
    expect(routeIncludesOwnedToken(ROUTE, [ELSEWHERE, FAR])).toBe(true);
  });

  it("refuses a run that touches none of the corporation's tokens", () => {
    // The rule that was missing entirely.
    expect(routeIncludesOwnedToken(ROUTE, [ELSEWHERE])).toBe(false);
  });

  it("refuses when the corporation holds no tokens at all", () => {
    expect(routeIncludesOwnedToken(ROUTE, [])).toBe(false);
  });

  it("refuses an empty route", () => {
    expect(routeIncludesOwnedToken([], [HOME])).toBe(false);
  });

  it("matches on coordinates, not on any label", () => {
    // `hexLabel` is a display name ("New York (G19)"); tokens are (q, r).
    // Passing extra fields must not change the answer.
    const labelled = ROUTE.map((p, i) => ({ ...p, hexLabel: `Somewhere ${i}` }));
    expect(routeIncludesOwnedToken(labelled, [MIDDLE])).toBe(true);
  });
});

describe("routeTokenBlockReason", () => {
  it("says nothing for a legal route", () => {
    expect(routeTokenBlockReason(ROUTE, [MIDDLE])).toBeNull();
  });

  it("does not judge a route shorter than two hexes", () => {
    // Not yet a route. Design note #256's own message covers that case, and
    // two errors about one click is one too many.
    expect(routeTokenBlockReason([], [HOME])).toBeNull();
    expect(routeTokenBlockReason([{ q: 1, r: 1 }], [])).toBeNull();
  });

  it("distinguishes 'no tokens yet' from 'wrong place'", () => {
    // Different situations needing different actions from the player: one
    // means place your home station, the other means redraw.
    const noTokens = routeTokenBlockReason(ROUTE, []);
    const wrongPlace = routeTokenBlockReason(ROUTE, [ELSEWHERE]);
    expect(noTokens).not.toBeNull();
    expect(wrongPlace).not.toBeNull();
    expect(noTokens).not.toBe(wrongPlace);
  });

  it("tells a tokenless corporation to place its home station", () => {
    // Since design note #416 that is a deliberate act, so the message names
    // it rather than leaving the player to infer why they cannot run.
    expect(routeTokenBlockReason(ROUTE, [])).toMatch(/home station/i);
  });

  it("says the token may be anywhere along the run", () => {
    // The message must not teach the rule the report complained about.
    const reason = routeTokenBlockReason(ROUTE, [ELSEWHERE]) ?? "";
    expect(reason).toMatch(/anywhere along the run|not just at the ends/i);
    expect(reason).not.toMatch(/home/i);
    expect(reason).not.toMatch(/\bstart\b/i);
  });
});
