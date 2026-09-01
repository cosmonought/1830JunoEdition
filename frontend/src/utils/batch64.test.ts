/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1099-1103 (harness): ONE EVENT, TWO NARRATORS, AND THEY DISAGREED
// ==================================================================
//
// REPORTED, playtesting Gentle Rust: three reprieved 2-trains finished their last run, and the player got the
// Rust modal (right) AND a Train Limit modal about the same three trains (wrong -- the limit took nothing).
//
// THE CAUSE IS A SENTENCE THAT OUTLIVED ITS PREMISE, which is this project's third recurring shape and is
// named as such in its own notes. `describeFleetLosses` reasoned: "under this variant every departure is the
// limit's. Rust only marks, so a doomed train that left the fleet in the same phase change left because the
// trim took it." Every clause of that is true AT A PHASE CHANGE, where #979 stops rust removing anything.
// At a REPRIEVE EXPIRY -- the one moment under this variant when rust does empty `owned_trains` -- it is
// false, and `describeReprieveExpiries` two hundred lines down was already saying so.
//
// SO THE FIX IS A SHARED ANSWER, NOT A SECOND CONDITION. Both narrators now ask `expiredReprieves`. A
// condition bolted onto the second one would have been a second implementation of the same question, which is
// how they came to disagree in the first place (#891).
//
// THE OTHER THREE ITEMS ARE SMALLER AND ARE HERE BECAUSE THEY TOUCH THE SAME SENTENCES: the counts are
// spelled out, the expiry moved one step earlier, and the Pay button says when it is also ending the turn.

export {};

const {
  applyPhaseChange,
  describeFleetLosses,
  describeReprieveExpiries,
  expiredReprieves,
} = require("./sandboxSession") as typeof import("./sandboxSession");
const { noticeHeadline, noticeBody, fleetLossNotices } =
  require("./fleetLossNotice") as typeof import("./fleetLossNotice");
const { spellCount, capitalise, namedTrains, countedTrains } =
  require("./trainPhrasing") as typeof import("./trainPhrasing");
const { readStripped, sliceBetween, anchorIndex } =
  require("./sourceScan") as typeof import("./sourceScan");
import type { GameStateResponse, PublicCompanyState } from "./gameState";

const SESSION = readStripped("utils/sandboxSession.ts");
const NOTICE = readStripped("utils/fleetLossNotice.ts");
const PANEL = readStripped("components/TrainPurchasePanel.tsx");
const APP = readStripped("App.tsx");
const SFX = readStripped("utils/variantSfx.ts");

const CO = 3;
const company = (over: Partial<PublicCompanyState> = {}): PublicCompanyState =>
  ({
    company_id: CO,
    ticker: "B&O",
    president: "p1",
    treasury: "500",
    owned_trains: [],
    player_holdings: [],
    ...over,
  }) as PublicCompanyState;
const board = (
  companies: PublicCompanyState[],
  gentleRust = true,
): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: 4,
    sub_round_index: 1,
    player_addresses: ["p1"],
    active_player_index: 0,
    public_companies: companies,
    private_companies: [],
    variants: { gentleRust },
  }) as unknown as GameStateResponse;

/* ------------------------------------------------------------------ */
/* 3: the phantom Train Limit modal                                    */
/* ------------------------------------------------------------------ */

describe("a reprieve running out is a rust and nothing else", () => {
  /* The reported transition: three marked 2-trains, their grace run over, the marks cleared and the fleet
     three trains lighter. Nothing about the train limit changed. */
  const before = board([
    company({ owned_trains: ["2", "2", "2", "4"], pending_rust_trains: ["2", "2", "2"] }),
  ]);
  const after = board([company({ owned_trains: ["4"], pending_rust_trains: [] })]);

  it("reports the rust", () => {
    const [loss] = describeReprieveExpiries(before, after);
    expect(loss.rusted).toEqual(["2", "2", "2"]);
    expect(loss.discarded).toEqual([]);
  });

  it("no longer reports a discard for the same three trains", () => {
    /* THE BUG, AS AN ASSERTION. Before this, `describeFleetLosses` saw three models leave `owned_trains` and
       -- under Gentle Rust, where its own note says every departure is the trim's -- called all three a
       discard. The player was told twice about one event, once wrongly. */
    expect(describeFleetLosses(before, after)).toEqual([]);
  });

  it("still reports a discard that really was one", () => {
    /* THE CONTROL, and the case that makes the fix a subtraction rather than a mute. A corporation that loses
       a MARKED 2-train to rust and an UNMARKED 3-train to the trim in the same dispatch must get both
       sentences -- which is why the expired models are removed from `lost` by multiset rather than the whole
       branch being skipped when any expiry is present. */
    const mixedBefore = board([
      company({ owned_trains: ["2", "3", "4"], pending_rust_trains: ["2"] }),
    ]);
    const mixedAfter = board([company({ owned_trains: ["4"], pending_rust_trains: [] })]);
    const [loss] = describeFleetLosses(mixedBefore, mixedAfter);
    expect(loss.discarded).toEqual(["3"]);
    expect(loss.rusted).toEqual([]);
    expect(describeReprieveExpiries(mixedBefore, mixedAfter)[0].rusted).toEqual(["2"]);
  });

  it("leaves the standard game's split alone", () => {
    /* THE VARIANT IS THE ONLY THING THAT CHANGED. Without Gentle Rust, rust removes trains at the phase change
       and the tier table decides which departures were rust and which were the trim -- untouched here. */
    const plainBefore = board([company({ owned_trains: ["2", "3"] })], false);
    const plainAfter = board([company({ owned_trains: [] })], false);
    expect(describeFleetLosses(plainBefore, plainAfter)).toHaveLength(1);
  });

  it("asks one function rather than deriving the answer twice", () => {
    /* THE SHAPE OF THE FIX. Two narrators disagreeing about one event is #891, and a condition written into
       the second narrator would have been a second implementation of the first's question. */
    expect(SESSION).toContain("export function expiredReprieves(");
    expect(SESSION.split("expiredReprieves(").length - 1).toBeGreaterThanOrEqual(3);
    expect(expiredReprieves(before.public_companies[0], after.public_companies[0])).toEqual([
      "2",
      "2",
      "2",
    ]);
  });

  it("expires nothing when the marks are still standing", () => {
    /* BOTH SIDES REQUIRED, which is what stops this firing at the phase change that does the marking: there
       the marks GROW and the fleet is untouched. */
    const marking = board([company({ owned_trains: ["2"], pending_rust_trains: ["2"] })]);
    expect(expiredReprieves(before.public_companies[0], marking.public_companies[0])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Timing: the reprieve ends when the run does                         */
/* ------------------------------------------------------------------ */

describe("the grace run ends at Dividends, not at Buy Trains", () => {
  it("expires on the way into Dividends", () => {
    /* REPORTED: "the Rust modal is firing after a player finishes the Dividends phase ... really it should
       happen at the beginning of the Dividends subphase / end of Run Routes."
       AND THE RULE AGREES: "you can run these trains one more time before they retire", so the reprieve is
       spent when the run is over. Hardware was the first place anybody looked for "later"; it was never the
       rule, and it put a blocking modal on top of the dividend animation. */
    expect(SESSION).toContain('const enteringDividends = next === "Dividends" && current !== "Dividends";');
    expect(SESSION).not.toContain('const enteringHardware =');
  });

  it("keeps the turn-change backstop", () => {
    /* A TURN CAN END WITHOUT REACHING DIVIDENDS -- an Operating Round set ending, or a path that skips the
       step -- and a reprieve that survived that would hand the train a second run. Two triggers for one
       event is normally the fault this codebase finds; here the second is idempotent because the first
       leaves nothing to expire.
       ==================================================================
        COUNTED, AND THE COUNT WAS WRONG
       ==================================================================
       THE FIRST DRAFT ASSERTED `>= 4` OCCURRENCES and got 3: the declaration reads `const expireReprieveFor =
       (`, which does not contain the string being counted, so only the three CALL SITES matched. A count was
       the wrong instrument anyway -- `batch28` already asserts this properly and says why: "the whole risk in
       having two triggers is that one of them names the wrong corporation, and a count cannot see that."
       SO THE SUBJECTS ARE NAMED, which is both correct and the stronger claim. */
    expect(SESSION).toContain("expireReprieveFor(after, outgoingCorporation)");
    expect(SESSION).toContain("expireReprieveFor(after, actingCorporation)");
  });
});

/* ------------------------------------------------------------------ */
/* 3a: numerals name tiers, words count trains                         */
/* ------------------------------------------------------------------ */

describe("train quantities are spelled out", () => {
  it("says what the ruling asked for, on both lines of the modal", () => {
    /* RULED: "B&O lost three trains to rust. Three of your 2-Trains have rusted." */
    const [notice] = fleetLossNotices(
      { companyId: CO, ticker: "B&O", rusted: ["2", "2", "2"], discarded: [] },
      "4",
      3,
    );
    expect(noticeHeadline(notice)).toBe("B&O lost three trains to rust");
    expect(noticeBody(notice)).toBe("Three of your 2-trains have rusted.");
  });

  it("collapses identical models instead of listing them", () => {
    /* THE OTHER HALF OF THE SAME RULING, from the reported text: the limit modal said "B&O's 2-train,
       2-train and 2-train are returned to the depot" -- one thing named three times where a player counts. */
    expect(namedTrains(["2", "2", "2"])).toBe("three 2-trains");
    expect(namedTrains(["2"])).toBe("2-train");
    // A MIXED FLEET KEEPS THE LIST, because there the names are the information.
    expect(namedTrains(["2", "3"])).toBe("2-train and 3-train");
    expect(namedTrains(["2", "3", "4"])).toBe("2-train, 3-train and 4-train");
  });

  it("keeps numerals for the tier, which is the whole point", () => {
    /* EVERY TRAIN IS NAMED BY A NUMERAL, so a sentence that also counts in numerals puts two unrelated
       numbers side by side. Asserted as the absence of a bare digit before the word "trains". */
    expect(countedTrains(3)).toBe("three trains");
    expect(countedTrains(1)).toBe("one train");
    expect(namedTrains(["2", "2"])).toContain("2-trains");
    expect(namedTrains(["2", "2"])).not.toMatch(/^\d/);
  });

  it("falls back to numerals past any fleet this game can hold", () => {
    /* SPELLED THROUGH TWELVE and numeric beyond -- a fleet that large is not reachable in 1830, and inventing
       prose for it would be writing for a case the rules exclude. */
    expect(spellCount(12)).toBe("twelve");
    expect(spellCount(13)).toBe("13");
    expect(capitalise(spellCount(3))).toBe("Three");
  });

  it("has one home, so a rule change reaches both surfaces", () => {
    /* THE SECOND COPY IS GONE. `fleetLossNotice` held its own `namedTrains` with a note saying "if a third
       caller ever wants it, that is the moment to lift it out" -- and the trigger was not a third caller but
       this ruling, which had to reach both at once or the Activity Log and the modal would describe one loss
       two ways. */
    expect(NOTICE).not.toContain("function namedTrains");
    expect(NOTICE).toContain('from "./trainPhrasing"');
    expect(SESSION).toContain('from "./trainPhrasing"');
  });
});

/* ------------------------------------------------------------------ */
/* 1: the Pay button says why the turn ended                           */
/* ------------------------------------------------------------------ */

describe("the Pay button warns that this buy ends the turn", () => {
  it("appends the clause only when both facts hold", () => {
    /* RULED: "when corporations are buying up to their train limit, the Pay button needs to say 'Pay $x and
       End Turn' so they know why they finished."
       BOTH CONDITIONS, because either alone lies: a buy that fills the limit on a step that is not last ends
       nothing, and a last step reached without filling the limit is not this. */
    expect(PANEL).toContain('fillsTrainLimit && endsTurnAtLimit ? " and End Turn" : ""');
    /* Design note #1104: ANCHORED ON THE NAMED LABEL, not on the expression's shape. My first draft pinned
       the multi-line ternary including its indentation -- the same mistake that broke `quantityOptions` and
       `stepJumpButton` when this third arm was added, made a third time in the file written to cover the
       change that broke them. An anchor that includes whitespace is an assertion about the formatter. */
    expect(PANEL).toContain("const payButtonLabel = atTrainLimit");
    expect(PANEL).toContain('? "Train Limit Reached"');
  });

  it("measures the limit with the same walk the quantity selector uses", () => {
    /* NOT A SUBTRACTION. `limitHeadroom` is `buyableNow`'s phase-aware walk (#296) -- with a phase change in
       the middle, `currentLimit - owned` overcounts, and a button that promised the ending on a purchase
       which did not reach the limit would be the reconciliation failure #247 exists to prevent. */
    expect(PANEL).toContain("quantity >= limitHeadroom");
    expect(PANEL).not.toContain("currentTrainLimit - ownedTrainCount");
  });

  it("asks the shell whether the turn actually ends", () => {
    /* #876's QUESTION, AND IT IS ABOUT THE STEP LIST: skipping the LAST step ends the turn, and `stepsFor`
       varies -- it drops `BuyPrivate` once the last private is bought. The panel would have to hardcode
       "Hardware is last" and go quietly wrong the day it is not, so the shell answers with the same function
       the auto-skip consults. */
    expect(APP).toContain('endsTurnAtLimit: autoSkipExit("Hardware", stepsFor(gameState)) === "end-turn"');
    expect(PANEL).toContain("endsTurnAtLimit = false");
  });
});

/* ------------------------------------------------------------------ */
/* The accounting: two modals, never the same train twice              */
/* ------------------------------------------------------------------ */

describe("a corporation that both rusts and overflows is told once about each train", () => {
  /* ==================================================================
      THE WORRY, AND WHY IT IS WELL FOUNDED
     ==================================================================
     REPORTED: "an unknowing player might think they've lost more trains than they had ... a player who is
     over the train limit AND has at least one train that rusted."
     THE CASE IS REAL AND REACHABLE. At the train limit in Phase 3 with a 2-train in the fleet, buying the
     first 4-train rusts the 2 AND drops the limit to three, so the trim then takes a 3 as well. Two modals,
     one dispatch.
     WHAT MAKES IT SAFE IS THE ORDER IN THE REDUCER, which is exactly the order the report describes: rust
     removes its trains first, and `trimToTrainLimit` is handed `fleetAfterRust` -- so the limit is measured
     against what is left, and a train the rust already took cannot also be trimmed.
     AND THE NARRATOR PARTITIONS RATHER THAN COUNTING TWICE: `describeFleetLosses` builds ONE multiset of
     departures and assigns each model to `rusted` or `discarded` by the tier table. A model cannot land in
     both, because it is moved out of the list when it lands in either. */
  const fleet = (trains: string[]) =>
    board([company({ owned_trains: trains })], false);

  it("names the rusted train and the trimmed train separately", () => {
    /* THE REPORTED SHAPE: 2,3,3,3 at the limit, buys the 4 itself. The 2 rusts; the fleet is still over the
       new limit of three, so a 3 goes as well. Two losses, two causes, two trains. */
    const before = fleet(["2", "3", "3", "3"]);
    const after = applyPhaseChange(fleet(["2", "3", "3", "3", "4"]), "4");
    const [loss] = describeFleetLosses(before, after);
    expect(loss.rusted).toEqual(["2"]);
    expect(loss.discarded).toEqual(["3"]);
  });

  it("never names one train under both causes", () => {
    /* THE PROPERTY, ASSERTED ACROSS EVERY SHAPE THIS CAN TAKE rather than on the one that was reported --
       what the player must never see is a total that exceeds what actually left the fleet. Each case checks
       that the two notices, taken together, name exactly the departures and no more. */
    for (const owned of [
      ["2", "3", "3", "3"], // rusts AND overflows -- the reported case
      ["2", "2", "3"], //      rust alone brings it under the new limit
      ["3", "3", "3", "3"], // overflows with nothing rusting
      ["2"], //               one train, and it rusts
    ]) {
      const before = fleet(owned);
      const after = applyPhaseChange(fleet([...owned, "4"]), "4");
      const [loss] = describeFleetLosses(before, after);
      if (!loss) continue;
      const survivors = [...(after.public_companies[0].owned_trains ?? [])];
      const departed: string[] = [];
      for (const model of owned) {
        const at = survivors.indexOf(model);
        if (at >= 0) survivors.splice(at, 1);
        else departed.push(model);
      }
      expect([...loss.rusted, ...loss.discarded].sort()).toEqual(departed.sort());
    }
  });

  it("measures the limit against the fleet rust has already thinned", () => {
    /* THE ORDER, ASSERTED IN THE REDUCER rather than inferred from an outcome: `trimToTrainLimit` is handed
       `fleetAfterRust`. Were it handed the pre-rust fleet it would trim trains the rust was about to take
       anyway, which is the double-count the report is worried about, arriving from the other direction. */
    expect(SESSION).toContain("owned: fleetAfterRust,");
  });

  it("puts the rust notice ahead of the limit notice", () => {
    /* RULED: "the Rust check/modal fires first, and only then ... does the Train Limit check and fire its
       modal." The queue order is the emission order, so this is asserted where the notices are built. */
    const notices = fleetLossNotices(
      { companyId: CO, ticker: "B&O", rusted: ["2"], discarded: ["3"] },
      "4",
      3,
    );
    expect(notices.map((n) => n.cause)).toEqual(["rust", "limit"]);
  });
});

/* ------------------------------------------------------------------ */
/* The refresh: a rebuild must not lose the board or repeat a modal    */
/* ------------------------------------------------------------------ */

describe("a replayed tile lay is judged against the reducer's phase", () => {
  it("takes the era from the ref the reducer writes, not from render state", () => {
    /* ==================================================================
        REPORTED: "the entire board reset to Yellow tiles, erasing the Green upgrades"
       ==================================================================
       THE ERA CAME FROM `currentPhase`, which is `useMemo(() => derivePhase(gameState))` -- React state. A
       refresh replays the whole log in one burst of awaited dispatches, so that memo still holds the phase
       the burst BEGAN in: phase 2, tint yellow. Every green upgrade is then judged against a yellow board,
       `filterSandboxPlacements` returns nothing, and the tile is dropped.
       #757 DIAGNOSED THIS EXACT FAILURE FOR THE OTHER INPUT -- "a legality check reading React state would
       judge every lay in that burst against the board as it stood before the burst began, and refuse
       legitimate upgrades" -- gave the GRID a ref, and left the PHASE on state. One rule, one of its two
       inputs, in the function whose own note names the fault.
       SNAPSHOTTED BESIDE THE GRID per #766 ("a snapshot, not a reorder"), so both halves judge one instant. */
    expect(APP).toContain("const phaseBeforeAction = derivePhase(sandboxStateRef.current);");
    expect(APP).toContain("era: ERA_FOR_PHASE_TINT[phaseBeforeAction?.tint ?? \"yellow\"]");
  });

  it("no longer asks render state for it", () => {
    /* THE NEGATIVE THAT MATTERS: `currentPhase` is still right for everything that renders, and wrong only
       inside a dispatch. Asserted on the predicate's own region so a render-time use elsewhere is untouched. */
    const predicate = sliceBetween(APP, "const gridBeforeAction = mapGridRef.current;", ").length === 0;");
    expect(predicate).not.toContain("currentPhase");
    expect(predicate).toContain("phaseBeforeAction");
  });

  it("is a real difference, not a theoretical one", () => {
    /* THE MECHANISM, EXERCISED. Green tile #29 upgrading yellow tile #7 on hex 5,0 is ALLOWED at era Green
       and REFUSED at era Yellow -- so the era handed to this predicate is exactly what decides whether a
       replayed upgrade survives the rebuild. Found by search rather than chosen: any pair with this property
       proves it, and asserting a real one keeps the case honest if the catalog changes. */
    const { filterSandboxPlacements } = require("../components/sandboxTileLegality") as typeof import("../components/sandboxTileLegality");
    const { MOCK_MAP_GRID } = require("./mockFixtures") as typeof import("./mockFixtures");
    /* ORIENTATION MATTERS AND MY FIRST DRAFT GUESSED IT. I found this pair by search -- yellow #7 at rot 3
       upgrading to green #29 at rot 3 -- and then wrote the case with orientation 0 for both, which is legal
       for neither era, so it asserted `true` about a placement that is simply invalid. The suite caught it.
       THE ROTATIONS ARE PART OF THE FIXTURE, not decoration. */
    const laid = {
      ...MOCK_MAP_GRID,
      tiles: [{ q: 5, r: 0, tile_id: 7, orientation: 3 }],
    };
    const ask = (era: "Yellow" | "Green") =>
      filterSandboxPlacements([{ tile_id: 29, orientation: 3 }], {
        mapGrid: laid as never,
        q: 5,
        r: 0,
        era,
      }).length > 0;
    expect(ask("Green")).toBe(true);
    expect(ask("Yellow")).toBe(false);
  });
});

describe("a dismissed fleet notice survives a refresh", () => {
  it("remembers the acknowledgement outside the page's memory", () => {
    /* REPORTED: "refreshing the page triggered the Rust modal despite it having fired several subphases
       before."
       #1032 KEYED DISMISSAL ON THE EVENT so a rebuild reaches the same key -- true of an UNDO, where the ref
       survives because the page does, and false of a REFRESH, which reconstructs it empty. The same shape as
       #1094's era toast: a guard that covers one kind of rebuild and silently not the other. */
    /* Design note #1107: in the app's own `1830juno.` storage namespace and versioned, the shape the other
       persisted keys use -- `appNaming.test.ts` enforces that namespace and caught the bare prefix I wrote
       first. */
    expect(APP).toContain("1830juno.fleet_loss_dismissed.v1.");
    expect(APP).toContain("rememberDismissed(noticeDismissKey(notice));");
  });

  it("keeps it out of the log, which #896 ruled against", () => {
    /* "A purely cosmetic dismissal that Undo could then rewind." Whether one viewer clicked a modal is not
       game state and must not enter the log every client replays -- so it lives in `sessionStorage`, keyed by
       room so two games in a session cannot inherit each other's acknowledgements. */
    expect(APP).toContain("window.sessionStorage.setItem(\n          dismissedStorageKey,");
    expect(APP).not.toContain("AcknowledgeFleetNotice");
  });

  it("fails toward showing the modal when storage refuses", () => {
    /* A PRIVATE WINDOW THROWS on `sessionStorage`, and the harmless direction is the one that was already the
       behaviour: the notice shows again. Both the read and the write are wrapped. */
    const load = sliceBetween(APP, "const saved = window.sessionStorage.getItem", "}");
    expect(load.length).toBeGreaterThan(0);
    expect(APP).toContain("dismissedFleetNoticesRef.current = new Set<string>();");
  });
});

/* ------------------------------------------------------------------ */
/* 2: the blizzard, and the rain                                       */
/* ------------------------------------------------------------------ */

describe("the rain clip, and the word that hides inside every train", () => {
  it("matches the word rain and not the letters in train", () => {
    /* ==================================================================
        THE BIGGEST KEYWORD TRAP IN THE POOL
       ==================================================================
       `/rain/i` MATCHES 72 OF THE 602 LINES AND MEANS ALMOST NONE OF THEM, because "t-r-a-i-n" contains
       "rain": every "Train robbers relieved the company of 20% of its revenue" would have played a
       rainstorm. Three lines contain the WORD. Measured before the pattern was written, not after.
       `\brain` WITH NO TRAILING BOUNDARY: the boundary is needed on the left, where "train" and "drain" fail
       it, and must be absent on the right or "rainstorm" is missed. */
    const rain = SFX_RULE("rain.mp3");
    for (const decoy of [
      "Train robbers relieved the company of 20% of its revenue.",
      "A rusting train gets one last Operating Round turn before it goes.",
      "A drainage ditch overflowed onto the permanent way.",
    ]) {
      expect(rain.test(decoy)).toBe(false);
    }
    expect(rain.test("Rain-softened embankments slowed freight to half speed.")).toBe(true);
    expect(rain.test("A rainstorm discouraged some less determined travelers.")).toBe(true);
  });

  it("takes the rainstorm off thunder, on purpose", () => {
    /* THE ONE LINE THAT MOVES FROM A WORKING CUE, and #1087's placement rule is why: a compound match beats a
       generic one, and rain is the more specific noise for a line whose subject is rain. The other three
       storm lines stay -- "a severe storm damaged signals" is not a rain line. */
    expect(anchorIndex(SFX, 'file: "rain.mp3"')).toBeLessThan(
      anchorIndex(SFX, 'file: "thunder.mp3"'),
    );
  });
});

describe("the blizzard clip covers the two lines it fits", () => {
  it("claims the blizzard and the winter freeze", () => {
    const rule = sliceBetween(SFX, 'file: "blizzard.mp3"', ",");
    expect(SFX).toContain('file: "blizzard.mp3"');
    expect(rule.length).toBeGreaterThan(0);
    expect(SFX).toContain("\\bblizzards?\\b|\\bwinter freeze\\b");
  });

  it("does not match the four metaphors or the fine weather", () => {
    /* ==================================================================
        THE TRAP THIS PATTERN IS SHAPED AROUND
       ==================================================================
       `/wind/i` WOULD HAVE TAKEN FIVE LINES IT HAS NO BUSINESS WITH: two "favorable wind" metaphors for good
       fortune, a "windfall" land grant, a cracked "window", and -- worst -- "a mild winter kept the tracks
       perfectly clear of ice and snow", whose entire content is that the weather was fine. A howling gale
       over that line is #1087's "matching a metaphor rather than the event" in its most embarrassing form.
       ASSERTED AS BEHAVIOUR, not as the regex: these run through the real pattern. */
    const blizzard = SFX_RULE();
    for (const decoy of [
      "A favorable wind blew directly into the corporate coffers.",
      "The line's directors negotiated a windfall land grant along the route.",
      "A cracked window required a last-minute repair before the train could leave.",
      "A mild winter kept the tracks perfectly clear of ice and snow.",
    ]) {
      expect(blizzard.test(decoy)).toBe(false);
    }
    // The positive control, or a pattern matching nothing would pass the above.
    expect(blizzard.test("A blizzard buried the mountain pass for eleven straight days.")).toBe(true);
    expect(blizzard.test("A winter freeze burst several miles of track.")).toBe(true);
  });

  it("sits at the head, above the generic storm cue", () => {
    /* PLACEMENT IS THE DESIGN, per #1087: "first match wins" makes this table an ordering. Below `thunder`,
       the blizzard line would be claimed by the storm pattern before this rule was ever consulted. */
    expect(anchorIndex(SFX, 'file: "blizzard.mp3"')).toBeLessThan(
      anchorIndex(SFX, 'file: "thunder.mp3"'),
    );
  });

  it("is on disk and in the set the on-disk check walks", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    expect(
      fs.existsSync(path.join(__dirname, "..", "..", "public", "audio", "blizzard.mp3")),
    ).toBe(true);
    const { everySfxFile } = require("./variantSfx") as typeof import("./variantSfx");
    expect(everySfxFile()).toContain("blizzard.mp3");
  });
});

/** The live pattern, pulled off the table rather than retyped -- a copy here could drift from the rule. */
function SFX_RULE(file = "blizzard.mp3"): RegExp {
  const { SFX_KEYWORDS } = require("./variantSfx") as typeof import("./variantSfx");
  const entry = SFX_KEYWORDS.find((row) => row.file === file);
  if (!entry) throw new Error(`no ${file} rule in SFX_KEYWORDS`);
  return entry.pattern;
}
