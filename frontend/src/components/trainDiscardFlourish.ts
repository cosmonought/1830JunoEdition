// frontend/src/components/trainDiscardFlourish.ts
//
// What a train-limit discard looks like on its way to the Bank Pool -- VF-8
// (VISUAL_FLOURISH_BACKLOG.md). Schedule, cut geometry and stylesheet only; `TrainBadges.tsx` renders it,
// `App.tsx` raises it. The split VF-1, VF-3, VF-4, VF-6 and VF-7 all keep.
//
/* ==================================================================
    DESIGN NOTE (VF-8): A DISCARD IS NOT A RUST, AND THE GRAMMAR HAS TO SAY SO
   ==================================================================
   VF-7 gave rust its vocabulary: oxidation, an irregular branching fracture, a shudder, dissolution. That
   was chosen to mean THE TRAIN IS DESTROYED. This one means something almost opposite, and the rulebook
   is precise about it (6.6.1): the president CHOOSES the train, it leaves the corporation, it enters the
   Bank Pool, nobody is paid, and anybody may buy it back at face value. Nothing broke. A piece of stock
   moved from one ledger to another.

   SO EVERY CHANNEL IS INVERTED. Rust's crack is jagged, branching and procedurally irregular; this cut is
   one straight near-vertical line. Rust oxidises in burnt iron; this adds no colour at all -- the cut is
   drawn in the chip's own ink. Rust shudders and rotates; this separates by a few pixels on one axis and
   does not rotate. Rust dissolves in place; this LEAVES, together, toward the Bank.

   AND NONE OF RUST'S PARTS ARE REUSED, deliberately rather than incidentally: no `crackPath`, no oxide
   keyframe, no `app-train-rust-*` class. Two vocabularies that share an implementation drift into looking
   alike, which is the one outcome that would make both of them useless. */

/** The train the president chose, and the fleet it is leaving. */
export interface DiscardedTrain {
  companyId: number;
  ticker: string;
  /** `owned_trains` as it stood BEFORE the dispatch -- the roster the chips stage. */
  before: readonly string[];
  /** The model named in the authoritative `DiscardTrain` message. */
  model: string;
  /** WHICH OCCURRENCE of it, in `before`. See `discardedOccurrence`. */
  at: number;
}

/** What the shell hands down: one discard, plus a token so a second genuine discard replays rather than
 *  sitting finished -- #1060's idiom, kept by every flourish event since.
 *
 *  ONE DISCARD PER EVENT, and that is the structural difference from VF-7's rust. A phase change rusts
 *  every doomed train in one reducer call, so rust is one global event with a list inside it. A discard
 *  is one president answering one obligation; `pendingTrainDiscards` then names the next corporation, and
 *  that is a separate action with a separate flourish. Nothing here can express "several corporations at
 *  once", because the rules never produce it. */
export interface TrainDiscardEvent {
  discard: DiscardedTrain;
  token: number;
}

/** This corporation's discard, or `null` when the event is about a different one. */
export function discardFor(
  event: TrainDiscardEvent | null | undefined,
  companyId: number | null | undefined,
): DiscardedTrain | null {
  if (!event || companyId == null) return null;
  return event.discard.companyId === companyId ? event.discard : null;
}

/* ==================================================================
    WHICH OCCURRENCE, WHEN THE MODELS ARE INDISTINGUISHABLE
   ==================================================================
   The message names a MODEL, not a position: `DiscardTrain { protocol_id, model_type }`. A corporation
   holding ["3", "3", "5"] and discarding a 3 has given the reducer no way to say which 3, because there
   is no difference between them -- 6.6.1's choice is over models.

   SO THE PRESENTATION TAKES THE REDUCER'S OWN CHOICE RATHER THAN MAKING ONE. The arm is explicit
   (#1530): "exactly the named train leaves the fleet (the first matching copy -- two 3-trains are
   interchangeable)", implemented as `owned.indexOf(model_type)`. This is that same expression, so the
   chip that animates is by construction the chip whose slot the reducer emptied. A presentation that
   picked its own occurrence would agree with the reducer today and could disagree the day the arm's
   tie-break changed.

   AND IT IS NOT A CHEAPEST-FIRST RULE, which is the thing this batch must not reintroduce. #1530 REPLACED
   the engine's cheapest-first trim with the president's explicit choice; `indexOf` is a position lookup
   for the model the president named, not a preference over models. Nothing here reads a price, a tier
   order or an age. */

/** Where in `before` the reducer will take the named model from, or `-1` when it holds none. */
export function discardedOccurrence(before: readonly string[], model: string): number {
  return before.indexOf(model);
}

/* ==================================================================
    FULL-MOTION TIMELINE
   ==================================================================
   The brief's own beats, taken as given and marked playtest-only: 0-80 tension, 80-120 cut, 120-200 the
   halves part, 200-360 the transfer, 360 the slot vacates and the Bank Pool receives, ~500 settled.
   Longer than VF-7's rust (530 vs... the same, as it happens) but spent differently: rust puts everything
   into the destruction and nothing into a destination, and this puts a third of its length into leaving. */

/** Tension: the chip draws in very slightly under the blade. No rotation -- that is rust's channel. */
export const DISCARD_TENSION_MS = 80;
/** The cut lands. THE BEAT THE EVENT IS ABOUT, and the audio cue point if a cue ever exists. */
export const DISCARD_CUT_AT_MS = DISCARD_TENSION_MS;
export const DISCARD_CUT_MS = 40;
/** The two halves separate, a few pixels, on one axis. */
export const DISCARD_PART_AT_MS = DISCARD_CUT_AT_MS + DISCARD_CUT_MS;
export const DISCARD_PART_MS = 80;
/** Both halves leave the corporation together. */
export const DISCARD_TRANSFER_AT_MS = DISCARD_PART_AT_MS + DISCARD_PART_MS;
export const DISCARD_TRANSFER_MS = 160;
/** ==================================================================
 *   THE SLOT IS GIVEN UP WHEN THE TRAIN HAS ARRIVED, NOT WHEN IT STARTS MOVING
 *  ==================================================================
 *  VF-7's rule, for VF-7's reason: the staged roster is dropped in ONE instant, after the departing chip
 *  is gone, so the survivors close up once rather than sliding under something still visible. It is also
 *  the instant the Bank Pool is told it has received something, because that is the same event seen from
 *  the other end. */
export const DISCARD_VACATE_AT_MS = DISCARD_TRANSFER_AT_MS + DISCARD_TRANSFER_MS;
/** The settle window covers the destination's own receiving reaction, so the event is over when the
 *  Bank Pool has finished acknowledging it rather than when the roster closed. */
export const DISCARD_SETTLE_MS = 140;
export const DISCARD_TOTAL_MS = DISCARD_VACATE_AT_MS + DISCARD_SETTLE_MS;

/* ==================================================================
    REDUCED-MOTION TIMELINE
   ==================================================================
   Brief: "brief clean vertical wipe/cut indication -> short opacity transition out -> Bank Pool receiving
   state appears -> roster settles. No split-halves travel. No shudder. No long transfer motion."
   THE CUT STAYS AND THE TRAVEL GOES, which is the same bargain VF-7 struck (#26: a cue that disappears
   under reduced motion is an information problem). The cut is the whole semantic difference from rust --
   drop it and the two events look identical to a reader who has switched off motion. */
export const DISCARD_REDUCED_TENSION_MS = 40;
export const DISCARD_REDUCED_CUT_AT_MS = DISCARD_REDUCED_TENSION_MS;
export const DISCARD_REDUCED_CUT_MS = 60;
/** Present for parity with the full timeline, and deliberately carrying no split: the reduced path
 *  attaches no half classes at all, so this window is the cut holding before the chip fades. */
export const DISCARD_REDUCED_PART_AT_MS = DISCARD_REDUCED_CUT_AT_MS + DISCARD_REDUCED_CUT_MS;
export const DISCARD_REDUCED_PART_MS = 20;
export const DISCARD_REDUCED_TRANSFER_AT_MS =
  DISCARD_REDUCED_PART_AT_MS + DISCARD_REDUCED_PART_MS;
export const DISCARD_REDUCED_TRANSFER_MS = 80;
export const DISCARD_REDUCED_VACATE_AT_MS =
  DISCARD_REDUCED_TRANSFER_AT_MS + DISCARD_REDUCED_TRANSFER_MS;
export const DISCARD_REDUCED_SETTLE_MS = 60;
export const DISCARD_REDUCED_TOTAL_MS = DISCARD_REDUCED_VACATE_AT_MS + DISCARD_REDUCED_SETTLE_MS;

/* ==================================================================
    NAMED MILESTONES, RESOLVED AGAINST THE ACTIVE SCHEDULE
   ==================================================================
   VF-4's correction, VF-6's practice, VF-7's shape: anything that has to happen "once the cut is
   visible", "once the train has arrived" or "once the row has settled" names the BEAT, and the timeline
   being played supplies the number. A full-motion constant used under reduced motion would hold the
   Tutorial modal half a second after a 260ms sequence finished. */
export interface DiscardTimeline {
  /** The cut's first frame -- the audio cue point, and the earliest the event is legible. */
  cutAt: number;
  /** The staged roster is dropped and the Bank Pool acknowledges the arrival. */
  transferredAt: number;
  /** The whole sequence, receiving reaction included. */
  totalMs: number;
}

export function discardTimeline(reducedMotion: boolean): DiscardTimeline {
  return reducedMotion
    ? {
        cutAt: DISCARD_REDUCED_CUT_AT_MS,
        transferredAt: DISCARD_REDUCED_VACATE_AT_MS,
        totalMs: DISCARD_REDUCED_TOTAL_MS,
      }
    : {
        cutAt: DISCARD_CUT_AT_MS,
        transferredAt: DISCARD_VACATE_AT_MS,
        totalMs: DISCARD_TOTAL_MS,
      };
}

export type DiscardMilestone = "cut" | "transferred" | "settled";

/** How long a surface waiting for `milestone` waits, under the timeline currently being played. */
export function discardMilestoneMs(milestone: DiscardMilestone, reducedMotion: boolean): number {
  const timeline = discardTimeline(reducedMotion);
  if (milestone === "cut") return timeline.cutAt;
  if (milestone === "transferred") return timeline.transferredAt;
  return timeline.totalMs;
}

/* ==================================================================
    AUDIO: OPEN, AND SILENT UNTIL IT IS ANSWERED
   ==================================================================
   Wanted: ONE cue per discard action -- a short dry paper-cutter, a ticket punch, a guillotine lever, a
   mechanical ka-chunk, one decisive onset and little or no tail -- landing on the `cut` milestone. Ruled
   out by name: sword slash, gore, cinematic whoosh, metallic screech, rust's own crack, explosion.
   THE TREE WAS AUDITED CLIP BY CLIP AND HAS NO UNOWNED CANDIDATE, for the third batch running. The
   mechanical clips are all claimed by `variantSfx.ts`'s flavour-text matcher -- `metal_clunk.mp3`
   (`/coupling|axles|wheels/`), `camera-shutter.mp3` (`/photograph/`), `telegraph.mp3`, `watch-wind.mp3`,
   `machinery.mp3` (`/iron|factory|mills/`) -- and the rest are the excluded list itself.
   THE NEAREST MISS IS `camera-shutter.mp3`, which is exactly the right ENVELOPE: a sprung mechanical
   snap, one onset, no tail, no tone. It is a shutter rather than a blade, and it already means "the
   ticker mentioned a photograph", so it is named here for a cheap overrule rather than taken.
   SO THE DISCARD SHIPPED SILENT, under the master SFX switch with no category of its own when it landed
   (#1457's rule for the presidency cue).

   ==================================================================
    ANSWERED BY THE AUDIO WIRING PASS: `train-discard.mp3`
   ==================================================================
   Supplied rather than taken, so `camera-shutter.mp3` keeps its photograph. A sharp blade slice of 2.0s
   whose whole body is its first 150ms: it opens hot, peaks at 68.7ms and is down by two thirds at 150ms.
   ONE CUE PER ACTION, AND THE ACTION IS THE PRESIDENT'S. Not one per train over the limit, not one when
   the limit drops, not one per corporation in the queue -- a discard is a decision somebody made, and
   the sound is the sound of them making it. Two corporations answering in sequence is two decisions and
   two cuts; the cap in `playVariantCue` is what keeps a fast pair from stacking into noise, and
   suppressing the second on the grounds that the first still has a tail would silence a real action. */

/** The clip, in `public/audio/`. Named for the action, not for the rule that forced it. */
export const DISCARD_SFX = "train-discard.mp3";

/* The slice's own impact, measured as VF-3 measured `floated.mp3`: peak sample at 68.7ms, loudest 10ms
   RMS window at 65ms. The third measure VF-3 quotes -- the sharpest RMS rise -- reads 15ms here and is
   discarded rather than averaged in, because this file opens hot: there is no silence in front of it for
   a rise to be sharp against, so that statistic is measuring the encoder's first frame and not the
   blade. Two agreeing measures inside 4ms are the alignment. */
export const DISCARD_AUDIO_IMPACT_OFFSET_MS = 69;

/** When to start the clip so the slice lands on `cut`, against the ACTIVE schedule.
 *
 *  BOTH TIMELINES CUT EARLY -- 80ms full motion and 40ms reduced -- so full motion starts the clip 11ms
 *  in and reduced motion clamps to 0 and lands the slice 29ms late. That is the cost of a tension beat
 *  shorter than the clip's own attack, and it is under two frames; the alternative is a longer tension
 *  beat, which would be changing the visual schedule to suit the audio rather than the other way round. */
export function discardCueAtMs(reducedMotion: boolean): number {
  const cutAt = reducedMotion ? DISCARD_REDUCED_CUT_AT_MS : DISCARD_CUT_AT_MS;
  return Math.max(0, cutAt - DISCARD_AUDIO_IMPACT_OFFSET_MS);
}

export type DiscardStageKind = "tension" | "cut" | "part" | "transfer";

export interface DiscardStage {
  kind: DiscardStageKind;
  at: number;
  durationMs: number;
}

export interface DiscardApplication {
  /** A set, for parity with every flourish since VF-1, though exactly one field lands. */
  applies: readonly ["transferred"];
  at: number;
}

export interface DiscardSequence {
  discard: DiscardedTrain;
  reducedMotion: boolean;
  stages: readonly DiscardStage[];
  applications: readonly DiscardApplication[];
  cutAt: number;
  transferredAt: number;
  totalMs: number;
}

/** The running order for one discard, or `null` when there is nothing to show. Pure: no measurement, no
 *  timers, no rules re-derivation -- it is handed a completed fact and turns it into a schedule. */
export function buildDiscardSequence(
  event: { discard: DiscardedTrain } | null,
  reducedMotion: boolean,
): DiscardSequence | null {
  if (!event) return null;
  /* A discard the staged roster cannot place is not shown at all -- A-3's direction, since a flourish
     pointing at the wrong chip is worse than none. */
  if (event.discard.at < 0 || event.discard.at >= event.discard.before.length) return null;
  const timeline = discardTimeline(reducedMotion);
  const stages: readonly DiscardStage[] = reducedMotion
    ? [
        { kind: "tension", at: 0, durationMs: DISCARD_REDUCED_TENSION_MS },
        { kind: "cut", at: timeline.cutAt, durationMs: DISCARD_REDUCED_CUT_MS },
        { kind: "part", at: DISCARD_REDUCED_PART_AT_MS, durationMs: DISCARD_REDUCED_PART_MS },
        {
          kind: "transfer",
          at: DISCARD_REDUCED_TRANSFER_AT_MS,
          durationMs: DISCARD_REDUCED_TRANSFER_MS,
        },
      ]
    : [
        { kind: "tension", at: 0, durationMs: DISCARD_TENSION_MS },
        { kind: "cut", at: timeline.cutAt, durationMs: DISCARD_CUT_MS },
        { kind: "part", at: DISCARD_PART_AT_MS, durationMs: DISCARD_PART_MS },
        { kind: "transfer", at: DISCARD_TRANSFER_AT_MS, durationMs: DISCARD_TRANSFER_MS },
      ];
  return {
    discard: event.discard,
    reducedMotion,
    stages,
    applications: [{ applies: ["transferred"], at: timeline.transferredAt }],
    ...timeline,
  };
}

/** The stage active at `elapsedMs`, or `null` outside the sequence. */
export function discardStageAt(sequence: DiscardSequence, elapsedMs: number): DiscardStage | null {
  let current: DiscardStage | null = null;
  for (const stage of sequence.stages) {
    if (stage.at <= elapsedMs) current = stage;
  }
  return current;
}

/* ==================================================================
    THE CUT: ONE STRAIGHT LINE, AND WHY IT IS BARELY PROCEDURAL
   ==================================================================
   VF-7's crack needed a generator because an irregular fracture that repeated itself would stop reading
   as a fracture. A guillotine has the opposite requirement: the whole point is that it is the SAME
   straight cut every time, made by a machine. So this is a position and a slant, not a path -- and the
   only reason it varies at all is that a dead-centre cut through a two-character label reads as a
   typographic divider rather than as something done to the chip.
   A COUPLE OF DEGREES OFF VERTICAL, at most, and only for readability: the brief allows "a slight slant
   if geometry requires it" and rules out a diagonal crack. Derived from the chip's own position so one
   chip's cut is identical on every render of one sequence, which is the same stability requirement
   `crackSeedFor` records -- a cut that moved mid-sequence would be two cuts. */
export const DISCARD_CUT_MIN_PERCENT = 42;
export const DISCARD_CUT_MAX_PERCENT = 58;
export const DISCARD_CUT_MAX_SLANT_PERCENT = 3;

export interface DiscardCut {
  /** Where the blade fell, as a percentage of the chip's width at its top edge. */
  xPercent: number;
  /** How far the bottom of the cut leans from the top, in percent. Small and signed. */
  slantPercent: number;
}

/** The blade's position for one chip. Deterministic: same chip, same cut, every render. */
export function discardCut(seed: number): DiscardCut {
  const whole = Math.abs(Math.floor(seed));
  const span = DISCARD_CUT_MAX_PERCENT - DISCARD_CUT_MIN_PERCENT;
  const xPercent = DISCARD_CUT_MIN_PERCENT + (whole % (span + 1));
  const slantSteps = DISCARD_CUT_MAX_SLANT_PERCENT * 2 + 1;
  const slantPercent = ((whole >> 3) % slantSteps) - DISCARD_CUT_MAX_SLANT_PERCENT;
  return { xPercent, slantPercent };
}

/** The seed a chip uses: its corporation and its position, so the cut is stable across every render of
 *  one sequence and two chips never take the identical blade. */
export function discardCutSeedFor(companyId: number, index: number): number {
  return companyId * 613 + index * 17 + 3;
}

/* ==================================================================
    THE CHIP'S OWN STYLESHEET
   ==================================================================
   #46/#18's escape hatch, on every previous flourish's rule: keyframes, a clip-path split and an
   absolutely-positioned second half are what an inline style cannot express. Durations are written
   inline by `TrainBadges.tsx` from the constants above -- one set of numbers, not two.

   NOTE FOR EDITORS: everything from here to the closing backtick is inside a TEMPLATE LITERAL, so no
   backticks -- #755, #1004, VF-6 and VF-7 each record terminating this kind of string early by quoting
   an identifier. */
export const TRAIN_DISCARD_CSS = `
/* The slot the two halves occupy. The LEFT half is in normal flow and therefore defines the slot's size;
   the right half is absolutely positioned over it. Both are real chips -- see TrainBadges.tsx for why
   the halves are siblings rather than children: a clip-path on a parent clips its descendants too, so a
   chip clipped to its left half cannot contain its own right half. */
.app-train-cut-slot {
  position: relative;
  display: inline-flex;
}
.app-train-cut-right {
  position: absolute;
  inset: 0;
}
/* Tension: the chip draws in, on both axes, by a hair. No rotation -- that channel belongs to rust. */
@keyframes app-train-discard-tension {
  from { transform: scale(1); }
  to   { transform: scale(0.97); }
}
.app-train-discard-tensing {
  animation-name: app-train-discard-tension;
  animation-timing-function: ease-in;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
/* The blade. One straight line, full height, arriving at once rather than travelling -- a guillotine
   falls, it does not propagate. Drawn in the chip's own ink, because nothing here is a new colour. */
.app-train-cut-line {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
.app-train-cut-line line {
  stroke: currentColor;
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
  opacity: 0.9;
}
@keyframes app-train-discard-blade {
  from { opacity: 0; transform: scaleY(0.2); }
  to   { opacity: 1; transform: scaleY(1); }
}
.app-train-cut-line-falling {
  transform-origin: center top;
  animation-name: app-train-discard-blade;
  animation-timing-function: cubic-bezier(0.3, 0, 0.2, 1);
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
/* The halves. Each is clipped to its own side of the cut and slides a few pixels away from it -- the
   kerf opening, not debris. Three pixels is the whole separation, because these are 24px chips in a row
   and anything larger overlaps a neighbour. */
@keyframes app-train-discard-part-left {
  from { transform: translateX(0); }
  to   { transform: translateX(-3px); }
}
@keyframes app-train-discard-part-right {
  from { transform: translateX(0); }
  to   { transform: translateX(3px); }
}
.app-train-cut-left.app-train-discard-parting {
  animation-name: app-train-discard-part-left;
  animation-timing-function: cubic-bezier(0.2, 0.7, 0.3, 1);
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
.app-train-cut-right.app-train-discard-parting {
  animation-name: app-train-discard-part-right;
  animation-timing-function: cubic-bezier(0.2, 0.7, 0.3, 1);
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
/* The transfer. Both halves leave TOGETHER and in one direction -- downward and slightly along, the way
   something is dropped into a tray. Not a flight across the shell (A-1): the halves travel a few pixels
   inside their own slot and the Bank Pool acknowledges the arrival at its own end. */
@keyframes app-train-discard-leave-left {
  from { transform: translate(-3px, 0); opacity: 1; }
  to   { transform: translate(-4px, 10px); opacity: 0; }
}
@keyframes app-train-discard-leave-right {
  from { transform: translate(3px, 0); opacity: 1; }
  to   { transform: translate(4px, 10px); opacity: 0; }
}
.app-train-cut-left.app-train-discard-leaving {
  animation-name: app-train-discard-leave-left;
  animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
.app-train-cut-right.app-train-discard-leaving {
  animation-name: app-train-discard-leave-right;
  animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
}
/* The Bank Pool's end of the same event: received into inventory. A scale pop and nothing else -- no
   glow, no colour, no money. Lives here rather than with the panel because it is this event's other
   half and the two lengths have to agree. */
@keyframes app-train-discard-received {
  0%   { transform: scale(1); }
  45%  { transform: scale(1.1); }
  100% { transform: scale(1); }
}
.app-train-discard-received {
  animation-name: app-train-discard-received;
  animation-timing-function: ease-out;
  animation-iteration-count: 1;
  animation-fill-mode: none;
}
@media (prefers-reduced-motion: reduce) {
  /* Belt and braces, as STOCK_TRANSFER_CSS puts it: TrainBadges.tsx reads the preference itself and
     never attaches the parting or leaving classes under it. THE CUT STAYS -- it is the whole semantic
     difference from rust, and a cue that disappears under reduced motion is an information problem
     (#26) -- and the chip leaves by opacity alone, with no travel and no split. */
  .app-train-discard-tensing,
  .app-train-discard-parting,
  .app-train-discard-leaving {
    animation: none !important;
    transform: none !important;
  }
  .app-train-cut-line-falling {
    animation: none !important;
    transform: none !important;
    opacity: 1;
  }
  .app-train-discard-received { animation: none !important; }
}
`;

/** The class carrying this stage on the chip, or `undefined` for a chip at rest. There is deliberately
 *  no class after the transfer: by then the staged roster has been dropped and this chip does not exist.
 *
 *  THE SAME CLASSES UNDER BOTH TIMELINES, with the media query above neutralising the motion ones -- VF-7's
 *  arrangement, for its reason: branching here as well would be two places deciding one accommodation,
 *  and the stylesheet is the one a stale render cannot bypass. */
export function discardChipStageClass(stage: DiscardStageKind | null): string | undefined {
  if (stage === "tension" || stage === "cut") return "app-train-discard-tensing";
  if (stage === "part") return "app-train-discard-parting";
  if (stage === "transfer") return "app-train-discard-leaving";
  return undefined;
}

/** Whether the blade is drawn, and whether it FALLS. Under reduced motion it is simply present from the
 *  cut beat -- a static mark rather than a movement, which is the same bargain VF-7 strikes for its
 *  crack's propagation. */
export function discardCutClass(
  stage: DiscardStageKind | null,
  reducedMotion: boolean,
): string | null {
  if (stage === null || stage === "tension") return null;
  return reducedMotion ? "app-train-cut-line" : "app-train-cut-line app-train-cut-line-falling";
}

/** Whether this stage renders the chip as two halves at all. Reduced motion never does: the brief rules
 *  out split-halves travel, and a split that does not move is just a chip with a line on it -- which is
 *  exactly what the reduced path already shows. */
export function discardIsSplit(stage: DiscardStageKind | null, reducedMotion: boolean): boolean {
  if (reducedMotion) return false;
  return stage === "part" || stage === "transfer";
}
