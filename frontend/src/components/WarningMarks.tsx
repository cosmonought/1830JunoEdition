// frontend/src/components/WarningMarks.tsx
//
// The static semantic identifiers on the Action Bar's warning badges -- the warning-mark pass
// (VISUAL_FLOURISH_BACKLOG.md, Part K).
//
/* ==================================================================
    DESIGN NOTE (WARNING MARKS): COLOUR SAYS HOW URGENT; THIS SAYS WHICH RULE
   ==================================================================
   THE PROBLEM, stated exactly: Rust and Train Limit sit in the same warning capsule, escalate on the same
   countdown (#867), and until now opened with the same `⚠`. So the only thing telling them apart was the
   sentence, and a row of amber pills that must be READ to be distinguished is a row that is not doing the
   job a badge is for.

   AND THE FIX IS NOT COLOUR. `ALERT_WARN_*` and `ALERT_CRITICAL_*` mean two-buys and one-buy, on every
   surface in this app -- the bar, the chips (#7), the private pills (#1035). A rust-brown badge and a
   limit-blue one would have made colour answer two questions at once, which is #732's rule, and would have
   cost the escalation the one channel it owns. So the urgency grammar is untouched and the CLASSIFICATION
   goes on a mark.

   ONE MARK, NOT A MARK PLUS A `⚠`. The brief is explicit and it is also the only arrangement that works:
   the generic glyph says "this is a warning", which the colour already said, so leaving it in front of a
   semantic mark spends the badge's first character restating the thing least in doubt.

   RESTRAINT IS THE POINT (brief §7). The animations carry the physical metaphors -- VF-7's fracture, VF-8's
   blade. These are the same events at rest, inside the same capsule as every other warning: no jagged
   outline for rust, no blade silhouette for the limit, no second railroad ticket. A static badge that
   competed with its own flourish would make the flourish redundant. */

import React from "react";

import { crackPath } from "./trainRustFlourish";
import { discardCut } from "./trainDiscardFlourish"; // W3-H (VF J-6)
import { FONT_SIZE } from "../styles/typography";

/* ==================================================================
    THE RUST MARK: VF-7'S OWN GENERATOR, AT A FIXED SEED AND HALF THE DETAIL
   ==================================================================
   VF-7's I-10 left this deliberately unbuilt and said what it should be made of: "`crackPath` is the piece
   that pass would reuse ... so a badge icon can be the same mark at a fixed seed." Taken literally, so the
   static mark and the animated fracture are the same rule about what a crack looks like rather than two
   drawings that resemble each other.

   ==================================================================
    THE SEED WAS SCORED, AND THEN THE SCORE WAS OVERRULED BY LOOKING AT IT
   ==================================================================
   Two hundred seeds at `steps: 2` were scored on the three things that should decide whether a small mark
   reads as a fracture or as dirt -- the turn at the interior vertex, the branch's length as a fraction of
   the box, and the branch's angle off the main run. Seed 18 won on every one of them: a 26-degree turn, a
   branch 39% of the box long and 92 degrees off the run.
   RENDERED AT 120px IT IS A CLOCK. Two steps leaves exactly one interior vertex and the branch leaves from
   an interior vertex, so the figure is necessarily three limbs radiating from one point near the middle of
   a rounded square -- which is an analogue clock at about 7:35, and "time remaining" is a meaning a
   countdown badge can very nearly carry. Every metric said fork; the picture said clock. The metrics were
   measuring the parts and not the gestalt, which is the failure mode of scoring a drawing.
   SO THE CANDIDATES WERE DRAWN OUT AND CHOSEN BY EYE, at 9, 12, 16, 26 and 110px, framed and unframed:
     - `steps: 2` with no branch is a plain diagonal in a box, which is a prohibition sign;
     - `steps: 4` reads as a smooth descending staircase -- a line chart, not a break;
     - a chip-aspect (oblong) frame squashes the fracture flat and turns the mark into a smudge below ~16px;
     - no frame at all leaves a squiggle that reads as a stray hair rather than as a deliberate mark.
   `crackPath(41, 3)` IN A SQUARE TILE WON: a main fracture running corner to corner with one short fork
   near the top, which survives to about 12px and does not resolve into anything that is not a break.
   WHAT THIS PASS LEARNED, for the next one: a 0-100 generator's parameters do not predict what it looks
   like at 13 pixels, and the only way to find out is to rasterise it and look. */
const RUST_BADGE_SEED = 41;
const RUST_BADGE_STEPS = 3;

/** The mark's box, and the frame's interior inside it. A rounded square rather than the chip's own 1.4:1
 *  oblong, and that was a rendering result rather than a preference: the generator's geometry is designed
 *  against a square box, and squashing it to chip aspect flattens the fracture into a smudge at every size
 *  the Action Bar actually draws. The capsule around the badge is the "warning" frame; this small tile is
 *  the "train" one, and it is squarer than a real chip so that the crack inside it survives. */
const MARK_BOX = 22;
const MARK_INSET = 3;
const MARK_SPAN = MARK_BOX - MARK_INSET * 2;

/** The generator's 0-100 output, mapped into the frame's interior so the fracture is contained BY the tile
 *  rather than slashed THROUGH it. A crack running off both edges of a box reads as a cancellation mark,
 *  which is the one wrong meaning available here. */
export function rustMarkPath(): string {
  const source = crackPath(RUST_BADGE_SEED, RUST_BADGE_STEPS);
  return source.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_match, command, x, y) => {
    const at = (value: string) => Math.round((MARK_INSET + (Number(value) / 100) * MARK_SPAN) * 10) / 10;
    return `${command}${at(x)} ${at(y)}`;
  });
}

/** Computed once: the seed is fixed, so recomputing it per render would be per-badge work for a constant. */
const RUST_MARK_PATH = rustMarkPath();

/** How large a mark sits beside `FONT_SIZE.micro` label text. In `em`, which is the whole answer to the
 *  uiScale question: the chrome is zoomed as one (`chromeZoomFor`), so a mark sized against its own label
 *  keeps its proportion at 0.63, 1.0 and 1.5 without a breakpoint anywhere. */
const MARK_SIZE = "1.15em";

const markStyle: React.CSSProperties = {
  width: MARK_SIZE,
  height: MARK_SIZE,
  display: "inline-block",
  /* Optically centred against the cap height of an 800-weight micro label, rather than sat on the
     baseline. Chosen over `vertical-align: middle`, which centres against the x-height and rides high. */
  verticalAlign: "-0.2em",
  flexShrink: 0,
};

/* Both marks are `aria-hidden`, and that is not a shortcut. The badge itself carries `aria-label` holding
   the whole fact -- "The next train purchase destroys every 2-Train in play, in every corporation." --
   which is more than either mark says. A mark announced separately would be a second, worse telling of a
   sentence the reader has already had (brief §9). */

/** Rust: a train chip with a fracture through it. */
export function RustMark(): React.JSX.Element {
  return (
    <svg
      viewBox={`0 0 ${MARK_BOX} ${MARK_BOX}`}
      style={markStyle}
      aria-hidden="true"
      focusable="false"
    >
      {/* The chip. Light and at 0.40 opacity, which is the weight three rendered candidates settled: at
          0.55 the tile competes with the fracture and the pair reads as a busy little box, and at this
          weight the crack is plainly the figure and the tile is plainly the thing it is in. `rx` 4 rather
          than 5 for the same reason -- 5 of 22 is an app icon, 4 is a chip. */}
      <rect
        x={1.1}
        y={1.1}
        width={MARK_BOX - 2.2}
        height={MARK_BOX - 2.2}
        rx={4}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        opacity={0.4}
      />
      {/* The fracture, in the badge's own ink and heavier than the tile: the mark is the crack. */}
      <path
        d={RUST_MARK_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ==================================================================
    W3-H (VF J-6, OD-14(h)): THE DISCARD MARK -- VF-8'S BLADE, AT A FIXED SEED, AGAINST THE CRACK
   ==================================================================
   OD-14(h) RULED "use static rust/discard icon treatment". The rust half is `RustMark` above (VF-7's I-10,
   built by the warning-marks pass). J-6 said what the discard half should be made of: "`discardCut` is the
   piece that pass would reuse -- it produces a position and a slant from a seed, so a badge can be the same
   blade at a fixed seed, and the contrast with VF-7's `crackPath` badge (I-10) is already built in: a
   straight line against a fracture." Taken literally, like the rust mark: the same tile, the same weights,
   and inside it ONE straight blade where the rust mark has a forked fracture.
   AND THE TILE IS PARTED AT THE BLADE. A lone near-vertical stroke in a square reads as a divider or a pause
   glyph at 12px; a tile in two pieces with the blade between them says "this train was cut", which is what a
   discard is (it goes to the Bank Pool intact -- no fracture, no debris). The gap is the J-3 "part" beat,
   frozen. The two marks therefore differ in the one property the two vocabularies exist to keep apart: a
   fracture that branches versus a clean straight cut. */
const DISCARD_BADGE_SEED = 110; // `discardCut(110)`: x 50%, slant +3% -- centred, at the generator's largest lean
/** Half the parting between the two halves of the tile, in mark units. */
const DISCARD_PART_HALF = 1.1;

/** The blade and the two half-tiles, in the mark's 0..MARK_BOX space. Exported for the harness. */
export function discardMarkGeometry(): { blade: string; left: string; right: string } {
  const { xPercent, slantPercent } = discardCut(DISCARD_BADGE_SEED);
  const at = (percent: number) => Math.round((MARK_INSET + (percent / 100) * MARK_SPAN) * 10) / 10;
  // The blade leans by `slantPercent` of the span across the tile's height, centred on `xPercent`.
  const top = at(xPercent + slantPercent / 2);
  const bottom = at(xPercent - slantPercent / 2);
  const y0 = 1.1;
  const y1 = MARK_BOX - 1.1;
  const blade = `M${top} ${MARK_INSET - 1.5} L${bottom} ${MARK_BOX - MARK_INSET + 1.5}`;
  const x0 = 1.1;
  const x1 = MARK_BOX - 1.1;
  const r = 4;
  const round1 = (value: number) => Math.round(value * 10) / 10;
  // Each half is the tile's outline cut along the blade line, pulled DISCARD_PART_HALF away from it.
  const lt = round1(top - DISCARD_PART_HALF);
  const lb = round1(bottom - DISCARD_PART_HALF);
  const rt = round1(top + DISCARD_PART_HALF);
  const rb = round1(bottom + DISCARD_PART_HALF);
  const left = `M${lt} ${y0} L${x0 + r} ${y0} Q${x0} ${y0} ${x0} ${y0 + r} L${x0} ${y1 - r} Q${x0} ${y1} ${x0 + r} ${y1} L${lb} ${y1}`;
  const right = `M${rt} ${y0} L${x1 - r} ${y0} Q${x1} ${y0} ${x1} ${y0 + r} L${x1} ${y1 - r} Q${x1} ${y1} ${x1 - r} ${y1} L${rb} ${y1}`;
  return { blade, left, right };
}

const DISCARD_MARK = discardMarkGeometry();

/** Discard: a train chip cut cleanly in two. */
export function DiscardMark(): React.JSX.Element {
  return (
    <svg viewBox={`0 0 ${MARK_BOX} ${MARK_BOX}`} style={markStyle} aria-hidden="true" focusable="false">
      {/* The two halves, at the rust tile's own weight and opacity, so the pair reads as one family. */}
      <path d={DISCARD_MARK.left} fill="none" stroke="currentColor" strokeWidth={1.2} opacity={0.4} />
      <path d={DISCARD_MARK.right} fill="none" stroke="currentColor" strokeWidth={1.2} opacity={0.4} />
      {/* The blade, at the fracture's weight: the mark is the cut. Straight, unbranched, edge to edge. */}
      <path d={DISCARD_MARK.blade} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
    </svg>
  );
}

/* ==================================================================
    THE TRAIN-LIMIT MARK: THE FIGURES, BECAUSE THEY BEAT ANY ICON
   ==================================================================
   `4→3` is not an abstraction of the rule, it IS the rule, and it distinguishes itself from a crack without
   having to be interpreted. The brief prefers it for that reason and so does #839's original argument for
   these badges existing at all: put the fact on the badge rather than one hop away.

   AND IT IS NOT REDUNDANT HERE, which was the one thing worth checking before building it. #889 condensed
   this badge's label to "Train Limit Drops in N Buys" and moved the figures into `detail` precisely because
   "Limit X → Y in N Buys" was "the busiest string in a row of badges". So the label does not carry them, and
   the mark restores the missing half at a fraction of the width.

   THE VALUES COME FROM THE WARNING, NOT FROM ITS SENTENCE. `purchaseWarnings` already holds both numbers --
   `phase.trainLimit` and `limitAfterNextPhase` -- at the moment it decides the warning exists at all; they
   are now carried on the warning rather than formatted into prose and read back out. Parsing them out of
   `detail` would have made the copy load-bearing, so a wording change would silently break an identifier. */

export interface CapacityChange {
  from: number;
  to: number;
}

/** Train limit: the capacity the phase is about to take away. */
export function CapacityMark({ capacity }: { capacity: CapacityChange | null }): React.JSX.Element {
  /* ==================================================================
      THE FALLBACK, AND AN HONEST NOTE ABOUT WHEN IT RUNS
     ==================================================================
     Brief §5: "If a warning somehow lacks usable old/new values: use a compact fallback capacity/down icon;
     do not fabricate numbers." Built, and it is UNREACHABLE TODAY -- `purchaseWarnings` constructs the
     train-limit warning only inside `if (after !== null && after < phase.trainLimit)`, so both figures exist
     by construction wherever this component is rendered from the bar.
     KEPT ANYWAY, and #788's rule about unreachable arms is the reason to say so rather than the reason to
     delete it: the prop is nullable because the component cannot see that guard, and the alternative to a
     fallback is a required prop that would push the same decision onto every future caller. What #788
     forbids is an arm nobody can explain; this one is explained and asserted. */
  if (capacity === null) {
    return (
      <svg viewBox={`0 0 ${MARK_BOX} ${MARK_BOX}`} style={markStyle} aria-hidden="true" focusable="false">
        {/* A ceiling coming down: the bar is the limit, the arrow is the direction. No numbers invented. */}
        <path
          d="M4 5 L18 5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
        />
        <path
          d="M11 8.5 L11 17 M6.8 12.8 L11 17 L15.2 12.8"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  /* TEXT RATHER THAN AN SVG, because it is text: it inherits the badge's ink, its weight and its scaling for
     free, and an arrow drawn as a glyph stays on the same baseline as the digits either side of it at every
     uiScale. `tabular-nums` so two badges in a row do not shift by a hairline when 4→3 becomes 3→2. */
  return (
    <span aria-hidden="true" style={capacityStyle}>
      {capacity.from}&#8594;{capacity.to}
    </span>
  );
}

const capacityStyle: React.CSSProperties = {
  /* Deliberately a hair smaller than the label it identifies: it is a mark, not a second headline, and at
     full size two digits and an arrow start to out-weigh "Train Limit Drops" beside them. */
  fontSize: "0.95em",
  fontVariantNumeric: "tabular-nums",
  /* The one thing that keeps it from reading as part of the sentence. Not a colour and not a box -- both
     were tried against the brief's "do not assign category-specific colours" and its restraint rule -- but
     the same letter-spacing relief the capsule already uses, so the figures sit as a unit. */
  letterSpacing: "0.04em",
  flexShrink: 0,
};

/** The mark for one warning, chosen by its key rather than by its words.
 *
 *  A FUNCTION RATHER THAN A BRANCH AT EACH OF THE BAR'S RENDER SITES. The badges are rendered in two places
 *  (the Operating Round rail and the generic left rail) and a third for the Gentle Rust final-run badge; a
 *  `key === "rust" ? ... : ...` copied three times is three chances for them to disagree about what a rust
 *  badge looks like. */
export function WarningMark({
  kind,
  capacity = null,
}: {
  kind: "rust" | "train-limit";
  capacity?: CapacityChange | null;
}): React.JSX.Element {
  return kind === "rust" ? <RustMark /> : <CapacityMark capacity={capacity} />;
}

/** Exported for the harness: the badge label's own size, so a test can state what the marks are sized
 *  against without re-deriving it. */
export const WARNING_MARK_LABEL_SIZE = FONT_SIZE.micro;
