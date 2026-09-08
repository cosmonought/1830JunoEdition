// frontend/src/utils/treasuryMovement.ts
//
// What a corporation's treasury just did, read off the two states the dispatch already has.
//
/* ==================================================================
 *  DESIGN NOTE 1272: THE TREASURY MOVES, AND THE PLAYER IS TOLD BY THE MONEY, NOT BY A SENTENCE
 * ==================================================================
 *
 * REPORTED (7 September plan, 4.2): "the train-purchase toast is not registering with players. Other
 * consequential moments have stronger, more direct indicators -- laying on a terrain hex warns about the cost
 * and treasury effect, a dividend opens the dividend machine slide-out -- and a toast is the weakest signal in
 * the vocabulary."
 *
 * SO THE TREASURY GETS THE MACHINE THE PLAYER'S CASH ALREADY HAS. #1060 built the dividend slide-out because a
 * figure a player has to compare against a memorised one confirms nothing; a treasury that drops from $920 to
 * $740 is the same fact in the same register, and the only reason it was a toast is that the toast came first.
 *
 * A DIFF, NOT A SIGNAL, for #1002's reason: the reducer settles and the shell narrates, and every message that
 * touches a treasury -- the depot purchase, the emergency purchase, the diesel exchange, a terrain fee, a
 * station token, a withheld dividend, a corporation-to-corporation trade on both sides -- would otherwise be a
 * call site that has to remember. What is observable afterwards is that `treasury` changed, which is this
 * function. It does not know why; the Activity Log's sentence says why, and the machine says how much.
 *
 * MULTIPLE MOVEMENTS ARE RETURNED IN ROSTER ORDER. A trade moves two treasuries in one action; the caller
 * shows the acting corporation's when it can tell which that is, and the first otherwise. */

import type { GameStateResponse } from "./gameState";

export interface TreasuryMovement {
  companyId: number;
  ticker: string;
  before: number;
  after: number;
  /** `after - before`; negative for a spend. Never zero -- an unchanged treasury is not a movement. */
  delta: number;
}

function treasuryOf(state: GameStateResponse, companyId: number): number | null {
  const company = state.public_companies?.find((entry) => entry.company_id === companyId);
  if (!company) return null;
  const raw = Number(company.treasury ?? NaN);
  return Number.isFinite(raw) ? raw : null;
}

/** Every corporation whose treasury differs between the two states. `[]` when nothing moved, or when either
 *  side is absent -- #232's reading, "the chain did not say" is never "zero". */
export function treasuryMovements(
  before: GameStateResponse | null | undefined,
  after: GameStateResponse | null | undefined,
): TreasuryMovement[] {
  if (!before || !after) return [];
  const out: TreasuryMovement[] = [];
  for (const company of after.public_companies ?? []) {
    const was = treasuryOf(before, company.company_id);
    const now = treasuryOf(after, company.company_id);
    if (was === null || now === null || was === now) continue;
    out.push({
      companyId: company.company_id,
      ticker: company.ticker,
      before: was,
      after: now,
      delta: now - was,
    });
  }
  return out;
}

/** The one movement to show for a dispatch: the acting corporation's when it moved, else the first. */
export function movementToShow(
  movements: readonly TreasuryMovement[],
  actingCompanyId: number | null,
): TreasuryMovement | null {
  if (movements.length === 0) return null;
  if (actingCompanyId !== null) {
    const acting = movements.find((movement) => movement.companyId === actingCompanyId);
    if (acting) return acting;
  }
  return movements[0];
}
