// frontend/src/utils/stockRoundSaleBlock.ts
//
// ==================================================================
//  6.5-B (K-08): A GRANTED SHARE OF A CORPORATION NOBODY HAS STARTED
// ==================================================================
//
// The C&A's buyer holds a 10% PRR share (and the M&H's exchanger an NYC share) before anybody has bought that
// corporation's President's Certificate. Rulebook p.15: those shares "cannot be sold until the president's
// certificate has been purchased" -- the sale authority's rule 4 (`stockSaleRefusal`), which the server asks. The
// Stock Round card's verdict (`App.saleBlockFor`) was `shareSaleBlock` alone, which has no par check, so row S-13 of
// the playtest matrix offered a live Sell that the server then refused.
//
// `shareSaleBlock` IS NOT TOUCHED: the reducer, the sale authority, divestment and emergency funding all share it.
// The shell asks this FIRST: for an UNPARRED corporation it is the sale authority itself, with the viewer as the
// seller, so the greyed Sell carries exactly the sentence the server would have answered with; for every parred
// corporation it is `null` and the shell's `shareSaleBlock` answer stands, unchanged.

import type { GameStateResponse } from "../gameEngine/gameState";
import { stockSaleRefusal } from "../gameEngine/stockTransactionAuthority";

/** The sale authority's refusal for a share of a corporation that has no par yet, or `null` when the corporation
 *  has been started (or is not on the board -- `shareSaleBlock` answers that). */
export function unstartedCorporationSaleRefusal(input: {
  state: GameStateResponse;
  seller: string;
  companyId: number;
  percentage: number;
}): string | null {
  const { state, seller, companyId, percentage } = input;
  const company = state.public_companies.find((entry) => entry.company_id === companyId);
  if (!company || (company.par_value !== null && company.par_value !== undefined)) return null;
  return stockSaleRefusal({ state, sell: { companyId, percentage }, actor: seller });
}
