/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1181 (harness): THE RING AND THE DOCK, ONE ANSWER AT LAST
// ==================================================================
//
// REPORTED: "when placing Home Station tokens on green/brown tiles, the station glow ring is just centered on
// the tile, not set on the stations."
//
// #698 ALREADY WROTE THE DIAGNOSIS, for the confirm preview rather than the glow: "the preview anchored HERE,
// to a city, and the placed token docks into a SLOT ... On a one-slot city those are the same point, which is
// why this held for so long; on a pill the city's anchor is the gap BETWEEN the two circles a token can
// occupy." It gave the ANCHOR `nextCitySlotPoint` and left the GLOW on `cityNodePoints`, so one of the two
// rings moved onto the circle and the other stayed in the gap.
//
// WHICH IS WHY THE REPORT NAMES GREEN AND BROWN. A yellow city is a single slot, so city and slot coincide;
// an upgrade is exactly what turns a city into a pill and pulls the two points apart.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { homeRingPoints, cityNodePoints, nextCitySlotPoint } =
  require("./stationTokens") as typeof import("./stationTokens");

const RENDERER = readStripped("components/HexGridRenderer.tsx");
const TOKENS = readStripped("utils/stationTokens.ts");
/* ENDED ON THE NEXT DECLARATION, not on a brace. My first draft sliced to the first line-initial "}" and
   caught the one that closes this function's OWN parameter object -- `}): Array<...> {` -- so every
   assertion below ran against the signature and would have failed for a reason that had nothing to do with
   the code. `sourceScan` #886's subject from the other side: an anchor that resolves to the wrong place is
   as bad as one that resolves to nothing. */
const RING_BODY = sliceBetween(TOKENS, "export function homeRingPoints(", "export function soleCityIndex(");

type Grid = import("../components/hexContractTypes").MapGridResponse;

/* A hex with no laid tile and no artwork: `cityNodePoints` returns nothing, which is the honest empty case
   and the one that must not be turned into a centre by a fallback. */
const bareGrid = { tiles: [] } as unknown as Grid;

describe("the ring asks where the token docks, not where the city is", () => {
  it("is resolved through one function, called by the draw pass", () => {
    /* #858's rule, one question over: "the circle that lights and the circle that may be clicked cannot
       diverge." The same applies to the circle that lights and the circle the token appears in. */
    expect(RENDERER).toContain("const litNodes = homeRingPoints({");
    expect(RING_BODY).toContain(
      "nextCitySlotPoint(mapGrid, publicCompanies, q, r, city, centre, hexSize)",
    );
  });

  it("still uses the city nodes only to decide WHICH city is home", () => {
    /* `homeSlotIndex` is a question about cities and stays one -- #584 pairs the ring with the reservation
       marker's own circle, and #742 keeps both lit where the president may choose. What changed is what gets
       drawn once that question is answered, not how it is answered. */
    expect(RENDERER).toContain("const homeSlot = homeSlotIndex(");
    expect(RENDERER).toContain("homeCityIndex: homeSlot,");
  });

  it("treats a null home city as every city, not as an unknown one", () => {
    /* #742's distinction, which #1181 has to carry rather than re-derive: on an OO hex both slots are the
       president's to pick and both must light. */
    const body = RING_BODY;
    expect(body).toContain("homeCityIndex === null ? nodes.map((_, index) => index) : [homeCityIndex]");
  });

  it("falls back to the city node rather than to nothing", () => {
    /* #698's order, preserved: a preprinted OO hex has no artwork to dock into, and a city whose slots cannot
       be resolved is still better rung at its own anchor than left dark. */
    expect(RING_BODY).toContain(
      "const point = slot ?? nodes[city];",
    );
  });
});

describe("the empty cases stay empty", () => {
  it("draws no ring on a hex with no cities at all", () => {
    /* THE FALLBACK THAT MUST NOT EXIST. A centre-point default here is precisely the bug being fixed, and it
       would be invisible: a ring on an empty hex looks like a ring on a hex. */
    expect(cityNodePoints(bareGrid, 0, 0, 40)).toEqual([]);
    expect(
      homeRingPoints({
        mapGrid: bareGrid,
        publicCompanies: [],
        q: 0,
        r: 0,
        hexSize: 40,
        homeCityIndex: null,
      }),
    ).toEqual([]);
  });

  it("returns nothing for a named city that has no geometry", () => {
    expect(
      homeRingPoints({
        mapGrid: bareGrid,
        publicCompanies: [],
        q: 0,
        r: 0,
        hexSize: 40,
        homeCityIndex: 0,
      }),
    ).toEqual([]);
    expect(nextCitySlotPoint(bareGrid, [], 0, 0, 0, { x: 0, y: 0 }, 40)).toBeNull();
  });
});
