// frontend/src/utils/fleetDiscard.test.ts
//
// ==================================================================
//  DESIGN NOTE 704 (harness): WHAT THE PHASE TOOK, AND WHY
// ==================================================================
//
// REQUESTED: "when corporations exceed the train limit, discard their lowest value train".
//
// `applyPhaseChange` has done exactly that since design note #284 -- rust first, then trim cheapest-first --
// so the interesting work was not writing the rule but finding out it was already there and had never been
// SAID. Trains left a corporation's chips between one render and the next with nothing in the Activity Log.
//
// TWO THINGS MADE THAT INVISIBLE:
//
//   #296's block meant the trim almost never fired on the BUYER. A corporation was refused the purchase that
//   would leave it over the new limit, so the only fleets ever trimmed belonged to bystanders. A rule
//   prevented from running looks a lot like a rule that was never written -- the first draft of #703's note
//   claimed, wrongly, that nothing in the codebase discarded at all.
//
//   And the loss was silent, which is #702's report made real: "I actually thought the 3-train purchase had
//   been swapped out with it because it is so hard to see." A misreading then. A president who buys a 4-train
//   and finds two chips where three were is now reading correctly.
//
// So this file pins the RULE (order, preference, ordering against rust) and the SENTENCE (that it describes
// what the reducer actually removed), because the two failing apart is how a correct reducer produced a
// confusing table.

import {
  applyPhaseChange,
  describeFleetLoss,
  describeFleetLosses,
  describePrivateClosures,
} from "../gameEngine/sandboxSession";
import { pendingTrainDiscards } from "../gameEngine/trainDiscard";
import type { GameStateResponse } from "../gameEngine/gameState";

/* ==================================================================
    DESIGN NOTE 1530 (harness): THE TRIM IS GONE; THE PHASE OWES, IT DOES NOT TAKE
   ==================================================================
   Everything above describes the automatic cheapest-first trim, which stood from #284 to Batch 4 and is
   replaced in Batch 4.6 by the president's `DiscardTrain` (rulebook 6.6.1; `trainDiscard.ts`). The cases
   below that pinned WHICH train the trim took now pin that it takes none and that the obligation is owed to
   the right corporation, in the right amount. The rust half of the ordering is unchanged, and so is the
   SENTENCE -- `describeFleetLoss` still narrates a fleet that shrank at a boundary (the Yellow Sign ghost's
   expiry, #1046, keeps its own trim) -- so those cases build their before/after states by hand rather than
   through a phase change that no longer discards. */

function stateWith(fleets: Record<number, string[]>): GameStateResponse {
  return {
    public_companies: Object.entries(fleets).map(([id, owned_trains]) => ({
      company_id: Number(id),
      ticker: `C${id}`,
      owned_trains,
      is_floated: true,
    })),
  } as unknown as GameStateResponse;
}

function fleetOf(state: GameStateResponse, companyId: number): string[] {
  return [...(state.public_companies.find((c) => c.company_id === companyId)?.owned_trains ?? [])];
}

describe("the phase takes nothing; the president is owed the choice (#1530)", () => {
  it("leaves a fleet over the new limit exactly as it was, and owes one discard", () => {
    /* Phase 4 allows three; this corporation holds four after buying the 4-train that started it. The trim
       used to take a 3 ($180) here. Now the fleet stands, and `pendingTrainDiscards` says who owes what. */
    const before = stateWith({ 1: ["3", "3", "3", "4"] });
    const after = applyPhaseChange(before, "4");
    expect(fleetOf(after, 1)).toEqual(["3", "3", "3", "4"]);
    expect(pendingTrainDiscards(after)?.required).toMatchObject({ companyId: 1, excess: 1, limit: 3 });
  });

  it("owes as many discards as the fleet is over by", () => {
    // Phase 5 allows two. A corporation holding four owes two, and loses none here.
    const before = stateWith({ 1: ["3", "3", "4", "5"] });
    const after = applyPhaseChange(before, "5");
    expect(fleetOf(after, 1)).toEqual(["3", "3", "4", "5"]);
    expect(pendingTrainDiscards(after)?.required).toMatchObject({ companyId: 1, excess: 2, limit: 2 });
  });

  it("owes nothing to a corporation entitled to keep what it holds", () => {
    const before = stateWith({ 1: ["4", "5"] });
    expect(applyPhaseChange(before, "5")).toBe(before);
    expect(pendingTrainDiscards(before)).toBeNull();
  });

  it("owes every over-limit corporation, not only the buyer", () => {
    // The limit is a rule about holdings; whose purchase triggered it does not enter into it.
    const before = stateWith({ 1: ["3", "3", "3", "4"], 2: ["4", "4", "4", "5"] });
    const after = applyPhaseChange(before, "5");
    expect(fleetOf(after, 1)).toEqual(["3", "3", "3", "4"]);
    expect(fleetOf(after, 2)).toEqual(["4", "4", "4", "5"]);
    expect(pendingTrainDiscards(after)?.queue.map((due) => [due.companyId, due.excess])).toEqual([[1, 2], [2, 2]]);
  });

  it("leaves an unreported roster alone", () => {
    /* `undefined` is "the chain did not say", not "owns nothing" -- #232's distinction. Trimming a fleet this
       build cannot see would invent one. */
    const before = {
      public_companies: [{ company_id: 1, ticker: "C1", owned_trains: undefined }],
    } as unknown as GameStateResponse;
    expect(applyPhaseChange(before, "5")).toBe(before);
  });
});

describe("a partial state is survived, not filled in (design note #897)", () => {
  /* ==================================================================
      THE CRASH THIS FILE FOUND, AND THE WORSE FIX IT COULD HAVE HAD
     ==================================================================
     Seven cases here threw "Cannot read properties of undefined (reading 'map')" -- every one whose arriving
     tier was 5, because only Phase 5 reaches #736's privates arm. The fixture above was RIGHT: it reports
     `public_companies` and nothing else, which #232 says means "the chain did not say", not "there are none".
     `applyPhaseChange` already honoured that rule for `owned_trains` and not for the lists holding them.
     THE TEMPTING FIX WAS THE DANGEROUS ONE. Defaulting the field and returning it would stop the throw and
     convert "did not say" into "there are none" -- the exact error #232 exists to prevent, committed by the
     fix for it. So these cases assert BOTH halves: it does not throw, AND it does not invent the field. */

  const partial = (fleets: Record<number, string[]>) =>
    ({
      public_companies: Object.entries(fleets).map(([id, owned_trains]) => ({
        company_id: Number(id),
        ticker: `C${id}`,
        owned_trains,
        is_floated: true,
      })),
    }) as unknown as GameStateResponse;

  it("closes no privates for a state that never reported any", () => {
    const before = partial({ 1: ["3", "3", "4", "5"] });
    const after = applyPhaseChange(before, "5");
    // It did not throw on the way to the privates arm, and (#1530) the limit took nothing: the two-over fleet
    // is owed to the president, which is the proof the roster was read.
    expect(fleetOf(after, 1)).toEqual(["3", "3", "4", "5"]);
    expect(pendingTrainDiscards(after)?.required.excess).toBe(2);
  });

  it("does not invent an empty privates list on the way out", () => {
    /* THE ASSERTION THAT MATTERS MOST, and `hasOwnProperty` rather than `=== undefined` because those two
       answers differ here: a field written as `[]` and a field never written are both falsy to a careless
       reader, and only one of them lies about the game.
       WHAT IT ACTUALLY GUARDS is the conditional spread in `applyPhaseChange`'s return, NOT the `!= null`
       check beside it -- established by control rather than assumed: replacing that check with `?? []` leaves
       this passing, and writing `private_companies` unconditionally fails it. The two guards do different
       jobs, and the sibling case above is the one that covers the throw. */
    const before = partial({ 1: ["3", "3", "4", "5"] });
    const after = applyPhaseChange(before, "5");
    /* #1530: with the trim gone a phase-5 change on this fixture has nothing to write -- no rust at 5, no
       roster to close -- so the state comes back by identity, which is the strongest form of "nothing was
       invented". A phase-4 change on a fleet with a 2-train still rebuilds the state (rust), and still
       writes no privates list: both halves are asserted. */
    expect(after).toBe(before);
    expect(Object.prototype.hasOwnProperty.call(after, "private_companies")).toBe(false);
    const rusting = partial({ 1: ["2", "3", "4"] });
    const rusted = applyPhaseChange(rusting, "4");
    expect(rusted).not.toBe(rusting);
    expect(fleetOf(rusted, 1)).toEqual(["3", "4"]);
    expect(Object.prototype.hasOwnProperty.call(rusted, "private_companies")).toBe(false);
  });

  it("survives a state with no public roster either", () => {
    /* The sibling hazard, and the same rule. A state reporting neither list has nothing to change, so the
       function must hand it straight back rather than throwing on the way to that conclusion. */
    const empty = { private_companies: [] } as unknown as GameStateResponse;
    expect(applyPhaseChange(empty, "5")).toBe(empty);
    expect(Object.prototype.hasOwnProperty.call(applyPhaseChange(empty, "5"), "public_companies")).toBe(
      false,
    );
  });

  it("still closes the privates it CAN see, which is the control", () => {
    /* Without this the three cases above would all be satisfied by a function that had simply stopped closing
       privates altogether -- a guard that swallows the rule it was protecting. */
    const before = {
      public_companies: [],
      private_companies: [
        { private_id: 1, name: "Schuylkill Valley", closed: false },
        { private_id: 2, name: "Camden & Amboy", closed: true },
      ],
    } as unknown as GameStateResponse;
    const after = applyPhaseChange(before, "5");
    expect(after.private_companies.map((priv) => priv.closed)).toEqual([true, true]);
    // Design note #1058: the number rides along now; this case is about WHICH private closed.
    expect(describePrivateClosures(before, after).map((entry) => entry.name)).toEqual([
      "Schuylkill Valley",
    ]);
  });

  it("narrates nothing rather than throwing when the lists are absent", () => {
    /* The two describers run in the same `App.tsx` block as the reducer, on the state it just returned, so a
       partial state reaches all three. Guarding the reducer alone would have moved the crash one line down. */
    const partialState = partial({ 1: ["4"] });
    expect(describePrivateClosures(partialState, partialState)).toEqual([]);
    expect(describeFleetLosses({} as GameStateResponse, {} as GameStateResponse)).toEqual([]);
  });
});

describe("rust resolves before the limit is read, and that ordering is load-bearing", () => {
  it("does not owe a discard for a train the phase already destroyed", () => {
    /* Phase 4 rusts every 2-train AND cuts the limit to three. This corporation holds four, one of which is a
       2. Rusting it first brings the fleet to three, which is legal -- so nothing is owed.
       Reading the limit FIRST would have owed a 3-train as well, leaving two where the rules leave three. */
    const before = stateWith({ 1: ["2", "3", "3", "4"] });
    const after = applyPhaseChange(before, "4");
    expect(fleetOf(after, 1)).toEqual(["3", "3", "4"]);
    expect(pendingTrainDiscards(after)).toBeNull();
  });

  it("still owes a discard when rusting alone is not enough -- and takes nothing itself (#1530)", () => {
    const before = stateWith({ 1: ["2", "3", "3", "3", "4"] });
    const after = applyPhaseChange(before, "4");
    // The 2 rusts, leaving four; the limit is three, so ONE discard is owed -- the president's to choose.
    expect(fleetOf(after, 1)).toEqual(["3", "3", "3", "4"]);
    expect(pendingTrainDiscards(after)?.required).toMatchObject({ companyId: 1, excess: 1, choices: ["3", "3", "3", "4"] });
  });
});

describe("the sentence describes what was actually removed", () => {
  /* #1530: a phase change no longer removes a train for the limit, so the "after" states here are written by
     hand -- the shape the ghost expiry (#1046) still produces, and the shape the narrator must keep reading. */
  const shrunk = (before: GameStateResponse, fleets: Record<number, string[]>) => ({
    ...before,
    public_companies: before.public_companies.map((company) => ({
      ...company,
      owned_trains: fleets[company.company_id] ?? company.owned_trains,
    })),
  });

  it("separates a rust from a discard", () => {
    const before = stateWith({ 1: ["2", "3", "3", "3", "4"] });
    const after = shrunk(applyPhaseChange(before, "4"), { 1: ["3", "3", "4"] });
    const [loss] = describeFleetLosses(before, after);

    expect(loss.rusted).toEqual(["2"]);
    expect(loss.discarded).toEqual(["3"]);
  });

  it("counts repeats rather than de-duplicating them", () => {
    /* Two 3-trains are two trains. A set difference would report one loss where the corporation suffered two,
       and the table would disagree with the sentence beside it. */
    const before = stateWith({ 1: ["3", "3", "3", "4"] });
    const after = shrunk(before, { 1: ["3", "4"] });
    const [loss] = describeFleetLosses(before, after);
    expect(loss.discarded).toEqual(["3", "3"]);
  });

  it("says nothing when nothing was taken", () => {
    const before = stateWith({ 1: ["4", "5"] });
    expect(describeFleetLosses(before, applyPhaseChange(before, "5"))).toEqual([]);
  });

  it("names the limit, so the discard does not read as a choice", () => {
    /* 1830 takes the train; the president has no say. A sentence that said only "discarded its 3-train" would
       describe a decision nobody made. */
    const before = stateWith({ 1: ["3", "3", "3", "4"] });
    const [loss] = describeFleetLosses(before, shrunk(before, { 1: ["3", "3", "4"] }));
    const line = describeFleetLoss(loss, 3);
    expect(line).toBe("C1: its 3-train was discarded to meet the new limit of 3.");
  });

  it("joins a rust and a discard into one line", () => {
    const before = stateWith({ 1: ["2", "3", "3", "3", "4"] });
    const [loss] = describeFleetLosses(before, shrunk(applyPhaseChange(before, "4"), { 1: ["3", "3", "4"] }));
    expect(describeFleetLoss(loss, 3)).toBe(
      "C1: its 2-train rusted, and its 3-train was discarded to meet the new limit of 3.",
    );
  });

  it("agrees in number for a multiple discard", () => {
    const before = stateWith({ 1: ["3", "3", "4", "5"] });
    const [loss] = describeFleetLosses(before, shrunk(before, { 1: ["4", "5"] }));
    expect(describeFleetLoss(loss, 2)).toBe(
      /* Design note #1100: numerals name the TIER, words count the trains -- ruled, "write out the number
       of trains and reserve numerals for the train tiers", because every train in 1830 is named by a numeral
       and a sentence that also counts in numerals puts two unrelated numbers side by side.
         AND IDENTICAL MODELS COLLAPSE, which is the half this line shows: "3-train and 3-train" names one
         thing twice where a player counts. A mixed fleet still gets the list. */
      "C1: its two 3-trains were discarded to meet the new limit of 2.",
    );
  });

  it("falls back to naming no figure rather than a wrong one", () => {
    // A limit the caller could not read is not a limit of zero, and printing "the new limit of null" would be
    // worse than the vaguer sentence.
    const before = stateWith({ 1: ["3", "3", "3", "4"] });
    const [loss] = describeFleetLosses(before, shrunk(before, { 1: ["3", "3", "4"] }));
    expect(describeFleetLoss(loss, null)).toContain("the new train limit");
  });
});
