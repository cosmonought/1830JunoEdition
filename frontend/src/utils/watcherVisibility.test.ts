/** @jest-environment node */
//
// What a player who is not acting can see and be told. No DOM.
//
// ==================================================================
//  DESIGN NOTES 786 / 787 (harness): THE OTHER FOUR PLAYERS
// ==================================================================
//
// TWO REPORTS, ONE AUDIENCE:
//   786) "I also don't receive any toast notifications when another player's corporation pays dividends to
//        me."
//   787) "During other players' run routes action, I can see the highlighted routes on the rail map, but on
//        the sticky Action bar I don't see the trains listed with their individual revenues."
//
// BOTH ARE THE SAME OMISSION SEEN TWICE: every surface in the Operating Round was built for the person
// acting, and the four people watching inherited whatever fell out. #697 scoped the toast to "did my button
// register", which is the right question and only the actor's; `showRouteToggle` gated the route readout on
// `mayActThisTurn`, because the panel began life as a control.
//
// A HALF-VISIBLE EVENT IS THE WORST OF THE THREE STATES. The map already draws a rival's routes, so a watcher
// saw WHERE the train ran and not what it earned; the bank already moved their money, and nothing said so.
// Hidden would at least be consistent.
//
// AND THE NARROWNESS IS THE POINT, because #718 has already had to fix "toast notifications for literally
// every action". The payout notice does not ask whether an event was interesting -- it asks whether it moved
// THIS viewer's money, off `dividendSplit`'s own list, which is the same value the reducer spent.

import { dividendSplit } from "./dividendSplit";
import type { GameStateResponse } from "./gameState";

const CO = 3;

function board(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    player_addresses: ["p1", "p2", "p3"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
      { player: "p3", cash_vgp: "500" },
    ],
    virtual_bank_vgp: "12000",
    private_companies: [],
    current_round_type: "OperatingRound",
    operating_sub_phase: "Dividends",
    macro_round_number: 2,
    active_player_index: 0,
    active_operating_order: [CO],
    active_corporation_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: CO,
        ticker: "C&O",
        is_floated: true,
        president: "p1",
        par_value: "82",
        home_hex_label: "F16",
        ipo_pool_percentage: 10,
        bank_pool_percentage: 0,
        treasury: "300",
        last_route_revenue: "0",
        player_holdings: [
          { player: "p1", percentage: 60 },
          { player: "p2", percentage: 30 },
        ],
        station_token_hexes: [[0, 0]],
        owned_trains: ["2"],
      },
    ],
    ...over,
  } as unknown as GameStateResponse;
}

/** The predicate the drain applies: did this settlement move THIS viewer's money? */
const owedTo = (viewer: string) =>
  dividendSplit(board(), CO, "100", true)?.players.find((share) => share.player === viewer) ?? null;

describe("a payout notice goes to the people it paid", () => {
  it("owes the 30% holder a figure", () => {
    /* p2 is not acting and not the president; p1's corporation is paying. This is the reported case, and the
       amount is `dividendSplit`'s -- the same value the reducer spends, so the notice cannot quote a figure
       nobody received. */
    expect(owedTo("p2")).toMatchObject({ amount: 30 });
  });

  it("owes the president their own share too", () => {
    // Suppressed for the ACTOR by the drain, not by the arithmetic: they already have a receipt.
    expect(owedTo("p1")).toMatchObject({ amount: 60 });
  });

  it("owes a non-shareholder nothing", () => {
    /* p3 holds none. THE NARROWNESS, as a case: a watcher with no stake in this corporation is told nothing,
       which is what keeps this from becoming #718's firehose at a six-player table. */
    expect(owedTo("p3")).toBeNull();
  });

  it("owes nothing on a withhold", () => {
    // A withhold moves money into the treasury and to no player at all.
    expect(dividendSplit(board(), CO, "100", false)?.players).toEqual([]);
  });

  it("pays nobody the IPO's slice", () => {
    // 10% unsold: $100 declared, $90 to players, and the notice can only name what a person received.
    const split = dividendSplit(board(), CO, "100", true)!;
    expect(split.players.reduce((sum, share) => sum + share.amount, 0)).toBe(90);
  });
});

describe("the payout notice reaches a watcher, from the right figure", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("uses the dividend toast that has always existed", () => {
    /* #786 ADDED A SECOND ONE AND #795 WITHDREW IT. `showDividendToast` fires in the drain for every
       shareholder, actor or not, and has since #400 -- so the reported "I don't receive any toast
       notifications when another player's corporation pays dividends to me" was never a missing feature. It
       was a wrong FIGURE, loud enough to read as an absence. I searched for the mechanism I expected instead
       of the one on screen, in a file I had already read. */
    expect(APP).toContain("showDividendToast(");
    expect(APP).not.toContain("paid you $");
  });

  it("takes the amount from dividendSplit rather than re-deriving it", () => {
    /* THE ACTUAL BUG. The caller passed a `perShare` floored from `last_route_revenue` -- a running total a
       multi-train turn fills one message at a time -- which is why every wrong figure reported was one
       train's worth of a longer run. */
    expect(APP).toContain("const settlement = dividendSplit(");
    expect(APP).toContain("declared.revenue_amount");
    expect(APP).toContain("amount: mine?.amount ?? 0");
  });

  it("no longer reads the running total", () => {
    const receiptCall = APP.slice(
      APP.indexOf("const settlement = dividendSplit("),
      APP.indexOf("if (receipt) {"),
    );
    expect(receiptCall).not.toContain("last_route_revenue");
  });

  it("keeps the receipt module out of the arithmetic", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const module = fs.readFileSync(path.join(__dirname, "dividendReceipt.ts"), "utf8");
    const code = module.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("const amount = input.amount;");
    expect(code).not.toContain("input.perShare * (input.viewerPercentage / 10)");
  });
});

describe("the route readout is not a control", () => {
  const BAR = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(
      path.join(__dirname, "..", "panels", "ContextualActionBar.tsx"),
      "utf8",
    );
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  })();

  it("renders the panel for anyone on the Routes step", () => {
    /* THE REPORT. The figures exist -- `rivalTrainDrafts` prices every rival route -- and the only reason
       they were invisible is that the panel printing them asked to be the actor's. */
    expect(BAR).toContain(
      'const showRouteReadout = roundType === "OperatingRound" && orSubPhase === "Routes";',
    );
    expect(BAR).toContain("{showRouteReadout && (");
  });

  it("keeps the mode toggle on the acting player", () => {
    /* TWO FLAGS RATHER THAN ONE WIDENED FLAG. Widening `showRouteToggle` would have handed a watcher the
       control that engages route mode on somebody else's turn. */
    expect(BAR).toContain(
      'const showRouteToggle =\n    roundType === "OperatingRound" && orSubPhase === "Routes" && mayActThisTurn;',
    );
  });

  it("gives a watcher no controls at all", () => {
    /* #787 SHOWED THE PANEL TO WATCHERS WITH ITS BUTTONS DISABLED, and #802 removed the panel: a watcher now
       gets the chip strip, which has no run or clear control to disable in the first place. Absence beats a
       greyed row -- the same reasoning #783 used for the home-station modal.
       So the assertion moves from "the buttons are disabled" to "the strip's only control is gated on being
       able to use it", which is the property that survives the panel it used to describe. */
    expect(BAR).toContain("canClear={mayActThisTurn && sessionReady}");
    expect(BAR).not.toContain("<RoutePlannerPanel");
  });

  it("still hands a watcher the rival drafts", () => {
    /* The shell's half, which was already right and is what made this a five-line fix: the bar is given
       `rivalTrainDrafts` when it is not your turn. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    expect(app).toContain("trainDrafts={isMyTurn ? trainDrafts : rivalTrainDrafts}");
  });
});
