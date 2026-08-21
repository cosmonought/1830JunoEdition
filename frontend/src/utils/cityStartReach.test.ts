// frontend/src/utils/cityStartReach.test.ts
//
// ==================================================================
//  DESIGN NOTE 686 (harness): A TOKEN IS IN A CITY, NOT ON A HEX
// ==================================================================
//
// REPORTED: "on NNH's operating turn, during Lay Track, the H18 hex is getting
// illuminated as part of its network ... NNH has no connectivity to H18. I'm
// not sure if it's the same character of issue here."
//
// It is the same character of issue, and it is the last surviving piece of it.
// `trackSegments.ts` #0 and `trackReach.ts` #4 both removed the hex-as-a-node
// model from the WALK -- it steps `(hex, arrival edge)` states, so a crossover
// is two rails rather than a junction. Neither could remove it from the START,
// because a route begins inside a city with no arrival edge, and "every rail on
// the hex" was the only answer the walk had.
//
// THE BOARD SAYS WHY THIS MATTERS, in numbers rather than adjectives:
//   New York (G19) is `[{edges:[1]}, {edges:[4]}]` -- two cities whose spurs do
//   not touch. `hexBoardData` #391 says the same of every OO hex.
//   NNH's home is the TOP-RIGHT city, which #584 derives from the reservation
//   marker, and that city owns edge 1.
//   H18 lies across edge 4 -- the other city's spur.
// So the walk left New York by a rail belonging to a city NNH has no token in,
// and offered a build on the far side of it.
//
// WHAT IS ASSERTED HERE is the geometry of the real board, not a fixture: the
// reported hexes, the reported corporation, the reported symptom. A synthetic
// two-city tile would prove the mechanism and not the report.

import { LANDMARK_TRACKS, STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import { cityExitEdges, liveEdgesForHex } from "../components/hexGeometry";
import { hexKey, layableHexes, reachableTrack, stationTokensOf } from "./trackReach";
import type { MapGridResponse } from "../components/hexContractTypes";

const BARE: MapGridResponse = { game_id: 1, tiles: [] };

/** New York and Philadelphia & Trenton, found rather than typed: a coordinate
 *  written by hand is one board edit away from testing empty space. */
const NEW_YORK = STATIC_BOARD_HEXES.find((hex) => hex.label === "G19")!;
const H18 = STATIC_BOARD_HEXES.find((hex) => hex.label === "H18")!;

/** NNH's home, from the same table the game uses. */
const NNH_HOME = STATION_HOME_HEXES.find((entry) => entry.label === "G19")!;

/** The city index whose spur points at H18 -- derived, so this test cannot
 *  disagree with the board about which city is which. */
const CITY_FACING_H18 = LANDMARK_TRACKS["New York"].findIndex((segment) =>
  segment.edges.some((edge) => {
    const offsets = [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ];
    return (
      NEW_YORK.q + offsets[edge][0] === H18.q && NEW_YORK.r + offsets[edge][1] === H18.r
    );
  }),
);
const OTHER_CITY = CITY_FACING_H18 === 0 ? 1 : 0;

describe("the fixture is the reported board", () => {
  it("puts NNH's home on New York", () => {
    expect(NNH_HOME).toBeDefined();
    expect(NEW_YORK).toBeDefined();
    expect(H18).toBeDefined();
  });

  it("finds New York's two disconnected spurs", () => {
    /* If this ever becomes one segment the whole report is moot and every
       assertion below is measuring a hex that no longer has the shape. */
    expect(LANDMARK_TRACKS["New York"]).toHaveLength(2);
    expect(liveEdgesForHex(BARE, NEW_YORK.q, NEW_YORK.r)).toHaveLength(2);
  });

  it("finds the spur that points at H18", () => {
    expect(CITY_FACING_H18).toBeGreaterThanOrEqual(0);
  });

  it("confirms H18 carries no printed track of its own", () => {
    // An OO hex: two revenue centres, no connecting track (`hexBoardData` #391).
    expect(liveEdgesForHex(BARE, H18.q, H18.r)).toEqual([]);
  });
});

describe("cityExitEdges", () => {
  it("gives each New York city only its own spur", () => {
    const first = cityExitEdges(BARE, NEW_YORK.q, NEW_YORK.r, 0);
    const second = cityExitEdges(BARE, NEW_YORK.q, NEW_YORK.r, 1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first).not.toEqual(second);
  });

  it("falls back to every live edge when the slot is unknown", () => {
    /* `trackReach.ts` #0's rule: the cost of being wrong here is a hex dimmed
       that should not be, so a chain with no recorded slot keeps exactly the
       behaviour it had. */
    expect(cityExitEdges(BARE, NEW_YORK.q, NEW_YORK.r, null)).toEqual(
      liveEdgesForHex(BARE, NEW_YORK.q, NEW_YORK.r),
    );
    expect(cityExitEdges(BARE, NEW_YORK.q, NEW_YORK.r, undefined)).toHaveLength(2);
  });

  it("falls back when the index is past the end", () => {
    // A malformed record must open the board up, not close it.
    expect(cityExitEdges(BARE, NEW_YORK.q, NEW_YORK.r, 7)).toHaveLength(2);
  });

  it("is a no-op on a one-city hex", () => {
    const single = STATIC_BOARD_HEXES.find(
      (hex) => hex.label === "E23", // Boston: one city, one segment
    )!;
    expect(cityExitEdges(BARE, single.q, single.r, 0)).toEqual(
      liveEdgesForHex(BARE, single.q, single.r),
    );
  });
});

describe("NNH's reach from New York", () => {
  const tokenIn = (cityIndex: number) =>
    reachableTrack(BARE, [[NEW_YORK.q, NEW_YORK.r, cityIndex] as const]);

  it("DOES NOT offer H18 from the other city", () => {
    /* THE REPORT. NNH's token is in the city that owns edge 1; H18 is across
       edge 4. Before design note #686 the walk took both spurs from a station
       and H18 was lit. */
    const lay = layableHexes({
      mapGrid: BARE,
      stationHexes: [[NEW_YORK.q, NEW_YORK.r, OTHER_CITY] as const],
    });
    expect(lay.hexes.has(hexKey(H18.q, H18.r))).toBe(false);
  });

  it("DOES offer H18 to a token in the city that faces it", () => {
    /* The other half, and the one that keeps this a fix rather than a blanket
       restriction: the spur is real, and a corporation with a token in THAT
       city may genuinely build across it. */
    const lay = layableHexes({
      mapGrid: BARE,
      stationHexes: [[NEW_YORK.q, NEW_YORK.r, CITY_FACING_H18] as const],
    });
    expect(lay.hexes.has(hexKey(H18.q, H18.r))).toBe(true);
  });

  it("reports one port per city rather than two", () => {
    // `.size`, not a spread: this project targets es5, where iterating a Set
    // needs `downlevelIteration` and `tsc` says so.
    expect(tokenIn(0).ports.size).toBe(1);
    expect(tokenIn(1).ports.size).toBe(1);
  });

  it("keeps H18 out of the NETWORK either way", () => {
    /* It was never in it -- `neighbourAcross` needs rail on both sides and H18
       has none -- which is worth pinning, because the report said "network" and
       the actual fault was one tier over in the extension set. A future change
       that put it in the network would be a different and worse bug. */
    expect(tokenIn(0).hexes.has(hexKey(H18.q, H18.r))).toBe(false);
    expect(tokenIn(1).hexes.has(hexKey(H18.q, H18.r))).toBe(false);
  });

  it("still takes both spurs when no slot was recorded", () => {
    // The pre-#560 chain. Unchanged behaviour, stated so the fallback is not
    // quietly tightened later.
    const lay = layableHexes({
      mapGrid: BARE,
      stationHexes: [[NEW_YORK.q, NEW_YORK.r] as const],
    });
    expect(lay.hexes.has(hexKey(H18.q, H18.r))).toBe(true);
  });
});

describe("stationTokensOf", () => {
  it("prefers the recorded slot", () => {
    const tokens = stationTokensOf({
      station_token_hexes: [[6, 6]],
      station_tokens: [[6, 6, 1]],
    });
    expect(tokens).toEqual([[6, 6, 1]]);
  });

  it("falls back per token, not per company", () => {
    /* `gameState.ts` #560's third state: a hex in `station_token_hexes` with no
       entry means the same as absent FOR THAT TOKEN. A company part-way through
       a migration must not lose the slots it does have. */
    const tokens = stationTokensOf({
      station_token_hexes: [
        [6, 6],
        [5, 7],
      ],
      station_tokens: [[6, 6, 1]],
    });
    expect(tokens).toEqual([[6, 6, 1], [5, 7]]);
  });

  it("survives the field being absent or null", () => {
    expect(stationTokensOf({ station_token_hexes: [[6, 6]] })).toEqual([[6, 6]]);
    expect(
      stationTokensOf({ station_token_hexes: [[6, 6]], station_tokens: null }),
    ).toEqual([[6, 6]]);
  });
});
