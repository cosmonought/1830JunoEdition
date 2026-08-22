// frontend/src/utils/depotSchedule.ts
//
// What each train tier does to the game, as data rather than as a sentence.
//
// ==================================================================
//  DESIGN NOTE 735: ONE COLUMN WAS DOING FOUR JOBS
// ==================================================================
//
// REPORTED: "the 'Obsolescence / Event Trigger' column is doing a lot of work, since it's actually listing
// [game phase] [tile unlock] [rust trigger] and [status]. Why don't we have those as individual columns?"
//
// COUNTED CORRECTLY, AND THE PROSE HID A REAL INCONSISTENCY. The old strings read:
//
//   2   "Phase 2 (Rusts when 4-Train bought)"
//   3   "Phase 3 (Unlocks Green Tiles; Rusts when 6-Train bought)"
//   4   "Phase 4 (First buy rusts all 2-Trains; Rusts when D-Train bought)"
//   5   "Phase 5 (First buy unlocks Brown Tiles & closes all Private Companies; Permanent)"
//   6   "Phase 6 (First buy rusts all 3-Trains; Permanent)"
//   D   "Diesel Era (First buy rusts all 4-Trains; Permanent)"
//
// -- and inside those parentheses are TWO DIFFERENT KINDS OF RUST, interleaved without ever saying so. "First
// buy rusts all 2-Trains" is what buying THIS tier does to somebody else's fleet; "Rusts when D-Train bought"
// is when THIS tier's own trains die. Tier 2 states only the second, tier 6 only the first, tier 4 both -- so
// a player scanning the column could not tell which sense they were reading without parsing each row.
//
// A COLUMN CAN ONLY MEAN ONE THING, which is the same argument #719 made about the quantity selector's LENGTH
// and #723 about the terrain badge. Split into:
//
//   PHASE            what this tier opens
//   ON FIRST PURCHASE everything the first buy of this tier sets off, to anybody
//   RUSTS             when THIS tier's trains die
//   STATUS            the live badges, which were never a fact about the tier at all
//
// EVERY RUST IS STILL STATED TWICE, from both ends -- tier 2 says "when a 4-Train is bought", tier 4 says
// "rusts all 2-Trains" -- and that is deliberate in a reference table: a player reading either row gets the
// answer without cross-referencing. What changes is that the two statements now live in columns that mean
// different things, so the duplication is legible instead of looking like an inconsistency.
//
// AS DATA, NOT SENTENCES, because that is what makes the split possible at all. The old map could not be
// decomposed by any renderer -- the facts were welded into prose. Anything that wants to ask "which tile
// colour does Phase 5 unlock" can now ask.
//
// See docs/ai_architecture/contract_economy.md, depotSchedule.ts #735.

export interface DepotTierSchedule {
  /** The phase this tier opens, in the words the phase badge uses. */
  phase: string;
  /** Everything the FIRST purchase of this tier sets off. Empty when it sets off nothing. */
  onFirstPurchase: readonly string[];
  /** Whether the FIRST purchase of this tier closes every private company.
   *
   *  Design note #736: A FLAG, NOT A STRING MATCH. `onFirstPurchase` already says "Closes all Private
   *  Companies" -- in prose, for a player to read. The reducer needs the same fact as a value it can branch
   *  on, and matching the sentence would make the rule depend on its own wording. Two representations of one
   *  fact, kept adjacent so a test can hold them together. */
  closesPrivates: boolean;
  /** When this tier's own trains rust, or `null` for a permanent train.
   *  `null` and "never" are the same fact here, and the renderer says "Permanent" for it -- but the data keeps
   *  the absence rather than the word, so a caller that wants to sort or filter on mortality can. */
  rustsWhen: string | null;
}

export const DEPOT_SCHEDULE: Readonly<Record<string, DepotTierSchedule>> = {
  "2": {
    closesPrivates: false,
    phase: "Phase 2",
    onFirstPurchase: [],
    rustsWhen: "A 4-Train is bought",
  },
  "3": {
    closesPrivates: false,
    phase: "Phase 3",
    onFirstPurchase: ["Unlocks Green tiles"],
    rustsWhen: "A 6-Train is bought",
  },
  "4": {
    closesPrivates: false,
    phase: "Phase 4",
    onFirstPurchase: ["Rusts all 2-Trains"],
    rustsWhen: "A D-Train is bought",
  },
  "5": {
    closesPrivates: true,
    phase: "Phase 5",
    onFirstPurchase: ["Unlocks Brown tiles", "Closes all Private Companies"],
    rustsWhen: null,
  },
  "6": {
    closesPrivates: false,
    phase: "Phase 6",
    onFirstPurchase: ["Rusts all 3-Trains"],
    rustsWhen: null,
  },
  D: {
    closesPrivates: false,
    phase: "Diesel Era",
    onFirstPurchase: ["Rusts all 4-Trains"],
    rustsWhen: null,
  },
};

/** The word a permanent train gets in the Rusts column.
 *
 *  Named rather than inlined so the table and any future surface agree, and so the test can assert the
 *  DISTINCTION between "never rusts" and "we do not know" -- which a bare empty cell would collapse. */
export const PERMANENT_TRAIN = "Permanent";

/** What the Rusts column prints for a tier. */
export function rustLabel(tier: string): string {
  return DEPOT_SCHEDULE[tier]?.rustsWhen ?? PERMANENT_TRAIN;
}


/** Whether the first purchase of `tier` closes every private company.
 *
 *  Design note #736: THE RULE HAD A DATA ENTRY, A CAPTION AND NO ENFORCEMENT.
 *
 *  REPORTED: "a 5-train has been purchased, but on the Player Cards in SR and in the Game Ledger > Player
 *  Assets, the private companies are still displayed (and counting toward certificates) ... moreover, the
 *  private companies are still paying out to players. We need to enforce the closure in code, not just design
 *  diary notes."
 *
 *  THE LAST SENTENCE NAMES THIS PROJECT'S MOST COMMON BUG, and this is the purest instance of it yet. Ten
 *  separate places already READ `closed` and behave correctly when it is true -- the payout skips them
 *  (`applyPrivateRevenue`), the trade panel hides them, the power panel greys them, the auction step is
 *  skipped. Every consumer was right. Nothing anywhere ever WROTE it. The rule existed as a caption, as a
 *  schedule entry, and as ten correct readers of a flag that was never set.
 *
 *  WHICH IS WHY (b) IS THE INTERESTING HALF OF THE REPORT: "the game is correctly skipping the Buy Private
 *  Companies action". That step tests something else -- whether any private is still unsold in the auction --
 *  so it went right for a reason that had nothing to do with closure, and looked like evidence the closure
 *  worked. A feature that is half-correct by coincidence is harder to doubt than one that is plainly broken. */
export function closesPrivateCompanies(tier: string): boolean {
  return DEPOT_SCHEDULE[tier]?.closesPrivates === true;
}
