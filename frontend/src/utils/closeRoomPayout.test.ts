/** @jest-environment node */
//
// ==================================================================
//  W1-N (harness): CLOSING A ROOM PAYS NOBODY, AND THE CLOCK IS THE SERVER'S
// ==================================================================
//
// K-24 (AUD-20.09): the #899 payout stub apportioned a placeholder ante in floating point and logged it as if it
// were a dispatch. It is a no-op now -- no arithmetic, nothing read from the request. Its one caller, in RED region
// R2, was deleted under OD-12 (`shellMessageArms.test.ts` pins the absence). A-10 (AUD-18.02): the auto-close
// deadline is the server's game-end stamp (the terminal seal's `at`), so a refresh cannot restart it. The
// countdown's own format is unchanged.

import {
  AUTO_CLOSE_MS,
  autoCloseRemainingMs,
  formatCountdown,
  gameEndedAtFromLog,
  NO_CLIENT_PAYOUT_REASON,
  settleRoomPayout,
} from "./closeRoomPayout";
import type { PlayerStanding } from "../gameEngine/endgame";
import { readStripped } from "./sourceScan";

const standing = (over: Partial<PlayerStanding> = {}): PlayerStanding => ({
  address: "p1",
  label: "Ada",
  cash: 500,
  stockValue: 900,
  privateValue: 0,
  netWorth: 1400,
  rank: 1,
  isWinner: true,
  isBankrupt: false,
  ...over,
});

const request = (over: Partial<Parameters<typeof settleRoomPayout>[0]> = {}) => ({
  roomCode: "JUNO-ABC",
  standings: [standing(), standing({ address: "p2", label: "Grace", isWinner: false, rank: 2, netWorth: 700 })],
  totalAnte: 20,
  trigger: "manual" as const,
  ...over,
});

describe("K-24: the client dispatches no payout", () => {
  it("never dispatches, for any trigger, room or table", () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      for (const trigger of ["manual", "timer"] as const) {
        for (const roomCode of ["JUNO-AAA", null]) {
          expect(settleRoomPayout(request({ trigger, roomCode }))).toEqual({ dispatched: false, reason: NO_CLIENT_PAYOUT_REASON });
        }
      }
      // Repeated calls are the same answer: there is no per-session state left to guard.
      expect(settleRoomPayout(request())).toEqual(settleRoomPayout(request()));
      // The #899 console stub is gone with the arithmetic it printed.
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it("reads nothing from the request -- not the standings, not the ante", () => {
    const poisoned = new Proxy(request(), {
      get(target, key) {
        if (key === "standings" || key === "totalAnte") throw new Error(`read ${String(key)}`);
        return (target as Record<PropertyKey, unknown>)[key];
      },
    });
    expect(() => settleRoomPayout(poisoned)).not.toThrow();
  });

  it("has no payout arithmetic left in its source, and neither does the endgame display", () => {
    const payout = readStripped("utils/closeRoomPayout.ts");
    const body = payout.slice(payout.indexOf("export function settleRoomPayout"), payout.indexOf("export const AUTO_CLOSE_MS"));
    expect(body).not.toMatch(/[*/]|\bMath\./);
    expect(body).not.toContain("console.");
    expect(payout).not.toContain("expectedPayout");

    const endgame = readStripped("gameEngine/endgame.ts");
    expect(endgame).not.toContain("expectedPayout");
    expect(endgame).not.toContain("totalAnte *");
    expect(endgame).not.toMatch(/\* 100\) \/ 100/);
  });
});

describe("A-10: the deadline is the server's game-end stamp", () => {
  const entry = (index: number, msg: unknown, at?: number) => ({
    index,
    id: `e${index}`,
    actor: "p1",
    payload: JSON.stringify(msg),
    ...(at === undefined ? {} : { at }),
  });

  it("is the last non-CloseRoom entry's stamp -- the terminal seal", () => {
    const log = [entry(0, { SetupGame: {} }, 1_000), entry(1, { RunTrains: {} }, 5_000), entry(2, { CloseRoom: {} }, 9_000)];
    expect(gameEndedAtFromLog(log)).toBe(5_000);
    // Without the close marker, the same.
    expect(gameEndedAtFromLog(log.slice(0, 2))).toBe(5_000);
  });

  it("reads replay order, not array order (index, then id)", () => {
    const log = [entry(1, { RunTrains: {} }, 5_000), entry(2, { CloseRoom: {} }, 9_000), entry(0, { SetupGame: {} }, 1_000)];
    expect(gameEndedAtFromLog(log)).toBe(5_000);
  });

  it("is null for an unstamped ending or an empty log -- absent is not a value (#232)", () => {
    expect(gameEndedAtFromLog([])).toBeNull();
    expect(gameEndedAtFromLog([entry(0, { SetupGame: {} }, 1_000), entry(1, { RunTrains: {} })])).toBeNull();
    expect(gameEndedAtFromLog([entry(0, { CloseRoom: {} }, 1_000)])).toBeNull();
  });

  it("gives every refresh the same deadline: it depends on the stamp and the clock, not on when a tab mounted", () => {
    const endedAt = 1_700_000_000_000;
    const log = [entry(0, { SetupGame: {} }, endedAt - 60_000), entry(1, { RunTrains: {} }, endedAt)];
    const firstTab = autoCloseRemainingMs(gameEndedAtFromLog(log), false, endedAt + 60_000);
    // A refresh four minutes later recomputes from the same stamp: four minutes less, not a fresh fifteen.
    const refreshed = autoCloseRemainingMs(gameEndedAtFromLog(log), false, endedAt + 5 * 60_000);
    expect(firstTab).toBe(AUTO_CLOSE_MS - 60_000);
    expect(refreshed).toBe(AUTO_CLOSE_MS - 5 * 60_000);
    // Past the deadline it is zero (the timer fires at once), never negative.
    expect(autoCloseRemainingMs(endedAt, false, endedAt + AUTO_CLOSE_MS + 1)).toBe(0);
  });

  it("counts nothing once the room is closed or without a stamp", () => {
    expect(autoCloseRemainingMs(1_000, true, 2_000)).toBeNull();
    expect(autoCloseRemainingMs(null, false, 2_000)).toBeNull();
  });
});

describe("the countdown reads like a clock", () => {
  it("is fifteen minutes, the short end of the requested range", () => {
    expect(AUTO_CLOSE_MS).toBe(15 * 60 * 1000);
  });

  it("formats minutes and padded seconds", () => {
    expect(formatCountdown(AUTO_CLOSE_MS)).toBe("15:00");
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(9_000)).toBe("0:09");
  });

  it("clamps at zero rather than counting backwards", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-190_000)).toBe("0:00");
  });
});
