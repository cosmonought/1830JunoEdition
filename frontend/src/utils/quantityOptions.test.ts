/** @jest-environment node */
//
// Source scans; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 1255 (harness): THE SELECTOR IS GONE, AND THE BUTTON STILL SAYS WHAT IT BUYS
// ==================================================================
//
// This file used to pin #719's rule for the quantity row's LENGTH ("the phase's limit and nothing else") and
// `quantityOptionCount`, the function that sized it. Both went with the selector: one press buys one train,
// so there is no row to size and no count to get wrong. What survives is #722's property -- the visible label
// is a price, so the accessible name must carry the verb and the tier -- and a scan that keeps the selector
// from coming back in a smaller costume.

export {};

const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const PANEL = readStripped("components/TrainPurchasePanel.tsx");
const APP = readStripped("App.tsx");

describe("one press, one train, #1255", () => {
  it("the panel has no quantity control and asks for one train", () => {
    expect(PANEL).not.toContain("quantityText");
    expect(PANEL).not.toContain("optionCount");
    expect(PANEL).not.toContain("quantityOptionCount");
    expect(PANEL).not.toContain('aria-label={`How many');
    expect(PANEL).toContain("onBuyFromBank(nextTier.tier);");
    expect(PANEL).toContain("Buy one {nextTier.tier}-train");
  });

  it("the shell dispatches exactly one purchase per press, with no loop and no summary", () => {
    const start = APP.indexOf("const handleBuyTrainsFromBank = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const handler = APP.slice(start, APP.indexOf("[runGameplayAction, gameId, actingProtocolId", start));
    /* #1326: the message names the shelf tier when there was a choice, so the literal is spread over lines;
       the one purchase, the two ids and the absence of a loop are what this case pins. */
    expect(handler).toContain("BuyHardwareFromPool: {");
    expect(handler).toContain("game_id: gameId,");
    expect(handler).toContain("protocol_id: actingProtocolId,");
    expect(handler).toContain("...(openTiers.length > 1 ? { model_type: tier } : {}),");
    expect(handler).not.toContain("for (");
    expect(handler).not.toContain("silentInLog");
    expect(handler).not.toContain("logInfo(");
    expect((handler.match(/runGameplayAction\(/g) ?? []).length).toBe(1);
  });

  it("the sizing function is gone from trainLimit", () => {
    const limit = readStripped("utils/trainLimit.ts");
    expect(limit).not.toContain("export function quantityOptionCount");
    expect(limit).toContain("export function buyableNow");
  });

  it("gives the price-only buy button a spoken name", () => {
    /* Design note #722: the visible label is `$600`, which reads correctly ONLY beside the sentence above it.
       A screen reader announces a button on its own, so the accessible name has to carry the verb and the
       tier that the eye picks up from the surrounding line. #1104: the label is a named const. */
    const raw = require("fs").readFileSync(
      require("path").join(__dirname, "..", "components", "TrainPurchasePanel.tsx"),
      "utf8",
    ) as string;
    expect(raw).toContain("const payButtonLabel = atTrainLimit");
    expect(raw).toContain('? "Train Limit Reached"');
    expect(raw).toContain(": `Pay $");
    expect(raw).toMatch(/aria-label=\{\s*atTrainLimit/);
    expect(raw).toContain("from the Bank for $");
    // #722's verbose label stays gone from the code and quoted in the note.
    expect(PANEL).not.toContain("-Train for $");
    expect(raw).toContain("-Train for $");
  });
});
