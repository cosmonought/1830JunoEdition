// frontend/src/utils/pendingSpend.ts
//
// What a staged action will cost a corporation, and what it leaves behind.
//
// ==================================================================
//  DESIGN NOTE 836: ONE QUESTION, ASKED BY TWO RINGS
// ==================================================================
//
// REPORTED: "In the same the tooltip confirmation for laying a track on a
// terrain tile lists the treasury effect, the Station Marker tooltip
// confirmation should list the Treasury effect."
//
// #673 built the projection for the TILE ring and argued for it in terms that
// were never about tiles: "the question a president actually has is not 'what
// does this hex cost' but 'what am I left with' -- because the next step in the
// same turn may be a $450 train." A station marker is $40 or $100 out of the
// same treasury in the same turn, and its ring quoted the price and stopped.
//
// SO THE SENTENCE IS EXTRACTED RATHER THAN COPIED. Two surfaces answering one
// question with two implementations is the failure this session has found in
// #815's three chip rows and #829's two acronym vocabularies, and it is exactly
// what a second "Costs $X — treasury $Y after" in `RadialTokenConfirm` would
// have been. `pendingTileCost.ts` keeps what is genuinely about ground -- which
// terrain costs what, and the rule that it is charged once -- and hands the
// arithmetic and the wording here.
//
// WHY A MODULE AND NOT A GENERALISED `pendingTileCost`. Its own header is four
// paragraphs about rivers, mountains and G19's preprinted yellow tile; a
// function named for tiles, in a file about terrain, describing the price of a
// station marker is the kind of small lie a reader trips over later. The name
// says what it does.
//
// PURE, and separate from every surface that renders it, for #673's reason.

/** A staged charge and its effect on the treasury. */
export interface PendingSpend {
  /** What the action will cost. `0` is a real answer -- clear ground, an
   *  upgrade over paid terrain, a free home station -- and all of them mean the
   *  same thing to the caption: say nothing. */
  fee: number;
  /** The treasury as it stands. `null` when it is not known -- offline, or
   *  before the first poll. */
  before: number | null;
  /** What it will be afterwards. `null` whenever `before` is: an unknown
   *  balance minus a known fee is still unknown, and rendering `-$80` there
   *  would be a figure no corporation has. */
  after: number | null;
  /** Whether the treasury cannot cover this. Reported, NOT enforced -- the
   *  rules about an unaffordable action belong to the contract, and this
   *  module's job is to say what the player is looking at. */
  short: boolean;
}

/** Project `fee` against `treasury`.
 *
 *  `treasury` is `number | null` rather than defaulted to zero for the reason
 *  `playerFinance.ts` #562 gives about an em dash: a balance nobody has read and
 *  a balance of nothing are different facts, and only one of them means the
 *  corporation is broke. */
export function pendingSpend(fee: number, treasury: number | null): PendingSpend {
  const before = treasury === null || !Number.isFinite(treasury) ? null : treasury;
  const after = before === null ? null : before - fee;
  return { fee, before, after, short: after !== null && after < 0 };
}

/** The sentence a confirm step says, or `null` when there is nothing to say.
 *
 *  Names the FEE and the remainder together, because the two answer different
 *  questions and the player is about to press a button that settles both.
 *
 *  `null` FOR A FREE ACTION as much as for an unknown treasury. Most hexes are
 *  free and every home station is, and a permanent "Costs $0" teaches a player
 *  to stop reading the line that matters where it does. */
export function describePendingSpend(spend: PendingSpend): string | null {
  if (spend.fee <= 0) return null;
  if (spend.after === null) return `Costs $${spend.fee}`;
  return `Costs $${spend.fee} — treasury $${spend.after} after`;
}
