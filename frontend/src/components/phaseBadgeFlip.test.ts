/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE (VF-4 harness): WHAT THE BADGE PRINTS IS THE WHOLE TRIGGER
// ==================================================================
//
// The flourish says one thing -- "the phase just changed" -- so the only way it can be wrong is by firing
// when the badge is not changing, or not firing when it is. Every case below is one of those two:
//
//   1. THE FIVE REAL TRANSITIONS animate (2->3, 3->4, 4->5, 5->6, 6->D), and the DISPLAYED phase is what
//      each is judged on -- `derivePhase` run over two real states rather than a hand-written pair.
//   2. THE LEVEL PLAYING FIELD'S 7-TRAIN DOES NOT. It is a tier change and a Phase 6 badge either side
//      (#1326), which is the one wrong trigger this module exists to be incapable of producing.
//   3. AN UNKNOWN PHASE IS NOT A PHASE at either end (`gamePhase.ts` #3).
//   4. THE SCHEDULE is inside the brief's band, swaps at a hidden midpoint, and ends with nothing on.
//   5. THE SHELL'S WIRING -- the replay guard, the two holds, and the badge's two call sites -- asserted
//      against source, because where a comparison happens is the whole lesson of #1094 and cannot be seen
//      from the outside.

import { derivePhase, type GamePhase } from "../gameEngine/gamePhase";
import { resolveVariants } from "../gameEngine/gameVariants";
import type { GameStateResponse } from "../gameEngine/gameState";
import {
  buildPhaseBadgeFlipSequence,
  displayedPhaseFace,
  phaseBadgeChange,
  sameDisplayedPhase,
  phaseBadgeMilestoneMs,
  phaseBadgeTimeline,
  PHASE_BADGE_FLIP_CSS,
  PHASE_BADGE_MIDPOINT_AT_MS,
  PHASE_BADGE_REDUCED_MIDPOINT_AT_MS,
  PHASE_BADGE_REDUCED_TOTAL_MS,
  PHASE_BADGE_SETTLE_AT_MS,
  PHASE_BADGE_TOTAL_MS,
  PHASE_BADGE_VISIBLE_MS,
  phaseBadgeStageAt,
} from "./phaseBadgeFlip";

const { readStripped, anchorIndex, sliceBetween } =
  require("../utils/sourceScan") as typeof import("../utils/sourceScan");

const STANDARD = resolveVariants({});
const LPF = resolveVariants({ levelPlayingField: true });

/** The only three fields `derivePhase` reads. A fuller fixture would say no more and would tie this suite
 *  to a board it has no opinion about. */
function owning(trains: readonly string[], variants = STANDARD): GameStateResponse {
  return {
    variants,
    returned_trains: [],
    public_companies: [{ company_id: 1, owned_trains: [...trains] }],
  } as unknown as GameStateResponse;
}

/** A chain that reports no roster at all -- `gamePhase.ts` #3's "unknown is a state, not a zero". */
const UNKNOWN = {
  variants: STANDARD,
  returned_trains: [],
  public_companies: [{ company_id: 1 }],
} as unknown as GameStateResponse;

const phaseOf = (state: GameStateResponse): GamePhase | null => derivePhase(state);

describe("the displayed phase is what the badge prints", () => {
  it("reads the label and the tint, and nothing else about the phase", () => {
    const face = displayedPhaseFace(phaseOf(owning(["4"])));
    expect(face).toEqual({ label: "Phase: 4 (Green)", tint: "green" });
    /* NOT THE TIER, NOT THE TRAIN LIMIT, NOT THE DEPOT. A-4: the comparison may read what is rendered and
       must not re-derive a rule, and a face carrying only two rendered values cannot. */
    expect(Object.keys(face ?? {}).sort()).toEqual(["label", "tint"]);
  });

  it("has no displayed phase while the roster is unknown", () => {
    // The badge still prints something (`Phase: Yellow`), and that is not a phase this app can stand
    // behind -- so neither arriving at it nor leaving it is a phase CHANGE.
    expect(phaseOf(UNKNOWN)?.known).toBe(false);
    expect(displayedPhaseFace(phaseOf(UNKNOWN))).toBeNull();
    expect(displayedPhaseFace(null)).toBeNull();
    expect(displayedPhaseFace(undefined)).toBeNull();
  });
});

describe("the five transitions a 1830 game actually shows", () => {
  const cases: ReadonlyArray<readonly [string, readonly string[], readonly string[], string, string]> = [
    ["2 -> 3", ["2"], ["3"], "Phase: 2 (Yellow)", "Phase: 3 (Green)"],
    ["3 -> 4", ["3"], ["4"], "Phase: 3 (Green)", "Phase: 4 (Green)"],
    ["4 -> 5", ["4"], ["5"], "Phase: 4 (Green)", "Phase: 5 (Brown)"],
    ["5 -> 6", ["5"], ["6"], "Phase: 5 (Brown)", "Phase: 6 (Brown)"],
    ["6 -> D", ["6"], ["6", "D"], "Phase: 6 (Brown)", "Phase: D (Brown)"],
  ];

  it.each(cases)("animates %s, staging the old face", (_name, beforeTrains, afterTrains, from, to) => {
    const before = phaseOf(owning(beforeTrains));
    const after = phaseOf(owning(afterTrains));
    expect(before?.label).toBe(from);
    expect(after?.label).toBe(to);
    /* THE STAGED FACE IS THE `before` ONE, which is the whole of A-2 here: the badge is already holding
       the new phase, and what the flourish adds is the old one, briefly, so the change is CAUSED. */
    expect(phaseBadgeChange(before, after)).toEqual({ label: from, tint: before?.tint });
  });

  it("does not animate a phase that did not change", () => {
    const four = phaseOf(owning(["4"]));
    expect(phaseBadgeChange(four, four)).toBeNull();
    // A second 4-train empties the depot and moves `depotRemaining`, `shiftImminent` and the warning --
    // none of which the badge prints. Nothing flips.
    expect(phaseBadgeChange(four, phaseOf(owning(["4", "4"])))).toBeNull();
  });
});

describe("the Level Playing Field's 7-train is Phase 6 on both sides", () => {
  it("does not produce a Phase 6 -> Phase 6 flourish", () => {
    /* #1326: "the 7-train has no effect", so `TIER_PRESENTATION` gives it `phaseNumber: "6"`. The TIER
       changes and the BADGE does not, and a trigger written on the tier would announce that nothing
       happened -- the wrong trigger this module is shaped to be incapable of. */
    const six = phaseOf(owning(["6"], LPF));
    const seven = phaseOf(owning(["6", "7"], LPF));
    expect(six?.tier).toBe("6");
    expect(seven?.tier).toBe("7");
    expect(seven?.label).toBe("Phase: 6 (Brown)");
    expect(sameDisplayedPhase(displayedPhaseFace(six)!, displayedPhaseFace(seven)!)).toBe(true);
    expect(phaseBadgeChange(six, seven)).toBeNull();
  });

  it("still animates the Diesel that follows the 7 on the same open shelf", () => {
    // The shelf opens 6/7/D together (#1439/#1326), so a table can go 7 -> D with no tier between them.
    const seven = phaseOf(owning(["6", "7"], LPF));
    const diesel = phaseOf(owning(["6", "7", "D"], LPF));
    expect(diesel?.label).toBe("Phase: D (Brown)");
    expect(phaseBadgeChange(seven, diesel)).toEqual({ label: "Phase: 6 (Brown)", tint: "brown" });
  });
});

describe("an unknown phase is never an edge", () => {
  it("suppresses the flip at both ends, and on a missing state", () => {
    const three = phaseOf(owning(["3"]));
    expect(phaseBadgeChange(phaseOf(UNKNOWN), three)).toBeNull();
    expect(phaseBadgeChange(three, phaseOf(UNKNOWN))).toBeNull();
    /* AND A MISSING `before` IS THE FIRST OBSERVATION. The shell compares two settled states; there is no
       state before the first one, so `derivePhase(null)` is `null` and nothing animates on load, on a
       refresh, or for a client joining mid-game. */
    expect(phaseBadgeChange(derivePhase(null), three)).toBeNull();
    expect(phaseBadgeChange(null, three)).toBeNull();
    expect(phaseBadgeChange(undefined, undefined)).toBeNull();
  });
});

describe("the schedule", () => {
  const face = { label: "Phase: 3 (Green)", tint: "green" } as const;

  it("lands inside the brief's 450-600ms band, and swaps at a hidden midpoint", () => {
    const sequence = buildPhaseBadgeFlipSequence(face, false)!;
    expect(PHASE_BADGE_VISIBLE_MS).toBeGreaterThanOrEqual(450);
    expect(PHASE_BADGE_TOTAL_MS).toBeLessThanOrEqual(600);
    expect(sequence.stages.map((stage) => stage.kind)).toEqual(["fold", "unfold", "settle"]);
    // ONE application, at the midpoint, which is also where the fold ends and the unfold begins -- the
    // instant the plate is edge-on and there is nothing on screen to swap in front of.
    expect(sequence.applications).toEqual([{ applies: ["face"], at: PHASE_BADGE_MIDPOINT_AT_MS }]);
    expect(sequence.midpointAt).toBe(PHASE_BADGE_MIDPOINT_AT_MS);
    expect(phaseBadgeStageAt(sequence, PHASE_BADGE_MIDPOINT_AT_MS - 1)?.kind).toBe("fold");
    expect(phaseBadgeStageAt(sequence, PHASE_BADGE_MIDPOINT_AT_MS)?.kind).toBe("unfold");
    expect(phaseBadgeStageAt(sequence, PHASE_BADGE_SETTLE_AT_MS)?.kind).toBe("settle");
  });

  it("stages the face it was handed and nothing else", () => {
    const sequence = buildPhaseBadgeFlipSequence(face, false)!;
    expect(sequence.from).toEqual(face);
    // No `to`: the new face is the authoritative prop the badge is already holding, and a copy here would
    // be the second phase authority this batch must not create.
    expect(Object.keys(sequence).sort()).toEqual([
      "applications",
      "from",
      "midpointAt",
      "reducedMotion",
      "stages",
      "totalMs",
    ]);
    expect(buildPhaseBadgeFlipSequence(null, false)).toBeNull();
  });

  it("keeps the same order under reduced motion, shorter and with no rotation in it", () => {
    const sequence = buildPhaseBadgeFlipSequence(face, true)!;
    expect(sequence.reducedMotion).toBe(true);
    expect(sequence.stages.map((stage) => stage.kind)).toEqual(["fold", "unfold", "settle"]);
    expect(sequence.midpointAt).toBe(PHASE_BADGE_REDUCED_MIDPOINT_AT_MS);
    expect(sequence.totalMs).toBe(PHASE_BADGE_REDUCED_TOTAL_MS);
    expect(PHASE_BADGE_REDUCED_TOTAL_MS).toBeLessThan(PHASE_BADGE_TOTAL_MS);
  });

  it("holds a follow-on surface to the ACTIVE timeline's milestone, not to a fixed number", () => {
    /* ==================================================================
        CORRECTED: TWO FIXED CONSTANTS BECAME TWO NAMED MILESTONES
       ==================================================================
       THIS CASE USED TO ASSERT `PHASE_BADGE_ERA_TOAST_HOLD_MS === 200` AND `..._NOTICE_HOLD_MS === 520`,
       and defended them under reduced motion with "the full-motion figure is longer, so the surface can
       never arrive early". Never-early was the wrong property: the reduced-motion badge has swapped at
       80ms and finished at 200ms, so those constants bought 120ms and 320ms of dead air for the reader
       who asked for LESS presentation time. A hold is now a milestone, and the timeline being played
       supplies the number.
       EXACT FIGURES ON BOTH SIDES, because "shorter" is what the old assertion could have said and the
       point is which beat each one lands on. */
    expect(phaseBadgeMilestoneMs("faceSwapped", false)).toBe(PHASE_BADGE_MIDPOINT_AT_MS);
    expect(phaseBadgeMilestoneMs("settled", false)).toBe(PHASE_BADGE_TOTAL_MS);
    expect(phaseBadgeMilestoneMs("faceSwapped", true)).toBe(PHASE_BADGE_REDUCED_MIDPOINT_AT_MS);
    expect(phaseBadgeMilestoneMs("settled", true)).toBe(PHASE_BADGE_REDUCED_TOTAL_MS);
    // The required reading, spelled out rather than derived, so a retimed constant has to be noticed here.
    expect([
      phaseBadgeMilestoneMs("faceSwapped", false),
      phaseBadgeMilestoneMs("settled", false),
      phaseBadgeMilestoneMs("faceSwapped", true),
      phaseBadgeMilestoneMs("settled", true),
    ]).toEqual([200, 520, 80, 200]);
    // "Do not create long serialization": the longest hold either timeline asks for is half a second.
    expect(phaseBadgeMilestoneMs("settled", false)).toBeLessThanOrEqual(600);
  });

  it("takes its milestones from the very sequence the badge plays", () => {
    /* ONE SOURCE, NOT TWO THAT AGREE TODAY. `buildPhaseBadgeFlipSequence` spreads `phaseBadgeTimeline`
       for its own `midpointAt`/`totalMs`, so a hold cannot wait for a beat the badge is not playing. */
    for (const reducedMotion of [false, true]) {
      const sequence = buildPhaseBadgeFlipSequence(face, reducedMotion)!;
      expect(phaseBadgeMilestoneMs("faceSwapped", reducedMotion)).toBe(sequence.midpointAt);
      expect(phaseBadgeMilestoneMs("settled", reducedMotion)).toBe(sequence.totalMs);
      expect(phaseBadgeTimeline(reducedMotion)).toEqual({
        midpointAt: sequence.midpointAt,
        totalMs: sequence.totalMs,
      });
      // And the swap really is scheduled on that milestone, not merely named after it.
      expect(sequence.applications[0].at).toBe(phaseBadgeMilestoneMs("faceSwapped", reducedMotion));
    }
  });
});

describe("the stylesheet says a mechanical plate, not a stage effect", () => {
  it("rotates about the badge's own horizontal axis and nothing else", () => {
    expect(PHASE_BADGE_FLIP_CSS).toContain("rotateX(-90deg)");
    expect(PHASE_BADGE_FLIP_CSS).toContain("rotateX(90deg)");
    /* THE BANNED VOCABULARY, as an absence. The brief rules out a glow, a shake, an enlargement and arcade
       easing by name; each of those has exactly one spelling that would appear here. */
    expect(PHASE_BADGE_FLIP_CSS).not.toContain("box-shadow");
    expect(PHASE_BADGE_FLIP_CSS).not.toContain("filter:");
    expect(PHASE_BADGE_FLIP_CSS).not.toContain("scale(");
    expect(PHASE_BADGE_FLIP_CSS).not.toContain("translate");
    expect(PHASE_BADGE_FLIP_CSS).not.toContain("cubic-bezier");
    expect(PHASE_BADGE_FLIP_CSS).not.toContain("infinite");
  });

  it("disables the rotation under the OS preference, belt and braces", () => {
    /* ANCHORED AT THE START ON CODE AND AT THE END ON THE FILE'S OWN END, which is a real boundary rather
       than a character count: the media query is the last thing in the sheet, and the case below says so
       so that a future rule appended after it fails here rather than silently widening this slice. */
    const at = anchorIndex(PHASE_BADGE_FLIP_CSS, "@media (prefers-reduced-motion: reduce)");
    const guarded = PHASE_BADGE_FLIP_CSS.slice(at);
    expect(guarded.trimEnd().endsWith("}")).toBe(true);
    expect(guarded.split("@media")).toHaveLength(2);
    expect(guarded).toContain(".app-phase-badge-fold");
    expect(guarded).toContain(".app-phase-badge-unfold");
    expect(guarded).toContain("animation: none !important");
    expect(guarded).toContain("transform: none !important");
  });
});

describe("the shell raises it where the replay guard can see it", () => {
  const CODE = readStripped("App.tsx");

  it("compares two settled states rather than watching a render", () => {
    /* #1094'S LESSON, INHERITED RATHER THAN RE-LEARNED. A `useEffect` on the derived phase sees every
       intermediate commit of a rebuild, so a refresh would flip the badge 2->3->4->5 for a game that has
       been in Phase 5 for an hour -- the exact bug that moved the era toast out of its effect. Two states,
       one comparison, nothing stored. */
    expect(CODE).toContain(
      "const phaseBadgeFrom = phaseBadgeChange(derivePhase(before), derivePhase(after));",
    );
    expect(CODE).not.toContain("previousPhaseBadgeRef");
    expect(CODE).not.toContain("lastPhaseBadgeRef");
  });

  it("is guarded on `replayingHistory`, at the dispatch and inside the raiser", () => {
    /* REPLAY/REBUILD DOES NOT ANIMATE. Both halves are asserted because both are load-bearing: the
       dispatch-site guard is the structural one, and the raiser's is #825's own door, which also covers a
       future second caller. */
    const at = anchorIndex(CODE, "if (!replayingHistory && before !== null) {");
    expect(
      anchorIndex(CODE, "const phaseBadgeFrom = phaseBadgeChange(derivePhase(before), derivePhase(after));"),
    ).toBeGreaterThan(at);
    /* ONE LINE PER SLICE, AND A NAME OF ITS OWN. `scripts/sourceScanSweep.js` resolves a slice only when
       its declaration is one `sliceBetween(FILE, "a", "b")` call with no trailing comma, and it binds an
       assertion to the NEAREST PRECEDING declaration of that name -- so a wrapped call, or a second `body`,
       silently sends these anchors to be checked against the wrong region. Found by running the sweep. */
    const raiserBody = sliceBetween(CODE, "const showPhaseBadgeFlip = useCallback", "phaseBadgeFlipTokenRef.current += 1;");
    expect(raiserBody).toContain("if (replayingHistory) return;");
  });

  it("lets a live remote action animate, which `isRemoteReplay` could not", () => {
    /* #1094's argument, one surface over: the round-transition line beside this one suppresses itself on
       every remote client because it is a receipt for a transition the LOCAL client drove. A phase change
       is not a receipt -- every player derives it from the same state -- so the guard has to be the one
       that can tell a live remote action from a rebuild. */
    const flipBlock = sliceBetween(CODE, "if (!replayingHistory && before !== null) {", "if (before !== null && !replayingHistory) {");
    expect(flipBlock).toContain("showPhaseBadgeFlip(phaseBadgeFrom);");
    expect(flipBlock).not.toContain("isRemoteReplay");
    expect(flipBlock).not.toContain("spectator");
  });

  it("clears a superseded event on its own token", () => {
    const clearBody = sliceBetween(CODE, "const showPhaseBadgeFlip = useCallback", "}, PHASE_BADGE_TOTAL_MS);");
    expect(clearBody).toContain("setPhaseBadgeFlip((live) => (live !== null && live.token === token ? null : live));");
  });
});

describe("the follow-on surfaces wait for the plate to turn", () => {
  const CODE = readStripped("App.tsx");

  it("holds the era toast to the badge's midpoint without rewriting it", () => {
    const eraBlock = sliceBetween(CODE, "if (before !== null && !replayingHistory) {", "before.current_round_type !== after.current_round_type");
    expect(eraBlock).toContain('holdForPhaseBadgeFlip("faceSwapped", () =>');
    /* THE TOAST ITSELF IS UNTOUCHED -- same door (#825's guard lives behind it), same sentence (#966),
       same graphic (#929), same window (#1094). `phaseEraToast.test.ts` owns all four and still passes;
       this case owns only the cue. */
    expect(eraBlock).toContain("showDividendToast(");
    expect(eraBlock).toContain("PHASE_CHANGE_TOAST_MS,");
  });

  it("holds the Phase 3 notice until the plate has settled, and changes no part of its edge", () => {
    const noticeBlock = sliceBetween(CODE, "const [phaseThreeNotice, setPhaseThreeNotice] = useState(false);", "const [ceremonySoundsReady, setCeremonySoundsReady] = useState(false);");
    // #1441's edge, unchanged: the same seeded first observation and the same 2 -> 3 comparison.
    expect(noticeBlock).toContain("if (previous === undefined) return;");
    expect(noticeBlock).toContain('if (previous === "2" && tier === "3") {');
    expect(noticeBlock).toContain('holdForPhaseBadgeFlip("settled", () => setPhaseThreeNotice(true));');
    // And it is a HOLD on the notice, not a hold on anything the reducer did.
    expect(noticeBlock).not.toContain("await");
  });

  it("clears every hold on unmount", () => {
    const holdBlock = sliceBetween(CODE, "const flourishHoldTimersRef = useRef<number[]>([]);", "const [outro, setOutro] = useState<");
    expect(holdBlock).toContain("flourishHoldTimersRef.current.forEach((timer) => window.clearTimeout(timer));");
    /* AND THE HOLD RESOLVES ITS MILESTONE AGAINST THE PREFERENCE THE BADGE ITSELF READS, in the same
       commit -- not against a constant chosen for one of the two timelines. */
    /* ==================================================================
        AMENDED BY VF-7: THE BOOKKEEPING WAS SHARED, THE SCHEDULE WAS NOT
       ==================================================================
       IT ASSERTED `const holdMs = phaseBadgeMilestoneMs(milestone, reducedMotion);` -- one statement
       that happened to carry both halves of the property. VF-7 added a second flourish with a second
       timeline, so the timer list and its cleanup were extracted (`scheduleFlourishHold`) and the
       preference read was named (`reducedMotionNow`), leaving each hold to resolve its OWN milestone
       against its OWN schedule. The property is unchanged and is now asserted as the two things it
       always was: the hold takes its number from the phase-badge timeline, and that timeline is chosen
       by the live preference. */
    expect(holdBlock).toContain(
      "scheduleFlourishHold(phaseBadgeMilestoneMs(milestone, reducedMotionNow()), run);",
    );
    expect(holdBlock).toContain('window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true');
    expect(holdBlock).not.toContain("PHASE_BADGE_ERA_TOAST_HOLD_MS");
    expect(holdBlock).not.toContain("PHASE_BADGE_NOTICE_HOLD_MS");
  });
});

describe("the bar flips the badge that is already there", () => {
  const BAR = readStripped("panels/ContextualActionBar.tsx");

  it("renders one component at both of the bar's phase-badge sites", () => {
    /* TWO CALL SITES, ONE CEREMONY. The bar prints the badge in the Operating Round panel's left rail and
       again in the action row's lead; before this batch each held its own copy of the span. */
    expect((BAR.match(/<PhaseBadge label=\{phase\.label\} tint=\{phase\.tint\} flip=\{phaseFlip \?\? null\} \/>/g) ?? []).length).toBe(2);
    /* AND THE AUTHORITATIVE READING IS STILL WHAT IT PRINTS AT REST -- `phase.label` straight from
       `derivePhase`, which is the property `purchaseWarnings.test.ts` has asserted since #868. */
    expect((BAR.match(/\{phase\.label\}/g) ?? []).length).toBe(2);
  });

  it("has no second phase plate, and no consequence text on the badge", () => {
    /* The brief's list of things this flourish must not become. Each has one spelling that would show up
       in this file if it had been built. */
    expect(BAR).not.toContain("Phase Change!");
    expect(BAR).not.toContain("phaseChangeModal");
    expect(BAR).not.toContain("phaseChangeBanner");
    expect(BAR).not.toContain("PhaseChangeToast");
  });
});
