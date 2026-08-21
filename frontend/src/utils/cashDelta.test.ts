// frontend/src/utils/cashDelta.test.ts
//
// ==================================================================
//  DESIGN NOTE 670 (harness): CONFIRMING A CHANGE, NOT A NUMBER
// ==================================================================
//
// REPORTED: "when players click Pay Dividends, it is very hard to tell if the
// game is actually doing so."
//
// The payout worked. What was missing is that a balance cannot confirm a
// change: "$540" reads as a payout only to somebody who had memorised "$530".
// So the badge is the fix, and the badge is arithmetic over a SEQUENCE of
// states -- which is why the arithmetic lives in a module and the tests live
// here. Every case below is a sequence, and every one of them is a way the
// badge could tell the player something untrue.
//
// The three that cost the most thought:
//
//   A PLAYER ARRIVING IS NOT A PLAYER EARNING. Setup deals every seat its
//   starting cash. Read as a change, that opens every game with "+$600" on
//   every card -- the loudest possible way to teach a reader that the badge
//   means nothing.
//
//   A REPLAY IS NOT AN EVENT. Joining a room replays the whole game and an undo
//   rebuilds from the fixture; both move every balance on the board. The drain
//   decides which passes are ordinary play, and these tests pin the rule the
//   drain relies on: a re-baseline emits nothing.
//
//   NET ZERO IS NOT A CHANGE. Buy a share and undo it and the player is exactly
//   where they started. A "+$0" badge is an event notice for a non-event.

import {
  CASH_DELTA_TTL_MS,
  cashByPlayer,
  cashChanges,
  formatCashDelta,
  settleCashDeltas,
  type CashDelta,
} from "./cashDelta";
import type { GameStateResponse } from "./gameState";

const ADA = "juno1ada";
const BEN = "juno1ben";

/** Only the field this module reads. Cast rather than built whole: a full
 *  `GameStateResponse` fixture here would be twenty irrelevant fields whose
 *  values a reader would have to check were irrelevant. */
function stateWithCash(cash: Record<string, string>): GameStateResponse {
  return {
    player_cash: Object.entries(cash).map(([player, cash_vgp]) => ({ player, cash_vgp })),
  } as GameStateResponse;
}

describe("cashByPlayer", () => {
  it("reads the contract's fixed-point strings", () => {
    // Project rule: money is never a float. It arrives as text and is compared
    // as a number, and this is the one place that conversion happens.
    expect(cashByPlayer(stateWithCash({ [ADA]: "600", [BEN]: "540" }))).toEqual({
      [ADA]: 600,
      [BEN]: 540,
    });
  });

  it("is empty for no state, rather than throwing", () => {
    // Before the first poll, and offline. Both are ordinary.
    expect(cashByPlayer(null)).toEqual({});
  });

  it("DROPS an unparseable balance instead of reading it as zero", () => {
    /* An unknown balance and a balance of nothing are different facts. Read as
       zero, the next good poll would fire a spectacular invented payout. */
    const map = cashByPlayer(stateWithCash({ [ADA]: "600", [BEN]: "not a number" }));
    expect(map).toEqual({ [ADA]: 600 });
    expect(BEN in map).toBe(false);
  });
});

describe("cashChanges", () => {
  it("reports what moved, signed", () => {
    const changes = cashChanges({ [ADA]: 530, [BEN]: 400 }, { [ADA]: 540, [BEN]: 333 });
    expect(changes).toEqual(
      expect.arrayContaining([
        { address: ADA, amount: 10 },
        { address: BEN, amount: -67 },
      ]),
    );
    expect(changes).toHaveLength(2);
  });

  it("says nothing about a player who did not move", () => {
    expect(cashChanges({ [ADA]: 540 }, { [ADA]: 540 })).toEqual([]);
  });

  it("does NOT report a player's first appearance", () => {
    /* THE DEAL. Every seat's starting cash arrives at once, and it is not a
       payment to anybody. */
    expect(cashChanges({}, { [ADA]: 600, [BEN]: 600 })).toEqual([]);
  });

  it("still reports a player who was already seated", () => {
    // The rule above must not swallow a real payout in a game that gains a
    // seat -- only the new seat is silent.
    const changes = cashChanges({ [ADA]: 600 }, { [ADA]: 610, [BEN]: 600 });
    expect(changes).toEqual([{ address: ADA, amount: 10 }]);
  });

  it("says nothing about a player who has left", () => {
    expect(cashChanges({ [ADA]: 600, [BEN]: 600 }, { [ADA]: 600 })).toEqual([]);
  });
});

describe("settleCashDeltas", () => {
  const now = 1_000_000;

  it("raises a badge for a change", () => {
    const out = settleCashDeltas([], [{ address: ADA, amount: 10 }], now);
    expect(out).toEqual([{ address: ADA, amount: 10, at: now }]);
  });

  it("ACCUMULATES two payouts inside the window", () => {
    /* Two corporations paying one shareholder seconds apart is one reader
       looking at one badge. "+$30" is true; "+$20" -- the later of the two --
       matches nothing that happened. */
    const first = settleCashDeltas([], [{ address: ADA, amount: 10 }], now);
    const second = settleCashDeltas(first, [{ address: ADA, amount: 20 }], now + 1_000);
    expect(second).toEqual([{ address: ADA, amount: 30, at: now + 1_000 }]);
  });

  it("restarts the clock on the combined figure", () => {
    /* The window is measured from the LATEST change, so a second payout
       refreshes the badge rather than letting it expire mid-story. */
    const first = settleCashDeltas([], [{ address: ADA, amount: 10 }], now);
    const late = now + CASH_DELTA_TTL_MS - 1;
    const second = settleCashDeltas(first, [{ address: ADA, amount: 20 }], late);
    expect(second[0].at).toBe(late);
    expect(settleCashDeltas(second, [], late + CASH_DELTA_TTL_MS - 1)).toHaveLength(1);
  });

  it("drops a run that nets back to nothing", () => {
    /* Buy a share for $67, undo it. The player is where they started and there
       is no event to announce. */
    const bought = settleCashDeltas([], [{ address: ADA, amount: -67 }], now);
    const undone = settleCashDeltas(bought, [{ address: ADA, amount: 67 }], now + 500);
    expect(undone).toEqual([]);
  });

  it("expires a badge once the window has passed", () => {
    const raised = settleCashDeltas([], [{ address: ADA, amount: 10 }], now);
    expect(settleCashDeltas(raised, [], now + CASH_DELTA_TTL_MS - 1)).toHaveLength(1);
    expect(settleCashDeltas(raised, [], now + CASH_DELTA_TTL_MS)).toHaveLength(0);
  });

  it("expires each player on their own clock", () => {
    const ada = settleCashDeltas([], [{ address: ADA, amount: 10 }], now);
    const both = settleCashDeltas(ada, [{ address: BEN, amount: 10 }], now + 3_000);
    const later = settleCashDeltas(both, [], now + CASH_DELTA_TTL_MS + 1);
    expect(later.map((d) => d.address)).toEqual([BEN]);
  });

  it("holds several players at once", () => {
    // A dividend pays everybody, and every badge has to arrive.
    const out = settleCashDeltas(
      [],
      [
        { address: ADA, amount: 10 },
        { address: BEN, amount: 20 },
      ],
      now,
    );
    expect(out).toHaveLength(2);
  });

  it("does not mutate what it was handed", () => {
    // React state. The caller re-renders off identity.
    const current: CashDelta[] = [{ address: ADA, amount: 10, at: now }];
    settleCashDeltas(current, [{ address: ADA, amount: 5 }], now + 1);
    expect(current).toEqual([{ address: ADA, amount: 10, at: now }]);
  });

  it("returns the same array when nothing changed and nothing expired", () => {
    /* The expiry timer re-settles on an interval, and an array with a new
       identity every tick would re-render the strip forever. */
    const current: CashDelta[] = [{ address: ADA, amount: 10, at: now }];
    expect(settleCashDeltas(current, [], now + 1)).not.toBe(current);
    expect(settleCashDeltas(current, [], now + 1)).toEqual(current);
  });
});

describe("a re-baseline", () => {
  /* What the drain does on a replay or a rebuild: read the new cash, keep it as
     the baseline, emit NOTHING. These pin the property the drain relies on. */

  it("emits nothing when the whole board is replayed from empty", () => {
    // Joining a room: every seat appears at once, mid-game.
    const replayed = cashByPlayer(stateWithCash({ [ADA]: "812", [BEN]: "415" }));
    expect(cashChanges({}, replayed)).toEqual([]);
  });

  it("emits nothing for a rebuild that lands on the same figures", () => {
    // An undo of something that did not touch cash -- a tile lay, a token.
    const before = { [ADA]: 812, [BEN]: 415 };
    expect(cashChanges(before, { ...before })).toEqual([]);
  });
});

describe("formatCashDelta", () => {
  it("signs both directions", () => {
    expect(formatCashDelta(30)).toBe("+$30");
    expect(formatCashDelta(-67)).toBe("−$67");
  });

  it("uses a real minus sign, not a hyphen", () => {
    /* At badge size the two are a pixel apart and only one of them is a minus.
       Asserted by codepoint, because the difference is invisible in a diff. */
    expect(formatCashDelta(-67).charCodeAt(0)).toBe(0x2212);
  });

  it("rounds to whole VGP", () => {
    expect(formatCashDelta(10.4)).toBe("+$10");
  });
});
