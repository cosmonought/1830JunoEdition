// frontend/src/components/WaitingOnLine.tsx
//
/* ==================================================================
    PHASE 3 W2-F (OD-1, AUD-09.09 / U-6, AUD-09.08 / U-5): ONE "WAITING ON X" LINE FOR EVERY CONSENT PROMPT
   ==================================================================
   Each prompt in the consent slot -- the private purchase offer, the train offer, the emergency funding offer, the
   player <-> player trade pointer and the excess-train discard -- printed its own waiting sentence, five spellings of
   one situation. OD-1 asks for one clear "Waiting on X / what is being decided" status on every seat.

   SO EVERY PROMPT NOW RENDERS THIS LINE, in one shape:
     - WHO: the prompt's own seat fact -- "This is <answerer>'s decision." for the seat that must decide, otherwise
       "Waiting on <answerer>." The answerer is the one the existing seat authorities name (`offerConsentView`, the
       discard's / funding offer's named president); this line decides nothing about who may act.
     - WHAT: the authority's sentence for the hold the table is under -- the shell's one hold answer
       (`dockHoldView(...).turnHoldReason`): `describeStandingOffer` inside `pendingOfferBlock`, the funding offer's
       `emergencyFundingBlock`, the discard's `pendingDiscardBlock`, in the authority's own priority, with names for
       seat ids. Every seat reads the same sentence. Nothing here restates a rule or chooses between holds.
   `null` (no hold reported -- a scrubbed past board) prints the WHO line alone rather than a guessed sentence. */

import React from "react";

export interface WaitingOnLineProps {
  /** The seat the decision belongs to, as the prompt names it. */
  who: string;
  /** Whether the viewer is that seat. */
  viewerDecides: boolean;
  /** The hold's own sentence (`dockHold.turnHoldReason`), or `null`. */
  sentence: string | null;
  /** The prompt's own paragraph style, so the line keeps its prompt's register. */
  style?: React.CSSProperties;
}

/** The WHO half, exactly as the prompt shows it. Exported for the tests and for nobody else. */
export function waitingOnLead(who: string, viewerDecides: boolean): string {
  if (viewerDecides) return who === "you" ? "This is your decision." : `This is ${who}'s decision.`;
  return `Waiting on ${who}.`;
}

export function WaitingOnLine({ who, viewerDecides, sentence, style }: WaitingOnLineProps) {
  return (
    <p style={style} role="status" data-testid="waiting-on-line">
      <span data-testid="waiting-on-who">{waitingOnLead(who, viewerDecides)}</span>
      {sentence !== null && (
        <>
          {" "}
          <span data-testid="waiting-on-sentence">{sentence}</span>
        </>
      )}
    </p>
  );
}

export default WaitingOnLine;
