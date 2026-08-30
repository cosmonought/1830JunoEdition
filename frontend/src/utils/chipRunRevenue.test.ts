/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1031 (harness): WHAT EACH TRAIN EARNED, AFTER THE DRAFTING STOPS
// ==================================================================
//
// REQUESTED (Batch 33 item 7): "Show revenue on rival train chips."
//
// #1021 ANSWERED HALF OF IT and this file exists because the other half is a different question. That note got
// the LIVE figure onto a watcher's chips by preferring what the president publishes over what the watcher's
// own client prices -- correct, and it only ever holds while somebody is publishing. Presence is scratch: it
// is written as the president draws, and a watcher who joins after the run, or reloads, or simply looks a
// minute later has none of it. Asked which of the two channels to use, the report's answer was "both".
//
// SO THE CASES BELOW SPLIT THE SAME WAY THE FIX DOES. The first describe is the resolution ORDER on the chip,
// driven against the real function, because "which source wins" is the whole of the change and is pure
// arithmetic. The second is the reducer keeping the figures it already computed. The third is the field's
// LIFETIME, which is where this could most easily reproduce #1028 in a new field.

export {};

const { watcherTrainDrafts } =
  require("./watcherRouteChips") as typeof import("./watcherRouteChips");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const REDUCER = readStripped("utils/sandboxSession.ts");

type Roster = Parameters<typeof watcherTrainDrafts>[0]["roster"];

/** Two trains, so a case can tell "the right entry" from "the first entry". */
const ROSTER = [
  { trainIndex: 0, model: "5" },
  { trainIndex: 1, model: "5" },
] as unknown as Roster;

/** A drawn two-hex path, which is the shortest thing that counts as a route (#498). */
const DRAWN = { 0: [[1, 1], [2, 2]] } as unknown as Parameters<
  typeof watcherTrainDrafts
>[0]["actorDrafts"];

const chips = (over: Partial<Parameters<typeof watcherTrainDrafts>[0]>) =>
  watcherTrainDrafts({
    roster: ROSTER,
    actorDrafts: DRAWN,
    labelForHex: (q, r) => `H${q}${r}`,
    priceRoute: () => 111,
    ...over,
  });

/* ------------------------------------------------------------------ */
/* The chip's three sources, in order                                 */
/* ------------------------------------------------------------------ */

describe("the chip prefers the most settled figure it has", () => {
  it("shows the committed figure when the run has happened", () => {
    /* THE REPORT. A watcher wants to know what the trains earned, and after the run that fact lives in the
       replayed state rather than in anybody's presence document. */
    expect(chips({ bankedFor: () => 200 })[0].value).toBe(200);
  });

  it("prefers the committed figure over the president's published one", () => {
    /* THE ORDERING, WHICH IS THE ONE REAL DECISION IN THIS CHANGE. #1021 put presence above local pricing
       because the president's figure is what the president is looking at. The committed figure outranks BOTH:
       the reducer priced it once, against the board the log describes, where `routeValues` is each client's
       own pre-commit arithmetic -- which is exactly the $440-versus-$450 disagreement #1021 was reported for.
       A fix that appended the new source to the END of the chain would pass every other case in this file. */
    expect(chips({ bankedFor: () => 200, valueFor: () => 450 })[0].value).toBe(200);
  });

  it("falls back to the published figure while the president is still drafting", () => {
    /* #1021 IS NOT SUPERSEDED, and this is the case that says so. Before a run is committed there is no
       banked figure, so presence is not merely preferred, it is the only answer there is. */
    expect(chips({ bankedFor: () => undefined, valueFor: () => 450 })[0].value).toBe(450);
  });

  it("falls back to local pricing for a log that carries neither", () => {
    // #232: an action written before this field existed does not say, and the chip prices what it can see.
    expect(chips({})[0].value).toBe(111);
  });

  it("shows a committed zero rather than falling through it", () => {
    /* THE VACUITY TRAP IN THIS CHAIN. `??` is correct and `||` is not: a train whose route genuinely earned
       nothing has a banked entry of 0, and a truthiness test would discard it and price the draft instead --
       reporting $111 for a run that paid nothing. This is #1026's `if (!ok)` against index 0, in a new place. */
    expect(chips({ bankedFor: () => 0, valueFor: () => 450 })[0].value).toBe(0);
  });

  it("keeps the em dash for a draft that is not yet a route", () => {
    /* #498 SURVIVES. A one-stop draft has no value on any channel, and "0" is a run that earned nothing --
       a different claim. Train 1 has no drafted path at all here. */
    expect(chips({ valueFor: () => 450 })[1].value).toBeNull();
  });

  it("shows a committed figure for a train whose drafted path is gone", () => {
    /* THE CASE THE WHOLE CHANGE EXISTS FOR, and the reason the two-stop gate had to stop covering the banked
       branch. A watcher arriving after the run has NO presence at all, so there is no path to price and the
       old shape returned null before it ever consulted a figure. The run still happened. */
    expect(chips({ actorDrafts: null, bankedFor: () => 200 })[0].value).toBe(200);
  });

  it("joins on the fleet slot, not on the model", () => {
    /* WHY THE PAYLOAD CARRIES AN INDEX AT ALL. Both trains here are 5-trains -- a legal fleet -- and a
       breakdown joined by model would answer both chips with the first entry. */
    const byIndex = chips({
      actorDrafts: null,
      bankedFor: (trainIndex) => (trainIndex === 0 ? 200 : 340),
    });
    expect(byIndex[0].value).toBe(200);
    expect(byIndex[1].value).toBe(340);
  });
});

/* ------------------------------------------------------------------ */
/* The reducer keeps what it already worked out                       */
/* ------------------------------------------------------------------ */

describe("the breakdown is kept rather than recomputed", () => {
  it("files the per-route figures the sum was built from", () => {
    /* NOTHING NEW IS CALCULATED. `priced` has held the per-train figures since #968; the arm summed them and
       dropped the array, which is why a watcher could be told the corporation earned $640 and never which
       train earned which half. */
    expect(REDUCER).toContain("printed_revenue: String(priced[at]),");
    expect(REDUCER).toContain("last_run_breakdown: breakdown");
  });

  it("writes nothing when the log cannot name the trains", () => {
    /* #232, AND THE STRONGER FORM OF IT. An old action carries no `train_indices`, and a breakdown built from
       routes whose trains cannot be identified would attach real figures to guessed slots -- worse than the
       absence, because the chip's fallbacks are honest about not knowing and a wrong index is not. */
    expect(REDUCER).toContain("train_indices && train_indices.length === routes.length");
  });

  it("keeps the printed figure rather than apportioning the adjusted one", () => {
    /* A RULES CONSTRAINT, NOT A CONVENIENCE. #941 rules the Unpredictable Revenue die is rolled once per
       corporation turn and applied to the aggregate, so no train has an adjusted figure of its own. The
       obvious "nicer" version of this feature splits the adjusted total across the trains, which would invent
       an apportionment 1830 does not define and -- #938's rounding being lossy -- would not re-sum to what the
       treasury received. */
    expect(REDUCER).toContain("printed_revenue: String(priced[at]),");
    expect(REDUCER).not.toContain("printed_revenue: String(roll");
  });

  it("still totals the money exactly as it did", () => {
    /* THE CONTROL. This arm moves money, and the change is meant to be purely additive: a fix that quietly
       re-based the sum on the breakdown would pass every case above. */
    expect(REDUCER).toContain("const printedThisMessage = priced.reduce((sum, value) => sum + value, 0);");
    expect(REDUCER).toContain("const printedTotal = previousPrinted + printedThisMessage;");
  });

  it("is sent the fleet slot by the shell that dispatches the run", () => {
    /* #1006's LESSON. A field the deciding caller never populates is not a field, and this one is optional --
       so a missing dispatch would degrade silently to the pre-#1031 behaviour rather than failing loudly. */
    expect(APP).toContain("train_indices: turnRoutes.map((entry) => entry.trainIndex),");
  });

  it("carries the slot through the filter rather than recovering it after", () => {
    /* THE BUG THIS SHAPE AVOIDS. `turnRoutes` drops any draft of fewer than two points, so the surviving
       entries are NOT positionally aligned with `runnable` -- a two-route list built from a three-train fleet
       cannot be re-joined to the fleet by position. Taking the index along while the draft is still in hand is
       the difference between an exact join and a guess. */
    expect(APP).toContain("trainIndex: draft.trainIndex,");
  });
});

/* ------------------------------------------------------------------ */
/* The field's lifetime                                               */
/* ------------------------------------------------------------------ */

describe("the breakdown does not outlive the turn it describes", () => {
  it("is cleared with the other turn-scoped figures", () => {
    /* THE #1028 TRAP, INVERTED. That note's field is copied FORWARD on the turn change because the Stock tab
       shows it for corporations that are not operating. This one is read only through the acting
       corporation's chips, so a breakdown that outlived its turn could only ever be read as a claim about the
       wrong turn -- a watcher opening the chips before this corporation has run would see last round's
       figures as though the trains had already gone out. */
    expect(REDUCER).toContain("last_run_breakdown: [],");
  });

  it("is listed in the predicate that decides a clear is needed", () => {
    /* THE GAP THAT WOULD SURVIVE THE LINE ABOVE. `staleRun` gates the whole clear, and the other three fields
       can all be zero while the breakdown is not: a turn whose routes earned nothing still ran trains. Left
       out of the predicate, such a turn leaves a breakdown standing that no later clear ever reaches. */
    expect(REDUCER).toContain("(company.last_run_breakdown?.length ?? 0) !== 0");
  });

  it("clears to an empty list rather than to absence", () => {
    /* #232's DISTINCTION, KEPT SHARP. Absence is reserved for "the log does not say", which is what an old
       replay means and what the chip's pricing fallback answers. "This corporation has not run this turn" is
       a positive fact, and an empty list is how it is stated. */
    expect(REDUCER).not.toContain("last_run_breakdown: undefined");
  });

  it("is read from the replayed state, not from presence", () => {
    /* THE POINT OF THE WHOLE EXERCISE, pinned where it could most easily regress. Every other revenue input
       to that memo arrives through `actor`, and a `bankedFor` that reached for presence would type-check,
       pass the pure cases above, and restore the exact bug: nothing to show once the drafting stops. */
    expect(APP).toContain("const entry = actingRunBreakdown?.find((row) => row.train_index === trainIndex);");
    expect(APP).not.toContain("actor?.last_run_breakdown");
  });

  it("distinguishes a missing entry from a zero one at the shell boundary", () => {
    /* THE SAME TRAP AS THE CHIP'S `??`, one layer out. `Number(...) || 0` is right for the VALUE and would be
       catastrophic for the ABSENCE: returning 0 for a train with no entry would stop the chain dead and print
       "$0" for a train that simply has not run. */
    expect(APP).toContain("entry === undefined ? undefined : Number(entry.printed_revenue) || 0");
  });

  it("lists the breakdown among the memo's dependencies", () => {
    /* #1020's FAULT AT THE MEMO LAYER: a value read inside a memo that does not list it stops updating the
       moment nothing else in the list changes -- so the chips would show the figures from whenever the memo
       last happened to rebuild. */
    expect(APP).toContain("actingRunBreakdown,\n  ]);");
  });
});
