/** @jest-environment node */
//
// The depot schedule as data, and the table that reads it. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 735 (harness): FOUR FACTS, FOUR COLUMNS
// ==================================================================
//
// REPORTED: "the 'Obsolescence / Event Trigger' column is doing a lot of work, since it's actually listing
// [game phase] [tile unlock] [rust trigger] and [status]. Why don't we have those as individual columns?"
//
// THE SPLIT IS EASY; NOT LOSING ANYTHING IN IT IS THE PART WORTH TESTING. The old strings were the only
// statement of these rules anywhere in the app, so a decomposition that dropped a clause would delete a rule
// silently and leave a table that still looked complete. Every fact from those six sentences is asserted
// below, against the structured data that replaced them.
//
// AND THE PROSE CARRIED AN AMBIGUITY THE SPLIT HAD TO RESOLVE. "Rusts" appeared in two senses -- what buying
// this tier does to OTHER fleets ("First buy rusts all 2-Trains") and when THIS tier's trains die ("Rusts when
// D-Train bought") -- interleaved with no marker, so tier 2 stated only the second, tier 6 only the first and
// tier 4 both. The tests here pin which column each sense went to, because that is the decision a later reader
// is likeliest to reverse.

import {
  DEPOT_SCHEDULE,
  PERMANENT_TRAIN,
  rustLabel,
  type DepotTierSchedule,
} from "./depotSchedule";

const TIERS = ["2", "3", "4", "5", "6", "D"] as const;

describe("nothing was lost in the split", () => {
  it("covers every tier the old map did", () => {
    expect(Object.keys(DEPOT_SCHEDULE).sort()).toEqual([...TIERS].sort());
  });

  it("keeps every phase name", () => {
    const phases = TIERS.map((tier) => DEPOT_SCHEDULE[tier].phase);
    expect(phases).toEqual([
      "Phase 2",
      "Phase 3",
      "Phase 4",
      "Phase 5",
      "Phase 6",
      "Diesel Era",
    ]);
  });

  it("keeps both tile unlocks", () => {
    /* The two facts the report calls "[tile unlock]", and the only two there are. A split that lost one would
       leave a table with no statement anywhere of when Brown tiles arrive. */
    expect(DEPOT_SCHEDULE["3"].onFirstPurchase).toContain("Unlocks Green tiles");
    expect(DEPOT_SCHEDULE["5"].onFirstPurchase).toContain("Unlocks Brown tiles");
  });

  it("keeps the private-company closure, which shared a cell with a tile unlock", () => {
    /* THE CLAUSE MOST LIKELY TO HAVE BEEN LOST. It was joined to the Brown unlock by an ampersand inside one
       parenthesis -- "unlocks Brown Tiles & closes all Private Companies" -- so it read as a footnote to the
       tile rule rather than as the separate, larger consequence it is. */
    expect(DEPOT_SCHEDULE["5"].onFirstPurchase).toContain("Closes all Private Companies");
    expect(DEPOT_SCHEDULE["5"].onFirstPurchase).toHaveLength(2);
  });

  it("keeps every fleet-killing effect", () => {
    expect(DEPOT_SCHEDULE["4"].onFirstPurchase).toContain("Rusts all 2-Trains");
    expect(DEPOT_SCHEDULE["6"].onFirstPurchase).toContain("Rusts all 3-Trains");
    expect(DEPOT_SCHEDULE.D.onFirstPurchase).toContain("Rusts all 4-Trains");
  });
});

describe("the two senses of 'rusts' went to different columns", () => {
  it("puts THIS tier's mortality in rustsWhen", () => {
    expect(DEPOT_SCHEDULE["2"].rustsWhen).toBe("A 4-Train is bought");
    expect(DEPOT_SCHEDULE["3"].rustsWhen).toBe("A 6-Train is bought");
    expect(DEPOT_SCHEDULE["4"].rustsWhen).toBe("A D-Train is bought");
  });

  it("puts what the purchase does to OTHERS in onFirstPurchase", () => {
    /* The distinction, stated as an exclusion: tier 4's own death belongs in `rustsWhen`, and what tier 4's
       arrival does to the 2-Trains belongs in `onFirstPurchase`. Mixing them is what the prose did. */
    expect(DEPOT_SCHEDULE["4"].onFirstPurchase).toContain("Rusts all 2-Trains");
    expect(DEPOT_SCHEDULE["4"].rustsWhen).not.toMatch(/2-Train/);
  });

  it("states each rust from both ends, consistently", () => {
    /* DELIBERATE DUPLICATION, and the test that keeps it deliberate. A player reading tier 2's row learns it
       dies to the 4-Train; a player reading tier 4's row learns buying it kills the 2-Trains. Same event,
       both directions, so neither row needs cross-referencing -- but the two must never disagree. */
    const pairs: [string, string, string][] = [
      ["2", "4", "2-Trains"],
      ["3", "6", "3-Trains"],
      ["4", "D", "4-Trains"],
    ];
    for (const [dies, killer, plural] of pairs) {
      expect(DEPOT_SCHEDULE[dies].rustsWhen).toContain(`${killer}-Train`);
      expect(DEPOT_SCHEDULE[killer].onFirstPurchase.join(" ")).toContain(plural);
    }
  });
});

describe("a permanent train says so", () => {
  it("marks 5, 6 and D as never rusting", () => {
    for (const tier of ["5", "6", "D"]) {
      expect(DEPOT_SCHEDULE[tier].rustsWhen).toBeNull();
      expect(rustLabel(tier)).toBe(PERMANENT_TRAIN);
    }
  });

  it("keeps 'never' distinguishable from 'unknown'", () => {
    /* `null` means permanent and the renderer prints a WORD for it. An empty cell would collapse the two, and
       an em dash in this column would read as "we do not know when this dies" -- the one thing the table is
       for. */
    expect(PERMANENT_TRAIN).not.toBe("");
    expect(PERMANENT_TRAIN).not.toBe("—");
  });

  it("falls back to Permanent for a tier it does not know", () => {
    // A tier from a variant ruleset should not render `undefined` into the table.
    expect(rustLabel("99")).toBe(PERMANENT_TRAIN);
  });
});

describe("the table reads the data rather than re-stating it", () => {
  const ledger = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(
      path.join(__dirname, "..", "components", "FinancialLedger.tsx"),
      "utf8",
    );
  })();

  it("has the four headers the report asked for", () => {
    for (const header of ["Phase", "On First Purchase", "Rusts", "Status"]) {
      expect(ledger).toContain(`<th style={styles.th}>${header}</th>`);
    }
  });

  it("no longer carries the prose map", () => {
    /* Comment-stripped, per #490a: #735's note quotes the old strings as evidence and must keep doing so. */
    const code = ledger.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("DEPOT_TRIGGER_NOTES");
    expect(ledger).toContain("DEPOT_TRIGGER_NOTES"); // the note explaining its removal survives
  });

  it("still declares the schedule for exactly the shipped tiers", () => {
    // Guards the fixture above: a truncated table would make every assertion here vacuous.
    const entries = Object.values(DEPOT_SCHEDULE) as DepotTierSchedule[];
    expect(entries).toHaveLength(6);
    expect(entries.every((entry) => entry.phase.length > 0)).toBe(true);
  });
});
