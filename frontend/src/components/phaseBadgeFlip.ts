// frontend/src/components/phaseBadgeFlip.ts
//
// The phase badge's own mechanical flip -- VF-4 (VISUAL_FLOURISH_BACKLOG.md). This module owns the SCHEDULE
// and the DISPLAYED-PHASE COMPARISON, and nothing else: `PhaseBadge.tsx` renders it, `App.tsx` raises it.
// The same split `corporationFloatFocus.ts` keeps for VF-3 and `stockTransferFocus.ts` for VF-1.
//
/* ==================================================================
    DESIGN NOTE (VF-4): THE FLOURISH SAYS ONE THING -- "THE PHASE JUST CHANGED"
   ==================================================================
   Every CONSEQUENCE of a phase change already has an owner, and none of them is this file: the badge itself
   is what phase is true now; `purchaseWarnings` counts down the rust and the train-limit losses; the era
   toast announces newly-legal tile colours; `PhaseThreeNoticeModal` states the Phase 3 private-company rule;
   the FleetLoss systems show lost trains. So there is no modal, no banner, no timetable, no second phase
   plate and no consequence text here. The EXISTING persistent badge changes state in front of the player,
   the way a mechanical destination plate does, and stops.

   A-2 ("an animation must CAUSE the visible final state"): the badge renders the STAGED `before` face --
   the old label and the old tint -- until the fold's hidden midpoint, and the authoritative new face
   afterwards. The change is therefore produced by the gesture rather than explained after it.

   A-3 ("presentation is never required for correctness"): nothing here is awaited by anything. The shell
   raises the event AFTER the reducer has settled, from two already-committed states, and a badge that never
   receives one (or whose sequence is superseded) renders the plain authoritative phase exactly as it does
   today.

   A-4 ("presentation never re-derives a rule"): the comparison below reads `GamePhase.label`/`.tint` --
   the two values the badge already prints -- off two completed states. It does not ask what phase SHOULD be
   in play, what rusts, what a train costs, or whether anything was legal.

   A-1 is untouched by construction: the badge animates in place, in its own DOM node, inside the existing
   `uiScale`-zoomed subtree. No portal, no `position: fixed`, no duplicate badge, no flight layer.
*/

import type { GamePhase, PhaseTint } from "../gameEngine/gamePhase";

/* ==================================================================
    WHAT "THE DISPLAYED PHASE" IS
   ==================================================================
   THE BADGE'S OWN TWO VALUES, AND DELIBERATELY NOT THE TIER. `derivePhase` answers with a TRAIN TIER, and
   the tier is not what the badge shows: `TIER_PRESENTATION` maps the Level Playing Field's 7-train to
   `phaseNumber: "6"` (#1326 -- "the 7-train has no effect"), so a table that buys its first 7 goes
   tier "6" -> tier "7" while the badge goes "Phase: 6 (Brown)" -> "Phase: 6 (Brown)". Comparing tiers would
   flip a Phase 6 badge into an identical Phase 6 badge -- a ceremony announcing that nothing happened, and
   the single most likely wrong trigger in this batch. Comparing what is PRINTED cannot produce it, because
   there is nothing to print differently.

   `label` AND `tint` TOGETHER, not `label` alone: the tint is the badge's other rendered channel, so a
   future presentation table that split two phases by colour alone would still be a visible change. (Today
   `PHASE_TINT_STYLES` maps all three tints to one neutral style -- #1450's neutral default -- so the tint
   channel currently carries no pixels. It is compared anyway, because this file's job is to notice when the
   BADGE changes, and the day the tints come back is not the day to remember this.)

   `known: false` IS NOT A PHASE, on `gamePhase.ts` #3's own rule ("unknown is a state, not a zero"). A
   badge reading `Phase: Yellow` because no corporation has reported a roster has not told us which phase
   the table is in, so neither entering nor leaving that reading is a phase CHANGE -- it is information
   arriving. Suppressed at both ends. */

/** The two values the badge prints. */
export interface PhaseBadgeFace {
  label: string;
  tint: PhaseTint;
}

/** What the badge is displaying for `phase`, or `null` when there is no displayed phase to compare. */
export function displayedPhaseFace(phase: GamePhase | null | undefined): PhaseBadgeFace | null {
  if (!phase || !phase.known) return null;
  return { label: phase.label, tint: phase.tint };
}

/** `true` when two states put the SAME thing on the badge. */
export function sameDisplayedPhase(a: PhaseBadgeFace, b: PhaseBadgeFace): boolean {
  return a.label === b.label && a.tint === b.tint;
}

/** The OLD face to stage, when the displayed phase genuinely changed between two settled states; `null`
 *  when it did not, or when either side has no displayed phase at all. The return value is the `before`
 *  face rather than a pair, because the `after` face is the authoritative one the badge is already being
 *  handed -- staging it here would be the second phase authority this batch must not create. */
export function phaseBadgeChange(
  before: GamePhase | null | undefined,
  after: GamePhase | null | undefined,
): PhaseBadgeFace | null {
  const from = displayedPhaseFace(before);
  const to = displayedPhaseFace(after);
  if (from === null || to === null) return null;
  return sameDisplayedPhase(from, to) ? null : from;
}

/** What the shell hands down: the staged old face, plus a token so two phase changes in a row still replay
 *  rather than sitting finished -- #1060's argument for the money machines' token, kept by every flourish
 *  event since. */
export interface PhaseBadgeFlipEvent extends PhaseBadgeFace {
  token: number;
}

/* ==================================================================
    FULL-MOTION TIMELINE -- A SPLIT-FLAP, NOT A CARD TRICK
   ==================================================================
   Brief: "~450-600 ms" total, and it "should read like a mechanical railway destination plate or split-flap
   changing state". So: a fold about the badge's own horizontal axis, a HIDDEN midpoint where the plate is
   edge-on, the swap there, and an unfold with one small mechanical settle -- no glow, no shake, no arcade
   easing, no enlargement. VF-3's half-turn is the closest relative and this is deliberately less than half
   its length: a corporation floats once, and a phase changes five times in a game. */

/** Fold: the old face rotates away to edge-on. */
export const PHASE_BADGE_FOLD_MS = 200;
/** The hidden midpoint -- the plate is edge-on, and this is the ONE instant the staged face is swapped for
 *  the authoritative one. Named separately from `applications[].at` (the same number) because the badge's
 *  own rotation CSS needs it independent of the swap bookkeeping, exactly as VF-3's `midpointAt` is. */
export const PHASE_BADGE_MIDPOINT_AT_MS = PHASE_BADGE_FOLD_MS;
export const PHASE_BADGE_UNFOLD_AT_MS = PHASE_BADGE_FOLD_MS;
/** Unfold: the new face swings in from edge-on, with the small overshoot-and-settle written into the
 *  keyframes rather than into a stage of its own -- one plate falling into its detent is one movement. */
export const PHASE_BADGE_UNFOLD_MS = 260;
/** Visible motion, fold start to settled plate: 460ms, inside the brief's 450-600ms band. */
export const PHASE_BADGE_VISIBLE_MS = PHASE_BADGE_UNFOLD_AT_MS + PHASE_BADGE_UNFOLD_MS;
/** THE SETTLE STAGE IS WHY THE LAST FRAME IS PIXEL-EQUIVALENT, and it is not decorative. An unfold left on
 *  `animation-fill-mode: forwards` holds `perspective(...) rotateX(0deg)` forever -- visually rest, but a
 *  transform all the same, which gives the span its own stacking context and can shift text rasterisation
 *  by a subpixel. The settle stage carries NO class and NO transform: the badge is then the ordinary badge,
 *  the same DOM and the same styles it renders with all game. `FLOAT_FOCUS_RELEASE_MS`'s role, with a
 *  second job. */
export const PHASE_BADGE_SETTLE_AT_MS = PHASE_BADGE_VISIBLE_MS;
export const PHASE_BADGE_SETTLE_MS = 60;
export const PHASE_BADGE_TOTAL_MS = PHASE_BADGE_SETTLE_AT_MS + PHASE_BADGE_SETTLE_MS;

/* ==================================================================
    REDUCED-MOTION TIMELINE
   ==================================================================
   Brief: "no 3D/flip movement; use a short crossfade or immediate old->new badge swap; authoritative phase
   still updates immediately." The crossfade, because it keeps the SEMANTIC ORDER of the full-motion
   sequence -- old face, hidden midpoint, new face -- so the same staging code, the same swap instant and
   the same tests describe both timelines, and only the CSS channel differs (opacity, never transform). */
export const PHASE_BADGE_REDUCED_FADE_OUT_MS = 80;
export const PHASE_BADGE_REDUCED_MIDPOINT_AT_MS = PHASE_BADGE_REDUCED_FADE_OUT_MS;
export const PHASE_BADGE_REDUCED_FADE_IN_MS = 80;
export const PHASE_BADGE_REDUCED_SETTLE_AT_MS =
  PHASE_BADGE_REDUCED_MIDPOINT_AT_MS + PHASE_BADGE_REDUCED_FADE_IN_MS;
export const PHASE_BADGE_REDUCED_SETTLE_MS = 40;
export const PHASE_BADGE_REDUCED_TOTAL_MS =
  PHASE_BADGE_REDUCED_SETTLE_AT_MS + PHASE_BADGE_REDUCED_SETTLE_MS;

/* ==================================================================
    WHEN THE FOLLOW-ON SURFACES MAY SPEAK
   ==================================================================
   Brief: "let the phase badge change visually before follow-on explanatory UI dominates attention", and the
   named case is Phase 2 -> 3, where `PhaseThreeNoticeModal` must not cover the badge before the flip is
   perceptible.

   TWO DIFFERENT MILESTONES, BECAUSE THE TWO SURFACES COMPETE DIFFERENTLY. The era toast does not cover the
   badge; it only draws the eye, so it waits until the badge has actually CHANGED -- `faceSwapped`, the
   hidden midpoint -- and no longer. The notice modal takes the screen, so it waits until the plate has
   `settled`.

   ==================================================================
    CORRECTED: A MILESTONE IN THE ACTIVE SCHEDULE, NOT A FIXED NUMBER
   ==================================================================
   THE FIRST CUT EXPORTED TWO CONSTANTS -- `PHASE_BADGE_ERA_TOAST_HOLD_MS = 200` and
   `PHASE_BADGE_NOTICE_HOLD_MS = 520` -- and argued that full-motion figures were safe under reduced motion
   too, "because the reduced timeline is shorter at every beat, so the full-motion figure satisfies it with
   a few hundred milliseconds to spare". THAT ARGUMENT WAS TRUE AND WAS ANSWERING THE WRONG QUESTION. What
   it guaranteed is that the surface never arrives EARLY; what it silently bought was 120ms of dead air
   before the toast and 320ms before the notice, for the reader who asked for less motion and got more
   waiting. A reduced-motion preference is a request to spend less time on presentation, and holding a
   modal for 320ms after its badge has finished is presentation time with nothing on screen to justify it.

   SO THE HOLD NAMES A MILESTONE AND THE ACTIVE TIMELINE SUPPLIES THE NUMBER. `phaseBadgeTimeline` is the
   one place either figure comes from, and `buildPhaseBadgeFlipSequence` reads its `midpointAt`/`totalMs`
   from the very same call -- so the beat a hold waits for is by construction the beat the badge is
   actually playing, not a number that agrees with it today.

   NEITHER HOLD DELAYS AUTHORITATIVE STATE (A-3). The reducer has already committed, the badge has already
   been handed the new phase, and what waits is a toast and a notice -- both of which are, and were before
   this batch, pure presentation. */

/** The two figures a follow-on surface can wait for. */
export interface PhaseBadgeTimeline {
  /** The hidden midpoint -- the instant the badge stops showing the old phase and shows the new one. */
  midpointAt: number;
  /** The whole sequence, after which the badge is the ordinary persistent badge again. */
  totalMs: number;
}

/** The timeline actually being played. THE SINGLE SOURCE for both the sequence's own beats and the holds
 *  below, so the two cannot drift. */
export function phaseBadgeTimeline(reducedMotion: boolean): PhaseBadgeTimeline {
  return reducedMotion
    ? { midpointAt: PHASE_BADGE_REDUCED_MIDPOINT_AT_MS, totalMs: PHASE_BADGE_REDUCED_TOTAL_MS }
    : { midpointAt: PHASE_BADGE_MIDPOINT_AT_MS, totalMs: PHASE_BADGE_TOTAL_MS };
}

/** What a follow-on surface waits for, named rather than measured.
 *  `faceSwapped` -- the badge has stopped saying the old phase (the era toast's cue).
 *  `settled` -- the badge is the ordinary badge again (the notice modal's cue). */
export type PhaseBadgeMilestone = "faceSwapped" | "settled";

/** How long a surface waiting for `milestone` holds, under the timeline currently being played. */
export function phaseBadgeMilestoneMs(
  milestone: PhaseBadgeMilestone,
  reducedMotion: boolean,
): number {
  const timeline = phaseBadgeTimeline(reducedMotion);
  return milestone === "faceSwapped" ? timeline.midpointAt : timeline.totalMs;
}

/* ==================================================================
    AUDIO: OPEN, AND SILENT UNTIL IT IS ANSWERED
   ==================================================================
   Brief: "add no audio unless an existing suitable mechanical cue already exists and can be reused
   cleanly ... do not use generic cinematic boom/whoosh."
   THERE IS NO CLEAN REUSE IN THE TREE. The three clips that could pass for a mechanical plate --
   `telegraph.mp3`, `watch-wind.mp3`, `steam_hiss.mp3` -- are all owned by `variantSfx.ts`'s FLAVOUR-TEXT
   matcher (`/telegraph/i`, `/pocket watch/i`, `/boiler|steam/i`), where they mean "the line the ticker just
   printed mentions this thing". Giving one of them a second, structural meaning is how a cue stops meaning
   anything. `floated.mp3` and `presidency.mp3` are one-off ceremonial stingers for other events.
   SO THE FLIP IS SILENT, and the question is recorded in VISUAL_FLOURISH_BACKLOG.md rather than answered by
   whichever file was nearest. */

export type PhaseBadgeStageKind = "fold" | "unfold" | "settle";

export interface PhaseBadgeStage {
  kind: PhaseBadgeStageKind;
  at: number;
  durationMs: number;
}

export interface PhaseBadgeApplication {
  /** A set, for parity with VF-1's `FocusApplication` and VF-3's `FloatFocusApplication`, though exactly
   *  one field ever lands here -- the shape that survives a second staged field without becoming a special
   *  case. */
  applies: readonly ["face"];
  at: number;
}

export interface PhaseBadgeFlipSequence {
  /** The staged OLD face. The new one is the authoritative phase the badge is already holding. */
  from: PhaseBadgeFace;
  reducedMotion: boolean;
  stages: readonly PhaseBadgeStage[];
  applications: readonly PhaseBadgeApplication[];
  midpointAt: number;
  totalMs: number;
}

/** The running order for one displayed-phase change, or `null` when there is no event to show. Pure: no
 *  measurement, no timers, no rules re-derivation. */
export function buildPhaseBadgeFlipSequence(
  event: PhaseBadgeFace | null,
  reducedMotion: boolean,
): PhaseBadgeFlipSequence | null {
  if (!event) return null;
  const from: PhaseBadgeFace = { label: event.label, tint: event.tint };
  if (reducedMotion) {
    return {
      from,
      reducedMotion: true,
      stages: [
        { kind: "fold", at: 0, durationMs: PHASE_BADGE_REDUCED_FADE_OUT_MS },
        {
          kind: "unfold",
          at: PHASE_BADGE_REDUCED_MIDPOINT_AT_MS,
          durationMs: PHASE_BADGE_REDUCED_FADE_IN_MS,
        },
        {
          kind: "settle",
          at: PHASE_BADGE_REDUCED_SETTLE_AT_MS,
          durationMs: PHASE_BADGE_REDUCED_SETTLE_MS,
        },
      ],
      applications: [{ applies: ["face"], at: phaseBadgeTimeline(true).midpointAt }],
      ...phaseBadgeTimeline(true),
    };
  }
  return {
    from,
    reducedMotion: false,
    stages: [
      { kind: "fold", at: 0, durationMs: PHASE_BADGE_FOLD_MS },
      { kind: "unfold", at: PHASE_BADGE_UNFOLD_AT_MS, durationMs: PHASE_BADGE_UNFOLD_MS },
      { kind: "settle", at: PHASE_BADGE_SETTLE_AT_MS, durationMs: PHASE_BADGE_SETTLE_MS },
    ],
    applications: [{ applies: ["face"], at: phaseBadgeTimeline(false).midpointAt }],
    ...phaseBadgeTimeline(false),
  };
}

/** The stage active at `elapsedMs`, or `null` before the first / after the last. VF-3's `floatStageAt`. */
export function phaseBadgeStageAt(
  sequence: PhaseBadgeFlipSequence,
  elapsedMs: number,
): PhaseBadgeStage | null {
  let current: PhaseBadgeStage | null = null;
  for (const stage of sequence.stages) {
    if (stage.at <= elapsedMs) current = stage;
  }
  return current;
}

/* ==================================================================
    THE BADGE'S OWN STYLESHEET
   ==================================================================
   #46's escape hatch, on VF-1/VF-3's rule: keyframes are the one thing inline styles cannot express, so the
   rotation lives here and the DURATIONS are written inline by `PhaseBadge.tsx` from the constants above --
   one set of numbers, not two.

   `perspective()` INSIDE THE TRANSFORM rather than on a parent. The badge's parents are the action bar's
   rails, which are shared layout owned by other notes; a `perspective` property on either would apply to
   every child they ever gain. A per-element `perspective()` function gives the same foreshortening and
   touches nothing but this span.

   THE UNFOLD'S 6 DEGREES ARE THE WHOLE "MECHANICAL" CLAIM. A plate driven into a detent overshoots very
   slightly and stops dead; that is one small negative angle and a linear-ish return, not a bounce and not
   an elastic curve. `ease-out` on the way in, `ease-in` on the way out, so the pair reads as one movement
   with a still point in the middle rather than two animations that happen to abut. */
export const PHASE_BADGE_FLIP_CSS = `
@keyframes app-phase-badge-fold {
  from { transform: perspective(200px) rotateX(0deg); }
  to   { transform: perspective(200px) rotateX(-90deg); }
}
@keyframes app-phase-badge-unfold {
  0%   { transform: perspective(200px) rotateX(90deg); }
  76%  { transform: perspective(200px) rotateX(-6deg); }
  100% { transform: perspective(200px) rotateX(0deg); }
}
.app-phase-badge-fold {
  animation-name: app-phase-badge-fold;
  animation-timing-function: ease-in;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
  backface-visibility: hidden;
  will-change: transform;
}
.app-phase-badge-unfold {
  animation-name: app-phase-badge-unfold;
  animation-timing-function: ease-out;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
  backface-visibility: hidden;
  will-change: transform;
}
@keyframes app-phase-badge-fade-out {
  from { opacity: 1; }
  to   { opacity: 0; }
}
@keyframes app-phase-badge-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.app-phase-badge-crossfade-out {
  animation-name: app-phase-badge-fade-out;
  animation-timing-function: linear;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
.app-phase-badge-crossfade-in {
  animation-name: app-phase-badge-fade-in;
  animation-timing-function: linear;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
@media (prefers-reduced-motion: reduce) {
  /* Belt and braces, as STOCK_TRANSFER_CSS puts it: PhaseBadge.tsx never attaches the rotation classes
     under the preference, because it reads it itself. This exists so a class left on by a stale render
     cannot rotate anything -- the one thing reduced motion is entitled to be certain about. */
  .app-phase-badge-fold,
  .app-phase-badge-unfold {
    animation: none !important;
    transform: none !important;
  }
}
`;
