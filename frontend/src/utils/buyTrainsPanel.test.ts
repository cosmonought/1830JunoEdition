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
    /* #837's PROPERTY, WHICH #863 DID NOT CHANGE: the question "may this bar pin" is asked of the resting
       height, because asking it of a subtree whose height the answer controls is a loop. What #863 changed is
       WHICH FUNCTION ASKS -- the return edge now uses the trapping test rather than the comfort one -- so the
       needle moves and the rule stays. The old form read
         expect(BAR).toContain('canPinWithoutTrapping(restingHeight(node), window.innerHeight, stickyTop)'); */
    expect(BAR).toContain("wasPinned ? rect.height : restingHeight(node)");
    expect(BAR).not.toContain("canPinWithoutTrapping(rect.height");
  });

  it("still measures the clearance from the rect", () => {
    /* TWO QUESTIONS, TWO NUMBERS, and collapsing them would be the opposite mistake. "Can I pin" is about
       the resting form; "how much am I covering right now" is about the pixels on screen, which is what a
       scrolled-to panel has to clear (#810). */
    expect(BAR).toContain("Math.round(stickyTop + rect.height)");
  });

  it("marks exactly the bodies a player can still fold (design note #860)", () => {
    /* THE MARK IS WHAT MAKES THE RESTING HEIGHT MEAN ANYTHING, and it must not outlive the caret it belongs
       to. #859 gave the bank a heading instead of a disclosure and #860 deleted its table outright, so two of
       the three marks went with them; what remains is the Train Roster and the corporation roster, both of
       which a player opens on purpose.
       A MARK ON A BODY NOBODY CAN FOLD WOULD BE THE WORSE BUG: the bar would claim a resting height it can
       never reach and pin at a size that traps the page -- #720's original report wearing #837's fix. */
    expect(PANEL.match(/\{\.\.\.STICKY_OPTIONAL\}/g) ?? []).toHaveLength(2);
  });

  it("no longer folds the bank at all (design note #859)", () => {
    /* #837 MADE THE TRIGGER HONEST AND #859 REMOVED THE NEED FOR IT. That pass made `condensed` mean "the bar
       has stuck and travelled"; a player already scrolled when the step arrived still met a folded bank, and
       chasing that with a third trigger would have been a third guess at a question the LAYOUT answers -- at
       half the bar's width the depot section costs a column, not a screen.
       ASSERTED AS AN ABSENCE because the fold is exactly what a future tidy-up would reinstate. */
    expect(PANEL).not.toContain("setBankOpen");
    /* SCOPED TO THE BANK SECTION. `accordionHeader` is still the CORPORATION roster's caret and must stay --
       eight operating corporations is #758's case and (c)'s own caveat, "the Buy from Corps table might get
       large with 8 corps". A file-wide absence would have deleted the wrong caret to prove the right one,
       which is the proxy-assertion mistake #776's harness made. */
    /* SLICED FROM THE RAW FILE, then stripped: the section banners are JSX COMMENTS, and `PANEL` above has
       had those removed for #490a's reason. Slicing the stripped copy on a comment anchor finds nothing and
       returns an empty string, which passes every `not.toContain` beside it -- the vacuity this session has
       now caught six times. The length guard is what turned it into a failure instead. */
    const raw = read("components/TrainPurchasePanel.tsx");
    const bank = strip(
      raw.slice(
        raw.indexOf("{/* ================= BANK ================= */}"),
        raw.indexOf("{/* ================= CORPORATION ================= */}"),
      ),
    );
    expect(bank.length).toBeGreaterThan(0);
    expect(bank).not.toContain("accordionHeader");
    expect(bank).toContain("styles.sectionHeading");
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

  it("names the caret for what it actually holds (design note #860)", () => {
    /* "Later trains" (#719) -> "Upcoming Trains" (#835) -> "Train Roster". REPORTED: "'Upcoming Trains' is not
       quite right either because it lists old trains, their bank supply, price, and rust condition."
       AND IT LISTS MORE OF THEM NOW: with the purchasable tier's own table gone, this is the whole depot. */
    expect(PANEL).toContain(">Train Roster<");
    expect(PANEL).not.toContain(">Upcoming Trains<");
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
    /* BOTH COUNTS MOVE, and the first draft of this line moved only `purchasesUntilRust` -- which was
       harmless while each warning judged its own urgency and became a real fixture bug at #867, when the
       escalation started coming from `phaseAlertLevel` (which reads `purchasesUntilPhaseChange`).
       THEY ARE ONE FIGURE IN REALITY: `derivePhase` sets both to `depotRemaining + 1`. A fixture that lets
       them diverge is describing a state the game cannot be in. */
    const warnings = purchaseWarnings(
      { ...PHASE, purchasesUntilRust: 1, purchasesUntilPhaseChange: 1 },
      DEPOT,
    );
    expect(warnings[0].label).toBe("Rust Event: 3-Trains");
    expect(warnings[0].imminent).toBe(true);
  });

  it("takes its urgency from the shared alert, not from its own count", () => {
    /* THE GAP A NEGATIVE CONTROL FOUND. Mutating `imminent` back to a locally-derived `buys <= 1` left every
       test green, because the two counts agree in every honest fixture -- so the mutation was equivalent
       under test while being exactly the drift #867 exists to prevent.
       THIS IS THE CASE THAT TELLS THEM APART: a phase whose rust count says "now" while the shared countdown
       says "not yet". It cannot arise from `derivePhase` today, which is precisely why it is worth pinning --
       the module must answer to ONE authority, so that if the two figures ever separate the badges still
       agree with each other and with the bar. */
    const divergent = purchaseWarnings(
      { ...PHASE, purchasesUntilRust: 1, purchasesUntilPhaseChange: 2 },
      DEPOT,
    );
    expect(divergent.length).toBeGreaterThan(0);
    divergent.forEach((warning) => expect(warning.imminent).toBe(false));
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
       fix applied to one of two copies is how the two come to disagree (#391).
       SUPERSEDED IN PART BY #868, and the superseded line is kept because it records what the row used to
       hold: `expect(BAR.match(/Phase Shift Imminent/g) ?? []).toHaveLength(2);`. That badge is gone -- it
       named an EVENT rather than a consequence, and the warnings beside it already say what any given shift
       will do. What survives unchanged is the property this test was really about: the tooltip is gone, both
       render sites are treated alike, and neither has grown a `title` back. */
    expect(BAR).not.toContain("phase?.shiftWarning");
    expect(BAR).not.toContain("Phase Shift Imminent");
    expect(BAR.match(/buyWarnings\.map/g) ?? []).toHaveLength(2);
  });

  it("carries the whole sentence in aria-label rather than in a title", () => {
    /* NOT A TOOLTIP BY ANOTHER NAME. `aria-label` is read INSTEAD of the visible label by a screen reader,
       for a reader who cannot see the badge at all -- it is not a second tier of information gated behind a
       hover, which is the thing being removed. */
    expect(BAR).toContain("aria-label={warning.detail}");
    expect(BAR).not.toContain("title={warning.detail}");
  });

  it("asks the rule that owns urgency instead of re-deriving it", () => {
    /* ==================================================================
        THIS ASSERTION WAS ENFORCING THE BUG (design note #867)
       ==================================================================
       IT READ `expect(warnings).not.toContain("phaseAlertLevel")`, under the note "`phaseAlertLevel` owns HOW
       LOUD (#7); `purchaseWarnings` owns WHAT. Two escalations would drift."
       THE PRINCIPLE IS RIGHT AND THE TEST HAD IT BACKWARDS. Keeping the authority OUT of this module did not
       give it one owner, it gave it two -- `phaseAlertLevel` deciding the phase badge and a local `buys <= 1`
       deciding these, on a different threshold. That is the drift the note feared, written down as a rule
       that produced it. Reported as "Rust and Limit both appear in orange/amber at '3 buys' left whereas the
       Phase Change shows up in orange/amber at '2 buys.'"
       SO THE ASSERTION FLIPS: the module must CALL the authority. `depotRemaining` stays forbidden, which is
       the part that was always right -- reaching past the helper to the raw stock would be a second
       implementation of the same judgement. */
    const warnings = strip(read("utils/purchaseWarnings.ts"));
    expect(warnings).toContain("phaseAlertLevel(phase)");
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
  it("tests the actual height when pinned and the resting height when not", () => {
    /* ==================================================================
        SUPERSEDED BY #863, AND THE OLD FORM IS THE POINT
       ==================================================================
       This was "tests trapping when pinned and comfort when not" and read:
         expect(BAR).toContain('? !shouldReleasePin(rect.height, window.innerHeight, stickyTop)');
         expect(BAR).toContain(': canPinWithoutTrapping(restingHeight(node), window.innerHeight, stickyTop);');
       It asserted #851's split faithfully and the split had a hole in it: a bar released by a fold could not
       return, because the edge back in demanded 50% of a bar that had been sticky at up to 80%. Reported as
       4d and again as 5d.
       THE SURVIVING HALF IS THE HEIGHT SOURCE, which is where the hysteresis actually lives -- a pinned bar
       is judged on the pixels on screen, an unpinned one on its resting form, and a `STICKY_OPTIONAL` fold is
       the difference between them. One threshold now governs both edges. */
    expect(BAR).toContain("const wasPinned = mayPinRef.current;");
    expect(BAR).toContain("wasPinned ? rect.height : restingHeight(node)");
    expect(BAR).toContain("const pinnable = !shouldReleasePin(");
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

describe("the panel gets the bar's width to divide (design note #859)", () => {
  it("claims its own row in the bar's wrapping flex", () => {
    /* REPORTED: "the current version has two columns appear in half the width of the Action Bar, when
       actually each column should be half the width of the Action Bar."
       `styles.actionBar` IS A WRAPPING FLEX ROW and this wrapper had no style at all, so it was a flex item
       sized to its own content, sharing a line with the corporation card. #838's grid was dividing a
       fragment. `flexBasis: 100%` is how a wrapping flex container is told "this child gets a line". */
    expect(BAR).toContain("<div ref={stepPanelRef} style={styles.stepPanelRow}>");
    const styles = (() => {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      return fs.readFileSync(path.join(__dirname, "..", "styles", "appStyles.ts"), "utf8");
    })();
    expect(styles).toContain('stepPanelRow: { flexBasis: "100%", width: "100%", minWidth: 0 }');
  });

  it("makes the panel itself fill that row", () => {
    // A full-width row divided by a panel that shrink-wraps is the same bug one level down.
    /* THE END ANCHOR IS SEARCHED FROM THE START, and both are proven present. `rootCondensed` appears in the
       JSX above the style sheet, so a bare `indexOf` gave a backwards range and an empty slice -- which the
       length guard caught rather than passing silently. Seventh time this session. */
    const start = PANEL.indexOf("  root: {");
    expect(start).toBeGreaterThan(-1);
    const end = PANEL.indexOf("rootCondensed:", start);
    expect(end).toBeGreaterThan(start);
    const root = PANEL.slice(start, end);
    expect(root).toContain('width: "100%"');
    expect(root).toContain('gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))"');
  });
});

describe("the depot's stock moved to the buy line (design note #860)", () => {
  it("names it where the quantity is chosen", () => {
    /* ASKED: "replace 'Current Train Limit 2 / 3' on the line with the Buy button with the remaining bank
       quantity". BESIDE rather than INSTEAD: #294's "two numbers, two subjects" -- one counts cardboard in
       the bank, the other caps a corporation's holdings. */
    expect(PANEL).toContain("In the Bank Depot");
    expect(PANEL).toContain("Current Train Limit");
  });

  it("shows unlimited as unlimited, not as a number", () => {
    // Diesels have no ceiling. "0" and "as many as you like" must not look alike.
    expect(PANEL).toContain("nextTier.remaining === null");
  });

  it("has no purchasable-tier table left to restate it", () => {
    expect(PANEL).not.toContain("availableTiers");
  });
});

describe("the bar tells the player when it stops travelling (design note #861)", () => {
  it("scrolls to the bar on the unpin transition only", () => {
    /* REPORTED: "when this pin happens ... the player is auto-scrolled to the top of the Action Bar,
       otherwise it seems like the Action Bar mysteriously disappeared and they are interrupted mid-task."
       ON THE TRANSITION ONLY: `measure` runs on every frame of a drag, and a scroll handler that scrolls is
       a loop. `wasPinned && !pinnable` is the edge, not the state. */
    expect(BAR).toContain("if (wasPinned && !pinnable) node.scrollIntoView(");
    expect(BAR).not.toContain("if (!pinnable) node.scrollIntoView(");
  });

  it("reports what the bar is actually doing, not only what the rule says", () => {
    /* Design note #861a, for the half of the report I could not reproduce by reading: "when I closed that
       Upcoming trains section, the Action Bar stayed pinned instead of becoming sticky again." `verdict` is
       the rule's answer; `now` is the observed state. If a playtest shows them disagreeing, the fault is
       between the measurement and the style. */
    expect(BAR).toContain("? \"pinned\" : \"travelling\"");
    /* `String.fromCharCode(36)` because a literal `${` in a plain string trips `no-template-curly-in-string`
       -- the rule reads the literal, not the intent. Fourth time this session. */
    expect(BAR).toContain("now " + String.fromCharCode(36) + "{now}");
  });
});
