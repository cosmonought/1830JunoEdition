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

describe("the trim takes the reprieved trains first (design note #979)", () => {
  it("leaves a fleet under the limit alone", () => {
    /* THE CONTROL ON EVERY CASE BELOW. A trim that fired unconditionally would satisfy most of them by
       accident, and the common case at a phase change is a corporation that is already legal. */
    const result = trimToTrainLimit({ owned: ["3", "5"], reprieved: ["3"], limit: 3, cost });
    expect(result.owned).toEqual(["3", "5"]);
    expect(result.reprieved).toEqual(["3"]);
    expect(result.discarded).toEqual([]);
  });

  it("counts the reprieved trains toward the limit", () => {
    /* THE RULING ITSELF. Three trains against a limit of two is over by one however many of them are marked
       -- which under #906 was not true, because two of these would not have been in the array at all. */
    const result = trimToTrainLimit({ owned: ["3", "3", "5"], reprieved: ["3", "3"], limit: 2, cost });
    expect(result.owned).toHaveLength(2);
    expect(result.discarded).toHaveLength(1);
  });

  it("discards a reprieved train before a cheaper live one", () => {
    /* THE ORDERING, WITH THE TWO RULES IN CONFLICT so the case can tell which won. The reprieved train here
       is the EXPENSIVE one, so a plain cheapest-first trim would keep it and scrap the live 2 -- leaving the
       corporation a train that dies at the end of this turn instead of one that runs all game.
       "which will typically be the gently rusted train" is the ruling's own expectation, and this is the
       fixture where "typically" and "cheapest" disagree. */
    const result = trimToTrainLimit({ owned: ["2", "5"], reprieved: ["5"], limit: 1, cost });
    expect(result.owned).toEqual(["2"]);
    expect(result.discarded).toEqual(["5"]);
    expect(result.reprieved).toEqual([]);
  });

  it("falls back to cheapest-first among the live trains", () => {
    /* #284'S RULE, STILL IN FORCE under the reprieved ones. Reprieved-first is an ORDERING, not a rule that
       only marked trains may go: when the marks run out the trim keeps taking, and it takes the cheapest. */
    const result = trimToTrainLimit({ owned: ["3", "4", "5", "6"], reprieved: ["3"], limit: 2, cost });
    expect(result.owned).toEqual(["5", "6"]);
    expect(result.discarded).toEqual(["3", "4"]);
  });

  it("marks one train per mark, not every train of that model", () => {
    /* THE MULTISET RULE. A corporation holding one reprieved 3 and one live 3 must lose exactly one of them,
       and the survivor must no longer be marked. */
    const result = trimToTrainLimit({ owned: ["3", "3", "6"], reprieved: ["3"], limit: 2, cost });
    expect(result.owned).toEqual(["3", "6"]);
    expect(result.discarded).toEqual(["3"]);
    expect(result.reprieved).toEqual([]);
  });

  it("keeps the unmarked twin when two trains must go", () => {
    /* ==================================================================
        ADDED BECAUSE THE CASE ABOVE COULD NOT SEE THE BUG IT WAS NAMED FOR
       ==================================================================
       A CONTROL THAT STOPPED DECREMENTING THE MARK COUNT -- treating every train of a reprieved model as
       reprieved, the `Set` mistake this rule exists to avoid -- PASSED the case above. With only ONE train
       over the limit the two implementations agree by construction: the first 3 is discarded either way, and
       nothing downstream distinguishes them.
       IT TAKES TWO DEPARTURES TO SEPARATE THEM. Here the correct trim takes the marked 3 and then the
       cheapest LIVE train -- the 2 -- leaving the unmarked 3, which runs for the rest of the game. The
       set-based version treats both 3s as marked, takes them both, and leaves the corporation the 2: a
       strictly worse fleet, arrived at by an off-by-one in a lookup, with nothing on screen to explain it.
       RECORDED because "assert the multiset" reads as obviously covered by the case above, and was not. */
    const result = trimToTrainLimit({ owned: ["3", "3", "2"], reprieved: ["3"], limit: 1, cost });
    expect(result.owned).toEqual(["3"]);
    expect(result.discarded).toEqual(["3", "2"]);
  });

  it("takes the mark away with the train it belonged to", () => {
    /* THE SILENT CORRUPTION THIS PREVENTS, and it is worse than a stale field. The reprieve expires by
       multiset removal from `owned_trains`, so a mark left behind for a train the trim already took would,
       at the end of the turn, remove a DIFFERENT train of that model -- a live one, scrapped for a mark that
       belonged to a train discarded two steps earlier, with nothing on screen to explain it. */
    const result = trimToTrainLimit({ owned: ["3", "3", "3"], reprieved: ["3", "3"], limit: 2, cost });
    expect(result.reprieved).toHaveLength(1);
    expect(result.owned).toHaveLength(2);
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

  it("calls a train the limit took a limit loss, not a rust one", () => {
    /* UNDER THIS VARIANT RUST TAKES NOTHING -- it only marks -- so anything that actually LEFT the fleet at a
       phase change left because the trim took it. That is also the more useful thing to tell the player,
       whose question is why the train they were just promised a grace run for is already gone. */
    const before = phase(["3", "3", "6"], true);
    const after = applyPhaseChange(before, "6");
    const [loss] = describeFleetLosses(before, after);
    expect(loss.rusted).toEqual(["3"]);
    expect(loss.discarded).toEqual(["3"]);
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

  it("renders the gentle line and skips an absent consequence", () => {
    /* BOTH CONDITIONALS MATTER AND THEY FAIL DIFFERENTLY. Without the first, the coloured line is computed
       and never shown -- the integration gap this project keeps finding. Without the second, a rust notice
       renders an empty `<p>`, which still occupies its margins and reads as a sentence that failed to load. */
    expect(MODAL).toContain("noticeGentleRustLine(notice) && (");
    expect(MODAL).toContain("noticeConsequence(notice) && (");
  });

  it("colours the gentle line rather than the body", () => {
    /* RULED: "keep the colored text". The body is the neutral sentence everyone gets; the variant's line is
       the one that was amber before and stays amber. */
    const block = sliceBetween(MODAL, "noticeGentleRustLine(notice) && (", ")}");
    expect(block).toContain("styles.consequence");
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
