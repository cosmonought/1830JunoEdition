/** @jest-environment node */
//
// ==================================================================
//  STAGE 8, SLICE 8.2 -- THE LEVEL PLAYING FIELD'S HOMES (SCENARIO D), THE RESERVATIONS, AND THE PRICE OF A STATION
// ==================================================================
//
// Design notes #1611 (candidate homes per board), #1616 (the prompt offers only what is legal), #1325 (C&O's two
// homes, Richmond enforced and Cleveland not), #1320 (the Level Playing Field's flat $100 station schedule).
//
// PRINTED AUTHORITY. The full 48-page Lookout/Mayfair rulebook, S-1.0 "A Level Playing Field" (Scenario D), checked
// against the attached `1830 FULL RULES with variants.pdf` (S-1.2, pp. 34-35; Table T-08, p. 47): PMQ is added at
// Detroit/Windsor E5, may start in either city, and takes the Erie's track rules; N&W is added with Norfolk L16 as
// its base city; C&O's first home is Cleveland F6 OR Richmond K13 -- Richmond closed to other railroads until C&O
// lays its first token, Cleveland NOT reserved and closable, the unchosen city reachable later only with a valid
// connection. S-1.2 7.3 prints a flat $100 station price; the owner's reading keeps the home free (base game 7.3.1)
// and makes every ordinary station after it $100. The asymmetry is pinned here as authority, never as "reserve
// both until C&O chooses".

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES, STANDARD_BOARD, activateBoard, boardInEffect } from "../components/hexBoardData";
import { homeHexesFor, homeReservationStands } from "../components/hexContractTypes";
import { CO_COMPANY_ID, NW_COMPANY_ID, PMQ_COMPANY_ID } from "../components/hexBoardDataLpf";
import { resolveVariants } from "../gameEngine/gameVariants";
import { withRules } from "../gameEngine/boardSelection";
import { initialGridFor } from "../gameEngine/initialGrid";
import {
  boardHomeHexToAxial,
  homeHexChoicesFor,
  homePlacementRefusal,
  legalHomeTargets,
  owedHomeStation,
} from "../gameEngine/homeStationAuthority";
import { applySandboxLayTile, pendingHomeTokens } from "../gameEngine/sandboxSession";
import {
  STANDARD_STATION_TOKEN_SCHEDULE,
  closedOoHomeAt,
  evaluateStationPlacement,
  nextStationTokenCost,
  stationTokenPrice,
  stationTokenSlots,
} from "../gameEngine/stationTokens";
import { stationPlacementRefusal } from "../gameEngine/stationPlacementGate";
import { board, P1, P2, P3, NYC } from "./offerFixtures74";
import { applyAsRoom, corp, ingress, same, withCorp, withState } from "./offerMatrix74Support";

const LPF = resolveVariants({ levelPlayingField: true });
const BO = 4;
const CO = CO_COMPANY_ID;
const PMQ = PMQ_COMPANY_ID;
const NW = NW_COMPANY_ID;
const table = boardHomeHexToAxial;

afterAll(() => activateBoard(STANDARD_BOARD));

/** Everything in this file is asked with the Level Playing Field's board, tray and chart in effect. */
const lpf = <T,>(fn: () => T): T => withRules(LPF, fn);
const hexAt = (label: string) => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no ${label} on the board in effect`);
  return hex;
};
const at = (label: string): [number, number] => [hexAt(label).q, hexAt(label).r];
const key = (label: string) => `${hexAt(label).q},${hexAt(label).r}`;
const tokens = (state: GameStateResponse, id: number) => corp(state, id).station_token_hexes.map(([q, r]) => `${q},${r}`);
/** The board's opening grid (the expanded map opens with tiles already down, #1301). */
const openingGrid = (): MapGridResponse => lpf(() => initialGridFor(boardInEffect()));

/** A home placement, its coordinates read off the Level Playing Field's board whatever board a caller is in. */
const home = (companyId: number, label: string, cityIndex: number | null = null) =>
  lpf(() => ({
    PlaceHomeStation: { game_id: 1, company_id: companyId, q: hexAt(label).q, r: hexAt(label).r, kind: "home", city_index: cityIndex, hex_label: label },
  }));

/**
 * A Level Playing Field Operating Round: B&O (P1, home I15 placed), C&O (P2), PMQ (P3), N&W (P1), NYC (P2, home E19
 * placed). `operating` names the corporation under the cursor at `step`.
 */
function lpfBoard(operating: number, step = "Track"): GameStateResponse {
  return lpf(() => {
    const state = board({
      round: "OperatingRound",
      corps: [
        { id: BO, ticker: "B&O", president: P1, trains: ["2"], treasury: "500", price: 100 },
        { id: CO, ticker: "C&O", president: P2, trains: [], treasury: "800", price: 80 },
        { id: PMQ, ticker: "PMQ", president: P3, trains: [], treasury: "700", price: 71 },
        { id: NW, ticker: "N&W", president: P1, trains: [], treasury: "760", price: 76 },
        { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90 },
      ],
      operating,
      step,
      over: { variants: LPF },
    });
    let out = withCorp(state, BO, { home_hex_label: "I15", station_token_hexes: [at("I15")] });
    out = withCorp(out, CO, { home_hex_label: "F6" });
    out = withCorp(out, PMQ, { home_hex_label: "E5", station_token_limit: 2 });
    out = withCorp(out, NW, { home_hex_label: "L16" });
    out = withCorp(out, NYC, { home_hex_label: "E19", station_token_hexes: [at("E19")] });
    return out;
  });
}

/** NYC's token in the one Cleveland circle -- Cleveland closed out before C&O operates. */
const clevelandClosed = (state: GameStateResponse) =>
  lpf(() => withCorp(state, NYC, { station_token_hexes: [at("E19"), at("F6")], station_tokens: [[hexAt("F6").q, hexAt("F6").r, 0]] }));

/** A tokenless, non-herald corporation: it has no network, so only the city rules (slots, reservations) answer. */
const probeFor = (state: GameStateResponse) => ({ ...corp(state, PMQ), station_token_hexes: [] as Array<[number, number]>, station_tokens: [] });

/* ================================================================== */
/* C&O: Cleveland OR Richmond, asymmetrically reserved                                                      */
/* ================================================================== */

describe("§27 C&O's first home is Cleveland or Richmond -- Richmond protected, Cleveland blockable (Scenario D)", () => {
  it("the board encodes the asymmetry: Richmond's reservation is enforced, Cleveland's is a marker that holds nothing", () => {
    lpf(() => {
      const homes = homeHexesFor(CO);
      expect(homes.map((entry) => [entry.label, entry.enforced !== false])).toEqual([
        ["F6", false],
        ["K13", true],
      ]);
      expect(homeHexChoicesFor(corp(lpfBoard(CO), CO), table).map((choice) => choice.hexLabel)).toEqual(["F6", "K13"]);
    });
  });

  it("(1, 2) before C&O operates, another corporation's station in Cleveland is not refused by any C&O reservation", () => {
    lpf(() => {
      const grid = openingGrid();
      const state = lpfBoard(BO, "Tokens");
      const verdict = evaluateStationPlacement({ mapGrid: grid, q: hexAt("F6").q, r: hexAt("F6").r, company: probeFor(state), allCompanies: state.public_companies });
      expect(verdict).toEqual({ allowed: true, reason: null });
    });
  });

  it("(3, 4) Richmond is refused to every other corporation until C&O places its home -- unfloated, floated, through the Stock Round and the corporations before it", () => {
    lpf(() => {
      const grid = openingGrid();
      const operatingFirst = lpfBoard(BO, "Tokens");
      const boards: Array<[string, GameStateResponse]> = [
        ["C&O unfloated, Stock Round", withState(withCorp(operatingFirst, CO, { is_floated: false }), { current_round_type: "StockRound", operating_sub_phase: undefined })],
        ["C&O floated, Stock Round", withState(operatingFirst, { current_round_type: "StockRound", operating_sub_phase: undefined })],
        ["C&O floated, an earlier corporation operating", operatingFirst],
        ["C&O at the start of its own first turn", lpfBoard(CO)],
      ];
      for (const [label, state] of boards) {
        const verdict = evaluateStationPlacement({ mapGrid: grid, q: hexAt("K13").q, r: hexAt("K13").r, company: probeFor(state), allCompanies: state.public_companies });
        expect([label, verdict.allowed, verdict.reason]).toEqual([label, false, "This city's remaining slot is reserved as a home station for company #5 and cannot be taken."]);
      }
    });
  });

  it("(5, 6) Cleveland closed out before C&O's first turn is not offered and not accepted; Richmond is the one legal home", () => {
    const grid = openingGrid();
    const state = clevelandClosed(lpfBoard(CO));
    lpf(() => {
      expect(legalHomeTargets(state, grid, table).map((target) => `${target.hexLabel}:${target.cityIndex}`)).toEqual(["K13:0"]);
      expect(pendingHomeTokens(state, table, grid)).toEqual([
        { companyId: CO, ticker: "C&O", hexLabel: "K13", q: hexAt("K13").q, r: hexAt("K13").r, president: P2, options: [{ hexLabel: "K13", q: hexAt("K13").q, r: hexAt("K13").r }] },
      ]);
      expect(homePlacementRefusal(state, home(CO, "F6").PlaceHomeStation, grid, table)).toBe("This city's only station slot is taken.");
    });
    expect(ingress(state, P2, home(CO, "F6"), grid)).toBe("This city's only station slot is taken.");
    expect(same(applyAsRoom(state, home(CO, "F6"), P2, grid), state)).toBe(true);
    const richmond = applyAsRoom(state, home(CO, "K13"), P2, grid);
    expect(lpf(() => tokens(richmond, CO))).toEqual([lpf(() => key("K13"))]);
  });

  it("(7, 8, 16) with both open at its first turn C&O may choose either, for nothing", () => {
    const grid = openingGrid();
    const state = lpfBoard(CO);
    lpf(() => {
      expect(pendingHomeTokens(state, table, grid)[0].options.map((option) => option.hexLabel)).toEqual(["F6", "K13"]);
    });
    for (const label of ["F6", "K13"]) {
      expect([label, ingress(state, P2, home(CO, label), grid)]).toEqual([label, null]);
      const placed = applyAsRoom(state, home(CO, label), P2, grid);
      expect([label, lpf(() => tokens(placed, CO))]).toEqual([label, [lpf(() => key(label))]]);
      expect([label, corp(placed, CO).treasury, placed.virtual_bank_vgp]).toEqual([label, corp(state, CO).treasury, state.virtual_bank_vgp]);
      expect([label, lpf(() => owedHomeStation(placed, table))]).toEqual([label, null]);
    }
  });

  it("(9, 10) choosing Cleveland releases Richmond at once: another corporation may then station there", () => {
    const grid = openingGrid();
    const cleveland = applyAsRoom(lpfBoard(CO), home(CO, "F6"), P2, grid);
    lpf(() => {
      const k13 = homeHexesFor(CO).find((entry) => entry.label === "K13")!;
      expect(homeReservationStands(corp(cleveland, CO), k13)).toBe(false);
      const verdict = evaluateStationPlacement({ mapGrid: grid, q: k13.q, r: k13.r, company: probeFor(cleveland), allCompanies: cleveland.public_companies });
      expect(verdict).toEqual({ allowed: true, reason: null });
    });
  });

  it("(11, 12) choosing Richmond ends the choice: Cleveland carries no C&O status at all", () => {
    const grid = openingGrid();
    const richmond = applyAsRoom(lpfBoard(CO), home(CO, "K13"), P2, grid);
    lpf(() => {
      const verdict = evaluateStationPlacement({ mapGrid: grid, q: hexAt("F6").q, r: hexAt("F6").r, company: probeFor(richmond), allCompanies: richmond.public_companies });
      expect(verdict).toEqual({ allowed: true, reason: null });
      expect(owedHomeStation(withState(richmond, { operating_sub_phase: "Tokens" }), table)).toBeNull();
    });
  });

  it("(13) C&O cannot claim the unchosen city as a second free home", () => {
    const grid = openingGrid();
    const cleveland = applyAsRoom(lpfBoard(CO), home(CO, "F6"), P2, grid);
    expect(ingress(cleveland, P2, home(CO, "K13"), grid)).toBe("C&O's home station is already on the board.");
    expect(same(applyAsRoom(cleveland, home(CO, "K13"), P2, grid), cleveland)).toBe(true);
  });

  it("(14, 15) the unchosen city is an ordinary station: it needs C&O's network to reach it, and costs $100", () => {
    const grid = openingGrid();
    const cleveland = withState(applyAsRoom(lpfBoard(CO), home(CO, "F6"), P2, grid), { operating_sub_phase: "Tokens" });
    lpf(() => {
      expect(nextStationTokenCost(corp(cleveland, CO))).toBe(100);
      // Not the reservation -- the route: C&O's network from Cleveland does not reach Richmond on the opening grid.
      expect(stationPlacementRefusal(cleveland, { protocol_id: CO, q: hexAt("K13").q, r: hexAt("K13").r, city_index: 0 }, grid)).toBe(
        "This corporation's track does not reach this city. Station tokens may only be placed on the network it already runs.",
      );
    });
  });
});

/* ================================================================== */
/* PMQ and N&W                                                                                              */
/* ================================================================== */

describe("§26 PMQ is Erie's case on Detroit/Windsor; N&W is a fixed home at Norfolk (Scenario D)", () => {
  it("PMQ may take either E5 city, with no tile, for nothing; not off its hex, not a taken circle", () => {
    const grid = openingGrid();
    const state = lpfBoard(PMQ);
    lpf(() => {
      expect(homeHexChoicesFor(corp(state, PMQ), table).map((choice) => choice.hexLabel)).toEqual(["E5"]);
      expect(legalHomeTargets(state, grid, table).map((target) => `${target.hexLabel}:${target.cityIndex}`)).toEqual(["E5:0", "E5:1"]);
      expect(homePlacementRefusal(state, home(PMQ, "I15", 0).PlaceHomeStation, grid, table)).toBe("PMQ's home station goes on E5, not on I15.");
    });
    for (const cityIndex of [0, 1]) {
      expect(ingress(state, P3, home(PMQ, "E5", cityIndex), grid)).toBeNull();
      const placed = applyAsRoom(state, home(PMQ, "E5", cityIndex), P3, grid);
      expect(corp(placed, PMQ).station_tokens).toEqual([[lpf(() => hexAt("E5").q), lpf(() => hexAt("E5").r), cityIndex]]);
      expect(corp(placed, PMQ).treasury).toBe(corp(state, PMQ).treasury);
    }
    const taken = lpf(() => withCorp(state, NYC, { station_token_hexes: [at("E19"), at("E5")], station_tokens: [[hexAt("E5").q, hexAt("E5").r, 1]] }));
    expect(ingress(taken, P3, home(PMQ, "E5", 1), grid)).toBe("This city's only station slot is taken.");
    expect(same(applyAsRoom(taken, home(PMQ, "E5", 1), P3, grid), taken)).toBe(true);
    expect(lpf(() => legalHomeTargets(taken, grid, table).map((target) => target.cityIndex))).toEqual([0]);
  });

  it("PMQ's reservation is Erie's: another corporation may take one E5 city, never the second, until PMQ has its home", () => {
    lpf(() => {
      const grid = openingGrid();
      const state = lpfBoard(BO, "Tokens");
      const [q, r] = at("E5");
      const probe = { ...corp(state, NW), station_token_hexes: [] as Array<[number, number]> };
      expect(evaluateStationPlacement({ mapGrid: grid, q, r, company: probe, allCompanies: state.public_companies, cityIndex: 0 }).allowed).toBe(true);
      const oneTaken = withCorp(state, NYC, { station_token_hexes: [at("E19"), at("E5")], station_tokens: [[q, r, 0]] });
      const second = evaluateStationPlacement({ mapGrid: grid, q, r, company: probe, allCompanies: oneTaken.public_companies, cityIndex: 1 });
      expect(second.allowed).toBe(false);
      expect(second.reason).toContain("reserved as a home station");
    });
  });

  it("N&W's home is Norfolk alone -- no second hex, no Multiple-Starting-Hexes choice -- and it is free", () => {
    const grid = openingGrid();
    const state = lpfBoard(NW);
    lpf(() => {
      expect(homeHexesFor(NW).map((entry) => entry.label)).toEqual(["L16"]);
      expect(homeHexChoicesFor(corp(state, NW), table).map((choice) => choice.hexLabel)).toEqual(["L16"]);
      expect(pendingHomeTokens(state, table, grid)[0].options.map((option) => option.hexLabel)).toEqual(["L16"]);
      expect(homePlacementRefusal(state, home(NW, "K13").PlaceHomeStation, grid, table)).toBe("N&W's home station goes on L16, not on K13.");
    });
    const placed = applyAsRoom(state, home(NW, "L16"), P1, grid);
    expect(lpf(() => tokens(placed, NW))).toEqual([lpf(() => key("L16"))]);
    expect(corp(placed, NW).treasury).toBe(corp(state, NW).treasury);
    expect(same(applyAsRoom(state, home(NW, "K13"), P1, grid), state)).toBe(true);
  });
});

/* ================================================================== */
/* §29 S8-14 the PMQ's E5: the Erie's rule on Detroit/Windsor (#1617)                                       */
/* ================================================================== */

describe("§29 S8-14: the PMQ's E5 -- one city protected before a tile, the whole hex closed after one, ordinary rules after its home (#1617)", () => {
  const E5 = () => lpf(() => hexAt("E5"));
  /** E5 after a tile has been laid there in play (tile 59), on the Level Playing Field's opening grid. */
  const tiledE5 = (): MapGridResponse => lpf(() => applySandboxLayTile(openingGrid(), E5().q, E5().r, 59, 0, () => false));
  /** N&W at the Tokens step with no home and no token: it owes nothing and has no network, so the city rules answer. */
  const nwAtTokens = () => lpf(() => withCorp(lpfBoard(NW, "Tokens"), NW, { home_hex_label: undefined, station_token_hexes: [], station_tokens: [] }));
  const stationAt = (companyId: number, cityIndex: number | null) => ({
    PlaceStationToken: { game_id: 1, protocol_id: companyId, q: E5().q, r: E5().r, city_index: cityIndex },
  });
  /** NYC's station in E5's circle `cityIndex`, placed while that was legal. */
  const nycIn = (state: GameStateResponse, cityIndex: number) =>
    lpf(() => withCorp(state, NYC, { station_token_hexes: [at("E19"), [E5().q, E5().r]], station_tokens: [[E5().q, E5().r, cityIndex]] }));
  /** A paid placement asked of the gate, of ingress and of the reducer as a room runs it: the three must agree. */
  const atBothLocks = (state: GameStateResponse, msg: ReturnType<typeof stationAt>, grid: MapGridResponse) => ({
    gate: lpf(() => stationPlacementRefusal(state, msg.PlaceStationToken, grid)),
    lock: ingress(state, P1, msg, grid),
    moved: !same(applyAsRoom(state, msg, P1, grid), state),
  });
  const closed = "PMQ has not placed its home station on E5 yet and a tile has been laid there, so no other corporation may place a station on E5 until it does.";

  it("the tile is real: tile 59 lands on E5, and nothing on the opening grid had been laid there", () => {
    expect(openingGrid().tiles.some((tile) => tile.q === E5().q && tile.r === E5().r)).toBe(false);
    expect(tiledE5().tiles.filter((tile) => tile.q === E5().q && tile.r === E5().r).map((tile) => [tile.tile_id, tile.printed === true])).toEqual([[59, false]]);
  });

  it("(4.1) before a tile: another corporation may take one E5 city while the other remains, never the last one -- at both locks", () => {
    const grid = openingGrid();
    const state = nwAtTokens();
    expect(atBothLocks(state, stationAt(NW, 0), grid)).toEqual({ gate: null, lock: null, moved: true });
    const last = "This city's remaining slot is reserved as a home station for company #9 and cannot be taken.";
    expect(atBothLocks(nycIn(state, 0), stationAt(NW, 1), grid)).toEqual({ gate: last, lock: last, moved: false });
  });

  it("(4.2) after a tile, before PMQ's home: no other corporation may place in either E5 city, at either lock", () => {
    const grid = tiledE5();
    const state = nwAtTokens();
    for (const cityIndex of [0, 1, null]) {
      expect([cityIndex, atBothLocks(state, stationAt(NW, cityIndex), grid)]).toEqual([cityIndex, { gate: closed, lock: closed, moved: false }]);
    }
    expect(lpf(() => closedOoHomeAt(grid, E5().q, E5().r, corp(state, NW), state.public_companies))).toMatchObject({ companyId: PMQ, label: "E5" });
  });

  it("(4.2) a station placed before the tile stays; nothing is added beside it; PMQ may still take the free city, not the taken one", () => {
    const grid = tiledE5();
    // NYC took circle 0 while that was legal; N&W then lays the tile through the reducer's own lay arm.
    const beforeTile = nycIn(lpf(() => withCorp(lpfBoard(NW, "Track"), NW, { home_hex_label: undefined, station_token_hexes: [], station_tokens: [] })), 0);
    const lay = { LayTile: { game_id: 1, protocol_id: NW, q: E5().q, r: E5().r, tile_id: 59, orientation: 0 } };
    const afterLay = applyAsRoom(beforeTile, lay, P1, openingGrid());
    expect(same(afterLay, beforeTile)).toBe(false); // the lay was applied
    expect(corp(afterLay, NYC).station_tokens).toEqual([[E5().q, E5().r, 0]]); // and NYC's station is still in circle 0
    expect(atBothLocks(withState(afterLay, { operating_sub_phase: "Tokens" }), stationAt(NW, 1), grid)).toEqual({ gate: closed, lock: closed, moved: false });
    const pmqTurn = nycIn(lpfBoard(PMQ), 0);
    expect(lpf(() => homePlacementRefusal(pmqTurn, home(PMQ, "E5", 1).PlaceHomeStation, grid, table))).toBeNull();
    expect(ingress(pmqTurn, P3, home(PMQ, "E5", 1), grid)).toBeNull();
    const placed = applyAsRoom(pmqTurn, home(PMQ, "E5", 1), P3, grid);
    expect(corp(placed, PMQ).station_tokens).toEqual([[E5().q, E5().r, 1]]);
    expect(corp(placed, NYC).station_tokens).toEqual([[E5().q, E5().r, 0]]);
    const taken = "This city's only station slot is taken.";
    expect(ingress(pmqTurn, P3, home(PMQ, "E5", 0), grid)).toBe(taken);
    expect(same(applyAsRoom(pmqTurn, home(PMQ, "E5", 0), P3, grid), pmqTurn)).toBe(true);
  });

  it("(4.3) once PMQ's home is placed the special reservation ends and ordinary rules govern", () => {
    const grid = tiledE5();
    const homed = lpf(() => withCorp(nwAtTokens(), PMQ, { station_token_hexes: [[E5().q, E5().r]], station_tokens: [[E5().q, E5().r, 1]] }));
    expect(lpf(() => closedOoHomeAt(grid, E5().q, E5().r, corp(homed, NW), homed.public_companies))).toBeNull();
    expect(atBothLocks(homed, stationAt(NW, 0), grid)).toEqual({ gate: null, lock: null, moved: true });
    const full = "This city's only station slot is taken.";
    expect(atBothLocks(homed, stationAt(NW, 1), grid)).toEqual({ gate: full, lock: full, moved: false });
  });

  it("the C&O's Cleveland is untouched by the OO rule: a tiled F6 still holds nothing for C&O (#1325)", () => {
    const f6 = lpf(() => hexAt("F6"));
    const tiled = lpf(() => applySandboxLayTile(openingGrid(), f6.q, f6.r, 57, 0, () => false));
    const state = nwAtTokens();
    expect(lpf(() => closedOoHomeAt(tiled, f6.q, f6.r, corp(state, NW), state.public_companies))).toBeNull();
  });
});

/* ================================================================== */
/* §28 the Level Playing Field's station prices                                                             */
/* ================================================================== */

describe("§28 under the Level Playing Field the home is free and every ordinary station after it is $100", () => {
  it("prices the home $0 and every later ordinary station $100 -- no $40 second station", () => {
    lpf(() => {
      expect([0, 1, 2, 3].map((index) => stationTokenPrice(index))).toEqual([0, 100, 100, 100]);
      expect(stationTokenSlots({ company_id: NW, station_token_hexes: [], station_token_limit: 3 }).map((slot) => slot.cost)).toEqual([0, 100, 100]);
      expect(nextStationTokenCost({ company_id: NW, station_token_hexes: [at("L16")], station_token_limit: 3 })).toBe(100);
      expect(nextStationTokenCost({ company_id: NW, station_token_hexes: [at("L16"), at("K15")], station_token_limit: 3 })).toBe(100);
    });
  });

  it("leaves the Classic schedule exactly as it was: free home, $40, then $100", () => {
    withRules(resolveVariants({}), () => {
      expect(STANDARD_STATION_TOKEN_SCHEDULE).toEqual({ home: 0, second: 40, later: 100 });
      expect([0, 1, 2].map((index) => stationTokenPrice(index))).toEqual([0, 40, 100]);
    });
  });
});
