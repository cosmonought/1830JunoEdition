/** @jest-environment node */
//
// Design note #1510: the corporation a message names is a claim the reducer now checks against the cursor.
//
// THE HOLE, IN ONE SENTENCE: `LayTile`, `PlaceStationToken` and `RunMultipleRoutes` carried a `protocol_id`
// and the arms applied whatever it said. The seat gate (`turnAuthority`) checks the SENDER is the operating
// corporation's president and nothing about which corporation the sender then acts for -- so a president of
// two corporations, or a hand-built message, acted for the one not operating. Batch 2 (#1449) recorded it;
// this batch closes it in the game-law layer, where #1182 first put it and then withdrew it.
//
// THE FIXTURE IS CHARTLESS ON PURPOSE. With no `market_positions` the reducer skips the chart step and a
// refusal comes back BY IDENTITY (#778), which is the assertion every refusal below makes: not "the token is
// missing", but "nothing whatsoever moved". A fixture with a chart would come back as a new object even when
// refused (the chart step copies the state), and identity is the stronger claim.

import { applySandboxAction } from "../gameEngine/sandboxSession";
import { operatingIdentityRefusal } from "../gameEngine/operatingIdentity";
import { operatingCorporationId } from "../gameEngine/dividendGate";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { GameplayExecuteMsg } from "./sessionKey";

const PRR = 1;
const BM = 8;
const PRESIDENT_OF_BOTH = "p1";
const OTHER = "p2";

/** An Operating Round in which PRR is operating and B&M is queued behind it. ONE PLAYER PRESIDES OVER BOTH,
 *  so the seat gate would let every message below through: what is being tested is the corporation, not
 *  the sender. */
function board(step: "Track" | "Tokens" | "Routes" = "Track"): GameStateResponse {
  return {
    player_addresses: [PRESIDENT_OF_BOTH, OTHER],
    player_cash: [
      { player: PRESIDENT_OF_BOTH, cash_vgp: "500" },
      { player: OTHER, cash_vgp: "500" },
    ],
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: [PRR, BM],
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    consecutive_passes: 0,
    operating_sub_phase: step,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: true,
        president: PRESIDENT_OF_BOTH,
        par_value: "100",
        ipo_pool_percentage: 0,
        bank_pool_percentage: 0,
        treasury: "1000",
        owned_trains: ["4"],
        player_holdings: [{ player: PRESIDENT_OF_BOTH, percentage: 100 }],
        station_token_hexes: [[2, 7]],
        station_tokens: [[2, 7, 0]],
        station_token_limit: 4,
        home_hex_label: "H12",
      },
      {
        company_id: BM,
        ticker: "B&M",
        is_floated: true,
        president: PRESIDENT_OF_BOTH,
        par_value: "100",
        ipo_pool_percentage: 0,
        bank_pool_percentage: 0,
        treasury: "1000",
        owned_trains: ["3"],
        player_holdings: [{ player: PRESIDENT_OF_BOTH, percentage: 100 }],
        station_token_hexes: [[9, 4]],
        station_tokens: [[9, 4, 0]],
        station_token_limit: 2,
        home_hex_label: "E23",
      },
    ],
  } as unknown as GameStateResponse;
}

const lay = (protocolId: number): GameplayExecuteMsg =>
  ({
    LayTile: { game_id: 0, protocol_id: protocolId, q: 4, r: 3, tile_id: 8, orientation: 0 },
  }) as never;

const token = (protocolId: number): GameplayExecuteMsg =>
  ({ PlaceStationToken: { game_id: 0, protocol_id: protocolId, q: 4, r: 3, city_index: 0 } }) as never;

const run = (protocolId: number): GameplayExecuteMsg =>
  ({
    RunMultipleRoutes: {
      game_id: 0,
      protocol_id: protocolId,
      routes: [[{ hex: "H12" }, { hex: "H10" }]],
      trains: ["4"],
      train_indices: [0],
      revenue_turn: "3.1.x",
    },
  }) as never;

const legacyRun = (protocolId: number): GameplayExecuteMsg =>
  ({ RunManualRoute: { game_id: 0, protocol_id: protocolId, path: [], payout_strategy: "Withhold" } }) as never;

const company = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)!;

describe("the fixture says what the tests assume", () => {
  it("has PRR operating, and one president over both corporations", () => {
    const state = board();
    expect(operatingCorporationId(state)).toBe(PRR);
    expect(company(state, PRR).president).toBe(company(state, BM).president);
  });
});

describe("a message naming a corporation that is not operating is refused (design note #1510)", () => {
  it("LayTile", () => {
    const before = board("Track");
    const after = applySandboxAction(before, lay(BM), { actor: PRESIDENT_OF_BOTH, layRefused: () => false });
    expect(after).toBe(before);
  });

  it("PlaceStationToken", () => {
    const before = board("Tokens");
    expect(applySandboxAction(before, token(BM), { actor: PRESIDENT_OF_BOTH })).toBe(before);
  });

  it("RunMultipleRoutes", () => {
    const before = board("Routes");
    expect(applySandboxAction(before, run(BM), { actor: PRESIDENT_OF_BOTH })).toBe(before);
  });

  it("RunManualRoute, the legacy run the schema still admits", () => {
    const before = board("Routes");
    expect(applySandboxAction(before, legacyRun(BM), { actor: PRESIDENT_OF_BOTH })).toBe(before);
  });

  it("names the rule, and both corporations, in the reason", () => {
    expect(operatingIdentityRefusal(board(), lay(BM))).toMatch(/PRR is operating, not B&M/);
    expect(operatingIdentityRefusal(board(), token(BM))).toMatch(/places a station token/);
    expect(operatingIdentityRefusal(board(), run(BM))).toMatch(/runs its trains/);
  });

  it("is about the corporation, not the sender: the named corporation's own president is refused too", () => {
    /* The seat gate passes this message -- the actor presides over the operating corporation -- and it would
       have passed it before this note. What decides is that B&M is not the corporation whose turn it is. */
    const before = board("Track");
    expect(company(before, BM).president).toBe(PRESIDENT_OF_BOTH);
    expect(applySandboxAction(before, lay(BM), { actor: PRESIDENT_OF_BOTH, layRefused: () => false })).toBe(
      before,
    );
  });

  it("refuses outside an Operating Round, where no corporation is operating", () => {
    const before = { ...board(), current_round_type: "StockRound" } as GameStateResponse;
    expect(applySandboxAction(before, lay(PRR), { actor: PRESIDENT_OF_BOTH, layRefused: () => false })).toBe(
      before,
    );
    expect(operatingIdentityRefusal(before, lay(PRR))).toMatch(/Operating Round/);
  });

  it("has no opinion about messages outside the family", () => {
    expect(operatingIdentityRefusal(board(), { PassTurn: { game_id: 0 } } as never)).toBeNull();
    expect(
      operatingIdentityRefusal(board(), { BuyStock: { game_id: 0, protocol_id: BM, source: "Ipo" } } as never),
    ).toBeNull();
  });
});

describe("the same actions for the corporation that IS operating still apply -- the controls", () => {
  it("LayTile advances the Track step", () => {
    const before = board("Track");
    const after = applySandboxAction(before, lay(PRR), { actor: PRESIDENT_OF_BOTH, layRefused: () => false });
    expect(after).not.toBe(before);
    expect(after.operating_sub_phase).toBe("Tokens");
  });

  it("RunMultipleRoutes records the run and moves to Dividends", () => {
    const before = board("Routes");
    const after = applySandboxAction(before, run(PRR), { actor: PRESIDENT_OF_BOTH });
    expect(after).not.toBe(before);
    expect(Number(company(after, PRR).last_route_revenue)).toBeGreaterThan(0);
    expect(after.operating_sub_phase).toBe("Dividends");
  });

  it("PlaceStationToken reaches the arm (no grid: the state-only rules only) and charges the schedule", () => {
    /* `ctx.mapGrid` absent is "no opinion" on the board rules (#1511), so this exercises the identity gate,
       the step, the allowance and the treasury, and then the arm. The board rules have their own file. */
    const before = board("Tokens");
    const after = applySandboxAction(before, token(PRR), { actor: PRESIDENT_OF_BOTH });
    expect(after).not.toBe(before);
    expect(company(after, PRR).station_token_hexes).toEqual([
      [2, 7],
      [4, 3],
    ]);
    expect(company(after, PRR).treasury).toBe("960");
  });
});

describe("an unresolvable cursor fails closed (no corporation is operating)", () => {
  it("refuses every message in the family when the Operating Round's queue cannot name a corporation", () => {
    /* NOT THE `dividendGate` POSITION, on purpose. That gate lets a `null` cursor through because the board
       still has a derived way forward; these messages act FOR a corporation and nothing derives them, so an
       unresolvable cursor means nobody may act. Two shapes of "unresolvable": an empty queue, and an index
       past the end of one. Both refuse, and the state comes back by identity. */
    for (const broken of [
      { active_operating_order: [] as number[], active_corporation_index: 0 },
      { active_operating_order: [PRR, BM], active_corporation_index: 7 },
    ]) {
      const before = { ...board("Track"), ...broken } as GameStateResponse;
      expect(operatingCorporationId(before)).toBeNull();
      expect(applySandboxAction(before, lay(PRR), { actor: PRESIDENT_OF_BOTH, layRefused: () => false })).toBe(before);
      expect(applySandboxAction(before, lay(BM), { actor: PRESIDENT_OF_BOTH, layRefused: () => false })).toBe(before);
      const atTokens = { ...before, operating_sub_phase: "Tokens" } as GameStateResponse;
      expect(applySandboxAction(atTokens, token(PRR), { actor: PRESIDENT_OF_BOTH })).toBe(atTokens);
      const atRoutes = { ...before, operating_sub_phase: "Routes" } as GameStateResponse;
      expect(applySandboxAction(atRoutes, run(PRR), { actor: PRESIDENT_OF_BOTH })).toBe(atRoutes);
      expect(applySandboxAction(atRoutes, legacyRun(PRR), { actor: PRESIDENT_OF_BOTH })).toBe(atRoutes);
      expect(operatingIdentityRefusal(before, lay(PRR))).toMatch(/No corporation is operating/);
    }
  });

  it("still has no opinion when the round itself is unstated (#232), which is the fixture case", () => {
    const unstated = { ...board("Track"), current_round_type: undefined } as unknown as GameStateResponse;
    expect(operatingIdentityRefusal(unstated, lay(BM))).toBeNull();
  });
});

describe("negative control: the ARM never checked, so the gate is the whole of the rule", () => {
  it("with the round unstated, the identical B&M run is applied by the arm", () => {
    /* THE PRE-#1510 BEHAVIOUR, REPRODUCED WITHOUT CHECKING OUT OLD CODE. The gate has no opinion about a
       board that does not say which round it is in (#232's rule, kept for the fixtures that exercise an arm
       in isolation). With that precondition removed, the same `LayTile` for B&M reaches the arm and the arm
       charges B&M and moves the step, exactly as it did for every message before this note. If the arm ever
       learns the rule itself, this case will start refusing and the control should be retired. */
    const before = { ...board("Routes"), current_round_type: undefined } as unknown as GameStateResponse;
    const after = applySandboxAction(before, run(BM), { actor: PRESIDENT_OF_BOTH });
    expect(after).not.toBe(before);
    // The arm credited the corporation the message named -- B&M, which the cursor says is not operating.
    expect(Number(company(after, BM).last_route_revenue)).toBeGreaterThan(0);
    expect(company(after, PRR).last_route_revenue).toBe(company(before, PRR).last_route_revenue);
  });
});
