/** @jest-environment node */
//
// Design note #1339 (harness): the auction's money on the viewer's cash machine -- and nowhere else's.

import { auctionCashMovement } from "./auctionCashMovement";
import type { GameStateResponse } from "./gameState";
import { readStripped, sliceBetween } from "./sourceScan";

const ME = "me";
const YOU = "you";

function board(
  round: GameStateResponse["current_round_type"],
  cash: Record<string, number>,
  privates: Array<{ id: number; name: string; owner: string | null }> = [],
): GameStateResponse {
  return {
    current_round_type: round,
    player_cash: Object.entries(cash).map(([player, value]) => ({ player, cash_vgp: String(value) })),
    private_companies: privates.map((entry) => ({
      private_id: entry.id,
      name: entry.name,
      owner: entry.owner,
    })),
  } as unknown as GameStateResponse;
}

describe("auctionCashMovement", () => {
  it("3a: a purchase is a spend named after the private that changed hands", () => {
    const before = board("WaterfallAuction", { [ME]: 1200, [YOU]: 1200 }, [{ id: 1, name: "Schuylkill Valley", owner: null }]);
    const after = board("WaterfallAuction", { [ME]: 1180, [YOU]: 1200 }, [{ id: 1, name: "Schuylkill Valley", owner: ME }]);
    expect(auctionCashMovement(before, after, ME)).toEqual({
      amount: -20,
      label: "Schuylkill Valley",
      cashBefore: 1200,
      cashAfter: 1180,
    });
    // The other seat's cash did not move: nothing for their machine.
    expect(auctionCashMovement(before, after, YOU)).toBeNull();
  });

  it("3b: the all-pass income is a payout", () => {
    const before = board("WaterfallAuction", { [ME]: 1180 });
    const after = board("WaterfallAuction", { [ME]: 1185 });
    expect(auctionCashMovement(before, after, ME)).toEqual({
      amount: 5,
      label: "Private income",
      cashBefore: 1180,
      cashAfter: 1185,
    });
  });

  it("3c: says nothing outside the auction -- the Operating Round's payout keeps its modal", () => {
    const before = board("OperatingRound", { [ME]: 1180 });
    const after = board("OperatingRound", { [ME]: 1210 });
    expect(auctionCashMovement(before, after, ME)).toBeNull();
    const sr = board("StockRound", { [ME]: 1180 });
    expect(auctionCashMovement(sr, board("StockRound", { [ME]: 1113 }), ME)).toBeNull();
  });

  it("is silent with nothing moved, no viewer, or no board", () => {
    const b = board("WaterfallAuction", { [ME]: 1200 });
    expect(auctionCashMovement(b, b, ME)).toBeNull();
    expect(auctionCashMovement(b, b, null)).toBeNull();
    expect(auctionCashMovement(null, b, ME)).toBeNull();
  });

  it("is wired into the drain beside the treasury diff, on the dividend machine, with the spend cue", () => {
    const APP = readStripped("App.tsx");
    const block = sliceBetween(APP, "const moved = auctionCashMovement(before, after, viewer);", "token: moneyMachineTokenRef.current,");
    expect(block).toContain("showDividendPayout({");
    expect(block).toContain("ticker: null,");
    expect(block).toContain("label: moved.label,");
    expect(APP).toContain("onSpendCue={handleTreasuryMachineCue}");
    const MACHINE = readStripped("components/DividendMoneyMachine.tsx");
    expect(MACHINE).toContain("if (spend) timers.push(window.setTimeout(onSpendCue ?? onCue, SPEND_CUE_AT_MS));");
    expect(MACHINE).toContain('direction={spend ? "up" : "down"}');
  });
});
