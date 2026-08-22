/** @jest-environment node */
//
// When a zone exemption expires. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 759 (harness): THE EXEMPTIONS WERE BUILT, THE EXPIRY WAS NOT
// ==================================================================
//
// REPORTED: "I don't think we have encoded rules for what a player must do when they purchased
// Yellow/Orange/Brown zone stocks and exceeded their certificate and/or corporation limits and then those
// corporation share prices move out of those zones."
//
// #7 AND #712 ARE BOTH CORRECT AND BOTH STOP AT THE PURCHASE. #7's own note describes the gap without
// noticing it: a zone is "a MARKET-POSITION rule, not an ownership one: the same certificate counts today and
// stops counting tomorrow if the price moves, with nothing about the certificate changing." That sentence
// describes an obligation and stops one clause short of saying who owes it.
//
// TWO OF THE THREE RULES ARE ENFORCED BY NOT DOING ANYTHING, which is what most of this file is about.
// Retention (i) and game-end scoring (ii) need no code -- they need the debt to be silent outside a Stock
// Round and invisible to the endgame. Tests for "nothing happens" are the ones a later refactor deletes as
// pointless, so each says which rule it is keeping alive.

import { divestmentDebt, divestmentRefusal, minimumCertificatesToSell } from "./forcedDivestment";
import { sharePurchaseBlock } from "./sharePurchase";
import { autoPassDecision } from "./autoPass";
import { rankPlayers } from "./endgame";
import type { GameStateResponse } from "./gameState";

const PRR = 1;
const BO = 2;
const ME = "me";

/* THE THREE ZONES DO NOT WAIVE THE SAME THINGS, and my first fixture got this wrong -- it put the exempt
   corporation in YELLOW and the tests failed, correctly. #712's rule is that the 60% holding cap is waived in
   ORANGE and BROWN only; Yellow waives the CERTIFICATE LIMIT (#7) and nothing else. So a Yellow corporation a
   player holds 80% of is over the cap right now, exemption or no exemption.
   Kept as a three-way ladder rather than a boolean, because the distinction is the interesting part of this
   rule and a fixture that could not express it would have hidden the failure instead of finding it. */
const zoneForPrice = (price: number | null | undefined) => {
  if (price == null) return "Normal";
  if (price <= 30) return "Brown";
  if (price <= 60) return "Yellow";
  return "Normal";
};

function board(over: Record<string, unknown> = {}): GameStateResponse {
  return {
    player_addresses: [ME, "rival"],
    player_cash: [
      { player: ME, cash_vgp: "500" },
      { player: "rival", cash_vgp: "500" },
    ],
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 4,
    active_player_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: true,
        president: ME,
        par_value: "100",
        ipo_pool_percentage: 0,
        bank_pool_percentage: 20,
        treasury: "0",
        player_holdings: [{ player: ME, percentage: 80 }],
        station_token_hexes: [],
      },
      {
        company_id: BO,
        ticker: "B&O",
        is_floated: true,
        president: "rival",
        par_value: "100",
        ipo_pool_percentage: 40,
        bank_pool_percentage: 0,
        treasury: "0",
        player_holdings: [
          { player: "rival", percentage: 40 },
          { player: ME, percentage: 20 },
        ],
        station_token_hexes: [],
      },
    ],
    ...over,
  } as unknown as GameStateResponse;
}

/* TYPED, NOT INFERRED. `{ [PRR]: 20 }` infers `{ 1: number }`, which cannot be indexed by a `number` under
   `noImplicitAny` -- and the failure surfaces only where the value is passed somewhere that indexes it
   loosely, which is why every other use of these two constants compiled fine and `rankPlayers` did not. */
const cheap: Record<number, number> = { [PRR]: 20, [BO]: 20 };
const dear: Record<number, number> = { [PRR]: 100, [BO]: 100 };

const debtFor = (
  state: GameStateResponse,
  marketPrices: Record<number, number>,
) => divestmentDebt({ state, player: ME, marketPrices, zoneForPrice });

describe("the debt appears when the price leaves the zone", () => {
  it("says nothing while the shares are still exempt", () => {
    /* 80% of PRR is over the 60% cap, and it is LEGAL while the price sits in the zone -- #712's waiver. The
       debt must not fire on a holding the rules currently permit. */
    expect(debtFor(board(), cheap).owed).toBe(false);
  });

  it("names the 60% cap once the price climbs out", () => {
    const debt = debtFor(board(), dear);
    expect(debt.overCapCompanies).toEqual([
      expect.objectContaining({ ticker: "PRR", percentage: 80 }),
    ]);
    expect(debt.owed).toBe(true);
  });

  it("explains that the shares MOVED rather than accusing the purchase", () => {
    /* This arrives without the player doing anything -- a price moved while they were not looking and a
       holding that was legal all game became illegal between rounds. "You are over the limit" would read as
       an accusation about a purchase they were allowed to make. */
    const refusal = divestmentRefusal(debtFor(board(), dear));
    expect(refusal).toMatch(/left the Yellow\/Orange\/Brown zones/);
    expect(refusal).toMatch(/20% over the 60% cap in PRR \(80% held\)/);
    expect(refusal).toMatch(/Sell down before buying or passing/);
  });

  it("says nothing at all when nothing is owed", () => {
    expect(divestmentRefusal(debtFor(board(), cheap))).toBeNull();
  });
});

describe("rule (i): the shares are kept until the next Stock Round", () => {
  it("owes nothing during an Operating Round", () => {
    /* THE WHOLE OF RULE (i), and it is enforced by the question not being asked. A price that climbs out of
       the zone during an Operating Round costs the holder nothing until the next Stock Round opens. */
    expect(debtFor(board({ current_round_type: "OperatingRound" }), dear).owed).toBe(false);
  });

  it("owes nothing during the Waterfall Auction either", () => {
    expect(debtFor(board({ current_round_type: "WaterfallAuction" }), dear).owed).toBe(false);
  });

  it("covers the end-of-round rise for free", () => {
    /* The report's parenthetical: "even if the share price moved out of the zone as a result of the 'move up'
       action that happens at the very end of a stock round". #746's rise fires as the round CLOSES, and the
       reducer turns that straight into an Operating Round -- so the board is never a Stock Round while that
       price move is the newest thing that happened. Nothing special was needed. */
    const closing = board({ current_round_type: "OperatingRound" });
    expect(debtFor(closing, dear).owed).toBe(false);
    expect(debtFor(board(), dear).owed).toBe(true);
  });
});

describe("rule (ii): a game that ends first keeps the shares", () => {
  it("counts every certificate in net worth", () => {
    /* ENFORCED BY NOT DOING ANYTHING, and worth a test precisely because "must sell down" invites a reader to
       add a liquidation to the endgame path. A game that ends before the next Stock Round ends with those
       shares owned and scored. */
    const ranked = rankPlayers({
      state: board(),
      priceForCompany: (companyId: number) => dear[companyId] ?? null,
      labelForAddress: (address: string) => address,
    } as never);
    const mine = ranked.find((entry: { address: string }) => entry.address === ME);
    // 80% of PRR at $100 plus 20% of B&O at $100, plus $500 cash.
    expect(mine?.netWorth).toBe(500 + 800 + 200);
  });
});

describe("rule (iii): three doors, held shut", () => {
  it("refuses a purchase", () => {
    const blocked = sharePurchaseBlock({
      state: board(),
      buyer: ME,
      companyId: BO,
      source: "Ipo",
      quantity: 1,
      zone: "Normal",
      marketPrices: dear,
      zoneForPrice,
    });
    expect(blocked).toMatch(/Sell down before buying or passing/);
  });

  it("allows the purchase while the exemption holds, which is the control", () => {
    expect(
      sharePurchaseBlock({
        state: board(),
        buyer: ME,
        companyId: BO,
        source: "Ipo",
        quantity: 1,
        zone: "Yellow",
        marketPrices: cheap,
        zoneForPrice,
      }),
    ).toBeNull();
  });

  it("refuses an auto-pass, and disarms rather than skipping one turn", () => {
    /* #717's rule about the presidency guarantee, applied here: a checkbox cannot consent to an outcome the
       rules forbid. And the debt persists until the player acts, so waking them once and re-arming would
       wake them again on the next seat and the one after. */
    const decision = autoPassDecision(board(), {
      player: ME,
      macroRoundNumber: 4,
      snapshot: {},
      divestmentOwed: true,
    } as never);
    expect(decision.pass).toBe(false);
    expect(decision.wakeReason).toMatch(/must sell down before passing/);
  });

  it("lets auto-pass run when nothing is owed", () => {
    const decision = autoPassDecision(board({ public_companies: [] }), {
      player: ME,
      macroRoundNumber: 4,
      snapshot: {},
      divestmentOwed: false,
    } as never);
    expect(decision.pass).toBe(true);
  });
});

describe("Yellow waives the certificate limit and not the 60% cap", () => {
  /* THE DISTINCTION MY OWN FIXTURE GOT WRONG, so it is pinned rather than left to the two constants. #7 is
     about how many CARDS you may hold in total; #712 is about how much of ONE corporation. Yellow answers the
     first and says nothing about the second. */
  const midPrice: Record<number, number> = { [PRR]: 50, [BO]: 50 };

  it("still owes the cap in Yellow", () => {
    const debt = debtFor(board(), midPrice);
    expect(debt.overCapCompanies).toEqual([
      expect.objectContaining({ ticker: "PRR", percentage: 80 }),
    ]);
  });

  it("does not owe the certificate limit in Yellow", () => {
    // Every card exempt, so `counted` is only whatever is not in a zone -- here, nothing.
    expect(debtFor(board(), midPrice).certificatesOver).toBe(0);
  });

  it("owes neither in Brown", () => {
    expect(debtFor(board(), cheap).owed).toBe(false);
  });
});

describe("the certificate limit is a separate debt from the cap", () => {
  it("counts certificates that stopped being exempt", () => {
    /* A player can be over one, the other, or both, and the sales that discharge them are not
       interchangeable -- selling a 10% of a corporation you hold 70% of fixes both, while selling your only
       share of some other corporation fixes the certificate limit alone. */
    const debt = debtFor(board(), dear);
    expect(debt.counted).toBeGreaterThan(0);
    expect(debt.certificateLimit).not.toBeNull();
  });

  it("reports a floor rather than an instruction", () => {
    /* Which shares to sell is the player's decision and the two debts overlap in ways only they can weigh, so
       the caption says how far there is to go rather than what to do. 80% down to 60% is two certificates. */
    expect(minimumCertificatesToSell(debtFor(board(), dear))).toBe(2);
    expect(minimumCertificatesToSell(debtFor(board(), cheap))).toBe(0);
  });
});

describe("the doors all ask one module", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // #490a: the notes quote #7's sentence and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("is asked by the purchase rules", () => {
    expect(read("utils/sharePurchase.ts")).toContain("divestmentDebt({ state, player: buyer");
  });

  it("is asked by the Pass button", () => {
    expect(read("App.tsx")).toContain("divestmentRefusal(");
  });

  it("is asked by auto-pass", () => {
    expect(read("utils/autoPass.ts")).toContain("if (arm.divestmentOwed === true)");
  });

  it("is never asked by the endgame", () => {
    /* Rule (ii) as a structural assertion: if `endgame.ts` ever imports this module, somebody has taught the
       final scoring to care about a debt the rules say expires unpaid. */
    expect(read("utils/endgame.ts")).not.toContain("forcedDivestment");
  });
});
