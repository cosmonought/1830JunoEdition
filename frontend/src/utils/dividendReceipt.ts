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
  /** The viewer's cash before the payout. `null` when it is not known. */
  cashBefore: number | null;
}

export interface DividendReceipt {
  /** "C&O paid $27 per share" -- the headline. */
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
  if (!Number.isFinite(input.perShare) || input.perShare <= 0) return null;
  if (!Number.isFinite(input.viewerPercentage) || input.viewerPercentage <= 0) return null;

  /* The reducer's own arithmetic, deliberately duplicated in shape rather than in source: it pays
     `perShare * (percentage / 10)`, and a receipt quoting a different figure from the one that moved would be
     worse than no receipt at all. `dividendReceipt.test.ts` holds the two together. */
  const amount = input.perShare * (input.viewerPercentage / 10);
  if (amount <= 0) return null;

  const before = input.cashBefore;
  const known = before !== null && Number.isFinite(before);

  return {
    headline: `${input.ticker} paid $${input.perShare} per share — you received $${amount}.`,
    /* Design note #670's arrow, and its rule: an unknown balance shows NOTHING rather than a figure with a
       guess on one end. The headline still carries the amount, so the toast is never empty. */
    transition: known ? `$${before} → $${(before as number) + amount}` : null,
    amount,
  };
}
