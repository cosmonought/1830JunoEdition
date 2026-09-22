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

/* ==================================================================
    DESIGN NOTE (VF-6): ONE BADGE, THREE STATES
   ==================================================================
   The Bank indicator stops being a warning that vanishes and becomes one continuous strategic object: it
   is absent while the Bank is comfortable, counts DOLLARS down in the shared urgency grammar as it
   approaches, and then -- at the break -- keeps its place and its silhouette and starts counting ROUNDS.

   THE LATCH DECIDES, AND IT DECIDES FIRST. `status` is `bankBrokenStatus`'s answer, which asks
   `bankIsBroken` (#1561) rather than looking at a balance. So a Bank that receives money after breaking --
   the owner's own `$10 -> pays $30 -> receives $100 -> $80` -- never gets its dollar countdown back: the
   broken arm is taken before `remaining` is so much as read. That ordering is the rule, not an
   optimisation, and the test for it passes a POSITIVE balance alongside a broken status.

   THE TONE IS THE STATE AND THE SHAPE IS THE CATEGORY. Amber and crimson are the existing shared alert
   grammar (#7: one escalation decision, shared with the train chips); the post-break tone is the
   application's existing special-event rainbow, because the meaning has changed from "danger approaching"
   to "a global event has happened". The ticket silhouette is the same in all three states, so the badge is
   recognisably one object that changed rather than two badges that swapped.

   THE PULSE STOPS AT THE BREAK. `pulses` is false on the broken arm by construction, not by a caller
   remembering to switch it off: the critical pulse means "act before this lands", and it has landed. */

/** What the Bank ticket reads, in any of its three states. */
export type BankTicketTone = "warn" | "critical" | "broken";

export interface BankTicketReading {
  tone: BankTicketTone;
  /** The ticket's own text. Post-break it says BANK BROKEN out loud -- the rainbow is never the only
   *  indication of the state (accessibility), and the count is part of the sentence rather than a tooltip. */
  label: string;
  /** The same fact at length, for `aria-label`. */
  detail: string;
  /** The existing critical pulse. NEVER true once the Bank has broken. */
  pulses: boolean;
  /** Operating Rounds left, post-break only. */
  orsRemaining: number | null;
}

/** The ticket for a Bank in any state, or `null` when there is nothing to show.
 *
 *  `status` is `bankBrokenStatus(state)` from `bankBreakEndgame.ts` -- passed in rather than derived here,
 *  so this module stays free of the round machine and can be asked about a bare number. A broken Bank
 *  whose status is `null` (the game has ended) shows nothing at all: the outro owns that screen. */
export function bankTicketReading(
  status: { orsRemaining: number } | null,
  remaining: number | null | undefined,
): BankTicketReading | null {
  if (status !== null) {
    const rounds = status.orsRemaining;
    // Never "0 ORs remaining": `bankBrokenStatus` refuses to produce a zero, and this refuses to print one.
    if (!Number.isFinite(rounds) || rounds < 1) return null;
    const plural = rounds === 1 ? "OR" : "ORs";
    return {
      tone: "broken",
      label: `BANK BROKEN · ${rounds} ${plural} remaining`,
      detail:
        rounds === 1
          ? "The Bank has broken. The game ends when this Operating Round finishes."
          : `The Bank has broken. The game ends after ${rounds} more Operating Rounds.`,
      pulses: false,
      orsRemaining: rounds,
    };
  }
  const warning = bankBreakWarning(remaining);
  if (!warning) return null;
  return {
    tone: warning.critical ? "critical" : "warn",
    label: warning.label,
    detail: warning.detail,
    pulses: warning.critical,
    orsRemaining: null,
  };
}
