/** @jest-environment node */
//
// Design note #1511: where a paid station token may go, asked by the authority and not only by the button.
//
// TWO FIXTURES. The first is the live game: the first 96 entries of JUNO-FCJ, frozen under `__fixtures__/`,
// replayed through `RoomEngine` with the server's own providers -- the exact path the server took when it
// applied B&M's token into NNH's home at New York (index 95). The second is a small synthetic corridor
// (borrowed from `stationTokenWall.test.ts`) for the rules the live prefix does not happen to exercise.
//
// EVERY REFUSAL IS ASSERTED TWO WAYS: the sentence `stationPlacementRefusal` gives, and the board the
// reducer leaves behind. The negative controls state the OLD arithmetic and show it answered yes.

import { readFileSync } from "fs";
import { join } from "path";
import { RoomEngine, entriesFromExport, type ExportedEntry } from "../gameEngine/replayLog";
import { effectiveActions } from "../gameEngine/logRevert";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../gameEngine/sandboxState";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { stateDigest } from "../gameEngine/stateDigest";
import { operatingCorporationId } from "../gameEngine/dividendGate";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { stationPlacementRefusal } from "../gameEngine/stationPlacementGate";
import {
  cityCountAt,
  citySlotCount,
  evaluateStationPlacement,
  homeReservedCityIndex,
  nextStationTokenCost,
  stationSlotCount,
} from "../gameEngine/stationTokens";
import { homeReservationStands, stationHomeHexes } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { HEX_NEIGHBOR_OFFSETS } from "../components/hexGeometry";
import { reachableCities, hexKey } from "../gameEngine/trackReach";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

const NNH = 7;
const BM = 8;
const BO = 4;
const CO = 5;
const NEW_YORK = { q: 6, r: 6 }; // G19

/* ------------------------------------------------------------------ */
/* Fixture 1: the live game, to the entry that reproduced the report   */
/* ------------------------------------------------------------------ */

function loadPrefix() {
  const path = join(__dirname, "__fixtures__", "JUNO-FCJ-prefix96.log.jsonl");
  const raw = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExportedEntry);
  const ordered = [...entriesFromExport(raw)].sort((a, b) => a.index - b.index);
  return effectiveActions(ordered);
}

/** The server's engine, replayed to just before `upTo`. */
function engineBefore(upTo: number): RoomEngine {
  const seedState = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const seedWaterfall = waterfallForRoster(
    sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
    [],
  );
  const engine = new RoomEngine(sandboxReplayProviders(), { state: seedState, waterfall: seedWaterfall });
  for (const entry of loadPrefix()) {
    if (entry.index >= upTo) break;
    /* ==================================================================
        DESIGN NOTE 1555 (fixture repair): THE PURCHASE THE LIVE TABLE WAS NEVER ASKED FOR
       ==================================================================
       Entry 74 is B&M, trainless at Buy Trains, passing its turn. The engine that recorded it saw no legal
       route for B&M -- its only route ended on a town (E23-F24) and towns were not termini. Under the S6-10
       ruling (rulebook 6.4: a small city is a city; a route may end at any city) that route IS legal, so the
       Batch-4 obligation gate refuses the pass and the prefix would stall here, one entry before the placement
       at 76 and twenty before the illegal placement at 95 this file exists for. THE CHOICE THE OLD ENGINE
       NEVER REQUIRED IS SUPPLIED HERE, IN THE HARNESS ONLY: a 2-train purchase by B&M at $80 through the
       ordinary arm, exactly what the live table would have been made to do. Nothing is appended to the
       fixture; the prefix on disk is unchanged; B&M's treasury is $80 lighter than the live game's from here,
       which no assertion in this file reads. The divergence is reported in the Batch 6 write-up. */
    if (entry.index === 74) {
      engine.apply({
        index: 74,
        id: `${entry.id}:s6-10-obligation`,
        actor: entry.actor,
        payload: JSON.stringify({ BuyHardwareFromPool: { game_id: 0, protocol_id: 8 } }),
        derived: true,
      });
    }
    engine.apply(entry);
  }
  return engine;
}

const entryAt = (index: number) => loadPrefix().find((entry) => entry.index === index)!;
const company = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)!;
/** The board tables in effect for this game (Level Playing Field, expanded map). */
const underRules = <T,>(state: GameStateResponse, fn: () => T): T =>
  withRules(resolveVariants(state.variants), fn);

describe("the live board at JUNO-FCJ index 95 is the one the report describes", () => {
  const engine = engineBefore(95);
  const state = engine.snapshot.state;
  const grid = engine.snapshot.grid;

  it("has B&M operating at the Tokens step", () => {
    expect(operatingCorporationId(state)).toBe(BM);
    expect(state.operating_sub_phase).toBe("Tokens");
    expect(entryAt(95).payload).toContain('"PlaceStationToken"');
    expect(entryAt(95).payload).toContain('"protocol_id":8');
  });

  it("has NNH unfloated, with its home reservation at New York standing", () => {
    expect(company(state, NNH).is_floated).toBe(false);
    expect(company(state, NNH).station_token_hexes).toEqual([]);
    underRules(state, () => {
      const home = stationHomeHexes().find((entry) => entry.companyId === NNH)!;
      expect([home.q, home.r]).toEqual([NEW_YORK.q, NEW_YORK.r]);
      expect(homeReservationStands(company(state, NNH), home)).toBe(true);
    });
  });

  it("New York is two cities of one slot each, and NNH's home is locked to the first", () => {
    underRules(state, () => {
      expect(stationSlotCount(grid, NEW_YORK.q, NEW_YORK.r)).toBe(2);
      expect(cityCountAt(grid, NEW_YORK.q, NEW_YORK.r)).toBe(2);
      expect(citySlotCount(grid, NEW_YORK.q, NEW_YORK.r, 0)).toBe(1);
      const home = stationHomeHexes().find((entry) => entry.companyId === NNH)!;
      expect(homeReservedCityIndex(grid, home)).toBe(0);
    });
  });
});

describe("Corporation A cannot place an ordinary token into Corporation B's reserved home station (#1511)", () => {
  it("is refused, and the reason names the reservation", () => {
    const engine = engineBefore(95);
    const state = engine.snapshot.state;
    const reason = underRules(state, () =>
      stationPlacementRefusal(
        state,
        { protocol_id: BM, q: NEW_YORK.q, r: NEW_YORK.r, city_index: 0 },
        engine.snapshot.grid,
      ),
    );
    expect(reason).toMatch(/reserved as the home station for company #7/);
  });

  it("leaves the board exactly as it was when the live entry is applied through the server's engine", () => {
    const engine = engineBefore(95);
    const before = engine.snapshot.state;
    const digestBefore = stateDigest(before);
    engine.apply(entryAt(95));
    const after = engine.snapshot.state;
    expect(stateDigest(after)).toBe(digestBefore);
    expect(company(after, BM).station_token_hexes).toEqual(company(before, BM).station_token_hexes);
    expect(company(after, BM).station_tokens ?? []).toEqual(company(before, BM).station_tokens ?? []);
    expect(company(after, BM).treasury).toBe(company(before, BM).treasury);
    expect(after.operating_sub_phase).toBe("Tokens");
  });

  it("is about the CIRCLE: the other New York circle is refused for connectivity, not for the reservation", () => {
    /* The reservation is not a blanket over the hex. B&M's track reaches the first circle only, so the
       second is refused for the ordinary reason -- which is the control that separates "locked to one
       circle" from "the whole hex is off limits". A corporation that did reach it could take it. */
    const engine = engineBefore(95);
    const state = engine.snapshot.state;
    const reason = underRules(state, () =>
      stationPlacementRefusal(
        state,
        { protocol_id: BM, q: NEW_YORK.q, r: NEW_YORK.r, city_index: 1 },
        engine.snapshot.grid,
      ),
    );
    expect(reason).toMatch(/track does not reach/);
    expect(reason).not.toMatch(/reserved/);
  });

  it("negative control: the hex-level arithmetic that let it through answers yes", () => {
    /* THE OLD GATE, IN ITS OWN TERMS. `occupied + unclaimedReservations >= slots` was the reservation arm,
       and on New York it is 0 + 1 >= 2 -- false, so the placement was allowed. Asserted so that a future
       edit reverting the circle arm to the hex arm fails the refusal above rather than passing by accident. */
    const engine = engineBefore(95);
    const state = engine.snapshot.state;
    underRules(state, () => {
      const occupied = state.public_companies.filter((entry) =>
        entry.station_token_hexes.some(([q, r]) => q === NEW_YORK.q && r === NEW_YORK.r),
      ).length;
      const reservations = stationHomeHexes().filter(
        (home) =>
          home.q === NEW_YORK.q &&
          home.r === NEW_YORK.r &&
          home.companyId !== BM &&
          home.enforced !== false &&
          homeReservationStands(company(state, home.companyId), home),
      ).length;
      const slots = stationSlotCount(engine.snapshot.grid, NEW_YORK.q, NEW_YORK.r);
      expect(occupied + reservations >= slots).toBe(false);
    });
  });
});

describe("a circle is full when ITS slot is taken, whatever the rest of the hex holds", () => {
  it("refuses B&M when NNH sits in the first New York circle, though the hex still has a slot", () => {
    /* WHAT HAPPENED NEXT IN THE LIVE GAME, in miniature: three more tokens went into that one circle
       (indices 547, 551, 1058) because occupancy was counted per hex. */
    const engine = engineBefore(95);
    const base = engine.snapshot.state;
    const state: GameStateResponse = {
      ...base,
      public_companies: base.public_companies.map((entry) =>
        entry.company_id === NNH
          ? {
              ...entry,
              is_floated: true,
              station_token_hexes: [[NEW_YORK.q, NEW_YORK.r]],
              station_tokens: [[NEW_YORK.q, NEW_YORK.r, 0]],
            }
          : entry,
      ),
    };
    const reason = underRules(state, () =>
      stationPlacementRefusal(
        state,
        { protocol_id: BM, q: NEW_YORK.q, r: NEW_YORK.r, city_index: 0 },
        engine.snapshot.grid,
      ),
    );
    expect(reason).toMatch(/only station slot is taken/);
    // Negative control: per hex, one token in two slots is room.
    expect(stationSlotCount(engine.snapshot.grid, NEW_YORK.q, NEW_YORK.r)).toBe(2);
  });
});

describe("a legal ordinary placement still succeeds through the same engine", () => {
  it("B&O's token at index 76 lands and is charged the schedule in effect", () => {
    const engine = engineBefore(76);
    const before = engine.snapshot.state;
    expect(entryAt(76).payload).toContain('"PlaceStationToken"');
    // The Level Playing Field prices the second token at $100 (`LPF_STATION_TOKEN_SCHEDULE`), not $40.
    const cost = underRules(before, () => nextStationTokenCost(company(before, BO)));
    expect(cost).toBe(100);
    engine.apply(entryAt(76));
    const after = engine.snapshot.state;
    expect(company(after, BO).station_token_hexes).toEqual([...company(before, BO).station_token_hexes, [2, 9]]);
    expect(Number(company(after, BO).treasury)).toBe(Number(company(before, BO).treasury) - cost!);
    expect(after.operating_sub_phase).toBe("Routes");
  });
});

/* ------------------------------------------------------------------ */
/* Fixture 2: a synthetic corridor for the rules the prefix lacks       */
/* ------------------------------------------------------------------ */

const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
const H16 = hex("H16");
const I17 = hex("I17");
const J14 = hex("J14");
const K15 = hex("K15");
const BALTIMORE = hex("I15");

/* The corridor from `stationTokenWall.test.ts`: H16 (C&O's token) -> I17 -> Baltimore -> J14 (two slots) ->
   K15 (one slot). */
const CORRIDOR: MapGridResponse = {
  game_id: 1,
  tiles: [
    { q: H16.q, r: H16.r, tile_id: 57, orientation: 2 },
    { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 },
    { q: J14.q, r: J14.r, tile_id: 14, orientation: 1 },
    { q: K15.q, r: K15.r, tile_id: 57, orientation: 2 },
  ],
} as unknown as MapGridResponse;

function corridorBoard(overrides: {
  step?: string;
  coTreasury?: string;
  coTokens?: Array<[number, number]>;
  coLimit?: number;
  boTokens?: Array<[number, number]>;
  coFloated?: boolean;
}): GameStateResponse {
  return {
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
    ],
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: [CO, BO],
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    consecutive_passes: 0,
    operating_sub_phase: overrides.step ?? "Tokens",
    public_companies: [
      {
        company_id: CO,
        ticker: "C&O",
        is_floated: overrides.coFloated ?? true,
        president: "p1",
        par_value: "100",
        ipo_pool_percentage: 0,
        bank_pool_percentage: 0,
        treasury: overrides.coTreasury ?? "1000",
        owned_trains: ["3"],
        player_holdings: [{ player: "p1", percentage: 100 }],
        station_token_hexes: overrides.coTokens ?? [[H16.q, H16.r]],
        station_token_limit: overrides.coLimit ?? 3,
        home_hex_label: "F6",
      },
      {
        company_id: BO,
        ticker: "B&O",
        is_floated: true,
        president: "p2",
        par_value: "100",
        ipo_pool_percentage: 0,
        bank_pool_percentage: 0,
        treasury: "1000",
        owned_trains: ["3"],
        player_holdings: [{ player: "p2", percentage: 100 }],
        station_token_hexes: overrides.boTokens ?? [[BALTIMORE.q, BALTIMORE.r]],
        station_token_limit: 3,
        home_hex_label: "I15",
      },
    ],
  } as unknown as GameStateResponse;
}

const place = (target: { q: number; r: number }, cityIndex = 0) =>
  ({
    PlaceStationToken: { game_id: 1, protocol_id: CO, q: target.q, r: target.r, city_index: cityIndex },
  }) as never;

describe("the corridor is what the tests assume", () => {
  it("K15 has one slot and J14 two, and C&O reaches both with Baltimore open", () => {
    expect(citySlotCount(CORRIDOR, K15.q, K15.r, 0)).toBe(1);
    expect(citySlotCount(CORRIDOR, J14.q, J14.r, 0)).toBe(2);
    const state = corridorBoard({ boTokens: [] });
    expect(stationPlacementRefusal(state, { protocol_id: CO, q: K15.q, r: K15.r, city_index: 0 }, CORRIDOR)).toBeNull();
  });
});

describe("an occupied slot cannot be reused", () => {
  it("refuses K15 once B&O holds its only circle, in words and on the board", () => {
    const before = corridorBoard({ boTokens: [[K15.q, K15.r]] });
    expect(stationPlacementRefusal(before, { protocol_id: CO, q: K15.q, r: K15.r, city_index: 0 }, CORRIDOR)).toMatch(
      /only station slot is taken/,
    );
    expect(applySandboxAction(before, place(K15), { actor: "p1", mapGrid: CORRIDOR })).toBe(before);
  });

  it("still allows the second SLOT of J14's one city beside one rival, which is the control", () => {
    const before = corridorBoard({ boTokens: [[J14.q, J14.r]] });
    const after = applySandboxAction(before, place(J14), { actor: "p1", mapGrid: CORRIDOR });
    expect(after).not.toBe(before);
    expect(company(after, CO).station_token_hexes).toEqual([
      [H16.q, H16.r],
      [J14.q, J14.r],
    ]);
    expect(company(after, CO).treasury).toBe("960");
    expect(after.operating_sub_phase).toBe("Routes");
  });
});

describe("the rules that were UI-only before #1511, now refused by the authority", () => {
  it("a token the network does not reach (connectivity through a walled Baltimore)", () => {
    // B&O in Baltimore's single circle: the corridor beyond it is reached but not passed (#1006).
    const before = corridorBoard({});
    expect(stationPlacementRefusal(before, { protocol_id: CO, q: J14.q, r: J14.r, city_index: 0 }, CORRIDOR)).toMatch(
      /track does not reach/,
    );
    expect(applySandboxAction(before, place(J14), { actor: "p1", mapGrid: CORRIDOR })).toBe(before);
  });

  it("a hex with no city", () => {
    const before = corridorBoard({ boTokens: [] });
    expect(stationPlacementRefusal(before, { protocol_id: CO, q: I17.q, r: I17.r, city_index: 0 }, CORRIDOR)).toMatch(
      /no city here/,
    );
    expect(applySandboxAction(before, place(I17), { actor: "p1", mapGrid: CORRIDOR })).toBe(before);
  });

  it("a circle the hex does not have", () => {
    const before = corridorBoard({ boTokens: [] });
    expect(stationPlacementRefusal(before, { protocol_id: CO, q: K15.q, r: K15.r, city_index: 3 }, CORRIDOR)).toMatch(
      /no city 4 on this hex/,
    );
    expect(applySandboxAction(before, place(K15, 3), { actor: "p1", mapGrid: CORRIDOR })).toBe(before);
  });

  it("a second token in a city the corporation already holds", () => {
    const before = corridorBoard({ boTokens: [], coTokens: [[H16.q, H16.r], [J14.q, J14.r]] });
    expect(stationPlacementRefusal(before, { protocol_id: CO, q: J14.q, r: J14.r, city_index: 0 }, CORRIDOR)).toMatch(
      /already has a station token/,
    );
    expect(applySandboxAction(before, place(J14), { actor: "p1", mapGrid: CORRIDOR })).toBe(before);
  });

  it("an exhausted allowance", () => {
    const before = corridorBoard({ boTokens: [], coLimit: 1 });
    expect(stationPlacementRefusal(before, { protocol_id: CO, q: K15.q, r: K15.r, city_index: 0 }, CORRIDOR)).toMatch(
      /Every one of C&O's 1 station tokens/,
    );
    expect(applySandboxAction(before, place(K15), { actor: "p1", mapGrid: CORRIDOR })).toBe(before);
  });

  it("a treasury short of the schedule (the arm used to clamp at zero and place anyway)", () => {
    const before = corridorBoard({ boTokens: [], coTreasury: "30" });
    expect(stationPlacementRefusal(before, { protocol_id: CO, q: K15.q, r: K15.r, city_index: 0 }, CORRIDOR)).toMatch(
      /holds \$30 and the next station costs \$40/,
    );
    expect(applySandboxAction(before, place(K15), { actor: "p1", mapGrid: CORRIDOR })).toBe(before);
  });

  it("a placement at a step that is not Place Token -- which is the one-token-per-turn rule", () => {
    const before = corridorBoard({ boTokens: [], step: "Routes" });
    expect(stationPlacementRefusal(before, { protocol_id: CO, q: K15.q, r: K15.r, city_index: 0 }, CORRIDOR)).toMatch(
      /Place Token step/,
    );
    expect(applySandboxAction(before, place(K15), { actor: "p1", mapGrid: CORRIDOR })).toBe(before);
  });

  it("a corporation that has not floated", () => {
    const before = corridorBoard({ boTokens: [], coFloated: false });
    expect(stationPlacementRefusal(before, { protocol_id: CO, q: K15.q, r: K15.r, city_index: 0 }, CORRIDOR)).toMatch(
      /has not floated/,
    );
  });

  it("an unknown step is let through, matching the dividend and train gates", () => {
    const before = { ...corridorBoard({ boTokens: [] }), operating_sub_phase: undefined } as GameStateResponse;
    expect(stationPlacementRefusal(before, { protocol_id: CO, q: K15.q, r: K15.r, city_index: 0 }, CORRIDOR)).toBeNull();
  });
});

describe("the hex-level question is refined, not replaced (the veil's position)", () => {
  it("a two-city hex is allowed when SOME circle may be taken, and refused when none may", () => {
    /* `placeableStationHexes` cannot name a circle. On New York at FCJ 95, B&M reaches only the reserved
       circle, so the honest hex answer is "nowhere on this hex" -- which is what the click would then say. */
    const engine = engineBefore(95);
    const state = engine.snapshot.state;
    underRules(state, () => {
      const verdict = evaluateStationPlacement({
        mapGrid: engine.snapshot.grid,
        q: NEW_YORK.q,
        r: NEW_YORK.r,
        company: company(state, BM),
        allCompanies: state.public_companies,
      });
      expect(verdict.allowed).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Fixture 3: hex -> city -> slot, each level asked on its own          */
/* ------------------------------------------------------------------ */

/* A hex has one or more CITIES (station circles); a city has one or more SLOTS. The gate must judge the
   circle -- never pool a hex's slots into one bucket, and never split one pill into two cities. These cases
   build boards by SEARCH rather than by hand-picked orientations (the codebase's habit: `oneLayPerTurn`,
   `layAuthority`), so the fixture is proved against the real tile tables before anything is asserted. */

const OO = hex("D10"); // Hamilton & Toronto: a two-city hex with no home reservation on the standard board
const TILE_59 = 59; // yellow OO: two cities of one slot each
const TILE_64 = 64; // brown OO: still two cities of one slot each
const CITY_TILES = [57, 14, 15, 59];

/** A board where a token on the neighbour reaches EXACTLY city `wanted` of `target`, or `null`. */
function boardReaching(
  target: { q: number; r: number },
  targetTile: number,
  wanted: 0 | 1,
): { grid: MapGridResponse; from: [number, number, number]; orientation: number } | null {
  const other = wanted === 0 ? 1 : 0;
  for (let orientation = 0; orientation < 6; orientation += 1) {
    for (let edge = 0; edge < 6; edge += 1) {
      const nq = target.q + HEX_NEIGHBOR_OFFSETS[edge][0];
      const nr = target.r + HEX_NEIGHBOR_OFFSETS[edge][1];
      if (!STATIC_BOARD_HEXES.some((entry) => entry.q === nq && entry.r === nr)) continue;
      for (const tileId of CITY_TILES) {
        for (let n = 0; n < 6; n += 1) {
          const grid = {
            game_id: 1,
            tiles: [
              ...(targetTile > 0 ? [{ q: target.q, r: target.r, tile_id: targetTile, orientation }] : []),
              { q: nq, r: nr, tile_id: tileId, orientation: n },
            ],
          } as unknown as MapGridResponse;
          const from: [number, number, number] = [nq, nr, 0];
          const cities = reachableCities(grid, [from]);
          if (cities.has(`${hexKey(target.q, target.r)}:${wanted}`) && !cities.has(`${hexKey(target.q, target.r)}:${other}`)) {
            return { grid, from, orientation };
          }
        }
      }
    }
  }
  return null;
}

function twoCityBoard(overrides: {
  grid: MapGridResponse;
  acting: { id: number; tokens: Array<[number, number, number]> };
  others: Array<{ id: number; tokens: Array<[number, number, number]>; floated?: boolean }>;
}): GameStateResponse {
  const corp = (id: number, tokens: Array<[number, number, number]>, floated: boolean, president: string) => ({
    company_id: id,
    ticker: `C${id}`,
    is_floated: floated,
    president,
    par_value: "100",
    ipo_pool_percentage: 0,
    bank_pool_percentage: 0,
    treasury: "1000",
    owned_trains: ["3"],
    player_holdings: [{ player: president, percentage: 100 }],
    station_token_hexes: tokens.map(([q, r]) => [q, r]),
    station_tokens: tokens,
    station_token_limit: 4,
    home_hex_label: "F6",
  });
  return {
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
    ],
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: [overrides.acting.id],
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: "Tokens",
    public_companies: [
      corp(overrides.acting.id, overrides.acting.tokens, true, "p1"),
      ...overrides.others.map((entry) => corp(entry.id, entry.tokens, entry.floated ?? true, "p2")),
    ],
  } as unknown as GameStateResponse;
}

const A = 1;
const RIVAL = 2;

describe("two-city hex, one slot each (yellow OO tile 59 on D10)", () => {
  const toCity1 = boardReaching(OO, TILE_59, 1);
  const toCity0 = boardReaching(OO, TILE_59, 0);

  it("the fixture is real: one orientation reaches city 1 only, another city 0 only", () => {
    expect(toCity1).not.toBeNull();
    expect(toCity0).not.toBeNull();
    expect(cityCountAt(toCity1!.grid, OO.q, OO.r)).toBe(2);
    expect(citySlotCount(toCity1!.grid, OO.q, OO.r, 0)).toBe(1);
    expect(citySlotCount(toCity1!.grid, OO.q, OO.r, 1)).toBe(1);
  });

  it("(1) an occupant in city 0 does not consume city 1's slot", () => {
    const before = twoCityBoard({
      grid: toCity1!.grid,
      acting: { id: A, tokens: [toCity1!.from] },
      others: [{ id: RIVAL, tokens: [[OO.q, OO.r, 0]] }],
    });
    expect(stationPlacementRefusal(before, { protocol_id: A, q: OO.q, r: OO.r, city_index: 1 }, toCity1!.grid)).toBeNull();
    const after = applySandboxAction(
      before,
      { PlaceStationToken: { game_id: 1, protocol_id: A, q: OO.q, r: OO.r, city_index: 1 } } as never,
      { actor: "p1", mapGrid: toCity1!.grid },
    );
    expect(after).not.toBe(before);
    expect(company(after, A).station_tokens).toEqual([toCity1!.from, [OO.q, OO.r, 1]]);
  });

  it("(2) city 0 being occupied refuses another token in city 0 while city 1 stays empty", () => {
    const before = twoCityBoard({
      grid: toCity0!.grid,
      acting: { id: A, tokens: [toCity0!.from] },
      others: [{ id: RIVAL, tokens: [[OO.q, OO.r, 0]] }],
    });
    // Per hex there is room (2 slots, 1 taken); per circle there is none.
    expect(stationSlotCount(toCity0!.grid, OO.q, OO.r)).toBe(2);
    expect(stationPlacementRefusal(before, { protocol_id: A, q: OO.q, r: OO.r, city_index: 0 }, toCity0!.grid)).toMatch(
      /only station slot is taken/,
    );
    expect(
      applySandboxAction(
        before,
        { PlaceStationToken: { game_id: 1, protocol_id: A, q: OO.q, r: OO.r, city_index: 0 } } as never,
        { actor: "p1", mapGrid: toCity0!.grid },
      ),
    ).toBe(before);
    // And the control on the same board: with city 0 empty, the same click lands.
    const open = twoCityBoard({ grid: toCity0!.grid, acting: { id: A, tokens: [toCity0!.from] }, others: [] });
    expect(stationPlacementRefusal(open, { protocol_id: A, q: OO.q, r: OO.r, city_index: 0 }, toCity0!.grid)).toBeNull();
  });

  it("(5) a brown upgrade keeps both tokens in their own cities, and the gate still sees two", () => {
    /* Tile 59 -> tile 64 through the reducer's own arm, with the shell's `token_cities` map. Both cities
       survive the upgrade with one occupant each, so a third corporation is refused in either. */
    const laid = twoCityBoard({
      grid: toCity0!.grid,
      acting: { id: A, tokens: [[OO.q, OO.r, 0]] },
      others: [{ id: RIVAL, tokens: [[OO.q, OO.r, 1]] }],
    });
    const atTrack = { ...laid, operating_sub_phase: "Track" } as GameStateResponse;
    const upgraded = applySandboxAction(
      atTrack,
      {
        LayTile: {
          game_id: 1,
          protocol_id: A,
          q: OO.q,
          r: OO.r,
          tile_id: TILE_64,
          orientation: toCity0!.orientation,
          token_cities: [
            [A, 0],
            [RIVAL, 1],
          ],
        },
      } as never,
      { actor: "p1", layRefused: () => false },
    );
    expect(upgraded).not.toBe(atTrack);
    expect(company(upgraded, A).station_tokens).toEqual([[OO.q, OO.r, 0]]);
    expect(company(upgraded, RIVAL).station_tokens).toEqual([[OO.q, OO.r, 1]]);
    const brown = {
      game_id: 1,
      tiles: [{ q: OO.q, r: OO.r, tile_id: TILE_64, orientation: toCity0!.orientation }],
    } as unknown as MapGridResponse;
    expect(cityCountAt(brown, OO.q, OO.r)).toBe(2);
    const third = { company_id: 3, is_floated: true, station_token_hexes: [], station_token_limit: 4 };
    const all = [...upgraded.public_companies, third];
    // Both circles full, so the whole hex is full and the hex-level arm speaks first: "All 2 ... taken".
    expect(evaluateStationPlacement({ mapGrid: brown, q: OO.q, r: OO.r, company: third, allCompanies: all, cityIndex: 0 }).reason).toMatch(
      /slots are taken/,
    );
    expect(evaluateStationPlacement({ mapGrid: brown, q: OO.q, r: OO.r, company: third, allCompanies: all, cityIndex: 1 }).reason).toMatch(
      /slots are taken/,
    );
    // And with the rival's token alone, city 1 is full and city 0 is open -- the identities survived.
    const half = [company(upgraded, RIVAL), third];
    expect(evaluateStationPlacement({ mapGrid: brown, q: OO.q, r: OO.r, company: third, allCompanies: half, cityIndex: 1 }).reason).toMatch(
      /only station slot is taken/,
    );
    expect(evaluateStationPlacement({ mapGrid: brown, q: OO.q, r: OO.r, company: third, allCompanies: half, cityIndex: 0 }).allowed).toBe(
      true,
    );
  });
});

describe("a locked reservation holds ITS circle and no other (printed New York)", () => {
  const toCity1 = boardReaching(NEW_YORK, 0, 1);

  it("(1) a corporation reaching the unreserved New York circle may take it while NNH's reservation stands", () => {
    expect(toCity1).not.toBeNull();
    const before = twoCityBoard({
      grid: toCity1!.grid,
      acting: { id: A, tokens: [toCity1!.from] },
      others: [{ id: NNH, tokens: [], floated: false }],
    });
    expect(stationPlacementRefusal(before, { protocol_id: A, q: NEW_YORK.q, r: NEW_YORK.r, city_index: 1 }, toCity1!.grid)).toBeNull();
    // The reserved circle is refused for the reservation, on the same board, for the same corporation.
    const reserved = twoCityBoard({
      grid: boardReaching(NEW_YORK, 0, 0)!.grid,
      acting: { id: A, tokens: [boardReaching(NEW_YORK, 0, 0)!.from] },
      others: [{ id: NNH, tokens: [], floated: false }],
    });
    expect(
      stationPlacementRefusal(reserved, { protocol_id: A, q: NEW_YORK.q, r: NEW_YORK.r, city_index: 0 }, boardReaching(NEW_YORK, 0, 0)!.grid),
    ).toMatch(/reserved as the home station for company #7/);
  });
});

describe("one city with several slots stays ONE city", () => {
  it("(3) and (4): J14 is one city of two slots to the tile table, the walk and the gate alike", () => {
    // The tile table: one city, two slots.
    expect(cityCountAt(CORRIDOR, J14.q, J14.r)).toBe(1);
    expect(citySlotCount(CORRIDOR, J14.q, J14.r, 0)).toBe(2);
    expect(citySlotCount(CORRIDOR, J14.q, J14.r, 1)).toBe(0);
    // The walk: exactly one city key on that hex, never a `:1`.
    const state = corridorBoard({ boTokens: [] });
    const cities = reachableCities(CORRIDOR, [[H16.q, H16.r]]);
    expect(cities.has(`${hexKey(J14.q, J14.r)}:0`)).toBe(true);
    expect(cities.has(`${hexKey(J14.q, J14.r)}:1`)).toBe(false);
    // The gate: a rival in slot 1 leaves slot 2 (`occupied slot` describe above lands there), and asking
    // for a "second city" is refused as a circle the hex does not have.
    expect(stationPlacementRefusal(state, { protocol_id: CO, q: J14.q, r: J14.r, city_index: 1 }, CORRIDOR)).toMatch(
      /no city 2 on this hex/,
    );
    /* Blocking treats the pill as one city too: `stationTokenWall.test.ts` "rule 1: room is room" (one rival
       in a two-slot city does not wall it; a second does) and `cityBlocking.test.ts` are the standing proofs. */
  });
});
