// frontend/src/utils/pendingTileCost.test.ts
//
// ==================================================================
//  DESIGN NOTE 673 (harness): THE FIGURE THE PLAYER COMMITS TO
// ==================================================================
//
// REQUESTED: the corporation's treasury should reflect the end-result of a
// track lay, and/or the lay should say what it costs before it happens.
//
// The price was never the missing part -- `HexGridRenderer` #136 has printed
// the terrain fee on unbuilt river and mountain hexes all along, and the radial
// picker has had a tick-and-cross confirm stage since #2. What was missing is
// the CONSEQUENCE: not "this hex costs $120" but "you will have $310 left, and
// the Buy Trains step is two steps away".
//
// So this module projects the result, and the projection is now on screen in
// two places at once. That is what makes these tests worth their length: a
// figure rendered twice is a figure that can be wrong twice, and the two
// surfaces do not compute it -- they read it from here.
//
// THE CASE THAT MATTERS MOST is the upgrade. `execute_lay_tile` charges terrain
// ONCE, on the first build, which is why the board badge disappears the moment
// a hex carries a tile. A projection that billed $120 to upgrade a yellow tile
// on a mountain would be confidently, specifically wrong about the single
// number it exists to report -- and it would be wrong in the direction that
// makes a player skip a move they could afford.

import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import { MOUNTAIN_BUILD_FEE, RIVER_BUILD_FEE, STATIC_BOARD_HEXES } from "../components/hexBoardData";
import {
  describePendingTileCost,
  formatPendingTreasury,
  pendingTileCost,
} from "./pendingTileCost";

const EMPTY: MapGridResponse = { game_id: 1, tiles: [] };

function withTile(q: number, r: number): MapGridResponse {
  const tile: MapTileEntry = { q, r, tile_id: 57, orientation: 0, landmark: null };
  return { game_id: 1, tiles: [tile] };
}

/** A real board hex of each terrain, found rather than hardcoded: a coordinate
 *  typed in by hand is one board edit away from testing empty space. */
function firstHexOfType(type: string): { q: number; r: number } {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.type === type);
  if (!hex) throw new Error(`no ${type} hex on this board`);
  return { q: hex.q, r: hex.r };
}

const MOUNTAIN = firstHexOfType("Mountain");
const RIVER = firstHexOfType("River");
const PLAIN = firstHexOfType("Plain");

describe("the fixture", () => {
  it("found one hex of each terrain", () => {
    // Without this, every assertion below could be measuring the same $0 hex.
    expect(MOUNTAIN).not.toEqual(RIVER);
    expect(RIVER).not.toEqual(PLAIN);
  });
});

describe("pendingTileCost", () => {
  it("charges the mountain fee on unbuilt ground", () => {
    const cost = pendingTileCost(EMPTY, MOUNTAIN.q, MOUNTAIN.r, 1000);
    expect(cost.fee).toBe(MOUNTAIN_BUILD_FEE);
    expect(cost.before).toBe(1000);
    expect(cost.after).toBe(1000 - MOUNTAIN_BUILD_FEE);
  });

  it("charges the river fee on unbuilt ground", () => {
    const cost = pendingTileCost(EMPTY, RIVER.q, RIVER.r, 1000);
    expect(cost.fee).toBe(RIVER_BUILD_FEE);
    expect(cost.after).toBe(1000 - RIVER_BUILD_FEE);
  });

  it("charges nothing on clear ground", () => {
    const cost = pendingTileCost(EMPTY, PLAIN.q, PLAIN.r, 1000);
    expect(cost.fee).toBe(0);
    expect(cost.after).toBe(1000);
  });

  it("CHARGES NOTHING TO UPGRADE, however expensive the ground", () => {
    /* THE CASE. 1830 bills terrain on the first build; an upgrade onto a tile
       already sitting on a mountain is free. Quoting $120 here would talk a
       president out of a move they can afford. */
    const built = withTile(MOUNTAIN.q, MOUNTAIN.r);
    const cost = pendingTileCost(built, MOUNTAIN.q, MOUNTAIN.r, 1000);
    expect(cost.fee).toBe(0);
    expect(cost.after).toBe(1000);
  });

  it("agrees with the board badge about which hexes are free", () => {
    /* `HexGridRenderer` #136 hides the badge once a hex is built, from this
       same pair of lookups. If the two ever disagree, the board and the card
       are quoting different prices for one click. */
    const unbuilt = pendingTileCost(EMPTY, MOUNTAIN.q, MOUNTAIN.r, 500);
    const built = pendingTileCost(withTile(MOUNTAIN.q, MOUNTAIN.r), MOUNTAIN.q, MOUNTAIN.r, 500);
    expect(unbuilt.fee).toBeGreaterThan(0);
    expect(built.fee).toBe(0);
  });

  it("charges nothing off the board", () => {
    // A coordinate no hex occupies is not a $0 hex; it is not a hex. Both
    // answer 0, and only one of them is a fee.
    expect(pendingTileCost(EMPTY, 999, 999, 1000).fee).toBe(0);
  });

  it("keeps an unknown treasury unknown", () => {
    /* `playerFinance.ts` #562's rule. An unknown balance minus a known fee is
       still unknown -- rendering "-$120" there would be a figure no
       corporation has. */
    const cost = pendingTileCost(EMPTY, MOUNTAIN.q, MOUNTAIN.r, null);
    expect(cost.fee).toBe(MOUNTAIN_BUILD_FEE);
    expect(cost.before).toBeNull();
    expect(cost.after).toBeNull();
    expect(cost.short).toBe(false);
  });

  it("reports a shortfall without hiding the figure", () => {
    /* REPORTED, not enforced: what 1830 does about an unaffordable lay is the
       contract's ruling, and a projection that refused to show the number
       would leave the player unable to see how far short they are. */
    const cost = pendingTileCost(EMPTY, MOUNTAIN.q, MOUNTAIN.r, 50);
    expect(cost.short).toBe(true);
    expect(cost.after).toBe(50 - MOUNTAIN_BUILD_FEE);
  });

  it("does not call an exact spend short", () => {
    // Spending the last dollar is legal and lands on zero.
    const cost = pendingTileCost(EMPTY, MOUNTAIN.q, MOUNTAIN.r, MOUNTAIN_BUILD_FEE);
    expect(cost.after).toBe(0);
    expect(cost.short).toBe(false);
  });
});

describe("formatPendingTreasury", () => {
  it("shows both ends of the move", () => {
    /* Design note #670's lesson applied: a lone changed number reads as a
       figure, not as a change. */
    const cost = pendingTileCost(EMPTY, RIVER.q, RIVER.r, 1000);
    expect(formatPendingTreasury(cost)).toBe(`$1000 → $${1000 - RIVER_BUILD_FEE}`);
  });

  it("uses a real arrow, not a hyphen and a bracket", () => {
    const cost = pendingTileCost(EMPTY, RIVER.q, RIVER.r, 1000);
    expect(formatPendingTreasury(cost)).toContain("→");
    expect(formatPendingTreasury(cost)).not.toContain("->");
  });

  it("says nothing about a free lay", () => {
    /* "$1000 → $1000" is an arrow pointing at itself, and a reader who sees
       one on clear ground learns that the arrow means nothing. */
    expect(formatPendingTreasury(pendingTileCost(EMPTY, PLAIN.q, PLAIN.r, 1000))).toBeNull();
  });

  it("says nothing when the treasury is unknown", () => {
    expect(formatPendingTreasury(pendingTileCost(EMPTY, RIVER.q, RIVER.r, null))).toBeNull();
  });
});

describe("describePendingTileCost", () => {
  it("names the fee and what is left", () => {
    const cost = pendingTileCost(EMPTY, MOUNTAIN.q, MOUNTAIN.r, 1000);
    expect(describePendingTileCost(cost)).toBe(
      `Costs $${MOUNTAIN_BUILD_FEE} — treasury $${1000 - MOUNTAIN_BUILD_FEE} after`,
    );
  });

  it("still names the fee when the treasury is unknown", () => {
    /* Half an answer beats none: the price is knowable offline because it is a
       property of the ground, and withholding it would make an offline board
       quieter than it needs to be. */
    const cost = pendingTileCost(EMPTY, MOUNTAIN.q, MOUNTAIN.r, null);
    expect(describePendingTileCost(cost)).toBe(`Costs $${MOUNTAIN_BUILD_FEE}`);
  });

  it("says nothing about a free lay", () => {
    // A permanent "Costs $0" teaches a player to stop reading the line that
    // matters on the two terrains where it does.
    expect(describePendingTileCost(pendingTileCost(EMPTY, PLAIN.q, PLAIN.r, 1000))).toBeNull();
  });
});
