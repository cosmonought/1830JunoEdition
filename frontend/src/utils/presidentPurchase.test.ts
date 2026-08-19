// frontend/src/utils/presidentPurchase.test.ts
//
// ==================================================================
//  DESIGN NOTE 587 (harness): WHO MAY FOUND A CORPORATION
// ==================================================================
//
// REPORTED: a player holding the PRR share the Camden & Amboy grants tried to
// buy the PRR's president's certificate. They were asked to set a par and
// charged twice it — and received a 10% share, no presidency, no par.
//
// The test was `president === null && !anySharesHeld`, and the second clause
// was defensible right up until the C&A started working: it treated
// "somebody holds shares but nobody is president" as a malformed board, and
// design note #576 made it a normal opening position.
//
// The two halves of the app then disagreed. `StockRoundPanel` offered a
// president's purchase (its own copy of the test read the same way but the
// UI reached it first); the reducer declined to grant one. A doubled charge
// with a single certificate is what that disagreement looks like from a
// player's seat — which is why these tests assert the FULL outcome of a
// founding purchase rather than just the flag.

import { applySandboxAction, type SandboxActionContext } from "./sandboxSession";
import type { GameStateResponse } from "./gameState";

const ADA = "p-ada";
const BEN = "p-ben";

function board(
  options: {
    president?: string | null;
    par?: string | null;
    adaHolds?: number;
    /** The pool has to actually hold something for a pool buy to move. */
    pool?: number;
  } = {},
): GameStateResponse {
  const { president = null, par = null, adaHolds = 0, pool = 0 } = options;
  return {
    game_id: 1,
    player_addresses: [ADA, BEN],
    active_player_index: 0,
    priority_deal_index: 0,
    current_round_type: "StockRound",
    consecutive_passes: 0,
    active_operating_order: [],
    active_corporation_index: 0,
    virtual_bank_vgp: "12000",
    player_cash: [
      { player: ADA, cash_vgp: "600" },
      { player: BEN, cash_vgp: "600" },
    ],
    public_companies: [
      {
        company_id: 1,
        ticker: "PRR",
        president,
        par_value: par,
        is_floated: false,
        player_holdings: adaHolds > 0 ? [{ player: ADA, percentage: adaHolds }] : [],
        ipo_pool_percentage: 100,
        bank_pool_percentage: pool,
        treasury_vgp: "0",
        trains: [],
        station_tokens: [],
        station_token_hexes: [],
      },
    ],
    private_companies: [],
  } as unknown as GameStateResponse;
}

const buy = { BuyStock: { game_id: 1, protocol_id: 1, source: "Ipo", par_value: "100" } } as never;
const ctx = { actor: ADA } as SandboxActionContext;

const prr = (state: GameStateResponse) => state.public_companies[0];
const heldBy = (state: GameStateResponse, who: string) =>
  prr(state)
    .player_holdings.filter((h) => h.player === who)
    .reduce((sum, h) => sum + h.percentage, 0);
const cash = (state: GameStateResponse, who: string) =>
  Number(state.player_cash.find((e) => e.player === who)?.cash_vgp ?? 0);

describe("founding a corporation", () => {
  it("grants 20%, the presidency and the par", () => {
    const next = applySandboxAction(board(), buy, ctx);
    expect(heldBy(next, ADA)).toBe(20);
    expect(prr(next).president).toBe(ADA);
    expect(prr(next).par_value).toBe("100");
  });

  it("still founds it for a player who already holds the C&A's share", () => {
    /* THE REPORTED BUG. Ada holds 10% from the Camden & Amboy and nobody is
       president -- the exact position design note #576 created and the old
       guard treated as malformed. */
    const next = applySandboxAction(board({ adaHolds: 10 }), buy, ctx);
    expect(prr(next).president).toBe(ADA);
    expect(prr(next).par_value).toBe("100");
    expect(heldBy(next, ADA)).toBe(30); // the bonus 10% plus the 20% block
  });

  it("charges twice the par exactly when it grants the presidency", () => {
    /* The half that made the bug expensive: the old code took the double
       charge from the UI's reading and granted the single share from its
       own. Whatever the answer, the price and the certificate must agree. */
    const founded = applySandboxAction(board({ adaHolds: 10 }), buy, ctx);
    expect(cash(founded, ADA)).toBe(400); // 600 - 2 x 100

    const ordinary = applySandboxAction(
      board({ president: BEN, par: "100", adaHolds: 10 }),
      buy,
      ctx,
    );
    expect(cash(ordinary, ADA)).toBe(500); // 600 - 100
    expect(heldBy(ordinary, ADA)).toBe(20);
  });

  it("does not hand out a second presidency", () => {
    const next = applySandboxAction(board({ president: BEN, par: "100" }), buy, ctx);
    expect(prr(next).president).toBe(BEN);
    expect(heldBy(next, ADA)).toBe(10);
  });

  it("treats a parred but presidentless company as already started", () => {
    /* The safety net the old `!anySharesHeld` clause was reaching for, kept
       in a form that cannot misfire: a par means somebody founded this, so
       the president's certificate is gone whatever the roster looks like. */
    const next = applySandboxAction(board({ par: "82" }), buy, ctx);
    expect(heldBy(next, ADA)).toBe(10);
    expect(prr(next).par_value).toBe("82");
  });

  it("founds it for the C&A holder at the price THEY set", () => {
    /* ==============================================================
     *  DESIGN NOTE 594 (harness): THE FIXTURE'S PAR WAS STILL THERE
     * ==============================================================
     *
     * REPORTED: "The par for PRR was not correctly recorded: $82 became
     * $100", and the founder got no crown.
     *
     * `withEmptyRoster` stripped the roster and left `par_value` alone --
     * and design note #587 had just made `par_value === null` the test for
     * "may this purchase found the company". The fixture is a MID-GAME
     * board, so every corporation arrived already parred, every founding
     * buy read as an ordinary one, and `company.par_value ?? ...` kept the
     * fixture's figure over the player's.
     *
     * This is the end-to-end version: a player holding the C&A's share
     * founds an unstarted company and the price is theirs. */
    const next = applySandboxAction(
      board({ adaHolds: 10 }),
      { BuyStock: { game_id: 1, protocol_id: 1, source: "Ipo", par_value: "82" } } as never,
      ctx,
    );
    expect(prr(next).par_value).toBe("82");
    expect(prr(next).president).toBe(ADA);
    expect(cash(next, ADA)).toBe(600 - 164);
  });

  it("never founds a corporation from a bank-pool purchase", () => {
    // The pool sells ordinary shares; the president's certificate starts in
    // the IPO and is never in the pool to be bought.
    const fromPool = {
      BuyStock: { game_id: 1, protocol_id: 1, source: "Bank", par_value: null },
    } as never;
    const next = applySandboxAction(board({ pool: 30 }), fromPool, ctx);
    expect(prr(next).president).toBeNull();
    expect(heldBy(next, ADA)).toBe(10);
  });
});
