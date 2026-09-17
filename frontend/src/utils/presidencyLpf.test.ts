/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1620 (harness): THE OTHER 20% IS NOT A CROWN (Slice 8.3, S8-2)
// ==================================================================
//
// PRINTED SCENARIO-D BEHAVIOUR, not an owner invention. The full 48-page rulebook (Scenario D, S-1.2 5.0,
// p. 34) gives the ERIE two 20% certificates -- the president's and an "other" one -- and six 10%s, and
// handles the N&W's second 20% the same way. Eight pieces of card each, not nine, and one of the two 20%s
// carries no presidency at all. `doubleCertificate.ts` (#1324) models it as `double_certificate: { at }`
// beside the percentages, and `certificateCardsHeld` counts it as ONE card (#1374).
//
// WHY PRESIDENCY NEEDS ITS OWN CASES HERE. `presidentFor` decides on PERCENTAGE plus §5.4 and never reads
// `double_certificate`, which is exactly right and exactly what could go wrong two ways: a holder of the
// other 20% could be crowned merely for holding a 20% CARD (it is a 20% holding, no more), or their 20%
// could be read as two 10%s and bias a tie-break that is supposed to be decided by the seating circle. Both
// are asserted absent below, for the ERIE and for the N&W, because the two share one representation and a
// catalog change could silently drop one of them.
//
// AND THE EXCHANGE ITSELF HAS TWO SHAPES HERE (owner ruling 2026-09-17, S8-15; design note #1622). §5.4's
// "he gives you two of his certificates" has one decomposition in the printed game and two under Scenario D:
// a successor holding the other-20 and fewer than two ordinary 10%s has no two 10%s to hand back, so the
// card that goes back is the other-20 itself, one-for-one for the President's Certificate. Which shape
// applies is read off `ordinaryPercentHeld` and never off the total percentage -- two successors on 30% take
// different exchanges depending on their cards, which is the whole of it.

export {};

const { presidentFor, presidentAfterSale, settlePresidencies } =
  require("../gameEngine/presidencyTransfer") as typeof import("../gameEngine/presidencyTransfer");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { certificateCount } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
const {
  certificateCardsHeld,
  certificateCardsInPool,
  doubleCertificateAt,
  needsDoubleForPresidencyExchange,
  ordinaryPercentHeld,
} = require("../gameEngine/doubleCertificate") as typeof import("../gameEngine/doubleCertificate");
const { shareSaleBlock } = require("../gameEngine/shareSale") as typeof import("../gameEngine/shareSale");
const { forcedSaleRefusal } = require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { ERIE_COMPANY_ID, DOUBLE_CERTIFICATE_COMPANY_IDS } =
  require("../gameEngine/levelPlayingField") as typeof import("../gameEngine/levelPlayingField");
const { NW_COMPANY_ID } = require("../components/hexBoardDataLpf") as typeof import("../components/hexBoardDataLpf");
const { marketZoneForPrice, parBoxCellFor, projectShareSaleMove } =
  require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const A = "p-a";
const B = "p-b";
const C = "p-c";
const D = "p-d";
const SEATS = [A, B, C, D] as const;

interface DoubleCorp {
  id: number;
  ticker: string;
  president: string | null;
  /** Who holds the printed NON-PRESIDENT 20% certificate: a player, `"Ipo"` or `"Bank"` -- or `null` for a
   *  corporation that prints none, which is the printed game's eight-corporation shape. */
  doubleAt: string | null;
  ipo: number;
  pool: number;
  holdings: ReadonlyArray<readonly [string, number]>;
}

/** A Stock Round board carrying one Scenario-D corporation. Holdings are listed in an order that is NOT the
 *  seating order, so no case here can pass by reading `player_holdings`. */
function board(
  corp: DoubleCorp,
  over: { seating?: readonly string[]; cash?: Record<string, number> } = {},
): GameStateResponse {
  const seating = over.seating ?? SEATS;
  return {
    current_round_type: "StockRound",
    macro_round_number: 2,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    variants: { rules: 1, levelPlayingField: true },
    player_addresses: [...seating],
    player_cash: seating.map((player) => ({ player, cash_vgp: String(over.cash?.[player] ?? 2000) })),
    virtual_bank_vgp: "9000",
    private_companies: [],
    market_positions: { [corp.id]: { price: 100, ...(parBoxCellFor(100) ?? { x: 2, y: 3 }), enteredAt: corp.id } },
    public_companies: [
      {
        company_id: corp.id,
        ticker: corp.ticker,
        president: corp.president,
        par_value: "100",
        is_floated: true,
        treasury: "0",
        owned_trains: [],
        ipo_pool_percentage: corp.ipo,
        bank_pool_percentage: corp.pool,
        player_holdings: corp.holdings.map(([player, percentage]) => ({ player, percentage })),
        ...(corp.doubleAt === null ? {} : { double_certificate: { at: corp.doubleAt } }),
        station_token_hexes: [],
        station_tokens: [],
        total_shares_issued: 0,
      },
    ],
  } as unknown as GameStateResponse;
}

const ctxFor = (state: GameStateResponse, actor: string | null) => {
  const positions = state.market_positions ?? {};
  const priceFor = (companyId: number): number | null => positions[companyId]?.price ?? null;
  return {
    actor,
    parCellFor: parBoxCellFor,
    marketZoneFor: (companyId: number) => marketZoneForPrice(priceFor(companyId)),
    zoneForPrice: marketZoneForPrice,
    marketPricesByCompany: Object.fromEntries(
      Object.entries(positions).map(([id, mark]) => [Number(id), mark?.price ?? null]),
    ) as Record<number, number | null>,
    marketContext: {
      projectSale: (from: { x: number; y: number; price: number }, blocks: number) => projectShareSaleMove(from, blocks),
    },
  };
};

const apply = (state: GameStateResponse, msg: unknown, actor: string | null) =>
  applySandboxAction(state, msg as never, ctxFor(state, actor) as never);

const SELL = (id: number, percentage: number) => ({ SellStock: { game_id: 0, protocol_id: id, percentage } });
const BUY = (id: number, source: "Ipo" | "Bank" = "Ipo") => ({
  BuyStock: { game_id: 0, protocol_id: id, source },
});

const only = (state: GameStateResponse) => state.public_companies[0];
const held = (state: GameStateResponse, player: string) =>
  only(state).player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
/** Every card of the corporation, wherever it sits. Eight for a Scenario-D corporation. */
const cards = (state: GameStateResponse) =>
  SEATS.reduce((sum, player) => sum + certificateCount(player, state), 0) +
  certificateCardsInPool(only(state), "Ipo") +
  certificateCardsInPool(only(state), "Bank");

/** Every holder's percentage, as a comparable map -- for asserting the exchange moved NO ownership. */
const percentages = (state: GameStateResponse) =>
  Object.fromEntries(only(state).player_holdings.map((entry) => [entry.player, entry.percentage]));

/** THE CANONICAL S9-14 BOARD: A presides on the President's 20% and holds nothing else; B's only
 *  certificate is the printed other-20, also 20%. Tied, so A is still president -- and the moment A
 *  announces a sale, that sale is what moves the crown, so the exchange happens before it completes and A is
 *  the one holding a 20% card. `pool` is the PRE-SALE Bank Pool, which is the whole question. */
const tieBoard = (make: (over: Partial<DoubleCorp>) => DoubleCorp, pool: number) =>
  board(make({ president: A, doubleAt: B, ipo: 60 - pool, pool, holdings: [[B, 20], [A, 20]] }));

const erie = (over: Partial<DoubleCorp>): DoubleCorp => ({
  id: ERIE_COMPANY_ID,
  ticker: "ERIE",
  president: A,
  doubleAt: "Ipo",
  ipo: 100,
  pool: 0,
  holdings: [],
  ...over,
});
const nw = (over: Partial<DoubleCorp>): DoubleCorp => ({ ...erie(over), id: NW_COMPANY_ID, ticker: "N&W" });
const ERIE_TIE = (pool: number) => tieBoard(erie, pool);
const NW_TIE = (pool: number) => tieBoard(nw, pool);

describe("0. the printed certificate mix (full rulebook, Scenario D 5.0 p. 34)", () => {
  it("is president 20 + other 20 + six 10s for BOTH the ERIE and the N&W -- eight cards, not nine", () => {
    /* The fact the rest of this file rests on, and the one a catalog change would break. `levelPlayingField.ts`
       seeds the other 20% into the IPO of exactly these two ids; `levelPlayingFieldRules.test.ts` pins the
       seeding and the N&W pool count (#1374), and this states the mix for both so neither can drift alone. */
    expect(DOUBLE_CERTIFICATE_COMPANY_IDS).toEqual([ERIE_COMPANY_ID, NW_COMPANY_ID]);
    for (const make of [erie, nw]) {
      const full = only(board(make({ president: null, ipo: 100 })));
      expect(full.ipo_pool_percentage).toBe(100);
      // 1 president + 1 other-20 + 6 tens. Nine would be the printed game's one 20 and eight 10s.
      expect(certificateCardsInPool(full, "Ipo")).toBe(8);
    }
  });
});

describe("1. the other 20% qualifies its holder and crowns nobody", () => {
  it("is a 20% HOLDING for eligibility -- and a tie with the incumbent, so the incumbent stays", () => {
    /* §11.1 of the brief. A holds the President's Certificate and nothing else; B holds the printed other
       20% and nothing else. 20 v 20 is not an excess, so the crown does not move -- and B is not crowned for
       holding a 20% CARD either, which is the confusion the second 20% invites. */
    for (const make of [erie, nw]) {
      const state = board(make({ president: A, doubleAt: B, ipo: 60, holdings: [[B, 20], [A, 20]] }));
      expect(presidentFor(only(state), state.player_addresses)).toBe(A);
      expect(settlePresidencies(state).state).toBe(state);
      // One card each, and the eight still add up.
      expect(certificateCardsHeld(only(state), A)).toBe(1);
      expect(certificateCardsHeld(only(state), B)).toBe(1);
      expect(cards(state)).toBe(8);
    }
  });

  it("does not make its holder president when they exceed on percentage either -- the percentage does", () => {
    /* The distinction stated as an equality: a challenger holding the other 20% plus two 10s (40%) and a
       challenger holding four 10s (40%) are the same challenger to this rule. */
    const viaDouble = board(erie({ president: A, doubleAt: B, ipo: 40, holdings: [[B, 40], [A, 20]] }));
    const viaTens = board(erie({ president: A, doubleAt: "Ipo", ipo: 40, holdings: [[B, 40], [A, 20]] }));
    expect(presidentFor(only(viaDouble), SEATS)).toBe(B);
    expect(presidentFor(only(viaTens), SEATS)).toBe(B);
  });
});

describe("2. the exchange leaves the other 20% an ordinary certificate (§11.2 / §11.4)", () => {
  /* A presides on the President's 20% alone; B holds the other 20% plus two 10s = 40% and exceeds. */
  const before = (make: (over: Partial<DoubleCorp>) => DoubleCorp) =>
    board(make({ president: A, doubleAt: B, ipo: 40, holdings: [[B, 40], [A, 20]] }));

  it("transfers the President's Certificate and rewrites nothing about the other 20%", () => {
    for (const make of [erie, nw]) {
      const after = settlePresidencies(before(make)).state;
      expect(only(after).president).toBe(B);
      /* THE ASSERTION §7 ASKS FOR: the other 20% did not "magically become" the President's Certificate, and
         it did not move. Only one field changed. */
      expect(doubleCertificateAt(only(after))).toBe(B);
      expect(only(after).double_certificate).toEqual({ at: B });
      expect(only(after).player_holdings).toEqual(only(before(make)).player_holdings);
    }
  });

  it("keeps ownership totals and both card counts correct across it", () => {
    /* §11.4. B's 40% is now the President's 20% plus the other 20% -- two cards, where it was the other 20%
       plus two 10s, three. A's 20% becomes two ordinary 10%s, where it was one 20% card. One card crosses,
       and the corporation still has eight. */
    const after = settlePresidencies(before(erie)).state;
    expect(held(after, A)).toBe(20);
    expect(held(after, B)).toBe(40);
    expect(certificateCount(B, before(erie))).toBe(3);
    expect(certificateCount(B, after)).toBe(2);
    expect(certificateCount(A, before(erie))).toBe(1);
    expect(certificateCount(A, after)).toBe(2);
    expect(cards(before(erie))).toBe(8);
    expect(cards(after)).toBe(8);
  });

  it("settles the same way through a real purchase, for the N&W (§12's standing regression)", () => {
    /* The ERIE and the N&W share one representation, so the risk is not two behaviours but one behaviour and
       one forgotten id. B buys a 10% from the IPO to go from 30% to 40% and takes the crown; the other 20%
       is still B's ordinary certificate afterwards. */
    const start = board(nw({ president: A, doubleAt: B, ipo: 50, holdings: [[B, 30], [A, 20]] }));
    const after = apply(start, BUY(NW_COMPANY_ID), B);
    expect(held(after, B)).toBe(40);
    expect(only(after).president).toBe(B);
    expect(doubleCertificateAt(only(after))).toBe(B);
    expect(cards(after)).toBe(8);
  });
});

describe("3. certificate shape does not bias the clockwise tie-break (§11.3)", () => {
  /* A presides on 30% (the President's 20% plus a 10%). B holds the other 20% as ONE card; C holds 20% as
     TWO cards. A sells 20%, drops to 10%, and both challengers are level at 20% -- so §5.4's circle decides,
     and the decision must be the same whichever of them is the card-shaped one. */
  /* THE POOL'S 10% IS NOT DECORATION. A holds the President's 20% plus one ordinary 10%, so a 20% sale
     reaches the card A is about to be handed and is therefore V-7.2's half-sale -- legal only with a 10%
     already in the pool (S9-14, #1624). Without it this whole board is an illegal action rather than a
     tie-break case, which is exactly what the new gate says. */
  const start = (seating: readonly string[]) =>
    board(erie({ president: A, doubleAt: B, ipo: 20, pool: 10, holdings: [[C, 20], [B, 20], [A, 30]] }), { seating });

  it("crowns the challenger closest clockwise, whether they hold one 20% card or two 10%s", () => {
    // Seated A, B, C: B is one clockwise from A and wins -- the holder of the single 20% card.
    expect(only(apply(start(SEATS), SELL(ERIE_COMPANY_ID, 20), A)).president).toBe(B);
    // Seated A, C, B: C is now one clockwise and wins -- the holder of two 10%s. Same holdings, same cards.
    expect(only(apply(start([A, C, B, D]), SELL(ERIE_COMPANY_ID, 20), A)).president).toBe(C);
  });

  it("is not decided by the holdings order, which lists C first in both runs", () => {
    /* The discriminating pair: if the double's 20% were read as two 10%s, or if the array decided, the two
       lines above would give the same answer. */
    const asListed = only(start(SEATS)).player_holdings.map((entry) => entry.player);
    expect(asListed).toEqual([C, B, A]);
    expect(only(apply(start(SEATS), SELL(ERIE_COMPANY_ID, 20), A)).president).not.toBe(asListed[0]);
  });

  it("leaves the crown alone when the sale only levels the incumbent with them", () => {
    // A sells 10%, lands on 20%, level with both. A tie is not an excess -- and the other 20% changes nothing.
    const after = apply(start(SEATS), SELL(ERIE_COMPANY_ID, 10), A);
    expect(held(after, A)).toBe(20);
    expect(only(after).president).toBe(A);
    expect(doubleCertificateAt(only(after))).toBe(B);
  });
});

describe("4. the special 20%-for-20% exchange (owner ruling 2026-09-17, S8-15)", () => {
  /* ERIE. A presides on the President's 20% and nothing else. B holds the printed other-20 plus ONE ordinary
     10% = 30% and exceeds A. B has no two 10%s to give, so the card that goes back is the other-20. */
  const special = (make: (over: Partial<DoubleCorp>) => DoubleCorp) =>
    board(make({ president: A, doubleAt: B, ipo: 50, holdings: [[B, 30], [A, 20]] }));

  it("is the shape the board is in, read off the successor's ORDINARY holding", () => {
    /* The criterion, asserted as the criterion rather than inferred from its effect -- and asserted against
       the case it is easy to confuse it with: 30% with the other-20 plus one 10% needs the card,
       30% as three ordinary 10%s does not. Same percentage, different exchange. */
    const withCard = only(special(erie));
    expect(ordinaryPercentHeld(withCard, B)).toBe(10);
    expect(needsDoubleForPresidencyExchange(withCard, B)).toBe(true);
    const withTens = only(board(erie({ president: A, doubleAt: "Ipo", ipo: 50, holdings: [[B, 30], [A, 20]] })));
    expect(ordinaryPercentHeld(withTens, B)).toBe(30);
    expect(needsDoubleForPresidencyExchange(withTens, B)).toBe(false);
    // And the 40% successor of §2, who has two 10%s and therefore takes the normal exchange.
    const withTwoTens = only(board(erie({ president: A, doubleAt: B, ipo: 40, holdings: [[B, 40], [A, 20]] })));
    expect(ordinaryPercentHeld(withTwoTens, B)).toBe(20);
    expect(needsDoubleForPresidencyExchange(withTwoTens, B)).toBe(false);
  });

  it("hands the other-20 to the former president and the President's 20% to the successor (ERIE)", () => {
    /* THE RULED CASE, in full. Every number the ruling names is asserted: who presides, who owns which card,
       that no percentage moved, both physical counts, and the inventory. */
    const before = special(erie);
    const after = settlePresidencies(before).state;

    expect(only(after).president).toBe(B);
    expect(doubleCertificateAt(only(after))).toBe(A); // the successor no longer owns it; the outgoing does
    expect(percentages(after)).toEqual(percentages(before)); // 20 / 30, untouched by the exchange
    expect(held(after, A)).toBe(20);
    expect(held(after, B)).toBe(30);
    expect(certificateCardsHeld(only(after), A)).toBe(1); // the other-20, one card for 20%
    expect(certificateCardsHeld(only(after), B)).toBe(2); // the President's 20% plus the 10% B kept
    expect(cards(after)).toBe(8); // eight before, eight after -- no phantom ninth
    expect(cards(before)).toBe(8);
    // Exactly one President's Certificate and exactly one other-20, and they are not in the same hand.
    expect(doubleCertificateAt(only(after))).not.toBe(only(after).president);
  });

  it("does it for the N&W on the same code path (§12's standing regression)", () => {
    const before = special(nw);
    const after = settlePresidencies(before).state;
    expect(only(after).president).toBe(B);
    expect(doubleCertificateAt(only(after))).toBe(A);
    expect(percentages(after)).toEqual(percentages(before));
    expect(certificateCardsHeld(only(after), A)).toBe(1);
    expect(certificateCardsHeld(only(after), B)).toBe(2);
    expect(cards(after)).toBe(8);
  });

  it("leaves the other-20 alone when the successor has two ordinary 10%s (the ruling's second example)", () => {
    /* Outgoing on President 20 + a 10% = 30, successor on other-20 + two 10%s = 40. Normal exchange; the
       other-20 does not move; the outgoing president ends on three ordinary 10%s. */
    const before = board(erie({ president: A, doubleAt: B, ipo: 30, holdings: [[B, 40], [A, 30]] }));
    const after = settlePresidencies(before).state;
    expect(only(after).president).toBe(B);
    expect(doubleCertificateAt(only(after))).toBe(B); // retained
    expect(percentages(after)).toEqual(percentages(before));
    expect(certificateCardsHeld(only(after), A)).toBe(3); // three ordinary 10%s
    expect(certificateCardsHeld(only(after), B)).toBe(2); // President's 20% + the other-20
    expect(cards(after)).toBe(8);
  });

  it("leaves it alone when the successor does not own it at all", () => {
    /* The printed-game shape, on a Scenario-D corporation: the other-20 sits in the IPO and the exchange is
       #596a's, untouched by this slice. */
    const before = board(erie({ president: A, doubleAt: "Ipo", ipo: 50, holdings: [[B, 30], [A, 20]] }));
    const after = settlePresidencies(before).state;
    expect(only(after).president).toBe(B);
    expect(doubleCertificateAt(only(after))).toBe("Ipo");
    expect(only(after).double_certificate).toEqual({ at: "Ipo" });
    expect(percentages(after)).toEqual(percentages(before));
    expect(cards(after)).toBe(8);
  });

  it("changes no card identity when the crown does not move", () => {
    /* The tie: the other-20 holder level with the incumbent at 20 v 20. No transfer, so no exchange, so
       nothing about either card moves -- and `settlePresidencies` still returns the same object. */
    const before = board(erie({ president: A, doubleAt: B, ipo: 60, holdings: [[B, 20], [A, 20]] }));
    expect(settlePresidencies(before).state).toBe(before);
    expect(doubleCertificateAt(only(before))).toBe(B);
    expect(only(before).president).toBe(A);
  });

  it("selects by seat and then exchanges by card, and the two decisions do not interfere", () => {
    /* §5.4's two halves in one dispatch. A on 30% sells 20% and drops to 10%; B (other-20, 20%) and C (two
       10%s, 20%) are tied challengers, so the CIRCLE picks -- and then whether the other-20 moves depends on
       WHICH of them it picked, because only B holds it. Reseat and both answers change together.
       A IS BELOW 20% HERE, so A cannot hold a 20% card: the printed sequence for this turn is
       exchange-then-sell -- A took the other-20 and sold it, half of it against the 10% the pool already
       held (S9-14, #1624, which is why this board carries one), so the card is in the Bank Pool with the
       percentage A sold (#1622's second destination). */
    const start = (seating: readonly string[]) =>
      board(erie({ president: A, doubleAt: B, ipo: 20, pool: 10, holdings: [[C, 20], [B, 20], [A, 30]] }), { seating });

    const toB = apply(start(SEATS), SELL(ERIE_COMPANY_ID, 20), A);
    expect(only(toB).president).toBe(B);
    expect(doubleCertificateAt(only(toB))).toBe("Bank");
    expect(certificateCardsHeld(only(toB), B)).toBe(1); // the President's 20% alone
    expect(certificateCardsHeld(only(toB), A)).toBe(1); // the 10% A kept
    expect(certificateCardsInPool(only(toB), "Bank")).toBe(2); // the other-20 plus the ordinary 10% A also sold
    expect(cards(toB)).toBe(8);

    // Seated A, C, B: C wins, C does not hold the other-20, so the exchange is the ordinary one and the card
    // stays with B untouched.
    const toC = apply(start([A, C, B, D]), SELL(ERIE_COMPANY_ID, 20), A);
    expect(only(toC).president).toBe(C);
    expect(doubleCertificateAt(only(toC))).toBe(B);
    expect(cards(toC)).toBe(8);
  });
});

describe("5. the special exchange through real reducer paths", () => {
  it("BuyStock: the other-20 holder buys one 10%, takes the crown and hands the card back in one dispatch", () => {
    /* THE INTEGRATION THE RULING ASKS FOR. ERIE parred; A presides on the President's 20%; B holds the
       other-20 at 20%; B buys one ordinary 10% from the IPO, reaches 30% and exceeds A. One message. */
    const before = board(erie({ president: A, doubleAt: B, ipo: 60, holdings: [[B, 20], [A, 20]] }));
    expect(cards(before)).toBe(8);
    const after = apply(before, BUY(ERIE_COMPANY_ID), B);

    expect(only(after).president).toBe(B);
    expect(doubleCertificateAt(only(after))).toBe(A);
    /* The ONLY percentage that moved is the 10% actually bought -- the exchange moved none of it. */
    expect(held(after, B)).toBe(30);
    expect(held(after, A)).toBe(20);
    expect(only(after).ipo_pool_percentage).toBe(50);
    expect(certificateCardsHeld(only(after), A)).toBe(1); // the other-20
    expect(certificateCardsHeld(only(after), B)).toBe(2); // the President's 20% plus the bought 10%
    expect(certificateCardsInPool(only(after), "Ipo")).toBe(5); // five ordinary 10%s left
    expect(cards(after)).toBe(8); // no phantom card anywhere on the board
  });

  it("SellStock: the incumbent sells down to the block and the successor pays with the card", () => {
    /* A naturally legal sale, no contortion: A presides on the President's 20% plus two 10%s (40%) and sells
       the two 10%s, landing ON the block at 20% -- always legal, no successor condition. B holds the other-20
       plus one 10% (30%) and now exceeds A, with no two 10%s to hand back, so the other-20 goes to A, who is
       on exactly 20% and can hold it. */
    const before = board(erie({ president: A, doubleAt: B, ipo: 30, holdings: [[B, 30], [A, 40]] }));
    expect(cards(before)).toBe(8);
    expect(shareSaleBlock({ state: before, seller: A, companyId: ERIE_COMPANY_ID, percentage: 20 })).toBeNull();
    const after = apply(before, SELL(ERIE_COMPANY_ID, 20), A);

    expect(held(after, A)).toBe(20);
    expect(held(after, B)).toBe(30);
    expect(only(after).bank_pool_percentage).toBe(20);
    expect(only(after).president).toBe(B);
    expect(doubleCertificateAt(only(after))).toBe(A);
    expect(certificateCardsHeld(only(after), A)).toBe(1); // the other-20
    expect(certificateCardsHeld(only(after), B)).toBe(2); // the President's 20% plus B's own 10%
    expect(certificateCardsInPool(only(after), "Bank")).toBe(2); // the two 10%s A sold
    expect(cards(after)).toBe(8);
  });
});

describe("5a. the forced-sale projection still answers WHO, and only WHO", () => {
  it("predicts the same successor the settlement crowns, on the board where the card also moves", () => {
    /* THE AUDIT (ruling item 10), asserted rather than argued. `presidentAfterSale` builds the board the sale
       would leave and asks `presidentFor` -- selection only. #1622 put the CARD half in the settlement, so
       the projection is untouched by it and cannot drift: the successor it names on a Scenario-D board is the
       successor `settlePresidencies` crowns there, special exchange and all. */
    const before = board(erie({ president: A, doubleAt: B, ipo: 30, holdings: [[B, 30], [A, 40]] }));
    const predicted = presidentAfterSale(only(before), A, 20, before.player_addresses);
    const settled = only(apply(before, SELL(ERIE_COMPANY_ID, 20), A));
    expect(predicted).toBe(B);
    expect(settled.president).toBe(B);
    expect(predicted).toBe(settled.president);
    /* And the projection moved nothing: a predictor that settled a certificate would have changed the board
       it was only judging. */
    expect(doubleCertificateAt(only(before))).toBe(B);
    expect(only(before).double_certificate).toEqual({ at: B });
  });

  it("still refuses a forced sale of the RESCUED corporation whose crown would move (6.6.3), unchanged", () => {
    /* No forced-sale legality reads the post-transfer card decomposition: the shortfall is cash, treasury and
       the train's price; `shareSaleBlock` asks `doubleSaleRefusal` of the SELLER's own pre-sale cards; and
       "only enough" is price x `certificatesIn(percentage)`, a bundle arithmetic that never consults card
       identity. So `emergencyFunding.ts` needed no change for S8-15 and got none beyond S8-2's roster
       parameter -- the module's own #1540 note already said the double certificate "happens exactly as in a
       Stock Round, because it is the same arm". */
    const state = board(erie({ president: A, doubleAt: B, ipo: 30, holdings: [[B, 30], [A, 40]] }));
    const funding = { companyId: ERIE_COMPANY_ID, ticker: "ERIE", president: A, shortfall: 100 };
    expect(forcedSaleRefusal(state, funding, A, ERIE_COMPANY_ID, 20)).toMatch(
      /would hand its presidency to another player/,
    );
    // A 10% bundle leaves A on 30%, still ahead of B: legal, and the crown stays.
    expect(forcedSaleRefusal(state, funding, A, ERIE_COMPANY_ID, 10)).toBeNull();
    const after = apply(state, SELL(ERIE_COMPANY_ID, 10), A);
    expect(only(after).president).toBe(A);
    expect(doubleCertificateAt(only(after))).toBe(B);
    expect(cards(after)).toBe(8);
  });
});

describe("6. S9-14: the half-sale prerequisite of a card the seller does not hold yet", () => {
  /* ==================================================================
      OWNER RULING 2026-09-17 (S9-14 absorbed into Slice 8.3)
     ==================================================================
     "V-7.2 requires the 10% exchange certificate to have been in the Bank Pool before a half-sale of the
     other-20. A president who must first receive that other-20 during a presidency transfer is subject to the
     same requirement. The current sale cannot supply its own prerequisite."

     THE CANONICAL BOARD, used by every case here: A presides on the President's 20% and holds nothing else;
     B's only certificate is the printed other-20, also 20%. They are TIED, so A is still president -- and the
     moment A announces a sale, the announced sale is what moves the crown, so the exchange happens first and
     A is the one holding a 20% card when the sale completes. */
  it("A. refuses the 10% sale when the Bank Pool holds no ordinary 10% -- before any mutation", () => {
    /* THE CASE THE ENGINE USED TO ALLOW. The refusal reads the PRE-SALE pool: the 10% this very sale would
       put there is not the prerequisite, which is the whole content of the ruling. */
    const before = ERIE_TIE(0);
    expect(cards(before)).toBe(8);
    const refusal = shareSaleBlock({ state: before, seller: A, companyId: ERIE_COMPANY_ID, percentage: 10 });
    expect(refusal).toMatch(/needs a 10% share already in the Bank Pool/);
    expect(refusal).toMatch(/Sell the whole 20% instead/);

    /* I. NOTHING MOVED -- and "nothing" means the chart too. `stockSaleRefusal` asks `shareSaleBlock`, the
       chart step's `saleRefused` asks `stockSaleRefusal`, and that runs BEFORE the token walks (S8-13), so
       one refusal covers holdings, pools, the presidency, the card identity and `market_positions`. */
    const after = apply(before, SELL(ERIE_COMPANY_ID, 10), A);
    expect(stateDigest(after)).toBe(stateDigest(before));
    expect(only(after).president).toBe(A);
    expect(held(after, A)).toBe(20);
    expect(only(after).bank_pool_percentage).toBe(0);
    expect(doubleCertificateAt(only(after))).toBe(B);
    expect(after.market_positions).toEqual(before.market_positions);
  });

  it("B. allows it when an ordinary 10% was ALREADY in the pool, and settles the printed result", () => {
    /* The same sale, one pre-existing 10% certificate later. The half-sale then has something to exchange
       against, and the ruling's physical result is what the board shows: B takes the President's 20%, A takes
       the other-20 and immediately trades it for the pool's 10%, so the pool ends holding the other-20 and A
       ends holding that ordinary 10%. */
    const before = ERIE_TIE(10);
    expect(cards(before)).toBe(8);
    expect(shareSaleBlock({ state: before, seller: A, companyId: ERIE_COMPANY_ID, percentage: 10 })).toBeNull();
    const after = apply(before, SELL(ERIE_COMPANY_ID, 10), A);

    expect(only(after).president).toBe(B);
    expect(held(after, A)).toBe(10);
    expect(held(after, B)).toBe(20);
    expect(only(after).bank_pool_percentage).toBe(20); // 10 out, the 20% card in
    expect(doubleCertificateAt(only(after))).toBe("Bank");
    expect(certificateCardsHeld(only(after), A)).toBe(1); // the ordinary 10% taken out of the pool
    expect(certificateCardsHeld(only(after), B)).toBe(1); // the President's 20% alone
    expect(certificateCardsInPool(only(after), "Bank")).toBe(1); // the other-20, one card for the pool's 20%
    expect(certificateCardsInPool(only(after), "Ipo")).toBe(5);
    expect(cards(after)).toBe(8);
  });

  it("C. never blocks the WHOLE 20% sale, which needs no prerequisite", () => {
    /* Do not overblock. Selling the entire returned 20% is a block sale, not a half-sale: the card goes to
       the pool as one certificate and V-7.2 has nothing to say. Only the ordinary pool cap applies. */
    const before = ERIE_TIE(0);
    expect(shareSaleBlock({ state: before, seller: A, companyId: ERIE_COMPANY_ID, percentage: 20 })).toBeNull();
    const after = apply(before, SELL(ERIE_COMPANY_ID, 20), A);

    expect(only(after).president).toBe(B);
    expect(held(after, A)).toBe(0);
    expect(held(after, B)).toBe(20);
    expect(only(after).bank_pool_percentage).toBe(20);
    expect(doubleCertificateAt(only(after))).toBe("Bank");
    expect(certificateCardsHeld(only(after), B)).toBe(1);
    expect(certificateCardsInPool(only(after), "Bank")).toBe(1);
    expect(cards(after)).toBe(8);
  });

  it("D. never blocks a sale that does not reach the card, and the card then stays with the former president", () => {
    /* Do not overblock, the other way. A on President 20 + one ordinary 10% sells the ORDINARY 10% and lands
       on 20%; B on other-20 + one 10% (30%) then exceeds A. The sale is A's own 10% card, so no half-sale
       arises and no pool 10% is needed -- and because A is still on 20%, A can hold the returned card. */
    const before = board(erie({ president: A, doubleAt: B, ipo: 40, holdings: [[B, 30], [A, 30]] }));
    expect(only(before).bank_pool_percentage).toBe(0);
    expect(shareSaleBlock({ state: before, seller: A, companyId: ERIE_COMPANY_ID, percentage: 10 })).toBeNull();
    const after = apply(before, SELL(ERIE_COMPANY_ID, 10), A);

    expect(only(after).president).toBe(B);
    expect(held(after, A)).toBe(20);
    expect(held(after, B)).toBe(30);
    expect(only(after).bank_pool_percentage).toBe(10); // the ordinary 10% A announced
    expect(doubleCertificateAt(only(after))).toBe(A); // retained by the former president, not pooled
    expect(certificateCardsHeld(only(after), A)).toBe(1); // the other-20
    expect(certificateCardsHeld(only(after), B)).toBe(2); // the President's 20% plus B's own 10%
    expect(cards(after)).toBe(8);
  });

  it("E. is a SELL condition: the buy path that reaches the same exchange stays legal on an empty pool", () => {
    /* A challenger buying to exceed the president performs no sale and no half-sale, so V-7.2 has no standing
       there. The S8-15 `BuyStock` result is asserted again with the pool explicitly empty, because that is
       the board an over-broad refusal would have broken. */
    const before = board(erie({ president: A, doubleAt: B, ipo: 60, holdings: [[B, 20], [A, 20]] }));
    expect(only(before).bank_pool_percentage).toBe(0);
    const after = apply(before, BUY(ERIE_COMPANY_ID), B);
    expect(only(after).president).toBe(B);
    expect(held(after, B)).toBe(30);
    expect(doubleCertificateAt(only(after))).toBe(A);
    expect(only(after).bank_pool_percentage).toBe(0);
    expect(cards(after)).toBe(8);
  });

  it("F. does not fire on a corporation that prints no other-20", () => {
    /* The printed game's eight, and the regression that matters most: the new condition must be invisible
       wherever there is no second 20% card. Same ownership shape, no `double_certificate` -- the president
       sells 10% under the block with a 20% successor, exactly as before this slice. */
    const before = board(erie({ president: A, doubleAt: null, ipo: 60, holdings: [[B, 20], [A, 20]] }));
    expect(only(before).double_certificate).toBeUndefined();
    expect(shareSaleBlock({ state: before, seller: A, companyId: ERIE_COMPANY_ID, percentage: 10 })).toBeNull();
    const after = apply(before, SELL(ERIE_COMPANY_ID, 10), A);
    expect(only(after).president).toBe(B);
    expect(held(after, A)).toBe(10);
    expect(only(after).bank_pool_percentage).toBe(10);
  });

  it("G. holds for the N&W on the same code path -- refused empty, allowed with the pool's 10%", () => {
    expect(
      shareSaleBlock({ state: NW_TIE(0), seller: A, companyId: NW_COMPANY_ID, percentage: 10 }),
    ).toMatch(/needs a 10% share already in the Bank Pool/);
    expect(shareSaleBlock({ state: NW_TIE(10), seller: A, companyId: NW_COMPANY_ID, percentage: 10 })).toBeNull();
    const after = apply(NW_TIE(10), SELL(NW_COMPANY_ID, 10), A);
    expect(only(after).president).toBe(B);
    expect(doubleCertificateAt(only(after))).toBe("Bank");
    expect(held(after, A)).toBe(10);
    expect(cards(after)).toBe(8);
  });

  it("H. reaches the ingress with the same reason, from the same function", () => {
    /* One implementation, two locks (#1174's rule). `stockSaleRefusal` asks `shareSaleBlock` and the ingress
       asks `stockSaleRefusal`, so the sentence the player is shown before the click is the sentence the
       reducer would have refused with -- no second S9-14 anywhere. */
    const before = ERIE_TIE(0);
    const ingress = turnRefusal({
      state: before,
      waterfall: null,
      actor: A,
      msg: SELL(ERIE_COMPANY_ID, 10) as never,
      mapGrid: undefined,
    });
    expect(ingress).toMatch(/needs a 10% share already in the Bank Pool/);
    expect(ingress).toBe(shareSaleBlock({ state: before, seller: A, companyId: ERIE_COMPANY_ID, percentage: 10 }));
    // And the legal one is legal at both locks.
    expect(
      turnRefusal({
        state: ERIE_TIE(10),
        waterfall: null,
        actor: A,
        msg: SELL(ERIE_COMPANY_ID, 10) as never,
        mapGrid: undefined,
      }),
    ).toBeNull();
  });
});

describe("7. every accepted action has a destination for the other-20 (exhaustiveness)", () => {
  it("leaves the do-nothing fallback unreachable through reducer authority", () => {
    /* #1622's third arm -- move the card nowhere -- exists for a hand-built fixture and must not be reachable
       by an accepted action, or an accepted action would settle an impossible board.
       THE ENUMERATION, over an accepted sale by a president whose crown moves to a successor who needs the
       card. `ordinary` is the seller's own 10%s and the sale takes those first (#1324):
         percentage <= ordinary            -> the card is untouched; the seller ends on 20% or more, so THEY
                                              hold it (case D);
         percentage - ordinary >= 20       -> the whole card is sold; the pool gains at least 20, so the POOL
                                              holds it (case C);
         percentage - ordinary == 10       -> the half-sale, now legal only with a pre-existing pool 10% (S9-14),
                                              and the pool then ends at 20 or more, so the POOL holds it (case B).
       The only shape that left neither able to hold a 20% card was the third one WITHOUT the prerequisite,
       and that action is now refused rather than settled. On the buy side the outgoing president's holding is
       untouched by the buyer, and a president always holds the 20% certificate, so they can always take the
       card (case E). Asserted here as the property rather than argued: across the reachable matrix, every
       accepted action leaves the card with a holder whose percentage can carry it. */
    const shapes: Array<{ what: string; state: GameStateResponse; msg: unknown; actor: string }> = [
      { what: "D: sale under the card", state: board(erie({ president: A, doubleAt: B, ipo: 40, holdings: [[B, 30], [A, 30]] })), msg: SELL(ERIE_COMPANY_ID, 10), actor: A },
      { what: "C: whole card sold", state: ERIE_TIE(0), msg: SELL(ERIE_COMPANY_ID, 20), actor: A },
      { what: "B: half-sale with the pool's 10%", state: ERIE_TIE(10), msg: SELL(ERIE_COMPANY_ID, 10), actor: A },
      { what: "E: buy to exceed", state: board(erie({ president: A, doubleAt: B, ipo: 60, holdings: [[B, 20], [A, 20]] })), msg: BUY(ERIE_COMPANY_ID), actor: B },
      { what: "ordinary exchange, card retained", state: board(erie({ president: A, doubleAt: B, ipo: 30, holdings: [[B, 40], [A, 30]] })), msg: SELL(ERIE_COMPANY_ID, 10), actor: A },
    ];
    for (const shape of shapes) {
      const after = apply(shape.state, shape.msg, shape.actor);
      expect(stateDigest(after)).not.toBe(stateDigest(shape.state)); // the action was ACCEPTED
      const company = only(after);
      const at = doubleCertificateAt(company);
      expect(at).not.toBeNull();
      /* Wherever it landed, that holder's percentage can carry a 20% card -- which is the invariant the
         do-nothing arm would have broken. */
      const carrying =
        at === "Bank"
          ? company.bank_pool_percentage
          : at === "Ipo"
            ? company.ipo_pool_percentage
            : (company.player_holdings.find((entry) => entry.player === at)?.percentage ?? 0);
      /* 20 for the other-20 itself, and 40 where the holder is the president -- a player may hold the
         other-20 BESIDE the President's Certificate (#1324), and the 40% successor of §2 does exactly that,
         so the two cards together must still fit inside their percentage. */
      expect(carrying).toBeGreaterThanOrEqual(at === company.president ? 40 : 20);
      expect(cards(after)).toBe(8);
    }
  });
});
