// frontend/src/components/BankTicket.tsx
//
// The Bank's persistent railroad ticket, and the one-time BANK BROKEN stamp -- VF-6
// (VISUAL_FLOURISH_BACKLOG.md). `bankBreakFlourish.ts` owns the schedule and the stylesheet;
// `utils/bankBreak.ts` owns what the ticket says; this owns the rendering and the timers.
//
/* ==================================================================
    DESIGN NOTE (VF-6): ONE TICKET, THREE TONES, ONE COMPONENT
   ==================================================================
   The brief's architecture in one sentence: colour is the state, shape is the category, text is the
   count. So there is ONE component for all three readings -- no separate post-break badge, no second
   persistent plate -- and the break is a class and two extra renders on the thing already there.

   EXTRACTED FROM `ContextualActionBar.tsx`, which printed the Bank capsule at two call sites (the
   Operating Round rail and the action row's lead). Two inline copies of one badge is how VF-4 found the
   phase badge, and the answer is the same: the bar passes what it has and this owns what it looks like.

   IT TAKES A READING, NOT A GAME STATE, and that is A-4 enforced by the signature. `bankTicketReading`
   has already asked the latch and the calendar; this component cannot consult a rule even by accident --
   it has no access to the bank balance, the round machine, or `bankIsBroken`.

   TWO TICKETS MAY BE MOUNTED AT ONCE (the two rails, plus the spectator dock) and each runs its own copy
   of the sequence off the same event token. Same arrangement as VF-4's two phase badges: they are one
   badge shown in more than one branch, so all of them playing the identical stamp is the correct reading. */

import { useEffect, useMemo, useState } from "react";

import { styles } from "../styles/appStyles";
import type { BankTicketReading } from "../utils/bankBreak";
import {
  BANK_TICKET_CSS,
  bankTicketStageClass,
  bankTicketToneClass,
  buildBankBreakSequence,
  type BankBreakFlipEvent,
  type BankBreakSequence,
  type BankBreakStageKind,
} from "./bankBreakFlourish";

/** The word the stamp presses onto the ticket. Also the post-break label's own opening, so the two say
 *  the same thing and a reader who missed the stamp reads it off the resting ticket. */
export const BANK_BROKEN_STAMP_TEXT = "BANK BROKEN";

/** The house idiom, optional-chained twice because a test environment has a `window` and no `matchMedia`
 *  (`PhaseBadge` VF-4, `StockRoundPanel` VF-3, `TreasuryMoneyMachine` #1272, `HexGridRenderer` #496). */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

interface BankTicketApplied {
  /** The staged critical ticket has become the authoritative broken one. */
  broken: boolean;
}

const NOTHING_APPLIED: BankTicketApplied = { broken: false };

interface BankTicketProgress {
  sequence: BankBreakSequence | null;
  stageIndex: number;
  applied: BankTicketApplied;
}

function startOfSequence(sequence: BankBreakSequence | null): BankTicketProgress {
  return { sequence, stageIndex: 0, applied: NOTHING_APPLIED };
}

/** The stamp's own timers. #1456's "the reset is a render, not an effect", for the reason VF-1, VF-3 and
 *  VF-4 all keep it: a superseding break must not let a stale `applied.broken` paint one frame of the new
 *  sequence, so the mismatch is resolved DURING render rather than in a passive effect. */
function useBankBreakStamp(
  event: BankBreakFlipEvent | null | undefined,
  reducedMotion: boolean,
): { sequence: BankBreakSequence | null; stage: BankBreakStageKind | null; applied: BankTicketApplied } {
  const descriptor = event ? { fromLabel: event.fromLabel } : null;
  // Keyed on the EVENT'S OWN TOKEN: an Undo back past the break and a second genuine break are two
  // ceremonies, and the staged label alone cannot tell them apart.
  const sequence = useMemo(
    () => buildBankBreakSequence(descriptor, reducedMotion),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [event?.token, reducedMotion],
  );
  const [progress, setProgress] = useState<BankTicketProgress>(() => startOfSequence(null));

  const live = progress.sequence === sequence ? progress : startOfSequence(sequence);
  if (live !== progress) setProgress(live);

  useEffect(() => {
    if (!sequence) return undefined;
    const timers: number[] = [];
    const advance = (at: number, step: (was: BankTicketProgress) => BankTicketProgress) => {
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
      advance(application.at, (was) => ({ ...was, applied: { ...was.applied, broken: true } }));
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [sequence]);

  return {
    sequence,
    stage: sequence ? (sequence.stages[live.stageIndex]?.kind ?? null) : null,
    applied: live.applied,
  };
}

/** This stage's own length, for the inline `animation-duration`. A plain lookup, not a hook. */
function stageDurationFor(
  sequence: BankBreakSequence | null,
  stage: BankBreakStageKind | null,
): number | null {
  if (!sequence || stage === null) return null;
  return sequence.stages.find((entry) => entry.kind === stage)?.durationMs ?? null;
}

export interface BankTicketProps {
  /** What the ticket says, from `bankTicketReading`. `null` renders nothing at all. */
  reading: BankTicketReading | null;
  /** The live false -> true break to stamp, or `null`/absent for the ordinary persistent ticket. */
  stamp?: BankBreakFlipEvent | null;
}

export function BankTicket({ reading, stamp }: BankTicketProps) {
  const reducedMotion = prefersReducedMotion();
  const { sequence, stage, applied } = useBankBreakStamp(stamp, reducedMotion);

  /* ==================================================================
      DESIGN NOTE (VF-6): A-2, AND THE ORDER THE EVENT ACTUALLY WENT IN
     ==================================================================
     Brief section 9 rules out "rainbow appears, then the animation pretends it was still red, then
     rainbow again". So while a sequence is running and its commit has not landed, the ticket renders the
     CRITICAL tone -- the state it was in a moment ago -- and the pre-break text the shell staged. It
     turns rainbow exactly once, at the commit, and stays.
     `fromLabel` MAY BE `null` and that is a real case, not a defect: a single large payout can take the
     Bank from comfortably solvent (no ticket at all) to broken, and there is no earlier text to stage.
     The ticket then shows the authoritative post-break sentence from the first frame, in the critical
     tone, and only the TONE commits. Inventing a dollar figure to stage would be presentation asserting
     a balance that never existed.
     AND THE AUTHORITATIVE READING IS NEVER STORED. `reading` is read off the props on every render; the
     staged value is a snapshot of text the shell saw, handed down once. There is no second Bank
     authority here and nothing cached. */
  const staging = sequence !== null && !applied.broken;
  if (!reading) return null;

  const tone = staging ? "critical" : reading.tone;
  const label = staging ? (sequence?.fromLabel ?? reading.label) : reading.label;
  const stamped = sequence !== null && stage !== null && stage !== "charge" && !applied.broken;

  const motionClass = bankTicketStageClass(stage, reducedMotion);
  const toneClass = bankTicketToneClass(tone);
  const stageDurationMs = stageDurationFor(sequence, stage);

  /* THE PULSE IS THE EXISTING ONE AND IT STOPS AT THE BREAK. `reading.pulses` is false on the broken arm
     by construction (`bankTicketReading`), and it is suppressed during the sequence too -- a ticket being
     stamped must not also be breathing. Pre-break, this is exactly the behaviour #1410 shipped. */
  const pulses = reading.pulses && sequence === null;

  const className = [
    "app-bank-ticket",
    toneClass,
    motionClass,
    pulses ? "app-phase-shift-critical" : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  /* ==================================================================
      DESIGN NOTE (VF-6): THREE PLACES AN INLINE STYLE WOULD HAVE WON, AND DID NOT
     ==================================================================
     #320 records the trap in one line -- "inline styles beat a stylesheet, so a `backgroundColor` or
     `borderColor` left inline would silently win over the gradient and the chaser would never appear" --
     and this badge walks into it three times at once, because it is built on a SHARED style object it
     does not own.
     1. `phaseShiftBadge.borderRadius` is a pill and the ticket is not, so the geometry the silhouette
        needs (square corners for the chamfers to cut, and room for the stub rule) is written here rather
        than left to `.app-bank-ticket` to lose.
     2. `phaseShiftBadgeCritical.animation` is the #1410 pulse, as a SHORTHAND -- which would reset the
        `animation-name` a stage class had just set. So it is pulled out and re-applied only when the
        ticket is genuinely pulsing, which is never during the stamp and never after the break.
     3. The broken tone contributes no colour at all from here; its fill and ring are the stylesheet's,
        which is the only way the two-layer `background-clip` ring can survive. */
  const { animation: criticalPulseAnimation, ...criticalInk } = styles.phaseShiftBadgeCritical;

  return (
    <>
      {/* #46/#18's escape hatch, injected unconditionally: `clip-path`, a `::before` and keyframes are
         what an inline style cannot express. A `<style>` element is `display: none`, so the rail's
         layout is exactly what it was. */}
      <style>{BANK_TICKET_CSS}</style>
      <span
        className={className}
        style={{
          ...styles.phaseShiftBadge,
          // (1) the ticket's own geometry, over the shared capsule's pill.
          borderRadius: 0,
          paddingLeft: 17,
          ...(tone === "broken"
            ? // (3) nothing but the border width, which the gradient ring needs in order to be visible.
              { borderWidth: "2px" }
            : tone === "critical"
              ? criticalInk
              : styles.phaseShiftBadgeWarn),
          // (2) the shared pulse, only when the ticket is actually pulsing.
          ...(pulses && criticalPulseAnimation ? { animation: criticalPulseAnimation } : {}),
          ...(motionClass && stageDurationMs !== null
            ? { animationDuration: `${stageDurationMs}ms` }
            : {}),
        }}
        aria-label={reading.detail}
        data-testid="bank-ticket"
        data-tone={tone}
      >
        {/* The warning glyph belongs to the WARNING states. Once the Bank has broken the event is not
           approaching danger any more, and the ticket says what happened in words instead. */}
        {tone === "broken" ? null : <>&#9888; </>}
        {label}
        {stamped && (
          <span
            className="app-bank-ticket-stamp"
            style={{
              ...(stageDurationMs !== null ? { animationDuration: `${stageDurationMs}ms` } : {}),
            }}
            aria-hidden="true"
          >
            {BANK_BROKEN_STAMP_TEXT}
          </span>
        )}
      </span>
    </>
  );
}

export default BankTicket;
