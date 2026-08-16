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

/* ------------------------------------------------------------------ */
/* App shell -- everything below here renders inside both providers   */
/* ------------------------------------------------------------------ */

