// frontend/src/utils/passedSeats.test.ts
//
// Design note #610: the walk is small and entirely made of off-by-one and
// wrap-around, which is the shape of arithmetic that reads correct and is
// not. These pin the four cases that decide whether a player sees "PASSED"
// over the right name.

import { passedSeatIndices } from "./passedSeats";

/* `forEach`, not spread: this project targets ES5 without
   `downlevelIteration`, so `[...set]` does not compile. */
const seats = (set: ReadonlySet<number>): number[] => {
  const out: number[] = [];
  set.forEach((index) => out.push(index));
  return out.sort((a, b) => a - b);
};

describe("passedSeatIndices", () => {
  it("marks nobody when nobody has passed", () => {
    expect(
      seats(passedSeatIndices({ seatCount: 4, activeIndex: 2, consecutivePasses: 0 })),
    ).toEqual([]);
  });

  it("marks the seats immediately before the one on turn", () => {
    // Seat 3 is up; two passes means seats 2 and 1 passed.
    expect(
      seats(passedSeatIndices({ seatCount: 4, activeIndex: 3, consecutivePasses: 2 })),
    ).toEqual([1, 2]);
  });

  it("wraps backwards past seat zero", () => {
    /* Seat 1 is up after two passes: seat 0 passed, and before them seat 3.
       The naive `(activeIndex - step) % seatCount` yields -1 here, which is
       not a seat and would silently mark nothing. */
    expect(
      seats(passedSeatIndices({ seatCount: 4, activeIndex: 1, consecutivePasses: 2 })),
    ).toEqual([0, 3]);
  });

  it("never marks the seat that is currently on turn", () => {
    /* Design note #610a: a full rotation of passes ends the round, so a count
       at or above the seat total is a state the bar is about to stop
       rendering. Until it does, the acting seat has provably not passed --
       they have not acted at all yet. */
    for (const passes of [4, 5, 99]) {
      const marked = passedSeatIndices({ seatCount: 4, activeIndex: 2, consecutivePasses: passes });
      expect(marked.has(2)).toBe(false);
      expect(marked.size).toBe(3);
    }
  });

  it("is suppressed wholesale when the caller says the rotation is a subset", () => {
    // A mini-auction rotates over contestants only, so walking the full
    // roster would stamp seats that were never asked to act.
    expect(
      seats(
        passedSeatIndices({
          seatCount: 4,
          activeIndex: 3,
          consecutivePasses: 2,
          enabled: false,
        }),
      ),
    ).toEqual([]);
  });

  it("marks nobody when no seat is on turn", () => {
    // `-1` is what the trail is passed while a round is turning over. There
    // is no cursor to walk back from, so there is no honest answer.
    expect(
      seats(passedSeatIndices({ seatCount: 4, activeIndex: -1, consecutivePasses: 2 })),
    ).toEqual([]);
  });

  it("survives a one-seat table without lapping", () => {
    // `seatCount - 1` is zero here, so nothing is marked -- the alternative
    // is stamping the only player, who is also the one on turn.
    expect(
      seats(passedSeatIndices({ seatCount: 1, activeIndex: 0, consecutivePasses: 3 })),
    ).toEqual([]);
  });
});
