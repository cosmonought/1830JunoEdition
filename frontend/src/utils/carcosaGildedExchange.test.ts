/** @jest-environment node */
//
// ==================================================================
//  UR-3 (harness): A GILDED TRAIN IS NEVER A DIESEL TRADE-IN (OD-UR-7 = 7-A, UR-F17)
// ==================================================================
//
// OWNER RULING OD-UR-7 (backlog D-41): a gilded / Carcosan train may not be used as a Diesel trade-in. Buying a
// Diesel normally stays legal, and so does trading in an ordinary, non-gilded eligible train -- the analogue of Gentle
// Rust's D-35. If the corporation also owns an ordinary copy of the gilded train's model, that copy stays tradable: the
// question is a MULTISET one (copies owned minus copies gilded), never a ban on the model -- GR-2's `exchangeableTrains`
// / `unreprievedTrains` shape, applied to a different mark.
//
// WHAT IT CLOSES (probe P-I): the exchange arm accepted the gilded 6, moved it into the Bank Pool as ordinary physical
// stock and left the gilding, the provenance marker, the curse and the doom clock behind at the seller -- the fog
// escaped without a Blood Price, and a synthetic train became a train the Bank could sell.
//
// A REFUSAL IS ATOMIC: the reducer's gate returns the board it was handed (the digest does not move -- no treasury,
// no Bank Pool, no gilding, no clock), the hosted room refuses with the gate's sentence and appends nothing.

import type { GameStateResponse } from "../gameEngine/gameState";

export {};

const S = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const { applySandboxAction, describeFleetLosses } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const DX = require("../gameEngine/dieselExchange") as typeof import("../gameEngine/dieselExchange");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");

const { CO, NYC, P1, P2, urBoard, companyOf } = S;

const GILDED_6 = { is_carcosan: true, carcosan_trains: ["6"], ghost_trains: ["6"], carcosan_doom_after_macro_round: 7 };

/** Phase D (NYC bought a real D); C&O in Buy Trains holding `trains`, of which the gilded 6 is marked. */
const buyTrains = (trains: string[], lpf = false, gilding: Record<string, unknown> = GILDED_6) =>
  urBoard({
    lpf,
    corps: [
      { id: CO, president: P1, trains, treasury: 1200, extra: gilding },
      { id: NYC, president: P2, trains: ["D"] },
    ],
    step: "Hardware",
    macro: 6,
  });

const c = (state: GameStateResponse) => companyOf(state, CO);
const exchange = (state: GameStateResponse, model: string) => applySandboxAction(state, S.exchange(CO, model) as never);

describe("the gilded copy is refused, atomically, at $800 and at the Level Playing Field's $750", () => {
  for (const lpf of [false, true]) {
    it(`${lpf ? "LPF $750" : "standard $800"}: the gate names the gilding and the board does not move`, () => {
      const board = buyTrains(["6"], lpf);
      expect(DX.dieselExchangeRefusal(board, CO, "6")).toMatch(/gold-trimmed|gilded|Carcosa/i);
      const after = exchange(board, "6");
      expect(stateDigest(after)).toBe(stateDigest(board));
      expect(c(after).owned_trains).toEqual(["6"]);
      expect(c(after).carcosan_trains).toEqual(["6"]);
      expect(c(after).ghost_trains).toEqual(["6"]);
      expect(c(after).carcosan_doom_after_macro_round).toBe(7);
      expect(c(after).is_carcosan).toBe(true);
      expect(after.returned_trains).toEqual([]);
      expect(c(after).treasury).toBe("1200");
      // No narration side effect: nothing left a fleet.
      expect(describeFleetLosses(board, after, S.exchange(CO, "6"))).toEqual([]);
    });
  }

  it("hosted: refused with the same sentence, nothing appended", () => {
    const board = buyTrains(["6"]);
    const room = S.hostedRoom(board, S.GULF, [1]);
    const seated = stateDigest(room.state); // the room's own seeded board (its market atom and waterfall normalised)
    const answer = S.submitTo(room, P1, S.exchange(CO, "6"));
    expect(answer.kind).toBe("refused");
    expect(answer.reason).toBe(DX.dieselExchangeRefusal(board, CO, "6"));
    expect(room.entries).toHaveLength(0);
    expect(stateDigest(room.state)).toBe(seated);
  });

  it("the panel offers no gilded copy and says why", () => {
    const offer = DX.dieselExchangeOfferFor(buyTrains(["6"]), CO)!;
    expect(offer.models).toEqual([]);
    expect(offer.problem).toBe(DX.dieselExchangeRefusal(buyTrains(["6"]), CO));
  });
});

describe("an ordinary copy beside the gilded one still trades (multiset, not a model ban)", () => {
  it("owned [6, 6] with one gilded: exactly one 6 may go, and the gilded one stays with all its marks", () => {
    const board = buyTrains(["6", "6"]);
    expect(DX.exchangeableTrains(c(board))).toEqual(["6"]);
    expect(DX.dieselExchangeRefusal(board, CO, "6")).toBeNull();
    const after = exchange(board, "6");
    expect(c(after).owned_trains).toEqual(["6", "D"]);
    expect(after.returned_trains).toEqual(["6"]);
    expect(Number(c(after).treasury)).toBe(1200 - DX.DIESEL_EXCHANGE_COST);
    // The copy that stayed is the gilded one: its gilding, provenance and clock are untouched.
    expect(c(after).carcosan_trains).toEqual(["6"]);
    expect(c(after).ghost_trains).toEqual(["6"]);
    expect(c(after).carcosan_doom_after_macro_round).toBe(7);
    // And now there is no ordinary 6 left to trade.
    expect(DX.exchangeableTrains(c(after))).toEqual([]);
    expect(stateDigest(exchange(after, "6"))).toBe(stateDigest(after));
  });

  it("an ordinary 5 beside the gilded 6 trades at the table's price", () => {
    for (const lpf of [false, true]) {
      const board = buyTrains(["5", "6"], lpf);
      expect(DX.exchangeableTrains(c(board))).toEqual(["5"]);
      const after = exchange(board, "5");
      expect(c(after).owned_trains).toEqual(["6", "D"]);
      expect(Number(c(after).treasury)).toBe(1200 - DX.dieselExchangeCostFor(board));
      expect(c(after).carcosan_trains).toEqual(["6"]);
    }
  });

  it("buying a Diesel outright stays legal for the Carcosan corporation", () => {
    const board = buyTrains(["6"]);
    const after = applySandboxAction(board, S.buy(CO, "D") as never);
    expect(c(after).owned_trains).toEqual(["6", "D"]);
    expect(c(after).carcosan_trains).toEqual(["6"]);
  });

  it("a Gentle Rust mark and a gilding on one corporation are subtracted together, each by its own multiset", () => {
    const both = { ...GILDED_6, pending_rust_trains: ["4"] };
    const board = buyTrains(["4", "4", "6", "6"], false, both);
    expect(DX.exchangeableTrains(c(board))).toEqual(["4", "6"]);
  });
});
