// Design note #1319: a train visits a city once; a later train may visit it again.
//
// RULED: "(i) a city can only ever be visited once by a train, and (ii) a second or later train CAN visit a
// city already visited by a previous train so long as they do not share/reuse any track between their routes,
// which would allow the same city to be scored however many times it's visited."

import { editRouteDraft } from "./routeDraftEdit";
import { stopForArrival } from "../gameEngine/trackReach";
import { applySandboxAction, sandboxRouteBreakdown } from "../gameEngine/sandboxSession";
import { UNLIMITED_REACH } from "../gameEngine/trainReach";
import { STANDARD_BOARD, activateBoard } from "../components/hexBoardData";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { STANDARD_TRAY, activateTray } from "../components/tileTray";
import { PLUS_TRAY } from "../components/tileTrayPlus";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { RoutePoint } from "./routeWaypoints";
import type { GameStateResponse } from "../gameEngine/gameState";

const P = (label: string, q: number, r: number): RoutePoint => ({ q, r, hexLabel: label });
const D12 = P("D12", 4, 3);
const D10 = P("D10", 3, 3);
const C11 = P("C11", 4, 2);
const E11 = P("E11", 3, 4);
const D8 = P("D8", 2, 3);

afterEach(() => {
  activateBoard(STANDARD_BOARD);
  activateTray(STANDARD_TRAY);
});

describe("one train, one visit per city (rule 5b)", () => {
  /* Toronto's #810 at orientation 0: city 0 owns E/NE/SE, city 1 owns NW/W/SW. A straight at E11 (NW-SE) and
     at D8 (E-W) give the route a rail back into Toronto from the south-east and from the west. */
  const grid: MapGridResponse = {
    game_id: 1,
    tiles: [
      { q: 3, r: 3, tile_id: 810, orientation: 0, landmark: null },
      { q: 3, r: 4, tile_id: 9, orientation: 2, landmark: null }, // E11: NW-SE
      { q: 2, r: 3, tile_id: 9, orientation: 0, landmark: null }, // D8: E-W
    ],
  };
  const edit = (points: RoutePoint[], click: RoutePoint) =>
    editRouteDraft({ mapGrid: grid, points, click, displayLabel: click.hexLabel, maxDistance: UNLIMITED_REACH });

  beforeEach(() => {
    activateBoard(EXPANDED_BOARD);
    activateTray(PLUS_TRAY);
  });

  it("refuses re-entering the city the route already stood in, even on a fresh rail", () => {
    // In from D12 (east) the first time -- city 0. Back in from E11 (south-east): city 0 again.
    const result = edit([D12, D10, C11, E11], D10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already stopped at that city on D10/);
  });

  it("allows re-entering the hex into its OTHER city", () => {
    // Back in from D8 (west): city 1, never visited.
    const result = editRouteDraft({
      mapGrid: grid,
      points: [D12, D10, C11, D8],
      click: D10,
      displayLabel: "D10",
      maxDistance: UNLIMITED_REACH,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.points).toHaveLength(5);
    // And that route pays Toronto twice -- once per city (#1318).
    const priced = sandboxRouteBreakdown(grid, [D12, D10, C11, D8, D10].map((p) => ({ hex: p.hexLabel })), "Green");
    expect(priced.stops.filter((stop) => stop.hex === "D10")).toHaveLength(2);
  });
});

describe("the stop a rail arrives at", () => {
  it("tells the two towns of a double-town tile apart by their rails", () => {
    // #1 at Akron & Canton (G7), orientation 0: one town on the E-SW rail, the other on the NE-W rail.
    const grid: MapGridResponse = { game_id: 1, tiles: [{ q: 0, r: 6, tile_id: 1, orientation: 0, landmark: null }] };
    expect(stopForArrival(grid, 0, 6, 0)).toBe(0);
    expect(stopForArrival(grid, 0, 6, 4)).toBe(0);
    expect(stopForArrival(grid, 0, 6, 1)).toBe(1);
    expect(stopForArrival(grid, 0, 6, 3)).toBe(1);
    expect(stopForArrival(grid, 0, 6, 2)).toBeNull(); // no rail on that edge
    // So a route through both towns pays both, and through one town twice pays once.
    // G9 (1,6) is east of G7; F6 (0,5) is north-west... use the rails' own neighbours: G9 (E) and G5 (-1,6, W).
    const both = sandboxRouteBreakdown(grid, [{ hex: "G9" }, { hex: "G7" }, { hex: "G11" }, { hex: "G5" }, { hex: "G7" }], "Yellow");
    expect(both.stops.filter((stop) => stop.hex === "G7")).toHaveLength(2);
  });

  it("answers city 0 for every ordinary hex", () => {
    const grid: MapGridResponse = { game_id: 1, tiles: [{ q: 1, r: 7, tile_id: 57, orientation: 0, landmark: null }] };
    expect(stopForArrival(grid, 1, 7, 0)).toBe(0);
    expect(stopForArrival(grid, 1, 7, 3)).toBe(0);
  });
});

describe("a second train scores the same city again", () => {
  it("prices each route on its own, so two trains through the token city both collect it", () => {
    /* Batch 6 (#1550): the reducer now judges the routes it prices, so the fixture has to be a board the
       routes can actually run on. It used to run F4-F6 and E5-F6 across a bare grid on which Cleveland's
       printed track reaches neither neighbour; the pricing did not care. Three yellow cities in a row on
       plain hexes (C7, C9, C11 -- #57 straights, edges 0/3), the token on the middle one: two 2-trains run
       C7-C9 and C11-C9, each collecting C9 ($20) plus its own end ($20), on separate track (the two stubs of
       C9's straight are two sections, #669). */
    const grid: MapGridResponse = {
      game_id: 1,
      tiles: [
        { q: 2, r: 2, tile_id: 57, orientation: 0, landmark: null },
        { q: 3, r: 2, tile_id: 57, orientation: 0, landmark: null },
        { q: 4, r: 2, tile_id: 57, orientation: 0, landmark: null },
      ],
    };
    const state = {
      game_id: 1,
      current_round_type: "OperatingRound",
      operating_sub_phase: "Routes",
      variants: {},
      player_addresses: ["p1"],
      player_cash: [],
      virtual_bank_vgp: "5000",
      private_companies: [],
      public_companies: [
        {
          company_id: 5,
          ticker: "C&O",
          president: "p1",
          treasury: "100",
          owned_trains: ["2", "2"],
          station_token_hexes: [[3, 2]],
          station_tokens: [[3, 2, 0]],
          station_token_limit: 3,
          is_floated: true,
        },
      ],
      active_operating_order: [5],
      active_corporation_index: 0,
    } as unknown as GameStateResponse;
    const after = applySandboxAction(
      state,
      {
        RunMultipleRoutes: {
          game_id: 1,
          protocol_id: 5,
          routes: [
            [{ hex: "C7" }, { hex: "C9" }],
            [{ hex: "C11" }, { hex: "C9" }],
          ],
          trains: ["2", "2"],
          train_indices: [0, 1],
        },
      } as never,
      { mapGrid: grid, era: "Yellow" },
    );
    const co = after.public_companies.find((entry) => entry.company_id === 5)!;
    expect(Number(co.last_route_revenue)).toBe(80); // $40 each: C9 is collected by both trains (#1319 (ii))
  });
});
