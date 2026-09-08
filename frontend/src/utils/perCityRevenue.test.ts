// Design note #1318: revenue is per CITY -- never per station, never merely per hex.
//
// RULED: "a route that runs through one double-station city, on a TO tile or any other tile, does not receive
// 2x revenue as a result. However, if a route runs through one city (however many stations it has) and then
// another city on the same hex, it does collect the revenue twice."

import { sandboxRouteBreakdown } from "./sandboxSession";
import { STANDARD_BOARD, activateBoard } from "../components/hexBoardData";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { STANDARD_TRAY, activateTray } from "../components/tileTray";
import { PLUS_TRAY } from "../components/tileTrayPlus";
import type { MapGridResponse } from "../components/hexContractTypes";

afterEach(() => {
  activateBoard(STANDARD_BOARD);
  activateTray(STANDARD_TRAY);
});

const path = (...labels: string[]) => labels.map((hex) => ({ hex }));

describe("stations never multiply a city's revenue", () => {
  it("pays a two-station brown city once", () => {
    // #63: one city, two stations, $40, at Pittsburgh.
    const grid: MapGridResponse = {
      game_id: 1,
      tiles: [{ q: 1, r: 7, tile_id: 63, orientation: 0, landmark: null }],
    };
    const breakdown = sandboxRouteBreakdown(grid, path("H8", "H10", "H12"), "Brown");
    expect(breakdown.stops.filter((stop) => stop.hex === "H10")).toEqual([{ hex: "H10", value: 40 }]);
  });

  it("pays a TO tile's double-station city once, and its two cities twice", () => {
    activateBoard(EXPANDED_BOARD);
    activateTray(PLUS_TRAY);
    // #882 at Toronto, orientation 0: city 0 owns E/NE/SE, city 1 owns W/SW/NW. $70 per city.
    const grid: MapGridResponse = {
      game_id: 1,
      tiles: [{ q: 3, r: 3, tile_id: 882, orientation: 0, landmark: null }],
    };
    // In from D12 (east): the eastern city, once, for $70 -- not $140 for its two stations.
    expect(sandboxRouteBreakdown(grid, path("D12", "D10"), "Brown").revenue).toBe(70);
    // In from the east, out, back in from D8 (west): both cities, $140.
    const both = sandboxRouteBreakdown(grid, path("D12", "D10", "C9", "D8", "D10"), "Brown");
    expect(both.stops.filter((stop) => stop.hex === "D10")).toHaveLength(2);
    expect(both.revenue).toBe(140);
    expect(both.hexes).toBe(4); // D10 is still one hex
  });
});

describe("two cities on one hex are two stops; one city twice is one", () => {
  // Brown OO #64 at Dunkirk & Buffalo (E11), orientation 0: city 0 owns E and NW, city 1 owns W and SW. $50 each.
  const grid: MapGridResponse = {
    game_id: 1,
    tiles: [{ q: 3, r: 4, tile_id: 64, orientation: 0, landmark: null }],
  };

  it("collects both cities when the route re-enters by the other city's rail", () => {
    // E13 is east of E11 (city 0); F10 is south-west of it (city 1).
    const twoCities = sandboxRouteBreakdown(grid, path("E13", "E11", "D10", "E9", "F10", "E11"), "Brown");
    expect(twoCities.stops.filter((stop) => stop.hex === "E11")).toEqual([
      { hex: "E11", value: 50 },
      { hex: "E11", value: 50 },
    ]);
  });

  it("collects the same city only once, however many times the route touches it", () => {
    // D10 is north-west of E11 -- city 0 again.
    const sameCity = sandboxRouteBreakdown(grid, path("E13", "E11", "D10", "E11"), "Brown");
    expect(sameCity.stops.filter((stop) => stop.hex === "E11")).toEqual([{ hex: "E11", value: 50 }]);
  });

  it("honours a waypoint that names its city, and dedupes on it", () => {
    const named = (city: number) => ({ hex: "E11", city_node: city });
    expect(sandboxRouteBreakdown(grid, [named(0), named(1)], "Brown").revenue).toBe(100);
    expect(sandboxRouteBreakdown(grid, [named(0), named(0)], "Brown").revenue).toBe(50);
    expect(sandboxRouteBreakdown(grid, [named(1), { hex: "E9" }, named(1)], "Brown").revenue).toBe(50);
  });

  it("changes nothing on a one-city hex", () => {
    // Cleveland (F6), printed $30, touched from two sides: still one payment, as it always was.
    const once = sandboxRouteBreakdown({ game_id: 1, tiles: [] }, path("F4", "F6", "E5", "F6"), "Yellow");
    expect(once.stops.filter((stop) => stop.hex === "F6")).toEqual([{ hex: "F6", value: 30 }]);
    expect(once.hexes).toBe(3);
  });
});
