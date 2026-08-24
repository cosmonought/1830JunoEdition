/** @jest-environment node */
//
// The private companies' copy: the right vocabulary, and a summary short enough to compare. No React.
//
// ==================================================================
//  DESIGN NOTE 771 / 772 (harness)
// ==================================================================
//
// REPORTED (771): "On M&H's special power it reads: '... a share is actually free in the bank or the pool.'
// 'bank or the pool' is confusing: the terms should be IPO or Bank?"
//
// THE RULE SURVIVED THE REPORT AND THE WORDS DID NOT. Asked directly, the answer was that the power really
// does reach both piles -- "the stated rule is correct, it can come from both IPO and Bank pool" -- so this
// pass changed nothing about what the M&H does. It changed what the two piles are called, to the names the
// rest of the app already uses. Recorded because the tempting fix was the wrong one: an ambiguous sentence
// invites you to narrow the rule to match your reading of it.
//
// REPORTED (772): "the Special Powers on the PC cards needs to be like 1-2 bullet items, and players can
// click a 'Full Rules' to read the full paragraph."
//
// THE COUNT IS THE INVARIANT WORTH PINNING. A summary has no natural limit -- every correction to a rule is
// a reason to add one more clause, and the shape degrades back into the paragraph one honest sentence at a
// time. Three bullets means the paragraph is being smuggled in, so it fails here.
//
// #490a: the vocabulary scan runs on a comment-stripped copy, because a design note explaining that "the
// bank or the pool" was wrong would otherwise be indistinguishable from the wrong text itself.

import {
  PRIVATE_COMPANY_CATALOG,
  abilitySummary,
  privateAcronym,
  type PrivateCatalogEntry,
} from "./privateCatalog";

const ENTRIES = Object.entries(PRIVATE_COMPANY_CATALOG) as [string, PrivateCatalogEntry][];
const MH = PRIVATE_COMPANY_CATALOG[4];

const SOURCE = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const raw = fs.readFileSync(path.join(__dirname, "privateCatalog.ts"), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
})();

describe("the two share piles are named the way the rest of the app names them", () => {
  it("says IPO or the Bank Pool on the M&H", () => {
    /* THE REPORT. Both piles, because both piles are right -- this is a vocabulary fix and the assertion is
       deliberately about the words rather than about the reach of the power. */
    expect(MH.ability).toContain("free in the IPO or the Bank Pool");
  });

  it("no longer calls one pile two things", () => {
    expect(MH.ability).not.toContain("bank or the pool");
  });

  it("still says the trade is available in either round type", () => {
    /* THE RULE THAT WAS NOT SUPPOSED TO CHANGE, pinned so a later tidy of this sentence cannot quietly
       narrow it. #548 lists this clause as one of the four things the verbatim text was carried for. */
    expect(MH.ability).toContain("in either kind of round");
  });

  it("keeps the 60% ceiling and the closure on the M&H", () => {
    expect(MH.ability).toContain("under 60%");
    expect(MH.ability.toLowerCase()).toContain("closes the company");
  });

  it("never lowercases a pile name anywhere in the catalog", () => {
    /* The whole file, not just the entry that was reported: "the bank" and "the pool" as bare nouns are the
       shape of the confusion, and one corrected sentence does not make a vocabulary. */
    const offenders = ENTRIES.filter(([, entry]) =>
      /\bthe bank\b(?! pool)|\bthe pool\b/i.test(`${entry.ability} ${abilitySummary(entry)}`),
    ).map(([id]) => id);
    expect(offenders).toEqual([]);
  });

  it("carries the note explaining why, and the scan cannot see it", () => {
    // #490a, both halves: the wrong phrase is gone from the code and the note about it survives.
    expect(SOURCE).not.toContain("bank or the pool");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "privateCatalog.ts"), "utf8");
    expect(raw).toContain("DESIGN NOTE 771");
    expect(raw).toContain("bank or the pool");
  });
});

describe("the summary is short enough to compare six of them", () => {
  it.each(ENTRIES)("gives %s one or two bullets", (_id, entry) => {
    expect(entry.abilityBullets.length).toBeGreaterThanOrEqual(1);
    expect(entry.abilityBullets.length).toBeLessThanOrEqual(2);
  });

  it.each(ENTRIES)("keeps each of %s's bullets to a scannable line", (_id, entry) => {
    /* A LENGTH LIMIT IS THE ONLY THING THAT MAKES THE COUNT LIMIT MEAN ANYTHING: two bullets of ninety words
       is the paragraph again with a caret in the middle. 100 is roughly one line at the card's width. */
    for (const bullet of entry.abilityBullets) {
      expect(bullet.length).toBeLessThanOrEqual(100);
    }
  });

  it.each(ENTRIES)("says something for %s rather than leaving a blank", (_id, entry) => {
    /* Schuylkill Valley's reason, generalised: a blank reads as missing data, not as "no power". Its bullet
       says so outright. */
    for (const bullet of entry.abilityBullets) {
      expect(bullet.trim().length).toBeGreaterThan(0);
    }
  });

  it("still says outright that the SV has no power", () => {
    expect(abilitySummary(PRIVATE_COMPANY_CATALOG[1]).toLowerCase()).toContain("no special power");
  });

  it.each(ENTRIES)("keeps %s's paragraph longer than its summary", (_id, entry) => {
    /* THE POINT OF HAVING TWO. If a summary ever grows past the rule it summarises, the disclosure is
       costing a click for less information than the card already showed. */
    expect(entry.ability.length).toBeGreaterThan(abilitySummary(entry).length);
  });
});

describe("the one-liner is derived, not a third copy", () => {
  it("joins the bullets in order", () => {
    expect(abilitySummary(PRIVATE_COMPANY_CATALOG[2])).toBe(
      PRIVATE_COMPANY_CATALOG[2].abilityBullets.join(" "),
    );
  });

  it("has no stored summary field left to drift", () => {
    /* #772's actual claim. A behavioural test cannot tell a derived summary from a hand-kept one that
       happens to match today, so this is the structural half: the field is gone from the file. */
    expect(SOURCE).not.toContain("abilitySummary:");
    expect(ENTRIES.every(([, entry]) => !("abilitySummary" in entry))).toBe(true);
  });

  it("changes with the bullets it is built from", () => {
    const invented: PrivateCatalogEntry = {
      ...PRIVATE_COMPANY_CATALOG[3],
      abilityBullets: ["First.", "Second."],
    };
    expect(abilitySummary(invented)).toBe("First. Second.");
  });
});

describe("the catalog's other guarantees still hold", () => {
  it("keeps an acronym for all six", () => {
    expect(ENTRIES.map(([id]) => privateAcronym(Number(id)))).toEqual([
      "SV",
      "C&StL",
      "D&H",
      "M&H",
      "C&A",
      "B&O",
    ]);
  });

  it("keeps #312's hexes distinct", () => {
    // C&StL is B-20, D&H is F-16, and the M&H reserves nothing.
    expect(PRIVATE_COMPANY_CATALOG[2].ability).toContain("B-20");
    expect(PRIVATE_COMPANY_CATALOG[3].ability).toContain("F-16");
    expect(PRIVATE_COMPANY_CATALOG[4].ability).not.toContain("F-16");
  });

  it("keeps #548's four corrections in the paragraphs", () => {
    /* The lay that is extra, the lay that is not, the mountain's price, and the C&A share arriving on
       purchase. Every one of them was wrong in a previous paraphrase. */
    expect(PRIVATE_COMPANY_CATALOG[2].ability).toContain("bonus rather than a substitute");
    expect(PRIVATE_COMPANY_CATALOG[3].ability).toContain("$120");
    expect(PRIVATE_COMPANY_CATALOG[3].ability).toContain("uses up the corporation");
    expect(PRIVATE_COMPANY_CATALOG[5].ability).toContain("stays open");
  });
});

describe("the surfaces are wired to the block", () => {
  const read = (relative: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  };

  it("puts bullets on both auction cards", () => {
    /* Two cards, one live and one sold, and the sold one is the copy that gets forgotten -- #391's whole
       lesson about two copies of a description. */
    const dashboard = read("components/WaterfallAuctionDashboard.tsx");
    expect(dashboard.match(/<SpecialPowerBlock/g)?.length).toBe(2);
  });

  it("no longer prints the paragraph on the card", () => {
    const dashboard = read("components/WaterfallAuctionDashboard.tsx").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(dashboard).not.toContain("{catalogEntry.ability}");
  });

  it("offers the paragraph behind a click", () => {
    const block = read("components/SpecialPowerBlock.tsx");
    expect(block).toContain("Full Rules");
    expect(block).toContain("aria-expanded={open}");
    expect(block).toContain("aria-controls={detailId}");
  });

  it("starts collapsed", () => {
    /* Open by default would be the paragraph again, with an extra control. */
    expect(read("components/SpecialPowerBlock.tsx")).toContain("useState(false)");
  });

  it("leaves the trade panel on the one-line shape", () => {
    // #661's row has one line to spend, so it takes the derived summary rather than the list.
    expect(read("components/PrivateTradePanel.tsx")).toContain("abilitySummary(catalog)");
  });
});
