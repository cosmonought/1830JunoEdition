/** @jest-environment node */
//
// One word per pile, swept across every player-facing surface. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 743 (harness): CASH IS A PLAYER'S, TREASURY IS A CORPORATION'S
// ==================================================================
//
// REPORTED: "listing the player's money as 'Cash' in the action bar and 'Treasury' on the corp card is
// confusing. I think we need to tighten up our language: Cash is what a player has, Treasury is what a
// corporation has."
//
// A VOCABULARY RULE NEEDS A SWEEP, NOT A FIX. Two surfaces were wrong when this was reported; the interesting
// question is not those two but the twentieth, written next year by somebody who read one of the remaining
// nineteen and copied its wording. So the assertion is over the whole components directory.
//
// AND IT IS SCOPED TO THE WORDS A PLAYER READS. `treasuryProjection.ts` is generic arithmetic over a balance
// and is correctly named -- both piles use it. `presidentCash` is a prop name. Neither is a label, and a scan
// that flagged them would be noise, which is how a rule this soft gets switched off. What is forbidden is a
// STRING that names a player's money "Treasury".
//
// 1830 MAKES THE DISTINCTION LOAD-BEARING. A president's cash and their corporation's treasury are separate
// piles that may not be mixed, except in the one emergency the rules carve out. A UI using one word for both
// teaches the opposite of the rule -- which is why this is a test rather than a style preference.

import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments discuss the old wording in the past tense and must keep doing so -- #490a, four times over. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("no player's money is called a Treasury", () => {
  /** Phrases that put a PLAYER and the corporation's word in one string. */
  const FORBIDDEN = [
    /President'?s (Personal )?Treasury/i,
    /Player Treasury/i,
    /Your Treasury/i,
    /Personal Treasury/i,
  ];

  it("has none anywhere in the app", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = code(file);
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${path.relative(SRC, file)}  ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still lets the design notes quote what was wrong", () => {
    /* #490a's rule, and the reason the scan reads a comment-stripped copy. #743's note quotes
       "President's Personal Treasury" as the string it replaced, and that quotation is the argument.
       #806 removed the tooltip that carried the corrected wording and quoted THAT on the way out, which is
       why this still passes against the raw file: the record of a fix outlives the code it fixed. */
    const bar = fs.readFileSync(path.join(SRC, "panels", "ContextualActionBar.tsx"), "utf8");
    expect(bar).toMatch(/Treasury/);
    expect(bar).toContain("President's Cash:");
  });
});

describe("the two labels that were reported", () => {
  it("names the sale projection Cash, because it projects playerCash", () => {
    /* THE CONFUSION AT ITS SOURCE. A player watching their own money move read the word the corporation cards
       use for theirs -- in the block that exists specifically to show them their own balance. */
    const panel = code(path.join(SRC, "components", "StockRoundPanel.tsx"));
    const start = panel.indexOf("function TreasuryProjectionBlock");
    const block = panel.slice(start, start + 2000);
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("Cash");
    expect(block).not.toMatch(/>\s*Treasury\s*</);
  });

  it("names the president's own money Cash where the two piles meet", () => {
    /* The place they sit closest together -- an emergency purchase is precisely the moment a player must
       tell them apart, and it was the one calling both "Treasury".
       DESIGN NOTE 806 MOVED THIS ASSERTION, and the move is worth recording because the old one had drifted
       from its own title. It said "in the emergency panel" and read `ContextualActionBar.tsx`, checking the
       bar's president-cash TOOLTIP -- a different surface from the one it named. That tooltip is now gone
       (its figure is on `PlayerCashStrip` for the whole table, under the board), so the example points at the
       panel the title always claimed: `EmergencyTrainPurchaseModal`, which spends a president's cash and
       calls it cash. */
    const modal = code(path.join(SRC, "components", "EmergencyTrainPurchaseModal.tsx"));
    expect(modal).toContain("Your cash $");
    expect(modal).not.toMatch(/Your Treasury/i);
  });

  it("heads the Operating Round strip Cash, because its rows are players", () => {
    /* THE SURFACE THAT REPLACED THE TOOLTIP. #670's strip is the reason #326's hover became redundant, so it
       is now the load-bearing example: one heading over a row per seat, in the round where money moves. */
    const strip = code(path.join(SRC, "components", "PlayerCashStrip.tsx"));
    expect(strip).toContain("<h4 style={styles.title}>Cash</h4>");
    expect(strip).toContain('aria-label="Player cash"');
    expect(strip).not.toMatch(/Treasury/i);
  });
});

describe("corporations keep the word Treasury", () => {
  it("is still the Ledger's column header", () => {
    /* THE OTHER HALF, and the one an over-eager rename would break. The rule is not "avoid the word"; it is
       "one word per pile". A sweep that removed Treasury everywhere would leave corporations with no name for
       their money and make the vocabulary worse, not better. */
    const ledger = code(path.join(SRC, "components", "FinancialLedger.tsx"));
    expect(ledger).toContain("Treasury");
  });

  it("is still the Operating Round strip's header", () => {
    expect(code(path.join(SRC, "components", "ContextualSubPanel.tsx"))).toContain("Treasury");
  });

  it("is still what a withhold pays into", () => {
    // "Withhold to Corporate Treasury" -- correct, and the clearest statement of the rule in the whole app.
    expect(code(path.join(SRC, "panels", "ContextualActionBar.tsx"))).toContain(
      "Corporate Treasury",
    );
  });
});

describe("the share-price row says something in every case", () => {
  it("explains a token that cannot fall further", () => {
    /* Design note #743a. The row returned `null` whenever the projected price equalled the current one -- which
       on this chart means the bottom of a column. So the board position where a seller most wants reassurance
       showed the same blank as a feature that had never been built, and an absent row cannot be told from a
       missing one. */
    const panel = code(path.join(SRC, "components", "StockRoundPanel.tsx"));
    expect(panel).toContain("if (after === null) return null;");
    expect(panel).toContain("already at the bottom of its column");
  });

  it("no longer hides the row on an equal price", () => {
    const panel = code(path.join(SRC, "components", "StockRoundPanel.tsx"));
    expect(panel).not.toContain("after === null || after === marketPrice");
  });
});
