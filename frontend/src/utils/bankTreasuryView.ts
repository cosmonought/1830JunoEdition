// frontend/src/utils/bankTreasuryView.ts
//
// What the ledger's Bank Treasury table says about the bank. Display only.
//
// ==================================================================
//  PHASE 3 W1-I (AUD-12.01 / K-23, U-27): A BROKEN BANK IS SAID SO, AND THE SHARE IS NEVER PAST 100%
// ==================================================================
//
// THE BANK PAYS PAST ZERO (D-15 / Q1b; `cashLedger.debitBank`), so after the break `virtual_bank_vgp` can read
// "-20". The table printed that balance raw ("$-20", or "$0" as "remaining") and computed "Paid Out So Far" as
// `(start - current) / start`, which is over 100% the moment the balance is negative -- and below 0% early in the
// game, when the bank has taken in more (private sales) than it has paid out.
//
// NOW: a negative balance reads "Bank broken — owes $N"; a broken bank at or above zero says it is broken beside
// its balance (D-15: a credit after the break never un-breaks it, so "broken" is `bankIsBroken`'s answer, not the
// sign); and the paid share is the TRUE share of the starting bank that has left it -- clamped to 0..100, and
// floored, so 100% is shown only once the starting bank is really gone.
//
// DISPLAY ONLY. Nothing here feeds a rule or a payout; the board's strings are read as integers (the VGP balances
// are whole numbers), and an unreadable value is shown as the board gave it, never guessed at.

import type { GameStateResponse } from "../gameEngine/gameState";
import { bankIsBroken } from "../gameEngine/endgame";

export interface BankTreasuryView {
  /** The Remaining Bank Cash cell. */
  remaining: string;
  /** The Paid Out So Far cell: a whole percentage in 0..100, or "--" when the start is unknown. */
  paidOut: string;
  /** Whether the bank has broken (latch or balance), for the cell's emphasis. */
  broken: boolean;
}

type BankFields = Pick<GameStateResponse, "virtual_bank_start" | "virtual_bank_vgp" | "bank_broken">;

const wholeNumber = (raw: unknown): number | null => {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isSafeInteger(value) ? value : null;
};

export function bankTreasuryView(state: BankFields): BankTreasuryView {
  const start = wholeNumber(state.virtual_bank_start);
  const current = wholeNumber(state.virtual_bank_vgp);
  const broken = bankIsBroken(state as GameStateResponse);

  let remaining: string;
  if (current === null) remaining = `$${state.virtual_bank_vgp}`;
  else if (current < 0) remaining = `Bank broken — owes $${-current}`;
  else if (broken) remaining = `Bank broken — $${current} left`;
  else remaining = `$${current}`;

  let paidOut = "--";
  if (start !== null && start > 0 && current !== null) {
    const paid = Math.min(start, Math.max(0, start - current));
    paidOut = `${Math.floor((paid * 100) / start)}%`;
  }

  return { remaining, paidOut, broken };
}
