// frontend/src/utils/closeRoomPayout.ts
//
// Settling the real JUNO when a finished room closes.
//
/* ==================================================================
 *  DESIGN NOTE 899: THE PAYOUT IS A STUB, AND ITS GUARDS ARE NOT
 * ==================================================================
 *
 * AGREED SCOPE: "Write a placeholder stub for the payout dispatch that simply logs to the console for now. We
 * will fill this with the actual ExecuteMsg logic in Phase 5."
 *
 * SO THE BODY IS A `console.info` AND EVERYTHING AROUND IT IS REAL. A stub that is only a stub teaches the
 * Phase 5 author nothing; the hard part of this dispatch is not the message, it is the three ways it can fire
 * more than once, and all three exist TODAY with fake money. Getting them right now costs a few lines and
 * getting them wrong later costs somebody's JUNO.
 *
 * THE THREE WAYS IT DOUBLE-FIRES, in the order they will actually happen:
 *
 *   1. EVERY CLIENT'S TIMER. Four players, four fifteen-minute countdowns, four dispatches within a second of
 *      each other. This is by design (#899 in `gameSetup.ts`: an elected owner strands the table when they
 *      close their tab), and it is handled in the REDUCER -- `room_closed` makes the second through fourth
 *      `CloseRoom` actions no-ops, so only one of them ever reaches this function.
 *
 *   2. THE MANUAL BUTTON RACING A TIMER. Same mechanism, same answer.
 *
 *   3. A REPLAY. This is the dangerous one and the reducer cannot help with it. Undo rebuilds state by
 *      replaying the whole log, so a log containing `CloseRoom` reaches the open -> closed transition again on
 *      every rebuild -- and a payout fired from a rebuild is a second real transfer for one game. The guard
 *      below is per-room and per-session, which stops it within one browser; it CANNOT stop a different
 *      client, or the same client after a refresh, from replaying that log and arriving here.
 *
 * WHICH MEANS PHASE 5 OWES THE CONTRACT AN IDEMPOTENCY CHECK, and this note is where that requirement is
 * written down rather than discovered. The chain is the only place that can hold "this room has already paid
 * out" across every client and every refresh. A client-side Set is a courtesy; `CloseRoom` on an
 * already-settled room must be refused by the contract, not merely skipped by the caller.
 *
 * See docs/ai_architecture/contract_economy.md, closeRoomPayout.ts #899. */

import type { PlayerStanding } from "./endgame";

/** What the settlement needs to know. Deliberately the standings rather than the game state: the split is
 *  already computed and already shown to the players, and re-deriving it here would be a second authority on
 *  the one number that moves real money. */
export interface RoomPayoutRequest {
  /** `null` for a local game with no room -- which never reaches a real dispatch. */
  roomCode: string | null;
  /** Every player, ranked, with `expectedPayout` already apportioned by share of net worth. */
  standings: readonly PlayerStanding[];
  /** The real JUNO pool the percentages divide. */
  totalAnte: number;
  /** How the closure was reached, for the log line. */
  trigger: "manual" | "timer";
}

export type RoomPayoutResult =
  | { dispatched: true }
  /** Already settled in this session, or nothing to settle. */
  | { dispatched: false; reason: string };

/** Rooms this browser session has already settled -- guard 3 above, to the extent a client can implement it. */
const settled = new Set<string>();

/** Dispatches the on-chain settlement for a closed room.
 *
 *  PHASE 5: replace the `console.info` with the real `ExecuteMsg`. Do not remove the guards around it, and do
 *  not treat them as sufficient -- see the header. */
export function settleRoomPayout(request: RoomPayoutRequest): RoomPayoutResult {
  const key = request.roomCode ?? "local";

  if (settled.has(key)) {
    /* Not an error and not a warning. A replay reaching this point is the NORMAL case after an Undo, and
       logging it as a failure would train whoever reads the console to ignore it. */
    return { dispatched: false, reason: "This room's payout has already been dispatched in this session." };
  }

  const payable = request.standings.filter((row) => row.expectedPayout > 0);
  if (payable.length === 0) {
    /* A pool of nothing, or a table where every net worth is zero. Refused rather than dispatched empty: a
       transfer of nothing is still a transaction somebody pays gas for. */
    return { dispatched: false, reason: "There is nothing to distribute." };
  }

  settled.add(key);

  /* ---- PHASE 5 REPLACES EVERYTHING BELOW THIS LINE ---- */
  console.info(
    `[closeRoomPayout #899] STUB — would settle ${payable.length} payouts from a ${request.totalAnte} JUNO ` +
      `pool for room ${key} (closed by ${request.trigger}):`,
    payable.map((row) => ({
      address: row.address,
      label: row.label,
      netWorth: row.netWorth,
      juno: row.expectedPayout,
    })),
  );
  /* ---- PHASE 5 REPLACES EVERYTHING ABOVE THIS LINE ---- */

  return { dispatched: true };
}

/** Test seam, and the reason it exists is worth a line: without it a case that settles a room would poison
 *  every later case in the same file, and the failure would look like the guard misfiring rather than like
 *  state leaking between tests. */
export function resetSettledRooms(): void {
  settled.clear();
}

/* ------------------------------------------------------------------ */
/* The auto-close countdown                                           */
/* ------------------------------------------------------------------ */

/** Fifteen minutes, the short end of the requested 15-to-30 range.
 *
 *  THE SHORT END ON PURPOSE. The countdown's job is to bound how long a finished table waits on somebody who
 *  has walked away; every player can already close the room themselves at any moment, so a longer timer buys
 *  nothing except a longer wait for the people still sitting there. Thirty minutes is a coffee break, and the
 *  game is over. */
export const AUTO_CLOSE_MS = 15 * 60 * 1000;

/** What the countdown should read, as `m:ss`. Clamped at zero rather than going negative: a tab that was
 *  backgrounded past the deadline should say "0:00" while its dispatch lands, not "-3:12". */
export function formatCountdown(msRemaining: number): string {
  const clamped = Math.max(0, msRemaining);
  const totalSeconds = Math.ceil(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
