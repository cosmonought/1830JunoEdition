/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 899 (harness): CLOSING A ROOM FOUR TIMES AT ONCE
// ==================================================================
//
// AGREED DESIGN: every connected client runs its own fifteen-minute countdown and any player may press Close
// Room, because an elected timekeeper dies with their browser tab and the room is then held hostage by exactly
// the person the timer was meant to route around. The cost of that choice is redundant dispatches, and the
// whole of this file is about them being harmless.
//
// THE STUB IS TESTED LIKE PRODUCTION CODE ON PURPOSE. Its body is a `console.info` until Phase 5, and its
// GUARDS are not provisional -- they are the part that will still be there when real JUNO moves through it.
// Testing them now is what makes the Phase 5 change a one-line body swap rather than a rewrite under pressure.

import {
  AUTO_CLOSE_MS,
  formatCountdown,
  resetSettledRooms,
  settleRoomPayout,
} from "./closeRoomPayout";
import type { PlayerStanding } from "./endgame";

const standing = (over: Partial<PlayerStanding> = {}): PlayerStanding =>
  ({
    address: "p1",
    label: "Ada",
    cash: 500,
    stockValue: 900,
    privateValue: 0,
    netWorth: 1400,
    rank: 1,
    isWinner: true,
    isBankrupt: false,
    expectedPayout: 12.5,
    ...over,
  }) as PlayerStanding;

const request = (over: Partial<Parameters<typeof settleRoomPayout>[0]> = {}) => ({
  roomCode: "JUNO-Y8V",
  standings: [standing(), standing({ address: "p2", label: "Grace", isWinner: false, expectedPayout: 7.5 })],
  totalAnte: 20,
  trigger: "manual" as const,
  ...over,
});

/* Silenced because the stub's whole body is a `console.info`, and a passing suite that prints six settlement
   dumps trains whoever runs it to scroll past output. Restored after, so a later file's real warning is not
   swallowed by this one's setup. */
let quiet: jest.SpyInstance;
beforeEach(() => {
  resetSettledRooms();
  quiet = jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => quiet.mockRestore());

describe("the first close wins and the rest are harmless (design note #899)", () => {
  it("dispatches once", () => {
    expect(settleRoomPayout(request())).toEqual({ dispatched: true });
  });

  it("refuses the second, third and fourth client's timer", () => {
    /* THE POINT OF THE WHOLE DESIGN. Four players means four countdowns firing within a second of each other,
       and every one of them calls this. Only the first may move money.
       ASSERTED AS A LOOP rather than as one repeat, because "the second is refused" would also pass on an
       implementation that alternated. */
    expect(settleRoomPayout(request()).dispatched).toBe(true);
    for (const trigger of ["timer", "timer", "manual"] as const) {
      expect(settleRoomPayout(request({ trigger })).dispatched).toBe(false);
    }
  });

  it("says why, in a sentence a player could be shown", () => {
    settleRoomPayout(request());
    const second = settleRoomPayout(request());
    expect(second.dispatched).toBe(false);
    expect(second.dispatched === false && second.reason).toMatch(/already been dispatched/i);
  });

  it("keeps two rooms independent", () => {
    /* THE GUARD IS PER ROOM, not a global "have I ever settled anything". One table finishing must not stop
       the next one from paying out -- and a browser tab can outlive several games. */
    expect(settleRoomPayout(request({ roomCode: "JUNO-AAA" })).dispatched).toBe(true);
    expect(settleRoomPayout(request({ roomCode: "JUNO-BBB" })).dispatched).toBe(true);
    expect(settleRoomPayout(request({ roomCode: "JUNO-AAA" })).dispatched).toBe(false);
  });

  it("refuses a table with nothing to distribute", () => {
    /* A transfer of nothing is still a transaction somebody pays gas for. Refused rather than dispatched
       empty -- and refused BEFORE the room is marked settled would be a bug, so the next case checks that. */
    const nothing = settleRoomPayout(
      request({ standings: [standing({ expectedPayout: 0 })], totalAnte: 0 }),
    );
    expect(nothing.dispatched).toBe(false);
    expect(nothing.dispatched === false && nothing.reason).toMatch(/nothing to distribute/i);
  });

  it("does not burn the room on a refusal", () => {
    /* THE ORDER MATTERS AND THIS IS WHERE IT SHOWS. If the "nothing to distribute" refusal marked the room
       settled on its way out, a room whose standings were momentarily empty could never pay out afterwards.
       The guard only fires on a real dispatch. */
    settleRoomPayout(request({ standings: [standing({ expectedPayout: 0 })] }));
    expect(settleRoomPayout(request()).dispatched).toBe(true);
  });
});

describe("the countdown reads like a clock", () => {
  it("is fifteen minutes, the short end of the requested range", () => {
    /* Pinned as a NUMBER rather than trusted: the range asked for was 15-to-30, and the reasoning for the
       short end is that every player can already close the room themselves, so a longer timer only makes the
       people still sitting there wait longer. */
    expect(AUTO_CLOSE_MS).toBe(15 * 60 * 1000);
  });

  it("formats minutes and padded seconds", () => {
    expect(formatCountdown(AUTO_CLOSE_MS)).toBe("15:00");
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(9_000)).toBe("0:09");
  });

  it("clamps at zero rather than counting backwards", () => {
    /* A BACKGROUNDED TAB IS THE NORMAL CASE HERE, not an edge one: a finished game is exactly the moment
       somebody switches away. It should read "0:00" while its dispatch lands, never "-3:12". */
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-190_000)).toBe("0:00");
  });
});
