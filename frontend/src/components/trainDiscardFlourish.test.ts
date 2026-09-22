/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE (VF-8 harness): THE PRESIDENT'S CHOICE, AND THE FIVE WAYS TO LOSE IT
// ==================================================================
//
// VF-7's harness lists five ways a rust flourish can be wrong. A discard's list is different, because the
// event is different: nothing broke, somebody DECIDED. Every case below is one of these:
//
//   1. IT FIRES WHEN NOTHING WAS DISCARDED. The gate refuses a discard by returning the state it was
//      handed (#778), so a refusal and a success differ only by object identity -- which means the guard
//      is a `before !== after` and this file has to prove that refusals really do come back identical.
//   2. IT ANIMATES A TRAIN THE PRESIDENT DID NOT CHOOSE. #1530 removed the engine's cheapest-first trim
//      precisely so the president chooses; a presentation that re-derived "the cheapest" would quietly
//      put the rule back where a player can see it.
//   3. IT CUTS THE WRONG COPY. `["3", "3", "5"]` discarding a 3 -- the reducer empties `indexOf`'s slot
//      and nothing else may.
//   4. IT READS THE FLEET DIFF. `describeFleetLosses` splices a `DiscardTrain` out of its narration
//      (#1530), so the diff reports NOTHING here. A flourish built on it would never fire at all.
//   5. IT LOOKS LIKE A RUST. The two events mean opposite things and share a chip row; the vocabularies
//      have to be disjoint by assertion, not by intention.
//
// The reducer cases run the real reducer. Nothing here hand-builds a "discarded" fact.

export {};

const {
  buildDiscardSequence,
  discardCut,
  discardCutSeedFor,
  discardChipStageClass,
  discardCutClass,
  discardFor,
  discardIsSplit,
  discardMilestoneMs,
  discardStageAt,
  discardTimeline,
  discardedOccurrence,
  DISCARD_CUT_AT_MS,
  DISCARD_CUT_MAX_PERCENT,
  DISCARD_CUT_MAX_SLANT_PERCENT,
  DISCARD_CUT_MIN_PERCENT,
  DISCARD_REDUCED_CUT_AT_MS,
  DISCARD_REDUCED_TOTAL_MS,
  DISCARD_REDUCED_VACATE_AT_MS,
  DISCARD_TOTAL_MS,
  DISCARD_VACATE_AT_MS,
  TRAIN_DISCARD_CSS,
} = require("./trainDiscardFlourish") as typeof import("./trainDiscardFlourish");
type TrainDiscardEvent = import("./trainDiscardFlourish").TrainDiscardEvent;

const { applySandboxAction, describeFleetLosses } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { pendingTrainDiscards } =
  require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { derivePhase } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { readStripped, sliceBetween } =
  require("../utils/sourceScan") as typeof import("../utils/sourceScan");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const NYC = 2;
const BO = 4;
const CO = 5;
const P1 = "p1";
const P2 = "p2";
const P3 = "p3";

/* The fixture is `utils/trainDiscard.test.ts`'s board, narrowed to the fields this batch reads. Chartless
   on purpose, so a refusal comes back by identity (#778) -- which is the signal case (1) is about. */
function board(corps: { id: number; ticker: string; president: string; trains: string[] }[], operating: number): GameStateResponse {
  const order = corps.map((corp) => corp.id);
  return {
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(operating),
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: "Hardware",
    public_companies: corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: true,
      president: corp.president,
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: "1000",
      owned_trains: corp.trains,
      player_holdings: [{ player: corp.president, percentage: 100 }],
      station_token_hexes: [],
      station_tokens: [],
      station_token_limit: 3,
      home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

const DISCARD = (id: number, model: string) =>
  ({ DiscardTrain: { game_id: 1, protocol_id: id, model_type: model } }) as never;
const apply = (state: GameStateResponse, msg: never, actor: string) =>
  applySandboxAction(state, msg, { actor });
const fleetOf = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)?.owned_trains ?? null;

/** Phase 5 (limit 2) with C&O three trains over-strength: the obligation exists and the president owes one. */
const overLimit = () =>
  board(
    [
      { id: NYC, ticker: "NYC", president: P2, trains: ["5"] },
      { id: CO, ticker: "C&O", president: P1, trains: ["3", "3", "4"] },
      { id: BO, ticker: "B&O", president: P3, trains: ["4"] },
    ],
    NYC,
  );

describe("the trigger is a successful authoritative DiscardTrain, and nothing else", () => {
  it("has an obligation to answer in the first place", () => {
    const state = overLimit();
    expect(derivePhase(state)?.trainLimit).toBe(2);
    expect(pendingTrainDiscards(state)?.required).toMatchObject({ companyId: CO, excess: 1, limit: 2 });
  });

  it("changes the state on a real discard, which is the whole of the guard", () => {
    /* `before !== after` is the shell's condition. It is only a trigger if a success really does produce a
       new object and the reducer really does empty the slot. */
    const before = overLimit();
    const after = apply(before, DISCARD(CO, "4"), P1);
    expect(after).not.toBe(before);
    expect(fleetOf(after, CO)).toEqual(["3", "3"]);
    expect(after.returned_trains).toEqual(["4"]);
  });

  it("returns the identical object for every refusal the gate makes", () => {
    /* CASE 1. #778: "every gate refuses by returning the state it was handed." Three refusals, three
       identities -- so the shell's guard rejects all three without knowing what any of them was. */
    const state = overLimit();
    // Not this corporation's president.
    expect(apply(state, DISCARD(CO, "4"), P2)).toBe(state);
    expect(apply(state, DISCARD(CO, "4"), P3)).toBe(state);
    // A train the corporation does not hold.
    expect(apply(state, DISCARD(CO, "6"), P1)).toBe(state);
    // A corporation that owes nothing.
    expect(apply(state, DISCARD(BO, "4"), P3)).toBe(state);
  });

  it("is invisible to the fleet diff, so the diff could never have been the trigger", () => {
    /* CASE 4, and the audit finding this batch turned on. #1530: the discard is "narrated by the Activity
       Log as the action it is, not as a loss the phase took", so `describeFleetLosses` splices the message
       out. Both ends are empty -- the phase change takes nothing and the discard is not a loss. */
    const before = overLimit();
    const after = apply(before, DISCARD(CO, "4"), P1);
    expect(describeFleetLosses(before, after, DISCARD(CO, "4"))).toEqual([]);
  });

  it("puts the chosen train in the Bank Pool and pays nobody", () => {
    /* The destination the flourish is about: `returned_trains` is the one structure the bank holds loose
       trains in (#1512), and 6.6.1 is explicit that "its railroad receives no payment for it". */
    const before = overLimit();
    const after = apply(before, DISCARD(CO, "3"), P1);
    expect(after.returned_trains).toEqual(["3"]);
    expect(after.public_companies.find((c) => c.company_id === CO)?.treasury).toBe(
      before.public_companies.find((c) => c.company_id === CO)?.treasury,
    );
    expect(Number(after.virtual_bank_vgp)).toBe(Number(before.virtual_bank_vgp));
  });
});

describe("the president chose it, and the presentation does not second-guess which", () => {
  it("animates the train the message names, even when it is the dearest one held", () => {
    /* CASE 2. The retired trim took cheapest-first, which here would have been a 3. The president takes
       the 4, and the fleet that results is the one the chips have to end on. */
    const before = overLimit();
    const after = apply(before, DISCARD(CO, "4"), P1);
    expect(fleetOf(after, CO)).toEqual(["3", "3"]);
    // And the cheap alternative is equally legal, which is what makes "cheapest" a preference and not a rule.
    expect(fleetOf(apply(before, DISCARD(CO, "3"), P1), CO)).toEqual(["3", "4"]);
  });

  it("resolves the model to the slot the reducer itself will empty", () => {
    /* CASE 3, at the unit. `discardedOccurrence` IS the reducer's `owned.indexOf(model_type)` -- the same
       expression rather than an agreeing one, so the two cannot drift apart on a tie-break change. */
    expect(discardedOccurrence(["3", "3", "5"], "3")).toBe(0);
    expect(discardedOccurrence(["5", "3", "3"], "3")).toBe(1);
    expect(discardedOccurrence(["3", "4"], "4")).toBe(1);
    // A model the fleet does not hold resolves to nothing rather than to position zero.
    expect(discardedOccurrence(["3", "4"], "6")).toBe(-1);
    expect(discardedOccurrence([], "3")).toBe(-1);
  });

  it("agrees with the reducer on which copy of a duplicate left, measured rather than argued", () => {
    /* The claim above, run through the real arm: the survivors are the roster minus the resolved slot. */
    const before = board([{ id: CO, ticker: "C&O", president: P1, trains: ["3", "3", "5"] }], CO);
    const at = discardedOccurrence(["3", "3", "5"], "3");
    const after = apply(before, DISCARD(CO, "3"), P1);
    const expected = ["3", "3", "5"].filter((_, index) => index !== at);
    expect(fleetOf(after, CO)).toEqual(expected);
    expect(fleetOf(after, CO)).toEqual(["3", "5"]);
  });

  it("reads no price, no tier order and no age anywhere on the path", () => {
    /* THE RULE THIS BATCH MUST NOT REINTRODUCE, asserted as an absence over the whole module. */
    const CODE = readStripped("components/trainDiscardFlourish.ts");
    expect(CODE).not.toContain("cheapest");
    expect(CODE).not.toContain("price");
    expect(CODE).not.toContain("cost");
    expect(CODE).not.toContain("sort(");
    expect(CODE).not.toContain("TRAIN_TIERS");
  });
});

describe("the event addresses one corporation", () => {
  const discard = { companyId: CO, ticker: "C&O", before: ["3", "3", "4"], model: "4", at: 2 };
  const event: TrainDiscardEvent = { discard, token: 1 };

  it("is this corporation's discard, or none", () => {
    expect(discardFor(event, CO)).toBe(discard);
    expect(discardFor(event, BO)).toBeNull();
    expect(discardFor(event, null)).toBeNull();
    expect(discardFor(null, CO)).toBeNull();
    expect(discardFor(undefined, CO)).toBeNull();
  });

  it("shows nothing for a position the staged roster cannot hold", () => {
    /* A-3's direction: a flourish pointing at the wrong chip is worse than no flourish. */
    expect(buildDiscardSequence(null, false)).toBeNull();
    expect(buildDiscardSequence({ discard: { ...discard, at: -1 } }, false)).toBeNull();
    expect(buildDiscardSequence({ discard: { ...discard, at: 3 } }, false)).toBeNull();
    expect(buildDiscardSequence({ discard: { ...discard, at: 0 } }, false)).not.toBeNull();
  });

  it("never expresses several corporations at once, because the rules never produce it", () => {
    /* `pendingTrainDiscards` names ONE corporation at a time and the next only once it is compliant, so a
       list here would be a shape with no reachable value in it. Asserted on the type's single subject. */
    const CODE = readStripped("components/trainDiscardFlourish.ts");
    expect(CODE).toContain("export interface TrainDiscardEvent {");
    const shape = sliceBetween(CODE, "export interface TrainDiscardEvent {", "export function discardFor(");
    expect(shape).toContain("discard: DiscardedTrain;");
    expect(shape).not.toContain("corporations");
    expect(shape).not.toContain("readonly DiscardedTrain[]");
  });
});

describe("the schedule", () => {
  it("runs the brief's beats, inside its band", () => {
    const stages = buildDiscardSequence({ discard: { companyId: CO, ticker: "C&O", before: ["3", "4"], model: "4", at: 1 } }, false)!;
    expect(stages.stages.map((stage) => stage.kind)).toEqual(["tension", "cut", "part", "transfer"]);
    expect(stages.cutAt).toBe(DISCARD_CUT_AT_MS);
    expect(stages.transferredAt).toBe(DISCARD_VACATE_AT_MS);
    expect(stages.totalMs).toBe(DISCARD_TOTAL_MS);
    // The brief's 450-600ms band, the same one VF-7 was held to.
    expect(DISCARD_TOTAL_MS).toBeGreaterThanOrEqual(450);
    expect(DISCARD_TOTAL_MS).toBeLessThanOrEqual(600);
  });

  it("gives up the slot only after the chip has arrived, never while it is still travelling", () => {
    const transfer = buildDiscardSequence({ discard: { companyId: CO, ticker: "C&O", before: ["3", "4"], model: "4", at: 1 } }, false)!
      .stages.find((stage) => stage.kind === "transfer")!;
    expect(DISCARD_VACATE_AT_MS).toBe(transfer.at + transfer.durationMs);
    expect(DISCARD_TOTAL_MS).toBeGreaterThan(DISCARD_VACATE_AT_MS);
  });

  it("keeps the same beats under reduced motion, shorter", () => {
    const reduced = buildDiscardSequence({ discard: { companyId: CO, ticker: "C&O", before: ["3", "4"], model: "4", at: 1 } }, true)!;
    expect(reduced.stages.map((stage) => stage.kind)).toEqual(["tension", "cut", "part", "transfer"]);
    expect(reduced.totalMs).toBe(DISCARD_REDUCED_TOTAL_MS);
    expect(DISCARD_REDUCED_TOTAL_MS).toBeLessThan(DISCARD_TOTAL_MS);
    expect(reduced.transferredAt).toBe(DISCARD_REDUCED_VACATE_AT_MS);
  });

  it("takes its milestones from the ACTIVE timeline, never a full-motion constant", () => {
    /* VF-4's correction, kept: a surface waiting on `settled` under reduced motion must not be held to a
       500ms schedule that finished at 260. */
    expect(discardMilestoneMs("cut", false)).toBe(DISCARD_CUT_AT_MS);
    expect(discardMilestoneMs("transferred", false)).toBe(DISCARD_VACATE_AT_MS);
    expect(discardMilestoneMs("settled", false)).toBe(DISCARD_TOTAL_MS);
    expect(discardMilestoneMs("cut", true)).toBe(DISCARD_REDUCED_CUT_AT_MS);
    expect(discardMilestoneMs("transferred", true)).toBe(DISCARD_REDUCED_VACATE_AT_MS);
    expect(discardMilestoneMs("settled", true)).toBe(DISCARD_REDUCED_TOTAL_MS);
    // Every reduced milestone is strictly earlier than its full-motion twin -- no dead air anywhere.
    for (const milestone of ["cut", "transferred", "settled"] as const) {
      expect(discardMilestoneMs(milestone, true)).toBeLessThan(discardMilestoneMs(milestone, false));
    }
    expect(discardTimeline(true).totalMs).toBe(DISCARD_REDUCED_TOTAL_MS);
  });

  it("names the stage a given instant is in, and nothing outside the sequence", () => {
    const sequence = buildDiscardSequence({ discard: { companyId: CO, ticker: "C&O", before: ["3", "4"], model: "4", at: 1 } }, false)!;
    expect(discardStageAt(sequence, 0)?.kind).toBe("tension");
    expect(discardStageAt(sequence, DISCARD_CUT_AT_MS)?.kind).toBe("cut");
    expect(discardStageAt(sequence, DISCARD_VACATE_AT_MS - 1)?.kind).toBe("transfer");
    expect(discardStageAt(sequence, -1)).toBeNull();
  });
});

describe("the cut is one machine-made line, and it does not move", () => {
  it("falls near the middle, never off the chip", () => {
    for (let seed = 0; seed < 400; seed += 1) {
      const cut = discardCut(seed);
      expect(cut.xPercent).toBeGreaterThanOrEqual(DISCARD_CUT_MIN_PERCENT);
      expect(cut.xPercent).toBeLessThanOrEqual(DISCARD_CUT_MAX_PERCENT);
      expect(Math.abs(cut.slantPercent)).toBeLessThanOrEqual(DISCARD_CUT_MAX_SLANT_PERCENT);
    }
  });

  it("is never dead centre through the whole run, which is what it would read as a divider", () => {
    /* The one reason the position varies at all. A band that never left 50% would be a typographic rule
       through a two-character label rather than something done to the chip. */
    const positions = new Set<number>();
    for (let seed = 0; seed < 64; seed += 1) positions.add(discardCut(seed).xPercent);
    expect(positions.size).toBeGreaterThan(4);
  });

  it("is the same cut for the same chip, every render", () => {
    /* VF-7's `crackSeedFor` stability requirement, for VF-7's reason: a blade that moved mid-sequence
       would be two cuts. The chip re-renders at every stage boundary. */
    const seed = discardCutSeedFor(CO, 2);
    expect(discardCut(seed)).toEqual(discardCut(seed));
    expect(discardCutSeedFor(CO, 2)).toBe(discardCutSeedFor(CO, 2));
  });

  it("is a different blade for a different chip", () => {
    expect(discardCutSeedFor(CO, 0)).not.toBe(discardCutSeedFor(CO, 1));
    expect(discardCutSeedFor(CO, 0)).not.toBe(discardCutSeedFor(BO, 0));
  });

  it("is a position and a slant rather than a path, which is the whole contrast with rust", () => {
    /* CASE 5 at the unit: rust needs a generator because an irregular fracture that repeated would stop
       reading as a fracture; a guillotine needs the opposite. Two numbers, no path data. */
    const cut = discardCut(discardCutSeedFor(CO, 1));
    expect(Object.keys(cut).sort()).toEqual(["slantPercent", "xPercent"]);
    const CODE = readStripped("components/trainDiscardFlourish.ts");
    expect(CODE).not.toContain("crackPath");
    expect(CODE).not.toContain("Math.random");
  });
});

describe("the vocabulary is transfer, and it borrows nothing from destruction", () => {
  it("shares no class, no keyframe and no colour with the rust flourish", () => {
    /* CASE 5. Two vocabularies that share an implementation drift into looking alike, which is the one
       outcome that makes both useless -- so the disjointness is asserted rather than intended. */
    expect(TRAIN_DISCARD_CSS).not.toContain("app-train-rust");
    expect(TRAIN_DISCARD_CSS).not.toContain("rotate");
    expect(TRAIN_DISCARD_CSS).not.toContain("oxid");
    /* No new colour at all: the blade is drawn in the chip's own ink. Matched as a DECLARED value rather
       than as the character -- the stylesheet's own design notes cite note numbers, and a bare
       `not.toContain("#")` fails on `#26` while proving nothing about a colour. */
    expect(TRAIN_DISCARD_CSS).not.toContain("rgba(");
    expect(TRAIN_DISCARD_CSS.match(/:\s*#[0-9a-fA-F]{3,8}\b/)).toBeNull();
    expect(TRAIN_DISCARD_CSS).not.toContain("color:");
    expect(TRAIN_DISCARD_CSS).toContain("stroke: currentColor;");
  });

  it("separates by a few pixels and travels inside its own slot", () => {
    /* A-1: no portal, no fixed-position flight across the shell. The halves move single digits. */
    expect(TRAIN_DISCARD_CSS).not.toContain("position: fixed");
    const travels = Array.from(TRAIN_DISCARD_CSS.matchAll(/translate[XY]?\(([-0-9]+)px/g)).map((m) =>
      Math.abs(Number(m[1])),
    );
    expect(travels.length).toBeGreaterThan(0);
    for (const distance of travels) expect(distance).toBeLessThanOrEqual(10);
  });

  it("never animates for ever", () => {
    const counts = Array.from(TRAIN_DISCARD_CSS.matchAll(/animation-iteration-count: ([a-z0-9]+);/g));
    expect(counts.length).toBeGreaterThan(0);
    for (const match of counts) expect(match[1]).toBe("1");
    expect(TRAIN_DISCARD_CSS).not.toContain("infinite");
  });

  it("carries no class at all once the slot is given up", () => {
    expect(discardChipStageClass("tension")).toBe("app-train-discard-tensing");
    expect(discardChipStageClass("cut")).toBe("app-train-discard-tensing");
    expect(discardChipStageClass("part")).toBe("app-train-discard-parting");
    expect(discardChipStageClass("transfer")).toBe("app-train-discard-leaving");
    expect(discardChipStageClass(null)).toBeUndefined();
  });

  it("keeps the cut under reduced motion and drops only its fall", () => {
    /* #26's rule: a cue that disappears under reduced motion is an information problem, and the cut is the
       whole semantic difference from rust. It stays; only the travel goes. */
    expect(discardCutClass("tension", false)).toBeNull();
    expect(discardCutClass("cut", false)).toContain("app-train-cut-line-falling");
    expect(discardCutClass("cut", true)).toBe("app-train-cut-line");
    expect(discardCutClass("transfer", true)).toBe("app-train-cut-line");
    expect(discardCutClass(null, true)).toBeNull();
    // And the stylesheet neutralises the motion classes as well, which a stale render cannot bypass.
    expect(TRAIN_DISCARD_CSS).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("never splits the chip under reduced motion", () => {
    expect(discardIsSplit("part", false)).toBe(true);
    expect(discardIsSplit("transfer", false)).toBe(true);
    expect(discardIsSplit("tension", false)).toBe(false);
    expect(discardIsSplit("cut", false)).toBe(false);
    for (const stage of ["tension", "cut", "part", "transfer"] as const) {
      expect(discardIsSplit(stage, true)).toBe(false);
    }
  });
});

describe("the shell raises it from the action, under the replay guard", () => {
  const CODE = readStripped("App.tsx");
  const RAISE = sliceBetween(CODE, "if (!replayingHistory && before !== null && before !== after && isDiscardTrainMsg(msg)) {", "const closures = describePrivateClosures(before, after);");

  it("reads the message rather than the diff", () => {
    /* CASE 4 in the wiring: the diff is empty here, so a flourish that asked it would never fire. */
    expect(RAISE).toContain("const { protocol_id, model_type } = msg.DiscardTrain;");
    expect(RAISE).toContain("discardedOccurrence(was, model_type)");
    expect(RAISE).not.toContain("describeFleetLosses");
    expect(RAISE).not.toContain("loss.discarded");
  });

  it("is guarded on `replayingHistory` and on a real state change, in the condition itself", () => {
    /* #1094's edge discipline: the module-level flag, not `isRemoteReplay` and not a previous-value ref.
       And `before !== after` is the refusal signal the reducer cases above pinned. */
    expect(CODE).toContain("if (!replayingHistory && before !== null && before !== after && isDiscardTrainMsg(msg)) {");
    // Belt and braces: the raiser refuses a rebuild a second time, at its own door.
    const RAISER = sliceBetween(CODE, "const showTrainDiscard = useCallback(", "useEffect(");
    expect(RAISER).toContain("if (replayingHistory) return;");
  });

  it("reads no price, no tier order and no age on the shell's path either", () => {
    // CASE 2 at the call site. The only lookup is for the model the message already names.
    expect(RAISE).not.toContain("cheapest");
    expect(RAISE).not.toContain("sort(");
    expect(RAISE).not.toContain("depotInventory");
  });

  it("clears a superseded discard on its own token", () => {
    /* #1060's idiom. Reachable rather than theoretical: a corporation two over the limit discards twice
       in a row, and the second must replay rather than find the first still finishing. */
    const RAISER = sliceBetween(CODE, "const showTrainDiscard = useCallback(", "useEffect(");
    expect(RAISER).toContain("discardEventTokenRef.current += 1;");
    expect(RAISER).toContain("setDiscardEvent((live) => (live !== null && live.token === token ? null : live));");
  });

  it("narrows the message shape once rather than casting at the call site", () => {
    expect(CODE).toContain("function isDiscardTrainMsg(");
    expect(CODE).toContain('msg is { DiscardTrain: { protocol_id: number; model_type: string } }');
  });
});

describe("Tutorial policy", () => {
  const CODE = readStripped("App.tsx");

  it("queues the limit explanation only in tutorial mode", () => {
    /* VF-7's rule for the rust notice, applied to this one: with tutorials off, the cut and the Activity
       Log have just said this, and a dialog restating it charges an interruption for nothing. */
    const RAISE = sliceBetween(CODE, "showTrainDiscard({ companyId: protocol_id, ticker, before: was, model: model_type, at });", "const closures = describePrivateClosures(before, after);");
    expect(RAISE).toContain("if (tutorialModeEnabled()) {");
    expect(RAISE).toContain("discarded: [model_type]");
    expect(RAISE).toContain("rusted: []");
    // The replay-stable dismiss key (#1032) and the queue are the existing ones, not a second mechanism.
    expect(RAISE).toContain("const key = noticeDismissKey(notice);");
    expect(RAISE).toContain("pendingFleetNoticesRef.current = next;");
  });

  it("holds the limit modal until the transfer has finished, on the ACTIVE schedule", () => {
    expect(CODE).toContain('holdForDiscardFlourish("settled", () => setDiscardNoticeHeld(false));');
    expect(CODE).toContain("scheduleFlourishHold(discardMilestoneMs(milestone, reducedMotionNow()), run);");
    const due = sliceBetween(CODE, "const candidates = pendingFleetNotices.filter(", "const mine = candidates.filter");
    expect(due).toContain('!(notice.cause === "limit" && discardNoticeHeld)');
    // The rust hold is untouched beside it -- two causes, two schedules, one queue.
    expect(due).toContain('!(notice.cause === "rust" && rustNoticeHeld)');
  });

  it("writes the Activity Log line whatever the setting says", () => {
    /* #896's standing rule: "silencing a notice changes WHEN a player finds out, never whether the game
       told them." The discard's own log line is the reducer's narration and is not gated here. */
    const RAISE = sliceBetween(CODE, "if (!replayingHistory && before !== null && before !== after && isDiscardTrainMsg(msg)) {", "const closures = describePrivateClosures(before, after);");
    const gated = RAISE.slice(RAISE.indexOf("if (tutorialModeEnabled()) {"));
    expect(gated).not.toContain("logInfo(");
  });

  it("has retired the limit silence machinery, which was the last thing holding it up", () => {
    /* THE AUDIT THIS BATCH OWED. VF-7 narrowed the silence store to `limit` because the Train Limit dialog
       still had a real reader. It has not: #1530 made that dialog unreachable under v2 rules -- the phase
       diff reports nothing and the discard is spliced out -- so the checkbox has been offering to silence
       a dialog that never fires. With the explanation re-homed onto the action, the whole store goes. */
    const NOTICE = readStripped("utils/fleetLossNotice.ts");
    expect(NOTICE).not.toContain("SilenceableCause");
    expect(NOTICE).not.toContain("NoticeSilenced");
    expect(NOTICE).not.toContain("silenceLabel");
    expect(NOTICE).not.toContain("sessionStorage");
    const MODAL = readStripped("components/FleetLossModal.tsx");
    expect(MODAL).not.toContain('type="checkbox"');
    expect(MODAL).not.toContain("onToggleSilence");
    // And no caller was left holding a removed argument.
    expect(readStripped("App.tsx")).not.toContain("isNoticeSilenced");
    expect(readStripped("App.tsx")).not.toContain("setNoticeSilenced");
  });

  it("gives tutorial mode a writable control, since it decides whether a dialog interrupts", () => {
    // VF-7 added this; VF-8 is the second reader of the same setting, so it is pinned from here too.
    const LIB = readStripped("components/TutorialModal.tsx");
    expect(LIB).toContain("setTutorialMode(event.target.checked);");
  });
});

describe("the Bank Pool's end of the same event", () => {
  const PANEL = readStripped("components/TrainPurchasePanel.tsx");

  it("acknowledges the arrival on the returned-train row, once", () => {
    /* OPTION B of the brief. Pooled trains render only as rows in this panel, for the acting
       corporation's president -- so a discard answered off-turn has no visible destination and the
       departure has to be complete on its own. This is the reaction WHEN the panel happens to be open. */
    expect(PANEL).toContain('discardReceipt?: { model: string; token: number } | null;');
    expect(PANEL).toContain("discardReceipt.model === train.model");
    expect(PANEL).toContain('className={receiving ? "app-train-discard-received" : undefined}');
  });

  it("pops exactly one row, even when the pool already held that model", () => {
    /* The multiset lesson again, at the other end: `findIndex` picks the first matching row rather than
       every row of that model, so discarding a second 3 into a pool that holds one pops one. */
    expect(PANEL).toContain("returnedTrains.findIndex((entry) => entry.model === discardReceipt.model) === index");
  });

  it("replays on a second discard rather than sitting finished", () => {
    // The token in the key -- #1060 at the destination.
    expect(PANEL).toContain("${discardReceipt.token}");
  });

  it("borrows the flourish's own stylesheet, so the two lengths cannot disagree", () => {
    expect(PANEL).toContain("<style>{TRAIN_DISCARD_CSS}</style>");
    expect(TRAIN_DISCARD_CSS).toContain(".app-train-discard-received {");
  });
});
