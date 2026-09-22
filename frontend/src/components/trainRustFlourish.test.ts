/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE (VF-7 harness): THE TRIGGER IS AN AUTHORITATIVE LOSS, NOT A TIER CHANGING
// ==================================================================
//
// The rust flourish can be wrong in five ways, and every case below is one of them:
//
//   1. IT FIRES WHEN NOTHING WAS DESTROYED. The named hazards are a phase tier moving, a model number
//      matching the rusting tier, and a warning disappearing -- all three are true at a Gentle Rust
//      MARKING, where the trains are still in the fleet. Run through the reducer, not hand-built.
//   2. IT DESTROYS THE WRONG CHIPS. Multiplicity is the whole of this: a corporation holding two 2-trains
//      that loses one must rust exactly one.
//   3. IT SERIALISES. One reducer call rusts several fleets; that is ONE event on ONE clock.
//   4. IT REDRAWS ITS OWN CRACK. The chip re-renders on every stage boundary, so the geometry has to be a
//      function of the chip rather than of the moment.
//   5. IT HOLDS A REDUCED-MOTION READER TO A FULL-MOTION SCHEDULE.

import {
  buildRustSequence,
  crackPath,
  destroyedRustedModels,
  crackSeedFor,
  rustChipStageClass,
  rustCrackClass,
  rustMilestoneMs,
  rustStageAt,
  rustTimeline,
  rustedFleetFor,
  rustingPositions,
  RUST_FRACTURE_AT_MS,
  RUST_REDUCED_FRACTURE_AT_MS,
  RUST_REDUCED_TOTAL_MS,
  RUST_REDUCED_VACATE_AT_MS,
  RUST_TOTAL_MS,
  RUST_VACATE_AT_MS,
  TRAIN_RUST_CSS,
  type RustFlourishEvent,
} from "./trainRustFlourish";
import {
  applyPhaseChange,
  describeFleetLosses,
  describeReprieveExpiries,
} from "../gameEngine/sandboxSession";
import { resolveVariants } from "../gameEngine/gameVariants";
import type { GameStateResponse } from "../gameEngine/gameState";

const { readStripped, sliceBetween } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");

const PRR = 1;
const BO = 4;

/** A board with named fleets. Only the fields `applyPhaseChange` and the two narrators read. */
const board = (
  fleets: Readonly<Record<number, readonly string[]>>,
  over: Partial<GameStateResponse> = {},
): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    variants: resolveVariants({}),
    returned_trains: [],
    public_companies: Object.entries(fleets).map(([id, trains]) => ({
      company_id: Number(id),
      ticker: Number(id) === PRR ? "PRR" : "B&O",
      is_floated: true,
      owned_trains: [...trains],
      pending_rust_trains: [],
      player_holdings: [],
      bank_pool_percentage: 0,
      ipo_pool_percentage: 0,
      station_token_hexes: [],
    })),
    ...over,
  }) as unknown as GameStateResponse;

describe("the trigger is what the reducer actually destroyed", () => {
  it("names the corporation, the models and the multiplicity of a standard rust", () => {
    /* THE NARRATORS ARE THE AUTHORITY AND THIS BATCH ADDS NO SECOND ONE. `describeFleetLosses` has told
       the Activity Log which trains rusted since #704; the flourish is handed its answer. */
    const before = board({ [PRR]: ["2", "2", "3"], [BO]: ["2", "4"] });
    const after = applyPhaseChange(before, "4");
    const losses = describeFleetLosses(before, after);
    const prr = losses.find((entry) => entry.companyId === PRR);
    const bo = losses.find((entry) => entry.companyId === BO);
    // Two 2-trains for PRR, one for B&O -- multiplicity, from the reducer.
    expect(prr?.rusted).toEqual(["2", "2"]);
    expect(bo?.rusted).toEqual(["2"]);
    // And the survivors are untouched, which is the other half of "exact".
    expect(after.public_companies.find((c) => c.company_id === PRR)?.owned_trains).toEqual(["3"]);
  });

  it("marks the rusting positions by multiset, leaving an identical survivor alone", () => {
    /* A corporation holding two 2-trains that loses ONE of them -- reachable under Gentle Rust, where a
       marked and an unmarked 2 can sit side by side. `.includes` would rust both; #1004's reprieve pool
       and #1088's ghost pool record the identical off-by-one. */
    expect(Array.from(rustingPositions(["2", "3", "2"], ["2"]))).toEqual([0]);
    expect(Array.from(rustingPositions(["2", "3", "2"], ["2", "2"]))).toEqual([0, 2]);
    expect(Array.from(rustingPositions(["2", "3"], []))).toEqual([]);
    // A model that is not in the roster at all marks nothing rather than throwing.
    expect(Array.from(rustingPositions(["3"], ["2"]))).toEqual([]);
  });

  it("animates only models that actually left the fleet", () => {
    /* THE STANDARD CASE: everything the narrator named is gone, so everything animates. */
    expect(destroyedRustedModels(["2", "2", "3"], ["3"], ["2", "2"])).toEqual(["2", "2"]);
    /* THE PARTIAL CASE, by multiset: one of two identical models left. */
    expect(destroyedRustedModels(["2", "2", "3"], ["2", "3"], ["2", "2"])).toEqual(["2"]);
    /* THE MARKING CASE: the narrator says rusted and nothing left. */
    expect(destroyedRustedModels(["2", "3"], ["2", "3"], ["2"])).toEqual([]);
    /* UNKNOWN ROSTERS YIELD NOTHING -- #232's rule, and A-3's direction: an invented destruction is
       worse than a missing flourish. */
    expect(destroyedRustedModels(null, ["3"], ["2"])).toEqual([]);
    expect(destroyedRustedModels(["2"], undefined, ["2"])).toEqual([]);
  });

  it("is one event across several corporations, on one clock", () => {
    const event: RustFlourishEvent = {
      token: 1,
      corporations: [
        { companyId: PRR, ticker: "PRR", before: ["2", "3"], rusted: ["2"] },
        { companyId: BO, ticker: "B&O", before: ["2"], rusted: ["2"] },
      ],
    };
    /* ONE SEQUENCE SHAPE FOR EVERY MEMBER. There is no per-corporation offset anywhere in the schedule,
       which is the structural half of "do not serialize corporations into a long ceremony" -- and of
       "do not make loss order imply rules precedence that does not exist". */
    const first = buildRustSequence({ corporations: [event.corporations[0]] }, false)!;
    const second = buildRustSequence({ corporations: [event.corporations[1]] }, false)!;
    expect(first.stages).toEqual(second.stages);
    expect(first.applications).toEqual(second.applications);
    // Each row takes its own share and ignores the rest.
    expect(rustedFleetFor(event, PRR)?.rusted).toEqual(["2"]);
    expect(rustedFleetFor(event, BO)?.ticker).toBe("B&O");
    expect(rustedFleetFor(event, 99)).toBeNull();
    expect(rustedFleetFor(null, PRR)).toBeNull();
    expect(rustedFleetFor(event, null)).toBeNull();
  });
});

describe("duplicate models: the multiset picks one occurrence and holds it", () => {
  /* ==================================================================
      THE CASE NOTHING ON SCREEN CAN TELL APART
     ==================================================================
     before ["3", "3", "5"], rust ["3"], after ["3", "5"]. WHICH 3 dies is semantically arbitrary --
     the two are the same train -- so what has to be right is the COUNT and the STABILITY of the
     choice. `.includes` would rust both; a re-derivation that walked right-to-left on one render and
     left-to-right on the next would move the dying chip mid-sequence. */
  const BEFORE = ["3", "3", "5"];
  const AFTER = ["3", "5"];

  it("destroys one occurrence, not the model", () => {
    expect(destroyedRustedModels(BEFORE, AFTER, ["3"])).toEqual(["3"]);
    // And the survivor is still there: the diff found exactly one departure.
    expect(destroyedRustedModels(BEFORE, AFTER, ["3", "3"])).toEqual(["3"]);
  });

  it("marks exactly one position, and the same one every time it is asked", () => {
    const positions = rustingPositions(BEFORE, ["3"]);
    expect(Array.from(positions)).toEqual([0]);
    // Pure and total: ten calls, one answer. Nothing in the render path can shift the choice.
    for (let n = 0; n < 10; n += 1) {
      expect(Array.from(rustingPositions(BEFORE, ["3"]))).toEqual([0]);
    }
    // The survivor's position is NOT marked, which is the whole of "the other 3 does not flinch".
    expect(positions.has(1)).toBe(false);
    expect(positions.has(2)).toBe(false);
  });

  it("marks both when both die, which is the control on the one-occurrence rule", () => {
    expect(Array.from(rustingPositions(BEFORE, ["3", "3"]))).toEqual([0, 1]);
  });

  it("gives the two occurrences different crack seeds", () => {
    /* If both 3s ever rust together they must not fracture identically -- two chips side by side with
       the same crack reads as a repeated sprite, which is what `crackSeedFor` taking the position is
       for. And each seed is stable, which is what keeps one chip's crack from redrawing. */
    expect(crackSeedFor(PRR, 0)).not.toBe(crackSeedFor(PRR, 1));
    expect(crackPath(crackSeedFor(PRR, 0))).not.toBe(crackPath(crackSeedFor(PRR, 1)));
  });

  it("keys a staged survivor by where it will BE, so the handover unmounts only the dying chip", () => {
    /* ==================================================================
        THE DEFECT, AS THE RULE THAT REPLACED IT
       ==================================================================
       `key={model-index}` named a position in whichever array was rendered, and the staged and
       authoritative arrays differ in length -- so React matched the staged `3-0` (dying) to the
       authoritative `3-0` (surviving), unmounted the survivor's own node and remounted the untouched
       5. Measured in the DOM before the fix; `trainRustChips.test.tsx` carries the node-identity
       assertions. This is the rule itself, checked against the source. */
    const BADGES = readStripped("components/TrainBadges.tsx");
    expect(BADGES).toContain("if (rustState.rustingAt.has(index)) return `rusting:${index}`;");
    expect(BADGES).toContain("const key = `${model}-${survivorIndex}`;");
    expect(BADGES).toContain("key={chipKeys[index]}");
    // And the old spelling is gone, not merely shadowed.
    expect(BADGES).not.toContain("key={`${model}-${index}`}");
  });

  it("hands out authoritative indices to interaction, or none at all", () => {
    /* `onSelectTrain(index)` means a position in the roster the CALLER knows about, and while staging
       `index` is a position in the pre-rust one. Unreachable today -- the chips are interactive only on
       the Routes step and rust fires elsewhere -- and guarded rather than argued, because "cannot
       happen" here is an argument about the cursor rules made in a file that cannot see them. */
    /* AMENDED BY VF-8. The rule this case states is unchanged -- interaction is handed authoritative
       indices or none -- but the boolean now has a second staging source to answer for. VF-8 stages a
       discarded chip in the same component, so a roster can be pre-DISCARD as well as pre-rust, and a
       guard that only knew about rust would hand out a stale index during a cut. Asserted on the
       expression rather than the whole declaration because it is now wrapped over two lines. */
    const BADGES = readStripped("components/TrainBadges.tsx");
    expect(BADGES).toContain("interactive && rustState.before === null && discardState.before === null;");
    expect(BADGES).toContain("onClick={interactiveNow && onSelectTrain ? () => onSelectTrain(index) : undefined}");
  });
});

describe("Gentle Rust: marking is not destruction", () => {
  const gentle = (fleets: Readonly<Record<number, readonly string[]>>) =>
    board(fleets, { variants: resolveVariants({ gentleRust: true }) } as never);

  it("destroys nothing at the phase change, so there is nothing to fracture", () => {
    /* #979: under this variant the arriving tier MARKS rather than destroys -- `pending_rust_trains`
       grows and `owned_trains` is untouched. Every hazard the brief names is true here at once: the
       phase tier moved, the models match the rusting tier, and the warning badge changed. None of them
       is a destruction, and the narrator says so. */
    const before = gentle({ [PRR]: ["2", "2", "3"] });
    const after = applyPhaseChange(before, "4");
    const company = after.public_companies.find((c) => c.company_id === PRR);
    expect(company?.owned_trains).toEqual(["2", "2", "3"]);
    expect(company?.pending_rust_trains).toEqual(["2", "2"]);
    /* ==================================================================
        AND THE NARRATOR STILL SAYS "RUSTED", WHICH IS WHY THE FLOURISH ASKS A SECOND QUESTION
       ==================================================================
       FOUND BY RUNNING THIS CASE. `describeFleetLosses` reports the newly MARKED models as `rusted`
       under this variant, deliberately (#979: the notice would otherwise go silent for the one variant
       whose point is announcing it). A flourish collecting `loss.rusted` directly would therefore have
       fractured two chips that are still in the fleet -- precisely what section 8 forbids -- and it
       would have passed a test that only checked the narrator. */
    const narrated = describeFleetLosses(before, after).flatMap((loss) => loss.rusted);
    expect(narrated).toEqual(["2", "2"]);
    expect(describeReprieveExpiries(before, after)).toEqual([]);
    // WHAT THE FLOURISH ACTUALLY COLLECTS IS EMPTY, because nothing left the fleet.
    expect(destroyedRustedModels(["2", "2", "3"], ["2", "2", "3"], narrated)).toEqual([]);
    expect(buildRustSequence({ corporations: [] }, false)).toBeNull();
  });

  it("expires one of two identical marked trains and leaves the other", () => {
    /* THE DUPLICATE SHAPE ON THE GENTLE PATH. A corporation holding two 3-trains under one reprieve can
       finish one train's last run before the other -- and `expiredReprieves` intersects the departures
       with the marks by multiset, so the narrator reports one. The flourish then stages three chips and
       rusts one, exactly as the standard path does. */
    const marked = {
      company_id: PRR,
      ticker: "PRR",
      owned_trains: ["3", "3", "5"],
      pending_rust_trains: ["3", "3"],
    } as never;
    const oneGone = {
      company_id: PRR,
      ticker: "PRR",
      owned_trains: ["3", "5"],
      pending_rust_trains: [],
    } as never;
    const losses = describeReprieveExpiries(
      { public_companies: [marked] } as unknown as GameStateResponse,
      { public_companies: [oneGone] } as unknown as GameStateResponse,
    );
    expect(losses[0].rusted).toEqual(["3"]);
    expect(destroyedRustedModels(["3", "3", "5"], ["3", "5"], losses[0].rusted)).toEqual(["3"]);
    expect(Array.from(rustingPositions(["3", "3", "5"], losses[0].rusted))).toEqual([0]);
  });

  it("destroys at the expiry, which IS the flourish's edge", () => {
    /* #1002/#1099: the marks clear and the fleet shrinks in the same dispatch. That pair is what
       `describeReprieveExpiries` requires, and it is what the flourish stages. */
    const marked = gentle({ [PRR]: ["2", "2", "3"] });
    const withMarks = applyPhaseChange(marked, "4");
    const expired = {
      ...withMarks,
      public_companies: withMarks.public_companies.map((company) =>
        company.company_id === PRR
          ? { ...company, owned_trains: ["3"], pending_rust_trains: [] }
          : company,
      ),
    } as GameStateResponse;
    const losses = describeReprieveExpiries(withMarks, expired);
    expect(losses).toHaveLength(1);
    expect(losses[0].rusted).toEqual(["2", "2"]);
    expect(losses[0].discarded).toEqual([]);
    // AND HERE THE SECOND QUESTION ANSWERS YES: the models really did leave the fleet.
    expect(destroyedRustedModels(["2", "2", "3"], ["3"], losses[0].rusted)).toEqual(["2", "2"]);
  });
});

describe("the schedule", () => {
  const event = { corporations: [{ companyId: PRR, ticker: "PRR", before: ["2"], rusted: ["2"] }] };

  it("runs the brief's beats, inside its 450-600ms band", () => {
    const sequence = buildRustSequence(event, false)!;
    expect(sequence.stages.map((stage) => stage.kind)).toEqual([
      "oxidise",
      "fracture",
      "fail",
      "vacate",
    ]);
    expect(RUST_TOTAL_MS).toBeGreaterThanOrEqual(450);
    expect(RUST_TOTAL_MS).toBeLessThanOrEqual(600);
  });

  it("gives up the slot only after the chip is invisible", () => {
    /* THE ONE ORDERING THAT MATTERS: "affected slot stays reserved until disappearance; survivors settle
       only afterward". If the roster were dropped at the start of the fade, the surviving chips would
       slide leftwards under a chip that is still on screen. */
    const sequence = buildRustSequence(event, false)!;
    const fail = sequence.stages.find((stage) => stage.kind === "fail")!;
    expect(sequence.vacatedAt).toBe(fail.at + fail.durationMs);
    expect(sequence.applications).toEqual([{ applies: ["vacated"], at: RUST_VACATE_AT_MS }]);
    expect(rustStageAt(sequence, RUST_VACATE_AT_MS - 1)?.kind).toBe("fail");
    expect(rustStageAt(sequence, RUST_VACATE_AT_MS)?.kind).toBe("vacate");
  });

  it("keeps the same beats under reduced motion, shorter", () => {
    const sequence = buildRustSequence(event, true)!;
    expect(sequence.stages.map((stage) => stage.kind)).toEqual([
      "oxidise",
      "fracture",
      "fail",
      "vacate",
    ]);
    expect(sequence.totalMs).toBe(RUST_REDUCED_TOTAL_MS);
    expect(RUST_REDUCED_TOTAL_MS).toBeLessThan(RUST_TOTAL_MS);
  });

  it("takes its milestones from the ACTIVE timeline, never a full-motion constant", () => {
    /* VF-4's correction and VF-6's practice. A reduced-motion reader waits 240ms for the Tutorial modal,
       not 530 -- the difference is dead air charged to somebody who asked for less presentation. */
    expect(rustMilestoneMs("fractured", false)).toBe(RUST_FRACTURE_AT_MS);
    expect(rustMilestoneMs("vacated", false)).toBe(RUST_VACATE_AT_MS);
    expect(rustMilestoneMs("settled", false)).toBe(RUST_TOTAL_MS);
    expect(rustMilestoneMs("fractured", true)).toBe(RUST_REDUCED_FRACTURE_AT_MS);
    expect(rustMilestoneMs("vacated", true)).toBe(RUST_REDUCED_VACATE_AT_MS);
    expect(rustMilestoneMs("settled", true)).toBe(RUST_REDUCED_TOTAL_MS);
    // And they are the very numbers the sequence itself is built from.
    for (const motion of [false, true]) {
      const sequence = buildRustSequence(event, motion)!;
      expect(rustTimeline(motion)).toEqual({
        fracturedAt: sequence.fracturedAt,
        vacatedAt: sequence.vacatedAt,
        totalMs: sequence.totalMs,
      });
    }
  });

  it("builds nothing from an empty event", () => {
    expect(buildRustSequence(null, false)).toBeNull();
    expect(buildRustSequence({ corporations: [] }, false)).toBeNull();
  });
});

describe("the crack is procedural and stable", () => {
  it("is the same crack for the same chip, every render", () => {
    /* THE CHIP RE-RENDERS ON EVERY STAGE BOUNDARY. A crack regenerated from `Math.random` would redraw
       itself mid-fracture -- a different crack every frame, which is not a crack. */
    const seed = crackSeedFor(PRR, 1);
    expect(crackPath(seed)).toBe(crackPath(seed));
  });

  it("is a different crack for a different chip", () => {
    expect(crackPath(crackSeedFor(PRR, 0))).not.toBe(crackPath(crackSeedFor(PRR, 1)));
    expect(crackPath(crackSeedFor(PRR, 0))).not.toBe(crackPath(crackSeedFor(BO, 0)));
  });

  it("is jagged and branching rather than one straight line", () => {
    const path = crackPath(crackSeedFor(PRR, 0));
    // TWO SUBPATHS: the main fracture and one limb leaving it. A single `M` would be a polyline.
    expect((path.match(/M/g) ?? []).length).toBe(2);
    // AND THE MAIN RUN CHANGES DIRECTION: five vertices, not two.
    const main = path.slice(0, path.lastIndexOf("M"));
    expect((main.match(/L/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // Every vertex inside the box, so no chip is drawn with a crack hanging off it.
    for (const [x, y] of Array.from(path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)).map((m) => [
      Number(m[1]),
      Number(m[2]),
    ])) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });

  it("is resolution-free, so one generator serves every chip size", () => {
    /* The brief's "not a raster image tied to one chip size", as a property of the markup rather than of
       the path: a 0-100 viewBox stretched with `preserveAspectRatio="none"`. */
    const BADGES = readStripped("components/TrainBadges.tsx");
    expect(BADGES).toContain('viewBox="0 0 100 100"');
    expect(BADGES).toContain('preserveAspectRatio="none"');
    expect(BADGES).toContain("crackPath(crackSeedFor(companyId ?? 0, index))");
  });
});

describe("the vocabulary is destruction, and reduced motion keeps the information", () => {
  it("oxidises in burnt iron rather than fire", () => {
    /* The brief rules out bright orange cartoon rust, glow and sparks by name. Each has one spelling
       that would appear in this sheet if it had been built. */
    expect(TRAIN_RUST_CSS).toContain("rgba(107, 63, 42");
    expect(TRAIN_RUST_CSS).not.toContain("box-shadow");
    expect(TRAIN_RUST_CSS).not.toContain("#ff");
    expect(TRAIN_RUST_CSS).not.toContain("orange");
  });

  it("separates by a few pixels and no more", () => {
    /* "Pieces separate only a few pixels", taken literally: every translate in the failure keyframe is
       within 3px. An explosion, flying debris or a long physics sequence would all fail here. */
    const fail = sliceBetween(TRAIN_RUST_CSS, "@keyframes app-train-rust-fail", "}\n.app-train-rust-failing");
    for (const value of Array.from(fail.matchAll(/translate\((-?\d+)px, (-?\d+)px\)/g))) {
      expect(Math.abs(Number(value[1]))).toBeLessThanOrEqual(3);
      expect(Math.abs(Number(value[2]))).toBeLessThanOrEqual(3);
    }
    expect(fail).toContain("opacity: 0");
  });

  it("keeps the crack under reduced motion and drops only its propagation", () => {
    expect(rustCrackClass("fracture", false)).toContain("app-train-rust-crack-drawing");
    expect(rustCrackClass("fracture", true)).toBe("app-train-rust-crack");
    expect(rustCrackClass("fail", true)).toBe("app-train-rust-crack");
    expect(rustCrackClass("oxidise", true)).toBeNull();
    expect(rustCrackClass(null, false)).toBeNull();
    const guarded = TRAIN_RUST_CSS.slice(
      TRAIN_RUST_CSS.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    // No shudder, no fragment travel -- and the drawing is stilled rather than hidden.
    expect(guarded).toContain("transform: none !important");
    expect(guarded).toContain("stroke-dashoffset: 0 !important");
  });

  it("carries no class at all once the slot is given up", () => {
    expect(rustChipStageClass("oxidise")).toBe("app-train-rusting");
    expect(rustChipStageClass("fracture")).toBe("app-train-rusting");
    expect(rustChipStageClass("fail")).toContain("app-train-rust-failing");
    expect(rustChipStageClass("vacate")).toBeUndefined();
    expect(rustChipStageClass(null)).toBeUndefined();
  });

  it("never animates for ever", () => {
    expect(TRAIN_RUST_CSS).not.toContain("infinite");
  });
});

describe("the shell raises it from the authoritative narrators only", () => {
  const CODE = readStripped("App.tsx");

  it("collects `rusted`, from both narrators, and never `discarded`", () => {
    expect(CODE).toContain("const rustedFleets: RustedFleet[] = [];");
    /* ONE COLLECTOR, CALLED FROM BOTH NARRATORS' LOOPS -- the standard rust and the reprieve expiry --
       so the destruction test cannot be applied to one and forgotten on the other, which is the
       half-fix #897 and #1099 both record this codebase producing. */
    expect(CODE).toContain("const destroyed = destroyedRustedModels(was, rosterOf(settledAfter, loss.companyId), loss.rusted);");
    expect((CODE.match(/collectRust\(loss\);/g) ?? []).length).toBe(2);
    expect(CODE).toContain("showRustFlourish(rustedFleets);");
    /* THE DISCARD IS A DIFFERENT CAUSE WITH A DIFFERENT REMEDY (#896's split), and this batch's whole
       semantic premise is that it must not look like destruction. */
    expect(CODE).not.toContain("rusted: loss.discarded");
    expect(CODE).not.toContain("rustedFleets.push({ companyId: loss.companyId, ticker: loss.ticker, before: was, rusted: loss.discarded })");
  });

  it("does not infer rust from a tier, a model or a warning", () => {
    const raise = sliceBetween(CODE, "const rustedFleets: RustedFleet[] = [];", "showRustFlourish(rustedFleets);");
    expect(raise).not.toContain("rustingTier");
    expect(raise).not.toContain("phaseAlertLevel");
    expect(raise).not.toContain("RUSTS_ON");
  });

  it("raises once, below both narrators", () => {
    /* Two calls would make the second supersede the first and cut half the board's chips off
       mid-fracture. The collection spans both blocks and the raise is after them. */
    /* ONE CALL. `readStripped` leaves the declaration as `const showRustFlourish = useCallback`, which
       does not match this pattern -- so a second match here would be a second raise, which is exactly
       the thing being forbidden. (The first draft expected 2 and was counting a declaration that does
       not have the parenthesis; found by running it.) */
    expect((CODE.match(/showRustFlourish\(/g) ?? []).length).toBe(1);
    const afterExpiries = CODE.slice(CODE.indexOf("const expiries = describeReprieveExpiries(before, after);"));
    expect(afterExpiries.indexOf("showRustFlourish(rustedFleets);")).toBeGreaterThan(-1);
  });

  it("is guarded on `replayingHistory` inside the raiser", () => {
    const raiser = sliceBetween(CODE, "const showRustFlourish = useCallback", "rustEventTokenRef.current += 1;");
    expect(raiser).toContain("if (replayingHistory) return;");
    expect(raiser).toContain("if (corporations.length === 0) return;");
    /* NO STORED PREVIOUS FLEET. #1094's lesson: a ref holding the last roster is re-read by every
       intermediate commit of a rebuild, which is how the era toast came to re-announce history. */
    expect(CODE).not.toContain("previousFleetRef");
    expect(CODE).not.toContain("lastFleetRef");
  });

  it("clears a superseded event on its own token", () => {
    const body = sliceBetween(CODE, "const showRustFlourish = useCallback", "}, RUST_TOTAL_MS);");
    expect(body).toContain("setRustEvent((live) => (live !== null && live.token === token ? null : live));");
  });
});

describe("Tutorial policy", () => {
  const CODE = readStripped("App.tsx");

  it("queues the rust notice only in tutorial mode, and never gates the limit notice", () => {
    expect((CODE.match(/if \(notice\.cause === "rust" && !tutorialModeEnabled\(\)\) continue;/g) ?? []).length).toBe(2);
    /* THE LIMIT NOTICE IS UNTOUCHED, which is this batch's scope boundary: a train-limit drop still has
       no visual vocabulary of its own, so its modal is still the only thing that says a train was taken. */
    expect(CODE).not.toContain('notice.cause === "limit" && !tutorialModeEnabled()');
  });

  it("writes the Activity Log line whatever the setting says", () => {
    /* #896's standing rule, and the reason gating the modal is safe: "silencing a notice changes WHEN a
       player finds out, never whether the game told them." The line is above the gate and outside it. */
    const block = sliceBetween(CODE, "for (const loss of describeFleetLosses(before, after, msg)) {", "for (const notice of fleetLossNotices(loss, arrivingTier, limitNow)) {");
    expect(block).toContain('if (sentence) logInfo("Phase Change", sentence);');
    expect(block).not.toContain("tutorialModeEnabled");
  });

  it("holds the rust modal until the chips have finished, on the active schedule", () => {
    /* AMENDED BY VF-8. The rust half of this case is untouched: the hold is still released on the
       ACTIVE schedule's "settled" milestone, and a held rust notice is still simply not due yet.
       What changed is the shape of the filter it reads. VF-7 could write a one-cause guard because
       rust was the only cause with a flourish to wait for; VF-8 gave the train-limit discard its own
       vocabulary, so the guard is a per-cause list now and the old anchors are gone. Re-anchored on
       the filter that replaced them, and the limit half is asserted here too so the two holds cannot
       silently collapse back into one. */
    expect(CODE).toContain('holdForRustFlourish("settled", () => setRustNoticeHeld(false));');
    expect(CODE).toContain("scheduleFlourishHold(rustMilestoneMs(milestone, reducedMotionNow()), run);");
    const due = sliceBetween(CODE, "const candidates = pendingFleetNotices.filter(", "const mine = candidates.filter");
    expect(due).toContain('!(notice.cause === "rust" && rustNoticeHeld)');
    expect(due).toContain('!(notice.cause === "limit" && discardNoticeHeld)');
  });

  it("gives tutorial mode a control, since it now decides whether a dialog interrupts", () => {
    const LIB = readStripped("components/TutorialModal.tsx");
    expect(LIB).toContain("setTutorialMode(event.target.checked);");
    expect(LIB).toContain("Tutorial mode");
  });

  it("leaves one system deciding whether the rust modal appears", () => {
    /* THE DUPLICATION THE BRIEF RULES OUT. A per-corporation rust silence would be a second, unreachable
       way to suppress the same dialog.

       AMENDED BY VF-8. VF-7 narrowed the silence store's cause to `limit` rather than deleting it, and
       said why: the limit half still had a real reader, because the Train Limit dialog was then the
       only way a player was told a train had left the fleet, so a "don't show me this again" checkbox
       was still doing work there. VF-8 is the batch that gave the discard its own vocabulary, and the
       audit that came with it found the Train Limit FleetLossModal unreachable under v2 rules besides
       (#1530: describeFleetLosses reports nothing at the phase change, and the DiscardTrain message is
       spliced out before the narrator sees it). With no reader left on either half, the whole store is
       retired rather than narrowed again -- so this case now asserts its ABSENCE, which is the same
       rule stated at its limit: exactly one system decides whether either dialog appears, and that
       system is the tutorial setting. */
    const NOTICE = readStripped("utils/fleetLossNotice.ts");
    expect(NOTICE).not.toContain("SilenceableCause");
    expect(NOTICE).not.toContain("isNoticeSilenced");
    expect(NOTICE).not.toContain("setNoticeSilenced");
    expect(NOTICE).not.toContain("sessionStorage");
    expect(NOTICE).not.toContain("Don't notify me about");
    // The queue itself is untouched -- what went is the second opinion, not the notice.
    const due = sliceBetween(NOTICE, "export function nextDueNotice(", "): FleetLossNotice | null {");
    expect(due).toContain("queued: readonly FleetLossNotice[],");
    expect(due).toContain("dismissed: ReadonlySet<string>,");
    // And the dialog that hosted the checkbox no longer offers one.
    const MODAL = readStripped("components/FleetLossModal.tsx");
    expect(MODAL).not.toContain('type="checkbox"');
    expect(MODAL).not.toContain("onToggleSilence");
  });
});
