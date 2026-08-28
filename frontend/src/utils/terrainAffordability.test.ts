/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 891 (harness): THE GROUND HAS TO BE PAID FOR
// ==================================================================
//
// REPORTED: "Serious bug: B&O had $0 in its treasury and was able to lay a track tile on a terrain hex
// costing $80. Its treasury stayed $0. Corporations should not be able to lay track if they cannot afford the
// terrain cost."
//
// BOTH HALVES OF THE REPORT HAVE ONE CAUSE. `adjustTreasury` ends `Math.max(0, current + delta)` -- right for
// its other callers, and here it turned an unaffordable charge into a silent no-op: the debit was issued, the
// clamp swallowed it, the tile landed, nothing said no. So "was able to lay" and "treasury stayed $0" are the
// same line of code seen from two sides.
//
// ASKED OF THE REDUCER, because that is the authority: the UI refuses first so a player is told, but the
// reducer is what survives a replay and what a hand-built or stale message meets. This is #757's own argument
// -- "every placement rule in this game lived in a filter that decides which chips the radial selector
// OFFERS. A message built by hand, replayed from a stale tab, or dispatched by any second control written
// later went straight through." One rule, one more door closed.

import { applySandboxAction } from "./sandboxSession";
import { terrainBuildFeeAt } from "../components/hexBoardData";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const BO = 6;

function company(over: Partial<PublicCompanyState> = {}): PublicCompanyState {
  return {
    company_id: BO,
    ticker: "B&O",
    is_floated: true,
    treasury: "0",
    total_shares_issued: 10,
    par_value: "100",
    president: "juno1alice",
    ipo_pool_percentage: 0,
    bank_pool_percentage: 0,
    player_holdings: [],
    home_hex_label: null,
    station_token_hexes: [],
    station_token_limit: 4,
    owned_trains: [],
    last_route_revenue: "0",
    ...over,
  } as PublicCompanyState;
}

const state = (treasury: string): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    public_companies: [company({ treasury })],
    private_companies: [],
    player_addresses: ["juno1alice"],
    terrain_fees_paid: [],
    active_operating_order: [BO],
    active_corporation_index: 0,
  }) as unknown as GameStateResponse;

/** A hex the board actually charges for. Found rather than hard-coded: a coordinate typed in here would be a
 *  second claim about the terrain table, and #891 is a bug about the two disagreeing. */
const CHARGED = (() => {
  for (let q = -12; q <= 12; q += 1) {
    for (let r = -12; r <= 12; r += 1) {
      const fee = terrainBuildFeeAt(q, r);
      if (Number.isFinite(fee) && fee > 0) return { q, r, fee };
    }
  }
  return null;
})();

const lay = (q: number, r: number) =>
  ({ LayTile: { game_id: "g", protocol_id: BO, q, r, tile_id: 8, orientation: 0 } }) as never;

const treasuryOf = (next: GameStateResponse): number =>
  Number(next.public_companies.find((c) => c.company_id === BO)?.treasury ?? -1);

describe("a corporation cannot build on ground it cannot pay for", () => {
  it("has a charged hex on the real board to test against", () => {
    /* THE PREMISE, PINNED. Every test below is about a hex with a fee; if the search found none, they would
       all pass while asserting nothing -- and `terrainBuildFeeAt` returning 0 everywhere is exactly the
       silent regression that would produce it. */
    expect(CHARGED).not.toBeNull();
    expect(CHARGED!.fee).toBeGreaterThan(0);
  });

  it("refuses the lay outright at $0, rather than laying it free", () => {
    /* THE REPORTED CASE, and the assertion is that NOTHING happened -- not merely that the treasury is
       unchanged. A reducer that clamped the debit and kept the tile would also leave the treasury at 0, so
       the terrain ledger is what tells the two apart: a refused lay never records the ground as paid. */
    const before = state("0");
    const after = applySandboxAction(before, lay(CHARGED!.q, CHARGED!.r));
    expect(treasuryOf(after)).toBe(0);
    expect(after.terrain_fees_paid ?? []).toEqual([]);
  });

  it("refuses a treasury that is short by a dollar", () => {
    /* THE BOUNDARY, because `<` and `<=` are one character apart and the wrong one is invisible in play until
       somebody is short by exactly the amount that matters. */
    const after = applySandboxAction(state(String(CHARGED!.fee - 1)), lay(CHARGED!.q, CHARGED!.r));
    expect(treasuryOf(after)).toBe(CHARGED!.fee - 1);
    expect(after.terrain_fees_paid ?? []).toEqual([]);
  });

  it("allows it at exactly the fee, and charges it", () => {
    /* THE CONTROL. A guard written `<=` would refuse this, which is a corporation forbidden from spending its
       last dollar on ground the rules let it buy -- the opposite bug, and the one a too-eager fix produces. */
    const after = applySandboxAction(state(String(CHARGED!.fee)), lay(CHARGED!.q, CHARGED!.r));
    expect(treasuryOf(after)).toBe(0);
    expect(after.terrain_fees_paid ?? []).not.toEqual([]);
  });

  it("still charges a corporation that can afford it", () => {
    const after = applySandboxAction(state("500"), lay(CHARGED!.q, CHARGED!.r));
    expect(treasuryOf(after)).toBe(500 - CHARGED!.fee);
  });

  it("leaves free ground alone at $0", () => {
    /* MOST OF THE BOARD COSTS NOTHING, and a guard that read "fee" as "always charge something" would block
       every ordinary lay by a broke corporation -- which is legal and common. */
    const free = (() => {
      for (let q = -12; q <= 12; q += 1) {
        for (let r = -12; r <= 12; r += 1) {
          if (!(terrainBuildFeeAt(q, r) > 0)) return { q, r };
        }
      }
      return null;
    })();
    expect(free).not.toBeNull();
    const after = applySandboxAction(state("0"), lay(free!.q, free!.r));
    expect(treasuryOf(after)).toBe(0);
  });
});
