// server/src/rooms/clockTestSupport.ts
//
// PHASE 3 LANE A (AUD-11.04), TESTS ONLY: controlled time for the gameplay clock -- a clock that moves only when a test
// moves it, and timers that fire only when it passes them.

import type { ClockTimers } from "./clockKeeper";

export interface FakeTime {
  readonly timers: ClockTimers;
  now(): number;
  pendingCount(): number;
  /** Move the clock forward, firing every timer it passes, in order (each given a turn of the event loop). */
  advance(ms: number): Promise<void>;
}

export function fakeTime(start: number): FakeTime {
  let now = start;
  let seq = 0;
  const pending = new Map<number, { at: number; fire: () => void }>();
  const timers: ClockTimers = {
    set(fire, ms) {
      seq += 1;
      pending.set(seq, { at: now + ms, fire });
      return seq;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    now: () => now,
    pendingCount: () => pending.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fire();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
