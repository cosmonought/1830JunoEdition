// frontend/src/utils/cashDelta.ts
//
// What just changed about a player's money.
//
// Design note #670: A NUMBER CANNOT CONFIRM A CHANGE.
//
// REPORTED: "when players click Pay Dividends, it is very hard to tell if the
// game is actually doing so."
//
// The payout was working, and the Activity Log said so in a full sentence. What
// was missing is that a cash figure of $540 only reads as a payout if the reader
// had memorised $530 a moment earlier -- so the fix is not "show the cash", it
// is "show the DIFFERENCE, briefly, next to it". This module owns the
// difference; nothing here draws anything.
//
// PURE, and separate from the component for the ordinary reason: the interesting
// cases are all about sequences of states -- a player arriving, a replay
// rewriting history, two payouts landing inside one window -- and a sequence is
// something a test can state and a screenshot cannot.
//
// THE THREE RULES, all of which cost a bug to find:
//
//   ARRIVING IS NOT EARNING. A player's first appearance in the cash table is
//   the deal, not a payment. Emitting it would open every game with "+$600" on
//   every seat, which is the loudest possible way to teach a reader that the
//   badge means nothing.
//
//   CHANGES ACCUMULATE INSIDE THE WINDOW. Two corporations paying the same
//   shareholder three seconds apart is one reader looking at one badge, and
//   "+$30" is true where "+$20" -- the later of the two -- is a figure that
//   matches nothing that happened.
//
//   A NET ZERO IS NOT A CHANGE. Buy a share for $67 and undo it and the player
//   is exactly where they started; a badge reading "+$0" would be an event
//   notice for a non-event.
//
// See docs/ai_architecture/ui_shell_layout.md, cashDelta.ts #670.

import type { GameStateResponse } from "./gameState";

/** Every seat's cash, keyed by address. A plain object rather than the
 *  contract's array, because every question below is a lookup. */
export type CashByPlayer = Readonly<Record<string, number>>;

/** One player's recent movement, as the strip renders it. */
export interface CashDelta {
  address: string;
  /** Signed, in whole VGP. Never zero -- see the third rule above. */
  amount: number;
  /** When the run of changes this badge represents last grew, epoch ms. The
   *  window is measured from the LATEST change, so a second payout refreshes
   *  the badge rather than letting it expire mid-story. */
  at: number;
}

/** How long a badge stays up. Long enough to look away from the board and back,
 *  short enough that it is plainly about something that just happened rather
 *  than a permanent part of the row. */
export const CASH_DELTA_TTL_MS = 6_000;

/** The cash column, as a map.
 *
 *  `cash_vgp` is the contract's fixed-point string (project rule: no floats
 *  anywhere near money). A row that will not parse is DROPPED rather than
 *  read as zero -- an unparseable balance is an unknown one, and treating it
 *  as $0 would manufacture a spectacular delta on the next poll. */
export function cashByPlayer(state: GameStateResponse | null): CashByPlayer {
  if (!state) return {};
  const out: Record<string, number> = {};
  for (const row of state.player_cash) {
    const value = Number(row.cash_vgp);
    if (!Number.isFinite(value)) continue;
    out[row.player] = value;
  }
  return out;
}

/** What moved between two cash maps.
 *
 *  A player present in `after` but not `before` is SKIPPED -- rule one. A player
 *  present in `before` but not `after` has left the table and has nothing to
 *  report. */
export function cashChanges(
  before: CashByPlayer,
  after: CashByPlayer,
): Array<{ address: string; amount: number }> {
  const out: Array<{ address: string; amount: number }> = [];
  for (const address of Object.keys(after)) {
    const was = before[address];
    if (was === undefined) continue;
    const amount = after[address] - was;
    if (amount === 0) continue;
    out.push({ address, amount });
  }
  return out;
}

/** The badge set, after folding in `changes` and dropping whatever has expired.
 *
 *  Called on every state change with an empty `changes` too -- that is how a
 *  badge ages out without the caller needing a second code path for "nothing
 *  happened, but time passed".
 *
 *  PURE AND TOTAL: given the same arguments it returns the same array, and the
 *  order is the caller's own (existing badges keep their position, new ones
 *  append). The strip renders one row per player and looks its badge up, so the
 *  order is not load-bearing -- but a function that reorders its output for no
 *  reason is one whose output cannot be compared in a test. */
export function settleCashDeltas(
  current: readonly CashDelta[],
  changes: ReadonlyArray<{ address: string; amount: number }>,
  now: number,
  ttlMs: number = CASH_DELTA_TTL_MS,
): CashDelta[] {
  const live = current.filter((delta) => now - delta.at < ttlMs);
  if (changes.length === 0) return live;

  const next = live.map((delta) => ({ ...delta }));
  for (const change of changes) {
    const at = next.findIndex((delta) => delta.address === change.address);
    if (at === -1) {
      next.push({ address: change.address, amount: change.amount, at: now });
      continue;
    }
    // Rule two: accumulate, and restart the clock on the combined figure.
    next[at] = {
      address: change.address,
      amount: next[at].amount + change.amount,
      at: now,
    };
  }
  // Rule three: a run that nets to nothing is not an event.
  return next.filter((delta) => delta.amount !== 0);
}

/** `+$30` / `−$67`. A real minus sign, not a hyphen: the two are a pixel apart
 *  at badge size and only one of them is a minus. */
export function formatCashDelta(amount: number): string {
  const magnitude = Math.abs(Math.round(amount));
  return `${amount < 0 ? "−" : "+"}$${magnitude}`;
}
