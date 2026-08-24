/** @jest-environment node */
//
// The seat stays with the President until the home token is down, and the log says what was bought.
// No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 769 / 770 (harness)
// ==================================================================
//
// REPORTED (769): "After a corporation floated, the president player did not immediately know they needed to
// place the station ... It immediately moved to the other player's turn, even though the President player
// hadn't placed their home station: the other player's button clicks were logged in the activity log, but
// nothing happened."
//
// #763 STOPPED THE OTHER PLAYER ACTING AND LEFT THE SEAT WHERE IT SHOULD NOT BE. The float happens on the
// president's purchase, and the purchase ends by advancing the seat -- so the round announced somebody else's
// turn and then refused everything they tried. Two players stuck, neither screen saying why.
//
// BEING REFUSED IS NOT THE SAME AS NOT BEING ASKED, which is the whole point of this pass. A gate is correct
// and invisible; the cursor is what tells a table whose move it is. So the fix is about the SEAT, and the
// tests are about `active_player_index` rather than about what is permitted.
//
// REPORTED (770): "the Activity Log reads: 'Player bought a 10% share of C&O from the IPO for $100.' This
// should state that Player bought the 20% President's share from the IPO and set par at $x."
//
// WRONG ON THREE COUNTS -- 20% not 10%, twice par not par, and it omitted the par-setting entirely, which is
// the most consequential decision in a Stock Round and the one figure a reader cannot reconstruct later.

import { applySandboxAction, placeHomeStationToken } from "./sandboxSession";
import { describeGameplayAction } from "./actionLog";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

const PRR = 1;
const BO = 2;

const homeHexToAxial = (label: string): readonly [number, number] | null => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  return hex ? ([hex.q, hex.r] as const) : null;
};

/** p1 on 50% of PRR: one more share floats it. p1 is seated. */
function board(over: Record<string, unknown> = {}): GameStateResponse {
  return {
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "900" },
      { player: "p2", cash_vgp: "900" },
    ],
    virtual_bank_vgp: "12000",
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 1,
    active_player_index: 0,
    active_operating_order: [],
    active_corporation_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: false,
        president: "p1",
        par_value: "100",
        home_hex_label: "H12",
        ipo_pool_percentage: 50,
        bank_pool_percentage: 0,
        treasury: "0",
        player_holdings: [{ player: "p1", percentage: 50 }],
        station_token_hexes: [],
      },
      {
        company_id: BO,
        ticker: "B&O",
        is_floated: false,
        president: null,
        par_value: null,
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

const buy = (state: GameStateResponse, companyId: number, actor = "p1") =>
  applySandboxAction(
    state,
    { BuyStock: { game_id: 1, protocol_id: companyId, source: "Ipo", par_value: "100" } } as never,
    { actor, homeHexToAxial },
  );

describe("the float holds the seat", () => {
  it("leaves the cursor on the President", () => {
    /* THE REPORT. Before #769 this advanced to p2, who then had a turn in which nothing worked. */
    const after = buy(board(), PRR);
    expect(after.public_companies[0].is_floated).toBe(true);
    expect(after.active_player_index).toBe(0);
  });

  it("releases the seat once the token is placed", () => {
    /* THE OTHER HALF, and the one that would matter more if it broke: a hold with no release is a frozen
       game. The placement is the only thing that lifts it.
       CALLED DIRECTLY, and the first draft got that wrong. `PlaceHomeStation` is not an arm of
       `applyOneAction` -- the shell applies it through `placeHomeStationToken`, which is therefore the
       authority for this message and the place the release belongs. Routing the test through
       `applySandboxAction` was testing a path that does not handle it. */
    const floated = buy(board(), PRR);
    const home = homeHexToAxial("H12")!;
    const placed = placeHomeStationToken(floated, PRR, home[0], home[1], 0, homeHexToAxial);
    expect(placed.public_companies[0].station_token_hexes.length).toBe(1);
    expect(placed.active_player_index).toBe(1);
  });

  it("does not release the seat for a corporation that owes nothing", () => {
    /* Identity, and the guard that keeps this from becoming a second way to pass a turn: a placement on a
       board with no outstanding token is not a turn-ender. */
    const settled = board({
      public_companies: [
        {
          ...(board().public_companies[0] as object),
          is_floated: true,
          station_token_hexes: [homeHexToAxial("H12")],
        },
        board().public_companies[1],
      ],
    } as never);
    const home = homeHexToAxial("H12")!;
    expect(placeHomeStationToken(settled, PRR, home[0], home[1], 0, homeHexToAxial)).toBe(settled);
  });

  it("does not release the seat outside a Stock Round", () => {
    // Nothing else advances a seat this way; an Operating Round has its own cursor.
    const inOr = buy(board(), PRR);
    const home = homeHexToAxial("H12")!;
    const placed = placeHomeStationToken(
      { ...inOr, current_round_type: "OperatingRound" } as GameStateResponse,
      PRR,
      home[0],
      home[1],
      0,
      homeHexToAxial,
    );
    expect(placed.active_player_index).toBe(0);
  });

  it("is wired that way in the shell", () => {
    /* The structural half: the release only happens if the caller passes the lookup, so an omission here
       would leave the seat held for ever with every behavioural test still green. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    expect(app).toContain("placeHomeStationToken(base, companyId, q, r, cityIndex, homeHexToAxial)");
  });

  it("advances normally on a purchase that floats nothing", () => {
    /* THE CONTROL. The condition is the DEBT, not the purchase -- a buy that does not float must pass the
       turn exactly as it always did, or every Stock Round stops on its first action. */
    const after = buy(board(), BO);
    expect(after.public_companies[1].is_floated).toBe(false);
    expect(after.active_player_index).toBe(1);
  });

  it("advances when the corporation has no resolvable home hex", () => {
    /* #416: a float with no home hex on this board owes no token, so there is nothing to wait for. Keyed on
       the debt rather than on the float, which is what makes this fall out rather than need a special case. */
    const noHome = board({
      public_companies: [
        { ...(board().public_companies[0] as object), home_hex_label: "ZZ99" },
        board().public_companies[1],
      ],
    } as never);
    expect(buy(noHome, PRR).active_player_index).toBe(1);
  });
});

describe("the opening purchase is described as what it is", () => {
  const context = {
    gameState: board(),
    mapGrid: { game_id: 1, tiles: [] } as unknown as MapGridResponse,
    era: "Yellow" as const,
    labelForAddress: (address: string) => address,
  };

  it("names the President's Certificate, the price and the par", () => {
    /* THE REPORT. B&O is unopened -- no president, no par -- so this purchase is the 20% card at twice par,
       and it is what sets the par in the first place. */
    const line = describeGameplayAction(
      { BuyStock: { game_id: 1, protocol_id: BO, source: "Ipo", par_value: "100" } } as never,
      context as never,
    );
    expect(line).toContain("20% President's Certificate of B&O");
    expect(line).toContain("for $200");
    expect(line).toContain("setting par at $100");
  });

  it("still calls an ordinary purchase a 10% share", () => {
    /* THE CONTROL. PRR is already open -- it has a president and a par -- so the next certificate really is
       10% at par, and relabelling every purchase would be a worse error than the one being fixed. */
    const line = describeGameplayAction(
      { BuyStock: { game_id: 1, protocol_id: PRR, source: "Ipo", par_value: "100" } } as never,
      context as never,
    );
    expect(line).toContain("bought a 10% share of PRR");
    expect(line).not.toContain("President's Certificate");
  });

  it("never calls a Bank Pool purchase an opening one", () => {
    // The President's Certificate only ever comes out of the IPO.
    const line = describeGameplayAction(
      { BuyStock: { game_id: 1, protocol_id: BO, source: "Bank" } } as never,
      context as never,
    );
    expect(line).not.toContain("President's Certificate");
  });

  it("stays silent about a par it does not know", () => {
    /* #554's rule: the par is precisely the figure a reader cannot reconstruct afterwards, so an invented one
       is worse than an omission. The certificate is still named. */
    const line = describeGameplayAction(
      { BuyStock: { game_id: 1, protocol_id: BO, source: "Ipo" } } as never,
      context as never,
    );
    expect(line).toContain("20% President's Certificate");
    expect(line).not.toContain("setting par");
    expect(line).not.toContain("$");
  });
});
