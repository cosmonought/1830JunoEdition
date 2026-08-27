/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 867/868 (harness): ONE COUNTDOWN, AND A REAL CONSEQUENCE
// ==================================================================
//
// REPORTED, three parts:
//   a) "they are on different countdowns from the Phase Change warning. Rust and Limit both appear in
//      orange/amber at '3 buys' left whereas the Phase Change shows up in orange/amber at '2 buys.'"
//   b) "all of the warning badges have a tooltip hover cursor icon, but no tooltip appears for them."
//   c) "I'm wondering if we can combine the Phase and Phase Change badges? and I'm wondering if we need the
//      Phase Change notification for every phase or only the two that shift from Yellow to Green and Green
//      to Brown?"
//
// AND THE CORRECTION THAT SETTLED (c): "the meaningful era change information (Green Tiles are now
// available, Brown Tiles are now available) could be a toast notification to every player when the threshold
// is crossed. The Rust and Limit warnings restrict what players can do, the Era change expands their
// repertoires."
//
// MY FIRST PASS MADE THE ERA A THIRD WARNING and this file asserted it, which is why the old expectations
// are quoted below rather than deleted. The line is not "what is coming" but "what is being taken away" --
// so the era leaves this module entirely and `App.tsx` toasts it when it lands.
//
// THE COVERAGE TABLE IS THE WHOLE ARGUMENT FOR DELETING THE GENERIC BADGE, so it is asserted rather than
// described: every transition that COSTS a player something earns a specific warning. The one silence --
// 2 -> 3, which only unlocks Green tiles -- is asserted as deliberate rather than left to be discovered.

import { purchaseWarnings, limitAfterNextPhase } from "./purchaseWarnings";
import { tierEra, type DepotTier, type GamePhase, type TrainTier } from "./gamePhase";

/** 1830's depot, with only the fields these rules read. */
const DEPOT: readonly DepotTier[] = [
  { tier: "2", cost: 80, total: 6, remaining: 0, trainLimit: 4, isCurrent: false, soldOut: true, rusted: false },
  { tier: "3", cost: 180, total: 5, remaining: 0, trainLimit: 4, isCurrent: false, soldOut: true, rusted: false },
  { tier: "4", cost: 300, total: 4, remaining: 0, trainLimit: 3, isCurrent: false, soldOut: true, rusted: false },
  { tier: "5", cost: 450, total: 3, remaining: 0, trainLimit: 2, isCurrent: false, soldOut: true, rusted: false },
  { tier: "6", cost: 630, total: 2, remaining: 0, trainLimit: 2, isCurrent: false, soldOut: true, rusted: false },
  { tier: "D", cost: 1100, total: null, remaining: null, trainLimit: 2, isCurrent: false, soldOut: false, rusted: false },
] as unknown as readonly DepotTier[];

/** The rusting schedule, from `gamePhase.ts`'s own table -- restated here only as the fixture's input. */
const RUSTS: Partial<Record<TrainTier, TrainTier>> = { "3": "2", "5": "3", "6": "4" };

/** A phase `buys` purchases from its shift. `purchasesUntilRust` and `purchasesUntilPhaseChange` are the
 *  SAME figure in `derivePhase` (`depotRemaining + 1`), which is the fact #867 turns on. */
const phaseAt = (tier: TrainTier, buys: number | null): GamePhase => {
  const row = DEPOT.find((entry) => entry.tier === tier);
  const rusting = RUSTS[tier] ?? null;
  return {
    tier,
    label: `Phase: ${tier}`,
    trainLimit: row?.trainLimit ?? 4,
    rustingTier: rusting,
    purchasesUntilPhaseChange: buys,
    purchasesUntilRust: rusting === null ? null : buys,
  } as unknown as GamePhase;
};

/** Every tier the fixture knows, taken from the fixture rather than from a module constant.
 *  `TIER_ORDER` IS PRIVATE TO `gamePhase.ts` and the first draft imported it anyway -- which failed at
 *  runtime as `undefined.forEach`, not at compile time. Reading the depot is also the better test: it is the
 *  same list the rule under test walks, so a tier added to one and not the other shows up here. */
const TIERS = DEPOT.map((row) => row.tier);

const keysAt = (tier: TrainTier, buys: number | null) =>
  purchaseWarnings(phaseAt(tier, buys), DEPOT).map((w) => w.key).sort();

describe("every warning shares one countdown (design note #867)", () => {
  it("says nothing at three buys, on any tier", () => {
    /* THE REPORT, AS AN ASSERTION. Rust and Limit used to appear here while the phase badge did not, which is
       the "different countdowns" that was seen. */
    TIERS.forEach((tier) => {
      expect(keysAt(tier as TrainTier, 3)).toEqual([]);
    });
  });

  it("warns at two and never claims imminence there", () => {
    TIERS.forEach((tier) => {
      purchaseWarnings(phaseAt(tier as TrainTier, 2), DEPOT).forEach((w) => {
        expect(w.imminent).toBe(false);
      });
    });
  });

  it("turns every warning critical together at one", () => {
    /* ONE MOMENT, ONE ESCALATION. Two badges about the same purchase disagreeing about urgency is the shape
       of the original report; this is the assertion that keeps them locked. */
    TIERS.forEach((tier) => {
      const at = purchaseWarnings(phaseAt(tier as TrainTier, 1), DEPOT);
      at.forEach((w) => expect(w.imminent).toBe(true));
    });
  });

  it("says nothing at all when the countdown is unknown", () => {
    // `null` is "the chain did not report train ownership" -- an unknown countdown must not render as urgent.
    expect(keysAt("3", null)).toEqual([]);
  });
});

describe("every loss is announced by something (design note #868)", () => {
  /* THE COVERAGE TABLE. This is why deleting the generic "Phase Shift Imminent" badge is safe rather than a
     gap, and why the answer to "only the two that shift Yellow to Green and Green to Brown" was no: the
     three transitions that would have been silenced are the RUST ones.
     THE FIRST VERSION OF THIS TABLE READ `["2", ["era"]]` and `["4", ["era", "train-limit"]]`, when the era
     change was a warning here. It is a toast now, so tier 2 -- whose shift takes nothing away -- correctly
     earns nothing at all. */
  const EXPECTED: ReadonlyArray<[TrainTier, readonly string[]]> = [
    ["2", []],
    ["3", ["rust", "train-limit"]],
    ["4", ["train-limit"]],
    ["5", ["rust"]],
    ["6", ["rust"]],
  ];

  it.each(EXPECTED)("tier %s earns exactly %s", (tier, expected) => {
    expect(keysAt(tier as TrainTier, 2)).toEqual([...expected].sort());
  });

  it("leaves no LOSS unannounced", () => {
    /* THE CLAIM THE DELETION RESTS ON, and DERIVED FROM THE RULES rather than from the table above -- which
       would just be that table restated. A tier earns a warning exactly when its shift rusts something or
       lowers the limit, so a tier added to the depot cannot slip through with a cost nobody mentions. */
    TIERS.forEach((tier) => {
      const phase = phaseAt(tier as TrainTier, 2);
      const after = limitAfterNextPhase(phase, DEPOT);
      const costsSomething =
        phase.rustingTier !== null || (after !== null && after < phase.trainLimit);
      expect(keysAt(tier as TrainTier, 2).length > 0).toBe(costsSomething);
    });
  });

  it("says nothing about the era at all", () => {
    /* THE CORRECTION, ASSERTED. My first pass made the era a third warning here and it was corrected: "The
       Rust and Limit warnings restrict what players can do, the Era change expands their repertoires."
       Counting down to good news put it in a row whose colour means danger. It is a toast now, and this
       module must not grow it back. */
    TIERS.forEach((tier) => {
      purchaseWarnings(phaseAt(tier as TrainTier, 2), DEPOT).forEach((w) => {
        expect(w.key as string).not.toBe("era");
        expect(w.label).not.toContain("Tiles");
      });
    });
  });

  it("is silent on 2 to 3 on purpose", () => {
    /* THE ONE TRANSITION THAT COSTS NOTHING. Yellow to Green rusts nothing and the limit stays at 4, so
       there is genuinely nothing to warn about. Asserted so the silence reads as a decision rather than as a
       gap somebody should fill -- and 5 -> 6 and 6 -> D are the mirror case, where the era does NOT change
       (Diesel shares Brown, per #612: the era names a tile colour and there is no diesel-coloured tile). */
    const phase = phaseAt("2", 1);
    expect(phase.rustingTier).toBeNull();
    expect(limitAfterNextPhase(phase, DEPOT)).toBe(4);
    expect(phase.trainLimit).toBe(4);
    expect(keysAt("2", 1)).toEqual([]);
    expect(tierEra("5")).toBe(tierEra("6"));
    expect(tierEra("6")).toBe(tierEra("D"));
  });

  it("has nothing to say at the end of the line", () => {
    // Diesel: nothing follows, so no era change, no limit drop and no rust.
    expect(keysAt("D", 2)).toEqual([]);
    expect(limitAfterNextPhase(phaseAt("D", 2), DEPOT)).toBeNull();
  });
});

describe("the row promises no tooltip (design note #867)", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  };

  it("drops the help cursor #839 left behind", () => {
    /* REPORTED: "all of the warning badges have a tooltip hover cursor icon, but no tooltip appears for
       them." `cursor: help` is an affordance, and #839 deleted the thing it advertised.
       DESIGN NOTE 490a, WALKED INTO AGAIN: the first draft searched the RAW file and failed, because the
       note explaining the fix quotes `cursor: "help"` in its own prose. A source scan cannot tell an
       implementation from a comment describing one. So the absence is read off a comment-stripped copy and
       the note is asserted separately against the raw text -- both halves, because stripping alone would let
       the explanation be deleted silently. */
    const raw = read("styles/appStyles.ts");
    const styles = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const at = styles.indexOf("  phaseShiftBadge: {");
    expect(at).toBeGreaterThan(-1);
    const body = styles.slice(at, styles.indexOf("\n  },", at));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('cursor: "default"');
    expect(body).not.toContain('cursor: "help"');
    // The record of WHY, which the stripped copy cannot see.
    expect(raw).toContain("DESIGN NOTE 867: A CURSOR PROMISING A TOOLTIP THAT WAS REMOVED");
  });

  it("carries the sentence for assistive technology instead", () => {
    /* NOT A TOOLTIP BY ANOTHER NAME. `aria-label` is read to somebody who cannot see the chip; no pointer
       reveals it, which is exactly why it does not violate #839's rule. */
    const bar = read("panels/ContextualActionBar.tsx");
    expect((bar.match(/aria-label=\{warning\.detail\}/g) ?? []).length).toBe(2);
  });

  it("has no generic phase-shift badge left in either form of the bar", () => {
    const bar = read("panels/ContextualActionBar.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(bar).not.toContain("Phase Shift Imminent");
    expect(bar).not.toContain("Phase Shift in 2 Buys");
    /* AND THE PHASE TAG SURVIVES, which is the other half of question (c): current state and what is coming
       are two facts, so the always-present tag was not merged into the sometimes-red warning. */
    expect(bar).toContain("{phase.label}");
  });
});
