// frontend/src/utils/dividendProjection.test.ts
//
// ==================================================================
//  DESIGN NOTE 705 (harness): THE PAY COLUMN'S ARITHMETIC
// ==================================================================
//
// REPORTED: "it's hard to see in the Dividends phase how paying out affects players' personal cash ... the
// solution is looking at us on the Withhold side where we show the corporation's treasury with its current
// value to its new value ... I am reluctant to lose the actual payout amount, which going from current to new
// treasury will elide."
//
// The Pay column showed a delta with no anchor; the Withhold column had shown a before-and-after since #509a.
// So the fix is arithmetic, and the thing worth pinning is that the arithmetic AGREES WITH ITSELF -- three
// figures on one line invite two of them to drift.
//
// WHO IS PAID took three corrections to get right, and the reason is worth recording: every draft read the
// REDUCER as the rule, and the reducer had the two pools EXACTLY SWAPPED (#706) -- it paid the IPO's share
// into the treasury and let the bank pool's share stay with the bank. So "the code pays the IPO" was evidence
// for precisely the wrong conclusion, and each correction produced a new wrong answer instead of converging.
//
// 1830, verbatim: "Shares in the bank pool pay dividends to the corporate treasury. No payments are made for
// unsold initial offering shares."
//
// This file therefore asserts the RULE and not the arithmetic that happens to implement it: bank pool -> the
// corporation, IPO -> nobody, and a total that falls short of the revenue by exactly the unsold shares.

import {
  describeDividendRow,
  projectDividendPayouts,
  type DividendProjectionInput,
} from "./dividendProjection";

const CASH: Record<string, number> = {
  alice: 420,
  bob: 138,
  carol: 0,
};

function input(over: Partial<DividendProjectionInput> = {}): DividendProjectionInput {
  return {
    // 60/30 held by players, 10 in the bank pool -- and, implicitly, nothing left unsold.
    holdings: [
      { player: "alice", percentage: 60 },
      { player: "bob", percentage: 30 },
    ],
    bankPoolPercentage: 10,
    treasuryNow: 240,
    corporationLabel: "B&O",
    // A $180 route pays $18 a 10% share.
    perShare: 18,
    cashOf: (player) => CASH[player] ?? null,
    labelOf: (player) => player.toUpperCase(),
    ...over,
  };
}

describe("each row carries both ends of the move", () => {
  it("projects a holder's cash through their share", () => {
    const [alice] = projectDividendPayouts(input());
    expect(alice).toMatchObject({
      holder: "ALICE",
      percentage: 60,
      amount: 108,
      cashBefore: 420,
      cashAfter: 528,
    });
  });

  it("keeps the payout amount, which is the figure the decision turns on", () => {
    /* THE REPORT'S ONE RESERVATION: "I am reluctant to lose the actual payout amount, which going from current
       to new treasury will elide." A before-and-after alone would make the reader subtract. */
    for (const row of projectDividendPayouts(input())) {
      expect(row.amount).toBeGreaterThan(0);
    }
  });

  it("always lands on before plus amount", () => {
    // The invariant three numbers on one line exist to break.
    for (const row of projectDividendPayouts(input())) {
      if (row.cashBefore === null) continue;
      expect(row.cashAfter).toBe(row.cashBefore + row.amount);
    }
  });

  it("treats a holder with nothing as a holder with zero, not as unknown", () => {
    const rows = projectDividendPayouts(
      input({ holdings: [{ player: "carol", percentage: 100 }] }),
    );
    expect(rows[0].cashBefore).toBe(0);
    expect(rows[0].cashAfter).toBe(180);
  });

  it("says nothing about a balance it cannot read", () => {
    /* `null` is "the state did not report this player's cash", which is not $0 -- and `null + amount` would
       quietly render the payout as though it were the whole balance. */
    const rows = projectDividendPayouts(
      input({ holdings: [{ player: "stranger", percentage: 100 }] }),
    );
    expect(rows[0].cashBefore).toBeNull();
    expect(rows[0].cashAfter).toBeNull();
  });
});

describe("the bank pool pays the corporation, and the IPO pays nobody", () => {
  it("gives the pool's share to the corporate treasury", () => {
    /* THE RULE. "Shares in the bank pool pay dividends to the corporate treasury." The row's recipient is the
       corporation, and its before-value is the same treasury the Withhold column beside it shows. */
    const pool = projectDividendPayouts(input()).find((row) => row.kind === "treasury");
    expect(pool).toMatchObject({
      holder: "B&O",
      percentage: 10,
      amount: 18,
      cashBefore: 240,
      cashAfter: 258,
    });
  });

  it("has no row for unsold shares", () => {
    /* "No payments are made for unsold initial offering shares." `ipo_pool_percentage` is not even an input,
       so a future caller cannot pass it in by mistake. */
    expect(Object.keys(input())).not.toContain("ipoPoolPercentage");
  });

  it("falls short of the revenue by exactly what is unsold", () => {
    /* 60 + 30 held and 10 pooled leaves nothing in the IPO, so the whole $180 is paid. Hold back 20% unsold
       and the column pays $144 against a $180 heading -- both true, and the gap is the IPO. */
    const fullySold = projectDividendPayouts(input());
    expect(fullySold.reduce((sum, row) => sum + row.amount, 0)).toBe(180);

    const partlyUnsold = projectDividendPayouts(
      input({ holdings: [{ player: "alice", percentage: 70 }], bankPoolPercentage: 10 }),
    );
    expect(partlyUnsold.reduce((sum, row) => sum + row.amount, 0)).toBe(144);
  });

  it("omits the pool row when the pool is empty", () => {
    const rows = projectDividendPayouts(input({ bankPoolPercentage: 0 }));
    expect(rows.every((row) => row.kind === "player")).toBe(true);
  });

  it("says nothing about a treasury it cannot read", () => {
    const pool = projectDividendPayouts(input({ treasuryNow: null })).find(
      (row) => row.kind === "treasury",
    );
    expect(pool).toMatchObject({ amount: 18, cashBefore: null, cashAfter: null });
  });
});

describe("shareholders are listed largest first", () => {
  it("puts the president at the top", () => {
    const rows = projectDividendPayouts(
      input({
        holdings: [
          { player: "bob", percentage: 30 },
          { player: "alice", percentage: 60 },
        ],
      }),
    );
    expect(rows.map((row) => row.holder)).toEqual(["ALICE", "BOB", "B&O"]);
  });

  it("keeps the corporation last, whatever the pool holds", () => {
    // A pool larger than every shareholder would sort first on holding alone; it is a footnote regardless.
    const rows = projectDividendPayouts(
      input({ holdings: [{ player: "alice", percentage: 20 }], bankPoolPercentage: 80 }),
    );
    expect(rows[rows.length - 1].kind).toBe("treasury");
  });
});

describe("the spoken row says what the numerals say", () => {
  it("states both ends and the amount between them", () => {
    const [alice] = projectDividendPayouts(input());
    expect(describeDividendRow(alice)).toBe("ALICE, 60%: $420 plus $108 is $528.");
  });

  it("drops to the amount alone where the balance is unknown", () => {
    // A player the state did not report cash for is still paid; the sentence just cannot name the two ends.
    const [stranger] = projectDividendPayouts(
      input({ holdings: [{ player: "stranger", percentage: 50 }], bankPoolPercentage: 0 }),
    );
    expect(describeDividendRow(stranger)).toBe("STRANGER, 50%: receives $90.");
  });

  it("does not say a corporation owns itself", () => {
    /* The pool row's percentage is a holding of the BANK's. Spoken as "B&O, 10%" it would claim the
       corporation holds a tenth of its own shares, which is a different -- and false -- statement. */
    const pool = projectDividendPayouts(input()).find((row) => row.kind === "treasury")!;
    expect(describeDividendRow(pool)).toBe(
      "B&O's treasury, on 10% in the bank pool: $240 plus $18 is $258.",
    );
  });
});
