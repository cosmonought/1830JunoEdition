// frontend/src/utils/gameClockView.test.ts
//
// PHASE 3 LANE A (AUD-11.04): what the room strip says about the gameplay clock -- the server's view in, one
// presentation out. The server is the clock; this tab counts on only by the monotonic time since the view arrived, says
// nothing as current when it is not, and never makes expiry look like a forfeit.

import type { RoomClockView } from "./clockProtocol";
import { CLOCK_EXPIRED_LABEL, formatClockDuration, presentClock, type ClockPresentationInput } from "./gameClockView";

const MIN = 60_000;

const clockOf = (over: Partial<RoomClockView> = {}): RoomClockView => ({
  mode: "live",
  state: "running",
  seat: "p-bob",
  allowanceMs: 2 * MIN,
  elapsedMs: 30_000,
  remainingMs: 90_000,
  serverNow: 1_800_000_000_000,
  turnStartedAt: 1_800_000_000_000 - 30_000,
  pausedAt: null,
  revision: 4,
  ...over,
});

const input = (over: Partial<ClockPresentationInput> = {}): ClockPresentationInput => ({
  clock: clockOf(),
  sinceReceiptMs: 0,
  current: true,
  boardSeat: "p-bob",
  viewerPlayerId: "p-alice",
  isHost: true,
  nameOf: (id) => (id === "p-bob" ? "Bob" : "Alice"),
  ...over,
});

describe("Phase 3 lane A: the clock's presentation", () => {
  test("durations: m:ss, then hours, then days -- whole seconds", () => {
    expect(formatClockDuration(0)).toBe("0:00");
    expect(formatClockDuration(59_999)).toBe("0:59");
    expect(formatClockDuration(90_000)).toBe("1:30");
    expect(formatClockDuration(3_600_000 + 5 * MIN)).toBe("1h 05m");
    expect(formatClockDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
    expect(formatClockDuration(-5)).toBe("0:00");
  });

  test("a running clock: whose turn, the server's figure counted on by the time since it arrived, the mode", () => {
    const shown = presentClock(input({ sinceReceiptMs: 10_000 }));
    expect([shown.visible, shown.state, shown.modeLabel, shown.label, shown.value, shown.tone]).toEqual([true, "running", "Live", "Bob's turn", "1:20 left", "normal"]);
    expect(presentClock(input({ viewerPlayerId: "p-bob" })).label).toBe("Your turn");
    expect(shown.ticking).toBe(true);
    expect(shown.canPause).toBe(true);
    expect(presentClock(input({ isHost: false })).canPause).toBe(false);
  });

  test("no duration set (the shipped default): the turn's time counts up and nothing ever expires", () => {
    const shown = presentClock(input({ clock: clockOf({ allowanceMs: null, remainingMs: null, mode: "async" }), sinceReceiptMs: 5 * MIN }));
    expect([shown.state, shown.modeLabel, shown.value, shown.tone]).toEqual(["running", "Async", "5:30 on this turn", "normal"]);
  });

  test("near the end it warns; at zero it says Time expired -- never forfeited -- and play continues", () => {
    expect(presentClock(input({ sinceReceiptMs: 70_000 })).tone).toBe("warning");
    const expired = presentClock(input({ sinceReceiptMs: 100_000 }));
    expect([expired.state, expired.value, expired.tone]).toEqual(["expired", CLOCK_EXPIRED_LABEL, "expired"]);
    expect(expired.detail).toMatch(/Play continues; nothing happens automatically/);
    expect(expired.detail).toMatch(/Overtime 0:10/);
    expect(JSON.stringify(expired)).not.toMatch(/forfeit/i);
    expect(expired.label).toBe("Bob's turn");
  });

  test("paused: the figure is frozen however long it has been, and the host may resume", () => {
    const shown = presentClock(input({ clock: clockOf({ state: "paused", pausedAt: 1 }), sinceReceiptMs: 60 * MIN }));
    expect([shown.state, shown.value, shown.canPause, shown.canResume, shown.ticking]).toEqual(["paused", "1:30 left · paused", false, true, false]);
    expect(shown.detail).toMatch(/The game itself is not paused/);
  });

  test("a tab that is not current shows NO figure: link down, board behind, or a clock naming another seat", () => {
    for (const over of [{ current: false }, { boardSeat: "p-alice" }]) {
      const shown = presentClock(input(over));
      expect([shown.state, shown.value, shown.canPause, shown.canResume, shown.ticking]).toEqual(["not-current", null, false, false, false]);
    }
  });

  test("held, stopped, idle and unavailable say what they are, with no figure", () => {
    for (const state of ["held", "stopped", "idle", "unavailable"] as const) {
      const shown = presentClock(input({ clock: clockOf({ state }) }));
      expect([shown.visible, shown.state, shown.value, shown.canPause, shown.canResume]).toEqual([true, state, null, false, false]);
    }
    expect(presentClock(input({ clock: undefined })).visible).toBe(false);
  });
});
