/** @jest-environment node */
//
// ==================================================================
//  STAGE 8, SLICE 8.2 -- S8-13: A HELD MESSAGE MOVES NOTHING, THE CHART INCLUDED (#1613)
// ==================================================================
//
// PROVEN ON THE CORPUS (Stage-8 design §5.8): server/JUNO-FCJ 904 / 911 / 918 / 932 were `SellStock` entries sent under
// the old float-time home hold; the core refused each sale after `applySandboxMarketAction` had already walked the
// seller's token down the chart. The four authoritative holds now run in `applySandboxActionOnBoard`, before the
// auction and chart atoms, in their priority -- excess-train discard (#1530), forced purchase and the finished game
// (#1540), a standing ordinary offer (#1590), the operating corporation's home station (#1612). Each case below
// takes a message that DOES move the chart on the same board without the hold (the control), and shows that under
// the hold the chart -- and every other field -- is untouched.
//
// AND THE GRID. A lay touches a third atom, and the room engine and the shell both move it before the reducer runs
// (#757). S8-13's own check -- "no other partial mutation before refusal" -- found it moving for a held lay: the tile
// landed on the grid while the reducer refused the lay by identity. The last describe pins both steps.

import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES, STANDARD_BOARD, activateBoard } from "../components/hexBoardData";
import { boardHomeHexToAxial, homeStationHold } from "../gameEngine/homeStationAuthority";
import { pendingDiscardBlock } from "../gameEngine/trainDiscard";
import { pendingOfferBlock } from "../gameEngine/pendingOfferHold";
import { emergencyFundingBlock } from "../gameEngine/emergencyFunding";
import { authoritativeHoldRefusal } from "../gameEngine/sandboxSession";
import { board, operatingBoard, stockRoundBoard, P1, P2, P3, PRR, NYC, CO, DH } from "./offerFixtures74";
import { M, corridor, fundingBoard, ingress, same, withCorp, withState } from "./offerMatrix74Support";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { readFileSync } from "fs";
import { join } from "path";
import { RoomEngine, entriesFromExport, type ExportedEntry } from "../gameEngine/replayLog";
import { effectiveActions } from "../gameEngine/logRevert";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { stateDigest } from "../gameEngine/stateDigest";
import { owedHomeStation } from "../gameEngine/homeStationAuthority";
import { readStripped, sliceBetween } from "./sourceScan";
import { tileEraFor } from "../gameEngine/gameConstants";
import type { GameplayExecuteMsg } from "./sessionKey";

const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
const table = boardHomeHexToAxial;
/** The reducer exactly as `RoomEngine.apply` calls it -- the chart injections, the author, the grid, the era, and the
 *  market context the chart step needs to price a sale or a dividend (without it the chart has no move to make, and
 *  a "nothing moved" assertion would prove nothing). */
const applyAsEngine = (state: GameStateResponse, msg: unknown, actor: string, mapGrid: MapGridResponse = GRID) => {
  const providers = sandboxReplayProviders();
  return applySandboxAction(state, msg as GameplayExecuteMsg, {
    ...providers.chartInjections(state),
    actor,
    mapGrid,
    era: tileEraFor(state),
    marketContext: providers.marketContext(state, msg as GameplayExecuteMsg, actor),
    parCellFor: providers.parCellFor,
  });
};
const apply = (state: GameStateResponse, msg: unknown, actor: string, mapGrid: MapGridResponse = GRID) => applyAsEngine(state, msg, actor, mapGrid);
const applyAsRoom = applyAsEngine;
const holds = (state: GameStateResponse, msg: unknown, mapGrid: MapGridResponse = GRID) =>
  authoritativeHoldRefusal(state, msg as never, { mapGrid, homeHexToAxial: table });

afterAll(() => activateBoard(STANDARD_BOARD));

const at = (label: string): [number, number] => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
  return [hex.q, hex.r];
};

/** An Operating board at Dividends for the operating corporation (a withhold moves its token one column left). */
const atDividends = (state: GameStateResponse) => withState(state, { operating_sub_phase: "Dividends" });
const withhold = (id: number) => ({ DeclareDividends: { game_id: 1, protocol_id: id, revenue_amount: "0", distribute: false } });

describe("S8-13: under each hold, a message that would move the chart moves nothing (#1613)", () => {
  it("the home-station hold: a withhold by the tokenless operating corporation leaves its token where it is", () => {
    // Control: C&O with its home placed withholds at Dividends and its token steps left.
    const placed = withCorp(atDividends(operatingBoard({ operating: CO })), CO, { home_hex_label: "F6", station_token_hexes: [at("F6")] });
    const moved = applyAsRoom(placed, withhold(CO), P3, GRID);
    expect(moved.market_positions?.[CO]).not.toEqual(placed.market_positions?.[CO]);
    // The same board with C&O's home still owed: held, and the chart does not move.
    const held = withCorp(placed, CO, { station_token_hexes: [] });
    expect(homeStationHold(held, withhold(CO) as never, table)).toContain("C&O is starting its first operating turn");
    const after = applyAsRoom(held, withhold(CO), P3, GRID);
    expect(after.market_positions).toEqual(held.market_positions);
    expect(same(after, held)).toBe(true);
    expect(ingress(held, P3, withhold(CO), GRID)).toBe(homeStationHold(held, withhold(CO) as never, table));
  });

  it("the offer hold: a Stock Round sale while a player's trade offer stands leaves the chart untouched (D-24's latent case)", () => {
    // Control: P1 sells 10% of PRR in the second Stock Round and PRR's token drops.
    const srBoard = stockRoundBoard({ privates: [{ id: DH, owner: P2, cost: "70" }] });
    const sold = apply(srBoard, M.sellStock(PRR, 10), P1);
    expect(sold.market_positions?.[PRR]).not.toEqual(srBoard.market_positions?.[PRR]);
    // With the trade standing, the same sale is held at both locks and nothing moves.
    const offered = apply(srBoard, M.proposeTrade(DH, P2, P1, 50), P1);
    expect(offered.private_trade_offer).not.toBeNull();
    const sentence = pendingOfferBlock(offered, M.sellStock(PRR, 10) as never);
    expect(sentence).not.toBeNull();
    expect(holds(offered, M.sellStock(PRR, 10))).toBe(sentence);
    expect(ingress(offered, P1, M.sellStock(PRR, 10))).toBe(sentence);
    const after = apply(offered, M.sellStock(PRR, 10), P1);
    expect(after.market_positions).toEqual(offered.market_positions);
    expect(same(after, offered)).toBe(true);
  });

  it("the discard hold: a withhold while a corporation is over its train limit leaves the chart untouched", () => {
    const base = atDividends(withCorp(operatingBoard(), CO, { owned_trains: ["4"] }));
    const control = applyAsRoom(base, withhold(PRR), P1, GRID);
    expect(control.market_positions?.[PRR]).not.toEqual(base.market_positions?.[PRR]);
    const over = withCorp(base, NYC, { owned_trains: ["3", "3", "2", "2"] });
    const sentence = pendingDiscardBlock(over, withhold(PRR) as never);
    expect(sentence).not.toBeNull();
    expect(holds(over, withhold(PRR))).toBe(sentence);
    const after = applyAsRoom(over, withhold(PRR), P1, GRID);
    expect(after.market_positions).toEqual(over.market_positions);
    expect(same(after, over)).toBe(true);
  });

  it("the funding hold: nothing but the obligation's own messages lands, and a held message changes no field", () => {
    const owed = fundingBoard(100);
    const sentence = emergencyFundingBlock(owed, M.pass as never, corridor());
    expect(sentence).not.toBeNull();
    expect(holds(owed, M.pass, corridor())).toBe(sentence);
    expect(same(applyAsRoom(owed, M.pass, P1, corridor()), owed)).toBe(true);
  });

  it("a legal sale with no hold standing still moves the chart (the hold is not a general freeze)", () => {
    const srBoard = stockRoundBoard();
    expect(holds(srBoard, M.sellStock(PRR, 10))).toBeNull();
    expect(apply(srBoard, M.sellStock(PRR, 10), P1).market_positions?.[PRR]).not.toEqual(srBoard.market_positions?.[PRR]);
  });
});

describe("the holds keep their priority: discard, then funding and the finished game, then an offer, then the home station", () => {
  it("names the first hold that stands", () => {
    // An over-limit corporation on a finished game: the discard speaks first.
    const discardAndEnded = withState(withCorp(withCorp(operatingBoard(), CO, { owned_trains: ["4"] }), NYC, { owned_trains: ["3", "3", "2", "2"] }), {
      current_round_type: "GameEnd",
    });
    expect(holds(discardAndEnded, M.pass)).toBe(pendingDiscardBlock(discardAndEnded, M.pass as never));
    // The finished game beside a standing trade offer: the finished game speaks.
    const offered = apply(stockRoundBoard({ privates: [{ id: DH, owner: P2, cost: "70" }] }), M.proposeTrade(DH, P2, P1, 50), P1);
    const endedWithOffer = withState(offered, { current_round_type: "GameEnd" });
    expect(holds(endedWithOffer, M.pass)).toBe("The game has ended. Nothing further can be played.");
    // The designed D-6 coexistence -- a train offer beside the forced purchase: the funding obligation speaks.
    const d6 = apply(fundingBoard(100), M.proposeTrain(PRR, CO, "3", "130", null), P1, corridor());
    expect(holds(d6, M.pass, corridor())).toBe(emergencyFundingBlock(d6, M.pass as never, corridor()));
    // A standing offer at the start of a turn whose corporation owes its home (hand-built): the offer speaks.
    const homeOwed = withCorp(board({ round: "OperatingRound", corps: [{ id: CO, ticker: "C&O", president: P3, trains: [] }, { id: PRR, ticker: "PRR", president: P1, trains: ["2"] }], step: "Track" }), CO, {
      home_hex_label: "F6",
    });
    const offerAndHome = withState(homeOwed, { private_trade_offer: offered.private_trade_offer });
    expect(homeStationHold(offerAndHome, M.pass as never, table)).not.toBeNull();
    expect(holds(offerAndHome, M.pass)).toBe(pendingOfferBlock(offerAndHome, M.pass as never));
    // Only the home station owed: it speaks.
    expect(holds(homeOwed, M.pass)).toBe(homeStationHold(homeOwed, M.pass as never, table));
    expect(P2).toBe("p2");
  });
});

/* ==================================================================
    #1613 ON THE GRID: A HELD LAY LANDS ON NEITHER ATOM
   ==================================================================
   Read on the frozen JUNO-CV4 log walked through a bare `RoomEngine` -- no development-corpus adapter -- so B&O's
   Stock-Round placement at 20 is refused as untimely, B&O's home is owed when its first operating turn opens after 26,
   and 27 is B&O's lay. Before #1613 reached the grid step, that lay's tile landed on the grid while the reducer refused
   the lay. The control places B&O's home first (the I15 choice it recorded at 20) and the same lay lands on both. */
describe("S8-13 on the grid: a lay under a hold lands on neither the grid nor the board (#1613)", () => {
  const CV4 = readFileSync(join(__dirname, "__fixtures__", "replayGolden", "logs", "JUNO-CV4.log.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExportedEntry);
  const walkTo = (index: number) => {
    const entries = effectiveActions([...entriesFromExport(CV4)].sort((a, b) => a.index - b.index));
    const providers = sandboxReplayProviders();
    const engine = new RoomEngine(providers, {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    });
    for (const entry of entries) {
      if (entry.index >= index) break;
      engine.apply(entry);
    }
    return { engine, providers, lay: entries.find((entry) => entry.index === index)! };
  };

  it("the room engine: B&O's lay with its home owed moves neither atom; with the home placed, the same lay lands on both", () => {
    const held = walkTo(27);
    expect(held.lay.payload).toContain('"LayTile"');
    const before = held.engine.snapshot;
    const homeTable = held.providers.chartInjections(before.state).homeHexToAxial!;
    expect(homeStationHold(before.state, JSON.parse(held.lay.payload), homeTable)).toMatch(/^B&O is starting its first operating turn/);
    held.engine.apply(held.lay);
    expect(held.engine.snapshot.grid.tiles).toEqual(before.grid.tiles);
    expect(stateDigest(held.engine.snapshot.state)).toBe(stateDigest(before.state));

    const placed = walkTo(27);
    const owed = owedHomeStation(placed.engine.snapshot.state, homeTable)!;
    expect(owed.ticker).toBe("B&O");
    placed.engine.apply({
      index: 26,
      id: "control-home",
      actor: owed.president!,
      payload: JSON.stringify({ PlaceHomeStation: { game_id: 0, company_id: owed.companyId, q: 3, r: 8, kind: "home", city_index: null } }),
    });
    const tiles = placed.engine.snapshot.grid.tiles.length;
    const state = placed.engine.snapshot.state;
    placed.engine.apply(placed.lay);
    expect(placed.engine.snapshot.grid.tiles.length).toBe(tiles + 1);
    expect(stateDigest(placed.engine.snapshot.state)).not.toBe(stateDigest(state));
  });

  it("both grid steps -- the room engine's and the shell's -- ask the reducer's hold predicate on the lay's snapshot", () => {
    /* Stage 10.1 (#1683): the grids no longer name the hold predicate themselves -- they ask `layTileRefusal`,
       the one `LayTile` composition, whose FIRST question is `authoritativeHoldRefusal`. Same guard, one
       layer up: the holds are still asked on the lay's snapshot, through the function the reducer asks. */
    const authority = readStripped("gameEngine/layTileAuthority.ts");
    expect(sliceBetween(authority, "export function layTileRefusal(", "return layTileLegalityRefusal(")).toContain(
      "authoritativeHoldRefusal(state, msg, ctx)",
    );
    const engine = readStripped("gameEngine/replayLog.ts");
    /* Stage 10.3 (#1690): both grid steps build the authority's injections with ONE function,
       `layAuthorityContext`, on the lay's snapshot -- so the two can no longer be handed two label tables or two
       grids. */
    expect(sliceBetween(engine, 'if ("LayTile" in msg) {', "this.grid = applySandboxLayTile(")).toContain(
      "layTileRefusal(stateBefore, msg, layAuthorityContext(this.providers, stateBefore, gridBefore))",
    );
    const app = readStripped("App.tsx");
    const predicate = sliceBetween(app, "const layRefusedByAuthority = (): boolean =>", 'if ("LayTile" in msg) {');
    // Stage 10.5 (S10-9): `layTileRefusal` takes the log-wide `SandboxLogMsg`, so the shell hands `msg` uncast.
    expect(predicate).toContain("layTileRefusal(\n                stateBeforeAction,\n                msg,");
    expect(predicate).toContain("layAuthorityContext(SHELL_PROVIDERS, stateBeforeAction, gridBeforeAction),");
    const builder = sliceBetween(readStripped("gameEngine/actionContext.ts"), "export function layAuthorityContext(", "\n}");
    expect(builder).toContain("mapGrid: gridBefore,");
    expect(builder).toContain("homeHexToAxial: providers.chartInjections(state).homeHexToAxial,");
  });
});
