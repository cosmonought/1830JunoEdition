// Design note #1315: upgrading a tokened New York #62 (two two-station cities) to #883 (one four-station
// city) under the Project 18XX+ tile set. Written before any playtest could reach it, because the failure it
// guards against is a quiet one: a token left pointing at a city the new tile does not have reads as a
// zero-slot city with an occupant -- a wall -- to everybody else's routes.

import { planTokenUpgrade, tokenLandingsFor } from "./tokenMigration";
import { fitStationsToUpgrade } from "./stationConnectivity";
import { applySandboxAction } from "./sandboxSession";
import { citySlotCount } from "./stationTokens";
import { cityBlockerFor } from "./cityBlocking";
import { tokenCityIndex, type StationTokenCompany } from "../components/hexContractTypes";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { GameStateResponse } from "./gameState";
import { STANDARD_BOARD, activateBoard } from "../components/hexBoardData";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import { STANDARD_TRAY, activateTray } from "../components/tileTray";
import { PLUS_TRAY } from "../components/tileTrayPlus";

const NY = { q: 6, r: 6 } as const; // G19
const NYC = 2;
const NNH = 7;
const BO = 4;

/* #62 at orientation 1 puts one city on New York's north-east stub and the other on its south-west stub;
   #883 at orientation 3 covers the same four edges with its single four-station city. */
const SIXTY_TWO_ORIENTATION = 1;
const EIGHT_EIGHTY_THREE_ORIENTATION = 3;

const withSixtyTwo: MapGridResponse = {
  game_id: 1,
  tiles: [{ q: NY.q, r: NY.r, tile_id: 62, orientation: SIXTY_TWO_ORIENTATION, landmark: "New York" }],
};

function company(id: number, ticker: string, city: number): StationTokenCompany {
  return {
    company_id: id,
    ticker,
    is_floated: true,
    station_token_hexes: [[NY.q, NY.r]],
    station_tokens: [[NY.q, NY.r, city]],
  } as unknown as StationTokenCompany;
}

beforeAll(() => {
  activateBoard(EXPANDED_BOARD);
  activateTray(PLUS_TRAY);
});
afterAll(() => {
  activateBoard(STANDARD_BOARD);
  activateTray(STANDARD_TRAY);
});

describe("fitStationsToUpgrade merges into a single city", () => {
  it("lands every anchored token at index 0 when the candidate has one city", () => {
    const landing = fitStationsToUpgrade(
      [
        { companyId: NYC, edges: [1, 2] },
        { companyId: NNH, edges: [3, 4] },
        { companyId: BO, edges: [] }, // a free token lands there too: there is nowhere else
      ],
      [[1, 2, 3, 4]],
      [4],
    );
    expect(landing).not.toBeNull();
    expect(Array.from(landing!.entries())).toEqual([[NYC, 0], [NNH, 0], [BO, 0]]);
  });

  it("refuses a merge that would overfill the city", () => {
    const five = [1, 2, 3, 4, 5].map((id) => ({ companyId: id, edges: [1] }));
    expect(fitStationsToUpgrade(five, [[1, 2, 3, 4]], [4])).toBeNull();
    expect(fitStationsToUpgrade(five.slice(0, 4), [[1, 2, 3, 4]], [4])).not.toBeNull();
  });

  it("still refuses a token whose edges no candidate city carries", () => {
    expect(fitStationsToUpgrade([{ companyId: NYC, edges: [0] }], [[1, 2, 3, 4]], [4])).toBeNull();
  });

  it("changes nothing for a two-city candidate without a slot table", () => {
    const landing = fitStationsToUpgrade(
      [{ companyId: NYC, edges: [1] }, { companyId: NNH, edges: [4] }],
      [[1, 2], [3, 4]],
    );
    expect(Array.from(landing!.entries())).toEqual([[NYC, 0], [NNH, 1]]);
  });
});

describe("planning the #62 -> #883 upgrade with tokens in both cities", () => {
  const companies = [company(NYC, "NYC", 0), company(NNH, "NNH", 1), company(BO, "B&O", 1)];

  it("moves all three tokens into the one city, none left free", () => {
    const plan = planTokenUpgrade(withSixtyTwo, NY.q, NY.r, companies, 883, EIGHT_EIGHTY_THREE_ORIENTATION);
    expect(plan).not.toBeNull();
    expect(plan!.anyFree).toBe(false);
    expect(plan!.landings).toEqual([
      { companyId: NYC, ticker: "NYC", fromCityIndex: 0, toCityIndex: 0 },
      { companyId: NNH, ticker: "NNH", fromCityIndex: 1, toCityIndex: 0 },
      { companyId: BO, ticker: "B&O", fromCityIndex: 1, toCityIndex: 0 },
    ]);
    // And the map the lay sends names all three.
    expect(tokenLandingsFor({ plan, actingCompanyId: NYC, chosenCity: undefined })).toEqual([
      [NYC, 0],
      [NNH, 0],
      [BO, 0],
    ]);
  });

  it("is refused when the merged city could not hold everyone", () => {
    const crowded = [...companies, company(1, "PRR", 0), company(3, "CPR", 0)];
    expect(planTokenUpgrade(withSixtyTwo, NY.q, NY.r, crowded, 883, EIGHT_EIGHTY_THREE_ORIENTATION)).toBeNull();
  });
});

describe("the reducer keeps every token inside the tile's cities", () => {
  const state = (): GameStateResponse =>
    ({
      game_id: 1,
      current_round_type: "OperatingRound",
      operating_sub_phase: "Track",
      variants: { expandedMap: true, plusTiles: true },
      terrain_fees_paid: [`${NY.q},${NY.r}`], // New York's water was paid for by the first lay
      player_addresses: ["p1", "p2"],
      player_cash: [],
      virtual_bank_vgp: "5000",
      private_companies: [],
      public_companies: [
        { ...company(NYC, "NYC", 0), president: "p1", treasury: "500", owned_trains: ["D"] },
        { ...company(NNH, "NNH", 1), president: "p2", treasury: "500", owned_trains: ["D"] },
        { ...company(BO, "B&O", 1), president: "p2", treasury: "500", owned_trains: [] },
      ],
      active_operating_order: [NYC, NNH, BO],
      active_corporation_index: 0,
    }) as unknown as GameStateResponse;

  const lay = (tokenCities?: Array<[number, number]>) => ({
    LayTile: {
      game_id: 1,
      protocol_id: NYC,
      q: NY.q,
      r: NY.r,
      tile_id: 883,
      orientation: EIGHT_EIGHTY_THREE_ORIENTATION,
      ...(tokenCities ? { token_cities: tokenCities } : {}),
    },
  });

  const cityOf = (after: GameStateResponse, id: number) =>
    tokenCityIndex(after.public_companies.find((c) => c.company_id === id) as never, NY.q, NY.r);

  it("applies the map the shell sends", () => {
    const after = applySandboxAction(state(), lay([[NYC, 0], [NNH, 0], [BO, 0]]) as never);
    expect([cityOf(after, NYC), cityOf(after, NNH), cityOf(after, BO)]).toEqual([0, 0, 0]);
  });

  it("clamps a token the message did not name -- an older log -- into the only city there is", () => {
    const after = applySandboxAction(state(), lay() as never);
    expect([cityOf(after, NYC), cityOf(after, NNH), cityOf(after, BO)]).toEqual([0, 0, 0]);
  });

  it("leaves every ordinary lay alone", () => {
    // A two-city tile keeps its indices; nothing is clamped where nothing overflows.
    const twoCity = applySandboxAction(
      state(),
      { LayTile: { game_id: 1, protocol_id: NYC, q: NY.q, r: NY.r, tile_id: 62, orientation: 1 } } as never,
    );
    expect([cityOf(twoCity, NYC), cityOf(twoCity, NNH), cityOf(twoCity, BO)]).toEqual([0, 1, 1]);
  });
});

describe("after the merge, New York is a four-slot city and not a wall", () => {
  it("counts four slots, three taken, and blocks nobody through", () => {
    const merged: MapGridResponse = {
      game_id: 1,
      tiles: [{ q: NY.q, r: NY.r, tile_id: 883, orientation: EIGHT_EIGHTY_THREE_ORIENTATION, landmark: "New York" }],
    };
    const companies = [company(NYC, "NYC", 0), company(NNH, "NNH", 0), company(BO, "B&O", 0)];
    expect(citySlotCount(merged, NY.q, NY.r, 0)).toBe(4);
    expect(citySlotCount(merged, NY.q, NY.r, 1)).toBe(0); // there is no city 1 any more
    const blocks = cityBlockerFor({
      actingCompanyId: 1, // PRR, with no token here
      companies,
      slotsAt: (q, r, city) => citySlotCount(merged, q, r, city),
      cityOf: (holder, q, r) => tokenCityIndex(holder as never, q, r),
    });
    expect(blocks(NY.q, NY.r, 0)).toBe(false); // one slot still open
  });
});
