// frontend/src/utils/clockProtocol.ts
//
// ==================================================================
//  PHASE 3 LANE A (AUD-11.04 / U-10, OD-18 SUPERSEDED IN PART): THE GAMEPLAY CLOCK ON THE WIRE
// ==================================================================
//
// PURE: types and the clock room ops' names -- no socket, no storage, no window. The server
// (`server/src/rooms/gameClock.ts`, `clockKeeper.ts`) owns the clock: it starts a turn's clock from the COMMITTED board,
// keeps the durable clock record, and projects this view into every `RoomView` (optional, additive: absent from an older
// server, from a table not yet dealt, and while the server is still reading the clock). The browser only PRESENTS it.
//
// WHAT THE BROWSER MAY AND MAY NOT BELIEVE.
//   - The numbers are the server's, computed at `serverNow` (the server's own clock). The browser counts on from them
//     with a MONOTONIC delta since it received the view (`performance.now`), never by comparing its wall clock with the
//     server's -- a tab whose clock is wrong still shows the right remaining time.
//   - A tab that has not caught up (the room link down, the board not current, the clock naming a seat the board on
//     screen does not) shows the clock as NOT CURRENT. It never presents a stale clock as the room's.
//   - `revision` binds a pause or resume to the clock this tab saw: the server refuses either from a tab whose view is
//     older (`clock-stale`), so a stale tab can neither reset nor advance anything.
//
// WHAT THE CLOCK IS NOT. It is not a rule of 1830 and it decides nothing in the game: no move is made, refused or
// forfeited because of it, no trade is declined, no host is replaced, and no settlement reads it (OD-18, superseded in
// part 2026-10-05: the clock is BUILT; its automatic consequences stay DEFERRED pending Phase-4 validation). A clock at
// zero says "Time expired" -- never "forfeited".
//
// NO OWNER-APPROVED DURATION EXISTS YET. `allowanceMs: null` is the shipped default for both modes: the clock then counts
// the turn's time UP and never expires. A deployment sets a duration only through the server's owner-gated configuration.

/** The table's pace, chosen at the deal (`GameVariants.mode`, design note #1256). */
export type ClockMode = "live" | "async";

/** What the clock is doing, as the server says it:
 *    running      the acting seat's turn clock is counting
 *    expired      it is counting and has reached the turn's allowance (overtime keeps counting; nothing else happens)
 *    paused       the host paused the clock (gameplay is NOT paused: the clock only stops counting)
 *    stopped      the game ended (GameEnd) or the room closed: nothing is timed any more
 *    idle         dealt, but no seat is acting (nothing to time)
 *    held         the server is holding the table (maintenance, unavailable, incompatible): the clock is not shown live
 *    unavailable  the server could not read this table's clock (it is never guessed at, and the game is unaffected) */
export type RoomClockState = "running" | "expired" | "paused" | "stopped" | "idle" | "held" | "unavailable";

export interface RoomClockView {
  mode: ClockMode;
  state: RoomClockState;
  /** The seat (player id) whose turn is being timed; `null` when no turn is. */
  seat: string | null;
  /** The turn's allowance in ms, frozen when this table's clock started; `null`: no duration set (counts up). */
  allowanceMs: number | null;
  /** Active (unpaused) time on the current turn at `serverNow`, ms. */
  elapsedMs: number;
  /** `allowanceMs - elapsedMs`, floored at 0; `null` with no allowance. */
  remainingMs: number | null;
  /** The server's clock when it computed this view (ms since the epoch). */
  serverNow: number;
  /** When the current turn began (server ms), or `null`. */
  turnStartedAt: number | null;
  /** When the current pause was asked (server ms), or `null`. */
  pausedAt: number | null;
  /** The clock record's revision: bound into a pause / resume so a stale tab is refused. */
  revision: number;
}

/** The two clock room ops (host only, active game only). */
export const CLOCK_PAUSE_OP = "clock-pause";
export const CLOCK_RESUME_OP = "clock-resume";

/** The server's answer to a pause / resume from a tab whose clock view is older than the server's. */
export const CLOCK_STALE_CODE = "clock-stale";
