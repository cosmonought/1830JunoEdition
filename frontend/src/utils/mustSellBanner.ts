// frontend/src/utils/mustSellBanner.ts
//
// ==================================================================
//  PHASE 3 W2-B (AUD-03.07): THE MUST-SELL HOLD, SAID WHERE THE SHARES ARE
// ==================================================================
//
// THE AUDIT: "The must-sell hold is shown only in tooltips." #759's rule (iii) -- a player over a limit "should not be
// able to buy shares OR skip/pass/auto-pass their turn until these sales have been made" -- is enforced at both locks
// (`divestmentPassRefusal`, `sharePurchaseBlock`), and its sentence reached the player only as the `title` of a greyed
// Pass and greyed Buy buttons. A player looking at the Stocks tab saw controls that would not work and had to hover
// one to learn why.
//
// SO THE PANEL SAYS IT ONCE, AT THE TOP, AND READS NOTHING OF ITS OWN. This is a projection of the authority's debt
// (`divestmentDebt`, the curable excess only -- DA-5) into what the banner draws: the authority's own sentence
// (`divestmentRefusal`, the exact string that greys the Pass) and the floor of certificates still to go
// (`minimumCertificatesToSell`, "a floor, not an instruction"). No debt, no banner -- outside a Stock Round, for a
// seatless viewer, or once the sales have been made, the debt is empty and this answers `null`.
//
// NOT A STAGE. The obsolete Sell -> Buy walk (#1443, superseded by OD-2 / rules v13) was about the ORDER of a turn;
// this is an obligation about holdings, which stands until it is discharged whatever the turn has done.

import { divestmentRefusal, minimumCertificatesToSell, type DivestmentDebt } from "../gameEngine/forcedDivestment";

export interface MustSellBanner {
  /** The authority's own sentence -- identical to the Pass button's refusal. */
  reason: string;
  /** The fewest certificates that would clear the debt (at least 1). */
  minimumCertificates: number;
}

export function mustSellBannerOf(debt: DivestmentDebt): MustSellBanner | null {
  const reason = divestmentRefusal(debt);
  if (reason === null) return null;
  return { reason, minimumCertificates: Math.max(1, minimumCertificatesToSell(debt)) };
}
