// frontend/src/utils/eraTracksPhase.test.ts
//
// ==================================================================
//  DESIGN NOTE 657 (harness): TILES NOW, ROUND PATTERN LATER
// ==================================================================
//
// INSTRUCTED: "tiles should become available immediately based on the era:
// so as soon as a game enters Green, green tiles must be available, though
// the SR>OR pattern does not change at this point."
//
// Two rules with different timings, and the interesting thing about them is
// that they are both about the same event. Buying the first 3-train changes
// the phase; the tile colour that unlocks is available on the spot, and the
// number of Operating Rounds in the CURRENT cycle does not move.
//
// The first half had never been implemented in the sandbox at all --
// `current_global_era` was written once at seed time and never again, so a
// Phase 6 game still reported "Yellow". The second half was implemented and
// is easy to break by accident while fixing the first, which is why both are
// asserted here rather than only the one that changed.

import { applySandboxAction } from "./sandboxSession";
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const ALICE = "juno1alice";
const BOB = "juno1bob";

function company(
  over: Partial<PublicCompanyState> & Pick<PublicCompanyState, "company_id" | "ticker">,
): PublicCompanyState {
  return {
    is_floated: true,
    treasury: "2000",
    total_shares_issued: 10,
    par_value: "100",
    president: ALICE,
    ipo_pool_percentage: 0,
    bank_pool_percentage: 0,
    player_holdings: [],
    home_hex_label: null,
    station_token_hexes: [],
    station_token_limit: 4,
    owned_trains: [],
    last_route_revenue: "0",
    ...over,
  };
}

/** An Operating Round in Phase 2, with the six 2-trains already gone -- so
 *  the depot's cheapest is a 3-train and the very next purchase moves the
 *  game into Green.
 *
 *  The 2-trains are spread across two bystander corporations because one
 *  corporation cannot hold six under the Phase 2 train limit, and because
 *  the depot sells CHEAPEST FIRST regardless of the `model_type` asked for
 *  -- a fixture that does not drain them first buys a 2-train and tests
 *  nothing. */
function aboutToEnterGreen(): GameStateResponse {
  return {
    game_id: 1,
    creator: ALICE,
    is_active: true,
    total_juno_pool: "0",
    virtual_bank_vgp: "12000",
    virtual_bank_start: "12000",
    max_players: 2,
    player_addresses: [ALICE, BOB],
    active_player_index: 0,
    priority_deal_index: 1,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [4, 1],
    active_corporation_index: 0,
    current_round_type: "OperatingRound",
    macro_round_number: 1,
    sub_round_index: 1,
    // Design note #511: stamped when the cycle opened, in Phase 2. One.
    operating_round_sequence_length: 1,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: BOB, cash_vgp: "400" },
    ],
    public_companies: [
      company({ company_id: 4, ticker: "B&O", president: ALICE }),
      company({ company_id: 1, ticker: "PRR", president: BOB }),
      company({ company_id: 2, ticker: "NYC", president: BOB, owned_trains: ["2", "2", "2"] }),
      company({ company_id: 3, ticker: "CPR", president: BOB, owned_trains: ["2", "2", "2"] }),
    ],
    private_companies: [],
  };
}

type Msg = Parameters<typeof applySandboxAction>[1];

const BUY_TRAIN = {
  BuyHardwareFromPool: { game_id: 1, protocol_id: 4, model_type: "3" },
} as Msg;

describe("entering Green", () => {
  it("moves the era on the purchase that moves the phase", () => {
    /* The instruction's first half. Before this the assertion was simply
       impossible to satisfy: `sandboxSession.ts` contained no
       `current_global_era:` write of any kind. */
    const before = aboutToEnterGreen();
    expect(before.current_global_era).toBe("Yellow");
    const after = applySandboxAction(before, BUY_TRAIN);
    // The purchase really was a 3-train -- without this the test could pass
    // having bought a 2-train and changed nothing.
    expect(after.public_companies.find((c) => c.company_id === 4)?.owned_trains).toContain("3");
    expect(after.current_global_era).toBe("Green");
  });

  it("does not lengthen the cycle it happens in", () => {
    /* The instruction's second half -- "the SR>OR pattern does not change at
       this point". Design note #511 locks `operating_round_sequence_length`
       when a cycle opens, and the era fix must not quietly re-derive it.

       This is the regression design note #431 describes having already been
       through once: "a 3-train bought mid-cycle turned a one-round Yellow
       cycle into a two-round Green one halfway through." */
    const after = applySandboxAction(aboutToEnterGreen(), BUY_TRAIN);
    expect(after.operating_round_sequence_length).toBe(1);
    expect(after.sub_round_index).toBe(1);
  });

  it("does not move the acting corporation off its own turn", () => {
    /* Design note #656's rule, restated against the era change specifically
       -- the two fixes touch the same moment and the same action. */
    const after = applySandboxAction(aboutToEnterGreen(), BUY_TRAIN);
    expect(after.active_corporation_index).toBe(0);
  });
});

describe("the era is settled, not assigned", () => {
  it("corrects a state whose era disagrees with its trains", () => {
    /* The property that makes this un-driftable. The era is recomputed from
       the fleet after EVERY action, so a state that arrives wrong -- an old
       Firestore log replayed into a client, a hand-edited fixture -- is
       right again after one message, rather than staying wrong until
       somebody happens to buy a train. */
    const stale: GameStateResponse = {
      ...aboutToEnterGreen(),
      current_global_era: "Yellow",
      public_companies: aboutToEnterGreen().public_companies.map((c) =>
        c.company_id === 4 ? { ...c, owned_trains: ["5"] } : c,
      ),
    };
    const after = applySandboxAction(stale, {
      AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 4 },
    } as Msg);
    expect(after.current_global_era).toBe("Brown");
  });

  it("leaves a board with no reported fleet alone", () => {
    /* `owned_trains: null` is "not reported", which is different from "no
       trains" (`gamePhase.ts`'s own distinction). A scenario seeded in Green
       must not be dragged back to Yellow by a board we know nothing about --
       `sandboxState.ts` seeds one exactly that way. */
    const unknown: GameStateResponse = {
      ...aboutToEnterGreen(),
      current_global_era: "Green",
      public_companies: aboutToEnterGreen().public_companies.map((c) => ({
        ...c,
        owned_trains: null as unknown as string[],
      })),
    };
    const after = applySandboxAction(unknown, {
      AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 4 },
    } as Msg);
    expect(after.current_global_era).toBe("Green");
  });

  it("stays put across an action that changes nothing about the fleet", () => {
    const opened = applySandboxAction(aboutToEnterGreen(), {
      AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 4 },
    } as Msg);
    expect(opened.current_global_era).toBe("Yellow");
  });
});
