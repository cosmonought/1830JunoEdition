/** @jest-environment node */
//
// The closure, and every surface that was reading a flag nobody set. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 736 (harness): TEN READERS AND NO WRITER
// ==================================================================
//
// REPORTED: "a 5-train has been purchased, but on the Player Cards in SR and in the Game Ledger > Player
// Assets, the private companies are still displayed (and counting toward certificates) ... moreover, the
// private companies are still paying out to players. We need to enforce the closure in code, not just design
// diary notes."
//
// THE PUREST INSTANCE OF THIS PROJECT'S RECURRING BUG. `closed` was consulted correctly in ten places -- the
// payout skipped it, the trade panel hid it, the power panel greyed it, the hex badge cleared for it -- and
// no line anywhere ever set it to `true`. Every consumer right, the producer missing. So the ordinary way to
// test this, "does a closed private pay out", was ALREADY GREEN before the fix and proved nothing.
//
// WHICH IS WHY EVERY CASE BELOW STARTS FROM THE PURCHASE. The fixtures do not set `closed`; they buy a
// 5-train and then ask what became true. A test that hand-sets the flag is testing the readers, and the
// readers were never broken.
//
// AND (b) IS THE CAUTIONARY HALF. The report notes the Buy Private step was correctly skipped -- but that step
// asks whether any private is still UNSOLD in the auction, which is a different question that happened to
// give the right answer. Half-correct by coincidence is harder to doubt than plainly broken.

import { applyPhaseChange, applyPrivateRevenue, describePrivateClosures } from "./sandboxSession";
import {
  certificateBreakdown,
  certificateCount,
  corporationPrivateCompanies,
  playerPrivateCompanies,
  type GameStateResponse,
} from "./gameState";
import { closesPrivateCompanies, DEPOT_SCHEDULE } from "./depotSchedule";

const ME = "me";
const CO = 1;

function board(): GameStateResponse {
  return {
    player_addresses: [ME],
    player_cash: [{ player: ME, cash_vgp: "500" }],
    private_companies: [
      {
        private_id: 1,
        name: "Schuylkill Valley",
        cost: "20",
        revenue_per_or: "5",
        owner: ME,
        owner_protocol_id: null,
        closed: false,
      },
      {
        private_id: 3,
        name: "Delaware & Hudson",
        cost: "70",
        revenue_per_or: "15",
        owner: null,
        owner_protocol_id: CO,
        closed: false,
      },
    ],
    public_companies: [
      {
        company_id: CO,
        ticker: "PRR",
        president: ME,
        treasury: "1000",
        owned_trains: ["5"],
        player_holdings: [{ player: ME, percentage: 20 }],
        ipo_pool_percentage: 0,
        bank_pool_percentage: 0,
        station_token_hexes: [],
      },
    ],
  } as unknown as GameStateResponse;
}

/** The board after the phase that closes privates has arrived. */
const afterFive = () => applyPhaseChange(board(), "5");

describe("the 5-train actually closes them", () => {
  it("marks every private closed", () => {
    /* THE WRITE THAT NEVER EXISTED. Nothing in the app set this flag, which is why ten correct readers added
       up to no enforcement at all. */
    expect(afterFive().private_companies.every((priv) => priv.closed)).toBe(true);
  });

  it("closes a corporate-owned private as well as a player's", () => {
    // Both ownership shapes, because "closes ALL private companies" admits no exception.
    const after = afterFive();
    expect(after.private_companies.find((p) => p.private_id === 1)?.closed).toBe(true);
    expect(after.private_companies.find((p) => p.private_id === 3)?.closed).toBe(true);
  });

  it("leaves them open on every OTHER tier", () => {
    /* THE CONTROL, and it has to sweep: a fix that closed privates on any phase change would end the auction
       economy at the first 3-train and pass a test that only looked at the 5. */
    for (const tier of ["2", "3", "4", "6", "D"]) {
      const after = applyPhaseChange(board(), tier);
      expect(after.private_companies.some((priv) => priv.closed)).toBe(false);
    }
  });

  it("is idempotent, because Undo replays the whole log", () => {
    /* A rebuild must produce the same state as the play. Closing an already-closed private has to be a no-op
       rather than an error or a duplicate log line. */
    const once = afterFive();
    const twice = applyPhaseChange(once, "5");
    expect(twice.private_companies).toEqual(once.private_companies);
  });
});

describe("the consequences the report listed", () => {
  it("stops the revenue", () => {
    /* (a). `applyPrivateRevenue` already skipped closed privates -- correctly, and uselessly, since nothing
       was ever closed. Asserted from the PURCHASE so it discriminates. */
    const before = applyPrivateRevenue(board());
    expect(before?.payouts.length).toBeGreaterThan(0);
    expect(applyPrivateRevenue(afterFive())?.payouts ?? []).toHaveLength(0);
  });

  it("takes them off the certificate limit", () => {
    /* The half the report saw on the Player Card. `certificateBreakdown` counted every private the player
       owned with no closed test at all, so the card kept charging them for a company that no longer exists. */
    const open = certificateBreakdown(ME, board(), null, undefined);
    const shut = certificateBreakdown(ME, afterFive(), null, undefined);
    expect(shut.counted).toBe(open.counted - 1);
    expect(certificateCount(ME, afterFive())).toBe(certificateCount(ME, board()) - 1);
  });

  it("takes them off the Player Card and the Ledger", () => {
    /* `playerPrivateCompanies` did not filter closed, while its corporate twin always had. The asymmetry was
       invisible until the flag became real. */
    expect(playerPrivateCompanies(ME, board())).toHaveLength(1);
    expect(playerPrivateCompanies(ME, afterFive())).toHaveLength(0);
  });

  it("takes them off the Operating Round strip", () => {
    // This one was already right; asserted so the pair cannot drift apart again.
    expect(corporationPrivateCompanies(CO, board())).toHaveLength(1);
    expect(corporationPrivateCompanies(CO, afterFive())).toHaveLength(0);
  });
});

describe("the closure is said out loud", () => {
  it("names what closed", () => {
    /* Income stopping, a certificate leaving the limit and a board power vanishing are three consequences a
       player will notice at different moments and misattribute. One line at the moment of the phase change is
       what connects them. */
    const names = describePrivateClosures(board(), afterFive());
    expect(names).toContain("Schuylkill Valley");
    expect(names).toContain("Delaware & Hudson");
  });

  it("says nothing when nothing closed", () => {
    expect(describePrivateClosures(board(), applyPhaseChange(board(), "3"))).toEqual([]);
  });

  it("says nothing on a replay of an already-closed board", () => {
    // Otherwise every Undo rebuild would re-announce a closure that happened turns ago.
    const once = afterFive();
    expect(describePrivateClosures(once, applyPhaseChange(once, "5"))).toEqual([]);
  });
});

describe("the flag and the caption state one rule", () => {
  it("agrees with the schedule's prose", () => {
    /* #735 put the sentence and #736 put the flag in the same entry, deliberately -- two representations of
       one fact, adjacent, so this test can hold them together. Matching the SENTENCE in the reducer would have
       made the rule depend on its own wording. */
    expect(closesPrivateCompanies("5")).toBe(true);
    expect(DEPOT_SCHEDULE["5"].onFirstPurchase).toContain("Closes all Private Companies");
  });

  it("names exactly one closing tier", () => {
    const closers = Object.keys(DEPOT_SCHEDULE).filter((tier) => closesPrivateCompanies(tier));
    expect(closers).toEqual(["5"]);
  });

  it("says no for a tier it does not know", () => {
    expect(closesPrivateCompanies("99")).toBe(false);
  });
});
