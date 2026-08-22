// The keyframe strings, moved out of `App.tsx` verbatim.
//
// These are the `<style>`-tag escape hatch design note #46 describes: inline
// `React.CSSProperties` cannot express `:hover` or `@keyframes`. Grouped because
// they are the same KIND of thing -- raw CSS text, not style objects.
// `NETA_CREDIT_CSS` and `MAIN_TAB_HOVER_CSS` travel with their own components,
// since each has exactly one consumer.

import { TURN_PULSE_INK_RGB } from "./palette";

/* Active Player Turn Notifications -- the CSS pulse. The other half of this
   notification, `document.title` flashing, lives in `utils/turnAlert.ts`: it has
   no DOM footprint to inject here. */

/* Design note #35: WHITE, not red. Two red pulses on screen simultaneously read
   as one effect, which is worst exactly when both fire -- your turn, during a
   contested mini-auction. The turn indicator moved because it is the one drawn
   over EVERYTHING (dark chrome, linen cards, map canvas), and white/silver is
   the only ink that keeps a consistent weight across all three. Red is now
   exclusively the auction's "contested" colour. */
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

   Opacity rather than a box-shadow glow: this badge sits inline in a crowded
   action bar, where a spreading glow would bleed over the controls either side.
   The pulse bottoms out at 0.55, not 0 -- a warning that blinks fully out is
   unreadable for half its cycle, and this one carries text. Reduced motion drops
   the animation and keeps the static crimson, which is why the two countdown
   steps differ in COLOUR and not merely in whether they pulse. */
export const PHASE_SHIFT_PULSE_CSS = `
@keyframes app-phase-shift-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
@media (prefers-reduced-motion: reduce) {
  .app-phase-shift-critical { animation: none !important; }
}
/* ==================================================================
   DESIGN NOTE 755: THE TRAIN CHIP BORROWS THE BADGE'S PULSE
   ==================================================================

   REQUESTED: "When trains are 2/1 purchase away from rusting, we currently have the number in the chip
   turning amber/red. I think maybe it should be the number AND the train icon that change colors, and they
   could pulsate like the 'Phase Shift' badge."

   THE SAME KEYFRAME, NOT A SECOND ONE THAT LOOKS LIKE IT. gamePhase.ts #7 already has chip and badge sharing
   the two alert constants "so chip and badge escalate together by construction"; sharing the motion is the
   same argument applied to the second channel. Two hand-tuned pulses at 1.4s and 1.5s would read as a
   rendering fault rather than as two warnings.

   ONE CLASS PER SURFACE, so reduced-motion can switch them off independently if the chip ever needs a
   different accommodation -- and because a class named for the badge, sitting on a train chip, is a thing a
   future reader would rightly hesitate to touch.

   NOTE FOR EDITORS: this whole block lives inside a TEMPLATE LITERAL, so no backticks. The first draft
   quoted three identifiers in backticks and terminated the string four lines early. */
.app-train-rust-critical {
  animation: app-phase-shift-pulse 1.4s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .app-train-rust-critical { animation: none !important; }
}
`;


/* Design note #601: `ROSTER_CONTEST_CHASE_CSS` is GONE with the action bar's
   roster pills, which were unreachable (`ContextualActionBar.tsx #601`).

   What it MEANT is worth keeping findable: design note #545 chose a multicolour
   chaser for a running mini-auction because green means "on turn in the ordinary
   rotation", and a mini-auction SUSPENDS that rotation. The chaser still rings
   the contested card in `WaterfallAuctionDashboard.tsx` (#320 / #344). The bar
   no longer marks a contest at all. */

/* Design note #597: a TRANSITION is noticed; a STATE is not.

   Two problems in one report. The 6px left-edge sliver is the least visible
   place a colour can go on a wide panel, so it becomes a full-width top bar. And
   the cue never CHANGED -- design note #570 made the colour a state, and a
   state, however bold, stops being seen within minutes; the continuous my-turn
   pulse has the same flaw, since it is running before you look and after.

   So the signal is the change itself: a one-shot sweep on every acting-seat
   change, in two intensities (somebody's turn began vs. YOURS). Replayed by
   REMOUNTING -- the band carries `key={acting seat}`, so a changed key restarts
   the animation for free where a JS restart needs a class toggle, a reflow read
   and a cleanup. Reduced motion keeps the band and drops the sweep.

   See docs/ai_architecture/ui_shell_layout.md, animations.ts #597. */
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

