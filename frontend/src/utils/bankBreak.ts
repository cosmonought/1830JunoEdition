// frontend/src/utils/bankBreak.ts
//
// ==================================================================
//  DESIGN NOTE 1410: THE BANK BREAK COUNTDOWN
// ==================================================================
//
// REQUESTED: "add a warning badge for 'Bank Break' counting down from $2000. 'Bank Break: $2000 remaining' in
// orange and once it's at $1000 or below it becomes red and flashing."
//
// The bank's balance is `virtual_bank_vgp` (the reducer's, replayed -- every client agrees on it). The badge
// appears once the bank holds `BANK_BREAK_WARN_AT` or less, in the rust warning's amber; at
// `BANK_BREAK_CRITICAL_AT` or less it takes the rust warning's crimson and its pulse. Pure arithmetic here so
// the two rails that show it (#654's Stock Round lead and the Operating Round rail) cannot disagree.

export const BANK_BREAK_WARN_AT = 2000;
export const BANK_BREAK_CRITICAL_AT = 1000;

export interface BankBreakWarning {
  label: string;
  detail: string;
  /** `true` at or below the critical line: crimson and pulsing. Amber and still otherwise. */
  critical: boolean;
}

/** The badge to show for a bank holding `remaining`, or `null` while it is comfortably solvent. */
export function bankBreakWarning(remaining: number | null | undefined): BankBreakWarning | null {
  if (remaining === null || remaining === undefined || !Number.isFinite(remaining)) return null;
  if (remaining > BANK_BREAK_WARN_AT) return null;
  const left = Math.max(0, Math.floor(remaining));
  const critical = left <= BANK_BREAK_CRITICAL_AT;
  return {
    label: `Bank Break: $${left} remaining`,
    detail: critical
      ? `The Bank holds $${left}. When it runs out the game ends at the close of the current Operating Round set.`
      : `The Bank holds $${left}. The game ends when it breaks.`,
    critical,
  };
}
