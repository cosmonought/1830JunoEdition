/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1001-1005 (harness): A LIFECYCLE THAT WAS ONE STEP LATE
// ==================================================================
//
// EVERY ITEM IN THIS BATCH IS THE SAME BUG SEEN FROM A DIFFERENT SURFACE, and that is worth stating before
// the cases: a gently rusted train died at the END of its corporation's turn, and almost everything the
// player was shown about it was calibrated to that moment.
//
//   THE ENGINE charged the corporation a train-limit slot through the whole of Buy Trains and refunded it
//   afterwards, so a corporation at the limit was auto-skipped past the step where it would have replaced
//   the train that just rusted. That is #1001, and it is the only item here that changes a rule.
//
//   THE MODAL fired at the phase change -- eight presidents told about a loss seven of them had not had yet.
//   #1002 moves it to the destruction.
//
//   THE COPY promised a run that, at the new moment, has already happened (#1003).
//
//   THE CHIPS AND BADGES went quiet at the phase change, because they are derived from the DEPOT outlook and
//   the depot had moved on to the next tier (#1004).
//
// SO THE CASES BELOW ARE MOSTLY ABOUT TIMING, which is the hardest thing for this project's harness to hold:
// jsdom renders no animation and drives no room, so what is checkable is WHICH DISPATCH changes state and
// what the surfaces are handed. The reducer half is driven; the render half is a source scan.

import { applyPhaseChange, applySandboxAction, describeReprieveExpiries } from "./sandboxSession";
import { STANDARD_VARIANTS } from "./gameVariants";
import { isTrainLocked } from "./trainLimit";
import { fleetLossNotices, noticeBody } from "./fleetLossNotice";
import type { GameStateResponse } from "./gameState";
import { readStripped, sliceBetween } from "./sourceScan";

const GENTLE = { ...STANDARD_VARIANTS, gentleRust: true };
const APP = readStripped("App.tsx");
const BAR = readStripped("panels/ContextualActionBar.tsx");
const CHIPS = readStripped("components/TrainBadges.tsx");
const ANIM = readStripped("styles/animations.ts");
const STYLES = readStripped("styles/appStyles.ts");
const REDUCER = readStripped("utils/sandboxSession.ts");

/** An Operating Round with one corporation acting, parked on whichever step the case needs. */
const operating = (subPhase: string, over: Partial<GameStateResponse> = {}): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    active_operating_order: [1],
    active_corporation_index: 0,
    sub_round_index: 1,
    macro_round_number: 3,
    operating_sub_phase: subPhase,
    virtual_bank_vgp: "9000",
    variants: GENTLE,
    private_companies: [],
    player_addresses: ["p1"],
    priority_deal_index: 0,
    active_player_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: 1,
        ticker: "PRR",
        owned_trains: ["3", "5"],
        pending_rust_trains: ["3"],
        last_route_revenue: "0",
        is_floated: true,
      },
    ],
    ...over,
  }) as unknown as GameStateResponse;

const declareDividends = (state: GameStateResponse) =>
  applySandboxAction(state, {
    DeclareDividends: { protocol_id: 1, distribute: false, revenue_amount: "0" },
  } as never);

describe("the reprieve ends before Buy Trains, not after it (design note #1001)", () => {
  it("destroys the marked train as the cursor enters Buy Trains", () => {
    /* REPORTED: "the engine incorrectly auto-skips the Buy Trains phase for corporations at the train limit,
       preventing them from replacing the trains that just rusted."
       AND IT IS #979 COLLIDING WITH #906a. #979 made a reprieved train count against the limit -- correctly,
       and that is what lets it run. #906a had already put its death at the END of the turn. Together they
       charge the corporation for the slot at exactly the moment the slot matters and refund it once buying is
       over.
       DRIVEN THROUGH THE REAL MESSAGE, because the whole claim is about WHICH dispatch the state changes on.
       A test that called a helper directly would prove the helper works and nothing about the timing. */
    const after = declareDividends(operating("Dividends"));
    expect(after.operating_sub_phase).toBe("Hardware");
    expect(after.public_companies[0].owned_trains).toEqual(["5"]);
    expect(after.public_companies[0].pending_rust_trains).toEqual([]);
  });

  it("frees the slot in time for the auto-skip to see it", () => {
    /* THE REPORTED SYMPTOM, AS THE PREDICATE THAT CAUSED IT. `isTrainLocked` is what `atTrainLimitNow` asks,
       and the auto-skip fires when it answers true. With a limit of 2 the corporation is locked before the
       expiry and free after -- so the step it was skipped past is now open, which is the whole fix stated in
       one comparison. */
    const before = operating("Dividends");
    expect(isTrainLocked(before.public_companies[0].owned_trains?.length ?? 0, 2)).toBe(true);
    const after = declareDividends(before);
    expect(isTrainLocked(after.public_companies[0].owned_trains?.length ?? 0, 2)).toBe(false);
  });

  it("leaves a corporation with no marks untouched", () => {
    /* THE CONTROL. Every corporation in a standard game passes through this transition on every turn, so an
       expiry that fired unconditionally would quietly delete a train per turn, for everybody. */
    const plain = operating("Dividends", {
      public_companies: [
        { company_id: 1, ticker: "PRR", owned_trains: ["3", "5"], last_route_revenue: "0", is_floated: true },
      ] as never,
    });
    const after = declareDividends(plain);
    expect(after.public_companies[0].owned_trains).toEqual(["3", "5"]);
  });

  it("acts on the corporation that is acting, not the one that just finished", () => {
    /* THE SUBJECT CHANGED WITH THE TIMING, and this is the half most likely to be got wrong. The turn-change
       expiry below reads `before`'s cursor -- the OUTGOING corporation -- because by then the queue has
       moved on. This one fires MID-TURN, so the same expression would name the wrong company: the one whose
       turn ended last round.
       ASSERTED WITH TWO CORPORATIONS MARKED, so a rule that expired the wrong one produces a visibly wrong
       fleet rather than coincidentally the right answer. */
    const two = operating("Dividends", {
      active_operating_order: [1, 2] as never,
      active_corporation_index: 0,
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          owned_trains: ["3", "5"],
          pending_rust_trains: ["3"],
          last_route_revenue: "0",
          is_floated: true,
        },
        {
          company_id: 2,
          ticker: "NYC",
          owned_trains: ["3", "5"],
          pending_rust_trains: ["3"],
          last_route_revenue: "0",
          is_floated: true,
        },
      ] as never,
    });
    const after = declareDividends(two);
    expect(after.public_companies[0].owned_trains).toEqual(["5"]);
    expect(after.public_companies[1].owned_trains).toEqual(["3", "5"]);
    expect(after.public_companies[1].pending_rust_trains).toEqual(["3"]);
  });

  it("keeps the turn-change expiry as a backstop", () => {
    /* TWO TRIGGERS FOR ONE EVENT IS NORMALLY THE FAULT THIS CODEBASE KEEPS FINDING, and this is the case
       where it is not: a turn can end without reaching Buy Trains -- an Operating Round set ending, or any
       path that skips the step -- and a reprieve surviving that hands the train a second run, which is
       #906a's own bug in reverse.
       THEY ARE THE SAME EXPRESSION ON THE SAME HELPER, and the second is idempotent because the first leaves
       nothing to expire. Asserted as the two SUBJECTS rather than as a call count: the whole risk in having
       two triggers is that one of them names the wrong corporation, and a count cannot see that. */
    expect(REDUCER).toContain("expireReprieveFor(after, outgoingCorporation)");
    expect(REDUCER).toContain("expireReprieveFor(after, actingCorporation)");
  });

  it("keys on the arrival at Buy Trains rather than on the message", () => {
    /* `DeclareDividends` IS ONE WAY IN AND `AdvanceOperatingSubPhase` IS THE OTHER -- the Skip button and
       #439's auto-skip both arrive as the latter. A rule written per message would have to name both and
       would miss the third. */
    expect(REDUCER).toContain('const enteringHardware = next === "Hardware" && current !== "Hardware";');
  });
});

describe("the modal waits for the train to actually die (design note #1002)", () => {
  it("reports an expiry as a rust loss", () => {
    /* THE SHELL NARRATES BY DIFFING (#704), and the expiry happens inside the reducer where no caller can see
       it. What is observable afterwards is that the marks emptied and the fleet lost exactly those models. */
    const before = operating("Dividends");
    const after = declareDividends(before);
    const [loss] = describeReprieveExpiries(before, after);
    expect(loss.rusted).toEqual(["3"]);
    expect(loss.discarded).toEqual([]);
  });

  it("says nothing at the phase change that MARKS the trains", () => {
    /* ==================================================================
        THE PROPERTY THAT MAKES THIS A DEFERRAL RATHER THAN A DUPLICATE
       ==================================================================
       When trains are marked, `pending_rust_trains` GROWS and `owned_trains` is untouched (#979); when they
       are destroyed, the marks clear and the fleet shrinks. Requiring both is what stops this function
       reporting the same trains twice -- once when they are doomed and again when they die. */
    const before = operating("Track", {
      public_companies: [
        { company_id: 1, ticker: "PRR", owned_trains: ["3", "6"], last_route_revenue: "0", is_floated: true },
      ] as never,
    });
    const after = applyPhaseChange(before, "6");
    expect(after.public_companies[0].pending_rust_trains).toEqual(["3"]);
    expect(describeReprieveExpiries(before, after)).toEqual([]);
  });

  it("does not call a train the limit took a rust expiry", () => {
    /* A DISPATCH THAT EXPIRED A REPRIEVE AND LOST A TRAIN TO SOMETHING ELSE would otherwise report the second
       as rust. Intersecting the departures with the MARKS keeps this function about the one event it names --
       and the two causes have different modals, different toggles and different remedies (#896). */
    const before = operating("Dividends", {
      public_companies: [
        {
          company_id: 1,
          ticker: "PRR",
          owned_trains: ["3", "5"],
          pending_rust_trains: ["3"],
          last_route_revenue: "0",
          is_floated: true,
        },
      ] as never,
    });
    const [loss] = describeReprieveExpiries(before, declareDividends(before));
    expect(loss.rusted).toEqual(["3"]);
    expect(loss.rusted).not.toContain("5");
  });

  it("suppresses only the RUST notice at the phase change, never the limit one", () => {
    /* A TRAIN THE LIMIT TOOK IS GONE RIGHT NOW -- the trim is not postponed by this variant -- so its notice
       is still due immediately. Suppressing both would lose that one entirely, and #896's split by cause is
       what makes the distinction expressible at all. */
    expect(APP).toContain('if (gentleRustOn && notice.cause === "rust") continue;');
  });

  it("queues the deferred notice when the expiry lands", () => {
    /* THE OTHER END OF THE DEFERRAL, and the half that would leave the feature silent if it were missing:
       suppressing the early modal without queueing the late one removes the warning altogether. */
    const block = sliceBetween(APP, "const expiries = describeReprieveExpiries(before, after);", "if (expiryQueue.length");
    expect(block).toContain("fleetLossNotices(loss, expiryTier, expiryLimit)");
    expect(block).toContain("expiryQueue.push(notice)");
  });

  it("stays idempotent across a replay", () => {
    /* UNDO REBUILDS BY REPLAYING THE LOG, so this block runs again for an expiry the player has already
       acknowledged -- the same hazard #706 records for the phase-change queue beside it, and keyed the same
       way: by CONTENT, so two different expiries both survive and a replay of one adds nothing.
       ==================================================================
        DESIGN NOTE 1032: AND CONTENT ALONE WAS NOT ENOUGH
       ==================================================================
       THIS CASE PASSED THROUGHOUT THE REPORTED BUG, which is why it is rewritten rather than left alone. It
       asked whether the queue was checked before pushing -- true, and irrelevant to the failure: dismissing a
       notice REMOVES it from that queue, so the next replay found no match and re-queued it. The dedupe was
       idempotent against itself and not against the player's own acknowledgement.
       BOTH SOURCES ARE NOW ASSERTED. The `some` walk stays because two expiries in one dispatch still have to
       be told apart; `dismissedFleetNoticesRef` is what makes "already seen" count as already queued. */
    const block = sliceBetween(APP, "const expiries = describeReprieveExpiries(before, after);", "if (expiryQueue.length");
    expect(block).toContain("expiryQueue.some((entry) => noticeDismissKey(entry) === key)");
    expect(block).toContain("dismissedFleetNoticesRef.current.has(key)");
  });

  it("still writes the Activity Log line at the phase change", () => {
    /* #896'S STANDING RULE: deferring or silencing a MODAL changes when a player finds out, never whether the
       game told them. `describeFleetLoss` is untouched and still fires for every corporation at the moment
       the phase turns. */
    expect(APP).toContain("const sentence = describeFleetLoss(loss, limitNow);");
    expect(APP).toContain('if (sentence) logInfo("Phase Change", sentence);');
  });
});

describe("the copy is the standard sentence again (design note #1003)", () => {
  it("says the same thing whatever the table is playing", () => {
    const [rust] = fleetLossNotices(
      { companyId: 1, ticker: "PRR", rusted: ["3"], discarded: [] },
      "6",
      2,
    );
    expect(noticeBody(rust)).toBe("1 of your 3-trains has rusted.");
  });

  it("has no variant branch left in the notice or the modal", () => {
    /* THE FLAG WENT WITH THE SENTENCE. A `gentleRust` field that can only ever be `false` is #788's
       unreachable arm wearing a boolean, and it is how the branch comes back. */
    const NOTICE = readStripped("utils/fleetLossNotice.ts");
    expect(NOTICE).not.toContain("gentleRust");
    expect(NOTICE).not.toContain("noticeGentleRustLine");
    expect(readStripped("components/FleetLossModal.tsx")).not.toContain("Gentle rust");
  });
});

describe("the warning survives the phase change (design note #1004)", () => {
  it("marks a reprieved chip doomed whatever the depot says", () => {
    /* REPORTED: "the red/amber warning badges and flashing train chips immediately disappear for the
       reprieved trains."
       AND THE CAUSE IS THAT THE DEPOT MOVED ON. `inDangerWindow` is derived from the tier NEXT in line to
       rust, so the instant the phase turns, the tier that just rusted stops being at risk and every chip of
       it goes quiet -- correct for the standard game, where those trains no longer exist. */
    expect(CHIPS).toContain("const isFinalRun = reprievedAt >= 0;");
    expect(CHIPS).toContain('const inDangerWindow = isFinalRun\n          ? "doomed"');
  });

  it("consumes the marks as a multiset", () => {
    /* A CORPORATION HOLDING ONE REPRIEVED 3 AND ONE LIVE 3 must show one pulsing chip and one still one. A
       `.includes` pulses both -- the same off-by-one `trimToTrainLimit` records for the trim, on a surface
       where it would tell the player they are about to lose two trains instead of one. */
    expect(CHIPS).toContain("reprievedPool.splice(reprievedAt, 1)");
    expect(CHIPS).not.toContain("reprieved?.includes(model)");
  });

  it("carries the marks from the corporation rather than deriving them", () => {
    /* THE ONE FACT ABOUT THE FLEET THAT CANNOT BE RECOMPUTED IN THE BAR. Everything else the chips show comes
       from the depot; this comes from the corporation, and the depot has already moved past it. */
    expect(APP).toContain("reprievedTrains: company.pending_rust_trains ?? [],");
    expect(BAR).toContain("reprieved={activeCorporation.reprievedTrains}");
  });

  it("keeps a persistent badge while any mark stands", () => {
    /* RULED (#1004): "retain a persistent warning badge reading 'Rust Imminent: [type]-train' for any
       corporation holding gently rusted trains until they are destroyed."
       ONE BADGE PER TIER, NOT PER TRAIN: two reprieved 3-trains are one fact.
       ==================================================================
        DESIGN NOTE 1033: THE LABEL IS SUPERSEDED; THE PERSISTENCE IS NOT
       ==================================================================
       RULED SINCE: "the badge must dynamically update to read 'Final Run: [type]-trains'." The #1004 wording
       is quoted above rather than deleted because it was ruled verbatim too, and the reason it could not
       survive is worth keeping: #1033 gives the PRE-purchase countdown "Rust Imminent:" at one buy away, so
       leaving it here would put identical words on two badges meaning two different things.
       WHAT THIS CASE STILL GUARDS is everything except the string -- that the badge is derived from the
       corporation's own marks and vanishes only when they clear. That was #1004's actual subject. */
    /* `no-template-curly-in-string` RIGHTLY OBJECTS to `${...}` inside a plain string, so the interpolation
       is assembled -- #779's harness uses the same dodge for its dollar sign. What is asserted is the source
       text of a template literal, which is a string to this file. */
    const DOLLAR = String.fromCharCode(36);
    expect(BAR).toContain("Final Run: " + DOLLAR + "{tiers.map(");
    expect(BAR).toContain(DOLLAR + "{tier}-trains");
    expect(BAR).not.toContain("Rust Imminent: " + DOLLAR + "{tiers.map(");
    expect(BAR).toContain("const marks = activeCorporation?.reprievedTrains ?? [];");
    expect(BAR).toContain("if (marks.length === 0) return null;");
  });

  it("gives the chip and the badge one shared animation", () => {
    /* RULED: "Make sure this animation is also applied to the 'Rust Imminent' warning badge so they match."
       ONE CLASS ON TWO SURFACES, which is #755's argument for sharing the countdown pulse in the first place:
       "two hand-tuned pulses at 1.4s and 1.5s would read as a rendering fault rather than as two warnings." */
    expect(CHIPS).toContain('"app-train-final-run"');
    expect(BAR).toContain('className="app-train-final-run"');
    expect(ANIM).toContain(".app-train-final-run {");
  });

  it("fades to a fifth rather than to the countdown's 0.55", () => {
    /* RULED: "fade its opacity from 100% down to 20% in a continuous pulse."
       A SECOND KEYFRAME RATHER THAN A DEEPER SHARED ONE, because the two states are different claims and
       #702's rule is that they stay distinguishable: 0.55 means "one purchase from rusting", 0.2 means
       "already rusted, running once more". A player who has learnt the first would read a deeper version of
       it as the same warning turned up. */
    /* SLICED TO THE NEXT BLOCK, NOT TO THE NEXT `}`. A keyframe body nests braces, so anchoring on `"}"`
       returns only the `0%` rule -- which contains neither figure. `polishWave6` records making exactly this
       mistake on the revenue arrows, and it is worth failing for twice rather than reading as obviously
       right a third time. */
    const pulse = sliceBetween(ANIM, "@keyframes app-final-run-pulse {", ".app-train-final-run {");
    expect(pulse).toContain("opacity: 0.2;");
    const countdown = sliceBetween(ANIM, "@keyframes app-phase-shift-pulse {", "@media");
    expect(countdown).toContain("opacity: 0.55;");
    /* AND THE TWO ARE DIFFERENT KEYFRAMES, which is the property a pair of `toContain`s on one file cannot
       express: a single keyframe deepened to 0.2 would fail the second of these rather than passing both. */
    expect(pulse).not.toContain("opacity: 0.55;");
  });

  it("holds the fade still for reduced motion rather than deleting it", () => {
    /* THE FADE CARRIES "this train is on its last run", which is information rather than decoration -- the
       accommodation is about MOTION (#953's rule for the revenue arrows), so the dimming stays and only the
       breathing stops. `!important` for #970b's reason: the class competes with inline styles. */
    expect(ANIM).toContain(".app-train-final-run { animation: none !important; opacity: 0.65; }");
  });
});

describe("the warning badges keep to one line (design note #1005)", () => {
  it("groups them in a nowrap container", () => {
    /* REPORTED: "The Warning badges on certain Action Bar subphases are spilling into a second row."
       AND THE BADGES WERE NEVER THE THING WRAPPING -- `phaseShiftBadge` has carried `whiteSpace: nowrap` and
       `flexShrink: 0` all along. What wraps is the rail. */
    const group = sliceBetween(STYLES, "orWarningGroup: {", "},");
    expect(group).toContain('flexWrap: "nowrap"');
    expect(group).toContain('flexShrink: 0');
    expect(BAR).toContain("<span style={styles.orWarningGroup}>");
  });

  it("leaves the rail free to wrap", () => {
    /* THE NARROW FIX, AND WHY IT IS NARROW. #482 records that this rail holds a phase badge, a round label
       and a variable number of warnings in a column that must yield rather than drag the centre rail
       sideways. Forbidding it to wrap at all trades a second row of badges for a rail that overflows its own
       track; grouping means the badges wrap TOGETHER and never against each other. */
    const rail = sliceBetween(STYLES, "orPanelRailLeft: {", "},");
    expect(rail).toContain('flexWrap: "wrap"');
    expect(rail).toContain("minWidth: 0");
  });

  it("keeps both kinds of badge inside the group", () => {
    /* THE REPRIEVE BADGE AND THE COUNTDOWN BADGES ARE THE SAME KIND OF OBJECT to a reader, so one outside the
       group would be the second row back for the one case that matters most -- a corporation both holding a
       reprieve and approaching the next rust. */
    const group = sliceBetween(BAR, "<span style={styles.orWarningGroup}>", "</span>\n            </div>");
    expect(group).toContain("reprieveWarning &&");
    expect(group).toContain("buyWarnings.map");
  });
});
