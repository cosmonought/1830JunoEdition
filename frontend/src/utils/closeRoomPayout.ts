// frontend/src/utils/closeRoomPayout.ts
//
// A finished room's closure: the auto-close countdown, its server-clock deadline, and the retired payout hook.
//
/* ==================================================================
 *  W1-N / K-24 (AUD-20.09): THE CLIENT DISPATCHES NO PAYOUT -- A NO-OP, NOT A STUB
 * ==================================================================
 *
 * DESIGN NOTE 899 made this a `console.info` stub for "the payout dispatch", to be filled with an `ExecuteMsg` in
 * Phase 5, and fed it `expectedPayout`: a floating-point split of a placeholder 100-JUNO ante by share of net worth.
 * That is not how money moves, and it never will be. A real-money table's JUNO is held by the escrow and settled
 * from the server's certified settlement of the terminal board (whole-VGP weights, integer arithmetic, the
 * certified rules version), on the escrow's own schedule; a no-money table has nothing to settle. No browser
 * apportions, rounds or dispatches a payout, so there is nothing here to fill in later.
 *
 * SO THIS IS A NO-OP AND DOES NO ARITHMETIC. It reads nothing from the request -- no standings, no ante -- and
 * always answers `dispatched: false`. #899's three double-fire hazards (every client's timer, the button racing a
 * timer, a replay) are moot for a function that does nothing; the reducer's `room_closed` latch still makes every
 * `CloseRoom` after the first a no-op, and the escrow's own idempotency is the chain's business.
 *
 * IT HAS NO CALLER. Its one caller sat inside `runGameplayAction`'s apply half (App.tsx, RED region R2) and was
 * deleted under owner decision OD-12 (Phase 3 Wave-1 integration, its own commit). The function, its request shape
 * and `PLACEHOLDER_TOTAL_ANTE` stay only until a later cleanup removes them together; nothing in the app reads them. */

import type { PlayerStanding } from "../gameEngine/endgame";

/** The shape the retired (RED R2) caller passed. Nothing in it is read. */
export interface RoomPayoutRequest {
  roomCode: string | null;
  standings: readonly PlayerStanding[];
  /** Retired with the placeholder payout (K-24). Ignored. */
  totalAnte: number;
  trigger: "manual" | "timer";
}

export type RoomPayoutResult =
  | { dispatched: true }
  | { dispatched: false; reason: string };

/** Why nothing was dispatched -- the only answer this function gives. */
export const NO_CLIENT_PAYOUT_REASON =
  "No payout is dispatched from the client: a real-money table settles through its escrow, and a table played for fun has nothing to settle.";

/** K-24: a no-op. Closing a room pays nobody from the client; see the header. */
export function settleRoomPayout(_request: RoomPayoutRequest): RoomPayoutResult {
  return { dispatched: false, reason: NO_CLIENT_PAYOUT_REASON };
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

/* ==================================================================
    W1-N / A-10 (AUD-18.02): THE DEADLINE IS THE SERVER'S GAME-END MOMENT, NOT THIS TAB'S
   ==================================================================
   The countdown latched `Date.now()` in the first tab that SAW the ending, so a refresh -- or a player who opened
   the table late -- started a fresh fifteen minutes. The moment the game ended is a fact the log already holds:
   the server stamps every entry (`at`, #643), and after GameEnd the engine admits nothing but the `CloseRoom`
   marker. So the game-end moment is the stamp of the last entry that is not a `CloseRoom` -- exactly the
   server's terminal seal (`server/src/rooms/lifecycle.ts` `sealOf`, whose `at` the record caches as
   `completed_at`), read from the same log every client holds. Every client and every refresh derives one
   deadline.

   ABSENT IS NOT A VALUE (#232). An ending entry with no stamp yields `null`, and the shell then shows no
   countdown rather than inventing one from this tab's clock; any player may still close the room. */

/** The minimal log-entry shape this reads: `SandboxAction` / `ServerLogEntry` both satisfy it. */
export interface StampedLogEntry {
  index: number;
  id: string;
  payload: string;
  at?: number;
}

function isCloseRoomEntry(entry: StampedLogEntry): boolean {
  try {
    const parsed = JSON.parse(entry.payload) as unknown;
    return typeof parsed === "object" && parsed !== null && "CloseRoom" in parsed;
  } catch {
    return false;
  }
}

/** When gameplay ended, by the server's stamp: the last non-`CloseRoom` entry's `at` in replay order (index, then
 *  id -- #1026). `null` for an empty log or an unstamped ending entry. Call it only once the board has ended. */
export function gameEndedAtFromLog(entries: readonly StampedLogEntry[]): number | null {
  const ordered = [...entries].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  for (let at = ordered.length - 1; at >= 0; at -= 1) {
    const entry = ordered[at];
    if (isCloseRoomEntry(entry)) continue;
    return typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : null;
  }
  return null;
}

/** Milliseconds until the room auto-closes, from the server's game-end stamp. `null` when there is no stamp or
 *  the room is already closed; clamped at zero. */
export function autoCloseRemainingMs(gameEndedAt: number | null, roomClosed: boolean, now: number): number | null {
  if (gameEndedAt === null || roomClosed) return null;
  return Math.max(0, gameEndedAt + AUTO_CLOSE_MS - now);
}
