/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1205 (harness): THE CHECK THAT DEFEATED THE REDUCER TWICE
// ==================================================================
//
// #1174 broke ten tests across four suites, `replayAttribution` among them. #1182 passed every test it had
// and reached real players. So this file is written on the assumption that the next mistake here will also
// look correct: each case names the flow it protects and what a player would lose if it were refused.
//
// THE FOUR BRANCHES ARE PINNED THROUGH `actingAddress`, NOT REIMPLEMENTED. A test that restated the rule
// would pass while the rule drifted -- #1184's shape in a test file. These cases build boards and assert who
// may act, so they fail if `actingAddress` changes its mind.

export {};

const { turnRefusal } = require("./turnAuthority") as typeof import("./turnAuthority");
const { sandboxScenarioState } = require("./sandboxState") as typeof import("./sandboxState");

type State = import("./gameState").GameStateResponse;
type Waterfall = import("./gameState").WaterfallStateResponse;

const ALICE = "p-alice";
const BOB = "p-bob";
const CAROL = "p-carol";

function board(over: Partial<State> = {}): State {
  const seed = sandboxScenarioState("start", 0, "default");
  return {
    ...seed,
    player_addresses: [ALICE, BOB, CAROL],
    active_player_index: 0,
    current_round_type: "StockRound",
    ...over,
  };
}

const refusal = (
  state: State,
  actor: string | null,
  msg: unknown,
  extra: { waterfall?: Waterfall | null; derived?: boolean } = {},
) =>
  turnRefusal({
    state,
    waterfall: extra.waterfall ?? null,
    actor,
    msg: msg as never,
    derived: extra.derived,
  });

const PASS = { PassTurn: { game_id: 0 } };

describe("the seat-driven rounds", () => {
  it("lets the seated player act and refuses the others", () => {
    const state = board();
    expect(refusal(state, ALICE, PASS)).toBeNull();
    expect(refusal(state, BOB, PASS)).toBe("It is not your turn.");
  });

  it("follows the cursor rather than the roster order", () => {
    const state = board({ active_player_index: 2 });
    expect(refusal(state, CAROL, PASS)).toBeNull();
    expect(refusal(state, ALICE, PASS)).not.toBeNull();
  });
});

describe("the Operating Round answers with a president, not a seat", () => {
  it("lets the operating corporation's president act", () => {
    /* #411: Operating Rounds are CORPORATION-driven and the seat pointer is not meaningful there -- it can
       easily point at a player with nothing to do. `active_player_index` below is ALICE's; the turn belongs
       to BOB because BOB is president of the corporation that is operating. */
    const seed = board();
    const state: State = {
      ...seed,
      current_round_type: "OperatingRound",
      active_player_index: 0,
      active_operating_order: [1],
      active_corporation_index: 0,
      public_companies: seed.public_companies.map((company) =>
        company.company_id === 1 ? { ...company, president: BOB } : company,
      ),
    };
    expect(refusal(state, BOB, PASS)).toBeNull();
    expect(refusal(state, ALICE, PASS)).toBe("It is not your turn.");
  });
});

describe("the mini-auction suspends the rotation, #544", () => {
  it("hands the turn to the contest's cursor and takes it from the waterfall's", () => {
    /* #544: while a contest is live the main rotation does not advance and nobody may take a waterfall
       action. `waterfall.current_turn` is preserved across the contest so it can be resumed untouched --
       which makes it a STALE pointer for the duration, and reading it here would hand the turn to a player
       who is not in the contest. */
    const state = board({ current_round_type: "WaterfallAuction", active_player_index: 0 });
    const contested = { mini_auction: { current_turn: CAROL } } as unknown as Waterfall;
    expect(refusal(state, CAROL, PASS, { waterfall: contested })).toBeNull();
    expect(refusal(state, ALICE, PASS, { waterfall: contested })).toBe("It is not your turn.");
  });

  it("falls back to the seat when no contest is running", () => {
    const state = board({ current_round_type: "WaterfallAuction", active_player_index: 0 });
    const quiet = { mini_auction: null } as unknown as Waterfall;
    expect(refusal(state, ALICE, PASS, { waterfall: quiet })).toBeNull();
  });
});

describe("the exemptions, each one a move a player would otherwise lose", () => {
  it("never audits the game's own actions", () => {
    /* #1203: the server generated these itself after a player's move. A `PassTurn` that ends a turn is by
       definition not on anybody's turn -- the corporation it belongs to has just finished. */
    const state = board({ active_player_index: 0 });
    expect(refusal(state, BOB, PASS, { derived: true })).toBeNull();
  });

  it("allows a null actor, because solo play has one", () => {
    /* #549b: a null actor is a POSITIVE STATE and `applyOneAction` resolves it to the cursor deliberately.
       Refusing would make a single-player game unplayable, and there is nobody to take a turn from. */
    expect(refusal(board(), null, PASS)).toBeNull();
  });

  it("lets the private's owner answer an offer while somebody else is on turn", () => {
    /* #701: a corporation on its turn OFFERS; the owner ANSWERS, and the owner is by definition not the one
       operating. Refusing this would make every private-company negotiation in the game unanswerable. */
    const state = board({
      active_player_index: 0,
      private_purchase_offer: {
        private_id: 3,
        private_name: "Delaware & Hudson",
        owner: BOB,
        buyer_protocol_id: 7,
        buyer_ticker: "NNH",
        price: 70,
      },
    } as Partial<State>);
    const answer = { AnswerPrivatePurchase: { private_id: 3, accept: true } };
    expect(refusal(state, BOB, answer)).toBeNull();
    expect(refusal(state, CAROL, answer)).toBe(
      "Only the private company's owner can answer that offer.",
    );
  });

  it("lets the selling president answer a train offer, and it is the buyer who is on turn", () => {
    /* #701 states the direction explicitly. Getting it backwards would refuse every train trade in the
       game, which is why the case asserts the seller passes AND the buyer does not. */
    const state = board({
      active_player_index: 0,
      train_purchase_offer: {
        seller_protocol_id: 4,
        seller_ticker: "B&O",
        seller_president: CAROL,
        buyer_protocol_id: 1,
        buyer_ticker: "PRR",
        model_type: "3",
        // NOTE: `train_purchase_offer.price` is a STRING while `private_purchase_offer.price` is a NUMBER.
        // Not this file's to reconcile; recorded in the migration plan as an audit item.
        price: "150",
      },
    } as Partial<State>);
    const answer = { AnswerTrainPurchase: { seller_protocol_id: 4, accept: true } };
    expect(refusal(state, CAROL, answer)).toBeNull();
    expect(refusal(state, ALICE, answer)).toBe(
      "Only the selling corporation's president can answer that offer.",
    );
  });

  it("does not turn a duplicate answer into an error", () => {
    /* #662: "the first answer settles it, the second finds nothing". The reducer's arm returns the state
       unchanged; a gate that refused here would put an error on the screen of somebody who did nothing
       wrong -- and in a room, a second client's replayed answer arrives exactly like this. */
    const answer = { AnswerPrivatePurchase: { private_id: 3, accept: true } };
    expect(refusal(board(), CAROL, answer)).toBeNull();
  });
});

describe("an unresolvable cursor allows the action through", () => {
  it("does not refuse when the roster is empty", () => {
    /* THE SAME LINE `dividendGate` AND `trainPurchaseGate` BOTH TAKE: "an unknown cursor is allowed through,
       deliberately ... refusing there would brick a board on the strength of a missing field rather than a
       broken rule." A board that cannot say whose turn it is has said nothing about THIS player. */
    expect(refusal(board({ player_addresses: [] }), ALICE, PASS)).toBeNull();
  });

  it("does not refuse when the operating corporation has no seated president", () => {
    const seed = board();
    const state: State = {
      ...seed,
      current_round_type: "OperatingRound",
      active_operating_order: [1],
      active_corporation_index: 0,
      public_companies: seed.public_companies.map((company) =>
        company.company_id === 1 ? { ...company, president: null } : company,
      ),
    };
    expect(refusal(state, ALICE, PASS)).toBeNull();
  });
});
