/** @jest-environment node */

//
// The Buy Trains step: what pins, what folds, what warns.
//
// ==================================================================
//  DESIGN NOTE 837 (harness): A DEADLOCK THAT LOOKED LIKE A ROUND
// ==================================================================
//
// REPORTED: "The Buy Trains subphase Action Panel is supposed to be sticky and in OR 1.1 it's not, but in OR
// 2.1 it is... Also clicking 'Buy Trains' auto-scrolls players from anywhere on the page a little bit upward,
// but it doesn't go all the way to the top."
//
// NOTHING ABOUT ROUNDS. Since #828 the step panel renders INSIDE the sticky element, so `measure()` read a
// rect containing it; `pinnable` was computed from that rect; `condensed` required `pinnable`; and the panel
// folded its depot table only when `condensed`. The table folded because the bar pinned and the bar pinned
// because the table folded. Whichever side of the 50% threshold the first frame landed on is where it stayed
// -- one extra corporation on the roster decides it.
//
// AND THE PROBE AGREED WITH IT. #813's readout took its verdict on the same on-screen pixels, so it announced
// WOULD UNPIN while the bar was unpinned BECAUSE it was unpinned. #828a's own sentence, one pass later: an
// instrument that lies is worse than none.
//
// THE CUT IS `restingHeight` -- the bar with every collapsible body subtracted. "Can this be a sticky bar at
// all" is properly a question about the resting form, and that number does not move when the fold moves.

import {
  restingHeight,
  shouldReleasePin,
  STICKY_MAX_VIEWPORT_SHARE,
  STICKY_OPTIONAL_ATTR,
  STICKY_RELEASE_VIEWPORT_SHARE,
} from "./stickyCollapse";
import { purchaseWarnings, limitAfterNextPhase } from "./purchaseWarnings";
import type { DepotTier, GamePhase } from "./gamePhase";

const read = (rel: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
};
/* #490a: every note below quotes the rule it explains, so the code assertions read a comment-stripped copy
   and the notes are checked separately against the raw text where that is the point. */
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const BAR = strip(read("panels/ContextualActionBar.tsx"));
const PANEL = strip(read("components/TrainPurchasePanel.tsx"));

/** A fake element tree, because `restingHeight` is DOM arithmetic and jsdom is not needed to check it.
 *
 *  `nest` makes the FIRST marked child the ancestor of the rest, which is the case the real filter exists
 *  for. The first draft of this helper had every child claim to contain every other, so `outermost` came back
 *  empty and the test passed on 300 -- a fake that models the shape wrongly proves nothing about the code. */
function node(height: number, optional: readonly number[], nest = false): HTMLElement {
  const children: HTMLElement[] = [];
  optional.forEach((h, index) => {
    children.push({
      getBoundingClientRect: () => ({ height: h }) as DOMRect,
      contains: (other: Node | null) => nest && index === 0 && other !== children[0],
    } as unknown as HTMLElement);
  });
  return {
    getBoundingClientRect: () => ({ height }) as DOMRect,
    querySelectorAll: (selector: string) =>
      selector === `[${STICKY_OPTIONAL_ATTR}]` ? children : [],
  } as unknown as HTMLElement;
}

describe("restingHeight", () => {
  it("subtracts what a caret can fold away", () => {
    expect(restingHeight(node(400, [242]))).toBe(158);
  });

  it("is the whole height when nothing is marked", () => {
    // The bar on every other step: no collapsible body, so resting and actual are the same number.
    expect(restingHeight(node(185, []))).toBe(185);
  });

  it("counts a nested mark once", () => {
    /* Subtracting an inner body and its outer one would report a NEGATIVE resting height, which
       `canPinWithoutTrapping` reads as "unmeasurable, so stick" -- hiding the exact case it was asked
       about behind a confident yes. */
    expect(restingHeight(node(300, [200, 50], true))).toBe(100);
  });

  it("never goes below zero", () => {
    expect(restingHeight(node(100, [400]))).toBe(0);
  });
});

describe("the pin no longer depends on what it decides", () => {
  it("tests the resting height, not the rect", () => {
    expect(BAR).toContain("canPinWithoutTrapping(restingHeight(node), window.innerHeight, stickyTop)");
    expect(BAR).not.toContain("canPinWithoutTrapping(rect.height");
  });

  it("still measures the clearance from the rect", () => {
    /* TWO QUESTIONS, TWO NUMBERS, and collapsing them would be the opposite mistake. "Can I pin" is about
       the resting form; "how much am I covering right now" is about the pixels on screen, which is what a
       scrolled-to panel has to clear (#810). */
    expect(BAR).toContain("Math.round(stickyTop + rect.height)");
  });

  it("marks both collapsible bodies and the upcoming-trains grid", () => {
    /* THE MARK IS WHAT MAKES THE RESTING HEIGHT MEAN ANYTHING. Miss one and the deadlock comes back through
       whichever body was left counted -- so the count is pinned, not merely the presence. */
    expect(PANEL.match(/\{\.\.\.STICKY_OPTIONAL\}/g) ?? []).toHaveLength(3);
  });

  it("keeps #828's fold, because only its trigger was wrong", () => {
    /* The rule "pinned means collapsed" is not withdrawn. `condensed` now means "the bar has stuck and
       travelled" rather than "the bar was short enough on the first frame", so a player ARRIVING at Buy
       Trains sees the depot open -- which is what was asked for -- and it folds as they scroll. */
    expect(PANEL).toContain("if (condensed) setBankOpen(false);");
    expect(PANEL).toContain("const [bankOpen, setBankOpen] = useState(true);");
  });
});

describe("two sources, side by side (design note #838)", () => {
  it("lays the panel out as a grid that stacks itself", () => {
    /* `auto-fit` + `minmax` rather than a breakpoint: the browser compares against the PANEL's width, which
       differs inside the sticky bar and outside it, so this file holds no opinion about viewports it cannot
       see. #813 settled that argument once already. */
    expect(PANEL).toContain('gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))"');
    expect(PANEL).toContain('display: "grid"');
    expect(PANEL).toContain('alignItems: "start"');
  });

  it("drops the ceiling caption and keeps the ceiling reason", () => {
    /* REPORTED: "there's a character string on the Buy line that reads: 'Current Train Limit 2 / 4 Room for 2
       more before the 4-train limit.' There's no need for the string."
       THE REASON IS NOT THE CAPTION. #700 split `purchaseCeiling`'s answer by MOOD -- a caption volunteered
       permanently, a reason asked for by hovering a dead option -- and only the volunteered half restates
       numbers already on the line. Deleting both would remove the answer to "why can I not pick 3". */
    expect(PANEL).not.toContain("ceilingCaption");
    expect(PANEL).toContain("ceilingReason");
  });

  it("renames the reference caret", () => {
    expect(PANEL).toContain(">Upcoming Trains<");
    expect(PANEL).not.toContain(">Later trains<");
  });
});

const PHASE: GamePhase = {
  tier: "4",
  label: "Phase: 4 (Green)",
  tint: "green",
  depotRemaining: 1,
  shiftImminent: true,
  known: true,
  trainLimit: 3,
  shiftWarning: "Buying the last 4-train starts Phase 5 and rusts every 3-train.",
  rustingTier: "3",
  purchasesUntilPhaseChange: 2,
  purchasesUntilRust: 2,
} as GamePhase;

const tier = (t: string, trainLimit: number): DepotTier =>
  ({ tier: t, cost: 0, total: null, remaining: null, trainLimit, isCurrent: false, soldOut: false,
     rusted: false, rustedBy: null, rustPhaseLabel: null }) as unknown as DepotTier;
const DEPOT = [tier("2", 4), tier("3", 4), tier("4", 3), tier("5", 2), tier("6", 2)];

describe("purchaseWarnings (design note #839)", () => {
  it("names the rusting tier and how many buys away it is", () => {
    const [rust] = purchaseWarnings(PHASE, DEPOT);
    expect(rust.key).toBe("rust");
    expect(rust.label).toBe("Rust in 2 Buys: 3-Trains");
    expect(rust.imminent).toBe(false);
  });

  it("escalates on the last buy", () => {
    const warnings = purchaseWarnings({ ...PHASE, purchasesUntilRust: 1 }, DEPOT);
    expect(warnings[0].label).toBe("Rust Event: 3-Trains");
    expect(warnings[0].imminent).toBe(true);
  });

  it("says nothing about rust when nothing is scheduled to rust", () => {
    /* 5s, 6s and Diesels are permanent. A badge that appeared anyway would teach a player that this row
       means "a purchase is coming", which every row on it already means. */
    expect(purchaseWarnings({ ...PHASE, rustingTier: null }, DEPOT)).toHaveLength(1);
  });

  it("reads the next tier's own limit rather than a table of its own", () => {
    expect(limitAfterNextPhase(PHASE, DEPOT)).toBe(2);
    expect(limitAfterNextPhase({ ...PHASE, tier: "6" } as GamePhase, DEPOT)).toBeNull();
  });

  it("only calls a drop a drop", () => {
    /* 1830's limit only falls, but the badge CLAIMS a direction, so the comparison is made rather than
       assumed -- a variant that raised it would otherwise get a "reduction" badge announcing an increase. */
    const flat = [tier("4", 3), tier("5", 3)];
    expect(purchaseWarnings({ ...PHASE, tier: "4" }, flat).some((w) => w.key === "train-limit")).toBe(false);
  });

  it("puts rust before the limit drop", () => {
    /* Ordered by consequence, not by phase order: a rust destroys trains already paid for, a limit drop only
       forces a discard and only for a corporation at the ceiling. */
    expect(purchaseWarnings(PHASE, DEPOT).map((w) => w.key)).toEqual(["rust", "train-limit"]);
  });

  it("says nothing at all without a phase", () => {
    expect(purchaseWarnings(null, DEPOT)).toEqual([]);
  });
});

describe("the warnings are read, not hovered", () => {
  it("removes the phase badge's tooltip at both render sites", () => {
    /* ASKED: "Keeping with our policy of not hiding critical information in hover tooltips, let's add Rust
       Event AND Train Limit Reduction to the warning badges. The Phase Change can stay and have its tooltip
       removed." #806 withdrew a tooltip from this same bar on the same grounds.
       BOTH SITES, because the bar renders this rail twice -- the condensed form and the full one -- and a
       fix applied to one of two copies is how the two come to disagree (#391). */
    expect(BAR).not.toContain("phase?.shiftWarning");
    expect(BAR.match(/Phase Shift Imminent/g) ?? []).toHaveLength(2);
    expect(BAR.match(/buyWarnings\.map/g) ?? []).toHaveLength(2);
  });

  it("carries the whole sentence in aria-label rather than in a title", () => {
    /* NOT A TOOLTIP BY ANOTHER NAME. `aria-label` is read INSTEAD of the visible label by a screen reader,
       for a reader who cannot see the badge at all -- it is not a second tier of information gated behind a
       hover, which is the thing being removed. */
    expect(BAR).toContain("aria-label={warning.detail}");
    expect(BAR).not.toContain("title={warning.detail}");
  });

  it("does not re-derive urgency beside the rule that owns it", () => {
    // `phaseAlertLevel` owns HOW LOUD (#7); `purchaseWarnings` owns WHAT. Two escalations would drift.
    const warnings = strip(read("utils/purchaseWarnings.ts"));
    expect(warnings).not.toContain("phaseAlertLevel");
    expect(warnings).not.toContain("depotRemaining");
  });
});

// ==================================================================
//  DESIGN NOTE 851 (harness): THE BAR STOPPED TRAVELLING, MID-DECISION
// ==================================================================
//
// REPORTED: "when my corporation had insufficient funds to buy another train, the sticky panel jumped to its
// fixed position up top. It doesn't need to do that."
//
// AN INSUFFICIENT TREASURY ADDS CONTENT: the refusal sentence, and #751c's Emergency Train Purchase button.
// #758 gave the bar a `ResizeObserver` precisely so any height change re-asks whether it may pin, and listed
// this case as a feature -- "a longer refusal message wrapping to three lines". The bar crossed 50%, `mayPin`
// went false, `position: sticky` became `position: static`, and a bar stuck at the top snapped back to its
// place in the document.
//
// #828 HAD ALREADY WRITTEN THE DISTINCTION and nothing enforced it: a table a player DELIBERATELY opened may
// unpin the bar; the bar unpinning by surprise is a different event, "which is what was reported twice".
// Three times now, and the difference is measurable without guessing at intent -- deliberate expansion blows
// past the point where content is unreachable, and a sentence plus a button does not.

describe("shouldReleasePin", () => {
  it("holds the pin through an ordinary growth", () => {
    /* THE REPORT, AS A NUMBER. A 300px bar in a 650px viewport is 46%; the refusal sentence and the emergency
       button take it to about 55%, which the OLD test failed and this one does not. Nothing is out of reach
       at 55%, so nothing needed to move. */
    expect(shouldReleasePin(300, 650, 0)).toBe(false);
    expect(shouldReleasePin(360, 650, 0)).toBe(false);
  });

  it("releases when the bar is genuinely in the way", () => {
    // #758's case: a roster of eight operating corporations, opened on purpose, with the page beneath it lost.
    expect(shouldReleasePin(600, 650, 0)).toBe(true);
  });

  it("counts the sticky offset against the usable height", () => {
    // The bar sits AT `stickyTop`, so the space it can occupy starts below it -- #810's arithmetic.
    expect(shouldReleasePin(430, 650, 120)).toBe(true);
    expect(shouldReleasePin(400, 650, 0)).toBe(false);
  });

  it("does not release on a rect nobody has laid out", () => {
    /* `canPinWithoutTrapping`'s "unmeasurable means stick", from the other side: the first paint must not
       drop a pin on the strength of a zero. */
    expect(shouldReleasePin(0, 650, 0)).toBe(false);
    expect(shouldReleasePin(Number.NaN, 650, 0)).toBe(false);
    expect(shouldReleasePin(300, 0, 0)).toBe(false);
  });

  it("sits well above the pin threshold, which is the whole point", () => {
    /* TWO THRESHOLDS BECAUSE THERE ARE TWO QUESTIONS. Equal values would be a boundary to flip on, which is
       the failure `shouldCondenseSticky` avoids with `STICKY_RELEASE_SLACK_PX`. */
    expect(STICKY_RELEASE_VIEWPORT_SHARE).toBeGreaterThan(STICKY_MAX_VIEWPORT_SHARE);
  });
});

describe("the bar asks the question that applies to it", () => {
  it("tests trapping when pinned and comfort when not", () => {
    expect(BAR).toContain("const wasPinned = mayPinRef.current;");
    expect(BAR).toContain("? !shouldReleasePin(rect.height, window.innerHeight, stickyTop)");
    expect(BAR).toContain(": canPinWithoutTrapping(restingHeight(node), window.innerHeight, stickyTop);");
  });

  it("reads the previous answer from a ref, not from state", () => {
    /* `measure` runs on every scroll frame and the closure is rebuilt only when the effect re-subscribes, so
       `mayPin` inside it would be whatever it was at subscription time. The same reason `isMyTurnRef` exists
       three files over. */
    expect(BAR).toContain("const mayPinRef = React.useRef(true);");
    expect(BAR).toContain("mayPinRef.current = pinnable;");
  });

  it("keeps #758's subscription, because the measurement still has to happen", () => {
    // The observer was never the bug -- what it triggered was. Removing it would bring #758 straight back.
    expect(BAR).toContain("new ResizeObserver(() => schedule())");
  });
});
