/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE (WARNING-MARK harness): CAN YOU TELL THE TWO WARNINGS APART WITHOUT READING THEM
// ==================================================================
//
// That is the whole subject, and it decomposes into five claims a rendered mark can settle:
//
//   1. THE TWO MARKS ARE DIFFERENT KINDS OF THING. A fracture and a pair of figures cannot be confused
//      with each other at any size, which is more than could be said for two identical `⚠`s.
//   2. THE GENERIC GLYPH IS GONE WHERE A MARK REPLACED IT, and nowhere else. The Bank's ticket keeps its
//      own (VF-6, untouched by this pass).
//   3. THE FIGURES COME FROM THE RULE, NOT FROM THE SENTENCE. `4→3` and `3→2` are produced by running the
//      real `purchaseWarnings` over the real depot, and no part of the path reads `detail`.
//   4. COLOUR STILL MEANS URGENCY AND NOTHING ELSE. Neither mark introduces a colour; both are
//      `currentColor`, so a rust badge and a limit badge at the same countdown are the same colour.
//   5. THE MARKS SCALE WITH THEIR LABELS. Everything is in `em`, and the chrome is zoomed as one
//      (`chromeZoomFor`), so there is no size at which a mark and its badge disagree.
//
// AND THE CRACK IS VF-7'S, asserted as identity with `crackPath` rather than as a resemblance to it.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { CapacityMark, RustMark, WarningMark, rustMarkPath } from "./WarningMarks";
import { crackPath } from "./trainRustFlourish";
import { purchaseWarnings } from "../utils/purchaseWarnings";
import type { DepotTier, GamePhase, TrainTier } from "../gameEngine/gamePhase";

const { readStripped } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* `utils/purchaseWarnings.test.ts`'s fixture, because the capacity figures have to come from the same
   depot the rule reads. A table restated here would prove that this file can add 4 and 3. */
const DEPOT: readonly DepotTier[] = [
  { tier: "2", cost: 80, total: 6, remaining: 0, trainLimit: 4, isCurrent: false, soldOut: true, rusted: false },
  { tier: "3", cost: 180, total: 5, remaining: 0, trainLimit: 4, isCurrent: false, soldOut: true, rusted: false },
  { tier: "4", cost: 300, total: 4, remaining: 0, trainLimit: 3, isCurrent: false, soldOut: true, rusted: false },
  { tier: "5", cost: 450, total: 3, remaining: 0, trainLimit: 2, isCurrent: false, soldOut: true, rusted: false },
  { tier: "6", cost: 630, total: 2, remaining: 0, trainLimit: 2, isCurrent: false, soldOut: true, rusted: false },
  { tier: "D", cost: 1100, total: null, remaining: null, trainLimit: 2, isCurrent: false, soldOut: false, rusted: false },
] as unknown as readonly DepotTier[];

const RUSTS: Partial<Record<TrainTier, TrainTier>> = { "3": "2", "5": "3", "6": "4" };

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

const warningsAt = (tier: TrainTier, buys: number) => purchaseWarnings(phaseAt(tier, buys), DEPOT);
const limitAt = (tier: TrainTier, buys: number) =>
  warningsAt(tier, buys).find((warning) => warning.key === "train-limit") ?? null;
const rustAt = (tier: TrainTier, buys: number) =>
  warningsAt(tier, buys).find((warning) => warning.key === "rust") ?? null;

describe("the capacity the phase is about to take away", () => {
  it("is carried on the warning, as two integers", () => {
    /* THE SOURCE CLAIM. `phase.trainLimit` and `limitAfterNextPhase` are what the rule is decided on, and
       they are now what the badge is drawn from -- the same two values, not a re-derivation and not a
       re-reading of the prose they also go into. */
    expect(limitAt("3", 2)?.capacity).toEqual({ from: 4, to: 3 });
    expect(limitAt("4", 2)?.capacity).toEqual({ from: 3, to: 2 });
  });

  it("produces the brief's two examples, at both escalations", () => {
    for (const buys of [1, 2]) {
      expect(limitAt("3", buys)?.capacity).toEqual({ from: 4, to: 3 });
      expect(limitAt("4", buys)?.capacity).toEqual({ from: 3, to: 2 });
    }
  });

  it("is null on a rust warning, which changes no ceiling", () => {
    expect(rustAt("3", 1)?.capacity).toBeNull();
    expect(rustAt("5", 1)?.capacity).toBeNull();
    expect(rustAt("6", 2)?.capacity).toBeNull();
  });

  it("can never describe an increase, because the guard it is built inside forbids one", () => {
    /* 1830's limit only falls, but the module makes the comparison rather than assuming it (#889's note),
       so a populated `capacity` is a reduction by construction. Asserted over every tier that has one. */
    for (const tier of ["2", "3", "4", "5", "6", "D"] as TrainTier[]) {
      for (const buys of [1, 2]) {
        const capacity = limitAt(tier, buys)?.capacity ?? null;
        if (capacity !== null) expect(capacity.to).toBeLessThan(capacity.from);
      }
    }
  });

  it("is never read back out of the label or the detail", () => {
    /* THE THING THE FIELD EXISTS TO PREVENT. #889 rewrote these strings once and #1033 twice more; a badge
       parsing "lowers the train limit from 4 to 3" would have emptied itself on any of those edits. */
    const MARKS = readStripped("components/WarningMarks.tsx");
    expect(MARKS).not.toContain("detail");
    expect(MARKS).not.toContain(".label");
    expect(MARKS).not.toContain("match(");
    const BAR = readStripped("panels/ContextualActionBar.tsx");
    expect(BAR).toContain("<WarningMark kind={warning.key} capacity={warning.capacity} />");
    // And the label itself still does not carry the figures, so the mark is adding information (#889).
    expect(limitAt("3", 2)?.label).not.toContain("4");
    expect(limitAt("3", 2)?.label).not.toContain("3 ");
  });
});

describe("the rust mark is VF-7's own crack", () => {
  it("is the generator's output, at a fixed seed, mapped into the tile", () => {
    /* IDENTITY, NOT RESEMBLANCE. The path is `crackPath(41, 3)` with every coordinate mapped from the
       generator's 0-100 box into the frame's 3..19 interior -- so a change to what a fracture looks like
       in `trainRustFlourish.ts` moves this mark with it, which is the whole reason to reuse the function
       rather than paste a path. */
    const source = crackPath(41, 3);
    const numbers = (d: string) => (d.match(/-?[\d.]+/g) ?? []).map(Number);
    const mapped = numbers(source).map((value) => Math.round((3 + (value / 100) * 16) * 10) / 10);
    expect(numbers(rustMarkPath())).toEqual(mapped);
    // Same command sequence: two lines and a branch, not a re-drawn shape.
    expect((rustMarkPath().match(/[ML]/g) ?? []).join("")).toBe((source.match(/[ML]/g) ?? []).join(""));
  });

  it("stays inside its own tile rather than slashing through it", () => {
    /* A crack running off both edges of a box is a cancellation mark, which is the one wrong meaning
       available to this glyph. Every coordinate is inside the frame's interior. */
    for (const value of (rustMarkPath().match(/-?[\d.]+/g) ?? []).map(Number)) {
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(19);
    }
  });

  it("is the same mark on every render, because the seed is fixed", () => {
    expect(rustMarkPath()).toBe(rustMarkPath());
  });

  it("is three segments and a fork, which is the fewest that is not a clock", () => {
    /* ==================================================================
        THE CASE THE FIRST ATTEMPT FAILED, AND IT TOOK A RASTERISER TO FIND
       ==================================================================
       `steps: 2` scored better on every metric worth writing down and rendered as an analogue clock: one
       interior vertex, a branch specified to leave from an interior vertex, and therefore three limbs from
       a single point in a rounded square. "Time remaining" is exactly the wrong meaning to hand a
       countdown badge by accident.
       SO THE FLOOR IS PINNED HERE AS A SHAPE CLAIM: the main fracture turns at least twice, so the branch
       leaves from somewhere that is not the figure's only corner. That is what keeps it a break. */
    const d = rustMarkPath();
    expect((d.match(/[ML]/g) ?? []).join("")).toBe("MLLLML");
    const points = Array.from(d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)).map((m) => [Number(m[1]), Number(m[2])]);
    const main = points.slice(0, 4);
    const [branchFrom, branchTo] = points.slice(4);
    // The branch leaves an INTERIOR vertex of the main run, never its start or its end.
    const at = main.findIndex((point) => point[0] === branchFrom[0] && point[1] === branchFrom[1]);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(main.length - 1);
    // The fork is a real limb, not a wart: a fifth of the tile at minimum.
    expect(Math.hypot(branchTo[0] - branchFrom[0], branchTo[1] - branchFrom[1])).toBeGreaterThan(16 / 5);
    // And it leaves at a real angle rather than doubling the stroke it came off.
    const angle = (a: number[], b: number[]) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const off = Math.abs(angle(branchFrom, branchTo) - angle(main[at - 1], main[at]));
    expect(off).toBeGreaterThan(30);
    // THE CLOCK CONTROL: the vertex the branch leaves is not the only corner the figure has.
    const turns = main.slice(1, -1).length;
    expect(turns).toBeGreaterThan(1);
  });
});

describe("the marks as rendered", () => {
  let host: HTMLDivElement;
  let root: Root;

  const draw = (node: React.JSX.Element) => {
    act(() => {
      root.render(node);
    });
  };
  const svg = () => host.querySelector("svg");
  const strokes = () =>
    Array.from(host.querySelectorAll("[stroke]")).map((node) => node.getAttribute("stroke"));

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  it("draws rust as a fractured tile", () => {
    draw(<RustMark />);
    expect(svg()).not.toBeNull();
    // The tile and the fracture: exactly two shapes, which is as much detail as 12px will hold.
    expect(host.querySelectorAll("rect")).toHaveLength(1);
    expect(host.querySelectorAll("path")).toHaveLength(1);
    expect(host.querySelector("path")?.getAttribute("d")).toBe(rustMarkPath());
    /* THE CRACK IS THE FIGURE AND THE TILE IS THE GROUND, which is a weight relationship and therefore
       assertable. Three rendered candidates settled it: at equal weights the pair reads as a busy box. */
    const tile = host.querySelector("rect")!;
    const fracture = host.querySelector("path")!;
    expect(Number(fracture.getAttribute("stroke-width"))).toBeGreaterThan(
      Number(tile.getAttribute("stroke-width")),
    );
    expect(Number(tile.getAttribute("opacity"))).toBeLessThan(0.5);
  });

  it("draws the train limit as the figures themselves", () => {
    draw(<CapacityMark capacity={{ from: 4, to: 3 }} />);
    expect(host.textContent).toBe("4→3");
    expect(svg()).toBeNull();
    draw(<CapacityMark capacity={{ from: 3, to: 2 }} />);
    expect(host.textContent).toBe("3→2");
  });

  it("falls back to a capacity-down glyph rather than inventing numbers", () => {
    /* Unreachable from the bar today -- `purchaseWarnings` only builds this warning when both figures
       exist -- and asserted anyway, because the prop is nullable and #788's objection is to an arm nobody
       can explain rather than to one that is explained and tested. */
    draw(<CapacityMark capacity={null} />);
    expect(svg()).not.toBeNull();
    expect(host.textContent).toBe("");
    expect(host.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("routes each warning to its own mark by KEY, never by its words", () => {
    draw(<WarningMark kind="rust" />);
    expect(host.querySelectorAll("rect")).toHaveLength(1);
    draw(<WarningMark kind="train-limit" capacity={{ from: 4, to: 3 }} />);
    expect(host.textContent).toBe("4→3");
    expect(host.querySelectorAll("rect")).toHaveLength(0);
  });

  it("introduces no colour of its own, so colour still means only urgency", () => {
    /* THE CONSTRAINT THE WHOLE PASS IS BUILT AROUND (brief section 2). `ALERT_WARN_*`/`ALERT_CRITICAL_*`
       mean two-buys and one-buy on every surface in this app; a category colour here would make one
       channel answer two questions, which is #732. Both marks inherit. */
    draw(<RustMark />);
    for (const stroke of strokes()) expect(stroke).toBe("currentColor");
    const MARKS = readStripped("components/WarningMarks.tsx");
    expect(MARKS).not.toContain("ALERT_");
    expect(MARKS).not.toContain("rgba(");
    expect(MARKS.match(/:\s*#[0-9a-fA-F]{3,8}\b/)).toBeNull();
    expect(MARKS).not.toContain("fill=\"#");
  });

  it("is sized against its own label, which is the whole of the uiScale answer", () => {
    /* The chrome is zoomed as one object (`chromeZoomFor`), so a mark in `em` holds its proportion at 0.63,
       1.0 and 1.5 with no breakpoint. Asserted as an absence of absolute sizing rather than by rendering
       three times, because there is nothing scale-dependent left to render. */
    const MARKS = readStripped("components/WarningMarks.tsx");
    expect(MARKS).toContain('const MARK_SIZE = "1.15em";');
    expect(MARKS).not.toContain("px\"");
    draw(<RustMark />);
    expect(svg()?.getAttribute("style")).toContain("1.15em");
  });

  it("says nothing to a screen reader that the badge has not already said", () => {
    /* Brief section 9. The badge carries `aria-label={warning.detail}`, which is the whole sentence; a mark
       announced beside it would be a second, worse telling of it. */
    draw(<RustMark />);
    expect(svg()?.getAttribute("aria-hidden")).toBe("true");
    expect(svg()?.getAttribute("focusable")).toBe("false");
    draw(<CapacityMark capacity={{ from: 4, to: 3 }} />);
    expect((host.firstElementChild as HTMLElement).getAttribute("aria-hidden")).toBe("true");
    // And the sentence itself still names both figures, so nothing was moved out of the accessible text.
    expect(limitAt("3", 2)?.detail).toContain("from 4 to 3");
  });

  it("leaves the document alone", () => {
    draw(<RustMark />);
    expect(document.body.children).toHaveLength(1);
  });
});

describe("the bar wears one mark per badge, and the generic glyph is gone", () => {
  const BAR = readStripped("panels/ContextualActionBar.tsx");

  it("has no warning glyph left on any badge that gained a mark", () => {
    /* Brief section 3: not both. The three badges that had one -- the two countdowns and the Gentle Rust
       final run -- now open with their classification instead. */
    expect(BAR).not.toContain("&#9888;");
    expect(BAR).not.toContain("⚠");
  });

  it("puts the mark on both rails' countdown badges", () => {
    expect((BAR.match(/<WarningMark kind=\{warning\.key\} capacity=\{warning\.capacity\} \/>/g) ?? []).length).toBe(2);
    // The badge shell, the escalation classes and the pulse are untouched beside it.
    expect((BAR.match(/aria-label=\{warning\.detail\}/g) ?? []).length).toBe(2);
    expect((BAR.match(/warning\.imminent \? styles\.phaseShiftBadgeCritical : styles\.phaseShiftBadgeWarn/g) ?? []).length).toBe(2);
    expect((BAR.match(/warning\.pulses \? "app-phase-shift-critical" : undefined/g) ?? []).length).toBe(2);
  });

  it("gives the Gentle Rust final-run badge the rust mark, because it is a rust badge", () => {
    /* Two states of one rule (#1004/#1033: one purchase from rusting, versus rusted and running once
       more). Two different classification marks on them, in one group, at one escalation, would be the
       confusion this pass exists to remove. Flagged for owner review in Part K all the same. */
    expect(BAR).toContain("<RustMark /> {reprieveWarning.label}");
  });

  it("does not touch the Phase badge or the Bank ticket", () => {
    /* Brief section 8. The phase tag is current state rather than a warning, and the Bank has had its own
       silhouette since VF-6 -- including its own `⚠`, which stays because nothing replaced it. */
    expect(BAR).toContain("{phase.label}");
    expect((BAR.match(/<BankTicket reading=\{bankBreak\}/g) ?? []).length).toBe(2);
    const TICKET = readStripped("components/BankTicket.tsx");
    expect(TICKET).toContain("&#9888;");
    expect(TICKET).not.toContain("WarningMark");
    expect(TICKET).not.toContain("RustMark");
  });

  it("changes no threshold, no copy and no escalation timing", () => {
    /* The batch's standing constraint, asserted where it could most easily have slipped: the module that
       decides WHEN a warning appears is untouched apart from carrying two integers it already held. */
    const WARNINGS = readStripped("utils/purchaseWarnings.ts");
    expect(WARNINGS).toContain("const alert = phaseAlertLevel(phase);");
    expect(WARNINGS).toContain("if (alert === null) return [];");
    expect(WARNINGS).toContain("pulses: imminent && !gentleRust,");
    expect(WARNINGS).toContain("if (after !== null && after < phase.trainLimit) {");
    // And no mark, no icon and no colour decision leaked into the rule module.
    expect(WARNINGS).not.toContain("Mark");
    expect(WARNINGS).not.toContain("svg");
  });
});
