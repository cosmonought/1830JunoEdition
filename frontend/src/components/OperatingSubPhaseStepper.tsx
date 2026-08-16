// frontend/src/components/OperatingSubPhaseStepper.tsx
//
// The Operating Round turn stepper: where a corporation is in its turn, and
// (in the sandbox) a way to move it.
//
// ===================================================================
//  DESIGN NOTE 0: THIS REPLACES A TEXT LABEL, AND THAT IS THE POINT
// ===================================================================
//
// The action bar used to render "Phase 4 of 6: Routes" as a static string.
// It was accurate and nearly useless: it named where you were without
// showing what came before, what comes next, or how far through the turn
// you had got. A player learning 1830's operating sequence -- which is the
// hardest ordering in the game to internalise -- got a number and a word.
//
// The strip shows the whole sequence at once, marks what is done, and
// highlights what is live. Same information the label had, plus the shape
// of the turn around it.
//
// ===================================================================
//  DESIGN NOTE 1: THE STRIP IS A READ-ONLY INDICATOR. IN EVERY MODE.
// ===================================================================
//
// The contract persists an operating sub-phase cursor and gates every one
// of these six actions against it (`or_phase::OR_PHASE_ORDER`; a client
// that walks a different order has its transactions rejected with
// `WrongOperatingSubPhase`). So in a live game the cursor is not the
// client's to set: jumping the UI to "Dividends" would not move the chain,
// it would just make the bar lie about what the chain would accept. That has
// always been true and the strip has always been a readout online.
//
// WHAT CHANGED (design note #212): the SANDBOX exception is gone. It let a
// step be clicked directly, on the reasoning that with no chain to disagree
// with, a jump was safe. It was safe and it was still wrong, for a reason
// that only shows up in use:
//
//   THE SANDBOX IS THE TESTBED FOR THE TURN ORDER. 1830's operating sequence
//   is the hardest ordering in the game to internalise, and the one thing
//   the sandbox is for is walking it. A strip whose steps can be clicked
//   turns the sequence into a menu -- and worse, it lets a tester reach a
//   state the contract cannot reach, then report the resulting behaviour as
//   a bug in a flow that no live game can enter. A testbed that permits
//   illegal transitions is not testing the thing it appears to test.
//
//   IT ALSO SKIPPED WORK SILENTLY. Clicking `Run Routes` from `Lay Track`
//   jumped `Station Tokens` without dispatching anything, so the corporation
//   arrived at Routes having never been offered a token placement and
//   nothing in the Action Log recorded that it had been passed over.
//
// So there are now exactly three ways the cursor moves, and all three are
// events with a record:
//
//   FORWARD, by acting  -- laying a tile, placing a token, running a route,
//                          declaring dividends. The action completes the step.
//   FORWARD, by skipping -- the "Skip" button, which dispatches the real
//                          `AdvanceOperatingSubPhase` and moves exactly one
//                          step.
//   BACKWARD, by Undo   -- which restores the whole snapshot, cursor
//                          included (`App.tsx` design note #178).
//
// `onSelect` is deleted rather than defaulted to `undefined`, so no caller
// can pass one: a prop that exists is a prop somebody eventually wires up.
//
// ===================================================================
//  DESIGN NOTE 2: FIVE STEPS OR SIX, DEPENDING ON THE ERA
// ===================================================================
//
// `BuyPrivate` leads the turn but does not exist before Phase 3: the
// contract starts its cursor at `Track` while the era is Yellow, and
// `initialOrSubPhase` mirrors that. Rendering a greyed-out first step that
// the chain says is not there yet would be inventing a phase.
//
// So the strip is built from whichever steps apply, and NUMBERED from that
// filtered list rather than from a fixed table. At game start that produces
// exactly five steps, 1-5; from Phase 3 it produces six. The numbers always
// describe the turn actually being played.

import React from "react";

import { FONT_SIZE } from "../styles/typography";

/** The legal, chronologically-ordered action sub-phases within one
 *  corporation's Operating Round turn.
 *
 *  Mirrors `or_phase::OR_PHASE_ORDER` in the contract, which is the
 *  AUTHORITY rather than a description -- see design note #1. Lives here
 *  rather than in `App.tsx` so the stepper, the action bar and the labels
 *  below all read one definition; `RulesReference.tsx` keeps its own
 *  independent copy on purpose (that file takes no game-state coupling at
 *  all). */
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

/**
 * Is there anything left for a corporation to buy?
 *
 * ==================================================================
 *  DESIGN NOTE 385: A STEP WITH NOTHING IN IT IS NOT A STEP
 * ==================================================================
 *
 * REPORTED: Buy Private Companies requires too many manual skips when no
 * privates are available.
 *
 * The step was gated on the ERA alone (design note #2 -- hidden before
 * Phase 3 because the contract's cursor starts at Track). From Phase 3 it
 * then appeared on every corporation's turn for the rest of the game, and
 * by the mid-game it is usually empty: privates get bought into treasuries,
 * and Phase 5 closes every one that is left. Six corporations each skipping
 * a dead step every Operating Round is a lot of clicks spent proving a
 * negative.
 *
 * A PRIVATE IS BUYABLE IF a player still holds it -- not closed, and not
 * already inside a corporation. That is the same predicate
 * `eligiblePrivatesForPurchase` applies in `PrivateTradePanel.tsx`, and it
 * is deliberately the same one: the step exists to open that picker, so the
 * step should be present exactly when the picker would have rows.
 *
 * PHASE 5 NEEDS NO SPECIAL CASE. It closes all privates, so every entry has
 * `closed: true` and this returns false on its own. Testing the phase as
 * well would be a second rule that has to be kept in agreement with the
 * first, and the first is the one that is actually true -- what matters is
 * whether anything is buyable, not why it isn't.
 *
 * AN UNKNOWN ROSTER SHOWS THE STEP. `undefined` means the query has not
 * resolved, and hiding a step because data has not arrived would make the
 * strip flicker as it loads -- worse, it would hide a legal action from a
 * player whose privates simply had not loaded yet. Absent evidence is not
 * evidence of absence.
 */
export function hasBuyablePrivate(
  privates: readonly PrivateAvailability[] | null | undefined,
): boolean {
  if (privates === null || privates === undefined) return true;
  return privates.some((entry) => !entry.closed && entry.owner_protocol_id === null);
}

/** Design note #2: the steps that apply in this era.
 *  Design note #385: and in this state of the private roster. */
export function visibleSubPhases(
  era: string | null | undefined,
  privates?: readonly PrivateAvailability[] | null,
): readonly OperatingSubPhase[] {
  const showBuyPrivate = initialOrSubPhase(era) !== "Track" && hasBuyablePrivate(privates);
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
  /* ==================================================================
   *  DESIGN NOTE 235: SKIP AND UNDO SWAPPED LINES
   * ==================================================================
   *
   * `onAdvance` -- the Skip button -- used to render HERE, on the strip,
   * while Undo sat on the action row below. Both were in the wrong place,
   * and the reason is what each control acts on:
   *
   *   SKIP is a TURN ACTION. It is the alternative to laying a tile, placing
   *   a token or running a route -- "I decline this step" -- and it belongs
   *   beside the actions it is an alternative to, so a player scanning the
   *   action row sees every way out of the current step in one line.
   *
   *   UNDO acts on the SUB-PHASE CURSOR. It is the only thing that moves the
   *   turn backwards (design note #1: forward by acting or skipping,
   *   backward by undoing), so it belongs on the strip that displays that
   *   cursor -- the two controls that move the same pointer, together.
   *
   * So this component no longer renders a button of its own. It renders the
   * strip and a `trailing` slot, and the bar supplies both controls in their
   * new homes. `onAdvance` is gone from the props rather than left unused:
   * a callback nothing calls is a callback somebody re-wires. */
  /** Rendered at the end of the strip -- the Undo control, supplied by the
   *  bar. A slot rather than a prop pair because this component has no
   *  opinion about what belongs there beyond WHERE it goes. */
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
  chevron: { color: "#4a5163", fontSize: FONT_SIZE.small, padding: "0 2px" },
  step: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 10px",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a4150",
    backgroundColor: "#1b2130",
    color: "#9aa0ac",
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
  stepDone: { color: "#6f7480", borderColor: "#2b3242", backgroundColor: "#161b27" },
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
    border: "1px solid #4a5163",
    backgroundColor: "#232936",
    color: "#e2e6ee",
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
