// frontend/src/gameEngine/privatePriceBand.ts
//
// Rulebook 3.1: "The price paid may not be less than half or more than twice the face value of the company and
// must be publicly declared." One band, mirrored by the contract, used by the trade panel (its former home,
// `PrivateTradePanel.tsx`, re-exports these) and by the emergency private sale (#1541), so the two cannot
// disagree about a legal price.

export const PRIVATE_PRICE_MIN_FACTOR = 0.5;
export const PRIVATE_PRICE_MAX_FACTOR = 2;

export function privatePriceBounds(faceValue: number): { min: number; max: number } {
  // Integer VGP either side. `ceil` on the floor and `floor` on the ceiling, so a rounded bound can never fall
  // OUTSIDE the band the contract checks -- rounding the other way would offer a price that looks legal here and
  // is rejected on chain, which is the one failure this mirror exists to prevent.
  return {
    min: Math.ceil(faceValue * PRIVATE_PRICE_MIN_FACTOR),
    max: Math.floor(faceValue * PRIVATE_PRICE_MAX_FACTOR),
  };
}

/** Rulebook 3.0: "During phases 3 and 4, a railroad may buy a private company". */
export function privatePurchasePhaseOpen(tier: string | null | undefined): boolean {
  return tier === "3" || tier === "4";
}
