/** @jest-environment node */

// No runtime imports: this file reads source text. `export {}` makes it a module for `--isolatedModules`.
export {};
//
// One player panel, in every round. No DOM.
//
// ==================================================================
//  DESIGN NOTE 819 (harness): ONE OF #670's TWO OBJECTIONS SURVIVED
// ==================================================================
//
// REQUESTED: "at the bottom of the Rail Map during the Operating Rounds, we added a 'Cash' panel to show
// players' holdings. I think we should just make this the Players panel from the Stock Round and show them
// everything."
//
// #670 CHOSE A NARROW STRIP OVER THE CARDS AND GAVE TWO REASONS.
//   DUPLICATION -- "it is not a second ledger, and the omissions are the design ... a second opinion on any of
//   them is a fact in two places, which is how the two come to disagree." That argues against a NEW readout.
//   `PlayerCards` is not one: it is the component the Stock Round has always used, over `playerFinances`, the
//   same derivation the Game Ledger reads. Rendering one component in a second place adds no second
//   derivation, which is what #562's rule is about. The duplication #670 feared was already there and was
//   already fine -- so this objection dissolves on inspection rather than being overruled.
//   HEIGHT -- "underneath an already-tall corporation panel, on the one tab where the board is competing for
//   every vertical pixel." That one stands, and it is a MEASUREMENT. This session has twice been wrong about a
//   height by reasoning about it (#508 put a panel in the sticky bar, #785 took it out), which is why #813
//   exists. If the cards prove too tall the answer is a collapse, not a second component.
//
// WHAT HAD TO BE CHECKED RATHER THAN ASSUMED is that the swap loses nothing. #670's whole report was "when
// players click Pay Dividends, it is very hard to tell if the game is actually doing so", and the answer was
// the delta badge -- not the balance. A swap that dropped the badge would have re-opened the report it was
// built for. It does not: #670 threaded `cashDelta` into `PlayerCards` at the time, "so the card asks the
// same question the strip asks and neither has to know how the answer is stored."

const read = (relative: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
};
const strip = (raw: string) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const APP = strip(read("App.tsx"));
const CARDS = strip(read("components/PlayerCards.tsx"));

describe("the cards render in the Operating Round too", () => {
  it("mounts them where the strip was", () => {
    expect(APP).toContain('{gameState?.current_round_type === "OperatingRound" && (');
    expect(APP.match(/<PlayerCards/g)).toHaveLength(2);
  });

  it("has no strip left to disagree with them", () => {
    /* #660a's rule: a component nothing renders is a rule nothing enforces, and this one would have kept a
       second shape over the same dataset alive behind it. */
    expect(APP).not.toContain("PlayerCashStrip");
    expect(APP).not.toContain("playerCashRows");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    expect(fs.existsSync(path.join(__dirname, "..", "components", "PlayerCashStrip.tsx"))).toBe(
      false,
    );
  });

  it("prints the balance alone; the machines answer the original report (design note #1339)", () => {
    /* #670's badge was the answer while a balance was the only surface. The dividend machine (#1060), the
       treasury machine (#1272) and the auction's cash machine (#1339) show the movement now, and the badge
       read as a reservation ("$1140 −$40") beside a figure that had already moved. Gone, with its plumbing. */
    expect(APP).not.toContain("cashDelta={cashDeltaFor}");
    expect(APP).not.toContain("settleCashDeltas");
    expect(CARDS).not.toContain("CashDeltaBadge");
    expect(CARDS).not.toContain("cashDelta");
  });

  it("marks the acting president rather than a seat on turn", () => {
    /* #593's line, drawn where it belongs now: an Operating Round's turn belongs to a CORPORATION, and
       `actingAddress` already resolves that to the president holding the controls. */
    expect(APP).toContain("activeAddress={actingAddress(gameState, waterfallState)}");
  });

  it("does not name the Priority Deal mid-Operating-Round", () => {
    /* It decides who opens the next STOCK round. Marking it here answers a question nobody is asking, which
       is #593's own argument against the seat ordinal, applied to the other marker on the card. */
    const orMount = APP.slice(
      APP.indexOf('{gameState?.current_round_type === "OperatingRound" && ('),
      APP.indexOf('{gameState?.current_round_type === "OperatingRound" && (') + 1400,
    );
    expect(orMount).toContain("priorityAddress={null}");
  });
});

describe("the finances stopped being a fact about a round", () => {
  it("computes them whenever there is a game", () => {
    /* #593 gated the DATA on the round type; #606 had already removed the layout flag that gate existed for.
       What was left was a data gate doing a layout job, and the layout question now has two answers. */
    expect(APP).toContain("const playerFinancesBySeat = useMemo(() => {");
    expect(APP).toContain("if (!gameState) return [];");
    expect(APP).not.toContain('gameState.current_round_type !== "StockRound" &&');
  });

  it("feeds both mounts from the one memo", () => {
    // The property that makes this a relocation rather than a second panel.
    expect(APP.match(/players=\{playerFinancesBySeat\}/g)).toHaveLength(2);
  });
});

describe("the badge's file is gone with it (design note #1339)", () => {
  it("has no home left", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    expect(fs.existsSync(path.join(__dirname, "..", "components", "CashDeltaBadge.tsx"))).toBe(false);
  });
});
