/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1032 (harness): THE SAME EVENT, ANNOUNCED FOREVER
// ==================================================================
//
// REPORTED, from a Gentle Rust playthrough: "Rust and Train Limit modals kept firing at the start of basically
// every operating round, listing trains and quantities that didn't always make sense (e.g., multiple times I
// received a modal that multiple trains had been discarded due to the train limit, even though the train limit
// had only changed once)."
//
// TWO FAULTS, AND NEITHER IS AN ARITHMETIC ONE. The counts were right every time; what was wrong is that one
// event's notice was re-raised every round, and that a train already under sentence could be sentenced again.
//
// WHAT THIS BATCH DID **NOT** DO IS AS IMPORTANT. The report as relayed asked for "Train Limit Evaluation
// Exclusion" -- reprieved trains excluded from the limit -- and the player corrected that on being asked:
// "Gently rusted trains DO count to the corporation's limit", and a reprieved train being taken first by the
// trim is correct, "since the gently rusting trains are by definition the cheapest trains". #979 therefore
// STANDS, unreversed, and the first case below is the control that keeps it standing.

export {};

const { applyPhaseChange, describeFleetLosses } =
  require("./sandboxSession") as typeof import("./sandboxSession");
const { trimToTrainLimit } = require("./trainLimit") as typeof import("./trainLimit");
const { noticeDismissKey, nextDueNotice, fleetLossNotices } =
  require("./fleetLossNotice") as typeof import("./fleetLossNotice");
const { STANDARD_VARIANTS } = require("./gameVariants") as typeof import("./gameVariants");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const GENTLE = { ...STANDARD_VARIANTS, gentleRust: true };
const cost = (model: string) => ({ "2": 80, "3": 180, "4": 300, "5": 450, "6": 630 })[model] ?? 0;

const state = (owned: string[], reprieved?: string[]): any => ({
  variants: GENTLE,
  public_companies: [
    {
      company_id: 1,
      ticker: "PRR",
      owned_trains: [...owned],
      ...(reprieved ? { pending_rust_trains: [...reprieved] } : {}),
    },
  ],
});
const fleet = (s: any) => s.public_companies[0];

/* ------------------------------------------------------------------ */
/* The rule that was NOT changed                                      */
/* ------------------------------------------------------------------ */

describe("a reprieved train occupies no limit slot (design note #1034, superseding #979)", () => {
  /* ==================================================================
      THESE TWO CASES ASSERTED THE OPPOSITE, AND THE REVERSAL WAS DELIBERATE
     ==================================================================
     THEY WERE WRITTEN AS GUARDS AGAINST EXACTLY THIS EDIT. Batch 37's relayed report asked for the exemption,
     the player corrected it ("Gently rusted trains DO count to the corporation's limit"), and I put these
     here so that a later fix could not quietly undo a ruling. The guard did its job: the rule changed by an
     explicit decision with a citation rather than by drift.
     RULED SINCE: "1846 officially implements the 'delayed obsolescence' rule, and in that version when trains
     gently rust, they stop counting to the train limit ... I am inclined to implement the 1846 rule."
     WHAT THEY GUARD NOW IS THE SAME THING FROM THE OTHER SIDE. #1034's mechanism is a subtraction every
     counting site performs; the failure mode is a partial conversion where one site still counts the roster.
     So both cases stay, inverted, rather than being deleted as obsolete. */

  it("does not count marked trains toward the limit", () => {
    /* THE RULE. Two marked 2-trains and a live 5 against a limit of 2 is ONE countable train -- under the
       limit -- so nothing is discarded at all. Under #979 this fleet lost a train. */
    const result = trimToTrainLimit({ owned: ["2", "2", "5"], reprieved: ["2", "2"], limit: 2, cost });
    expect(result.owned).toEqual(["2", "2", "5"]);
    expect(result.discarded).toEqual([]);
  });

  it("no longer takes the marked train before a cheaper live one", () => {
    /* THE FIXTURE WHERE THE TWO RULES DISAGREE MOST LOUDLY, kept for that reason. A reprieved 5 and a live 2
       against a limit of 1: #979 discarded the 5 ("worth exactly one more run"), which was coherent while it
       occupied a slot. It does not, so discarding it frees nothing and the live 2 is the only countable
       train -- already legal. Nothing goes. */
    const result = trimToTrainLimit({ owned: ["2", "5"], reprieved: ["5"], limit: 1, cost });
    expect(result.owned).toEqual(["2", "5"]);
    expect(result.discarded).toEqual([]);
  });

  it("still trims when the LIVE trains alone exceed the limit", () => {
    /* #284'S RULE, UNTOUCHED, and the control that stops the exemption becoming "the limit never applies".
       Three live trains against a limit of 2 loses the cheapest, exactly as it always did -- and the marked
       train beside them is neither counted nor taken. */
    const result = trimToTrainLimit({
      owned: ["2", "3", "4", "5"],
      reprieved: ["2"],
      limit: 2,
      cost,
    });
    expect(result.discarded).toEqual(["3"]);
    expect(result.owned).toEqual(["2", "4", "5"]);
    expect(result.reprieved).toEqual(["2"]);
  });
});

/* ------------------------------------------------------------------ */
/* Fault 1 -- the sentence served twice                               */
/* ------------------------------------------------------------------ */

describe("a train already under sentence is not sentenced again", () => {
  it("does not re-mark a train that is already reprieved", () => {
    /* THE REPRODUCTION. Two 2-trains, both already marked, met by `applyPhaseChange("4")` again: the mark
       list doubled to four entries for two trains. `describeFleetLosses` diffs that list to find the rust
       event, so the surplus was reported as a fresh rust -- "quantities that didn't always make sense". */
    const before = state(["2", "2"], ["2", "2"]);
    const after = applyPhaseChange(before, "4");
    expect(fleet(after).pending_rust_trains).toEqual(["2", "2"]);
  });

  it("reports no new rust when nothing new was doomed", () => {
    /* THE SAME FAULT SEEN FROM THE NARRATOR, which is where the player met it. A diff over a doubled list
       yields entries that never happened. */
    const before = state(["2", "2"], ["2", "2"]);
    expect(describeFleetLosses(before, applyPhaseChange(before, "4"))).toEqual([]);
  });

  it("still marks a train that is genuinely newly doomed", () => {
    /* THE CONTROL. A filter that excluded too much would silence the variant altogether, and this is the
       case that separates "already marked" from "not marked": one 2 is under sentence, the other is not. */
    const before = state(["2", "2"], ["2"]);
    const after = applyPhaseChange(before, "4");
    expect(fleet(after).pending_rust_trains).toEqual(["2", "2"]);
    expect(describeFleetLosses(before, after)[0].rusted).toEqual(["2"]);
  });

  it("marks a different tier while leaving the standing marks alone", () => {
    /* THE MIXED CASE, which is the ordinary one in play: a corporation carrying reprieved 2-trains when the
       6 arrives and dooms its 3. The 3 is new, the 2s are not, and only the 3 is a rust event. */
    const before = state(["2", "3", "5"], ["2"]);
    const after = applyPhaseChange(before, "6");
    expect(describeFleetLosses(before, after)[0].rusted).toEqual(["3"]);
  });
});

/* ------------------------------------------------------------------ */
/* Fault 2 -- the dismissal that expired with the turn                */
/* ------------------------------------------------------------------ */

describe("a dismissed notice stays dismissed into the next round", () => {
  const [rust] = fleetLossNotices(
    { companyId: 1, ticker: "PRR", rusted: ["2"], discarded: [] },
    "4",
    3,
  );

  it("keys the dismissal on the event rather than the showing", () => {
    /* THE BUG, STATED AS THE PROPERTY THAT WAS MISSING. The key was `turnGuardKey(turn, company, cause)`, so
       the same event acquired a new key every operating round: dismissed in OR 6.2, unrecognised in OR 7.1,
       re-queued by the replay, shown again. The key takes one argument now and there is no turn in it. */
    expect(noticeDismissKey(rust)).toBe("1:rust:4:2");
  });

  it("suppresses the notice once it has been answered", () => {
    expect(nextDueNotice([rust], () => false, new Set([noticeDismissKey(rust)]))).toBeNull();
  });

  it("does not suppress a different phase change's notice", () => {
    /* THE CONTROL THAT STOPS THE FIX BECOMING A NEW BUG. A key coarse enough to survive the round must still
       be fine enough to tell two events apart, or dismissing the first rust would silence every later one. */
    const [later] = fleetLossNotices(
      { companyId: 1, ticker: "PRR", rusted: ["3"], discarded: [] },
      "6",
      2,
    );
    expect(nextDueNotice([later], () => false, new Set([noticeDismissKey(rust)]))).toBe(later);
  });

  it("does not let silencing stand in for having been seen", () => {
    /* #896'S DISTINCTION, RE-ASSERTED because this batch rewrote the function that enforces it. A notice
       skipped for being silenced was never dismissed, so switching the toggle back off raises it again. */
    expect(nextDueNotice([rust], (n) => n.cause === "rust", new Set())).toBeNull();
    expect(nextDueNotice([rust], () => false, new Set())).toBe(rust);
  });
});

describe("the shell refuses to re-queue what the player already answered", () => {
  it("consults the dismissed set at the phase-change queue", () => {
    /* WHERE THE LOOP CLOSED. Keying the dismissal correctly is only half: the replay re-derives the notice
       and pushes it onto an empty queue, so the queue itself has to ask whether this event was already
       acknowledged. Without this the modal still returns, wearing a key that now matches nothing. */
    const block = sliceBetween(APP, "for (const notice of fleetLossNotices(loss, arrivingTier, limitNow)) {", "if (queuedNotices.length");
    expect(block).toContain("dismissedFleetNoticesRef.current.has(key)");
    expect(block).toContain("const key = noticeDismissKey(notice);");
  });

  it("consults it at the expiry queue too", () => {
    /* THE SIBLING CALL SITE. Two queues, one rule -- and fixing one of two identical call sites is the
       half-fix this codebase keeps producing (#897's words, three features over). */
    const block = sliceBetween(APP, "const expiries = describeReprieveExpiries(before, after);", "if (expiryQueue.length");
    expect(block).toContain("dismissedFleetNoticesRef.current.has(key)");
  });

  it("no longer builds the key inline at either site", () => {
    /* THE ROOT OF THE DISAGREEMENT. The queue spelled the content key out by hand while the dismissal used
       `turnGuardKey`, so the two "same notice" rules were written separately and drifted. One function now
       answers both, and an inline rebuild here is what would let them drift again. */
    /* ASSEMBLED, because `no-template-curly-in-string` objects to a literal `${...}` -- #1007's dodge, and
       the leading `$` is a text character the interpolation does not supply (#1031 lost a run to that). */
    const D = String.fromCharCode(36);
    expect(APP).not.toContain(`const key = \`${D}{notice.companyId}:${D}{notice.cause}`);
  });

  it("still defers the rust modal under the variant", () => {
    /* #1002 SURVIVES UNTOUCHED. The rust notice waits for the trains to actually die; only the limit notice
       is due at the phase change. A batch about WHEN notices repeat must not disturb when they first fire. */
    expect(APP).toContain('if (gentleRustOn && notice.cause === "rust") continue;');
  });
});
