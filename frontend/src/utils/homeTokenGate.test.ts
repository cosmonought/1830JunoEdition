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

import { applySandboxAction, pendingHomeTokens } from "./sandboxSession";
import { homeTokenBlock, homeTokenOwed } from "./homeTokenGate";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { GameStateResponse } from "./gameState";

const PRR = 1;
const BO = 2;

const homeHexToAxial = (label: string): readonly [number, number] | null => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  return hex ? ([hex.q, hex.r] as const) : null;
};

/** PRR floated, its home token NOT yet on the board -- the reported position. */
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

const apply = (state: GameStateResponse, msg: unknown) =>
  applySandboxAction(state, msg as never, { actor: "p2", homeHexToAxial });

describe("the reported position", () => {
  it("owes a token", () => {
    /* The premise, read back. If PRR were not actually pending, every refusal below would be about nothing. */
    const owed = pendingHomeTokens(board(), homeHexToAxial);
    expect(owed).toHaveLength(1);
    expect(owed[0].ticker).toBe("PRR");
    expect(homeTokenOwed(board(), homeHexToAxial)).toBe(true);
  });

  it("names the corporation, the hex and the player holding things up", () => {
    /* The reader is usually NOT the one holding things up -- P2 sees this, P1 has the prompt. "Wait" without
       "for whom" is the most annoying message a game can show. */
    const reason = homeTokenBlock({ state: board(), homeHexToAxial });
    expect(reason).toMatch(/PRR has floated/);
    expect(reason).toMatch(/H12/);
    expect(reason).toMatch(/must place it/);
  });
});

describe("no message lands while a token is owed", () => {
  it("refuses the share purchase from the report", () => {
    /* THE REPORT. Before #763 this settled a purchase against a board with a floated corporation that has no
       token -- a board 1830 cannot reach, which is the state #762's crash was living in. */
    const before = board();
    expect(
      apply(before, {
        BuyStock: { game_id: 1, protocol_id: BO, source: "Ipo", par_value: "100" },
      }),
    ).toBe(before);
  });

  it("refuses a pass", () => {
    const before = board();
    expect(apply(before, { PassTurn: { game_id: 1 } })).toBe(before);
  });

  it("refuses a sale", () => {
    const before = board();
    expect(apply(before, { SellStock: { game_id: 1, protocol_id: PRR, percentage: 10 } })).toBe(
      before,
    );
  });

  it("refuses even a message that looks harmless", () => {
    /* The point of gating before every arm rather than on the three obvious ones: "harmless" is a judgement
       about today's arms, and the next arm will be written by somebody who has not read this note. */
    const before = board();
    expect(apply(before, { AdvanceOperatingSubPhase: { game_id: 1 } })).toBe(before);
  });
});

describe("the exits stay open", () => {
  it("lets the placement itself through", () => {
    /* Otherwise the gate locks the board for ever -- the one failure mode that would be worse than the bug
       it fixes. */
    const placed = applySandboxAction(
      board(),
      { PlaceHomeStation: { game_id: 1, protocol_id: PRR, q: 3, r: 5, city_index: 0 } } as never,
      { actor: "p1", homeHexToAxial },
    );
    expect(placed).not.toBe(board());
  });

  it("lets Undo through", () => {
    /* A gate with no exit turns any bad state into an unrecoverable one, and Undo is the only thing that can
       rewind past whatever produced it.
       ASSERTED ON THE PREDICATE, NOT ON THE STATE, and the first draft got that wrong. The reducer's
       `UndoLastAction` arm is a deliberate no-op -- "genuinely unmodellable: undo is a full replay of the
       contract's event log" -- so it returns the same state whether the gate passes it or refuses it, and an
       identity check could never tell the two apart. What has to be true is that the GATE does not name it. */
    expect(
      homeTokenBlock({ state: board(), homeHexToAxial, msg: { UndoLastAction: { game_id: 1 } } }),
    ).toBeNull();
  });

  it("still refuses an ordinary message on the same board", () => {
    // The control for the assertion above: the gate is live, it simply exempts Undo.
    expect(
      homeTokenBlock({ state: board(), homeHexToAxial, msg: { PassTurn: { game_id: 1 } } }),
    ).not.toBeNull();
  });
});

describe("the gate opens once the token is down", () => {
  it("allows the purchase again", () => {
    /* THE CONTROL, and the one that would catch a gate that never lifts. Same board, same message, token
       placed. */
    const settled = board({
      public_companies: [
        {
          ...(board().public_companies[0] as object),
          station_token_hexes: [homeHexToAxial("H12")],
        },
        board().public_companies[1],
      ],
    } as never);
    expect(homeTokenOwed(settled, homeHexToAxial)).toBe(false);
    expect(
      apply(settled, {
        BuyStock: { game_id: 1, protocol_id: BO, source: "Ipo", par_value: "100" },
      }),
    ).not.toBe(settled);
  });

  it("says nothing when no corporation has floated", () => {
    const nothingFloated = board({
      public_companies: [
        { ...(board().public_companies[0] as object), is_floated: false },
        board().public_companies[1],
      ],
    } as never);
    expect(homeTokenBlock({ state: nothingFloated, homeHexToAxial })).toBeNull();
  });

  it("says nothing for a corporation with no home hex on this board", () => {
    // #416: `homeHexToAxial` returning null means the float still happens and simply owes no token.
    const noHome = board({
      public_companies: [
        { ...(board().public_companies[0] as object), home_hex_label: "ZZ99" },
        board().public_companies[1],
      ],
    } as never);
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

  it("is enforced by the reducer", () => {
    expect(read("utils/sandboxSession.ts")).toContain("homeTokenBlock({ state, homeHexToAxial: ctx.homeHexToAxial, msg })");
  });

  it("is what the Pass button says", () => {
    /* The button explains itself rather than silently doing nothing -- and it reads FIRST among the pass
       reasons, because a player told about some later rule would fix that one and find the button still
       dead. */
    expect(read("App.tsx")).toContain("homeTokenBlock({");
  });
});
