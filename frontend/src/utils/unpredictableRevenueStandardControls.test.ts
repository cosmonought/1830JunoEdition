/** @jest-environment node */
//
// ==================================================================
//  UR-3 (harness): STANDARD-MODE NEGATIVE CONTROLS -- UNPREDICTABLE REVENUE OFF
// ==================================================================
//
// #902: "DEFAULTS ARE THE STANDARD GAME, ALWAYS" -- UR-N3: with the variant off, no Unpredictable Revenue mechanism
// (the die, a Yellow Sign stage, Carcosa, the fog, a gift's phase effect) can change the game. UR-3 moves the Sign into
// the run and the fog onto the OR-set boundary, so each of those new seams is pinned here as INERT on a pinned table
// without the variant, next to the same message on the same board with the variant on (the positive control).

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { derivePhase } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const DX = require("../gameEngine/dieselExchange") as typeof import("../gameEngine/dieselExchange");

const { CO, BO, NYC, P1, P2, P3, GULF, TWO_ROUTE, THREE_ROUTE, urBoard, runMsg, signRequest, companyOf, partsFor } = S;

const CTX = { mapGrid: GULF, era: "Yellow" } as const;
const apply = (state: GameStateResponse, msg: unknown) => applySandboxAction(state, msg as never, CTX);
const board = (ur: boolean, over: Partial<Parameters<typeof urBoard>[0]> = {}) =>
  urBoard({
    ur,
    corps: [
      { id: CO, president: P1, trains: ["2", "3"], treasury: 300 },
      { id: BO, president: P2, trains: ["3"] },
    ],
    ...over,
  });
const RUN = (seed?: number) => runMsg(CO, [TWO_ROUTE, THREE_ROUTE], [0, 1], ["2", "3"], seed);
const MARK_110 = S.seedWhere((seed) => S.isMarkDraw(110, partsFor(seed)));
const SIGN_FIELDS = ["has_yellow_sign", "is_carcosan", "carcosan_trains", "ghost_trains", "carcosan_doom_after_macro_round", "last_run_yellow_sign"] as const;

describe("Unpredictable Revenue off: the run is the standard game's", () => {
  it("pays the printed total whatever the committed seed would have rolled, and draws no stage", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const after = apply(board(false), RUN(seed));
      const c = companyOf(after, CO);
      expect(c.last_route_revenue).toBe("110");
      expect(c.owned_trains).toEqual(["2", "3"]);
      for (const field of SIGN_FIELDS) expect(c[field]).toBeUndefined();
    }
    // The positive control: the same run and seed on a Unpredictable Revenue table IS a Mark.
    expect(companyOf(apply(board(true), RUN(MARK_110)), CO).has_yellow_sign).toBe(true);
  });

  it("hosted: the same, through the room's own draw", () => {
    const room = S.hostedRoom(board(false), GULF, [MARK_110]);
    expect(S.submitTo(room, P1, RUN()).kind).toBe("applied");
    expect(companyOf(room.state, CO).last_route_revenue).toBe("110");
    expect(companyOf(room.state, CO).owned_trains).toEqual(["2", "3"]);
  });
});

describe("Unpredictable Revenue off: a client YellowSignEvent cannot alter the board", () => {
  it("reducer and hosted room both refuse it, before and after a run, with and without stored-outcome fields", () => {
    const fresh = board(false);
    const ran = apply(fresh, RUN(MARK_110));
    for (const state of [fresh, ran]) {
      for (const extra of [{}, { stage: "mark", model: "2", cash: "40" }, { stage: "carcosa", model: "D" }, { debug_force: true }]) {
        expect(stateDigest(apply(state, signRequest(CO, extra)))).toBe(stateDigest(state));
      }
    }
    const room = S.hostedRoom(fresh, GULF, [MARK_110]);
    S.submitTo(room, P1, RUN());
    const answer = S.submitTo(room, P1, signRequest(CO));
    expect(answer.kind).toBe("refused");
    expect(room.entries).toHaveLength(1);
  });
});

describe("Unpredictable Revenue off: phase, rust and the Diesel exchange are the standard game's", () => {
  it("the first 4 rusts the 2s at the purchase", () => {
    const phase3 = urBoard({
      ur: false,
      corps: [
        { id: CO, president: P1, trains: ["2", "3"], treasury: 1000 },
        { id: BO, president: P2, trains: ["3", "3", "3", "3"] },
        { id: NYC, president: P3, trains: ["2", "2", "2", "2"] },
      ],
      step: "Hardware",
    });
    const after = apply(phase3, S.buy(CO));
    expect(companyOf(after, CO).owned_trains).toEqual(["3", "4"]);
    expect(companyOf(after, NYC).owned_trains).toEqual([]);
    expect(derivePhase(after)!.tier).toBe("4");
  });

  it("a 5 trades in for a Diesel at $800 and goes to the Bank Pool", () => {
    const phaseD = urBoard({
      ur: false,
      corps: [
        { id: CO, president: P1, trains: ["5"], treasury: 1000 },
        { id: NYC, president: P2, trains: ["D"] },
      ],
      step: "Hardware",
    });
    expect(DX.exchangeableTrains(companyOf(phaseD, CO))).toEqual(["5"]);
    const after = apply(phaseD, S.exchange(CO, "5"));
    expect(companyOf(after, CO).owned_trains).toEqual(["D"]);
    expect(after.returned_trains).toEqual(["5"]);
    expect(companyOf(after, CO).treasury).toBe("200");
  });

  it("an Operating-Round set boundary creates and removes no Carcosa state", () => {
    const lastTurn = urBoard({
      ur: false,
      corps: [
        { id: NYC, president: P2, trains: ["D"] },
        { id: BO, president: P1, trains: ["5"] },
      ],
      operating: BO,
      step: "Hardware",
      macro: 6,
      sub: 3,
      sequence: 3,
    });
    const after = apply(lastTurn, S.PASS);
    expect(after.current_round_type).toBe("StockRound");
    for (const company of after.public_companies) {
      for (const field of SIGN_FIELDS) expect(company[field]).toBeUndefined();
    }
    expect(companyOf(after, NYC).owned_trains).toEqual(["D"]);
    expect(companyOf(after, BO).owned_trains).toEqual(["5"]);
  });
});
