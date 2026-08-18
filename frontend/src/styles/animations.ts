// frontend/src/styles/animations.ts
//
// THE KEYFRAME STRINGS, moved out of `App.tsx` verbatim.
//
// These are the `<style>`-tag escape hatch design note #46 describes: inline
// `React.CSSProperties` cannot express `:hover` or `@keyframes`, so the few
// effects that genuinely need real CSS are carried as template strings and
// injected next to the element that uses them. They are grouped here because
// they are the same KIND of thing -- raw CSS text, not a style object -- and
// keeping them beside `appStyles.ts` means someone looking for "how is this
// styled" finds both halves in one directory.
//
// Each string keeps the design note that justifies it. `NETA_CREDIT_CSS` and
// `MAIN_TAB_HOVER_CSS` travel with their own components instead, since each
// has exactly one consumer and would only be indirection here.

import { TURN_PULSE_INK_RGB } from "./palette";

/* ------------------------------------------------------------------ */
/* Active Player Turn Notifications -- CSS pulse keyframes, see design    */
/* note #18/item 4. `document.title` flashing (the other half of this    */
/* notification) lives in utils/turnAlert.ts instead -- no DOM footprint */
/* to inject here. Same `<style>`-tag keyframes escape hatch Chatbox.tsx */
/* already established (that file's own design note #2) for this        */
/* codebase's plain-inline-style convention, which cannot express a      */
/* `@keyframes` rule at all.                                             */
/* ------------------------------------------------------------------ */

/* Design note #35: WHITE, not red.
 *
 * This pulse used to be red, and so did the mini-auction ring in
 * `WaterfallAuctionDashboard.tsx`. Two red pulses on screen simultaneously
 * read as one effect, which is worst exactly when both are firing: your
 * turn, during a contested mini-auction.
 *
 * The turn indicator is the one that moved, because it is the one drawn
 * over EVERYTHING. It sits on the dark chrome, the linen-white cards and
 * the map canvas in turn, and white/crisp silver is the only ink that keeps
 * a consistent weight across all three -- red read as urgent on the dark
 * shell and as a smudge over the cards. Red is now exclusively the
 * auction's "contested" colour. */
export const TURN_PULSE_KEYFRAMES_CSS = `
@keyframes app-turn-pulse-glow {
  0%, 100% {
    box-shadow: inset 0 0 0 rgba(${TURN_PULSE_INK_RGB}, 0),
                0 0 0 rgba(${TURN_PULSE_INK_RGB}, 0);
  }
  50% {
    box-shadow: inset 0 0 40px rgba(${TURN_PULSE_INK_RGB}, 0.28),
                0 0 30px rgba(${TURN_PULSE_INK_RGB}, 0.4);
  }
}
`;

/* The phase-shift badge's CRITICAL step -- one purchase from the shift.
 *
 * Opacity rather than the box-shadow glow the other two pulses use. This
 * badge sits inline in a crowded action bar, where a spreading glow would
 * bleed over the controls either side of it; the turn overlay and the
 * auction card both own their whitespace and can afford one.
 *
 * The pulse bottoms out at 0.55, not 0. A warning that blinks fully out is
 * unreadable for half its cycle, and this one carries text the player needs
 * to actually read.
 *
 * Reduced motion drops the animation and keeps the static crimson, exactly
 * as `WaterfallAuctionDashboard.tsx` does: the player still sees WHICH step
 * of the countdown they are on, just without the movement. Escalation must
 * survive the animation being switched off, which is the other reason the
 * two steps differ in colour and not merely in whether they pulse. */
/** `GamePhase.tint` -> the tile tier that phase has unlocked.
 *
 *  `tint` is already the exact three-value era `gamePhase.ts`'s
 *  `TIER_PRESENTATION` assigns (Phase 2 yellow; Phases 3-4 green; Phases
 *  5/6/D brown), so this is a case change rather than a second opinion about
 *  which era it is. Written as a table anyway rather than a string cast, so
 *  a fourth `PhaseTint` would fail to compile here instead of silently
 *  producing a `TileColorTier` that does not exist. */
/* The phase-shift badge's CRITICAL step -- one purchase from the shift.
 *
 * Opacity rather than the box-shadow glow the other two pulses use. This
 * badge sits inline in a crowded action bar, where a spreading glow would
 * bleed over the controls either side of it; the turn overlay and the
 * auction card both own their whitespace and can afford one.
 *
 * The pulse bottoms out at 0.55, not 0. A warning that blinks fully out is
 * unreadable for half its cycle, and this one carries text the player needs
 * to actually read.
 *
 * Reduced motion drops the animation and keeps the static crimson, exactly
 * as `WaterfallAuctionDashboard.tsx` does: the player still sees WHICH step
 * of the countdown they are on, just without the movement. Escalation must
 * survive the animation being switched off, which is the other reason the
 * two steps differ in colour and not merely in whether they pulse. */
export const PHASE_SHIFT_PULSE_CSS = `
@keyframes app-phase-shift-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@media (prefers-reduced-motion: reduce) {
  .app-phase-shift-critical { animation: none !important; }
}
`;


/* ==================================================================
 *  DESIGN NOTE 545: THE CONTEST'S COLOUR, ON THE ROSTER
 * ==================================================================
 *
 * INSTRUCTED: "maybe just the Action panel player tags should get the
 * rainbow chaser treatment during a Mini-Auction and leave the green for
 * the regular Waterfall Auctions."
 *
 * ONE MEANING, ONE TREATMENT. The multicolour chaser already exists and
 * already means exactly this -- `WaterfallAuctionDashboard.tsx` puts it
 * round the contested card (design notes #320/#344), chosen specifically
 * because it is none of the status colours this UI has assigned meaning to.
 * Reusing it on the pill makes the bar and the card say the same thing in
 * the same voice; inventing a second animation for the same event would
 * have the player learning two cues for one fact.
 *
 * WHY THE PILL AND NOT A NEW PANEL. A mini-auction is not a second table,
 * it is the same table with most of it stood down, so the honest rendering
 * is the existing roster with its rows re-marked -- greyed for the seats
 * shut out, chased for whoever is answering. A separate contest table would
 * put two lists of the same people on screen and make "who is up" a
 * question about which list you happened to read, which is the class of bug
 * design note #544 exists to fix.
 *
 * GREEN IS RESERVED, deliberately. It means "on turn in the ordinary
 * rotation" here and on the seating table, and the whole point of design
 * note #544 is that the ordinary rotation is SUSPENDED for the duration --
 * so painting a contestant green would assert the very thing that is not
 * true.
 *
 * THE GEOMETRY IS COPIED, not re-derived, from design note #344: the fill
 * must not repeat and the gradient must, and the `200%` in `background-size`
 * is the same one number as the `200%` in the keyframe -- one cycle
 * translates exactly one tile, or the loop stutters once per lap. Border is
 * 1px rather than the card's 3px because this is a pill in a crowded bar.
 *
 * REDUCED MOTION keeps the same bargain as every other animation here: the
 * ring stays, static, because switching the movement off must not cost the
 * player the answer to "who is bidding". */
export const ROSTER_CONTEST_CHASE_CSS = `
@keyframes app-roster-contest-chase {
  from { background-position: 0 0, 0 0; }
  to   { background-position: 0 0, 200% 0; }
}
.app-roster-pill-contested {
  border: 1px solid transparent !important;
  background:
    linear-gradient(#17202f, #17202f) padding-box,
    linear-gradient(
      90deg,
      #ff4d4d, #ff9f1c, #ffd400, #4ade80, #22d3ee,
      #4f7cff, #a855f7, #ff4dc4, #ff4d4d
    ) border-box;
  background-size: 100% 100%, 200% 100%;
  background-position: 0 0, 0 0;
  background-repeat: no-repeat, repeat;
  animation: app-roster-contest-chase 3.2s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .app-roster-pill-contested { animation: none; }
}
`;

/* ------------------------------------------------------------------ */
/* App shell -- everything below here renders inside both providers   */
/* ------------------------------------------------------------------ */

