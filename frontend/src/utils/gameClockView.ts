// frontend/src/utils/gameClockView.ts
//
// ==================================================================
//  PHASE 3 LANE A (AUD-11.04 / U-10): WHAT THE ROOM STRIP SAYS ABOUT THE GAMEPLAY CLOCK
// ==================================================================
//
// PURE: the server's clock view (`clockProtocol.ts`) in, one presentation out. No socket, no storage, no wall clock --
// the caller supplies how long ago (monotonic) it received the view, and whether this tab is CURRENT.
//
// THE SERVER IS THE CLOCK. The numbers are the server's at `serverNow`; a running clock counts on here by the monotonic
// time since the view arrived, never by this device's date. A tab that is not current -- its room link down, its board
// behind or diverged, a catch-up in progress, or a clock that names a different seat than the board on screen -- says so
// and shows NO countdown: a stale tab must not present a clock as the room's (W3-J's stale-board rule, applied here).
//
// EXPIRY IS NOT A FORFEIT. A clock that ran out reads "Time expired"; play continues and nothing happens automatically
// (OD-18, superseded in part: the clock is built, its consequences are deferred pending Phase-4 validation).

import type { RoomClockState, RoomClockView } from "./clockProtocol";

export type ClockTone = "normal" | "warning" | "expired" | "muted";

export interface ClockPresentation {
  readonly visible: boolean;
  /** The server's state, or `not-current` when this tab may not present it. */
  readonly state: RoomClockState | "not-current";
  readonly modeLabel: string;
  /** Whose turn is being timed ("Your turn", "Bob's turn"), or what the clock is doing. */
  readonly label: string;
  /** The figure ("1:23 left", "4:12 on this turn", "Time expired"), or `null` when none may be shown. */
  readonly value: string | null;
  /** One more line for the tooltip / screen reader, or `null`. */
  readonly detail: string | null;
  readonly tone: ClockTone;
  /** Whether this tab may pause (or resume) now: the host, a current tab, a clock that is timing a turn. */
  readonly canPause: boolean;
  readonly canResume: boolean;
  /** Whether the figure changes second by second (the caller re-renders while true). */
  readonly ticking: boolean;
}

export const CLOCK_EXPIRED_LABEL = "Time expired";
export const CLOCK_EXPIRED_DETAIL = "This turn's time has run out. Play continues; nothing happens automatically.";
export const CLOCK_NOT_CURRENT_DETAIL = "This tab is catching up with the room, so its clock is not shown as current.";
export const CLOCK_PAUSED_DETAIL = "The host paused the clock. The game itself is not paused.";
export const CLOCK_NO_LIMIT_DETAIL = "No turn time limit is set for this table; the clock shows how long the turn has run.";
export const CLOCK_HELD_DETAIL = "The table is held by the server; its clock is not shown as live.";
export const CLOCK_UNAVAILABLE_DETAIL = "The server could not read this table's clock. The game is unaffected.";

const HIDDEN: ClockPresentation = Object.freeze({
  visible: false,
  state: "idle",
  modeLabel: "",
  label: "",
  value: null,
  detail: null,
  tone: "muted",
  canPause: false,
  canResume: false,
  ticking: false,
});

/** A duration for the strip: `m:ss` under an hour, `Hh MMm` under a day, `Dd Hh` beyond. Whole seconds, rounded down. */
export function formatClockDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface ClockPresentationInput {
  readonly clock: RoomClockView | null | undefined;
  /** Monotonic ms since this view arrived (0 at receipt). */
  readonly sinceReceiptMs: number;
  /** This tab may present the room's clock: its room link is open, its board is current, it is not catching up. */
  readonly current: boolean;
  /** The acting seat on the board this tab has APPLIED (`null`: none, or no board). */
  readonly boardSeat: string | null;
  readonly viewerPlayerId: string | null;
  readonly isHost: boolean;
  readonly nameOf: (playerId: string) => string;
}

export function presentClock(input: ClockPresentationInput): ClockPresentation {
  const clock = input.clock;
  if (clock === null || clock === undefined) return HIDDEN;
  const modeLabel = clock.mode === "async" ? "Async" : "Live";
  const base = { visible: true, modeLabel, canPause: false, canResume: false, ticking: false } as const;
  switch (clock.state) {
    case "unavailable":
      return { ...base, state: "unavailable", label: "Clock unavailable", value: null, detail: CLOCK_UNAVAILABLE_DETAIL, tone: "muted" };
    case "held":
      return { ...base, state: "held", label: "Clock held", value: null, detail: CLOCK_HELD_DETAIL, tone: "muted" };
    case "stopped":
      return { ...base, state: "stopped", label: "Clock stopped", value: null, detail: "The game is over; nothing is timed.", tone: "muted" };
    case "idle":
      return { ...base, state: "idle", label: "No turn timed", value: null, detail: null, tone: "muted" };
    default:
      break;
  }
  const seat = clock.seat;
  const label = seat === null ? "Turn" : seat === input.viewerPlayerId ? "Your turn" : `${input.nameOf(seat)}'s turn`;
  /* NOT CURRENT: no figure at all -- a stale tab never shows a countdown as the room's. */
  const disagrees = seat !== null && input.boardSeat !== null && input.boardSeat !== seat;
  if (!input.current || disagrees) {
    return { ...base, state: "not-current", label: "Clock catching up", value: null, detail: CLOCK_NOT_CURRENT_DETAIL, tone: "muted" };
  }
  const counting = clock.state === "running" || clock.state === "expired";
  const elapsed = Math.max(0, clock.elapsedMs + (counting ? Math.max(0, input.sinceReceiptMs) : 0));
  const allowance = clock.allowanceMs;
  const remaining = allowance === null ? null : Math.max(0, allowance - elapsed);
  const expired = remaining !== null && remaining <= 0;
  let value: string;
  let detail: string | null;
  let tone: ClockTone;
  if (remaining === null) {
    value = `${formatClockDuration(elapsed)} on this turn`;
    detail = CLOCK_NO_LIMIT_DETAIL;
    tone = "normal";
  } else if (expired) {
    value = CLOCK_EXPIRED_LABEL;
    detail = `${CLOCK_EXPIRED_DETAIL} Overtime ${formatClockDuration(elapsed - (allowance as number))}.`;
    tone = "expired";
  } else {
    value = `${formatClockDuration(remaining)} left`;
    detail = null;
    tone = remaining <= Math.max(30_000, Math.floor((allowance as number) / 5)) ? "warning" : "normal";
  }
  if (clock.state === "paused") {
    return {
      ...base,
      state: "paused",
      label,
      value: `${value} · paused`,
      detail: expired ? `${CLOCK_PAUSED_DETAIL} ${CLOCK_EXPIRED_DETAIL}` : CLOCK_PAUSED_DETAIL,
      tone: "muted",
      canResume: input.isHost,
    };
  }
  return { ...base, state: expired ? "expired" : "running", label, value, detail, tone, canPause: input.isHost, ticking: true };
}
