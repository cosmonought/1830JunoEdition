// frontend/src/components/badgeDodgesCities.test.ts
//
// ==================================================================
//  DESIGN NOTE 1394 (harness): A BADGE DODGES THE TILE'S OWN CITIES
// ==================================================================
//
// REPORTED: "The OO tiles have collisions on the cities, revenue markers, and OO markers, when there are free
// spaces to put them instead?"
//
// The slot engine blocked slots by live EDGES only; a laid OO tile's city rings sit at corners the badge
// preferences reach for first. `slotsBlockedByTileMarkers` blocks by geometry, and both badge passes take it.

import { readStripped } from "../utils/sourceScan";
import { slotsBlockedByTileMarkers } from "./hexCanvasPrimitives";

describe("slotsBlockedByTileMarkers (design note #1394)", () => {
  it("626 at orientation 0 blocks the upper-right and lower-left corners its cities sit on", () => {
    const blocked = slotsBlockedByTileMarkers(626, 0);
    // Cities at (0.433, -0.25) = corner slot 8 and (-0.433, 0.25) = corner slot 11.
    expect(blocked.has(8)).toBe(true);
    expect(blocked.has(11)).toBe(true);
    // The opposite corners are clear.
    expect(blocked.has(9)).toBe(false);
    expect(blocked.has(12)).toBe(false);
  });

  it("turns with the tile", () => {
    // One step of orientation turns the artwork 60 degrees anticlockwise on screen: the upper-right city
    // moves to the top point (slot 7), the lower-left one to the bottom point (slot 10).
    const blocked = slotsBlockedByTileMarkers(626, 1);
    expect(blocked.has(7)).toBe(true);
    expect(blocked.has(10)).toBe(true);
    expect(blocked.has(8)).toBe(false);
    expect(blocked.has(11)).toBe(false);
  });

  it("a single centred city blocks only the centre and the two edges its straight runs to (#1405: rails count)", () => {
    // 57 is a straight through a centred city: the centre and the two edge midpoints on that axis are taken;
    // every corner is clear.
    const straight = Array.from(slotsBlockedByTileMarkers(57, 0)).sort((a, b) => a - b);
    expect(straight).toHaveLength(3);
    expect(straight[0]).toBe(0);
    expect(straight.slice(1).every((slot) => slot >= 1 && slot <= 6)).toBe(true);
    // 14's pill lies along an axis with four rails: no corner is taken.
    const pill = Array.from(slotsBlockedByTileMarkers(14, 0));
    expect(pill.every((slot) => slot <= 6)).toBe(true);
    expect(pill.some((slot) => slot >= 7)).toBe(false);
  });

  it("882 (brown TO) leaves the top and bottom points open although every edge is live (#1405)", () => {
    // The edge-guard rule blocked all twelve slots here; the sampled rails bend into the cities and leave
    // the two points free -- which is where the badge and the TO letter now go.
    const blocked = slotsBlockedByTileMarkers(882, 0);
    expect(blocked.has(7)).toBe(false);
    expect(blocked.has(10)).toBe(false);
    expect(blocked.has(8)).toBe(true); // a pill cap
    expect(blocked.has(2)).toBe(true); // the E arm
  });

  it("66's city at the top blocks the top point; the centre city blocks nothing", () => {
    const blocked = slotsBlockedByTileMarkers(66, 0);
    expect(blocked.has(7)).toBe(true);
    expect(blocked.has(10)).toBe(false);
  });

  it("an unknown tile blocks nothing", () => {
    expect(slotsBlockedByTileMarkers(999999, 0).size).toBe(0);
  });
});

describe("both badge passes take the marker set (design note #1394)", () => {
  const PRIMS = readStripped("components/hexCanvasPrimitives.ts");
  const GRID = readStripped("components/HexGridRenderer.tsx");

  it("drawValueBadge takes the tile's own set in place of the edge guess (#1405)", () => {
    expect(PRIMS).toContain("tileBlocked?: ReadonlySet<number>,");
    expect(PRIMS).toContain("const blocked = tileBlocked ? new Set(tileBlocked) : slotsBlockedByEdges(liveEdges, false);");
  });

  it("drawRestrictionBadge looks the laid tile up itself and uses its drawing (#1405)", () => {
    expect(PRIMS).toContain(
      "const blocked = laid ? slotsBlockedByTileMarkers(laid.tile_id, laid.orientation) : hexBlockedSlots(mapGrid, q, r);",
    );
  });

  it("the TO tiles get a revenue badge (#1405)", () => {
    expect(GRID).toContain('catalogEntry.terrain !== "TorontoHub"');
    expect(PRIMS).toContain("TorontoHub: \"square\",");
  });

  it("the laid-tile revenue pass passes the tile's markers", () => {
    expect(GRID).toContain("const markerBlocked = slotsBlockedByTileMarkers(tile.tile_id, tile.orientation);");
  });
});
