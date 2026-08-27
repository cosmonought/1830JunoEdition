/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 875 (harness): THE STATE A WATCHER IS ACTUALLY IN
// ==================================================================
//
// REPORTED, AND NOT FOR THE FIRST TIME: "On Run Routes subphase, non-active players STILL cannot see the
// train chips + revenue of the operating corporation. It is imperative that this gets fixed."
//
// THE FIRST TEST IS THE WHOLE BUG. Two previous passes worked this path and both were exercised with routes
// already drawn -- the state where presence carries an entry per train and the row looks right. Nobody tested
// the state a watcher is in for most of the step: watching, before the president has drawn anything.

import { watcherTrainDrafts, RIVAL_ROUTE_INDEX_BASE } from "./watcherRouteChips";

const ROSTER = [
  { trainIndex: 0, model: "3" },
  { trainIndex: 1, model: "3" },
  { trainIndex: 2, model: "4" },
];

/** A tiny board: three named hexes, everything else off-board. */
const BOARD: Readonly<Record<string, string>> = { "0,0": "F16", "1,0": "F18", "2,0": "G19" };
const labelForHex = (q: number, r: number) => BOARD[`${q},${r}`];

/** Prices a route at $10 a stop, so a test can tell one length from another. */
const priceRoute = (labels: readonly string[]) => labels.length * 10;

describe("a watcher sees the fleet before anything is drafted", () => {
  it("gives every train a chip with nothing drafted at all", () => {
    /* THE REPORTED BUG, AS ARITHMETIC. The old builder mapped the DRAFTS, so this returned `[]` -- and the
       row's own `trainDrafts.length > 0` guard then hid it completely. Not a missing chip: a missing row. */
    const chips = watcherTrainDrafts({ roster: ROSTER, actorDrafts: null, labelForHex, priceRoute });
    expect(chips).toHaveLength(3);
    expect(chips.map((chip) => chip.model)).toEqual(["3", "3", "4"]);
  });

  it("gives every train a chip with an EMPTY draft map", () => {
    /* THE OTHER SHAPE OF NOTHING. Presence can publish an entry with no routes in it, and `{}` must behave
       exactly like `null` here -- two spellings of "the president has not drawn anything yet". */
    expect(watcherTrainDrafts({ roster: ROSTER, actorDrafts: {}, labelForHex, priceRoute })).toHaveLength(3);
  });

  it("says nothing rather than zero for an undrafted train", () => {
    /* `null`, NOT `0`. Zero is a run that earned nothing; no route is not that, and the chip prints an em
       dash for one and a figure for the other (#498). */
    const chips = watcherTrainDrafts({ roster: ROSTER, actorDrafts: null, labelForHex, priceRoute });
    chips.forEach((chip) => expect(chip.value).toBeNull());
  });

  it("keeps the trains that have no route when one of them does", () => {
    /* THE MIXED CASE, which is what most of the step looks like: one route drawn, two to go. The old builder
       returned one chip here and the row silently claimed the corporation had one train. */
    const chips = watcherTrainDrafts({
      roster: ROSTER,
      actorDrafts: { 1: [[0, 0], [1, 0]] },
      labelForHex,
      priceRoute,
    });
    expect(chips).toHaveLength(3);
    expect(chips.map((chip) => chip.value)).toEqual([null, 20, null]);
  });
});

describe("the revenue is the president's, and only that", () => {
  it("prices a drafted route from its named hexes", () => {
    const chips = watcherTrainDrafts({
      roster: ROSTER,
      actorDrafts: { 0: [[0, 0], [1, 0], [2, 0]] },
      labelForHex,
      priceRoute,
    });
    expect(chips[0].value).toBe(30);
  });

  it("refuses to price a one-stop draft", () => {
    /* A ROUTE NEEDS TWO ENDS. Handing a single hex to the pricer would earn a figure for a draft in progress
       -- the chip would show money for a route the president is still drawing. */
    const chips = watcherTrainDrafts({
      roster: ROSTER,
      actorDrafts: { 0: [[0, 0]] },
      labelForHex,
      priceRoute,
    });
    expect(chips[0].value).toBeNull();
  });

  it("drops coordinates that are not board hexes", () => {
    /* A malformed draft prices on what survives, and a draft that survives as one hex prices as nothing --
       rather than throwing, or worse, pricing a route with a hole in it as though it were whole. */
    const chips = watcherTrainDrafts({
      roster: ROSTER,
      actorDrafts: { 0: [[0, 0], [99, 99]] },
      labelForHex,
      priceRoute,
    });
    expect(chips[0].value).toBeNull();
  });
});

describe("the key three surfaces join by survives", () => {
  it("offsets a watcher's indices above any real train", () => {
    /* #740's rule: a watcher's overlay must never collide with their OWN drafts on `trainIndex`, which the
       map, the chips and the planner all join on (#373). The map overlay keys rival routes the same way, so
       hovering a chip still lights the right line. */
    const chips = watcherTrainDrafts({ roster: ROSTER, actorDrafts: null, labelForHex, priceRoute });
    expect(chips.map((chip) => chip.trainIndex)).toEqual([
      RIVAL_ROUTE_INDEX_BASE,
      RIVAL_ROUTE_INDEX_BASE + 1,
      RIVAL_ROUTE_INDEX_BASE + 2,
    ]);
  });

  it("leaves room for more trains than 1830 can hold", () => {
    // A corporation holds at most four; the base is room to be wrong in.
    expect(RIVAL_ROUTE_INDEX_BASE).toBeGreaterThan(100);
  });

  it("reads the draft by the train's own index, not by position", () => {
    /* THE ROSTER IS SORTED (`ownedTrainRoster` orders by tier) while `trainIndex` is the position in
       `owned_trains`. Indexing the draft map by array position would attach a route to the wrong train the
       moment a corporation holds two tiers out of order. */
    const shuffled = [
      { trainIndex: 2, model: "4" },
      { trainIndex: 0, model: "3" },
    ];
    const chips = watcherTrainDrafts({
      roster: shuffled,
      actorDrafts: { 2: [[0, 0], [1, 0]] },
      labelForHex,
      priceRoute,
    });
    expect(chips[0].value).toBe(20);
    expect(chips[1].value).toBeNull();
  });
});
