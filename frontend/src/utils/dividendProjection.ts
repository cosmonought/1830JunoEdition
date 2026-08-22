// frontend/src/utils/dividendProjection.ts
//
// What a pay-out does to each shareholder's cash, before it is done.
//
// Design note #705: THE PAY COLUMN SHOULD ANSWER THE QUESTION THE WITHHOLD COLUMN ANSWERS.
//
// REPORTED: "We discussed previously that it's hard to see in the Dividends phase how paying out affects
// players' personal cash, but I think the solution is looking at us on the Withhold side where we show the
// corporation's treasury with its current value to its new value. Perhaps the pay out column should also show
// P1's current treasury > P1's treasury after pay out, etc, instead of only showing P1 gets $x, P2 gets $y?
// I am reluctant to lose the actual payout amount, which going from current to new treasury will elide."
//
// The two columns were answering DIFFERENT KINDS of question. Withhold says "$420 becomes $600" -- a
// before-and-after about a balance the player can check. Pay said "P1 gets $54" -- a delta with no anchor,
// which is only useful to a reader who already holds P1's cash in their head. Design note #509a wrote the
// Withhold transition precisely because "the sentence it replaces ... described a consequence the player then
// had to compute", and the Pay column was left doing exactly that, one column to the left.
//
// SO: BOTH ENDS AND THE MOVE BETWEEN THEM. The payout amount stays -- it is the figure the decision turns on
// and #188 put it on the button for the same reason -- but it now sits between the two balances it connects
// rather than standing alone.
//
// WHO IS PAID -- 1830, verbatim: "Shares in the bank pool pay dividends to the corporate treasury. No payments
// are made for unsold initial offering shares."
//
// GETTING HERE TOOK THREE CORRECTIONS, and the shape of them is worth keeping. The first draft carried a "Bank
// Pool" row paying the BANK, inherited from the code it replaced along with the comment justifying it. Told
// there was no bank pool payout, the second draft deleted the row and, reading the reducer, proposed a new one
// for the IPO -- because the reducer really did pay `ipo_pool_percentage` into the treasury. Told that IPO
// shares pay nothing, the third deleted both.
//
// ALL THREE WERE READING THE REDUCER AS THE RULE, and the reducer had the two pools EXACTLY SWAPPED (#706).
// That is why each correction produced a new wrong answer instead of converging: the source being consulted
// was itself inverted, so "the code pays the IPO" was evidence for precisely the wrong conclusion.
//
// SO THE POOL ROW IS BACK, and its recipient is the CORPORATION. That makes it the one row in this column that
// is not a player, and the one whose before-and-after is a TREASURY -- which is the same figure, on the same
// corporation, that the Withhold column beside it has been showing since #509a. The two columns now share a
// subject as well as a grammar.
//
// The IPO's share pays nobody, so it has no row, and the rows total less than the revenue whenever shares
// remain unsold. That gap is a fact about the corporation, not a rounding error.
//
// See docs/ai_architecture/contract_economy.md, dividendProjection.ts #705.

import type { PlayerShareEntry } from "./gameState";

export interface DividendPayoutProjection {
  /** Design note #706: a shareholder, or the corporation itself collecting its bank pool's share. The renderer
   *  brands the treasury row with the corporate herald, exactly as the Withhold column does. */
  kind: "player" | "treasury";
  /** The display label, resolved at the edge -- a wallet is what travels, a label is one client's rendering. */
  holder: string;
  percentage: number;
  /** This holder's share of the revenue. */
  amount: number;
  /** Cash before the payout, or `null` when the state did not report this player's balance -- which is not
   *  the same as zero, and must not render as one. */
  cashBefore: number | null;
  /** `cashBefore + amount`, or `null` for the same reason. */
  cashAfter: number | null;
}

export interface DividendProjectionInput {
  holdings: readonly PlayerShareEntry[];
  /** Percent sitting in the BANK POOL -- shares players sold back, which pay the corporate treasury.
   *  `ipo_pool_percentage` is deliberately not an input: unsold shares pay nobody. */
  bankPoolPercentage: number;
  /** The corporation's treasury now, for the pool row's before-value. `null` when unknown. */
  treasuryNow: number | null;
  /** How the pool row names its recipient -- the operating corporation's ticker. */
  corporationLabel: string;
  /** Revenue per 10% share -- 1830 splits ten ways. */
  perShare: number;
  /** This player's cash right now, or `null` if unknown. */
  cashOf: (player: string) => number | null;
  /** Wallet -> display name. */
  labelOf: (player: string) => string;
}

/** One row per shareholder that is actually paid, largest holding first. */
export function projectDividendPayouts(
  input: DividendProjectionInput,
): DividendPayoutProjection[] {
  const { holdings, bankPoolPercentage, treasuryNow, corporationLabel, perShare, cashOf, labelOf } =
    input;

  const rows: DividendPayoutProjection[] = holdings.map((entry) => {
    const amount = shareOfRevenue(perShare, entry.percentage);
    const cashBefore = cashOf(entry.player);
    return {
      kind: "player" as const,
      holder: labelOf(entry.player),
      percentage: entry.percentage,
      amount,
      cashBefore,
      // `null + amount` would be `amount`, which would state a balance this build does not have.
      cashAfter: cashBefore === null ? null : cashBefore + amount,
    };
  });

  /* SORTED BY HOLDING, not by cash: the reader is scanning a cap table, and the president -- who is looking
     at their own row first -- is the largest holder by definition. */
  rows.sort((a, b) => b.percentage - a.percentage);

  /* The pool LAST regardless of its size. It is the one row that is not a player, and a corporation paying
     itself reads as a footnote to the shareholders' rows wherever else it lands. */
  if (bankPoolPercentage > 0) {
    const amount = shareOfRevenue(perShare, bankPoolPercentage);
    rows.push({
      kind: "treasury",
      holder: corporationLabel,
      percentage: bankPoolPercentage,
      amount,
      cashBefore: treasuryNow,
      cashAfter: treasuryNow === null ? null : treasuryNow + amount,
    });
  }

  return rows;
}

/** A 10% share takes one tenth, so a percentage takes `percentage / 10` shares' worth. */
function shareOfRevenue(perShare: number, percentage: number): number {
  return perShare * (percentage / 10);
}

/** The row as one string, for a screen reader and for the tooltip.
 *
 *  BUILT FROM THE SAME FIELDS THE ROW RENDERS, so the sentence and the numerals cannot describe different
 *  money -- the mistake `TrainPurchasePanel` #687a records in the depot cell. */
export function describeDividendRow(row: DividendPayoutProjection): string {
  /* The pool row's percentage is a holding of the BANK's, not of the corporation being named -- so it is
     spoken differently, or the sentence would claim a corporation owns itself. */
  const share =
    row.kind === "treasury"
      ? `${row.holder}'s treasury, on ${row.percentage}% in the bank pool`
      : `${row.holder}, ${row.percentage}%`;
  if (row.cashBefore === null || row.cashAfter === null) {
    return `${share}: receives $${row.amount}.`;
  }
  return `${share}: $${row.cashBefore} plus $${row.amount} is $${row.cashAfter}.`;
}
