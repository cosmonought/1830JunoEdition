/** @jest-environment node */
//
// Design note #1272 (harness): the treasury slide-out reads a DIFF, and the diff has to be right about the
// cases that used to be a toast -- a spend, a receipt, two treasuries in one action, and nothing at all.

export {};

const { movementToShow, treasuryMovements } =
  require("./treasuryMovement") as typeof import("./treasuryMovement");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");
import type { GameStateResponse } from "./gameState";

const PRR = 1;
const BO = 4;

const board = (treasuries: Record<number, string | undefined>): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    active_operating_order: [PRR, BO],
    active_corporation_index: 0,
    public_companies: [
      { company_id: PRR, ticker: "PRR", treasury: treasuries[PRR] },
      { company_id: BO, ticker: "B&O", treasury: treasuries[BO] },
    ],
  }) as unknown as GameStateResponse;

describe("the treasury diff", () => {
  it("reports a spend as a negative movement", () => {
    const [move] = treasuryMovements(board({ [PRR]: "920", [BO]: "600" }), board({ [PRR]: "740", [BO]: "600" }));
    expect(move).toEqual({ companyId: PRR, ticker: "PRR", before: 920, after: 740, delta: -180 });
  });

  it("reports a receipt as a positive one", () => {
    const [move] = treasuryMovements(board({ [PRR]: "740", [BO]: "600" }), board({ [PRR]: "900", [BO]: "600" }));
    expect(move.delta).toBe(160);
  });

  it("is silent when nothing moved, and when the chain did not say", () => {
    expect(treasuryMovements(board({ [PRR]: "920", [BO]: "600" }), board({ [PRR]: "920", [BO]: "600" }))).toEqual([]);
    expect(treasuryMovements(board({ [PRR]: undefined, [BO]: "600" }), board({ [PRR]: "920", [BO]: "600" }))).toEqual([]);
    expect(treasuryMovements(null, board({ [PRR]: "920", [BO]: "600" }))).toEqual([]);
  });

  it("prefers the acting corporation when a trade moves two", () => {
    /* A corporation-to-corporation train sale moves both treasuries in one action. The panel names the one
       the player was looking at. */
    const moves = treasuryMovements(board({ [PRR]: "920", [BO]: "600" }), board({ [PRR]: "840", [BO]: "680" }));
    expect(moves).toHaveLength(2);
    expect(movementToShow(moves, BO)?.companyId).toBe(BO);
    expect(movementToShow(moves, null)?.companyId).toBe(PRR);
    expect(movementToShow([], PRR)).toBeNull();
  });
});

describe("the machine is wired where the dividend one is", () => {
  const APP = readStripped("App.tsx");
  const MACHINE = readStripped("components/TreasuryMoneyMachine.tsx");

  it("reads the diff after the state is committed, and is replay-silent", () => {
    expect(APP).toContain("treasuryMovements(before, after)");
    const raiser = APP.slice(APP.indexOf("const showTreasuryMovement = useCallback("));
    expect(raiser.slice(0, 200)).toContain("if (replayingHistory) return;");
  });

  it("shares the player's corner, the other way up, and says which it is (design note #1291)", () => {
    /* #1272 put this panel top right under the action bar; #1291 ruled both slide-outs into the bottom-right
       corner, cued apart: the corporation's wears its livery and herald and says TREASURY, with rounded
       corners against the player's square ones, and its spend merges UPWARD. When both are up the
       corporation's sits one step above. */
    expect(MACHINE).not.toContain("data-action-bar");
    expect(MACHINE).toContain('kind="corporation"');
    expect(MACHINE).toContain("heraldTicker: event.ticker");
    expect(MACHINE).toContain('label: "Treasury"');
    const PANEL = readStripped("components/MoneyMachinePanel.tsx");
    expect(PANEL).toContain("borderRadius: corporation ? RADIUS.card : 0");
    expect(PANEL).toContain("{rises ? holderRow : moverRow}"); // #1339: direction, defaulting from kind
    expect(PANEL).toContain("bottom: `${CORNER_BOTTOM_PX + stackIndex * STACK_STEP_PX}px`");
    expect(readStripped("App.tsx")).toContain("stackIndex={dividendPayout ? 1 : 0}");
  });

  it("keeps the dividend machine's schedule rather than retyping it", () => {
    for (const mark of ["MONEY_MACHINE_FALL_AT_MS", "MONEY_MACHINE_MERGE_AT_MS", "MONEY_MACHINE_LEAVE_AT_MS", "MONEY_MACHINE_TOTAL_MS"]) {
      expect(MACHINE).toContain(mark);
    }
    expect(MACHINE).not.toContain("const MONEY_MACHINE_");
    expect(MACHINE).toContain('from "./moneyMachineSchedule"');
  });

  it("merges by subtraction when the sign says so", () => {
    expect(MACHINE).toContain('amountText: `${spend ? "−" : "+"}$${magnitude}`');
    expect(MACHINE).toContain("ink: spend ? CARD_INK_NEGATIVE : CARD_INK_POSITIVE");
  });

  it("whooshes on the subtraction, measured (design note #1291, item 9)", () => {
    /* `spend.mp3` peaks 1.18s in; fired that far before the merge so the peak lands on it -- #1082's own
       method for the ding. Through the shell's helper, like every cue (#1041), and only on a spend. */
    expect(MACHINE).toContain('export const SPEND_SFX = "spend.mp3";');
    expect(MACHINE).toContain("SPEND_CUE_AT_MS = MONEY_MACHINE_MERGE_AT_MS - SPEND_WHOOSH_AT_MS");
    expect(MACHINE).toContain("if (spend) timers.push(window.setTimeout(onCue, SPEND_CUE_AT_MS));");
    expect(MACHINE).not.toContain("playVariantCue");
    expect(readStripped("App.tsx")).toContain("playVariantCue(SPEND_SFX, sfxEnabledRef.current && sfxPayoutRef.current);");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    expect(fs.existsSync(path.join(__dirname, "..", "..", "public", "audio", "spend.mp3"))).toBe(true);
  });
});

describe("the treasury panel is the president's, and back-to-back spends are one panel (#1371, #1372)", () => {
  const APP = readStripped("App.tsx");

  it("is raised only for the viewer who presides over the corporation that spent", () => {
    const site = APP.slice(APP.indexOf("const shown = movementToShow("), APP.indexOf("const shown = movementToShow(") + 900);
    expect(site).toContain("?.president === viewer;");
    expect(site).toContain("if (shown && presides) {");
  });

  it("holds a movement for a second one by the same corporation, and folds them", () => {
    const raiser = APP.slice(APP.indexOf("const showTreasuryMovement = useCallback("), APP.indexOf("const handleTreasuryMachineDone"));
    expect(raiser).toContain("if (replayingHistory) return;");
    expect(raiser).toContain("if (held.movement.companyId === movement.companyId) {");
    expect(raiser).toContain("amount: held.movement.amount + movement.amount,");
    expect(raiser).toContain("treasuryBefore: held.movement.treasuryBefore,");
    // A different corporation's movement releases the held one rather than being folded into it.
    expect(raiser).toContain("releaseHeldTreasury();");
    expect(raiser).toContain("window.setTimeout(releaseHeldTreasury, TREASURY_MACHINE_COALESCE_MS)");
  });
});
