// frontend/src/utils/treasuryProjection.ts
//
// What a share purchase or sale leaves the player holding.
//
// Design note #682: REPORTED -- the "$500 → $433" beside the Buy button was
// "a little unclear what it actually is showing for people who don't know why
// we put it there ... caused by it being a plain-looking text string and also
// having no styling."
//
// Design note #577 put that string there for a good reason and it is still the
// right reason: the price is on the button, and what the button cannot say is
// the thing a player actually decides on -- not "does this cost $67" but "can I
// still start the C&O afterwards". What #577 got wrong is that it rendered an
// ANSWER in the typography of an aside. Two bare numbers and an arrow, in muted
// micro text, beside a button carrying its own price, reads as a footnote about
// the button rather than as the consequence of pressing it.
//
// So the arithmetic moves here and the presentation moves below the button,
// into a block that says whose money it is (the seat's own colour) and which
// way it is going.
//
// ONE MODULE FOR BOTH DIRECTIONS, which is the part worth extracting. A buy and
// a sale are the same question with the sign flipped, and they were two
// expressions in two places -- one of which had a shortfall branch and the other
// did not.
//
// THE COLOUR RULE IS STATED HERE, not in the component, because it is a claim
// about the MEANING of the figure rather than about its appearance:
//
//   UP is green. Money arriving.
//   DOWN is amber, NOT red. `cashDelta.ts` #670 settled this: red in this app
//   marks a contested auction and an error toast, and money leaving a player's
//   hand to buy a share is neither. Spending is ordinary and should read as
//   ordinary.
//   SHORT is red, and is the one case that earns it -- the player cannot do
//   this. The card already used red for exactly this and nothing else.
//
// See docs/ai_architecture/stock_market.md, treasuryProjection.ts #682.

/** Which way the money moves, and therefore how it is drawn. */
export type TreasuryDirection = "up" | "down" | "short";

export interface TreasuryProjection {
  /** What the player holds now. */
  before: number;
  /** What they would hold after. Negative when they cannot afford it -- the
   *  figure is kept rather than clamped, because "how far short" is the useful
   *  part and `short` below is derived from it. */
  after: number;
  /** Signed movement. Never zero for a rendered projection: a free action has
   *  nothing to project and the caller renders nothing. */
  delta: number;
  /** How much is missing, or `null` when the player can cover it. */
  short: number | null;
  direction: TreasuryDirection;
}

/** `delta` is signed: negative for a purchase, positive for a sale.
 *
 *  The caller supplies the sign rather than a cost plus a flag, so a new kind of
 *  transaction cannot arrive with its own opinion about which way is which. */
export function projectTreasury(before: number, delta: number): TreasuryProjection {
  const after = before + delta;
  const short = after < 0 ? -after : null;
  return {
    before,
    after,
    delta,
    short,
    direction: short !== null ? "short" : delta >= 0 ? "up" : "down",
  };
}

/* `formatTreasuryProjection` was here and is DELETED. It built "$500 → $433" as
   one string, which is what the OLD inline rendering needed -- and the block that
   replaced it composes the two figures itself, because it tints them separately
   and an arrow that cannot take the direction's colour is the glyph the report
   said nobody could interpret.
   Removed rather than left exported: an unused string builder for the exact
   rendering somebody just asked us to stop using is an invitation to go back to
   it. The rule `palette.ts` records for its deleted colour token, and this
   file's own #466 for `cannotAffordNote`.
   BOTH ENDS ARE STILL SHOWN -- that part of #670 stands. The block draws them;
   `describeTreasuryProjection` says them in words for a tooltip and a screen
   reader, where an arrow says nothing. */

/** The sentence for a tooltip and for assistive technology, where an arrow
 *  glyph says nothing. */
export function describeTreasuryProjection(
  projection: TreasuryProjection,
  action: string,
): string {
  if (projection.short !== null) {
    return `You hold $${projection.before} and this costs $${Math.abs(projection.delta)} — $${projection.short} short.`;
  }
  return `$${projection.before} now, $${projection.after} after this ${action}.`;
}
