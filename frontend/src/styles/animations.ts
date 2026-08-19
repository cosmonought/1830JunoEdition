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

