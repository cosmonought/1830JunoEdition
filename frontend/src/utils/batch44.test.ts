/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1025 (harness): THE MANUAL DRAW, AT RAIL LEVEL
// ==================================================================
//
// REPORTED, three symptoms of one model error, plus a clarification that settles where the refusal belongs:
//   "The manual router allows visually jumping between disconnected tracks on the same hex (e.g., Tile 45 and
//    Brown OO tiles)."
//   "an error that they cannot re-enter a hex, even when using a completely separate track segment"
//   "throws a 'hex already visited' error instead of a 'no legal connection' error."
//   "the UI will draw discontinuous bits of route as though that were legal ... it would be better to stop
//    them before they get that far, especially when building long Diesel train routes."
//
// SO EVERY CASE HERE ASSERTS THE CLICK, not the submit. `editRouteDraft` is the click handler; a route that
// never enters the draft cannot be drawn, cannot be priced, and cannot reach Run Routes to be refused there.
//
// TILE 45 IS THE HEX THE REPORT NAMES and it is the reason this is testable at all: two curves that share no
// edge, so "which arm am I on" has two different answers and the old rule could not ask. Its edge sets are
// read from `traversalsFrom` in the first describe rather than typed here -- a fixture that asserted the
// artwork would be testing my reading of the catalog instead of the board.

export {};

const { editRouteDraft } = require("./routeDraftEdit") as typeof import("./routeDraftEdit");
const { connectionForClick, segmentsUsedBy, edgeToward } =
  require("./routeConnection") as typeof import("./routeConnection");
const { traversalsFrom } = require("./trackSegments") as typeof import("./trackSegments");
// `liveEdgesForHex` lives with the geometry, not with the segments -- the two modules split at #4.
const { liveEdgesForHex } =
  require("../components/hexGeometry") as typeof import("../components/hexGeometry");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

/** A synthetic patch: tile 45's two unconnected curves in the middle, plain straights on the neighbours.
 *  Coordinates are arbitrary and unrelated to the real board -- this is about tile topology, and using the
 *  shipped map would drag its own connectivity into a question that is not about it. */
const CENTRE = { q: 5, r: 5 };
const around = (edge: number) => {
  const offsets = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ];
  return { q: CENTRE.q + offsets[edge][0], r: CENTRE.r + offsets[edge][1] };
};

/** Every neighbour must carry rail back to the edge it shares with the centre -- the two-sided join (#1) is a
 *  rule about the OTHER hex and this file is not testing it, so the fixture has to satisfy it rather than
 *  assume it.
 *
 *  THE ORIENTATION IS DERIVED, NOT TYPED. The first draft gave every neighbour tile 14 at orientation 0 and a
 *  comment claiming that covered "whatever edge we approach it from". It does not -- tile 14 is a FOUR-spoke
 *  hub, so two of its six edges are blank at any orientation, and the two neighbours facing those edges were
 *  unreachable. One case failed and said so. Rotating until the facing edge is live is both correct and
 *  self-correcting: it cannot drift if the catalog changes, the way a hand-picked orientation would. */
function neighbourOrientation(grid: never, facing: number): number {
  for (let orientation = 0; orientation < 6; orientation += 1) {
    const probe = {
      game_id: 1,
      tiles: [{ q: 0, r: 0, tile_id: 14, orientation }],
    } as never;
    if (liveEdgesForHex(probe, 0, 0).includes(facing)) return orientation;
  }
  void grid;
  return 0;
}

function board(centreTile: number) {
  const blank = { game_id: 1, tiles: [] } as never;
  return {
    game_id: 1,
    tiles: [
      { q: CENTRE.q, r: CENTRE.r, tile_id: centreTile, orientation: 0 },
      ...[0, 1, 2, 3, 4, 5].map((edge) => ({
        ...around(edge),
        tile_id: 14,
        // The edge of the NEIGHBOUR that faces the centre is the opposite of the one we left by.
        orientation: neighbourOrientation(blank, (edge + 3) % 6),
      })),
    ],
  } as never;
}

const point = (hex: { q: number; r: number }, label: string) => ({ ...hex, hexLabel: label });

/** Tile 45's two arms, READ off the board rather than typed. */
function armsOf(mapGrid: never): Array<{ entry: number; exits: number[] }> {
  return liveEdgesForHex(mapGrid, CENTRE.q, CENTRE.r).map((entry) => ({
    entry,
    exits: traversalsFrom(mapGrid, CENTRE.q, CENTRE.r, entry).map((way) => way.exitEdge),
  }));
}

describe("the fixture really has two unconnected tracks", () => {
  /* THE PREMISE. Every case below is vacuous on a hex whose rails all meet -- and a vacuous pass is this
     project's most frequent failure. */
  const grid = board(45);

  it("offers at least four live edges", () => {
    expect(liveEdgesForHex(grid, CENTRE.q, CENTRE.r).length).toBeGreaterThanOrEqual(4);
  });

  it("has an entry edge that cannot reach every other edge", () => {
    /* THE WHOLE POINT OF TILE 45: arriving on one curve leaves you unable to exit by the other curve's edges.
       If this were false the tile would be a hub and the report's jump would be legal. */
    const arms = armsOf(grid);
    const live = liveEdgesForHex(grid, CENTRE.q, CENTRE.r);
    const restricted = arms.find((arm) => arm.exits.length < live.length - 1);
    expect(restricted).toBeDefined();
  });
});

describe("a click may only follow the rail the route is on", () => {
  const grid = board(45);
  const arms = armsOf(grid);
  /* The arm we enter on, and an edge it genuinely cannot reach -- both derived, so this cannot drift from the
     artwork the way a typed pair would. */
  const arm = arms.find((entry) => entry.exits.length > 0)!;
  const reachable = arm.exits[0];
  const unreachable = liveEdgesForHex(grid, CENTRE.q, CENTRE.r).find(
    (edge) => edge !== arm.entry && !arm.exits.includes(edge),
  );

  const enteredFrom = around(arm.entry);
  const draft = [point(enteredFrom, "IN"), point(CENTRE, "MID")];

  it("accepts a click the current arm reaches", () => {
    const edit = editRouteDraft({
      mapGrid: grid,
      points: draft,
      click: point(around(reachable), "OUT"),
      displayLabel: "OUT",
      maxDistance: null,
    });
    expect(edit.ok).toBe(true);
  });

  it("refuses a click on the OTHER track of the same hex", () => {
    /* THE REPORTED BUG. Both neighbours are adjacent to the hex the route is standing on, and the old rule
       appended any adjacent click without asking which rail it was on -- so the line was drawn between two
       tracks that never meet. */
    expect(unreachable).toBeDefined();
    const edit = editRouteDraft({
      mapGrid: grid,
      points: draft,
      click: point(around(unreachable!), "OTHER"),
      displayLabel: "OTHER",
      maxDistance: null,
    });
    expect(edit.ok).toBe(false);
    if (edit.ok) return;
    expect(edit.reason).toMatch(/No track connects/);
  });

  it("refuses it at the CLICK, so no illegal draft is ever built", () => {
    /* THE CLARIFICATION: "it would be better to stop them before they get that far, especially when building
       long Diesel train routes." A refusal at Run Routes would let a player draw twelve hexes and then be
       told the second one was wrong. Asserted as the draft being UNCHANGED -- an `ok: false` that still
       committed points would satisfy the case above and none of the intent behind it. */
    const edit = editRouteDraft({
      mapGrid: grid,
      points: draft,
      click: point(around(unreachable!), "OTHER"),
      displayLabel: "OTHER",
      maxDistance: null,
    });
    expect(edit.ok).toBe(false);
    expect("points" in edit).toBe(false);
  });

  it("leaves the first click free to depart by any rail", () => {
    /* A ROUTE STARTS INSIDE THE STATION, so the opening step has no arrival edge to be bound by -- the same
       exemption the network walk (#4) and the bridge make. Without this the very first move off a two-track
       hex would be refused half the time. */
    const fromCentre = [point(CENTRE, "MID")];
    for (const edge of liveEdgesForHex(grid, CENTRE.q, CENTRE.r)) {
      expect(connectionForClick(grid, fromCentre, around(edge))).not.toBeNull();
    }
  });

  it("refuses a neighbour with no rail facing back", () => {
    /* THE TWO-SIDED JOIN (#1), kept: a stub facing blank cardboard is not a connection. Asserted through a
       board where the neighbour has no tile at all. */
    const lonely = {
      game_id: 1,
      tiles: [{ q: CENTRE.q, r: CENTRE.r, tile_id: 45, orientation: 0 }],
    } as never;
    expect(connectionForClick(lonely, [point(CENTRE, "MID")], around(0))).toBeNull();
  });
});

describe("visited is about rails, not about hexes", () => {
  const grid = board(45);

  it("counts the rails a drafted route has run", () => {
    const arms = armsOf(grid);
    const arm = arms.find((entry) => entry.exits.length > 0)!;
    const walked = [
      point(around(arm.entry), "IN"),
      point(CENTRE, "MID"),
      point(around(arm.exits[0]), "OUT"),
    ];
    expect(segmentsUsedBy(grid, walked).size).toBeGreaterThan(0);
  });

  it("counts nothing for a route that has not crossed anything yet", () => {
    /* INTERIOR TRANSITS ONLY. A two-point route has entered a hex and not yet left one, so it has run no
       rail through anything -- the same "interior only" rule `withForcedBypass` follows. */
    expect(segmentsUsedBy(grid, [point(CENTRE, "MID"), point(around(0), "OUT")]).size).toBe(0);
  });

  it("refuses a step that would run a rail the route already ran", () => {
    /* THE RULE THE OLD COORDINATE CHECK WAS APPROXIMATING, and the half that must survive: 1830 forbids
       running the same track twice, and a rail-level check has to keep refusing that or the fix has traded
       one wrong answer for another. */
    const arms = armsOf(grid);
    const arm = arms.find((entry) => entry.exits.length > 0)!;
    const there = [
      point(around(arm.entry), "IN"),
      point(CENTRE, "MID"),
      point(around(arm.exits[0]), "OUT"),
    ];
    const backAgain = editRouteDraft({
      mapGrid: grid,
      points: there,
      click: point(CENTRE, "MID"),
      displayLabel: "MID",
      maxDistance: null,
    });
    /* Clicking the hex before last is not the one-step undo (#RULE 3 covers only the LAST point), so this
       reaches the rail rule -- and the rail it would run is one this route has already run. */
    expect(backAgain.ok).toBe(false);
  });
});

describe("the refusals arrive in the order a player can act on", () => {
  const grid = board(45);

  it("names the missing connection, not a visit, for an unconnected neighbour", () => {
    /* ITEM 3. The old order asked "has this hex been visited" first, so a player clicking a neighbour they
       had no rail to was sent to look at the wrong part of their own route. Both conditions are true here at
       once, which is the only way to test an ORDER. */
    const arms = armsOf(grid);
    const arm = arms.find((entry) => entry.exits.length > 0)!;
    const unreachable = liveEdgesForHex(grid, CENTRE.q, CENTRE.r).find(
      (edge) => edge !== arm.entry && !arm.exits.includes(edge),
    )!;
    /* The clicked hex is ALREADY on the route -- it is where the route started -- and it is also on the arm
       the route cannot reach. Old order: "already on this route". New order: the truth about the rail. */
    const draft = [
      point(around(unreachable), "START"),
      point(around(arm.entry), "IN"),
      point(CENTRE, "MID"),
    ];
    const edit = editRouteDraft({
      mapGrid: grid,
      points: draft,
      click: point(around(unreachable), "START"),
      displayLabel: "START",
      maxDistance: null,
    });
    expect(edit.ok).toBe(false);
    if (edit.ok) return;
    expect(edit.reason).toMatch(/No track connects/);
    expect(edit.reason).not.toMatch(/already on this route/);
  });

  it("still steps back when the LAST point is clicked again", () => {
    /* #RULE 3's ONE-STEP UNDO, which runs before everything and must keep doing so -- it is the only way out
       of a mis-click, and a connection check in front of it would refuse the escape hatch. */
    const draft = [point(around(0), "IN"), point(CENTRE, "MID")];
    const edit = editRouteDraft({
      mapGrid: grid,
      points: draft,
      click: point(CENTRE, "MID"),
      displayLabel: "MID",
      maxDistance: null,
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    expect(edit.points).toHaveLength(1);
  });

  it("keeps the hex-level rule on the bridge path", () => {
    /* SCOPE, PINNED. A non-adjacent click goes to `bridgeWaypoints`, which keeps a hex-keyed `avoid` set --
       teaching it to propose re-entries is a larger change than this report asks for, and a scope decision
       nobody wrote down is a scope decision somebody re-opens. */
    expect(readStripped("utils/routeDraftEdit.ts")).toContain(
      "points.some((entry) => entry.q === click.q && entry.r === click.r)",
    );
  });
});

describe("a plain hex behaves exactly as it always did", () => {
  /* THE COMPATIBILITY CASE. Tile 9 is a single straight -- one way through, no arms to choose between -- so
     every rule above must be invisible on it. A fix that made ordinary drawing harder would pass every case
     in this file and fail every player. */
  const grid = board(9);

  it("accepts a straight crossing", () => {
    const live = liveEdgesForHex(grid, CENTRE.q, CENTRE.r);
    expect(live.length).toBe(2);
    const edit = editRouteDraft({
      mapGrid: grid,
      points: [point(around(live[0]), "IN"), point(CENTRE, "MID")],
      click: point(around(live[1]), "OUT"),
      displayLabel: "OUT",
      maxDistance: null,
    });
    expect(edit.ok).toBe(true);
  });

  it("computes the edge between two neighbours", () => {
    // The primitive everything above rests on, checked directly so a failure names itself.
    expect(edgeToward(CENTRE, around(2))).toBe(2);
    expect(edgeToward(CENTRE, { q: 99, r: 99 })).toBe(-1);
  });
});
