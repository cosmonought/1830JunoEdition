/** @jest-environment node */
//
// ==================================================================
//  UR-3 (harness): A SYNTHETIC CARCOSA TRAIN NEVER ADVANCES THE PHASE (OD-UR-3 = 3-A, UR-F4)
// ==================================================================
//
// OWNER RULING OD-UR-3 (backlog D-39): synthetic (gifted) Carcosa trains do not advance the game phase; the phase
// follows REAL train purchases. A gift above the current phase may exist and operate early, but by itself it does not
// change the phase, rust trains, mark trains for Gentle Rust, open the next depot shelf, advance the 18XX+ era, receive
// Phase Rusher treatment or cause any ordinary phase-change consequence. When the first REAL train of that tier is
// bought, the normal phase change happens then. A synthetic D is not a real D purchase. The gift rule itself (#1672:
// the depot's lowest-value train) is unchanged.
//
// WHY IT IS NEWLY URGENT: UR-3 makes Carcosa reach hosted boards for the first time (UR-F1), so a gift above the phase
// (the reachable windows are "5s sold out" -> a 6 and "6s sold out" -> a D; under the Level Playing Field also a 7)
// would have corrupted live phase, rust and era progression (the audit's probes P-B and P-F).
//
// The boards hold the gift exactly as the reducer writes it (`owned_trains` + `ghost_trains` + `carcosan_trains`, the
// corporation Carcosan); the purchases that follow are real `BuyHardwareFromPool` messages through the reducer.

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { derivePhase, openDepotTiers, realDieselPurchased } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { carcosaGiftModel } = require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const { tileEraFor } = require("../gameEngine/gameConstants") as typeof import("../gameEngine/gameConstants");

const { CO, BO, NYC, P1, P2, P3, urBoard, companyOf } = S;

const gift = (model: string, doom?: number) => ({
  is_carcosan: true,
  has_yellow_sign: false,
  carcosan_trains: [model],
  ghost_trains: [model],
  ...(doom === undefined ? {} : { carcosan_doom_after_macro_round: doom }),
});
const tiers = (state: GameStateResponse) => openDepotTiers(state).map((row) => row.tier);
const buyAt = (state: GameStateResponse, companyId: number, tier?: string) =>
  applySandboxAction({ ...state, operating_sub_phase: "Hardware", active_corporation_index: state.active_operating_order.indexOf(companyId) }, S.buy(companyId, tier) as never);

describe("a gifted 6 while the real phase is 5 (the 5s are sold out)", () => {
  const base = (gentle = false) =>
    urBoard({
      gentle,
      corps: [
        { id: CO, president: P1, trains: ["5", "6"], extra: gift("6") },
        { id: BO, president: P2, trains: ["5", "5"] },
        { id: NYC, president: P3, trains: ["3"], treasury: 1500 },
      ],
      operating: NYC,
    });

  it("the gift is the depot's lowest tier -- a 6 -- and the corporation may own and run it", () => {
    const beforeGift = urBoard({ corps: [{ id: CO, president: P1, trains: ["5"] }, { id: BO, president: P2, trains: ["5", "5"] }] });
    expect(carcosaGiftModel(beforeGift, derivePhase(beforeGift)!.tier)).toBe("6");
    expect(companyOf(base(), CO).owned_trains).toEqual(["5", "6"]);
  });

  it("the phase stays 5: no 3 rusts, the Diesel shelf does not open, the limit and the set length stay phase 5's", () => {
    const board = base();
    const phase = derivePhase(board)!;
    expect(phase.tier).toBe("5");
    expect(phase.trainLimit).toBe(2);
    expect(tiers(board)).toEqual(["6"]); // the queue's head, not the 6 / D shelf
    expect(companyOf(board, NYC).owned_trains).toEqual(["3"]);
  });

  it("under Gentle Rust the gift marks nothing either", () => {
    const board = base(true);
    expect(derivePhase(board)!.tier).toBe("5");
    expect(companyOf(board, NYC).pending_rust_trains ?? []).toEqual([]);
  });

  it("the first REAL 6 is the phase change: the 3s rust then, and the shelf opens", () => {
    const after = buyAt(base(), NYC);
    expect(companyOf(after, NYC).owned_trains).toEqual(["6"]); // the 3 rusted on the real 6's arrival
    expect(derivePhase(after)!.tier).toBe("6");
    expect(tiers(after)).toEqual(["6", "D"]);
    // The gift still took nothing off the shelf: one REAL 6 owned, one of two left.
    expect(openDepotTiers(after).find((row) => row.tier === "6")!.remaining).toBe(1);
  });

  it("and under Gentle Rust the first real 6 marks the 3 for its Final Run", () => {
    const after = buyAt(base(true), NYC);
    expect(companyOf(after, NYC).owned_trains).toEqual(["3", "6"]);
    expect(companyOf(after, NYC).pending_rust_trains).toEqual(["3"]);
  });
});

describe("a gifted D while the real phase is 6 (the 6s are sold out)", () => {
  const base = (over: Partial<Parameters<typeof urBoard>[0]> = {}) =>
    urBoard({
      corps: [
        { id: CO, president: P1, trains: ["6", "D"], extra: gift("D") },
        { id: BO, president: P2, trains: ["6"] },
        { id: NYC, president: P3, trains: ["4"], treasury: 1500 },
      ],
      operating: NYC,
      macro: 5,
      ...over,
    });

  it("the phase stays 6, the 4s do not rust, and the synthetic D starts no doom clock", () => {
    const board = base();
    expect(derivePhase(board)!.tier).toBe("6");
    expect(companyOf(board, NYC).owned_trains).toEqual(["4"]);
    expect(realDieselPurchased(board)).toBe(false);
    expect(companyOf(board, CO).carcosan_doom_after_macro_round).toBeUndefined();
  });

  it("the first REAL D rusts the 4s and starts the gilded D's clock: set N, deadline N + 1", () => {
    const after = buyAt(base(), NYC, "D");
    expect(companyOf(after, NYC).owned_trains).toEqual(["D"]);
    expect(derivePhase(after)!.tier).toBe("D");
    expect(realDieselPurchased(after)).toBe(true);
    expect(companyOf(after, CO).carcosan_doom_after_macro_round).toBe(6);
    // The gilded D itself is untouched by the phase change.
    expect(companyOf(after, CO).owned_trains).toEqual(["6", "D"]);
  });

  it("under the 18XX+ tiles the Gray era opens with the real D, not with the gift", () => {
    const plus = base({ plusTiles: true });
    // The era the board settles to (#657, `settleEra` writes exactly this): the gift has not opened Gray.
    expect(tileEraFor(plus)).toBe("Brown");
    const after = buyAt(plus, NYC, "D");
    expect(after.current_global_era).toBe("Gray");
    expect(tileEraFor(after)).toBe("Gray");
  });
});

describe("the Level Playing Field: gifts from the 6 / 7 / D shelf", () => {
  it("a gifted 7 does not turn the phase (the 7 would have no effect, and still is not the phase)", () => {
    const board = urBoard({
      lpf: true,
      corps: [
        { id: CO, president: P1, trains: ["6", "7"], extra: gift("7") },
        { id: BO, president: P2, trains: ["6"] },
        { id: NYC, president: P3, trains: ["4"], treasury: 1500 },
      ],
      operating: NYC,
    });
    expect(derivePhase(board)!.tier).toBe("6");
    expect(companyOf(board, NYC).owned_trains).toEqual(["4"]);
  });

  it("a gifted D does not either; the first real D -- $900 on this board -- rusts the 4s", () => {
    const board = urBoard({
      lpf: true,
      corps: [
        { id: CO, president: P1, trains: ["6", "D"], extra: gift("D") },
        { id: BO, president: P2, trains: ["6", "7"] },
        { id: S.CPR, president: P1, trains: ["7"] },
        { id: NYC, president: P3, trains: ["4"], treasury: 1500 },
      ],
      operating: NYC,
      macro: 5,
    });
    expect(tiers(board)).toEqual(["D"]); // 6s and 7s sold out: the gift was the shelf's D
    expect(derivePhase(board)!.tier).toBe("7"); // two real 7s bought: the LPF's "phase 6" presentation of the 7
    expect(derivePhase(board)!.label).toContain("Phase: 6");
    expect(companyOf(board, NYC).owned_trains).toEqual(["4"]);
    const after = buyAt(board, NYC, "D");
    expect(Number(companyOf(board, NYC).treasury) - Number(companyOf(after, NYC).treasury)).toBe(900);
    expect(derivePhase(after)!.tier).toBe("D");
    expect(companyOf(after, NYC).owned_trains).toEqual(["D"]);
    expect(companyOf(after, CO).carcosan_doom_after_macro_round).toBe(6);
  });
});

describe("delivered by the run itself (OD-UR-1): the gift above the phase leaves the phase where it was", () => {
  it("phase 5, 5s sold out: the Marked corporation's Carcosa gifts a 6 at its run and the phase stays 5", () => {
    const marked = urBoard({
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 300, extra: { has_yellow_sign: true } },
        { id: BO, president: P2, trains: ["5", "5"] },
        { id: NYC, president: P3, trains: ["3"] },
      ],
    });
    const seed = S.seedWhere((s) => S.isCarcosaDraw(90, S.partsFor(s)));
    const after = applySandboxAction(marked, S.runMsg(CO, [S.LONG_ROUTE], [0], ["5"], seed) as never, { mapGrid: S.GULF, era: "Yellow" });
    expect(companyOf(after, CO).owned_trains).toEqual(["5", "6"]);
    expect(companyOf(after, CO).ghost_trains).toEqual(["6"]);
    expect(derivePhase(after)!.tier).toBe("5");
    expect(companyOf(after, NYC).owned_trains).toEqual(["3"]);
    expect(tiers(after)).toEqual(["6"]);
  });
});
