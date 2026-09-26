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
} from "../gameEngine/depotSchedule";
import { depotInventory, tierOrderFor } from "../gameEngine/gamePhase";
import { trainCapacityFor } from "../gameEngine/routeAuthority";
import { isUnlimitedReach } from "../gameEngine/trainReach";
import { applyPhaseChange } from "../gameEngine/sandboxSession";
import { withEmptyRoster } from "../gameEngine/gameSetup";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenarioState } from "../gameEngine/sandboxState";
import { MOCK_TRAIN_CATALOG } from "../gameEngine/mockFixtures";
import type { GameStateResponse } from "../gameEngine/gameState";

const TIERS = ["2", "3", "4", "5", "6", "D"] as const;

describe("nothing was lost in the split", () => {
  it("covers every tier the old map did", () => {
    expect(Object.keys(DEPOT_SCHEDULE).sort()).toEqual([...TIERS].sort());
  });

  it("keeps every phase name", () => {
    /* #1327: the Diesel row used to read "Diesel Era" while the phase badge and the Rules Reference both
       said `Phase D`. The names are now derived from `gamePhase.ts`'s own naming, so this list is what the
       badge prints -- which is what this field's comment always promised. The Diesel keeps a gloss because
       `Phase D` alone does not say which train opens it, and the gloss is the app's own existing spelling, the one the phase-shift warning has printed since #5. */
    const phases = TIERS.map((tier) => DEPOT_SCHEDULE[tier].phase);
    expect(phases).toEqual([
      "Phase 2",
      "Phase 3",
      "Phase 4",
      "Phase 5",
      "Phase 6",
      "Phase D (Diesel)",
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
    /* ==================================================================
        DESIGN NOTE 1126: THE CLAIM IS THE HEADERS, NOT THE STYLE KEY THEY USE
       ==================================================================
       THIS PINNED `styles.th` AND THAT WAS NEVER THE POINT. #735's report was about four FACTS getting four
       columns instead of one column doing all four jobs; which padding token each header carries is a
       different subject entirely. #1126 moved Phase and Status onto `thTight` to pay for the new Available
       Tiles column, and this case failed on two headers that are exactly where #735 put them.
       MATCHED ON THE HEADER TEXT IN A `<th>`, whatever style it wears -- so the next width change is free and
       a header actually going missing still fails. */
    for (const header of ["Phase", "On First Purchase", "Rusts", "Status"]) {
      expect(ledger).toMatch(new RegExp(`<th style=\\{styles\\.\\w+\\}>${header}</th>`));
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

/* ==================================================================
    RUST-RETIRE-2A (H3): THE PRINTED 1830 ROSTER, ASKED OF THE RUNTIME
   ==================================================================
   The retired Rust engine pinned its own `TRAIN_CATALOG` against the printed roster
   (`train_catalog_matches_printed_1830_roster`). With that crate gone, the roster exists only in this engine --
   and in more than one table: the depot's counts, prices and limits (`gamePhase.ts`), the reach the route judge
   enforces (`trainCapacityFor`, over `MOCK_TRAIN_CATALOG`), and the reducer's own rust table (`sandboxSession.ts`
   `RUSTS_ON`, which `depotInventory`'s `rustedBy` mirrors for the card and the countdown).
   SO EACH COLUMN BELOW IS READ BACK THROUGH THE FUNCTION PLAY CONSULTS, never from a copy, on the board a new
   room opens with. The `PRINTED` rows are the certification evidence -- the rulebook's train table as the in-app
   Rules Reference prints it -- and an edit to any one runtime table fails here.
   THE STANDARD GAME ONLY. The Level Playing Field's 7-train and $900 Diesel are pinned in
   `levelPlayingFieldRules.test.ts`; no other variant changes the roster. The Diesel's inexhaustible supply is
   asserted at the purchase itself, in `trainLifecycle.test.ts` (H4). */
describe("the printed 1830 train roster, read through the runtime authorities (RUST-RETIRE-2A H3)", () => {
  type Reach = number | "unlimited";
  //                                           tier  printed  price  reach  limit*  rusted by   (* while the phase)
  const PRINTED: ReadonlyArray<readonly [string, number | null, number, Reach, number, string | null]> = [
    ["2", 6, 80, 2, 4, "4"],
    ["3", 5, 180, 3, 4, "6"],
    ["4", 4, 300, 4, 3, "D"],
    ["5", 3, 450, 5, 2, null],
    ["6", 2, 630, 6, 2, null],
    ["D", null, 1_100, "unlimited", 2, null], // null: no ceiling -- the Bank never runs out of Diesels
  ];
  const tiers = PRINTED.map(([tier]) => tier);
  /* The base a room's log replays onto (`roundReplay.ts`, `gameHistory.ts`): the board with every trace of a
     played game removed, every fleet `[]`. */
  const fresh = () => withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));

  it("is six tiers, in the order the depot sells them, with no 7-train", () => {
    expect(tierOrderFor(fresh())).toEqual(tiers);
    expect(depotInventory(fresh()).map((row) => row.tier)).toEqual(tiers);
  });

  it("opens every new game on the full printed depot: count, price and train limit, tier by tier", () => {
    expect(depotInventory(fresh()).map((row) => [row.tier, row.total, row.remaining, row.cost, row.trainLimit])).toEqual(
      PRINTED.map(([tier, printed, price, , limit]) => [tier, printed, printed, price, limit]),
    );
  });

  it("gives each train the reach the route judge enforces -- and the Diesel an unlimited one", () => {
    expect(
      tiers.map((tier) => {
        const capacity = trainCapacityFor(tier);
        return [tier, isUnlimitedReach(capacity) ? "unlimited" : capacity];
      }),
    ).toEqual(PRINTED.map(([tier, , , reach]) => [tier, reach]));
  });

  it("rusts exactly the printed victims when each tier arrives, and never a 5, a 6 or a Diesel", () => {
    /* One train of every tier, each in its own corporation so no train limit is in play; every arrival is the
       reducer's own `applyPhaseChange`, the call the depot purchase makes. */
    const base = fresh();
    const holders = base.public_companies.slice(0, tiers.length).map((company) => company.company_id);
    expect(holders).toHaveLength(tiers.length);
    const fleet: GameStateResponse = {
      ...base,
      public_companies: base.public_companies.map((company) => {
        const at = holders.indexOf(company.company_id);
        return at < 0 ? company : { ...company, owned_trains: [tiers[at]] };
      }),
    };
    const survivors = (state: GameStateResponse) =>
      state.public_companies.flatMap((company) => company.owned_trains ?? []);
    expect(survivors(fleet)).toEqual(tiers);

    expect(tiers.map((arriving) => [arriving, tiers.filter((tier) => !survivors(applyPhaseChange(fleet, arriving)).includes(tier))])).toEqual([
      ["2", []],
      ["3", []],
      ["4", ["2"]],
      ["5", []],
      ["6", ["3"]],
      ["D", ["4"]],
    ]);
    // ...and the depot's rust column, which the card and the countdown print, says the same thing.
    expect(depotInventory(fresh()).map((row) => [row.tier, row.rustedBy])).toEqual(
      PRINTED.map(([tier, , , , , rustedBy]) => [tier, rustedBy]),
    );
  });

  it("holds the stand-in catalog's prices and counts to the depot (`MOCK_TRAIN_CATALOG`)", () => {
    /* Only this catalog's REACH is read at runtime (`trainCapacityFor`, above). Its `costVgp` and `bankQuantity`
       are read by nothing outside tests -- leftovers of the retired Rust array it mirrored -- and are held to the
       depot here only so the stand-in cannot quietly disagree with the rule before it is retired. NOT its Diesel
       `bankQuantity: 20`, which already does: the depot's `total: null` is the rule. */
    expect(
      depotInventory(fresh()).map((row) => {
        const entry = MOCK_TRAIN_CATALOG.find((train) => train.modelType === row.tier);
        return [row.tier, entry?.costVgp, row.total === null ? null : entry?.bankQuantity];
      }),
    ).toEqual(PRINTED.map(([tier, printed, price]) => [tier, price, printed]));
  });
});
