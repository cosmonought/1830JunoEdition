/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 979-981 (harness): A RULE THAT WAS ENFORCED BY HIDING A VALUE
// ==================================================================
//
// #906 RULED THAT A GENTLY-RUSTED TRAIN OCCUPIES NO TRAIN-LIMIT SLOT, and implemented it by moving the train
// out of `owned_trains` into `pending_rust_trains`. Its harness stated the mechanism plainly: "Every surface
// that counts trains counts that array, so this is what implements 'a pending-rust train occupies no
// train-limit slot' without any of them being told."
//
// CORRECTED: "Gently rusted trains do count toward the limit until they are permanently retired at the end of
// their grace run."
//
// AND THE OLD MECHANISM IS WHY THE OLD RULE COULD BE WRONG IN SILENCE. A rule enforced by withholding a value
// from every reader is enforced nowhere in particular: there is no line to review, no assertion to disagree
// with, and nothing that must be updated when the ruling changes. It also took the train off every OTHER
// surface reading `owned_trains` -- including `ownedTrainRoster`, which is where the route planner gets its
// trains -- so #906's headline promise of "exactly one final Operating Round run" was unreachable from the
// moment it was written. `pending_rust_trains` was written by `applyPhaseChange`, cleared by
// `settleOperatingCursor`, and read by nothing else in the app.
//
// THIS FILE THEREFORE ASKS THREE DIFFERENT KINDS OF QUESTION.
//   #979's ORDERING is a pure function and is driven directly -- `trimToTrainLimit` has a defined answer for
//   every fleet, and its failure modes are all "the wrong train survived".
//   #979's WIRING is a source scan, because "the roster the planner draws from includes the reprieved train"
//   is a claim about which array a component reads, and jsdom cannot run the planner.
//   #980's COPY is a value with an answer, so it is compared to the ruled string rather than paraphrased.
//   #981's AUDIENCE is a memo in the shell: a source scan, and the note there says why that is the weak half.

import { trimToTrainLimit } from "./trainLimit";
import { applyPhaseChange, describeFleetLosses } from "./sandboxSession";
import { STANDARD_VARIANTS } from "./gameVariants";
import type { GameStateResponse } from "./gameState";
import { readStripped, sliceBetween } from "./sourceScan";

const COST: Readonly<Record<string, number>> = { "2": 80, "3": 180, "4": 300, "5": 450, "6": 630 };
const cost = (model: string) => COST[model] ?? 0;

describe("the trim leaves the reprieved trains alone (design note #1034, superseding #979)", () => {
  /* ==================================================================
      THIS DESCRIBE IS THE THIRD RULE THIS FEATURE HAS HAD, AND SAYS SO
     ==================================================================
     #906  exempted reprieved trains from the limit by MOVING them out of `owned_trains` -- which also moved
           them out of the roster the planner draws from, so the grace run was unreachable.
     #979  made them count, which fixed the disappearance by removing the exemption rather than its mechanism.
           This file was written for that ruling and its title was "the trim takes the reprieved trains first".
     #1034 exempts them again, and this time as a subtraction each counting site performs, with the train left
           in the fleet where it can be seen and run.
     RULED: "1846 officially implements the 'delayed obsolescence' rule, and in that version when trains gently
     rust, they stop counting to the train limit and players turn the train cards sideways to indicate they
     have one run left."
     THE CASES BELOW ARE REWRITTEN RATHER THAN REPLACED, because the fixtures were well chosen and only their
     expected answers moved. What each one is FOR is unchanged. */

  it("leaves a fleet under the limit alone", () => {
    /* THE CONTROL ON EVERY CASE BELOW. A trim that fired unconditionally would satisfy most of them by
       accident, and the common case at a phase change is a corporation that is already legal. */
    const result = trimToTrainLimit({ owned: ["3", "5"], reprieved: ["3"], limit: 3, cost });
    expect(result.owned).toEqual(["3", "5"]);
    expect(result.reprieved).toEqual(["3"]);
    expect(result.discarded).toEqual([]);
  });

  it("does not count the reprieved trains toward the limit", () => {
    /* THE RULING ITSELF, INVERTED. It read "counts the reprieved trains toward the limit ... three trains
       against a limit of two is over by one however many of them are marked". Two marked 3s and a live 5 is
       ONE countable train, so this fleet is under a limit of two and nothing goes. */
    const result = trimToTrainLimit({ owned: ["3", "3", "5"], reprieved: ["3", "3"], limit: 2, cost });
    expect(result.owned).toEqual(["3", "3", "5"]);
    expect(result.discarded).toEqual([]);
  });

  it("does not discard a reprieved train to make room", () => {
    /* THE FIXTURE WHERE THE OLD RULE AND THE NEW ONE DISAGREE MOST SHARPLY, kept for exactly that. #979 took
       the reprieved 5 here and its reasoning was sound under its own rule -- "a reprieved train is worth
       exactly one more run; a live train is worth every run for the rest of the game". That only holds while
       it occupies a slot. It does not, so taking it would free nothing and cost the corporation its last run. */
    const result = trimToTrainLimit({ owned: ["2", "5"], reprieved: ["5"], limit: 1, cost });
    expect(result.owned).toEqual(["2", "5"]);
    expect(result.discarded).toEqual([]);
    expect(result.reprieved).toEqual(["5"]);
  });

  it("takes the cheapest LIVE train when the live fleet is over", () => {
    /* #284'S RULE, WHICH IS NOW THE ONLY ORDERING. It read "reprieved-first is an ORDERING, not a rule that
       only marked trains may go"; there is no reprieved-first any more, and the marked train is simply not a
       candidate. Three live trains (4, 5, 6) against a limit of two loses the 4. */
    const result = trimToTrainLimit({ owned: ["3", "4", "5", "6"], reprieved: ["3"], limit: 2, cost });
    expect(result.owned).toEqual(["3", "5", "6"]);
    expect(result.discarded).toEqual(["4"]);
  });

  it("exempts one train per mark, not every train of that model", () => {
    /* THE MULTISET RULE, WHICH SURVIVES THE REVERSAL AND CHANGES SIDES. It used to stop a `Set` from marking
       both 3s as discardable; it now stops one from EXEMPTING both. A corporation with one reprieved 3 and
       one live 3 has one countable 3 -- so with a 6 beside them and a limit of 2 it is exactly at the limit
       and nothing goes. A set-based version would report one countable train and also do nothing, so the
       case below is what actually separates them. */
    const result = trimToTrainLimit({ owned: ["3", "3", "6"], reprieved: ["3"], limit: 2, cost });
    expect(result.owned).toEqual(["3", "3", "6"]);
    expect(result.discarded).toEqual([]);
  });

  it("still counts the unmarked twin when the fleet is over", () => {
    /* ==================================================================
        THE CASE THAT SEPARATES A MULTISET FROM A SET, REAIMED
       ==================================================================
       ITS PREDECESSOR MADE THE SAME POINT ABOUT DISCARD ORDER and recorded that the obvious fixture could not
       see the bug -- "it takes two departures to separate them". The same is true of the exemption: with one
       marked 3 and one live 3, a `Set` exempts both and reports one fewer countable train than there is.
       HERE THAT DIFFERENCE DECIDES A DISCARD. Countable is {3, 2} = two against a limit of one, so the
       cheapest live train -- the 2 -- goes. A set-based count would see only the 2, call the fleet legal, and
       leave a corporation holding two countable trains against a limit of one. */
    const result = trimToTrainLimit({ owned: ["3", "3", "2"], reprieved: ["3"], limit: 1, cost });
    expect(result.owned).toEqual(["3", "3"]);
    expect(result.discarded).toEqual(["2"]);
  });

  it("returns the marks untouched", () => {
    /* THE SILENT CORRUPTION THIS PREVENTS, restated for the new rule. #979 had to STRIP a mark whose train the
       trim had taken, or the expiry -- also a multiset removal -- would later scrap a different live train of
       that model. No reprieved train can be taken now, so the correct behaviour is that the mark list comes
       back exactly as it went in. A trim that started editing it again would be the old bug returning. */
    const result = trimToTrainLimit({ owned: ["3", "3", "3"], reprieved: ["3", "3"], limit: 2, cost });
    expect(result.reprieved).toEqual(["3", "3"]);
    expect(result.owned).toEqual(["3", "3", "3"]);
  });

  it("keeps the surviving fleet in its original order", () => {
    /* NOT COSMETIC. The train chips render in array order and the route planner indexes drafts by position
       (#275), so a trim that re-sorted the fleet would move every chip under the player's cursor and
       re-point their route drafts at different trains. */
    const result = trimToTrainLimit({ owned: ["6", "2", "5"], reprieved: [], limit: 2, cost });
    expect(result.owned).toEqual(["6", "5"]);
  });

  it("does nothing when the limit is unbounded", () => {
    /* `Infinity` is what an unreadable phase produces, and #232's rule applies: guessing a limit would take
       trains a corporation legally holds. */
    const result = trimToTrainLimit({ owned: ["2", "3"], reprieved: ["2"], limit: Infinity, cost });
    expect(result.discarded).toEqual([]);
    expect(result.owned).toEqual(["2", "3"]);
  });
});

describe("the reprieved train stays in the fleet (design note #979)", () => {
  const phase = (owned: string[], gentleRust: boolean): GameStateResponse =>
    ({
      current_round_type: "OperatingRound",
      active_operating_order: [1],
      active_corporation_index: 0,
      macro_round_number: 2,
      sub_round_index: 1,
      variants: { ...STANDARD_VARIANTS, gentleRust },
      private_companies: [],
      player_addresses: ["p1"],
      priority_deal_index: 0,
      active_player_index: 0,
      consecutive_passes: 0,
      public_companies: [{ company_id: 1, ticker: "PRR", owned_trains: owned, is_floated: true }],
    }) as unknown as GameStateResponse;

  it("is still in owned_trains, which is what makes it runnable", () => {
    /* THE HALF #906 NEVER DELIVERED. Its ruling was "exactly one final Operating Round run before
       obsolescence"; its implementation moved the train out of the one array the route planner reads. */
    const after = applyPhaseChange(phase(["3", "6"], true), "6");
    expect(after.public_companies[0].owned_trains).toContain("3");
    expect(after.public_companies[0].pending_rust_trains).toEqual(["3"]);
  });

  it("is destroyed outright when the variant is off", () => {
    /* THE STANDARD RULE, UNCHANGED, and the control that stops the fix leaking into every table. */
    const after = applyPhaseChange(phase(["3", "6"], false), "6");
    expect(after.public_companies[0].owned_trains).not.toContain("3");
    expect(after.public_companies[0].pending_rust_trains ?? []).toEqual([]);
  });

  it("leaves the field absent on a state that never mentioned it", () => {
    /* #232/#897: a phase change that reprieves nothing must not write `pending_rust_trains: []` onto every
       company in the game. An empty answer where the record had none is this codebase inventing one. */
    const after = applyPhaseChange(phase(["5", "6"], true), "6");
    expect(after.public_companies[0].pending_rust_trains).toBeUndefined();
  });

  it("still says a rust happened, even though nothing left the fleet", () => {
    /* ==================================================================
        THE NARRATOR READS A DIFF, AND #979 MOVED WHAT IT WAS DIFFING
       ==================================================================
       `describeFleetLosses` reads back what the reducer did by comparing `owned_trains` before and after.
       Under #979 a gently-rusted train does not leave that array -- so left alone, the rust notice would
       simply STOP APPEARING for the one variant whose entire point is telling the player about it. A
       narrator going quiet because the thing it narrates moved one field over is the exact shape of fault
       this project keeps finding, and it is invisible: no error, no wrong figure, just nothing said. */
    const before = phase(["3", "6"], true);
    const after = applyPhaseChange(before, "6");
    const [loss] = describeFleetLosses(before, after);
    expect(loss.rusted).toEqual(["3"]);
    expect(loss.discarded).toEqual([]);
  });

  it("no longer reports one phase change as both a rust and a discard", () => {
    /* ==================================================================
        DESIGN NOTE 1034: BATCH 37'S FIRST REPORT, ANSWERED BY THE RULE CHANGE
       ==================================================================
       THIS CASE USED TO EXPECT `rusted: ["3"], discarded: ["3"]` and its note explained why that was right:
       "under this variant rust takes nothing -- it only marks -- so anything that actually LEFT the fleet at a
       phase change left because the trim took it."
       THAT WAS AN ACCURATE DESCRIPTION OF A BEHAVIOUR THE PLAYER THEN REPORTED AS A BUG: "the engine currently
       reports the same trains as rusting and being discarded by the train limit." Under #979 it was not a bug
       and I said so -- the marked train counted, it was the cheapest, the trim took it, and both sentences
       were true of the same tier in one event.
       UNDER #1034 IT CANNOT HAPPEN. A marked train is not a candidate for the trim, so no train can appear in
       both lists from one phase change. The complaint is answered by the rule rather than by suppressing a
       message, which is the better kind of fix and was not available before.
       BOTH 3s ARE MARKED AND NOTHING IS DISCARDED: countable is the 6 alone, against phase 6's limit of two. */
    const before = phase(["3", "3", "6"], true);
    const after = applyPhaseChange(before, "6");
    const [loss] = describeFleetLosses(before, after);
    expect(loss.rusted).toEqual(["3", "3"]);
    expect(loss.discarded).toEqual([]);
  });

  it("keeps the standard tier split when the variant is off", () => {
    /* THE CONTROL ON THE BRANCH ABOVE. With no reprieve the split is #704's original: what rusts on the
       arriving tier is rust, and everything else is the limit. */
    const before = phase(["3", "3", "6"], false);
    const after = applyPhaseChange(before, "6");
    const [loss] = describeFleetLosses(before, after);
    expect(loss.rusted).toEqual(["3", "3"]);
    expect(loss.discarded).toEqual([]);
  });
});

describe("the reprieved train reaches the surfaces that count and run it (design note #979)", () => {
  /* SOURCE SCANS, because what is being asserted is which ARRAY a surface reads. `owned_trains` now holds the
     reprieved train, so every one of these is correct by construction -- and that is precisely the claim
     worth pinning, since the way #906 went wrong was by quietly removing the train from all of them at once.
     A future change that re-introduces a parallel list would have to fail here first. */
  const APP = readStripped("App.tsx");

  it("builds the run roster from the whole fleet", () => {
    /* `ownedTrainRoster` IS THE ROUTE PLANNER'S SOURCE. A train missing here has no roster entry, so no route
       draft, so no way to be run -- which is how "one final run" was lost. */
    const roster = sliceBetween(APP, "const ownedTrainRoster = useMemo(", "return owned");
    expect(roster).toContain("?.owned_trains ?? []");
    expect(roster).not.toContain("pending_rust_trains");
  });

  it("asks the shared lock about the same fleet", () => {
    const gate = sliceBetween(APP, "const atTrainLimitNow = useMemo(", "}, [gameState");
    expect(gate).toContain("company?.owned_trains?.length");
    expect(gate).toContain("isTrainLocked(");
  });

  it("shows the same fleet on the corporation card", () => {
    expect(APP).toContain("trains: company.owned_trains ?? [],");
  });
});

describe("the rust modal is two lines (design note #980)", () => {
  const NOTICE = readStripped("utils/fleetLossNotice.ts");
  const MODAL = readStripped("components/FleetLossModal.tsx");

  it("has no variant-only line left in the modal (design note #1003)", () => {
    /* ==================================================================
        THE GENTLE LINE IS GONE, AND SO IS THE CONSEQUENCE SLOT BESIDE IT
       ==================================================================
       #980 PUT A COLOURED SECOND LINE HERE -- "Gentle rust: You can run these trains one more time before
       they retire." -- and these two cases asserted it, its guard and its colour.
       RULED SINCE: the modal fires at DESTRUCTION now (#1002), so a sentence promising a future run would be
       about trains that left the fleet in the dispatch that raised it. The variant still gives the extra run;
       the modal is simply no longer where a player hears about it.
       THREE FUNCTIONS IN THIS FEATURE HAVE NOW OUTLIVED THEIR CALLERS -- `noticeConsequence` (#990),
       `dividendStepsExplanation` (#998) and this one -- and all three were deleted rather than left returning
       null. Asserted as an absence over the modal, because a re-added slot is how the copy comes back.
       THE BODY IS STILL THE BODY, which is the half that must survive a deletion: the modal has one sentence
       and it is the standard one. */
    expect(MODAL).not.toContain("noticeGentleRustLine");
    expect(MODAL).not.toContain("noticeConsequence");
    expect(MODAL).not.toContain("Gentle rust:");
    expect(MODAL).toContain("<p style={styles.body}>{noticeBody(notice)}</p>");
  });

  it("has retired the paragraph and the rule it was still asserting", () => {
    /* AS AN ABSENCE, on a comment-stripped copy (#490a) so #980's own note quoting the old copy cannot
       satisfy the search. The clause that matters most is "no longer counts against the train limit" -- that
       is #906's rule, which #979 has just reversed, so a surviving copy of this paragraph would be telling
       the player a rule the engine no longer follows. */
    expect(NOTICE).not.toContain("no longer counts against the train limit");
    expect(NOTICE).not.toContain("NOT gone yet");
    expect(NOTICE).not.toContain("destroyed with it");
    expect(NOTICE).not.toContain("Run it while you still have it");
  });
});

describe("only the president is stopped (design note #981)", () => {
  const APP = readStripped("App.tsx");
  const memo = sliceBetween(APP, "const dueFleetNotice = useMemo<FleetLossNotice | null>(", "}, [");

  it("compares the corporation's president to the viewer", () => {
    /* REPORTED: "the Rust and Train Limit modals pop up for every player in the room."
       AND THE GATE THAT WAS THERE READS AS IF IT ALREADY SCOPED THIS. `companyId === actingProtocolId` is a
       fact about the GAME, so it is true on every client at once -- six players, six unskippable modals. The
       only viewer-scoped condition in the whole memo was `spectator`, and a seated player who owns nothing is
       not a spectator. */
    expect(memo).toContain("president === viewerAddress");
    expect(memo).toContain("viewerAddress");
  });

  it("still shows it when the viewer cannot be identified", () => {
    /* #232 APPLIED TO THE VIEWER. A client that has not resolved its own address is not a client that has
       been told it is nobody -- and the two directions are not symmetric: showing a notice wrongly costs one
       dismissal, hiding it wrongly loses it for that turn permanently, because the dismiss key is the turn. */
    expect(memo).toContain("president === null || viewerAddress === null");
    expect(memo).toContain("return true;");
  });

  it("keeps the turn and spectator gates it already had", () => {
    /* THE HALF THAT MUST NOT BE LOST IN A NARROWING. A president is still only stopped at their own
       corporation's turn -- #896's whole placement argument -- and a spectator is stopped never. */
    expect(memo).toContain('!== "OperatingRound"');
    expect(memo).toContain("if (spectator) return null;");
    expect(memo).toContain("notice.companyId !== actingProtocolId");
  });

  it("re-reads when the roster or the viewer changes", () => {
    /* THE STALE-MEMO FAILURE, which is invisible: a memo that does not depend on the president would keep
       showing -- or keep hiding -- a modal after a presidency changed hands mid-round. */
    const deps = sliceBetween(APP, "const dueFleetNotice = useMemo<FleetLossNotice | null>(", "]);");
    expect(deps).toContain("gameState?.public_companies,");
    expect(deps).toContain("viewerAddress,");
  });
});
