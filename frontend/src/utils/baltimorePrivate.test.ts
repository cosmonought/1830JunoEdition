// frontend/src/utils/baltimorePrivate.test.ts
//
// ==================================================================
//  DESIGN NOTE 660 (harness): A RULE THE GAME ONLY SAID
// ==================================================================
//
// REPORTED: "the rules prohibit B&O (private company) being sold to a
// corporation ... B&O (private company) closes as soon as B&O (corporation)
// purchases its first train, and in my playthrough B&O (corp) has purchased a
// train and is still appearing in this modal and the Player card on multiple
// screens and Player Assets in Game Ledger."
//
// Both rules were already in `privateCatalog.ts`, in prose, on screen in the
// powers panel: "It can never be sold to a corporation ... It closes the
// moment the B&O buys its first train." Neither was enforced anywhere.
//
// That is the failure mode this file exists to prevent, and it is worse than
// an unimplemented rule: the game TAUGHT the player a rule and then did not
// keep it. Same shape as the "GAME END" tooltip on a cell that ended nothing
// (#652). Prose cannot be tested; these predicates can.

import { applySandboxAction } from "./sandboxSession";
import {
  BAO_COMPANY_ID,
  BAO_PRIVATE_ID,
  baoPrivateShouldClose,
  corporateSaleBlockReason,
  isSellableToCorporation,
  settleBaoPrivate,
} from "./baltimorePrivate";
import {
  privatePurchaseBlockReason,
  purchasablePrivatesInPlay,
} from "../components/PrivateTradePanel";
import type { GameStateResponse, PrivateCompanyState, PublicCompanyState } from "./gameState";

const ALICE = "juno1alice";
const BOB = "juno1bob";

function company(
  over: Partial<PublicCompanyState> & Pick<PublicCompanyState, "company_id" | "ticker">,
): PublicCompanyState {
  return {
    is_floated: true,
    treasury: "900",
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

function priv(
  over: Partial<PrivateCompanyState> & Pick<PrivateCompanyState, "private_id" | "name">,
): PrivateCompanyState {
  return {
    cost: "100",
    revenue_per_or: "10",
    owner: ALICE,
    owner_protocol_id: null,
    closed: false,
    ...over,
  };
}

/** A board where the B&O corporation has NOT yet bought a train, and the B&O
 *  private is held by a player. */
function boardBeforeTheFirstTrain(): GameStateResponse {
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
    active_operating_order: [BAO_COMPANY_ID, 1],
    active_corporation_index: 0,
    current_round_type: "OperatingRound",
    macro_round_number: 1,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: BOB, cash_vgp: "400" },
    ],
    public_companies: [
      company({ company_id: BAO_COMPANY_ID, ticker: "B&O", president: ALICE }),
      company({ company_id: 1, ticker: "PRR", president: BOB }),
    ],
    private_companies: [
      priv({ private_id: 3, name: "Delaware & Hudson", owner: BOB }),
      priv({ private_id: BAO_PRIVATE_ID, name: "Baltimore & Ohio", owner: ALICE }),
    ],
  };
}

type Msg = Parameters<typeof applySandboxAction>[1];

describe("closing on the first train", () => {
  it("stays open while the B&O owns no train", () => {
    const board = boardBeforeTheFirstTrain();
    expect(baoPrivateShouldClose(board)).toBe(false);
    expect(settleBaoPrivate(board)).toBe(board);
  });

  it("closes once the B&O owns one", () => {
    const board = boardBeforeTheFirstTrain();
    const withTrain: GameStateResponse = {
      ...board,
      public_companies: board.public_companies.map((c) =>
        c.company_id === BAO_COMPANY_ID ? { ...c, owned_trains: ["2"] } : c,
      ),
    };
    expect(baoPrivateShouldClose(withTrain)).toBe(true);
    const settled = settleBaoPrivate(withTrain);
    const bao = settled.private_companies.find((p) => p.private_id === BAO_PRIVATE_ID);
    expect(bao?.closed).toBe(true);
  });

  it("releases the owner with it", () => {
    /* Half the reported symptom was the private still showing on the player
       card and in Player Assets. A closed private that keeps its `owner` is
       still counted there -- `applyPrivateExchange` releases both fields on
       the Mohawk & Hudson's exchange (#573a) and this matches. */
    const board = boardBeforeTheFirstTrain();
    const withTrain: GameStateResponse = {
      ...board,
      public_companies: board.public_companies.map((c) =>
        c.company_id === BAO_COMPANY_ID ? { ...c, owned_trains: ["2"] } : c,
      ),
    };
    const bao = settleBaoPrivate(withTrain).private_companies.find(
      (p) => p.private_id === BAO_PRIVATE_ID,
    );
    expect(bao?.owner).toBeNull();
    expect(bao?.owner_protocol_id).toBeNull();
  });

  it("leaves every other private alone", () => {
    const board = boardBeforeTheFirstTrain();
    const withTrain: GameStateResponse = {
      ...board,
      public_companies: board.public_companies.map((c) =>
        c.company_id === BAO_COMPANY_ID ? { ...c, owned_trains: ["2"] } : c,
      ),
    };
    const dh = settleBaoPrivate(withTrain).private_companies.find((p) => p.private_id === 3);
    expect(dh?.closed).toBe(false);
    expect(dh?.owner).toBe(BOB);
  });

  it("does not close on a board whose fleet is unreported", () => {
    /* `owned_trains == null` is "we do not know", not "no trains" -- the
       distinction `gamePhase.ts` draws. Closing a company on a board we know
       nothing about would destroy an asset on a guess. */
    const board = boardBeforeTheFirstTrain();
    const unknown: GameStateResponse = {
      ...board,
      public_companies: board.public_companies.map((c) => ({
        ...c,
        owned_trains: null as unknown as string[],
      })),
    };
    expect(baoPrivateShouldClose(unknown)).toBe(false);
  });

  it("closes through the reducer, on the purchase itself", () => {
    /* THE REPORTED PLAYTHROUGH. The B&O buys its first train and the private
       is gone by the time the action resolves -- not on the next action, and
       not only after a reload. */
    const before = boardBeforeTheFirstTrain();
    const after = applySandboxAction(before, {
      BuyHardwareFromPool: { game_id: 1, protocol_id: BAO_COMPANY_ID, model_type: "2" },
    } as Msg);
    expect(
      after.public_companies.find((c) => c.company_id === BAO_COMPANY_ID)?.owned_trains?.length,
    ).toBeGreaterThan(0);
    expect(after.private_companies.find((p) => p.private_id === BAO_PRIVATE_ID)?.closed).toBe(true);
  });
});

describe("the corporate sale ban", () => {
  it("names the B&O and nothing else", () => {
    expect(isSellableToCorporation(BAO_PRIVATE_ID)).toBe(false);
    for (const id of [1, 2, 3, 4, 5]) {
      expect(isSellableToCorporation(id)).toBe(true);
    }
  });

  it("gives a reason a player can read", () => {
    const bao = priv({ private_id: BAO_PRIVATE_ID, name: "Baltimore & Ohio" });
    expect(corporateSaleBlockReason(bao)).toContain("never be sold to a corporation");
    expect(corporateSaleBlockReason(priv({ private_id: 3, name: "Delaware & Hudson" }))).toBeNull();
  });

  it("refuses the B&O on the list the modal actually renders", () => {
    /* Design note #660a: the first draft of this test asserted against
       `eligiblePrivatesForPurchase`, and passed -- against a function no
       caller ever ran. The modal renders `purchasablePrivatesInPlay` and
       gates selection on `privatePurchaseBlockReason`, so those are what the
       rule has to hold against.

       The B&O is still SHOWN. Design note #386 renders an unbuyable private
       as an inert row so the player learns it exists; what must be true is
       that it can never be selected. */
    const shown = purchasablePrivatesInPlay(boardBeforeTheFirstTrain().private_companies);
    expect(shown.map((entry) => entry.private_id)).toContain(BAO_PRIVATE_ID);

    const bao = shown.find((entry) => entry.private_id === BAO_PRIVATE_ID);
    expect(bao).toBeDefined();
    expect(privatePurchaseBlockReason(bao!)).toContain("never be sold to a corporation");

    const dh = shown.find((entry) => entry.private_id === 3);
    expect(privatePurchaseBlockReason(dh!)).toBeNull();
  });

  it("drops the B&O from the list entirely once it has closed", () => {
    /* The two rules meeting. After the B&O corporation buys a train the
       private is closed, and `purchasablePrivatesInPlay` filters closed
       companies -- so it leaves the modal by the ordinary route rather than
       needing the ban to hide it. */
    const board = boardBeforeTheFirstTrain();
    const withTrain: GameStateResponse = {
      ...board,
      public_companies: board.public_companies.map((c) =>
        c.company_id === BAO_COMPANY_ID ? { ...c, owned_trains: ["2"] } : c,
      ),
    };
    const shown = purchasablePrivatesInPlay(settleBaoPrivate(withTrain).private_companies);
    expect(shown.map((entry) => entry.private_id)).not.toContain(BAO_PRIVATE_ID);
  });

  it("refuses the purchase in the reducer, not only in the UI", () => {
    /* The filter is a UI guarantee and a replayed log entry does not go
       through it. A remote client replays MESSAGES, so the rule has to hold
       against a message nobody could have clicked. */
    const before = boardBeforeTheFirstTrain();
    const after = applySandboxAction(before, {
      BuyPrivateCompany: {
        game_id: 1,
        protocol_id: 1,
        private_id: BAO_PRIVATE_ID,
        price: "220",
      },
    } as Msg);
    const bao = after.private_companies.find((p) => p.private_id === BAO_PRIVATE_ID);
    expect(bao?.owner).toBe(ALICE);
    expect(bao?.owner_protocol_id).toBeNull();
  });

  it("still allows an ordinary private to be sold", () => {
    /* The ban must be narrow. A fix that blocked every corporate purchase
       would pass every assertion above. */
    const before = boardBeforeTheFirstTrain();
    const after = applySandboxAction(before, {
      BuyPrivateCompany: { game_id: 1, protocol_id: 1, private_id: 3, price: "70" },
    } as Msg);
    expect(after.private_companies.find((p) => p.private_id === 3)?.owner_protocol_id).toBe(1);
  });
});
