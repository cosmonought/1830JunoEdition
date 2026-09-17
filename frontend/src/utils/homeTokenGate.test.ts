/** @jest-environment node */
//
// Nothing happens while a home token is owed. Through the reducer. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 763 (harness): THE WINDOW #416 OPENED
// ==================================================================
//
// REPORTED: "While the modal telling P1 to place their corp home station was open, P2 was able to buy a share
// and the game kept going." And on how to resolve it: "I suppose the safest thing is to refuse every action
// until the home station is placed."
//
// IN 1830 THERE IS NO GAP TO ACT IN -- floating and placing the token are one event. #416 split them into a
// prompt so the player would witness the placement, which is right for a screen and opened a window the
// physical game does not have.
//
// THE ASSERTIONS ARE ABOUT THE REDUCER, not the buttons, for the reason #712, #736, #748 and #757 each found
// independently: a rule enforced where the controls are drawn is a rule with a door beside it. Every test
// below goes through `applySandboxAction`, which is what a remote client replays.
//
// AND TWO OF THEM ARE ABOUT THE EXITS. A gate is easy; a gate somebody can get stuck behind is a worse bug
// than the one it fixes, so the placement and Undo have their own cases.
//
// ==================================================================
//  RE-PINNED BY DESIGN NOTES 1610 / 1612 (Stage 8, Slice 8.2, S8-5 / S8-12)
// ==================================================================
//
// "IN 1830 THERE IS NO GAP TO ACT IN" was not the rule. 6.3.1 places the home station "at the beginning of a
// railroad's first turn of operation", so the reported position -- PRR floated in a Stock Round, token not down --
// owes NOTHING and holds NOTHING: P2's purchase is simply P2's purchase. The gate survives where the rule puts it:
// PRR under the Operating Round cursor at the start of its first turn, with no token. Every case below keeps its
// assertion and moves to that board; the Stock Round board now pins the absence of a freeze. The exits are the
// placement, #763's Undo and the room's own messages (#1612).

import { applySandboxAction, pendingHomeTokens } from "../gameEngine/sandboxSession";
import { homeTokenBlock, homeTokenOwed } from "../gameEngine/homeTokenGate";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { GameStateResponse } from "../gameEngine/gameState";

const PRR = 1;
const BO = 2;

const homeHexToAxial = (label: string): readonly [number, number] | null => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  return hex ? ([hex.q, hex.r] as const) : null;
};

/** PRR floated, its home token NOT yet on the board -- the reported position, in the Stock Round. */
function board(over: Record<string, unknown> = {}): GameStateResponse {
  return {
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "600" },
      { player: "p2", cash_vgp: "600" },
    ],
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 1,
    active_player_index: 1,
    active_operating_order: [],
    active_corporation_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: true,
        president: "p1",
        par_value: "100",
        home_hex_label: "H12",
        ipo_pool_percentage: 40,
        bank_pool_percentage: 0,
        treasury: "1000",
        player_holdings: [{ player: "p1", percentage: 60 }],
        station_token_hexes: [],
      },
      {
        company_id: BO,
        ticker: "B&O",
        is_floated: false,
        president: null,
        par_value: "100",
        home_hex_label: "I15",
        ipo_pool_percentage: 100,
        bank_pool_percentage: 0,
        treasury: "0",
        player_holdings: [],
        station_token_hexes: [],
      },
    ],
    ...over,
  } as unknown as GameStateResponse;
}

/** The same PRR at the start of its first operating turn -- where the home station IS owed (#1610). */
function firstTurn(over: Record<string, unknown> = {}): GameStateResponse {
  return board({
    current_round_type: "OperatingRound",
    macro_round_number: 1,
    active_player_index: 0,
    active_operating_order: [PRR],
    active_corporation_index: 0,
    operating_sub_phase: "Track",
    ...over,
  });
}

const apply = (state: GameStateResponse, msg: unknown, actor = "p2") =>
  applySandboxAction(state, msg as never, { actor, homeHexToAxial });

describe("the reported position", () => {
  it("owes nothing in the Stock Round: the float is not the moment (#1610)", () => {
    expect(pendingHomeTokens(board(), homeHexToAxial)).toEqual([]);
    expect(homeTokenOwed(board(), homeHexToAxial)).toBe(false);
    expect(homeTokenBlock({ state: board(), homeHexToAxial })).toBeNull();
  });

  it("lets P2's purchase through -- the report's action is an ordinary purchase", () => {
    const before = board();
    const after = apply(before, { BuyStock: { game_id: 1, protocol_id: BO, source: "Ipo", par_value: "100" } });
    expect(after).not.toBe(before);
  });

  it("owes the token at PRR's first operating turn", () => {
    /* The premise of every case below, read back. If PRR were not actually pending, every refusal would be about
       nothing. */
    const owed = pendingHomeTokens(firstTurn(), homeHexToAxial);
    expect(owed).toHaveLength(1);
    expect(owed[0].ticker).toBe("PRR");
    expect(homeTokenOwed(firstTurn(), homeHexToAxial)).toBe(true);
  });

  it("names the corporation, the hex and the player holding things up", () => {
    /* The reader is usually NOT the one holding things up. "Wait" without "for whom" is the most annoying message a
       game can show. */
    const reason = homeTokenBlock({ state: firstTurn(), homeHexToAxial });
    expect(reason).toMatch(/PRR is starting its first operating turn/);
    expect(reason).toMatch(/H12/);
    expect(reason).toMatch(/p1 must place it/);
  });
});

describe("no message lands while a token is owed", () => {
  it("refuses a share purchase", () => {
    const before = firstTurn();
    expect(
      apply(before, {
        BuyStock: { game_id: 1, protocol_id: BO, source: "Ipo", par_value: "100" },
      }),
    ).toBe(before);
  });

  it("refuses a pass", () => {
    const before = firstTurn();
    expect(apply(before, { PassTurn: { game_id: 1 } }, "p1")).toBe(before);
  });

  it("refuses a sale", () => {
    const before = firstTurn();
    expect(apply(before, { SellStock: { game_id: 1, protocol_id: PRR, percentage: 10 } })).toBe(before);
  });

  it("refuses even a message that looks harmless", () => {
    /* The point of gating before every arm rather than on the three obvious ones: "harmless" is a judgement about
       today's arms, and the next arm will be written by somebody who has not read this note. */
    const before = firstTurn();
    expect(apply(before, { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: PRR } }, "p1")).toBe(before);
  });
});

describe("the exits stay open", () => {
  it("lets the placement itself through", () => {
    /* Otherwise the gate locks the board for ever -- the one failure mode that would be worse than the bug it fixes.
       Asserted on the token, not on `not.toBe(board())`, which a fresh fixture passes whatever happens. */
    const home = homeHexToAxial("H12")!;
    const before = firstTurn();
    const placed = applySandboxAction(
      before,
      { PlaceHomeStation: { game_id: 1, company_id: PRR, q: home[0], r: home[1], kind: "home", city_index: null } } as never,
      { actor: "p1", homeHexToAxial },
    );
    expect(placed.public_companies[0].station_token_hexes).toEqual([home]);
  });

  it("lets Undo through", () => {
    /* A gate with no exit turns any bad state into an unrecoverable one, and Undo is the only thing that can rewind
       past whatever produced it. ASSERTED ON THE PREDICATE, NOT ON THE STATE: the reducer's `UndoLastAction` arm is a
       deliberate no-op, so an identity check could never tell a pass from a refusal. */
    expect(
      homeTokenBlock({ state: firstTurn(), homeHexToAxial, msg: { UndoLastAction: { game_id: 1 } } }),
    ).toBeNull();
  });

  it("still refuses an ordinary message on the same board", () => {
    // The control for the assertion above: the gate is live, it simply exempts Undo.
    expect(
      homeTokenBlock({ state: firstTurn(), homeHexToAxial, msg: { PassTurn: { game_id: 1 } } }),
    ).not.toBeNull();
  });
});

describe("the gate opens once the token is down", () => {
  it("lets the turn go on", () => {
    /* THE CONTROL, and the one that would catch a gate that never lifts. Same board, same message, token placed. */
    const settled = firstTurn({
      public_companies: [
        {
          ...(board().public_companies[0] as object),
          station_token_hexes: [homeHexToAxial("H12")],
        },
        board().public_companies[1],
      ],
    });
    expect(homeTokenOwed(settled, homeHexToAxial)).toBe(false);
    expect(apply(settled, { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: PRR } }, "p1")).not.toBe(settled);
  });

  it("says nothing when the operating corporation has not floated", () => {
    const nothingFloated = firstTurn({
      public_companies: [
        { ...(board().public_companies[0] as object), is_floated: false },
        board().public_companies[1],
      ],
    });
    expect(homeTokenBlock({ state: nothingFloated, homeHexToAxial })).toBeNull();
  });

  it("says nothing for a corporation with no home hex on this board", () => {
    // #416: `homeHexToAxial` returning null means the float still happens and simply owes no token.
    const noHome = firstTurn({
      public_companies: [
        { ...(board().public_companies[0] as object), home_hex_label: "ZZ99" },
        board().public_companies[1],
      ],
    });
    expect(homeTokenBlock({ state: noHome, homeHexToAxial })).toBeNull();
  });
});

describe("both surfaces ask one function", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // #490a: the notes quote #416's prompt reasoning and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("is enforced by the reducer, before anything moves (#1613)", () => {
    expect(read("gameEngine/sandboxSession.ts")).toContain("homeStationHold(state, msg, ctx.homeHexToAxial)");
    expect(read("gameEngine/homeTokenGate.ts")).toContain("return homeStationHold(state, msg as GameplayExecuteMsg | undefined, homeHexToAxial, labelForAddress);");
  });

  it("is what the Pass button says", () => {
    /* The button explains itself rather than silently doing nothing -- and it reads FIRST among the pass reasons. */
    expect(read("App.tsx")).toContain("homeTokenBlock({");
  });
});
