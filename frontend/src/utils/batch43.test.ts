/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1024 (harness): REMOVE ONE STOP
// ==================================================================
//
// REQUESTED: "Players need the ability to remove individual stops from their route array. Add a 'Remove'
// button (such as a small 'X' icon) to each individual hex/stop ... Clicking the 'X' on a specific hex should
// splice that specific hex (and potentially any hexes that follow it, if your routing logic requires
// contiguous paths from the start node) out of the active route array."
//
// THE PARENTHETICAL IS THE FEATURE, and the first describe is about proving the premise rather than assuming
// it: this app's routes ARE contiguous walks, so a mid-array splice would produce a list claiming two
// non-adjacent hexes are joined -- which nothing downstream checks. That is why removal truncates, and a test
// suite that only checked the splice would not have shown why.
//
// THE SECOND HALF OF THE REQUEST -- "allowing the player to seamlessly resume drawing from the new end point"
// -- is asserted end to end through the real `editRouteDraft`, because "you can carry on" is a claim about
// what happens NEXT and a truncation test alone cannot make it.

export {};

const { truncateRouteAtHex, stopsRemovedByTruncating } =
  require("./routeTruncate") as typeof import("./routeTruncate");
const { editRouteDraft } = require("./routeDraftEdit") as typeof import("./routeDraftEdit");
const { removeStopTitle } =
  require("../components/RouteChipDetail") as typeof import("../components/RouteChipDetail");
const { axialHexDistance } = require("./routeWaypoints") as typeof import("./routeWaypoints");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

/** A real corridor, FOUND rather than typed: H10 - H12 - H14 - H16 run west to east on one row. */
const H10 = STATIC_BOARD_HEXES.find((hex) => hex.label === "H10")!;
const H12 = STATIC_BOARD_HEXES.find((hex) => hex.label === "H12")!;
const H14 = STATIC_BOARD_HEXES.find((hex) => hex.label === "H14")!;
const H16 = STATIC_BOARD_HEXES.find((hex) => hex.label === "H16")!;

const point = (hex: { q: number; r: number; label: string }) => ({
  q: hex.q,
  r: hex.r,
  hexLabel: hex.label,
});

const ROUTE = [point(H10), point(H12), point(H14), point(H16)];

describe("a drafted route really is a contiguous walk", () => {
  /* THE PREMISE THE WHOLE DESIGN RESTS ON. If routes were bags of hexes, plucking one out of the middle would
     be the right implementation and truncation would be gratuitous. Asserted rather than assumed, because
     "potentially, if your routing logic requires it" is the request handing this decision over. */
  it("has every consecutive pair adjacent", () => {
    for (let at = 1; at < ROUTE.length; at += 1) {
      expect(axialHexDistance(ROUTE[at - 1], ROUTE[at])).toBe(1);
    }
  });

  it("would be left claiming a false join by a mid-array splice", () => {
    /* THE COUNTERFACTUAL, stated as arithmetic. Lifting H12 out leaves H10 beside H14, two hexes apart -- a
       list that says they are joined, which the pricer, the bypass marking and the reducer would all read as
       a route. Nothing downstream re-checks adjacency, so this would price a run no train can make. */
    const spliced = [ROUTE[0], ROUTE[2], ROUTE[3]];
    expect(axialHexDistance(spliced[0], spliced[1])).toBeGreaterThan(1);
  });
});

describe("removing a stop truncates from that stop", () => {
  it("drops the stop and everything after it", () => {
    expect(truncateRouteAtHex(ROUTE, "H14").map((p) => p.hexLabel)).toEqual(["H10", "H12"]);
  });

  it("removing the last stop is an ordinary pop", () => {
    // The common case, and the one an 'X' reads as -- worth its own line so the general rule is seen to cover it.
    expect(truncateRouteAtHex(ROUTE, "H16").map((p) => p.hexLabel)).toEqual(["H10", "H12", "H14"]);
  });

  it("removing the first stop empties the route", () => {
    /* HONEST RATHER THAN CLEVER. There is no route left once the start goes, and pretending otherwise -- by
       promoting the second hex to a start it was never drawn as -- would invent a route the player did not
       draw. Same outcome as Clear, reached by a different gesture. */
    expect(truncateRouteAtHex(ROUTE, "H10")).toEqual([]);
  });

  it("returns the SAME array when the hex is not in the route", () => {
    /* BY REFERENCE, which is the property the shell's state write depends on: a stale click on a stop that has
       already gone must be a no-op, not a wipe. `toBe`, not `toEqual` -- an equal-but-new array would pass the
       looser check and still re-render, and on a control a player can double-fire that is the difference
       between nothing happening and the draft clearing. */
    expect(truncateRouteAtHex(ROUTE, "Z99")).toBe(ROUTE);
  });

  it("counts what the removal costs", () => {
    expect(stopsRemovedByTruncating(ROUTE, "H16")).toBe(1);
    expect(stopsRemovedByTruncating(ROUTE, "H12")).toBe(3);
    expect(stopsRemovedByTruncating(ROUTE, "Z99")).toBe(0);
  });

  it("does not mutate the array it was given", () => {
    // `slice`, not `splice` -- the drafts live in React state and a mutation there is invisible until it isn't.
    const before = ROUTE.map((p) => p.hexLabel);
    truncateRouteAtHex(ROUTE, "H12");
    expect(ROUTE.map((p) => p.hexLabel)).toEqual(before);
  });
});

describe("the control says what it will take", () => {
  it("reads as a simple removal for a trailing stop", () => {
    expect(removeStopTitle("H16", 1)).toMatch(/Remove H16/);
    expect(removeStopTitle("H16", 1)).not.toMatch(/after it/);
  });

  it("names the cost for an interior stop", () => {
    /* #783's RULE. An 'X' promises "remove this one", which is true only at the end of a route -- so the
       interior case has to say what it is really going to do rather than let a player find out. */
    const title = removeStopTitle("H12", 3);
    expect(title).toMatch(/2 hexes drawn after it/);
    expect(title).toMatch(/carry on drawing/);
  });

  it("counts one hex in the singular", () => {
    expect(removeStopTitle("H14", 2)).toMatch(/1 hex drawn after it/);
    expect(removeStopTitle("H14", 2)).not.toMatch(/1 hexes/);
  });
});

describe("the player can carry on drawing from the new end", () => {
  /* THE SECOND HALF OF THE REQUEST, and it is a claim about what happens NEXT -- so it is asserted through the
     real draft editor rather than by inspecting the truncated array. */
  const BOARD = {
    game_id: 1,
    tiles: [
      { q: H10.q, r: H10.r, tile_id: 9, orientation: 0 },
      { q: H14.q, r: H14.r, tile_id: 9, orientation: 0 },
      { q: H16.q, r: H16.r, tile_id: 9, orientation: 0 },
    ],
  } as never;

  it("accepts an append onto the truncated route", () => {
    const shortened = truncateRouteAtHex(ROUTE, "H16");
    const edit = editRouteDraft({
      mapGrid: BOARD,
      points: shortened,
      click: point(H16),
      displayLabel: "H16",
      maxDistance: null,
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    expect(edit.points.map((p) => p.hexLabel)).toEqual(["H10", "H12", "H14", "H16"]);
  });
});

describe("the UI offers it, and only to the player who may edit", () => {
  const DETAIL = readStripped("components/RouteChipDetail.tsx");

  it("renders a remove control on each stop", () => {
    const list = sliceBetween(DETAIL, "<span style={styles.stop}>", "</span>\n              </React.Fragment>");
    expect(list).toContain("onRemoveStop(draft.trainIndex, stop.hex)");
  });

  it("keys the removal by hex label, not by list index", () => {
    /* THE PROXY THAT WOULD NOT HAVE STOOD FOR ITS SUBJECT. This list renders PAYING stops; the array being
       spliced is the full walk including plain track. The two are different lengths, so an index here means a
       different hex there -- and the bug would only appear on routes with non-paying hexes in them. */
    expect(DETAIL).toContain("onRemoveStop?: (trainIndex: number, hexLabel: string) => void;");
    expect(DETAIL).not.toContain("onRemoveStop(draft.trainIndex, index)");
  });

  it("hides it from a watcher", () => {
    // The same permission the Clear button carries: a watcher may read the route and may not edit it.
    expect(DETAIL).toContain("{canClear && onRemoveStop && (");
  });

  it("keeps the global Clear alongside it", () => {
    /* GRANULAR EDITING IS AN ADDITION, NOT A REPLACEMENT. Starting over is still one click, and a player who
       wants that should not have to press X four times. */
    expect(DETAIL).toContain("onClearRoute(draft.trainIndex)");
  });

  it("is wired from the shell through the bar", () => {
    /* #1006's LESSON: a helper the deciding caller never asks is not a feature. Both hops asserted, because a
       fix at either end alone leaves the button inert. */
    const app = readStripped("App.tsx");
    expect(app).toContain("onRemoveRouteStop={handleRemoveRouteStop}");
    expect(readStripped("panels/ContextualActionBar.tsx")).toContain(
      "onRemoveStop={onRemoveRouteStop}",
    );
  });

  it("deletes the key rather than storing an empty array", () => {
    /* `routeDrafts[i] ?? []` IS THE IDIOM EVERYWHERE DOWNSTREAM, so an empty array and an absent key mean the
       same thing to every reader -- and only one of them is the shape `handleClearRoute` already writes. Two
       representations of "no route" is how a `length === 0` check and an `in` check come to disagree. */
    const app = readStripped("App.tsx");
    expect(app).toContain("if (next.length === 0) delete updated[trainIndex];");
  });
});
