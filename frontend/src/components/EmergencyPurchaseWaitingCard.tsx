// What every seat but the obligated president -- and every watcher -- sees while an emergency train purchase is
// being resolved.
//
// ==================================================================
//  PHASE 3 W2-G (OD-1 VIEWER SCOPE): ONE READ-ONLY STATUS, NO CONTROLS -- IN W2-H's WAITING SURFACE
// ==================================================================
// The old modal mounted the whole funding surface on every screen, "Declare bankruptcy" included (P3-N017). The
// ruling: the obligated president gets the interactive workflow (`EmergencyTrainPurchaseModal`); everybody else gets
// a status naming who the table is waiting on -- e.g. "PRR is resolving an emergency train purchase — waiting on
// Alice." -- and never an actionable funding or bankruptcy control.
//
// v13 RECONCILIATION: rendered through W2-H's `WaitingStatusBanner`, the one surface every waiting prompt uses (not
// modal, a keyboard focus target, the sentence in a polite live region, no controls -- not even a disabled one), so
// the emergency stop and the home-station / auction stops read alike. The board stays usable behind it, and the
// authoritative hold (`emergencyFundingBlock`) is what keeps everything else from happening, not this card. The
// answer prompts a non-president may have to use (`TrainTradePrompt`, `FundingPrivateOfferPrompt`) sit at the bottom
// right and are never covered by it.

import React from "react";

import { WaitingStatusBanner } from "./WaitingStatusBanner";

export interface EmergencyPurchaseWaitingCardProps {
  /** `emergencyWaitingSentence(...)`, or `null` when no emergency purchase stands (or this viewer is its president). */
  sentence: string | null;
}

export function EmergencyPurchaseWaitingCard({ sentence }: EmergencyPurchaseWaitingCardProps) {
  if (!sentence) return null;
  return (
    <WaitingStatusBanner heading="Emergency train purchase" testId="emergency-purchase-waiting">
      {sentence}
    </WaitingStatusBanner>
  );
}

export default EmergencyPurchaseWaitingCard;
