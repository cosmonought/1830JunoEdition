/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1221 (harness): A LATE MARK IS NOT A MISSING MARK
// ==================================================================
//
// REPORTED: "B&O parred at $100, then PRR parred at $100, then B&O floated, then PRR floated… However, in
// the playtest PRR is going first." Reported separately, and in fact the same bug: a tile that appeared and
// then vanished on every Lay Track attempt.
//
// THE LOG SETTLED IT WITHOUT A GUESS, which is what the replay CLI is for. The same 28 actions run headless
// through the reducer give `operatingOrder: [4, 1, 5]` -- B&O first, correct. The browser had PRR first. So
// the reducer was never wrong and no rule needed changing; the client's copy of the rule did.
//
// WHY IT SURVIVED A READ OF THE CODE. #1211 removed the shell's `reconcileParMarks` on the grounds that
// "`applySandboxActionInner` runs it after every action". True -- and irrelevant for `SetBoPar`, which the
// shell handles itself and returns from long before the reducer is reached. The mark was not lost, though:
// `reconcileParMarks` is comprehensive, so the NEXT action stamped it. It stamped it in the same pass as
// PRR's, and that pass walks `public_companies` in company-id order, so PRR (1) took the earlier arrival.
//
// AND ARRIVAL IS THE TIE-BREAK. Both parred at $100; price could not separate them; `buildOperatingOrder`
// fell through to arrival, and arrival had been quietly reassigned by a missing call. Every token was on the
// right cell at the right price. Only the ORDER THEY WERE WRITTEN IN carried the fault, which is invisible
// in a screenshot and in every unit test of either side.
//
// SO THIS FILE PINS THE JOIN, not the pieces. Two claims:
//   the rule -- a corporation marked first operates first when prices tie, whatever the company ids say;
//   the wiring -- the shell's `SetBoPar` branch reconciles before it returns, because nothing downstream
//   will do it for that message in time.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
const { reconcileParMarks } = require("./sandboxState") as typeof import("./sandboxState");
const { buildOperatingOrder } = require("./sandboxSession") as typeof import("./sandboxSession");
const { sandboxScenarioState } = require("./sandboxState") as typeof import("./sandboxState");

type State = import("./gameState").GameStateResponse;

describe("the rule: arrival breaks a price tie (#1221)", () => {
  /* TWO CORPORATIONS, ONE PRICE, AND THE ONE WITH THE HIGHER ID PARRED FIRST. That combination is the whole
     bug: company-id order and arrival order disagree, so a build that has lost its arrival tie-break gives
     the opposite answer rather than a coincidentally-equal one. */
  const PRICE = 100;

  function floatedPair(): State {
    const seed = sandboxScenarioState("start", 0, "default");
    return {
      ...seed,
      player_addresses: ["p-a", "p-b"],
      public_companies: seed.public_companies.map((company) =>
        company.company_id === 1 || company.company_id === 4
          ? {
              ...company,
              is_floated: true,
              president: company.company_id === 1 ? "p-a" : "p-b",
              par_value: String(PRICE),
            }
          : company,
      ),
    };
  }

  const order = (state: State, markedFirst: number, markedSecond: number) => {
    /* MARKS PLACED ONE AT A TIME, IN THE ORDER THE ARGUMENT NAMES. Handing `reconcileParMarks` both
       corporations at once is exactly the call that produced the bug -- it stamps them in company-id order,
       which is the thing this test has to be able to tell apart from a real par sequence.

       ONE CELL FOR BOTH, so the column key cannot separate them either. Price ties, column ties, and
       ARRIVAL is the only key left -- which is the tie-break the bug reassigned. */
    let positions: Record<number, { price: number; x: number; y: number; enteredAt?: number } | null> = {};
    for (const companyId of [markedFirst, markedSecond]) {
      positions = reconcileParMarks(
        positions,
        state.public_companies.filter((company) => company.company_id === companyId),
        () => ({ x: 0, y: 0 }),
      ) as typeof positions;
    }
    return buildOperatingOrder(
      { ...state, market_positions: positions },
      () => PRICE,
      (companyId: number) => positions[companyId] ?? null,
    );
  };

  it("puts the corporation marked first at the head, not the lower company id", () => {
    const queue = order(floatedPair(), 4, 1);
    expect(queue[0]).toBe(4);
  });

  it("and reverses when the marks are placed the other way round", () => {
    /* THE PAIR IS THE POINT. A single assertion could pass on a build that always answered 4, which is not
       the rule -- it is the same accident in the other direction. */
    const queue = order(floatedPair(), 1, 4);
    expect(queue[0]).toBe(1);
  });
});

describe("the wiring: the mark is the reducer's, and the shell no longer stands in its way (#1221 -> #1234)", () => {
  /* #1221 PUT A `reconcileParMarks` CALL INTO THE SHELL'S `SetBoPar` BRANCH, because that branch returned before
     the reducer ran and so the reducer's own post-action reconcile never happened on a client. #1234 removed
     the branch's state writes and its `return` entirely: the reducer now runs for `SetBoPar` on the client as
     it always did on the server, and its wrapper reconciles the mark at the right moment for free. So the
     property this block guards is the same -- B&O's mark is placed BY the SetBoPar action, not by whichever
     action happens to follow -- and the wiring that delivers it has moved one layer down.
     THE OLD ASSERTION IS INVERTED ON PURPOSE. A `reconcileParMarks` call reappearing in this branch would be a
     second writer of the chart, one layer above the one that owns it -- #1184's shape, the very thing #1234
     removed. */
  const APP = readStripped("App.tsx");
  // #1247/#1248: the negotiation and closure branches that used to follow are gone; the next branch standing
  // is the deal's narration.
  const branch = sliceBetween(APP, "if (isSetBoParMsg(msg)) {", "if (isSetupGameMsg(msg)) {");

  it("writes no state and does not reconcile from the shell branch", () => {
    expect(branch).not.toContain("reconcileParMarks(");
    expect(branch).not.toContain("grantBOPresidency(");
    expect(branch).not.toContain("sandboxStateRef.current =");
    expect(branch).not.toContain("setSandboxState(");
  });

  it("does not return, so the reducer's arm -- and its reconcile -- is reached", () => {
    expect(branch).not.toMatch(/\n\s*return;\s*\n/);
  });

  it("still closes the prompt on every client, and narrates from the general path", () => {
    // #565: the prompt closes wherever the answer lands. #1246: the sentence moved to `describeGameplayAction`
    // so the general path's entry is the one line; the branch no longer logs anything itself.
    expect(branch).toContain("setBoParPrompt(null)");
    expect(branch).not.toContain("logInfo(");
    const LOG = readStripped("utils/actionLog.ts");
    expect(LOG).toContain("receives the B&O President's Certificate and pars it at $");
  });

  it("places the mark by the SetBoPar action itself, on the reducer path", () => {
    /* THE PROPERTY, asserted where it now lives. After `SetBoPar` alone -- no following action to do the
       work late -- the reducer's output carries B&O's par mark. This is what #1221 was for. */
    const seed = sandboxScenarioState("start", 0, "default");
    const state: State = {
      ...seed,
      player_addresses: ["p-a", "p-b"],
      market_positions: {},
    };
    const { applySandboxAction } = require("./sandboxSession") as typeof import("./sandboxSession");
    const after = applySandboxAction(
      state,
      { SetBoPar: { par_value: "100", player: "p-a" } } as never,
      { actor: "p-a", parCellFor: () => ({ x: 0, y: 0 }) } as never,
    );
    const bo = after.public_companies.find((company) => company.ticker === "B&O");
    expect(bo?.president).toBe("p-a");
    expect(after.market_positions?.[bo?.company_id ?? -1] ?? null).not.toBeNull();
  });
});
