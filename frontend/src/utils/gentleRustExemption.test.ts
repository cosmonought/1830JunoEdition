/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1034 (harness): THE EXEMPTION, ASKED RATHER THAN HIDDEN
// ==================================================================
//
// NAMED FOR ITS SUBJECT, NOT FOR A BATCH. This file was first written as `batch38.test.ts` and was destroyed
// by a later batch that the player numbered 38 -- I had taken the number for an unnumbered report and the
// collision overwrote twenty-two cases. Recorded because the lesson is cheap: a harness named after a rule
// cannot be clobbered by a coincidence of numbering.
//
// RULED, with the precedent that settled a question 1830's own variant text leaves open: "1846 officially
// implements the 'delayed obsolescence' rule, and in that version when trains gently rust, they stop counting
// to the train limit and players turn the train cards sideways to indicate they have one run left."
//
// THIS IS THE THIRD POSITION AND THE FIRST WORKABLE ONE, and the harness is shaped by which of the three it
// has to defend against:
//   #906  exempted them by MOVING them out of `owned_trains`, which also removed them from the roster the
//         route planner reads -- so the grace run was unreachable and nothing failed to say so.
//   #979  made them count, correcting the disappearance by dropping the exemption rather than its mechanism.
//   #1034 exempts them again, as a subtraction each counting site performs, with the train left in the fleet.
//
// SO THE DANGEROUS REGRESSION IS #906, not a wrong number. Deleting the train "implements" the rule in one
// line and breaks the feature invisibly. The ruling names that constraint directly -- "you need to make sure
// the train chips for the gently rusting trains continue displaying on their final run" -- and the last
// describe is where it is pinned.

export {};

const { countableTrainCount, trimToTrainLimit, isTrainLocked } =
  require("./trainLimit") as typeof import("./trainLimit");
const { trainPurchaseRefusal } =
  require("./trainPurchaseGate") as typeof import("./trainPurchaseGate");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const BAR = readStripped("panels/ContextualActionBar.tsx");
const BADGES = readStripped("components/TrainBadges.tsx");
const SUBPANEL = readStripped("components/ContextualSubPanel.tsx");
const LEDGER = readStripped("components/FinancialLedger.tsx");
const STOCK = readStripped("components/StockRoundPanel.tsx");
const PANEL = readStripped("components/TrainPurchasePanel.tsx");

const cost = (model: string) =>
  ({ "2": 80, "3": 180, "4": 300, "5": 450, "6": 630 })[model] ?? 0;

/* ------------------------------------------------------------------ */
/* The rule itself                                                    */
/* ------------------------------------------------------------------ */

describe("a reprieved train occupies no limit slot", () => {
  it("subtracts one slot per mark", () => {
    expect(countableTrainCount(["2", "3", "5"], ["2"])).toBe(2);
    expect(countableTrainCount(["2", "3", "5"], [])).toBe(3);
  });

  it("subtracts per TRAIN, not per model", () => {
    /* THE MULTISET RULE, which changes sides with the ruling. It used to stop a `Set` marking both 3s as
       discardable; it now stops one EXEMPTING both. A corporation with one reprieved 3 and one live 3 has one
       countable 3, and `owned.filter(m => !reprieved.includes(m))` would report zero -- handing it a free
       slot it has not earned. */
    expect(countableTrainCount(["3", "3", "6"], ["3"])).toBe(2);
  });

  it("cannot be driven below zero by a mark naming no train", () => {
    /* DEFENSIVE, AND NOT HYPOTHETICAL. #1032 fixed one source of surplus marks -- a phase change re-marking
       trains already marked, which grew the list to four entries for two trains. A count that trusted the
       mark list's length rather than walking the fleet would have turned that into free limit slots. */
    expect(countableTrainCount(["3"], ["3", "3", "3"])).toBe(0);
    expect(countableTrainCount([], ["2"])).toBe(0);
  });

  it("treats an unreported roster as nothing to count", () => {
    // #232: absent is "the chain did not say". The callers distinguish that from empty before they ask.
    expect(countableTrainCount(undefined, ["2"])).toBe(0);
    expect(countableTrainCount(["2", "3"], undefined)).toBe(2);
    expect(countableTrainCount(["2", "3"], null)).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* The trim                                                           */
/* ------------------------------------------------------------------ */

describe("the trim neither counts nor takes a reprieved train", () => {
  it("leaves a fleet whose LIVE trains are within the limit", () => {
    const result = trimToTrainLimit({ owned: ["2", "2", "5"], reprieved: ["2", "2"], limit: 2, cost });
    expect(result.discarded).toEqual([]);
    expect(result.owned).toEqual(["2", "2", "5"]);
  });

  it("does not trim a fleet that is over on ROSTER but under on slots", () => {
    /* ==================================================================
        ADDED BY A NEGATIVE CONTROL THAT PASSED
       ==================================================================
       A CONTROL REVERTING THE EARLY RETURN to `owned.length <= limit` -- the #979 test -- left every other
       case in this file green, because in each of them the doomed-slice happened to come out empty anyway.
       That made the guard look decorative. It is not.
       `slice(0, countable.length - limit)` WITH A NEGATIVE END IS A SLICE FROM THE OTHER DIRECTION. Two
       countable trains against a limit of three gives `slice(0, -1)`, which is not "nothing" -- it is every
       element but the last, so ONE live train is discarded from a fleet that is under the limit. The guard is
       what stops the arithmetic ever being asked that question.
       FOUR TRAINS, TWO OF THEM MARKED, LIMIT THREE: over on roster length, under on slots, and the case where
       the two implementations finally disagree. */
    const result = trimToTrainLimit({ owned: ["2", "2", "4", "5"], reprieved: ["2", "2"], limit: 3, cost });
    expect(result.discarded).toEqual([]);
    expect(result.owned).toEqual(["2", "2", "4", "5"]);
  });

  it("takes the cheapest live train when the live fleet is over", () => {
    /* #284'S RULE SURVIVES AS THE ONLY ORDERING. The marked 2 is not a candidate, so the 3 goes -- not the
       cheaper 2 sitting beside it. */
    const result = trimToTrainLimit({ owned: ["2", "3", "4", "5"], reprieved: ["2"], limit: 2, cost });
    expect(result.discarded).toEqual(["3"]);
    expect(result.reprieved).toEqual(["2"]);
  });

  it("returns the mark list exactly as it received it", () => {
    /* THE INVARIANT THAT REPLACES #979's MARK-STRIPPING. That note had to remove a mark whose train the trim
       had taken, or the expiry -- also a multiset removal -- would later scrap a different live train of the
       same model. Nothing can orphan a mark now, and an edit that started discarding reprieved trains again
       would fail here rather than at the end of somebody's turn. */
    const reprieved = ["3", "3"];
    const result = trimToTrainLimit({ owned: ["3", "3", "4", "5", "6"], reprieved, limit: 2, cost });
    expect(result.reprieved).toEqual(["3", "3"]);
    expect(result.discarded).toEqual(["4"]);
  });

  it("restores the grace run the old ordering was eating", () => {
    /* THE SYMPTOM I REPORTED AFTER BATCH 37 AND COULD NOT FIX UNDER #979. `["3","4","5"]` entering phase 6
       had its 3 marked and then immediately trimmed away -- `reprieved: []`, no final run at all, in every
       game where the phase change also drops the limit. That was correct under the old rule and it was the
       variant cancelling itself. */
    const result = trimToTrainLimit({ owned: ["3", "4", "5"], reprieved: ["3"], limit: 2, cost });
    expect(result.owned).toContain("3");
    expect(result.reprieved).toEqual(["3"]);
  });
});

/* ------------------------------------------------------------------ */
/* The gates                                                          */
/* ------------------------------------------------------------------ */

describe("the gates measure the countable fleet", () => {
  const state = (owned: string[], reprieved: string[]): any => ({
    current_round_type: "OperatingRound",
    operating_sub_phase: "Hardware",
    active_operating_order: [1],
    active_corporation_index: 0,
    public_companies: [
      {
        company_id: 1,
        ticker: "PRR",
        treasury: "5000",
        owned_trains: [...owned],
        pending_rust_trains: [...reprieved],
      },
    ],
  });

  it("still refuses when the LIVE fleet is at the limit", () => {
    /* RULED when asked directly: two live trains against a limit of two is full, and the exempt train
       neither blocks nor helps. The alternative -- treating the dying train as already gone and freeing its
       slot early -- was declined. */
    expect(trainPurchaseRefusal(state(["4", "5", "3"], ["3"]), 1, { cost: 100, trainLimit: 2 })).toContain(
      "Train limit reached",
    );
  });

  it("allows the purchase the exemption makes legal", () => {
    /* THE HALF THAT WAS BROKEN. One live train and one condemned one against a limit of two is one countable
       train, so this corporation may buy -- and under the roster-length test it was refused. */
    expect(trainPurchaseRefusal(state(["4", "3"], ["3"]), 1, { cost: 100, trainLimit: 2 })).toBeNull();
  });

  it("reports the figure it actually judged", () => {
    /* #979'S REPORT WAS TWO SURFACES ENFORCING ONE RULE AGAINST TWO NUMBERS. A refusal that measures the
       countable fleet and then explains itself with the roster length is that fault inside one sentence. */
    const refusal = trainPurchaseRefusal(state(["4", "5", "3"], ["3"]), 1, {
      cost: 100,
      trainLimit: 2,
    });
    expect(refusal).toContain("already holds 2 of a maximum 2");
  });

  it("is the same measure the auto-skip uses", () => {
    /* #703 FOUND THESE TWO DISAGREEING and fixed it by sharing `isTrainLocked`. Teaching only the panel the
       exemption would reproduce that with the sides swapped -- the skip sending a corporation past Buy Trains
       that the panel would have served. */
    /*        ==================================================================
        DESIGN NOTE 1046: THE ARGUMENT LIST GREW, AND THESE PINNED ALL OF IT
       ==================================================================
       THIS ASSERTED THE COMPLETE CALL, closing paren included, so adding a THIRD exempt list -- the Yellow
       Sign's ghost trains, on their own clock -- broke it everywhere. What the case is for did not change:
       every counting site must ask the shared rule rather than measuring the roster itself.
       RE-ANCHORED ON THE SUBJECT, not the whole signature. The trailing comma is deliberate: it still proves
       this site passes the fleet AND a second argument, and it survives a fourth exemption arriving without
       another round of red. An assertion that pins a full argument list is a promise that nothing will ever
       be added to it -- the same promise a trailing paren made in `revenueFlashWiring` two batches ago, and
       broken the same way. */
    expect(APP).toContain("countableTrainCount(\n        company?.owned_trains,");
    expect(APP).toContain("company?.pending_rust_trains,");
    expect(PANEL).toContain(
      // Design note #1046: the subject, not the full signature -- the fourth of these, and the last.
      "countableTrainCount(buyer?.owned_trains, buyer?.pending_rust_trains",
    );
  });

  it("leaves the shared lock rule alone", () => {
    // The comparison is unchanged; only what is fed to it moved. A rewritten predicate would be a second rule.
    expect(isTrainLocked(2, 2)).toBe(true);
    expect(isTrainLocked(1, 2)).toBe(false);
    expect(isTrainLocked(5, null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The train stays visible -- the #906 regression guard               */
/* ------------------------------------------------------------------ */

describe("the condemned train is still in the fleet and still drawn", () => {
  it("keeps every chip call site told which trains are condemned", () => {
    /* THE REPORTED GAP, and #1006's shape exactly: "the pill counts in the Corporations subpanel don't have
       the amber/red/fade-out effects on the train chips, and they should." `TrainChips` has accepted
       `reprieved` since #1004 and ONE of its four call sites passed it, so three surfaces drew a train on its
       final run as an ordinary one.
       COUNTED, NOT MERELY PRESENT -- a negative control caught this. `ContextualSubPanel` and the Ledger each
       pass the marks TWICE, to the chips and to the capacity pill beside them, so deleting one left the other
       satisfying a bare `toContain`. That is the unbounded-match failure this project keeps meeting: a
       well-formed assertion about the wrong occurrence. The Stock Round panel has chips and no pill. */
    const marks = (source: string) =>
      source.split("reprieved={company.pending_rust_trains}").length - 1;
    expect(marks(SUBPANEL)).toBe(2);
    expect(marks(LEDGER)).toBe(2);
    expect(marks(STOCK)).toBe(1);
    expect(BAR).toContain("reprieved={activeCorporation.reprievedTrains}");
  });

  it("keeps the fade class that says 'one run left'", () => {
    /* THE SIDEWAYS CARD, in the ruling's terms. This is the only thing on screen distinguishing a condemned
       train from a healthy one now that it no longer moves the limit figure. */
    expect(BADGES).toContain('"app-train-final-run"');
  });

  it("does not implement the exemption by removing the train", () => {
    /* THE #906 REGRESSION GUARD, and the reason this file exists in the shape it does. The one-line version
       of this rule is to drop the train from `owned_trains`, which satisfies every count above and breaks the
       feature invisibly -- no roster entry, no route draft, no chip, and no failing test. The reducer must
       keep leaving the fleet alone under this variant. */
    expect(readStripped("utils/sandboxSession.ts")).toContain(
      "const fleetAfterRust = gentle\n      ? [...owned]",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Saying so on screen                                                */
/* ------------------------------------------------------------------ */

describe("the exemption is visible where the number is", () => {
  it("counts only the countable trains in the capacity pill", () => {
    /* A PILL DISAGREEING WITH THE GATE would be #979's report on a new surface -- and this pill is where a
       player checks the limit. */
    // Design note #1046: the subject, not the full signature -- see the note on the auto-skip case above.
    expect(BADGES).toContain("const countable = trains == null ? null : countableTrainCount(trains, reprieved");
    expect(BADGES).not.toContain("trains.length >= phase.trainLimit");
  });

  it("names the exempt trains beside the train-limit figure", () => {
    /* RULED: "add an additional parenthetical to the Train Limit like (Gently Rusting: 3-trains)". Without it
       the bar reads "2 / 2" beside three chips, which looks like it is miscounting the fleet in front of it. */
    expect(BAR).toContain("(Gently Rusting: {reprievedNames})");
    expect(BAR).toContain("Train limit: {countableTrains} / {phase.trainLimit}");
  });

  it("drops the parenthetical entirely in a standard game", () => {
    /* NOT "(Gently Rusting: )" AND NOT "()". Most tables never see this, and a surface that renders empty
       punctuation reads as a rendering fault. */
    expect(BAR).toContain("reprievedNames !== null && (");
  });

  it("derives the figure and its explanation from one place", () => {
    /* THE FAILURE THIS AVOIDS is the one #979 was reported for: a count and a sentence about the count,
       computed separately, disagreeing. */
    // Design note #1046: the subject, not the full signature.
    expect(BAR).toContain(
      "const countableTrains = countableTrainCount(\n    activeCorporation?.trains,\n    activeCorporation?.reprievedTrains,",
    );
  });
});
