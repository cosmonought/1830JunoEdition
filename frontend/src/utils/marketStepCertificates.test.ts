/** @jest-environment node */
//
// The stock market walks one row per PHYSICAL CERTIFICATE sold, not one row per 10% of ownership -- S9-13.
//
// ==================================================================
//  DESIGN NOTE 1650 (harness): ONE CARD, ONE STEP
// ==================================================================
//
// FILED (Slice 8.3, left open by the owner's 2026-09-17 ruling on S9-14; `RULES_HARDENING_BACKLOG.md` S9-13):
// "the chart walks one row per 10%, not per certificate, so the LPF other-20 sold as a block drops the token
// twice." The proceeds were already right (`certificatesIn`/`saleProceeds`, #1324) -- this is the chart step
// alone, and the fix reuses the same ordinary/double split `doubleSaleEffect` and `ordinaryPercentHeld`
// already read (`certificatesSoldInMarketMove`, `doubleCertificate.ts`) rather than inventing a second
// certificate model.
//
// THREE SHAPES, ONE MESSAGE EACH: an ordinary 10% certificate (one card, one step -- unchanged), the printed
// non-president 20% sold as a whole block (one card, one step -- the fix), and two ordinary 10% certificates
// sold together (two cards, two steps -- unchanged, and the check that the fix did not flatten every sale to
// one step). Proceeds and the Bank Pool's own certificate count are asserted alongside the chart on each one,
// because the whole point of #1650 is that these numbers can now disagree and must be asserted separately.
//
// PRESIDENCY IS NOT RE-TESTED HERE. `presidencyLpf.test.ts` already drives `SellStock` through this same
// reducer and chart atom for the S8-15 / S9-14 exchange shapes; this file changes nothing that suite reads
// (`presidentAfterSale`, `needsDoubleForPresidencyExchange`), so re-running it is the regression proof for
// "existing presidency behavior is unchanged" rather than a duplicate of it here.

export {};

const { applySandboxAction } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { certificateCardsInPool, doubleCertificateAt } =
  require("../gameEngine/doubleCertificate") as typeof import("../gameEngine/doubleCertificate");
const { ERIE_COMPANY_ID } =
  require("../gameEngine/levelPlayingField") as typeof import("../gameEngine/levelPlayingField");
const { marketZoneForPrice, parBoxCellFor, projectShareSaleMove } =
  require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const A = "p-a";
const B = "p-b";
const SEATS = [A, B] as const;
const PAR_100_CELL = parBoxCellFor(100) ?? { x: 2, y: 3 };
const PAR_100_PRICE = 100;

interface DoubleCorp {
  president: string | null;
  doubleAt: string | null;
  ipo: number;
  pool: number;
  holdings: ReadonlyArray<readonly [string, number]>;
}

/** A Stock Round board carrying one Scenario-D corporation (ERIE), parred at $100 -- the same shape
 *  `presidencyLpf.test.ts`'s `board()` uses, already proven to carry real `SellStock` traffic through the
 *  actual reducer and chart atom together. */
function board(corp: DoubleCorp): GameStateResponse {
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
    player_addresses: [...SEATS],
    player_cash: SEATS.map((player) => ({ player, cash_vgp: "2000" })),
    virtual_bank_vgp: "9000",
    private_companies: [],
    market_positions: { [ERIE_COMPANY_ID]: { price: PAR_100_PRICE, ...PAR_100_CELL, enteredAt: ERIE_COMPANY_ID } },
    public_companies: [
      {
        company_id: ERIE_COMPANY_ID,
        ticker: "ERIE",
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

const ctxFor = (state: GameStateResponse, actor: string) => {
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
      projectSale: (from: { x: number; y: number; price: number }, blocks: number) =>
        projectShareSaleMove(from, blocks),
    },
  };
};

const sell = (state: GameStateResponse, percentage: number, actor: string) =>
  applySandboxAction(
    state,
    { SellStock: { game_id: 0, protocol_id: ERIE_COMPANY_ID, percentage } } as never,
    ctxFor(state, actor) as never,
  );

const only = (state: GameStateResponse) => state.public_companies[0];
const mark = (state: GameStateResponse) => state.market_positions![ERIE_COMPANY_ID];
const cashOf = (state: GameStateResponse, player: string) =>
  Number(state.player_cash.find((entry) => entry.player === player)!.cash_vgp);

describe("S9-13: the chart walks one row per certificate, not per 10%", () => {
  it("one ordinary 10% certificate: one market step", () => {
    const before = board({ president: B, doubleAt: null, ipo: 70, pool: 0, holdings: [[B, 20], [A, 10]] });
    const expected = projectShareSaleMove(PAR_100_CELL, 1);

    const after = sell(before, 10, A);

    expect(mark(after)).toMatchObject(expected as object);
    expect(certificateCardsInPool(only(after), "Bank")).toBe(1);
  });

  it("one non-president 20% certificate sold as a whole block: ONE market step, not two", () => {
    const before = board({ president: B, doubleAt: A, ipo: 60, pool: 0, holdings: [[B, 20], [A, 20]] });
    const oneStep = projectShareSaleMove(PAR_100_CELL, 1);
    const twoSteps = projectShareSaleMove(PAR_100_CELL, 2);

    const after = sell(before, 20, A);

    expect(mark(after)).toMatchObject(oneStep as object);
    expect(mark(after)).not.toMatchObject(twoSteps as object);
    // The other-20 is ONE physical certificate: the Bank Pool gained exactly one card, not two.
    expect(doubleCertificateAt(only(after))).toBe("Bank");
    expect(certificateCardsInPool(only(after), "Bank")).toBe(1);
    expect(only(after).player_holdings.find((entry) => entry.player === A)?.percentage ?? 0).toBe(0);
  });

  it("two separate ordinary 10% certificates: TWO market steps", () => {
    const before = board({ president: B, doubleAt: null, ipo: 60, pool: 0, holdings: [[B, 20], [A, 20]] });
    const twoSteps = projectShareSaleMove(PAR_100_CELL, 2);

    const after = sell(before, 20, A);

    expect(mark(after)).toMatchObject(twoSteps as object);
    expect(certificateCardsInPool(only(after), "Bank")).toBe(2);
  });

  it("proceeds remain percentage-correct regardless of the certificate count behind them", () => {
    const singleBoard = board({ president: B, doubleAt: null, ipo: 70, pool: 0, holdings: [[B, 20], [A, 10]] });
    const blockBoard = board({ president: B, doubleAt: A, ipo: 60, pool: 0, holdings: [[B, 20], [A, 20]] });
    const singleCashBefore = cashOf(singleBoard, A);
    const blockCashBefore = cashOf(blockBoard, A);

    const afterSingle = sell(singleBoard, 10, A);
    const afterBlock = sell(blockBoard, 20, A);

    const singleProceeds = cashOf(afterSingle, A) - singleCashBefore;
    const blockProceeds = cashOf(afterBlock, A) - blockCashBefore;

    // The 20% block is worth exactly twice the 10% sale, whichever physical card carried it -- proceeds are
    // untouched by the chart-step fix (S9-13's note: "The PROCEEDS are already right").
    expect(singleProceeds).toBe(PAR_100_PRICE * 1);
    expect(blockProceeds).toBe(PAR_100_PRICE * 2);
    expect(blockProceeds).toBe(singleProceeds * 2);
  });
});
