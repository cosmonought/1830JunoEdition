// server/src/rooms/clock/clockTestSupport.ts
//
// PHASE 3 FINAL CLOCKS, TESTS ONLY: controlled time for the table clock -- a clock that moves only when a test moves
// it, and timers that fire only when it passes them (each in its own turn of the event loop, in time order).

import type { ClockTimers } from "./clockController";

export interface FakeTime {
  readonly timers: ClockTimers;
  now(): number;
  pendingCount(): number;
  /** Move the clock forward, firing every timer it passes, in order (each given turns of the event loop to settle). */
  advance(ms: number): Promise<void>;
  /** Move the clock WITHOUT firing anything (a process that was not running: an outage). */
  jump(ms: number): void;
  /** Awaited after every fired timer, before the clock moves on (the server's clock tasks drain at the moment they
   *  fired, as they would in real time). Set by a test once its server exists. */
  drain: (() => Promise<void>) | null;
}

const settle = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

export function fakeTime(start: number): FakeTime {
  let now = start;
  let seq = 0;
  const pending = new Map<number, { at: number; fire: () => void }>();
  const timers: ClockTimers = {
    set(fire, ms) {
      seq += 1;
      pending.set(seq, { at: now + Math.max(0, ms), fire });
      return seq;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  const time: FakeTime = {
    drain: null,
    timers,
    now: () => now,
    pendingCount: () => pending.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fire();
        await settle();
        if (time.drain !== null) await time.drain();
      }
      now = target;
      await settle();
      if (time.drain !== null) await time.drain();
    },
    jump(ms: number) {
      now += ms;
      pending.clear();
    },
  };
  return time;
}
