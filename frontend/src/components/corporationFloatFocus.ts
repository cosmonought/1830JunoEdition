// frontend/src/components/corporationFloatFocus.ts
//
// The order the corporation-float ceremony is read in, and how long each part of it takes. Approach C
// (VISUAL_FLOURISH_BACKLOG.md, A-1 as amended): the same corporation-card DOM node lifts, translates and
// scales toward the Stock Round's own centre, stamps, flips, and returns -- all inside the card's existing
// DOM subtree and the existing `uiScale`-zoomed coordinate system. Nothing here measures anything; that is
// `StockRoundPanel.tsx`'s job, against its own DOM, exactly as `stockTransferFocus.ts` leaves measurement to
// the panel that owns the table. This module owns the SCHEDULE and NOTHING ELSE, mirroring #1451's split.
//
/* ==================================================================
    DESIGN NOTE (VF-3): ONE SEQUENCE, FOUR STAGES, ONE STATE SWAP
   ==================================================================
   The four things a reader can see happen: the card LIFTS (translate + scale toward the Stock Round's own
   centre), the FLOATED stamp lands, the card FLIPS (a single restrained half-turn), and the card RETURNS
   (the same translate + scale, reversed). The staged-presentation swap -- float progress becomes Last Run,
   muted livery becomes full livery, the stamp disappears with the departing face -- happens at the FLIP's
   hidden midpoint, edge-on, where the card is thinnest and nothing mirrored is visible. That is `applications`
   below, kept separate from `stages` for the same reason #1452 kept them separate for the stock-transfer
   focus: a stage says what is MOVING, an application says when the figures actually change, and here they
   are deliberately not the same instant either -- the swap sits in the middle of the flip's stage, not at
   its start or its end.

   NOTHING HERE TOUCHES THE RULE. `metFloatThreshold` and `is_floated` stay in `floatThreshold.ts`; this
   module is handed a company id and a ticker -- already-completed facts -- and turns them into a running
   order, the same restraint `stockTransferFocus.ts` keeps about `presidencyTransfer.ts`. */

/** What the shell hands down once a corporation's `is_floated` has flipped false -> true on this action.
 *  PRESENTATION ONLY: the card stages nothing about ownership or price, only its own `is_floated` reading,
 *  so the descriptor carries no snapshot of either state -- there is nothing else this ceremony stages. */
export interface CorporationFloatDescriptor {
  companyId: number;
  ticker: string;
}

/** Design note (VF-3), matching #1457's split for the presidency cue: the card owns the TIMING (this file
 *  says WHEN the stamp lands), the shell owns the PLAYING (`playVariantCue`, under the master SFX mute and
 *  the shared volume) so the mute and the radio ducking stay in the one helper every other cue goes through. */
export const FLOAT_SFX = "floated.mp3";

/* ==================================================================
    FULL-MOTION TIMELINE
   ================================================================== */

/** Lift: translate + scale toward the Stock Round centre, eased out. */
export const FLOAT_LIFT_MS = 480;
/** The stamp's own impact lands here -- chosen to land under `floated.mp3`'s own early hit, which the brief
 *  places "around the first roughly half-second". The lift finishes exactly as the stamp lands: the card is
 *  already at the centre when the ink hits, not still travelling. */
export const FLOAT_STAMP_AT_MS = FLOAT_LIFT_MS;
/** The stamp's own brief impact settle (a small scale-in, not a bounce). */
export const FLOAT_STAMP_IMPACT_MS = 90;
/** How long the stamp holds, readable, before the flip begins. */
export const FLOAT_STAMP_HOLD_MS = 200;
export const FLOAT_FLIP_AT_MS = FLOAT_STAMP_AT_MS + FLOAT_STAMP_HOLD_MS;
/** One restrained half-turn. Not a spin -- see `docs`/the brief: "one controlled half-turn is preferable to
 *  repeated spinning". */
export const FLOAT_FLIP_MS = 640;
/** The hidden midpoint: the card is edge-on here, at its thinnest and visually a hairline, which is where
 *  the staged presentation swaps and the stamp is removed from the tree with the departing face. */
export const FLOAT_FLIP_MIDPOINT_AT_MS = FLOAT_FLIP_AT_MS + FLOAT_FLIP_MS / 2;
export const FLOAT_RETURN_AT_MS = FLOAT_FLIP_AT_MS + FLOAT_FLIP_MS;
/** Return: the same translate + scale, reversed, eased in to a clean settle. */
export const FLOAT_RETURN_MS = 420;
/** How long the card holds its resting state after the last beat, so the release reads as one object
 *  settling rather than the ceremony being cut off -- `stockTransferFocus.ts`'s `FOCUS_RELEASE_MS`, same
 *  reasoning. */
export const FLOAT_FOCUS_RELEASE_MS = 60;
/** Visible motion, start of lift to end of return: 1740ms, inside the brief's 1.6-2.0s band. */
export const FLOAT_VISIBLE_MS = FLOAT_RETURN_AT_MS + FLOAT_RETURN_MS;
export const FLOAT_TOTAL_MS = FLOAT_VISIBLE_MS + FLOAT_FOCUS_RELEASE_MS;

/* ==================================================================
    REDUCED-MOTION TIMELINE
   ==================================================================
   No rotation and no travel -- `prefersReducedMotion` skips the geometry measurement entirely (see
   `StockRoundPanel.tsx`), so this timeline never depends on `getBoundingClientRect` succeeding. Same
   semantic order as full motion: pre-float -> stamp -> state becomes floated -> final card. Audio remains,
   matching VF-5's convention (`tileTransition.ts` sounds its commit under reduced motion too). */
export const FLOAT_REDUCED_EMPHASIS_MS = 160;
export const FLOAT_REDUCED_STAMP_AT_MS = FLOAT_REDUCED_EMPHASIS_MS;
export const FLOAT_REDUCED_STAMP_HOLD_MS = 260;
export const FLOAT_REDUCED_SWAP_AT_MS = FLOAT_REDUCED_STAMP_AT_MS + FLOAT_REDUCED_STAMP_HOLD_MS;
export const FLOAT_REDUCED_SWAP_MS = 200;
export const FLOAT_REDUCED_SWAP_MIDPOINT_AT_MS = FLOAT_REDUCED_SWAP_AT_MS + FLOAT_REDUCED_SWAP_MS / 2;
export const FLOAT_REDUCED_RETURN_AT_MS = FLOAT_REDUCED_SWAP_AT_MS + FLOAT_REDUCED_SWAP_MS;
export const FLOAT_REDUCED_RETURN_MS = 160;
export const FLOAT_REDUCED_VISIBLE_MS = FLOAT_REDUCED_RETURN_AT_MS + FLOAT_REDUCED_RETURN_MS;
export const FLOAT_REDUCED_TOTAL_MS = FLOAT_REDUCED_VISIBLE_MS + FLOAT_FOCUS_RELEASE_MS;

/** PLAYTEST VARIABLE (brief section 5/12): how much the card scales up at the centre. Restrained on purpose;
 *  nobody has watched it yet. `StockRoundPanel.tsx` additionally clamps this against the Stock Round
 *  container's own width so a narrow viewport cannot push the enlarged card past it. */
export const FLOAT_SCALE = 1.5;
export const FLOAT_REDUCED_SCALE = 1.12;

/** PLAYTEST VARIABLE (brief section 5): how much the pre-float livery stripe is muted. A CSS `saturate()`
 *  filter, never `grayscale` -- the brief is explicit that the hue must stay identifiable so corporations
 *  remain distinguishable mid-stock-round. 0.5 keeps every one of the ten liveries clearly its own colour,
 *  just visibly duller, in an eyeballed check against `CORPORATION_LIVERY_COLORS`; nobody has watched it on
 *  the actual card yet. */
export const PRE_FLOAT_LIVERY_SATURATION = 0.5;

/** PLAYTEST VARIABLE (brief section 4): the stamp's rotation, inside the brief's 15-25 degree band, plus a
 *  small off-centre nudge so it reads as physically stamped rather than centred UI typography. */
export const FLOAT_STAMP_ROTATION_DEG = -18;
export const FLOAT_STAMP_OFFSET_X_PERCENT = -3;
export const FLOAT_STAMP_OFFSET_Y_PERCENT = 4;

/* ==================================================================
    AUDIO CUE ALIGNMENT: THE CLIP'S OWN PRINCIPAL IMPACT, NOT ITS FIRST SAMPLE
   ==================================================================
   `floated.mp3` is not a hit at sample zero -- it opens with a ~250ms lead-in, dips to near-silence, then
   builds into its own principal impact. Waveform-measured directly against the file in this repo (ffmpeg
   decode to raw PCM, then a 10ms-window RMS envelope plus a whole-clip peak-sample search): the loudest
   instant lands at 458ms, corroborated by the loudest 10ms RMS window (centred 454ms) and the sharpest
   RMS rise/onset (449ms) -- three independent measures inside a 9ms band, all in the 450-500ms range this
   was scoped against. Starting playback exactly on the stamp beat (as the first cut of this ceremony did)
   therefore put the clip's OWN impact near the flip's hidden midpoint, not on the stamp landing at all.
   THE FIX MOVES ONLY WHEN PLAYBACK STARTS, never the file and never the visual timeline: `stages` above
   (the stamp's own landing at `FLOAT_STAMP_AT_MS`) is untouched, and so is every other beat. The cue now
   fires `FLOAT_AUDIO_IMPACT_OFFSET_MS` earlier than the stamp beat, so the clip's own impact -- not its
   start -- lands on it; `Math.max(0, ...)` is a standing guard, not a live clamp at today's numbers (480 -
   458 = 22, comfortably positive), against a future retiming of either constant pushing it negative. */
export const FLOAT_AUDIO_IMPACT_OFFSET_MS = 458;
export const FLOAT_CUE_AT_MS = Math.max(0, FLOAT_STAMP_AT_MS - FLOAT_AUDIO_IMPACT_OFFSET_MS);

/** REDUCED MOTION CANNOT USE THE SAME OFFSET. Its stamp beat (`FLOAT_REDUCED_STAMP_AT_MS`, 160ms) is itself
 *  earlier than the clip's own impact (458ms) -- the same offset would ask for playback to start at
 *  160 - 458 = -298ms, before the sequence exists, which is impossible without seeking into the file or
 *  trimming the asset (both are ruled out). The earliest legal start is the sequence's own beginning: firing
 *  the cue at 0ms gets the clip's principal impact as close as this fixed-length clip can get to the stamp
 *  beat, landing at the absolute 458ms mark -- 298ms after the stamp, but still inside the ceremony (before
 *  the reduced return phase ends at `FLOAT_REDUCED_TOTAL_MS - FLOAT_FOCUS_RELEASE_MS` = 780ms), and close to
 *  the state-swap midpoint (520ms) rather than landing in dead air after everything has already settled. */
export const FLOAT_REDUCED_CUE_AT_MS = 0;

export type FloatFocusStageKind = "lift" | "stamp" | "flip" | "return";

export interface FloatFocusStage {
  kind: FloatFocusStageKind;
  at: number;
  durationMs: number;
}

export interface FloatFocusApplication {
  /** Design note (VF-3): a set for parity with `stockTransferFocus.ts`'s `FocusApplication`, even though
   *  exactly one field ever lands -- the shape that survives a second staged field being added later
   *  (there is none planned) without becoming a special case. */
  applies: readonly ["floated"];
  at: number;
}

export interface FloatFocusSequence {
  companyId: number;
  ticker: string;
  reducedMotion: boolean;
  stages: readonly FloatFocusStage[];
  applications: readonly FloatFocusApplication[];
  /** When the shell starts playing `FLOAT_SFX`, once per sequence -- NOT when the stamp visually lands
   *  (that is `stages`' own "stamp" entry, at `FLOAT_STAMP_AT_MS`/`FLOAT_REDUCED_STAMP_AT_MS`, unchanged by
   *  this field). This is offset earlier so the CLIP's own measured principal impact, not its first sample,
   *  arrives on the stamp beat -- see `FLOAT_CUE_AT_MS`/`FLOAT_REDUCED_CUE_AT_MS` above. */
  stampImpactAt: number;
  /** The hidden midpoint, named separately from `applications[].at` (which is the same number) because the
   *  card's own flip-rotation CSS needs it independent of the state-swap bookkeeping. */
  midpointAt: number;
  totalMs: number;
}

/** The running order for one completed float, or `null` when there is no event to show. Pure: no
 *  `getBoundingClientRect`, no timers, no rules re-derivation -- see the module note above. */
export function buildFloatFocusSequence(
  event: CorporationFloatDescriptor | null,
  reducedMotion: boolean,
): FloatFocusSequence | null {
  if (!event) return null;
  if (reducedMotion) {
    return {
      companyId: event.companyId,
      ticker: event.ticker,
      reducedMotion: true,
      stages: [
        { kind: "lift", at: 0, durationMs: FLOAT_REDUCED_EMPHASIS_MS },
        { kind: "stamp", at: FLOAT_REDUCED_STAMP_AT_MS, durationMs: FLOAT_REDUCED_STAMP_HOLD_MS },
        { kind: "flip", at: FLOAT_REDUCED_SWAP_AT_MS, durationMs: FLOAT_REDUCED_SWAP_MS },
        { kind: "return", at: FLOAT_REDUCED_RETURN_AT_MS, durationMs: FLOAT_REDUCED_RETURN_MS },
      ],
      applications: [{ applies: ["floated"], at: FLOAT_REDUCED_SWAP_MIDPOINT_AT_MS }],
      stampImpactAt: FLOAT_REDUCED_CUE_AT_MS,
      midpointAt: FLOAT_REDUCED_SWAP_MIDPOINT_AT_MS,
      totalMs: FLOAT_REDUCED_TOTAL_MS,
    };
  }
  return {
    companyId: event.companyId,
    ticker: event.ticker,
    reducedMotion: false,
    stages: [
      { kind: "lift", at: 0, durationMs: FLOAT_LIFT_MS },
      { kind: "stamp", at: FLOAT_STAMP_AT_MS, durationMs: FLOAT_STAMP_IMPACT_MS + FLOAT_STAMP_HOLD_MS },
      { kind: "flip", at: FLOAT_FLIP_AT_MS, durationMs: FLOAT_FLIP_MS },
      { kind: "return", at: FLOAT_RETURN_AT_MS, durationMs: FLOAT_RETURN_MS },
    ],
    applications: [{ applies: ["floated"], at: FLOAT_FLIP_MIDPOINT_AT_MS }],
    stampImpactAt: FLOAT_CUE_AT_MS,
    midpointAt: FLOAT_FLIP_MIDPOINT_AT_MS,
    totalMs: FLOAT_TOTAL_MS,
  };
}

/** The stage active at `elapsedMs`, or `null` before the first / after the last. */
export function floatStageAt(
  sequence: FloatFocusSequence,
  elapsedMs: number,
): FloatFocusStage | null {
  let current: FloatFocusStage | null = null;
  for (const stage of sequence.stages) {
    if (stage.at <= elapsedMs) current = stage;
  }
  return current;
}

/* ==================================================================
    THE CARD'S OWN STYLESHEET
   ==================================================================
   Design note (VF-3), following #1451's rule for `STOCK_TRANSFER_CSS`: this owns the flip rotation and the
   stamp's impact keyframes and nothing else. The lift/return TRANSLATE and SCALE are written as plain inline
   `transform`/`transition` by `StockRoundPanel.tsx`, exactly where `stockTransferFocus.ts`'s proxy chip's
   travel distance is applied inline (`useTransferProxyGeometry`) -- because that distance is measured at
   runtime and a stylesheet cannot express a number it does not have. */
export const CORPORATION_FLOAT_CSS = `
@keyframes app-float-flip {
  from { transform: rotateY(0deg); }
  to   { transform: rotateY(180deg); }
}
.app-float-flip {
  animation-name: app-float-flip;
  animation-timing-function: ease-in-out;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
  will-change: transform;
}
@keyframes app-float-stamp-impact {
  0%   { opacity: 0; transform: scale(1.35) rotate(${FLOAT_STAMP_ROTATION_DEG}deg); }
  55%  { opacity: 1; transform: scale(0.94) rotate(${FLOAT_STAMP_ROTATION_DEG}deg); }
  100% { opacity: 1; transform: scale(1) rotate(${FLOAT_STAMP_ROTATION_DEG}deg); }
}
.app-float-stamp {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  opacity: 0;
  animation-name: app-float-stamp-impact;
  animation-timing-function: ease-out;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
@media (prefers-reduced-motion: reduce) {
  /* Belt and braces, as STOCK_TRANSFER_CSS puts it -- the panel does not attach these classes at all under
     the preference, because StockRoundPanel.tsx never measures geometry or schedules the flip stage when
     prefersReducedMotion() is true. This still exists so an inline style left attached by a stale render
     cannot animate. */
  .app-float-flip { animation: none !important; }
  .app-float-stamp {
    animation: none !important;
    opacity: 1 !important;
    transform: scale(1) rotate(${FLOAT_STAMP_ROTATION_DEG}deg) !important;
  }
}
`;
