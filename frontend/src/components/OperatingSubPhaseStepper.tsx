// frontend/src/components/OperatingSubPhaseStepper.tsx
//
// The Operating Round turn stepper: where a corporation is in its turn.
//
// Design note #0: THIS REPLACES A TEXT LABEL, AND THAT IS THE POINT. "Phase 4 of 6: Routes" was accurate and
// nearly useless -- it named where you were without showing what came before, what comes next, or how far
// through the turn you had got. A player learning 1830's operating sequence, the hardest ordering in the game
// to internalise, got a number and a word.
//
// Design note #1 / #212: THE STRIP IS A READ-ONLY INDICATOR, IN EVERY MODE. The contract persists the cursor
// and rejects a client that walks a different order, so jumping the UI would just make the bar lie about what
// the chain accepts. The SANDBOX exception is gone: it was safe and still wrong, because the sandbox is the
// testbed for the turn order, and a strip whose steps can be clicked turns the sequence into a menu -- letting
// a tester reach a state the contract cannot reach and report the result as a bug in a flow no live game can
// enter. It also skipped work silently: jumping to Routes from Lay Track passed over Station Tokens with
// nothing dispatched and nothing logged.
// So the cursor moves in exactly three ways, all of them events with a record: forward by ACTING, forward by
// SKIPPING (which dispatches the real `AdvanceOperatingSubPhase`), and backward by UNDO.
//
// Design note #2: FIVE STEPS OR SIX, DEPENDING ON THE ERA. `BuyPrivate` leads the turn but does not exist
// before Phase 3, and rendering a greyed-out step the chain says is not there would be inventing a phase. The
// strip is NUMBERED from the filtered list, so the numbers always describe the turn actually being played.
//
// Design notes #235/#385/#613: see `docs/ai_architecture/state_machine.md`.

import React from "react";

import { FONT_SIZE } from "../styles/typography";

/** The legal, chronologically-ordered action sub-phases within one corporation's Operating Round turn. Mirrors
 *  `or_phase::OR_PHASE_ORDER`, which is the AUTHORITY rather than a description (design note #1). Lives here
 *  rather than in `App.tsx` so the stepper, the action bar and the labels all read one definition;
 *  `RulesReference.tsx` keeps its own independent copy on purpose -- that file takes no game-state coupling. */
export type OperatingSubPhase =
  | "BuyPrivate"
  | "Track"
  | "Tokens"
  | "Routes"
  | "Dividends"
  | "Hardware";

/** Canonical order. The strip, the numbering and every "is this step done"
 *  comparison read this array, so there is one sequence in the app. */
export const OPERATING_SUB_PHASE_ORDER: readonly OperatingSubPhase[] = [
  "BuyPrivate",
  "Track",
  "Tokens",
  "Routes",
  "Dividends",
  "Hardware",
];

/** Display metadata. `name` is the short form the action bar's header uses;
 *  `stepLabel` is the longer, verb-led form for the strip, where there is
 *  room and where a newcomer benefits from being told what the step IS
 *  ("Lay Track") rather than what it is called ("Track"). */
export const OPERATING_SUB_PHASE_LABELS: Readonly<
  Record<OperatingSubPhase, { index: number; name: string; stepLabel: string }>
> = {
  BuyPrivate: { index: 1, name: "Buy Private", stepLabel: "Buy Private" },
  Track: { index: 2, name: "Track", stepLabel: "Lay Track" },
  Tokens: { index: 3, name: "Tokens", stepLabel: "Station Tokens" },
  // Design note #142 (App.tsx): `Routes` is its own phase. Running trains
  // COMPUTES the revenue; declaring dividends chooses what to do with it.
  Routes: { index: 4, name: "Routes", stepLabel: "Run Routes" },
  Dividends: { index: 5, name: "Dividends", stepLabel: "Dividends" },
  Hardware: { index: 6, name: "Hardware", stepLabel: "Buy Trains" },
};

export const OPERATING_SUB_PHASE_TOTAL = OPERATING_SUB_PHASE_ORDER.length;

/** Where a corporation's turn starts, mirroring
 *  `or_phase::initial_sub_phase` -- `Track` before Phase 3, because
 *  `BuyPrivate`'s action is locked until then and the contract's cursor
 *  starts there too. */
export function initialOrSubPhase(era: string | null | undefined): OperatingSubPhase {
  return era === "Yellow" || !era ? "Track" : "BuyPrivate";
}

/** The shape `visibleSubPhases` needs off a private company -- structural,
 *  so callers can pass `PrivateCompanyState` without this module importing
 *  the whole game-state vocabulary. */
export interface PrivateAvailability {
  closed: boolean;
  /** Set when a CORPORATION holds it; such a private can never be bought
   *  again (`trading.rs` reads `private.owner` and fails without one). */
  owner_protocol_id: number | null;
}

/** Is there anything left for a corporation to buy? Design note #385: A STEP WITH NOTHING IN IT IS NOT A STEP.
 *  The step was gated on the ERA alone, so from Phase 3 it appeared on every corporation's turn for the rest of
 *  the game -- and by the mid-game it is usually empty. Six corporations each skipping a dead step every
 *  Operating Round is a lot of clicks spent proving a negative.
 *  A PRIVATE IS BUYABLE IF a player still holds it -- not closed, not already inside a corporation. That is the
 *  same predicate `PrivateTradePanel.tsx` applies, deliberately: the step exists to open that picker, so it
 *  should be present exactly when the picker would have rows.
 *  PHASE 5 NEEDS NO SPECIAL CASE -- it closes all privates, so this returns false on its own, and testing the
 *  phase too would be a second rule to keep in agreement with the first.
 *  AN UNKNOWN ROSTER SHOWS THE STEP: hiding it because data has not arrived would make the strip flicker as it
 *  loads, and would hide a legal action from a player whose privates simply had not loaded yet. */
export function hasBuyablePrivate(
  privates: readonly PrivateAvailability[] | null | undefined,
): boolean {
  if (privates === null || privates === undefined) return true;
  return privates.some((entry) => !entry.closed && entry.owner_protocol_id === null);
}

/* Design note #613: THE RULE IS A PHASE NUMBER, SO SAY THE PHASE NUMBER. Corporations may buy privates from the
   first 3-train until the first 5-train closes them. The old test approximated that in two hops -- an era check
   for the lower bound and #385's "is anything still buyable" for the upper -- correct only because the second
   hop happens to be true whenever the first is wrong.
   WHY THAT WAS WORTH TIGHTENING even though it behaved: the upper bound was enforced by a CONSEQUENCE of Phase
   5 rather than by Phase 5, which is a correct reading of a state the contract has to have written first -- so
   during any window where the phase has advanced and the closures have not yet arrived, the step would offer
   itself. Testing the phase closes that window and makes the rule legible.
   THE ERA STAYS AS THE FALLBACK, NOT AS THE RULE: `derivePhase` reports `known: false` when no corporation has
   reported trains, and there is then no phase number to test.
   `initialOrSubPhase` IS DELIBERATELY UNCHANGED. It mirrors the contract's `initial_sub_phase`, which decides
   where the CURSOR starts, and a mirror that stops matching its original is worse than an imprecise one. */
export function visibleSubPhases(
  era: string | null | undefined,
  privates?: readonly PrivateAvailability[] | null,
  /** The phase number from `derivePhase`. Omitted or `null` falls back to
   *  the era test -- see the note above. */
  tier?: string | null,
): readonly OperatingSubPhase[] {
  const phaseAllowsBuying =
    tier === null || tier === undefined
      ? initialOrSubPhase(era) !== "Track"
      : tier === "3" || tier === "4";
  const showBuyPrivate = phaseAllowsBuying && hasBuyablePrivate(privates);
  return showBuyPrivate
    ? OPERATING_SUB_PHASE_ORDER
    : OPERATING_SUB_PHASE_ORDER.filter((phase) => phase !== "BuyPrivate");
}

export interface OperatingSubPhaseStepperProps {
  current: OperatingSubPhase;
  /** Drives which steps render -- see design note #2. */
  era: string | null | undefined;
  /** Design note #385: also drives which steps render. `Buy Private` is
   *  dropped once nothing is left for a corporation to buy. Omitted or
   *  `undefined` means "not loaded", which shows the step. */
  privates?: readonly PrivateAvailability[] | null;
  /* Design note #235: SKIP AND UNDO SWAPPED LINES. Both were in the wrong place, and the reason is what each
     control acts on: SKIP is a TURN ACTION -- the alternative to laying a tile, placing a token or running a route
     -- so it belongs beside the actions it is an alternative to; UNDO acts on the SUB-PHASE CURSOR, the only
     thing that moves the turn backwards, so it belongs on the strip that displays that cursor.
     So this component renders no button of its own: it renders the strip and a `trailing` slot, and the bar
     supplies both controls in their new homes. `onAdvance` is gone from the props rather than left unused -- a
     callback nothing calls is a callback somebody re-wires.
     A slot rather than a prop pair, because this component has no opinion about what belongs there beyond WHERE. */
  trailing?: React.ReactNode;
}

export function OperatingSubPhaseStepper({
  current,
  era,
  privates,
  trailing,
}: OperatingSubPhaseStepperProps) {
  const steps = visibleSubPhases(era, privates);
  const currentIndex = steps.indexOf(current);

  return (
    <div style={styles.root} role="group" aria-label="Operating Round turn steps">
      <ol style={styles.strip}>
        {steps.map((phase, index) => {
          const isCurrent = phase === current;
          // `currentIndex` is -1 if the cursor sits on a step this era does
          // not show, which would otherwise mark every step complete.
          const isDone = currentIndex >= 0 && index < currentIndex;
          const label = OPERATING_SUB_PHASE_LABELS[phase].stepLabel;
          const body = (
            <>
              <span style={styles.stepNumber}>{index + 1}</span>
              {label}
            </>
          );
          return (
            <li key={phase} style={styles.stepItem}>
              {index > 0 && (
                <span style={styles.chevron} aria-hidden="true">
                  &#8250;
                </span>
              )}
              {/* Design note #1: a `<span>`, never a `<button>`. Rendering
                  a disabled button would announce an interactive control to
                  a screen reader and then refuse it; this is not a control
                  that happens to be off, it is an indicator. */}
              <span
                aria-current={isCurrent ? "step" : undefined}
                style={{
                  ...styles.step,
                  ...(isDone ? styles.stepDone : {}),
                  ...(isCurrent ? styles.stepCurrent : {}),
                }}
                // Says WHY it does not respond. A strip that simply ignores
                // clicks reads as broken rather than as read-only.
                title={
                  isCurrent
                    ? `Current step: ${label}. Complete it, or use Skip to move on.`
                    : isDone
                      ? `${label} — done. Undo steps back.`
                      : `${label}. Steps are reached in order: act, or use Skip.`
                }
              >
                {body}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Design note #235: the Undo control, supplied by the bar. The Skip
          button that used to live here moved to the action row, where the
          other ways of ending a step are. */}
      {trailing && <div style={styles.controls}>{trailing}</div>}
    </div>
  );
}

export default OperatingSubPhaseStepper;

/* ------------------------------------------------------------------ */
/* Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "10px",
    /* Design note #299 (`App.tsx`): 8px above and below the step strip, on
       top of the panel's own row gap, made this the tallest thing in the
       action panel that contains no control. It is a progress indicator --
       it needs to be readable, not spacious. */
    padding: "3px 0",
  },
  strip: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "2px",
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  stepItem: { display: "inline-flex", alignItems: "center", gap: "2px" },
  chevron: { color: "#4a4a4a", fontSize: FONT_SIZE.small, padding: "0 2px" },
  step: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 10px",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a3a3a",
    backgroundColor: "#141414",
    color: "#a8a6a0",
    fontSize: FONT_SIZE.small,
    fontWeight: 600,
    whiteSpace: "nowrap",
    // Inherited by the `<button>` branch, which would otherwise pick up the
    // UA default font rather than the app's.
    fontFamily: "inherit",
  },
  // Done reads as settled rather than disabled: a completed step is not an
  // error state, and dimming it to near-invisible would break the "shape of
  // the turn" the strip exists to show.
  /* ==================================================================
      DESIGN NOTE 1096: A FINISHED STEP IS INFORMATION, NOT AN UNAVAILABLE CONTROL
     ==================================================================
     This was `#6e6c68` -- the same ink the app gives DISABLED BUTTONS -- at 3.66:1. The paragraph above
     already had the right idea ("settled rather than disabled") and the colour quietly contradicted it.
     WHY THE DISTINCTION MATTERS RATHER THAN BEING PEDANTRY: the accessibility floor exempts disabled
     controls, on the reasoning that a control offering you nothing need not be read. A completed step is
     the opposite -- it is the strip telling you where you are in the round, which is a thing a player
     actively reads. Borrowing the disabled ink borrowed an exemption this element is not entitled to.
     ONE NOTCH, NOT A PROMOTION: `#8a8a86` is 5.53:1 on this ground, still clearly quieter than
     `stepCurrent`'s filled treatment, so the sequence still reads as done / here / to come. */
  stepDone: { color: "#8a8a86", borderColor: "#2a2a2a", backgroundColor: "#0f0f0f" },
  stepCurrent: {
    color: "#eaf2ff",
    borderColor: "#4d8ee0",
    backgroundColor: "#1d3a55",
    fontWeight: 800,
  },
  stepNumber: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.micro,
    opacity: 0.75,
  },
  controls: { display: "inline-flex", flexDirection: "row", gap: "8px", alignItems: "center" },
  advanceButton: {
    padding: "5px 12px",
    borderRadius: "6px",
    border: "1px solid #4a4a4a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  skipButton: {
    padding: "5px 12px",
    borderRadius: "6px",
    border: "1px solid #3a5a8a",
    backgroundColor: "#1d2a3f",
    color: "#9ec5ff",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  skipButtonDisabled: { opacity: 0.45, cursor: "not-allowed" },
};
