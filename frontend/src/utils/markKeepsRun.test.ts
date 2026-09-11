/** @jest-environment node */
//
// Design note #1375 (harness): the Mark takes one train's route, not the whole run.

import { applySandboxAction } from "./sandboxSession";
import { runWithoutTrain, lowestValueTrain, markPayout } from "./yellowSign";
import { rollTurnRevenue, STANDARD_VARIANTS, legacyTurnSeed } from "./gameVariants";
import type { GameStateResponse } from "./gameState";

const BO = 6;
const SEED = legacyTurnSeed(3, 1, BO);
const PARTS = { macroRound: 3, subRound: 1, companyId: BO, turnSeed: SEED };
const SHORT = [{ hex: "F2" }, { hex: "A9" }];

const board = (): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_sub_phase: "Routes",
    active_operating_order: [BO],
    active_corporation_index: 0,
    player_addresses: ["p1"],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    private_companies: [],
    variants: { ...STANDARD_VARIANTS, unpredictableRevenue: true },
    public_companies: [
      { company_id: BO, ticker: "B&O", president: "p1", treasury: "340", last_route_revenue: "0", owned_trains: ["3", "4"] },
    ],
  }) as unknown as GameStateResponse;

const ran = (state: GameStateResponse) =>
  applySandboxAction(state, {
    RunMultipleRoutes: { protocol_id: BO, routes: [SHORT, SHORT], trains: ["3", "4"], train_indices: [0, 1], revenue_seed: SEED },
  } as never);

const corp = (state: GameStateResponse) => state.public_companies.find((entry) => entry.company_id === BO)!;

describe("the Mark keeps the other trains' routes (design note #1375)", () => {
  it("removes exactly the taken train's printed route and re-rolls the remainder under the same seed", () => {
    const after = ran(board());
    const before = corp(after);
    const breakdown = before.last_run_breakdown!;
    expect(breakdown.length).toBe(2);
    const taken = lowestValueTrain(before.owned_trains)!;
    expect(taken).toBe("3");
    const takenPrinted = Number(breakdown.find((entry) => entry.model === "3")!.printed_revenue);
    const printedBefore = Number(before.printed_route_revenue);

    const marked = applySandboxAction(after, {
      YellowSignEvent: { game_id: 0, protocol_id: BO, stage: "mark", model: taken, cash: String(markPayout(taken)), revenue_seed: SEED },
    } as never);
    const c = corp(marked);
    expect(c.owned_trains).toEqual(["4"]);
    expect(Number(c.printed_route_revenue)).toBe(printedBefore - takenPrinted);
    expect(Number(c.last_route_revenue)).toBe(rollTurnRevenue(printedBefore - takenPrinted, PARTS).adjusted);
    expect(Number(c.last_route_revenue)).toBeGreaterThan(0);
    expect(c.last_run_breakdown!.map((entry) => entry.model)).toEqual(["4"]);
    expect(c.routes_run_this_turn).toBe(1);
    expect(Number(c.treasury)).toBe(340 + markPayout(taken));
    // The shell narrates from the same function, so the sentence and the board cannot disagree.
    const narrated = runWithoutTrain(before, taken, PARTS);
    expect(narrated.adjusted).toBe(Number(c.last_route_revenue));
    expect(narrated.routes).toBe(1);
  });

  it("a message without the seed keeps #1046's zeroing, so old logs replay unchanged", () => {
    const after = ran(board());
    const marked = applySandboxAction(after, {
      YellowSignEvent: { game_id: 0, protocol_id: BO, stage: "mark", model: "3", cash: "90" },
    } as never);
    expect(corp(marked).last_route_revenue).toBe("0");
    expect(corp(marked).printed_route_revenue).toBe("0");
  });
});
