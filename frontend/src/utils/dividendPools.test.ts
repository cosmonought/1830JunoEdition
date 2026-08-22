// frontend/src/utils/dividendPools.test.ts
//
// ==================================================================
//  DESIGN NOTE 706 (harness): TWO POOLS, EXACTLY SWAPPED
// ==================================================================
//
// 1830, verbatim: "Shares in the bank pool pay dividends to the corporate treasury. No payments are made for
// unsold initial offering shares."
//
// The reducer did the opposite of both halves. It paid `ipo_pool_percentage` into the operating corporation's
// treasury, and let `bank_pool_percentage` stay with the bank:
//
//     const treasurySlice = perShare * (company.ipo_pool_percentage / 10);
//     if (treasurySlice > 0) next = adjustTreasury(next, protocol_id, treasurySlice);
//     const bankSlice = perShare * (company.bank_pool_percentage / 10);
//     return adjustBank(next, -(revenue - bankSlice));
//
// WHY IT SURVIVED: being wrong in both directions at once, the TOTAL still looked plausible. Every dollar was
// accounted for, and the bank's ledger balanced -- only the recipient of one slice was wrong, and no screen
// showed the recipient. It surfaced because #705 tried to draw that recipient and had to ask who it was.
//
// AND IT COST THE READING TWICE. Two corrections to #705's display were made by consulting the reducer as the
// authority ("the code pays the IPO, so the IPO must be paid"), which is exactly the wrong move when the code
// is the thing that is inverted. The rule had to come from the rulebook.
//
// IT REWARDED THE POSITION 1830 DOES NOT. A freshly floated corporation is mostly IPO, so it collected on
// nearly every dividend it declared; a corporation players had dumped back into the pool is where the real
// rule pays, and it collected nothing.

import { applySandboxAction } from "./sandboxSession";
import type { GameStateResponse } from "./gameState";

const ALICE = "alice";

function state(over: { ipo?: number; pool?: number; held?: number } = {}): GameStateResponse {
  const ipo = over.ipo ?? 0;
  const pool = over.pool ?? 0;
  const held = over.held ?? 100 - ipo - pool;
  return {
    game_id: 1,
    virtual_bank_vgp: "10000",
    player_addresses: [ALICE],
    active_player_index: 0,
    player_cash: [{ player: ALICE, cash_vgp: "500" }],
    public_companies: [
      {
        company_id: 1,
        ticker: "B&O",
        treasury: "240",
        is_floated: true,
        president: ALICE,
        ipo_pool_percentage: ipo,
        bank_pool_percentage: pool,
        player_holdings: held > 0 ? [{ player: ALICE, percentage: held }] : [],
        owned_trains: ["3"],
        last_route_revenue: "180",
        station_token_hexes: [],
      },
    ],
  } as unknown as GameStateResponse;
}

function payOut(before: GameStateResponse): GameStateResponse {
  return applySandboxAction(before, {
    DeclareDividends: {
      game_id: 1,
      protocol_id: 1,
      revenue_amount: "180",
      distribute: true,
    },
  } as never);
}

function treasuryOf(s: GameStateResponse): number {
  return Number(s.public_companies[0].treasury ?? 0);
}

function cashOf(s: GameStateResponse): number {
  return Number(s.player_cash.find((row) => row.player === ALICE)?.cash_vgp ?? 0);
}

describe("shares in the bank pool pay the corporate treasury", () => {
  it("credits the pool's slice to the corporation", () => {
    /* THE RULE'S FIRST HALF. 70% held, 30% pooled: the player takes $126 and the treasury takes $54.
       Under the old code the treasury took NOTHING here -- the bank simply kept it. */
    const after = payOut(state({ pool: 30, held: 70 }));
    expect(cashOf(after)).toBe(500 + 126);
    expect(treasuryOf(after)).toBe(240 + 54);
  });

  it("leaves the treasury alone when the pool is empty", () => {
    const after = payOut(state({ held: 100 }));
    expect(treasuryOf(after)).toBe(240);
    expect(cashOf(after)).toBe(500 + 180);
  });
});

describe("no payments are made for unsold initial offering shares", () => {
  it("pays nothing on the IPO", () => {
    /* THE RULE'S SECOND HALF, and the one the old code got backwards most expensively. 60% held, 40% still
       unsold: the player takes $108 and NOBODY takes the other $72. The old code paid that $72 into the
       corporation's own treasury, so a barely-sold corporation part-funded itself on every dividend. */
    const after = payOut(state({ ipo: 40, held: 60 }));
    expect(cashOf(after)).toBe(500 + 108);
    expect(treasuryOf(after)).toBe(240);
  });

  it("distinguishes the two pools rather than treating them alike", () => {
    /* The assertion that would have caught the swap. Same 30% away from players, two different destinations --
       if the reducer confused them, these two treasuries would match. */
    const pooled = treasuryOf(payOut(state({ pool: 30, held: 70 })));
    const unsold = treasuryOf(payOut(state({ ipo: 30, held: 70 })));
    expect(pooled).toBe(240 + 54);
    expect(unsold).toBe(240);
    expect(pooled).not.toBe(unsold);
  });
});

describe("the bank funds exactly what it paid", () => {
  it("loses the players' cash and the treasury's slice, and nothing more", () => {
    /* Summed rather than reconstructed from `revenue` minus other slices -- the old expression had to stay in
       step with two figures computed elsewhere, and did not. */
    const before = state({ ipo: 20, pool: 20, held: 60 });
    const after = payOut(before);
    const moved =
      cashOf(after) - cashOf(before) + (treasuryOf(after) - treasuryOf(before));
    expect(moved).toBe(108 + 36);
    expect(Number(before.virtual_bank_vgp) - Number(after.virtual_bank_vgp)).toBe(moved);
  });

  it("pays out nothing at all for a wholly unsold corporation", () => {
    const before = state({ ipo: 100, held: 0 });
    const after = payOut(before);
    expect(Number(before.virtual_bank_vgp)).toBe(Number(after.virtual_bank_vgp));
    expect(treasuryOf(after)).toBe(240);
  });
});
