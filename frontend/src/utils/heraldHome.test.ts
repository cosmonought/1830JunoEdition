// Design note #1302: PRR's herald at H12 on the Project 18XX+ board.
//
// The request: "PRR's herald with a $10 revenue sits above the track -- PRR alone can (and must in its first
// turns) count this as its home station, but it is not a city, does not block anyone, and on subsequent
// rounds PRR can opt not to include it." And, ruled: the herald consumes no station token.

import { STANDARD_BOARD, activateBoard, heraldAt, heraldHexFor } from "../components/hexBoardData";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { initialGridFor } from "./initialGrid";
import { stationTokensOf } from "./trackReach";
import {
  hasHeraldHome,
  nextStationTokenCost,
  placeableStationHexes,
  stationTokenPrice,
  stationTokenSlots,
} from "./stationTokens";
import { readStripped } from "./sourceScan";
import {
  isRevenueCentreHex,
  isRouteTerminusHex,
  pendingHomeTokens,
  sandboxRouteBreakdown,
} from "./sandboxSession";
import { autoTraceRoute } from "./routeAutoTrace";
import { citySlotCount } from "./stationTokens";
import type { GameStateResponse } from "./gameState";

const PRR = 1;
const NYC = 2;
const H12 = { q: 2, r: 7 } as const;

const prr = (overrides: Partial<{ station_token_hexes: Array<[number, number]> }> = {}) => ({
  company_id: PRR,
  station_token_hexes: overrides.station_token_hexes ?? ([] as Array<[number, number]>),
  station_tokens: null,
  station_token_limit: 4,
});

describe("the herald on the expanded board", () => {
  beforeAll(() => activateBoard(EXPANDED_BOARD));
  afterAll(() => activateBoard(STANDARD_BOARD));

  it("is PRR's, at H12, for $10 -- and nobody else's", () => {
    expect(heraldAt("H12")).toEqual({ companyId: PRR, revenue: 10 });
    expect(heraldHexFor(PRR)?.label).toBe("H12");
    expect(heraldHexFor(NYC)).toBeNull();
    expect(heraldAt("H10")).toBeNull();
  });

  it("is a root for PRR's network before any token is placed, and only for PRR", () => {
    expect(stationTokensOf(prr())).toEqual([[H12.q, H12.r]]);
    expect(stationTokensOf({ ...prr(), company_id: NYC })).toEqual([]);
    // Not duplicated beside a real token, and real tokens come first.
    expect(stationTokensOf(prr({ station_token_hexes: [[1, 7]] }))).toEqual([[1, 7], [H12.q, H12.r]]);
  });

  it("is not a city: no token can ever be placed there", () => {
    expect(citySlotCount(initialGridFor(EXPANDED_BOARD), H12.q, H12.r, 0)).toBe(0);
  });

  it("consumes no token: PRR keeps four to place, and its first placement is its second station", () => {
    expect(hasHeraldHome(prr())).toBe(true);
    expect(stationTokenPrice(0, true)).toBe(40);
    expect(stationTokenPrice(1, true)).toBe(100);
    expect(stationTokenPrice(0, false)).toBe(0);
    const slots = stationTokenSlots(prr());
    expect(slots).toHaveLength(4);
    expect(slots.map((slot) => slot.cost)).toEqual([40, 100, 100, 100]);
    expect(slots.some((slot) => slot.isHome)).toBe(false);
    expect(nextStationTokenCost(prr())).toBe(40);
    // NYC is unchanged: a free home, then $40.
    expect(stationTokenSlots({ ...prr(), company_id: NYC }).map((slot) => slot.cost)).toEqual([0, 40, 100, 100]);
  });

  it("owes PRR no home token, while NYC still owes its own", () => {
    const state = {
      active_operating_order: [PRR, NYC],
      public_companies: [
        { company_id: PRR, ticker: "PRR", is_floated: true, home_hex_label: "H12", station_token_hexes: [], president: "a" },
        { company_id: NYC, ticker: "NYC", is_floated: true, home_hex_label: "E19", station_token_hexes: [], president: "b" },
      ],
    } as unknown as GameStateResponse;
    const owed = pendingHomeTokens(state, (label) => (label === "E19" ? [7, 4] : label === "H12" ? [2, 7] : null));
    expect(owed.map((entry) => entry.companyId)).toEqual([NYC]);
  });

  it("pays $10 to PRR, nothing to anyone else, and nothing when PRR passes it by", () => {
    const grid = initialGridFor(EXPANDED_BOARD);
    expect(sandboxRouteBreakdown(grid, [{ hex: "H12" }], "Green", PRR)).toMatchObject({
      revenue: 10,
      centres: 1,
      stops: [{ hex: "H12", value: 10 }],
    });
    expect(sandboxRouteBreakdown(grid, [{ hex: "H12" }], "Green", NYC)).toMatchObject({ revenue: 0, centres: 0 });
    expect(sandboxRouteBreakdown(grid, [{ hex: "H12" }], "Green")).toMatchObject({ revenue: 0, centres: 0 });
    expect(sandboxRouteBreakdown(grid, [{ hex: "H12", bypass: true }], "Green", PRR)).toMatchObject({
      revenue: 0,
      centres: 0,
    });
  });

  it("is a revenue centre and a terminus for PRR only", () => {
    const grid = initialGridFor(EXPANDED_BOARD);
    expect(isRevenueCentreHex(grid, "H12", PRR)).toBe(true);
    expect(isRouteTerminusHex(grid, "H12", PRR)).toBe(true);
    expect(isRevenueCentreHex(grid, "H12", NYC)).toBe(false);
    expect(isRouteTerminusHex(grid, "H12", NYC)).toBe(false);
    expect(isRevenueCentreHex(grid, "H12")).toBe(false);
  });

  it("is a network for the token veil: PRR may only place where H12 reaches (design note #1277)", () => {
    /* REPORTED (LPF): "every hex on the board with an open city is illuminated" for PRR. The placement gate
       exempted a corporation with no `station_token_hexes` from the reach check -- right for a corporation
       with no network, wrong for one whose network is a herald. On the opening board nothing is reachable
       from H12 but the printed tile, so no city may be lit at all. */
    const grid = initialGridFor(EXPANDED_BOARD);
    const company = { ...prr(), is_floated: true };
    const lit = placeableStationHexes({
      mapGrid: grid,
      company,
      allCompanies: [company],
      boardHexes: EXPANDED_BOARD.hexes.map((hex) => [hex.q, hex.r] as const),
    });
    expect(lit.size).toBe(0);
    // NYC before its home token is still allowed through: no network of any kind to measure.
    const nyc = { ...prr(), company_id: NYC, is_floated: true };
    const litForNyc = placeableStationHexes({
      mapGrid: grid,
      company: nyc,
      allCompanies: [nyc],
      boardHexes: EXPANDED_BOARD.hexes.map((hex) => [hex.q, hex.r] as const),
    });
    expect(litForNyc.size).toBeGreaterThan(0);
  });

  it("counts as a station for the can-it-run question, so PRR's Routes step is not skipped", () => {
    /* JUNO-CV4 87-89: PRR held a 2-train and no token, and the derived actions skipped Routes and forced a
       withhold. The verdict counted `station_token_hexes` (0); it now counts `stationTokensOf` (the herald). */
    expect(readStripped("utils/derivedActions.ts")).toContain(
      "company.station_token_hexes == null ? undefined : stationTokensOf(company).length",
    );
    expect(readStripped("App.tsx")).toContain(
      "company?.station_token_hexes == null ? undefined : stationTokensOf(company).length",
    );
  });

  it("gives the tracer somewhere to start from on the opening board", () => {
    // No token anywhere, no track beyond the printed tile: the answer is "no route", not "no token".
    const grid = initialGridFor(EXPANDED_BOARD);
    const result = autoTraceRoute({
      mapGrid: grid,
      era: "Green",
      startHexes: stationTokensOf(prr()),
      maxRevenueCentres: 2,
      companyId: PRR,
    });
    expect(result.reason).toMatch(/No route found/);
    expect(result.reason).not.toMatch(/no station token/);
  });
});

describe("the standard board has no herald", () => {
  it("changes nothing for PRR", () => {
    expect(heraldAt("H12")).toBeNull();
    expect(heraldHexFor(PRR)).toBeNull();
    expect(stationTokensOf(prr())).toEqual([]);
    expect(hasHeraldHome(prr())).toBe(false);
    expect(stationTokenSlots(prr()).map((slot) => slot.cost)).toEqual([0, 40, 100, 100]);
  });
});
