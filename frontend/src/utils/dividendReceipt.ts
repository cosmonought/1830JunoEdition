// frontend/src/utils/dividendReceipt.ts
//
// The one notification a player gets about somebody else's action.
//
// ==================================================================
//  DESIGN NOTE 738: A NAMED EXCEPTION TO #718, NOT A WIDENING OF IT
// ==================================================================
//
// REQUESTED: "when a player Pays Dividends, there is an Activity Log that records player payouts, but it might
// be worth reintroducing a player-specific toast: 'You received dividends! [Corporation] paid $x per share' or
// something similar, with their [treasury] > [new treasury] below it."
//
// THIS BREAKS THE RULE #718 JUST WROTE, and that is worth saying plainly rather than quietly relaxing the
// rule. #718 scoped toasts to "an action whose confirmations are all somewhere other than where the player
// clicked" -- a RECEIPT for a button you pressed -- and said in as many words that "a toast for somebody
// else's action would be a notification feed, which is what the log already is."
//
// SO WHY THIS ONE. Because the argument for that rule does not reach this case, and the difference is
// specific: every action #718 silenced was one the reader TOOK, on a screen they were already looking at. A
// dividend is money arriving in a player's hand while it is not their turn, from a decision they had no part
// in, on a screen whose numbers they have no reason to be watching. There is no click to confirm and no
// element under the cursor to update. The Activity Log records it, and the log is a feed a player consults
// AFTER wondering -- which requires them to wonder, which requires them to notice.
//
// AND IT IS THE ONE MOMENT A PLAYER'S OWN CASH MOVES WITHOUT THEM. That is the whole of the exception. If a
// second case is ever proposed, test it against that sentence rather than against this one's existence.
//
// SILENT FOR EVERYONE WHO WAS NOT PAID. A player holding no shares in the paying corporation gets nothing --
// not a toast saying zero, which would make the feature noise in exactly the games it is for. The president
// who declared it gets one only if they were also paid, which they always are, because a president holds 20%.
//
// See docs/ai_architecture/ui_shell_layout.md, dividendReceipt.ts #738.

export interface DividendReceiptInput {
  /** The corporation that declared. */
  ticker: string;
  /** Whether the president chose to pay out. A withhold pays no player anything. */
  distribute: boolean;
  /** Revenue per 10% share, floored -- the same figure the reducer pays. */
  perShare: number;
  /** The viewer's holding in that corporation, as a percentage. `0` when they hold none. */
  viewerPercentage: number;
  /** Design note #923: what the corporation ran for, which the headline now leads with. From the same
   *  `dividendSplit` the amount comes from, so the two figures in one sentence cannot come from two places. */
  revenue: number;
  /** The viewer's cash before the payout. `null` when it is not known. */
  cashBefore: number | null;
  /** Design note #795: what the viewer actually received, from `dividendSplit` -- the same value the reducer
   *  spends and #775's Activity Log sentence prints. Passed in rather than computed here, because a receipt
   *  that does its own arithmetic is a second opinion about somebody else's money. */
  amount: number;
}

export interface DividendReceipt {
  /** "PRR ran for $27. Your 20% share paid $5." -- the headline (#923). */
  headline: string;
  /** "$412 → $520", or `null` when the balance is unknown. */
  transition: string | null;
  /** What the viewer received, for callers that want the figure rather than the sentence. */
  amount: number;
}

/** What to show the viewer when a corporation declares, or `null` for nothing.
 *
 *  `null` IS THE COMMON ANSWER and the function is written so it stays that way: a withhold, a holding of
 *  zero, a corporation that earned nothing. A notification that fires on every dividend in a four-player game
 *  would be the toast flood #718 removed, wearing a different hat. */
export function dividendReceipt(input: DividendReceiptInput): DividendReceipt | null {
  if (!input.distribute) return null;
  /* Design note #923: the GATE is still `perShare`, because it is the cheapest test for "did this
     corporation pay anything at all" and a corporation that paid nothing has no receipt to show. What changed
     is that the number no longer appears in the sentence. */
  if (!Number.isFinite(input.perShare) || input.perShare <= 0) return null;
  if (!Number.isFinite(input.viewerPercentage) || input.viewerPercentage <= 0) return null;

  /* ==================================================================
   *  DESIGN NOTE 795: THE THIRD COPY OF ONE CALCULATION
   * ==================================================================
   *
   * THE COMMENT THIS REPLACES ADMITTED THE PROBLEM AND ACCEPTED IT: "the reducer's own arithmetic,
   * deliberately duplicated in shape rather than in source ... `dividendReceipt.test.ts` holds the two
   * together." A test holding two implementations in step is a rope, not a fix, and #775 had already made the
   * same argument about the Activity Log's sentence -- which is now built from `dividendSplit`, the value the
   * reducer actually spends.
   *
   * SO THIS TAKES THE AMOUNT RATHER THAN RECOMPUTING IT. `perShare` survives because the headline quotes it,
   * but the figure a player is told they received is no longer this module's opinion.
   *
   * REPORTED: "the Dividends and the Activity Log showed the correct amounts, but the toast notification said
   * B&O paid $5 per share ... I'm not sure why you don't have the toast notifications pulling from the same
   * source as the Activity Log." The caller was passing a `perShare` derived from `last_route_revenue`
   * instead of from the declaration -- see App.tsx #795 -- and no amount of arithmetic here could have
   * rescued a wrong input. */
  const amount = input.amount;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const before = input.cashBefore;
  const known = before !== null && Number.isFinite(before);

  return {
    /* ==================================================================
        DESIGN NOTE 923: A PERCENTAGE, BECAUSE "PER SHARE" STOPPED BEING A WHOLE NUMBER
       ==================================================================
       REPORTED: "because the variant breaks clean per-share integers, the toast reading 'XXX paid out $5 per
       share' is no longer accurate."
       AND IT IS THE SAME PREMISE #922 BROKE ONE MODULE OVER. 1830's printed revenues are multiples of ten, so
       "per share" was an exact figure a player could multiply by their own holding; under #903's die it is a
       rounded tenth, and multiplying it back up gives a number that does not match what they were paid. A
       headline quoting it was arithmetic the player could check and find wrong.
       SO IT QUOTES WHAT IS TRUE AT EVERY REVENUE: the route's total, the holding, and the amount. All three
       are facts rather than rates, and none of them invites a multiplication that will not reconcile. */
    headline: `${input.ticker} ran for $${input.revenue}. Your ${input.viewerPercentage}% share paid $${amount}.`,
    /* Design note #670's arrow, and its rule: an unknown balance shows NOTHING rather than a figure with a
       guess on one end. The headline still carries the amount, so the toast is never empty. */
    transition: known ? `$${before} → $${(before as number) + amount}` : null,
    amount,
  };
}
