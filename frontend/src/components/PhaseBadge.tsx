// frontend/src/components/PhaseBadge.tsx
//
// The persistent phase badge, and the mechanical flip it performs when the displayed phase changes -- VF-4
// (VISUAL_FLOURISH_BACKLOG.md). `phaseBadgeFlip.ts` owns the schedule and the comparison; this owns the
// rendering, the timers and the staged face, the same split `StockRoundPanel.tsx` keeps over
// `corporationFloatFocus.ts`.
//
/* ==================================================================
    DESIGN NOTE (VF-4): THE BADGE ITSELF, NOT A SECOND BADGE THAT LOOKS LIKE IT
   ==================================================================
   THE WHOLE POINT IS THAT NOTHING NEW APPEARS. The brief rules out a modal, a banner, a timetable and a
   duplicate plate; what is left is the one element that has been on screen all game changing state in
   front of the player. So this component IS the badge -- the same `styles.phaseBadge` span, in the same
   layout slot, with the same text -- and the flourish is a class and two extra renders on it.

   EXTRACTED FROM `ContextualActionBar.tsx` RATHER THAN WRITTEN TWICE. The bar prints the badge at two
   places (the Operating Round panel's left rail, and the action row's lead) and both are the same badge in
   two branches of one bar. Before this batch each held its own copy of the span; a flourish written into
   both would be two implementations of one ceremony, which is the drift `gamePhase.ts` #5/#632/#1094 keeps
   naming. Both call sites still pass `phase.label` and `phase.tint` -- the authoritative reading, straight
   from `derivePhase` -- so what the badge prints at rest is unchanged, character for character.

   IT TAKES A LABEL AND A TINT, NOT A `GamePhase`, and that is A-4 enforced by the signature: handed the two
   values it prints, this component cannot consult a rule even by accident. It has no access to the tier,
   the depot, the train limit or the variants, and nothing here can answer "what phase is it" -- only "what
   does the badge say".

   TWO BADGES MAY BE MOUNTED AT ONCE and each runs its own copy of the sequence off the same event token.
   That is the same arrangement every roster card has under VF-1/VF-3 (the panel builds one sequence and
   each card decides whether it is the subject); here both subjects are the same badge shown twice, so both
   playing the identical flip is the correct reading rather than a collision. */

import { useEffect, useMemo, useState } from "react";

import { PHASE_TINT_STYLES, styles } from "../styles/appStyles";
import type { PhaseTint } from "../gameEngine/gamePhase";
import {
  buildPhaseBadgeFlipSequence,
  PHASE_BADGE_FLIP_CSS,
  type PhaseBadgeFace,
  type PhaseBadgeFlipEvent,
  type PhaseBadgeFlipSequence,
  type PhaseBadgeStageKind,
} from "./phaseBadgeFlip";

/** The house idiom, optional-chained twice because a test environment has a `window` and no `matchMedia`
 *  (`StockRoundPanel` VF-3, `TreasuryMoneyMachine` #1272, `HexGridRenderer` #496). */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

interface PhaseBadgeApplied {
  /** The staged old face has been replaced by the authoritative one. */
  face: boolean;
}

const NOTHING_APPLIED: PhaseBadgeApplied = { face: false };

interface PhaseBadgeProgress {
  sequence: PhaseBadgeFlipSequence | null;
  stageIndex: number;
  applied: PhaseBadgeApplied;
}

function startOfSequence(sequence: PhaseBadgeFlipSequence | null): PhaseBadgeProgress {
  return { sequence, stageIndex: 0, applied: NOTHING_APPLIED };
}

/** The flip's own timers. #1456's "the reset is a render, not an effect", for the same reason VF-1 and VF-3
 *  both keep it: a superseding phase change must not let a stale `applied.face` paint one frame of the new
 *  sequence, so the mismatch is resolved DURING render rather than in a passive effect. */
function usePhaseBadgeFlip(
  event: PhaseBadgeFlipEvent | null | undefined,
  reducedMotion: boolean,
): { sequence: PhaseBadgeFlipSequence | null; stage: PhaseBadgeStageKind | null; applied: PhaseBadgeApplied } {
  const face: PhaseBadgeFace | null = event ? { label: event.label, tint: event.tint } : null;
  // Keyed on the EVENT'S OWN TOKEN: two changes into and back out of one phase (an Undo, then the same
  // purchase again) are two ceremonies, and the faces alone cannot tell them apart.
  const sequence = useMemo(
    () => buildPhaseBadgeFlipSequence(face, reducedMotion),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [event?.token, reducedMotion],
  );
  const [progress, setProgress] = useState<PhaseBadgeProgress>(() => startOfSequence(null));

  const live = progress.sequence === sequence ? progress : startOfSequence(sequence);
  if (live !== progress) setProgress(live);

  useEffect(() => {
    if (!sequence) return undefined;
    const timers: number[] = [];
    const advance = (at: number, step: (was: PhaseBadgeProgress) => PhaseBadgeProgress) => {
      timers.push(
        window.setTimeout(() => {
          setProgress((was) => (was.sequence !== sequence ? was : step(was)));
        }, at),
      );
    };
    sequence.stages.forEach((stage, index) => {
      if (index === 0) return;
      advance(stage.at, (was) => ({ ...was, stageIndex: index }));
    });
    sequence.applications.forEach((application) => {
      advance(application.at, (was) => ({ ...was, applied: { ...was.applied, face: true } }));
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [sequence]);

  return {
    sequence,
    stage: sequence ? (sequence.stages[live.stageIndex]?.kind ?? null) : null,
    applied: live.applied,
  };
}

/** The class carrying this stage's motion, or `undefined` for a badge at rest. `settle` is deliberately
 *  `undefined` rather than a third class: see `PHASE_BADGE_SETTLE_AT_MS` for why the last frame must carry
 *  no transform at all. */
function flipClassName(stage: PhaseBadgeStageKind | null, reducedMotion: boolean): string | undefined {
  if (stage === "fold") return reducedMotion ? "app-phase-badge-crossfade-out" : "app-phase-badge-fold";
  if (stage === "unfold") return reducedMotion ? "app-phase-badge-crossfade-in" : "app-phase-badge-unfold";
  return undefined;
}

export interface PhaseBadgeProps {
  /** What the badge prints -- `GamePhase.label`, unchanged. */
  label: string;
  /** The badge's other rendered channel -- `GamePhase.tint`, unchanged. */
  tint: PhaseTint;
  /** The displayed-phase change to play, or `null`/absent for the ordinary persistent badge. */
  flip?: PhaseBadgeFlipEvent | null;
}

export function PhaseBadge({ label, tint, flip }: PhaseBadgeProps) {
  /* Read once per sequence, not per render, so the OS preference changing mid-flip cannot swap timelines
     halfway through one -- the same `[event?.token, reducedMotion]` keying every other flourish uses. */
  const reducedMotion = prefersReducedMotion();
  const { sequence, stage, applied } = usePhaseBadgeFlip(flip, reducedMotion);

  /* ==================================================================
      DESIGN NOTE (VF-4): A-2, IN ONE TERNARY
     ==================================================================
     Before the hidden midpoint the badge prints the STAGED OLD FACE, even though the authoritative `label`
     and `tint` props it is holding are already the new phase's -- that is the whole of "the animation
     CAUSES the visible final state". After the midpoint it prints the props, and from the settle stage on
     it is indistinguishable from the badge that has been there all game.
     AND THERE IS NO SECOND AUTHORITY HERE. The staged value is a snapshot of what this badge was printing a
     moment ago, handed down by the shell; the new value is never stored, never derived and never cached --
     it is read straight off the props on every render. */
  const showStaged = sequence !== null && !applied.face;
  const shownLabel = showStaged ? sequence.from.label : label;
  const shownTint = showStaged ? sequence.from.tint : tint;

  const motionClass = flipClassName(stage, reducedMotion);
  const stageDurationMs = stageDurationFor(sequence, stage);

  return (
    <>
      {/* #46/#18's escape hatch, on VF-1's rule: injected unconditionally, because keyframes are what an
         inline style cannot express. A `<style>` element is `display: none`, so it is not a flex item and
         the rail's layout is exactly what it was. */}
      <style>{PHASE_BADGE_FLIP_CSS}</style>
      <span
        className={motionClass}
        style={{
          ...styles.phaseBadge,
          ...PHASE_TINT_STYLES[shownTint],
          /* The durations come from `phaseBadgeFlip.ts`'s constants rather than being written again in the
             stylesheet, so the schedule the timers keep and the schedule the compositor keeps are one set
             of numbers. `undefined` at rest leaves the span with no animation properties at all. */
          ...(motionClass && stageDurationMs !== null
            ? { animationDuration: `${stageDurationMs}ms` }
            : {}),
        }}
      >
        {shownLabel}
      </span>
    </>
  );
}

/** This stage's own length, for the inline `animation-duration`. A plain lookup, not a hook: the sequence
 *  is immutable once built, so there is nothing to remember between renders. */
function stageDurationFor(
  sequence: PhaseBadgeFlipSequence | null,
  stage: PhaseBadgeStageKind | null,
): number | null {
  if (!sequence || stage === null) return null;
  return sequence.stages.find((entry) => entry.kind === stage)?.durationMs ?? null;
}

export default PhaseBadge;
