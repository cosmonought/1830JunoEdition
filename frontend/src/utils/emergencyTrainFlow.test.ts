/** @jest-environment node */
//
// The mandatory train purchase: the obligation, the funding cascade, and the ending. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 751 (harness): AN OBLIGATION IS NOT A METHOD
// ==================================================================
//
// REPORTED: "when a corporation gets to the Buy Trains action and can't afford it, let's have the normal Buy
// button grayed out with the explanation as usual, and a new 'Emergency Train Purchase' button that opens a
// modal instead -- it is important that this be a button because the corporation could fulfill its obligation
// by buying from another corporation instead."
//
// THE OLD BUILD ENFORCED THE RULE BY REMOVING THE ALTERNATIVES. #3 mounted the modal the instant a plan
// existed and gave it no dismissal, which is correct about the duty and wrong about how it may be
// discharged: buying a rival's train satisfies 1830 just as well as the Depot does. So the assertions below
// are about the PASS being refused, not about the modal being present -- those are different claims, and
// only the first is the rule.
//
// AND ONE CASE HAS TO GO THE OTHER WAY, which is #751a. A president who cannot raise the money by any legal
// combination has no decision to make, so the flow resolves itself rather than waiting behind a button a
// losing player has every incentive never to press.

import {
  emergencyPurchaseAvailable,
  noDecisionRemains,
  saleChoiceExists,
  trainPurchaseRefusal,
} from "./trainObligation";
import { resolveEmergencyFunding } from "./endgame";
import { describeTreasuryMoves, treasuryMoveLine } from "./treasuryProvenance";
import type { GameStateResponse } from "./gameState";

const obliged = {
  atHardwareStep: true,
  trainless: true,
  couldRunARoute: true,
  ticker: "PRR",
};

describe("the obligation lands on Pass", () => {
  it("refuses the pass, naming both ways out", () => {
    /* THE REPORT'S POINT, as the assertion: the reason has to mention buying from another corporation,
       because that escape lives on a different panel and no control here offers it. A refusal that named
       only the Depot would send a president to a button they already know is dead. */
    const refusal = trainPurchaseRefusal(obliged);
    expect(refusal).toMatch(/must acquire one/);
    expect(refusal).toMatch(/Bank Depot/);
    expect(refusal).toMatch(/another corporation/);
    expect(refusal).toMatch(/emergency purchase/);
  });

  it("says nothing outside the Hardware step", () => {
    expect(trainPurchaseRefusal({ ...obliged, atHardwareStep: false })).toBeNull();
  });

  it("says nothing to a corporation that owns a train", () => {
    expect(trainPurchaseRefusal({ ...obliged, trainless: false })).toBeNull();
  });

  it("says nothing to a corporation with nowhere to run", () => {
    /* #707's probe, and the reason it is threaded in rather than assumed: a trainless corporation with no
       reachable route is under no obligation at all, and blocking its pass would strand the round. */
    expect(trainPurchaseRefusal({ ...obliged, couldRunARoute: false })).toBeNull();
  });
});

describe("the emergency button is offered only when the treasury is short", () => {
  it("appears when the corporation cannot pay", () => {
    expect(
      emergencyPurchaseAvailable({ obliged: true, treasury: 500, cheapestTrainCost: 630 }),
    ).toBe(true);
  });

  it("stays away when the corporation can pay", () => {
    /* THE ONE THAT MATTERS FOR THE RULES. President's cash and corporate treasury are separate piles that
       1830 permits mixing in exactly this emergency -- so an emergency button beside a purchase the company
       can afford would invite a president to spend their own money where the rules forbid it. */
    expect(
      emergencyPurchaseAvailable({ obliged: true, treasury: 700, cheapestTrainCost: 630 }),
    ).toBe(false);
  });

  it("stays away when there is no obligation", () => {
    expect(
      emergencyPurchaseAvailable({ obliged: false, treasury: 0, cheapestTrainCost: 630 }),
    ).toBe(false);
  });

  it("stays away when the depot is empty", () => {
    expect(
      emergencyPurchaseAvailable({ obliged: true, treasury: 0, cheapestTrainCost: null }),
    ).toBe(false);
  });
});

describe("the funding cascade", () => {
  const holdings = [
    { companyId: 2, ticker: "B&O", proceeds: 142, sellableCertificates: 2 },
    { companyId: 3, ticker: "NYC", proceeds: 90, sellableCertificates: 1 },
  ];

  it("empties the treasury first, then reaches for cash", () => {
    /* The report's own order: "their corporation's contribution to the purchase (its full treasury, by
       definition), and then a button saying 'You must contribute $x of personal cash'". */
    const funding = resolveEmergencyFunding({
      trainCost: 630,
      treasury: 500,
      playerCash: 400,
      holdings: holdings as never,
    });
    expect(funding.fromTreasury).toBe(500);
    expect(funding.fromPlayerCash).toBe(130);
    expect(funding.mustRaiseBySelling).toBe(0);
    expect(funding.bankrupt).toBe(false);
  });

  it("reaches for shares only when cash runs out", () => {
    const funding = resolveEmergencyFunding({
      trainCost: 630,
      treasury: 500,
      playerCash: 40,
      holdings: holdings as never,
    });
    expect(funding.mustRaiseBySelling).toBe(90);
    expect(funding.bankrupt).toBe(false);
  });

  it("never draws more from the treasury than the train costs", () => {
    // A treasury larger than the train is not an emergency; capping it keeps that arithmetic honest.
    const funding = resolveEmergencyFunding({
      trainCost: 630,
      treasury: 900,
      playerCash: 0,
      holdings: [],
    });
    expect(funding.fromTreasury).toBe(630);
    expect(funding.mustRaiseBySelling).toBe(0);
  });
});

describe("when nothing remains to decide", () => {
  it("is bankruptcy, and only bankruptcy", () => {
    /* #751a pins the definition rather than paraphrasing it: "no meaningful decision" means the SELLABLE
       ceiling falls short, which is `resolveEmergencyFunding`'s own test -- and endgame.ts #1 explains why
       it is the sellable ceiling and not the portfolio ("a president can hold a fortune in unsellable paper
       and still be bankrupt"). */
    const doomed = resolveEmergencyFunding({
      trainCost: 630,
      treasury: 500,
      playerCash: 10,
      holdings: [{ companyId: 2, ticker: "B&O", proceeds: 71, sellableCertificates: 1 }] as never,
    });
    expect(doomed.bankrupt).toBe(true);
    expect(noDecisionRemains(doomed)).toBe(true);
  });

  it("is not triggered by a president who merely has to sell", () => {
    /* THE CONTROL, and the one that would make this feature dangerous if it failed: auto-resolving a
       solvable emergency would end a game somebody could still have played out of. */
    const solvable = resolveEmergencyFunding({
      trainCost: 630,
      treasury: 500,
      playerCash: 40,
      holdings: [{ companyId: 2, ticker: "B&O", proceeds: 142, sellableCertificates: 2 }] as never,
    });
    expect(solvable.bankrupt).toBe(false);
    expect(noDecisionRemains(solvable)).toBe(false);
  });

  it("leaves a real choice where one exists", () => {
    const twoWays = resolveEmergencyFunding({
      trainCost: 630,
      treasury: 500,
      playerCash: 40,
      holdings: [
        { companyId: 2, ticker: "B&O", proceeds: 142, sellableCertificates: 2 },
        { companyId: 3, ticker: "NYC", proceeds: 90, sellableCertificates: 1 },
      ] as never,
    });
    expect(saleChoiceExists(twoWays)).toBe(true);
  });

  it("calls it a choice when one position raises more than is needed", () => {
    /* Selling one certificate more than the shortfall requires costs that corporation a market row for
       nothing, and the president may still be holding those shares at the end. So "how many" is a decision
       even when "which" is not. */
    const oneBigPosition = resolveEmergencyFunding({
      trainCost: 630,
      treasury: 500,
      playerCash: 40,
      holdings: [{ companyId: 2, ticker: "B&O", proceeds: 300, sellableCertificates: 4 }] as never,
    });
    expect(saleChoiceExists(oneBigPosition)).toBe(true);
  });

  it("calls it no choice when the only position is exactly enough", () => {
    const exact = resolveEmergencyFunding({
      trainCost: 630,
      treasury: 500,
      playerCash: 40,
      holdings: [{ companyId: 2, ticker: "B&O", proceeds: 90, sellableCertificates: 1 }] as never,
    });
    expect(exact.mustRaiseBySelling).toBe(90);
    expect(saleChoiceExists(exact)).toBe(false);
  });
});

describe("treasury provenance", () => {
  /* ==================================================================
   *  DESIGN NOTE 750 (harness): THE PHANTOM $1500
   * ==================================================================
   *
   * REPORTED: "a corporation's trains rusted with $500 in its treasury ... where it miraculously suddenly had
   * $1500 to make the purchase."
   *
   * I DID NOT FIND THE WRITER, and this file does not claim to fix it. Twice this session I supplied a
   * mechanism that fit a symptom and was wrong (#746c, #748b), so the instrument ships instead of a theory.
   *
   * WHAT MAKES IT AN INSTRUMENT RATHER THAN A LABEL is that it reads the balance before and after the
   * reducer and reports the difference. An arm asked to declare what it charged would declare its own bug
   * happily; a diff cannot. A movement on a message that has no business moving a treasury prints as
   * UNEXPLAINED, which is the only line here worth reading.
   */

  const withTreasury = (amount: string): GameStateResponse =>
    ({
      public_companies: [{ company_id: 1, ticker: "PRR", treasury: amount }],
    }) as unknown as GameStateResponse;

  it("names an ordinary spend without alarm", () => {
    const moves = describeTreasuryMoves(
      { LayTile: {} },
      withTreasury("500"),
      withTreasury("420"),
    );
    expect(moves).toHaveLength(1);
    expect(moves[0].unexplained).toBe(false);
    expect(treasuryMoveLine(moves[0], "LayTile")).toBe(
      "PRR spent $80 — treasury $500 → $420.",
    );
  });

  it("flags a credit no rule accounts for", () => {
    /* THE REPORTED SHAPE, as a unit: a treasury that grows on a message with no business growing it. $1000
       is ten times a $100 par, which is the leading hypothesis and not a finding. */
    const moves = describeTreasuryMoves(
      { RunManualRoute: {} },
      withTreasury("500"),
      withTreasury("1500"),
    );
    expect(moves[0].unexplained).toBe(true);
    expect(treasuryMoveLine(moves[0], "RunManualRoute")).toMatch(
      /PRR received \$1000 — treasury \$500 → \$1500\. UNEXPLAINED/,
    );
  });

  it("stays silent when nothing moved", () => {
    // Otherwise every message would print a line per corporation and the log would be unreadable.
    expect(describeTreasuryMoves({ PassTurn: {} }, withTreasury("500"), withTreasury("500")))
      .toEqual([]);
  });

  it("does not report a corporation's opening balance as a movement", () => {
    /* A company that did not exist before has no CHANGE to report. Reading an absent balance as zero would
       print "received $1000" for every corporation the moment it appears. */
    const before = { public_companies: [] } as unknown as GameStateResponse;
    expect(describeTreasuryMoves({ BuyStock: {} }, before, withTreasury("1000"))).toEqual([]);
  });

  it("copes with no before-state at all", () => {
    expect(describeTreasuryMoves({ LayTile: {} }, null, withTreasury("500"))).toEqual([]);
  });
});

describe("the surfaces ask the rule module", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // #490a: the notes quote the old arrangement and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("gates Pass on the obligation", () => {
    expect(read("App.tsx")).toContain("trainPurchaseRefusal({");
  });

  it("no longer mounts the modal on the plan alone", () => {
    /* #3's line was `const emergencyModalPlan = emergencyPurchasePlan;`. The structural half of #751: if
       that came back, the button would still work and the alternative route would silently close again. */
    const app = read("App.tsx");
    expect(app).not.toMatch(/emergencyModalPlan = emergencyPurchasePlan;/);
    expect(app).toContain("emergencyModalOpen || emergencyForced");
  });

  it("still opens itself when nothing remains to decide", () => {
    expect(read("App.tsx")).toContain("noDecisionRemains(emergencyPurchasePlan)");
  });

  it("logs every treasury movement", () => {
    expect(read("App.tsx")).toContain("describeTreasuryMoves(msg, before, after)");
  });
});
