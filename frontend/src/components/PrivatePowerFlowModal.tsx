// frontend/src/components/PrivatePowerFlowModal.tsx
//
// The private power, walked through one step at a time.
//
// Design note #848: one modal for both hex powers, rendering `privatePowerFlow`'s steps. It writes no rules
// and no copy -- every sentence and every label comes from that module, so the D&H's two lines and the
// C&SL's one cannot drift apart or from the catalog they describe.
//
// IT REPLACES TWO COMPONENTS. `PrivatePowerPrompt` (#845) asked "use this power?" and then dropped the
// player on the board; `DhStationPrompt` (#818) asked about the free station with no memory that a lay had
// just happened. They were the two halves of this, built a report apart. #818's REASONING SURVIVES IN
// `privatePowerFlow.ts` -- the free station must be taken or forfeited by a named button and never by a
// dismissal -- and its Forfeit button is line two's `declineLabel`.
//
// THE X IS CONDITIONAL, WHICH IS THE WHOLE POINT OF IT. Asked for exactly that way: "an X button to cancel
// the private power usage (which should disappear once they've committed to its first action)". Before the
// lay there is nothing to undo; after it, an X would have to mean "forfeit the token", and the button that
// says so in words is right there.
//
// A DONE STEP STAYS ON SCREEN, greyed, rather than disappearing. The player is being walked through a
// sequence, and a sequence that deletes its finished steps leaves them looking at a different modal than the
// one they were reading.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import type { PowerFlow, PowerFlowStep } from "../utils/privatePowerFlow";

export interface PrivatePowerFlowModalProps {
  flow: PowerFlow;
  /** The corporation using it, for the line that names it. */
  ticker: string;
  /** Unplaced station markers, or `null` when the room has not reported them.
   *
   *  Design note #818: FREE IS NOT COSTLESS -- the marker comes out of the corporation's own supply, so a
   *  company down to its last one is choosing between Scranton and somewhere it would rather be. Absent
   *  rather than guessed when unknown. */
  tokensLeft: number | null;
  /** ==================================================================
   *   DESIGN NOTE 882: WHY THE LAST ATTEMPT DID NOT HAPPEN
   *  ==================================================================
   *
   *  #848 CLAIMS THIS COMPONENT "writes no rules and no copy", and this prop is what keeps that true of the
   *  refusal too: the sentence is composed by `privateExchange.ts`, which is where the rule being broken
   *  lives, and arrives here already written. #872 found the same claim two strings short and fixed it the
   *  same way.
   *
   *  IT IS NOT A STEP, and that is deliberate. A refusal is not a stage of the flow -- nothing was spent,
   *  the step it belongs to is still live, and rendering it as a fourth greyed box would say the opposite.
   *  It is an answer to the last press, so it sits above the steps and the step below it stays enabled.
   *
   *  `null` WHENEVER THE FLOW IS CLEAN, including for a refusal belonging to a different power: the shell
   *  matches the ability key before passing it, so this component never has to ask whether the sentence is
   *  about the power it is showing. */
  refusal?: string | null;
  onAct: (step: PowerFlowStep["key"]) => void;
  onDecline: (step: PowerFlowStep["key"]) => void;
  /** Only called while `flow.cancellable`; the control is not rendered otherwise. */
  onCancel: () => void;
}

export function PrivatePowerFlowModal({
  flow,
  ticker,
  tokensLeft,
  refusal = null,
  onAct,
  onDecline,
  onCancel,
}: PrivatePowerFlowModalProps): React.ReactElement {
  return (
    <div style={styles.backdrop} role="alertdialog" aria-modal="true" aria-label={flow.title}>
      <div style={styles.card}>
        <div style={styles.header}>
          <h2 style={styles.title}>{flow.title}</h2>
          {/* Design note #848: present only while nothing is committed. Not disabled -- ABSENT: a greyed X
              would still read as "there is a way out of this", which after the lay there is not. */}
          {flow.cancellable && (
            <button
              type="button"
              style={styles.close}
              onClick={onCancel}
              aria-label="Cancel this private power"
              title="Put the power back — nothing has been spent yet."
            >
              &#10006;
            </button>
          )}
        </div>

        {/* Design note #872: the sentence comes from the flow now. It read `{ticker} holds this power.`
            here, which is right for the two corporate hex powers and wrong for the M&H -- a PLAYER power
            (#441), whose holder has a name rather than a ticker. #848's claim that this component "writes no
            rules and no copy" was two strings away from true; this is one of them. */}
        <p style={styles.who}>{flow.holderLine}</p>

        {/* Design note #882: ABOVE THE STEPS, BELOW THE HOLDER LINE. It answers the last press, so it goes
            where the eye returns after the modal fails to close -- and it must not push the live step off
            screen, which is what putting it under the buttons would do on the D&H's two-step card.
            AMBER, NOT RED, matching the panel line this replaces: nothing was spent and the power is intact,
            so a destructive colour would misdescribe a refusal a player can act on and come back from. */}
        {refusal && (
          <p style={styles.refusal} role="alert">
            {refusal}
          </p>
        )}

        {flow.steps.map((step, index) => (
          <div
            key={step.key}
            style={{
              ...styles.step,
              ...(step.done ? styles.stepDone : {}),
              ...(step.enabled ? styles.stepLive : {}),
            }}
          >
            <p style={styles.stepText}>
              <span style={styles.stepIndex}>{index + 1}.</span> {step.text}
            </p>
            {/* Design note #818: the supply, on the step that spends it. */}
            {step.key === "station" && tokensLeft !== null && (
              <p style={styles.supply}>
                {ticker} has {tokensLeft} station marker{tokensLeft === 1 ? "" : "s"} left to place.
              </p>
            )}
            <div style={styles.stepActions}>
              {/* Design note #674: the decline is a peer, not a lesser -- forfeiting to keep a marker for a
                  city that matters more is an ordinary play. It is drawn as a secondary control because it
                  is the negative of the pair, not because it is the worse choice. */}
              {step.declineLabel && (
                <button
                  type="button"
                  style={{
                    ...styles.secondary,
                    ...(step.enabled ? {} : styles.buttonDisabled),
                  }}
                  disabled={!step.enabled}
                  onClick={() => onDecline(step.key)}
                  /* Design note #872: and the other one. This was the D&H's forfeit sentence, hardcoded --
                     true of the only decline that existed when it was written, and the exact opposite of the
                     M&H's, where declining gives up nothing at all. `declineHint` travels with the step. */
                  title={step.enabled ? (step.declineHint ?? undefined) : "Available once the tile is laid."}
                >
                  {step.declineLabel}
                </button>
              )}
              <button
                type="button"
                style={{
                  ...styles.primary,
                  ...(step.enabled ? {} : styles.buttonDisabled),
                }}
                disabled={!step.enabled}
                onClick={() => onAct(step.key)}
                /* Design note #619: a disabled button has to LOOK disabled, and #732's rule that a greyed
                   control means one thing -- here, "not yet", which the `title` says in words because a
                   player cannot see an order of operations. */
                title={
                  step.done
                    ? "Already done."
                    : step.enabled
                      ? undefined
                      : "Available once the step above is finished."
                }
              >
                {step.done ? `${step.actionLabel} ✓` : step.actionLabel}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    backgroundColor: "rgba(6, 9, 16, 0.72)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 60,
    padding: "20px",
  },
  card: {
    width: "min(520px, 100%)",
    /* Design note #840: longhands, never a `border` shorthand a sibling state could override -- see
       `PrivateTradePanel`'s #840 for the white frame React could not put back. */
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#454c5c",
    borderRadius: "12px",
    backgroundColor: "#1e2331",
    boxShadow: "0 18px 48px rgba(0, 0, 0, 0.55)",
    padding: "18px 20px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" },
  title: { margin: 0, fontSize: FONT_SIZE.heading, color: "#e2e6ee" },
  close: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#4a5163",
    borderRadius: "6px",
    backgroundColor: "transparent",
    color: "#c8cdd8",
    fontSize: FONT_SIZE.control,
    lineHeight: 1,
    padding: "4px 8px",
    cursor: "pointer",
  },
  who: { margin: 0, fontSize: FONT_SIZE.small, color: "#9aa2b1" },
  /* Design note #882: the powers panel's `abilityError` treatment, carried over unchanged so the refusal a
     player used to read below the fold looks like the same object in its new home.
     LONGHANDS, per #732/#840: this box sits among siblings (`step`, `stepLive`) that override
     `borderColor`, and a `border` shorthand here is exactly the pairing that makes React write
     `borderColor = ""` on the render that drops the override. */
  refusal: {
    margin: 0,
    padding: "9px 11px",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#6b4a2f",
    backgroundColor: "#2a1d13",
    color: "#e6c08a",
    fontSize: FONT_SIZE.small,
    lineHeight: 1.45,
  },
  step: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a4150",
    borderRadius: "8px",
    backgroundColor: "#1b2130",
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  /* Design note #848: the live step carries the app's "this is the one you are acting on" blue, the same
     frame `PrivateTradePanel`'s open card wears (#804). One vocabulary for one meaning. */
  stepLive: { borderColor: "#4d8ee0", backgroundColor: "#1d3a55" },
  stepDone: { opacity: 0.66 },
  stepText: { margin: 0, fontSize: FONT_SIZE.body, color: "#d7dbe4", lineHeight: 1.5 },
  stepIndex: { fontWeight: 700, color: "#9aa2b1" },
  supply: { margin: 0, fontSize: FONT_SIZE.small, color: "#9aa2b1" },
  stepActions: { display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: "10px" },
  primary: {
    padding: "9px 16px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#4ade80",
    backgroundColor: "#16a34a",
    color: "#04140a",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  secondary: {
    padding: "9px 16px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#4a5163",
    backgroundColor: "#242b3a",
    color: "#e2e6ee",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  buttonDisabled: { opacity: 0.45, cursor: "not-allowed" },
};

export default PrivatePowerFlowModal;
