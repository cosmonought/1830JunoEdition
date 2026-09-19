/** @jest-environment node */
//
// ==================================================================
//  STAGE 8, SLICE 8.2 -- HOME-STATION AUTHORITY (S8-5 / S8-6 / S8-12): TIMING, THE HOLD, AND WHERE A HOME MAY GO
// ==================================================================
//
// Design notes #1610 (the obligation on the cursor), #1611 (placement legality), #1612 (the turn-local hold at
// both locks, and the derived loop), #1615 (the D&H's free station is not a home placement). The Level Playing
// Field's homes (C&O, PMQ, N&W), its station prices and the reservations are `homeStationLpf.test.ts`; the holds'
// position ahead of the chart step is `holdBeforeChart.test.ts`; the development corpus's adapter is
// `legacyHomeAdapter.test.ts`.
//
// Every refusal is asserted at BOTH locks -- the reducer as a room's engine calls it (the providers' label table,
// the author, the grid), judged by `stateDigest` because a charted board comes back as a fresh object even when
// nothing moved (S10-1), and ingress (`turnRefusal`), judged by its sentence -- and the sentence is the
// authority's own.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES, activateBoard, STANDARD_BOARD } from "../components/hexBoardData";
import { resolveVariants } from "../gameEngine/gameVariants";
import { withRules } from "../gameEngine/boardSelection";
import { nextDerivedAction } from "../gameEngine/derivedActions";
import {
  boardHomeHexToAxial,
  homeHexChoicesFor,
  homePlacementRefusal,
  homeStationHold,
  homeStationOwed,
  legalHomeTargets,
  owedHomeStation,
} from "../gameEngine/homeStationAuthority";
import { homeTokenBlock, homeTokenOwed } from "../gameEngine/homeTokenGate";
import { applySandboxLayTile, authoritativeHoldRefusal, pendingHomeTokens, placeDhFreeStationToken, placeHomeStationToken } from "../gameEngine/sandboxSession";
import { closedOoHomeAt, evaluateStationPlacement, placeableStationHexes } from "../gameEngine/stationTokens";
import { stationPlacementRefusal } from "../gameEngine/stationPlacementGate";
import { board, P1, P2, P3, PRR, NYC } from "./offerFixtures74";
import { applyAsRoom, corp, ingress, M, same, withCorp, withState } from "./offerMatrix74Support";

const BO = 4;
const ERIE = 6;
const NNH = 7;
const DH_PRIVATE = 3;
const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
const table = boardHomeHexToAxial;

afterAll(() => activateBoard(STANDARD_BOARD));

function hexAt(label: string) {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no ${label} on the board in effect`);
  return hex;
}
const at = (label: string): [number, number] => [hexAt(label).q, hexAt(label).r];

/** A home placement message. */
const home = (companyId: number, label: string, cityIndex: number | null = null, kind: "home" | "dh" = "home") => ({
  PlaceHomeStation: { game_id: 1, company_id: companyId, q: hexAt(label).q, r: hexAt(label).r, kind, city_index: cityIndex, hex_label: label },
});

/**
 * The standard board, Operating Round 3.1: PRR (P1, token on H12), B&O (P2, home I15), ERIE (P3, home E11),
 * NYC (P1, home E19), NNH (P2, home G19). Every corporation is floated; only PRR has placed its home. `operating`
 * names the corporation under the cursor; `step` its step (the start of a turn is Track).
 */
function orBoard(operating: number = BO, step = "Track"): GameStateResponse {
  const state = board({
    round: "OperatingRound",
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["2"], treasury: "500", price: 100 },
      { id: BO, ticker: "B&O", president: P2, trains: [], treasury: "900", price: 90 },
      { id: ERIE, ticker: "ERIE", president: P3, trains: [], treasury: "800", price: 80 },
      { id: NYC, ticker: "NYC", president: P1, trains: [], treasury: "700", price: 71 },
      { id: NNH, ticker: "NNH", president: P2, trains: [], treasury: "670", price: 67 },
    ],
    operating,
    step,
  });
  let out = withCorp(state, PRR, { home_hex_label: "H12", station_token_hexes: [at("H12")], station_tokens: [] });
  out = withCorp(out, BO, { home_hex_label: "I15" });
  out = withCorp(out, ERIE, { home_hex_label: "E11" });
  out = withCorp(out, NYC, { home_hex_label: "E19" });
  out = withCorp(out, NNH, { home_hex_label: "G19" });
  return out;
}

/** Stock Round 2, P2 seated on 50% of B&O (parred $90, IPO 50%): one more share floats it. PRR is operating-ready. */
function floatBoard(variants?: Record<string, unknown>): GameStateResponse {
  const state = board({
    round: "StockRound",
    seat: 1,
    corps: [
      { id: PRR, ticker: "PRR", president: P1, trains: ["2"], treasury: "500", holdings: [[P1, 60]] },
      { id: BO, ticker: "B&O", president: P2, trains: [], treasury: "0", holdings: [[P2, 50]], ipo: 50, floated: false, price: 90, parValue: "90" },
    ],
    ...(variants ? { over: { variants: variants as never } } : {}),
  });
  return withCorp(withCorp(state, PRR, { home_hex_label: "H12", station_token_hexes: [at("H12")] }), BO, { home_hex_label: "I15" });
}

const tokens = (state: GameStateResponse, id: number) => corp(state, id).station_token_hexes.map(([q, r]) => `${q},${r}`);
const key = (label: string) => `${hexAt(label).q},${hexAt(label).r}`;

/* ================================================================== */
/* §24 timing: owed at the start of the first operating turn, and nowhere else                             */
/* ================================================================== */

describe("§24 the home station is owed at the start of the corporation's first operating turn (S8-5, #1610)", () => {
  it("a Stock Round float owes nothing, holds nothing, places nothing, and the buyer's turn ends as any purchase does", () => {
    const before = floatBoard();
    const after = applyAsRoom(before, M.buyStock(BO), P2, GRID);
    expect(corp(after, BO).is_floated).toBe(true);
    expect(corp(after, BO).station_token_hexes).toEqual([]);
    expect(owedHomeStation(after, table)).toBeNull();
    expect(pendingHomeTokens(after, table, GRID)).toEqual([]);
    expect(homeTokenOwed(after, table)).toBe(false);
    expect(homeTokenBlock({ state: after, homeHexToAxial: table })).toBeNull();
    // The seat moved on (#769 retired): the next player is seated and may act at both locks.
    expect(after.active_player_index).toBe(2);
    expect(ingress(after, P3, M.pass)).toBeNull();
    const passed = applyAsRoom(after, M.pass, P3, GRID);
    expect(same(passed, after)).toBe(false);
  });

  it("under Sell-Buy-Sell the floating purchase leaves the turn to be ended by the Pass, which nothing refuses", () => {
    const before = floatBoard({ rules: 1 });
    const bought = applyAsRoom(before, M.buyStock(BO), P2, GRID);
    expect(corp(bought, BO).is_floated).toBe(true);
    expect(bought.active_player_index).toBe(1); // #1443: the purchase is the middle of the turn
    expect(ingress(bought, P2, M.pass)).toBeNull();
    const ended = applyAsRoom(bought, M.pass, P2, GRID);
    expect(ended.active_player_index).toBe(2); // the old #769 Sell-Buy-Sell refusal of this Pass is gone
  });

  it("a Stock Round placement is refused at both locks as untimely, and places nothing", () => {
    const floated = applyAsRoom(floatBoard(), M.buyStock(BO), P2, GRID);
    const sentence = "B&O places its home station at the start of its first operating turn, and it is not operating now.";
    expect(homePlacementRefusal(floated, home(BO, "I15").PlaceHomeStation, GRID, table)).toBe(sentence);
    expect(ingress(floated, P2, home(BO, "I15"), GRID)).toBe(sentence);
    expect(same(applyAsRoom(floated, home(BO, "I15"), P2, GRID), floated)).toBe(true);
  });

  it("the corporation owes its home when it is under the cursor at the start of its first operating turn", () => {
    const state = orBoard(BO);
    expect(owedHomeStation(state, table)).toMatchObject({ companyId: BO, ticker: "B&O", president: P2, choices: [{ hexLabel: "I15" }] });
    expect(homeStationOwed(state, BO, table)).toBe(true);
    for (const other of [PRR, ERIE, NYC, NNH]) expect(homeStationOwed(state, other, table)).toBe(false);
  });

  it("placing it resolves the obligation; the same corporation stays current at the same step with no turn artifact", () => {
    const before = orBoard(BO);
    const placed = applyAsRoom(before, home(BO, "I15"), P2, GRID);
    expect(tokens(placed, BO)).toEqual([key("I15")]);
    expect(owedHomeStation(placed, table)).toBeNull();
    expect(placed.active_corporation_index).toBe(before.active_corporation_index);
    expect(placed.active_operating_order).toEqual(before.active_operating_order);
    expect(placed.operating_sub_phase).toBe("Track");
    expect(placed.active_player_index).toBe(before.active_player_index);
    expect(placed.consecutive_passes).toBe(before.consecutive_passes);
    expect(placed.turn_action_taken ?? false).toBe(before.turn_action_taken ?? false);
    // The home token is free (6.3.1): no treasury, no bank.
    expect(corp(placed, BO).treasury).toBe(corp(before, BO).treasury);
    expect(placed.virtual_bank_vgp).toBe(before.virtual_bank_vgp);
  });

  it("a later operating turn does not owe the home again", () => {
    const later = withCorp(orBoard(BO, "Track"), BO, { station_token_hexes: [at("I15")] });
    expect(owedHomeStation(later, table)).toBeNull();
    expect(homeStationHold(later, M.layTile(BO) as never, table)).toBeNull();
  });

  it("a floated corporation that never reaches a turn never touches the map (the game ends first)", () => {
    const floated = applyAsRoom(floatBoard(), M.buyStock(BO), P2, GRID);
    const ended = withState(floated, { current_round_type: "GameEnd" });
    expect(owedHomeStation(ended, table)).toBeNull();
    expect(corp(ended, BO).station_token_hexes).toEqual([]);
  });

  it("a corporation floated while an Operating Round is open is outside its membership and owes nothing until a later round's turn", () => {
    // B&O floated but not in this round's frozen membership (#1600): PRR and NYC operate.
    const open = withState(withCorp(orBoard(PRR), NYC, { station_token_hexes: [at("E19")] }), { active_operating_order: [PRR, NYC], active_corporation_index: 0 });
    for (const index of [0, 1]) {
      const cursorAt = withState(open, { active_corporation_index: index });
      expect(homeStationOwed(cursorAt, BO, table)).toBe(false);
      expect(owedHomeStation(cursorAt, table)).toBeNull();
    }
    // The next round's queue includes it, and at its turn it owes.
    const nextRound = withState(open, { active_operating_order: [PRR, BO, NYC], active_corporation_index: 1, macro_round_number: 4 });
    expect(homeStationOwed(nextRound, BO, table)).toBe(true);
  });
});

/* ================================================================== */
/* §25 the hold: turn-local, one sentence, derived loop silent                                            */
/* ================================================================== */

describe("§25 while the operating corporation owes its home, nothing else happens (S8-5 / S8-12, #1612)", () => {
  const HOLD = "B&O is starting its first operating turn and its home station is not on the board yet. p2 must place it on I15 before B&O can operate.";

  it("refuses every ordinary action at both locks with the one sentence, and moves nothing", () => {
    const held = orBoard(BO);
    const messages: Array<[string, unknown, string]> = [
      ["LayTile", M.layTile(BO), P2],
      ["PlaceStationToken", M.token(BO), P2],
      ["RunMultipleRoutes", M.run(BO), P2],
      ["DeclareDividends", M.dividend(BO), P2],
      ["BuyHardwareFromPool", M.depot(BO), P2],
      ["AdvanceOperatingSubPhase", M.advance(BO), P2],
      ["PassTurn", M.pass, P2],
      ["SellStock (a stock move out of place)", M.sellStock(PRR, 10), P1],
      ["BuyStock (a stock move out of place)", M.buyStock(PRR), P1],
      ["ProposeTrainPurchase", M.proposeTrain(PRR, BO, "2", "80"), P2],
      ["the D&H's free station", home(BO, "F16", null, "dh"), P2],
    ];
    for (const [label, msg, actor] of messages) {
      expect([label, homeStationHold(held, msg as never, table)]).toEqual([label, HOLD]);
      expect([label, authoritativeHoldRefusal(held, msg as never, { mapGrid: GRID, homeHexToAxial: table })]).toEqual([label, HOLD]);
      expect([label, ingress(held, actor, msg, GRID)]).toEqual([label, HOLD]);
      expect([label, same(applyAsRoom(held, msg, actor, GRID), held)]).toEqual([label, true]);
    }
  });

  it("lets the placement itself through, and the room's own exits", () => {
    const held = orBoard(BO);
    expect(homeStationHold(held, home(BO, "I15") as never, table)).toBeNull();
    expect(ingress(held, P2, home(BO, "I15"), GRID)).toBeNull();
    for (const exit of [M.revert(0), M.closeRoom, { UndoLastAction: { game_id: 1 } }]) {
      expect(homeStationHold(held, exit as never, table)).toBeNull();
    }
  });

  it("names the operating corporation, its president and its hex to every seat (the shell's Pass reason)", () => {
    expect(homeTokenBlock({ state: orBoard(BO), homeHexToAxial: table, labelForAddress: (address) => address.toUpperCase() })).toBe(
      "B&O is starting its first operating turn and its home station is not on the board yet. P2 must place it on I15 before B&O can operate.",
    );
  });

  it("derives nothing while the home is owed, and resumes the derived flow once it is placed", () => {
    // A tokenless trainless corporation at Routes would be walked through its turn by the auto-skips.
    const atRoutes = orBoard(BO, "Routes");
    expect(nextDerivedAction({ state: atRoutes, mapGrid: GRID, emitted: new Set() })).toBeNull();
    const placed = applyAsRoom(atRoutes, home(BO, "I15"), P2, GRID);
    expect(tokens(placed, BO)).toEqual([key("I15")]);
    expect(nextDerivedAction({ state: placed, mapGrid: GRID, emitted: new Set() })).not.toBeNull();
  });

  it("another corporation lacking its home never holds the corporation that is operating", () => {
    const prrTurn = orBoard(PRR, "Track"); // B&O, ERIE, NYC and NNH all lack tokens; PRR has its home
    expect(owedHomeStation(prrTurn, table)).toBeNull();
    for (const msg of [M.layTile(PRR), M.advance(PRR), M.pass]) {
      expect(authoritativeHoldRefusal(prrTurn, msg as never, { mapGrid: GRID, homeHexToAxial: table })).toBeNull();
      expect(homeStationHold(prrTurn, msg as never, table)).toBeNull();
    }
    // A trainless PRR at Routes is skipped as usual: the other corporations' missing homes do not stop the loop.
    const prrAtRoutes = withCorp(withState(prrTurn, { operating_sub_phase: "Routes" }), PRR, { owned_trains: [] });
    expect(nextDerivedAction({ state: prrAtRoutes, mapGrid: GRID, emitted: new Set() })).not.toBeNull();
  });
});

/* ================================================================== */
/* §26 where a home may go: fixed homes, NYC, Erie, NNH's locked circle, heralds                           */
/* ================================================================== */

describe("§26 the placement is judged, not trusted (S8-6, #1611)", () => {
  const refusedAtBothLocks = (state: GameStateResponse, actor: string, msg: { PlaceHomeStation: { company_id: number } & Record<string, unknown> }, sentence: string) => {
    expect(homePlacementRefusal(state, msg.PlaceHomeStation as never, GRID, table)).toBe(sentence);
    expect(ingress(state, actor, msg, GRID)).toBe(sentence);
    expect(same(applyAsRoom(state, msg, actor, GRID), state)).toBe(true);
  };

  it("an ordinary fixed home: the printed hex is accepted; the wrong hex, the wrong circle and a second home are refused", () => {
    const state = orBoard(BO);
    expect(homeHexChoicesFor(corp(state, BO), table)).toEqual([{ hexLabel: "I15", q: hexAt("I15").q, r: hexAt("I15").r }]);
    refusedAtBothLocks(state, P2, home(BO, "F6"), `B&O's home station goes on I15, not on F6.`);
    refusedAtBothLocks(state, P2, home(BO, "I15", 1), "I15 has one city; there is no city 2 there.");
    expect(homePlacementRefusal(state, home(BO, "I15", 0).PlaceHomeStation, GRID, table)).toBeNull();
    const placed = applyAsRoom(state, home(BO, "I15"), P2, GRID);
    expect(tokens(placed, BO)).toEqual([key("I15")]);
    refusedAtBothLocks(placed, P2, home(BO, "I15"), "B&O's home station is already on the board.");
    // `placeHomeStationToken` asks the same predicate: nothing bypasses it.
    expect(placeHomeStationToken(state, BO, ...at("F6"), null, table, GRID)).toBe(state);
  });

  it("a corporation that is not operating, or has not floated, is refused", () => {
    const state = orBoard(BO);
    refusedAtBothLocks(state, P1, home(NYC, "E19"), "NYC places its home station at the start of its first operating turn, and it is not operating now.");
    const unfloated = withCorp(state, BO, { is_floated: false });
    expect(homePlacementRefusal(unfloated, home(BO, "I15").PlaceHomeStation, GRID, table)).toBe(
      "B&O has not floated. A corporation places its home station at the start of its first operating turn.",
    );
    expect(same(applyAsRoom(unfloated, home(BO, "I15"), P2, GRID), unfloated)).toBe(true);
  });

  it("NYC's home needs no tile on E19 (6.3.1's note): the untiled printed city takes it", () => {
    const state = orBoard(NYC);
    expect(GRID.tiles.some((tile) => tile.q === hexAt("E19").q && tile.r === hexAt("E19").r)).toBe(false);
    expect(homePlacementRefusal(state, home(NYC, "E19").PlaceHomeStation, GRID, table)).toBeNull();
    expect(ingress(state, P1, home(NYC, "E19"), GRID)).toBeNull();
    expect(tokens(applyAsRoom(state, home(NYC, "E19"), P1, GRID), NYC)).toEqual([key("E19")]);
  });

  it("Erie may take either city of E11 when it is free, with no tile, for nothing; not a circle that is taken, not off its hex", () => {
    const state = orBoard(ERIE);
    expect(legalHomeTargets(state, GRID, table).map((target) => `${target.hexLabel}:${target.cityIndex}`)).toEqual(["E11:0", "E11:1"]);
    for (const cityIndex of [0, 1]) {
      const placed = applyAsRoom(state, home(ERIE, "E11", cityIndex), P3, GRID);
      expect(corp(placed, ERIE).station_tokens).toEqual([[hexAt("E11").q, hexAt("E11").r, cityIndex]]);
      expect(corp(placed, ERIE).treasury).toBe(corp(state, ERIE).treasury);
      expect(ingress(state, P3, home(ERIE, "E11", cityIndex), GRID)).toBeNull();
    }
    refusedAtBothLocks(state, P3, home(ERIE, "E11"), "E11 has 2 cities; the placement must say which one ERIE's home station goes in.");
    refusedAtBothLocks(state, P3, home(ERIE, "I15", 0), "ERIE's home station goes on E11, not on I15.");
    // NYC already sits in circle 0 (a legal placement: one slot of the two was never Erie's to hold).
    const taken = withCorp(state, NYC, { station_token_hexes: [at("E11")], station_tokens: [[hexAt("E11").q, hexAt("E11").r, 0]] });
    refusedAtBothLocks(taken, P3, home(ERIE, "E11", 0), "This city's only station slot is taken.");
    expect(legalHomeTargets(taken, GRID, table).map((target) => target.cityIndex)).toEqual([1]);
  });

  it("Erie's reservation keeps one E11 city for it: another corporation may take one, never the second", () => {
    withRules(resolveVariants({}), () => {
      const state = orBoard(PRR);
      const probe = { ...corp(state, NNH), station_token_hexes: [] as Array<[number, number]> }; // no network: only the city rules speak
      const [q, r] = at("E11");
      expect(evaluateStationPlacement({ mapGrid: GRID, q, r, company: probe, allCompanies: state.public_companies, cityIndex: 0 }).allowed).toBe(true);
      const oneTaken = withCorp(state, NYC, { station_token_hexes: [at("E11")], station_tokens: [[q, r, 0]] });
      const second = evaluateStationPlacement({ mapGrid: GRID, q, r, company: probe, allCompanies: oneTaken.public_companies, cityIndex: 1 });
      expect(second.allowed).toBe(false);
      expect(second.reason).toContain("reserved as a home station");
      // Once Erie has its home the reservation is spent.
      const erieHome = withCorp(state, ERIE, { station_token_hexes: [at("E11")], station_tokens: [[q, r, 1]] });
      expect(evaluateStationPlacement({ mapGrid: GRID, q, r, company: probe, allCompanies: erieHome.public_companies, cityIndex: 0 }).allowed).toBe(true);
    });
  });

  it("a fixed home on a two-city hex (NNH, New York) is the circle its reservation marks, not the other", () => {
    const state = orBoard(NNH);
    refusedAtBothLocks(state, P2, home(NNH, "G19", 1), "NNH's home station on G19 is city 1, the one its reservation marks.");
    expect(tokens(applyAsRoom(state, home(NNH, "G19", 0), P2, GRID), NNH)).toEqual([key("G19")]);
  });

  it("a printed herald owes no token and cannot place one (PRR on the expanded map, #1302)", () => {
    withRules(resolveVariants({ expandedMap: true }), () => {
      const state = withState(withCorp(orBoard(PRR), PRR, { station_token_hexes: [] }), { variants: resolveVariants({ expandedMap: true }) });
      expect(owedHomeStation(state, table)).toBeNull();
      expect(homePlacementRefusal(state, home(PRR, "H12").PlaceHomeStation, GRID, table)).toBe(
        "PRR's home is printed on the board, so it places no home station.",
      );
    });
  });
});

/* ================================================================== */
/* §29 S8-14 the Erie's OO home hex: last-opportunity protection, then the whole hex once tiled (#1617)      */
/* ================================================================== */

describe("§29 S8-14: the Erie's E11 -- one city protected before a tile, the whole hex closed after one, ordinary rules after its home (#1617)", () => {
  const E11 = () => hexAt("E11");
  /** E11 after a tile has been laid there in play (tile 59, the OO pair), through the grid's own lay step. */
  const tiledE11 = (): MapGridResponse => applySandboxLayTile(GRID, E11().q, E11().r, 59, 0, () => false);
  /** PRR at the Tokens step with no home and no token: it owes nothing and has no network, so the city rules answer. */
  const prrAtTokens = () => withCorp(orBoard(PRR, "Tokens"), PRR, { home_hex_label: undefined, station_token_hexes: [], station_tokens: [] });
  const stationAt = (companyId: number, cityIndex: number | null) => ({
    PlaceStationToken: { game_id: 1, protocol_id: companyId, q: E11().q, r: E11().r, city_index: cityIndex },
  });
  /** NYC's station in E11's circle `cityIndex`, placed while that was legal. */
  const nycIn = (state: GameStateResponse, cityIndex: number) =>
    withCorp(state, NYC, { station_token_hexes: [[E11().q, E11().r]], station_tokens: [[E11().q, E11().r, cityIndex]] });
  /** A paid placement asked of the gate, of ingress and of the reducer as a room runs it: the three must agree. */
  const atBothLocks = (state: GameStateResponse, msg: ReturnType<typeof stationAt>, grid: MapGridResponse) => {
    const gate = stationPlacementRefusal(state, msg.PlaceStationToken, grid);
    const lock = ingress(state, P1, msg, grid);
    const moved = !same(applyAsRoom(state, msg, P1, grid), state);
    return { gate, lock, moved };
  };
  const closed = "ERIE has not placed its home station on E11 yet and a tile has been laid there, so no other corporation may place a station on E11 until it does.";

  it("the tile is real: the lay puts tile 59 on E11 and the hex still has its two one-slot cities", () => {
    const grid = tiledE11();
    expect(grid.tiles.map((tile) => [tile.q, tile.r, tile.tile_id])).toEqual([[E11().q, E11().r, 59]]);
    expect(evaluateStationPlacement({ mapGrid: grid, q: E11().q, r: E11().r, company: corp(orBoard(ERIE), ERIE), allCompanies: [], cityIndex: 1 }).allowed).toBe(true);
  });

  it("(1) before a tile: another corporation may take one city while the other remains, never the last one -- at both locks", () => {
    const state = prrAtTokens();
    expect(atBothLocks(state, stationAt(PRR, 0), GRID)).toEqual({ gate: null, lock: null, moved: true });
    const oneTaken = nycIn(state, 0);
    const last = "This city's remaining slot is reserved as a home station for company #6 and cannot be taken.";
    expect(atBothLocks(oneTaken, stationAt(PRR, 1), GRID)).toEqual({ gate: last, lock: last, moved: false });
    expect(closedOoHomeAt(GRID, E11().q, E11().r, corp(state, PRR), state.public_companies)).toBeNull();
  });

  it("(2) after a tile, before ERIE's home: no other corporation may place in either city, at either lock, nor light the hex", () => {
    const grid = tiledE11();
    const state = prrAtTokens();
    for (const cityIndex of [0, 1, null]) {
      expect([cityIndex, atBothLocks(state, stationAt(PRR, cityIndex), grid)]).toEqual([cityIndex, { gate: closed, lock: closed, moved: false }]);
    }
    expect(closedOoHomeAt(grid, E11().q, E11().r, corp(state, PRR), state.public_companies)).toMatchObject({ companyId: ERIE, label: "E11" });
    const board = STATIC_BOARD_HEXES.map((hex) => [hex.q, hex.r] as const);
    expect(placeableStationHexes({ mapGrid: grid, company: corp(state, PRR), allCompanies: state.public_companies, boardHexes: board }).has(`${E11().q},${E11().r}`)).toBe(false);
    expect(placeableStationHexes({ mapGrid: GRID, company: corp(state, PRR), allCompanies: state.public_companies, boardHexes: board }).has(`${E11().q},${E11().r}`)).toBe(true);
  });

  it("(2) a station placed before the tile stays where it is; nothing is added beside it; ERIE may still take the free city", () => {
    // NYC took circle 0 while that was legal. PRR then lays the tile through the reducer's own lay arm -- which may
    // move or clamp a token on the hex (#824, #1315) but never removes one -- and the grid takes the same tile.
    const beforeTile = nycIn(withCorp(orBoard(PRR, "Track"), PRR, { home_hex_label: undefined, station_token_hexes: [], station_tokens: [] }), 0);
    const lay = { LayTile: { game_id: 1, protocol_id: PRR, q: E11().q, r: E11().r, tile_id: 59, orientation: 0 } };
    const afterLay = applyAsRoom(beforeTile, lay, P1, GRID);
    expect(same(afterLay, beforeTile)).toBe(false); // the lay was applied
    expect(corp(afterLay, NYC).station_tokens).toEqual([[E11().q, E11().r, 0]]); // and NYC's station is still in circle 0
    const grid = tiledE11();
    expect(atBothLocks(withState(afterLay, { operating_sub_phase: "Tokens" }), stationAt(PRR, 1), grid)).toEqual({ gate: closed, lock: closed, moved: false });
    // ERIE, at the start of its first turn on the same board, places its home in the city left free -- not the taken one.
    const erieTurn = nycIn(orBoard(ERIE), 0);
    expect(homePlacementRefusal(erieTurn, home(ERIE, "E11", 1).PlaceHomeStation, grid, table)).toBeNull();
    expect(ingress(erieTurn, P3, home(ERIE, "E11", 1), grid)).toBeNull();
    const placed = applyAsRoom(erieTurn, home(ERIE, "E11", 1), P3, grid);
    expect(corp(placed, ERIE).station_tokens).toEqual([[E11().q, E11().r, 1]]);
    expect(corp(placed, NYC).station_tokens).toEqual([[E11().q, E11().r, 0]]);
    const taken = "This city's only station slot is taken.";
    expect(homePlacementRefusal(erieTurn, home(ERIE, "E11", 0).PlaceHomeStation, grid, table)).toBe(taken);
    expect(ingress(erieTurn, P3, home(ERIE, "E11", 0), grid)).toBe(taken);
    expect(same(applyAsRoom(erieTurn, home(ERIE, "E11", 0), P3, grid), erieTurn)).toBe(true);
    // And on a tiled hex nobody has touched, ERIE may take either city (no tile was ever required of it).
    for (const cityIndex of [0, 1]) expect(homePlacementRefusal(orBoard(ERIE), home(ERIE, "E11", cityIndex).PlaceHomeStation, grid, table)).toBeNull();
  });

  it("(3) once ERIE's home is placed the special reservation ends and ordinary rules govern the other city", () => {
    const grid = tiledE11();
    const homed = withCorp(prrAtTokens(), ERIE, { station_token_hexes: [[E11().q, E11().r]], station_tokens: [[E11().q, E11().r, 1]] });
    expect(closedOoHomeAt(grid, E11().q, E11().r, corp(homed, PRR), homed.public_companies)).toBeNull();
    expect(atBothLocks(homed, stationAt(PRR, 0), grid)).toEqual({ gate: null, lock: null, moved: true });
    // Ordinary rules: ERIE's own city is full.
    const full = "This city's only station slot is taken.";
    expect(atBothLocks(homed, stationAt(PRR, 1), grid)).toEqual({ gate: full, lock: full, moved: false });
  });

  it("a tile the board printed does not close the hex (#1301): only a tile laid in play does", () => {
    const printed = { game_id: 1, tiles: [{ ...tiledE11().tiles[0], printed: true }] } as unknown as MapGridResponse;
    const state = prrAtTokens();
    expect(closedOoHomeAt(printed, E11().q, E11().r, corp(state, PRR), state.public_companies)).toBeNull();
    expect(atBothLocks(state, stationAt(PRR, 0), printed)).toEqual({ gate: null, lock: null, moved: true });
  });

  it("New York's locked circle is not an OO home: a tiled G19 keeps #1511's one-circle rule for NNH", () => {
    const g19 = hexAt("G19");
    const state = prrAtTokens();
    const tiled = { game_id: 1, tiles: [{ q: g19.q, r: g19.r, tile_id: 54, orientation: 0 }] } as unknown as MapGridResponse; // green NY
    expect(closedOoHomeAt(tiled, g19.q, g19.r, corp(state, PRR), state.public_companies)).toBeNull();
  });
});

/* ================================================================== */
/* #1615 the D&H's free station is not a home placement                                                     */
/* ================================================================== */

describe("the D&H's free station is judged by its own rules and never takes the home slot (#1615)", () => {
  /* Design note #1660 (S9-12): F16 with tile #57 down -- the one city the D&H's own lay creates, and the
     grid every legality check below needs to see a destination at all. `applySandboxLayTile` is the same
     mutator `tiledE11()` above uses for E11's green upgrade. */
  const dhGrid = (): MapGridResponse => applySandboxLayTile(GRID, ...at("F16"), 57, 0, () => false);

  const dhBoard = () =>
    withCorp(
      withState(orBoard(BO, "Tokens"), {
        private_companies: [{ private_id: DH_PRIVATE, name: "Delaware & Hudson", cost: "70", revenue_per_or: "15", owner: null, owner_protocol_id: BO, closed: false }],
        /* #1660: the D&H's own lay has happened, and this is still that same operating turn -- the two
           facts `dhStationRefusal` asks for beyond the shared arm's old floated/not-already-there pair. */
        used_private_abilities: ["dh-tile"],
        dh_station_pending: BO,
      }),
      BO,
      { station_token_hexes: [at("I15")], station_tokens: [] },
    );

  it("is appended after the home, free, and not asked the home predicate", () => {
    const state = dhBoard();
    const grid = dhGrid();
    const after = applyAsRoom(state, home(BO, "F16", 0, "dh"), P2, grid);
    expect(tokens(after, BO)).toEqual([key("I15"), key("F16")]);
    expect(corp(after, BO).treasury).toBe(corp(state, BO).treasury);
    expect(homePlacementRefusal(state, home(BO, "F16").PlaceHomeStation, grid, table)).toBe("B&O's home station is already on the board.");
    const direct = placeDhFreeStationToken(state, BO, ...at("F16"), 0, grid);
    expect(corp(direct, BO).station_token_hexes.map(([q, r]) => `${q},${r}`)).toEqual([key("I15"), key("F16")]);
    expect(corp(direct, BO).station_tokens).toEqual([[hexAt("F16").q, hexAt("F16").r, 0]]);
  });

  it("without a grid, the shared arm's old pair still stands: floated, not already on the hex", () => {
    /* #757: no board-dependent arm is asked without a grid, so a caller that cannot supply one (the same
       caller `placeHomeStationToken` has always tolerated) still gets a placement rather than a silent
       no-op invented by a check it could never satisfy. */
    const state = dhBoard();
    const direct = placeDhFreeStationToken(state, BO, ...at("F16"), 0);
    expect(tokens(direct, BO)).toEqual([key("I15"), key("F16")]);
  });
});
