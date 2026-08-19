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
 *  DESIGN NOTE 601: THE MINI-AUCTION CHASER IS GONE
 * ==================================================================
 *
 * `ROSTER_CONTEST_CHASE_CSS` lived here and dressed the action bar's
 * roster pills, which turned out to be unreachable -- design note #601 in
 * `ContextualActionBar.tsx` has the why. Deleting the pills left this with
 * no consumer, so it goes with them rather than sitting here looking like
 * a shared animation.
 *
 * WHAT IT MEANT IS WORTH KEEPING FINDABLE. Design note #545 chose the
 * multicolour chaser for a running mini-auction because green is reserved
 * for "on turn in the ordinary rotation", and a mini-auction SUSPENDS that
 * rotation -- so painting a contestant green would assert the one thing
 * that is not true. The chaser itself is not lost: it still rings the
 * contested card in `WaterfallAuctionDashboard.tsx` (design notes
 * #320/#344), which is where it came from and where it is still read.
 *
 * SO THE BAR NO LONGER MARKS A CONTEST. `SeatOrderTrail` draws the seat
 * queue and says nothing about mini-auction membership. If that turns out
 * to matter, this note and #545 are the two to read before reinventing
 * it. */

/* ==================================================================
 *  DESIGN NOTE 597: A TRANSITION IS NOTICED; A STATE IS NOT
 * ==================================================================
 *
 * REPORTED: the acting seat's colour "is still too subtle for most people
 * since it currently sits as a very slim border on the left edge... If it
 * were a little more dynamic somehow, players would notice 'for sure' when
 * their turn has come back around."
 *
 * TWO SEPARATE PROBLEMS, and the report names both without separating them.
 *
 *   THE BAND IS TOO SMALL. A 6px vertical sliver on the left edge is the
 *   least visible place a colour can be put on a wide panel -- it is in
 *   peripheral vision only if you happen to be looking at the left margin.
 *   It becomes a full-width bar along the top edge, which is the widest
 *   dimension the panel has.
 *
 *   THE CUE NEVER CHANGES. This is the deeper half. Design note #570 made
 *   the colour a STATE -- "this bar belongs to whoever is up" -- and a state,
 *   however bold, stops being seen within a few minutes. Habituation is not
 *   a matter of contrast; it is a matter of nothing happening. The existing
 *   my-turn pulse has the same flaw for the same reason: it is a CONTINUOUS
 *   animation, so it is running when you look away and still running when
 *   you look back, and carries no arrival.
 *
 * SO THE SIGNAL IS THE CHANGE ITSELF. A one-shot sweep runs across the band
 * whenever the acting seat changes, and stops. Motion that starts is caught
 * peripherally in a way that motion which has always been running is not --
 * and because it ends, it costs nothing for the rest of the turn.
 *
 * TWO INTENSITIES, because "somebody's turn began" and "YOUR turn began" are
 * different news. Everyone gets the sweep; the seat holder gets a brighter,
 * longer one with a soft bloom under the bar. The stronger version is the
 * one the report is actually asking for.
 *
 * REPLAYED BY REMOUNTING, not by a timer. The band carries `key={acting
 * seat}`, so React replaces the element on every change and the browser
 * starts the animation fresh. A JS-driven restart would need a class toggle,
 * a reflow read and a cleanup, all to reproduce what a changed key does for
 * free.
 *
 * REDUCED MOTION keeps the band and drops the sweep, the same bargain every
 * other animation here makes: the colour still says whose turn it is, which
 * is the information. Only the arrival cue is lost, and an arrival cue that
 * cannot be switched off is an accessibility problem. */
export const TURN_HANDOFF_SWEEP_CSS = `
@keyframes app-turn-band-sweep {
  0%   { background-position: -140% 0; }
  100% { background-position: 240% 0; }
}
@keyframes app-turn-band-bloom {
  0%   { opacity: 0; transform: scaleY(0.4); }
  22%  { opacity: 1; transform: scaleY(1); }
  100% { opacity: 0; transform: scaleY(1); }
}
/* The band itself: the seat colour, full width, with a travelling highlight
   laid over it. 'background-size: 60%' on the sheen keeps the moving band
   narrow relative to the bar, so it reads as a sweep rather than as the
   whole strip changing brightness. */
.app-turn-band {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  border-top-left-radius: 10px;
  border-top-right-radius: 10px;
  overflow: hidden;
  pointer-events: none;
}
.app-turn-band::after {
  content: "";
  position: absolute;
  inset: 0;
  background-image: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.85) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  background-size: 60% 100%;
  background-repeat: no-repeat;
  animation: app-turn-band-sweep 900ms ease-out 1;
}
/* Your own turn: a slower, wider sweep and a bloom below the bar, so the one
   handoff that requires you to DO something is louder than the three that do
   not. */
.app-turn-band-mine::after {
  background-size: 85% 100%;
  animation-duration: 1300ms;
}
.app-turn-band-mine::before {
  content: "";
  position: absolute;
  inset: -2px -8px -14px;
  background: radial-gradient(
    ellipse at top,
    rgba(255, 255, 255, 0.35),
    rgba(255, 255, 255, 0) 70%
  );
  animation: app-turn-band-bloom 1300ms ease-out 1;
}
@media (prefers-reduced-motion: reduce) {
  .app-turn-band::after,
  .app-turn-band-mine::before {
    animation: none;
    opacity: 0;
  }
}
`;

/* ------------------------------------------------------------------ */
/* App shell -- everything below here renders inside both providers   */
/* ------------------------------------------------------------------ */

