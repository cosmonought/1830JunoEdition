/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1033 (harness): THE COUNTDOWN TELLS THE TRUTH ABOUT THE VARIANT
// ==================================================================
//
// TWO REPORTS, ONE FILE, because both are about a surface that describes state rather than changes it.
//
// REPORTED (1): "The UI text for the Rust warning badge is inaccurate for the Gentle Rust variant. It
// currently says 'Rusts in X buys', but this variant delays rusting until after the phase-change train is
// bought AND the reprieved trains complete their final run." With the wording ruled: "'Rusts Soon:' (when 2
// buys away) and 'Rust Imminent:' (when 1 buy away), and 'Final Run:' (when a train reaches its final run)",
// and the post-purchase badge reading "Final Run: [type]-trains".
//
// REPORTED (2): "The Game Ledger currently forces players to scroll through a massive vertical list", fixed as
// three collapsible panels defaulting to collapsed.
//
// THE COPY IS DRIVEN AND THE LAYOUT IS SCANNED, which is this repo's standing division: `purchaseWarnings` is
// a pure function with a defined answer for every phase, so its strings are compared to the ruled ones rather
// than looked for in source. The ledger and the action bar are JSX and there is no component renderer in this
// tree, so the strongest available claim about them is what the file says it renders.

export {};

const { purchaseWarnings } = require("./purchaseWarnings") as typeof import("./purchaseWarnings");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const BAR = readStripped("panels/ContextualActionBar.tsx");
const LEDGER = readStripped("components/FinancialLedger.tsx");
const APP = readStripped("App.tsx");

/* The fixture `buyTrainsPanel.test.ts` uses, kept in step deliberately: two files describing one function
   from two different phases is how a rule comes to be asserted twice and differently.
   `NonNullable`, NOT the bare parameter type. `purchaseWarnings` takes `GamePhase | null`, so casting to the
   parameter itself makes `PHASE` nullable -- and spreading a nullable value turns every property optional,
   which is a type error at each `{ ...PHASE }` below. Jest never saw it (Babel strips types without checking
   them) and `tsc` did. */
type Phase = NonNullable<Parameters<typeof purchaseWarnings>[0]>;

const PHASE = {
  tier: "4",
  label: "Phase 4",
  trainLimit: 3,
  rustingTier: "3",
  purchasesUntilRust: 2,
  purchasesUntilPhaseChange: 2,
} as unknown as Phase;

const tier = (t: string, trainLimit: number) =>
  ({
    tier: t,
    cost: 0,
    total: null,
    remaining: null,
    trainLimit,
    isCurrent: false,
    soldOut: false,
    rusted: false,
    rustedBy: null,
    rustPhaseLabel: null,
  }) as unknown as Parameters<typeof purchaseWarnings>[1][number];

const DEPOT = [tier("2", 4), tier("3", 4), tier("4", 3), tier("5", 2), tier("6", 2)];
const at = (buys: number, gentle: boolean) =>
  purchaseWarnings(
    { ...PHASE, purchasesUntilRust: buys, purchasesUntilPhaseChange: buys },
    DEPOT,
    gentle,
  );
const rustOf = (buys: number, gentle: boolean) =>
  at(buys, gentle).find((w) => w.key === "rust")!;

/* ------------------------------------------------------------------ */
/* Item 1a -- the countdown's wording                                 */
/* ------------------------------------------------------------------ */

describe("the rust countdown says what this variant actually does", () => {
  it("reads 'Rusts Soon' two buys out under Gentle Rust", () => {
    expect(rustOf(2, true).label).toBe("Rusts Soon: 3-trains");
  });

  it("reads 'Rust Imminent' one buy out under Gentle Rust", () => {
    expect(rustOf(1, true).label).toBe("Rust Imminent: 3-trains");
  });

  it("leaves the standard wording exactly as it was", () => {
    /* THE CONTROL, AND THE HALF OF THIS CHANGE THAT COULD DO REAL DAMAGE. Most tables play standard rules,
       where "Rusts in 1 Buy" is true and is the sentence a president acts on. A variant-shaped rewrite that
       leaked into the default would mislead every other game to fix one. #889's strings, verbatim. */
    expect(rustOf(2, false).label).toBe("Rusts in 2 Buys: 3-train");
    expect(rustOf(1, false).label).toBe("Rusts in 1 Buy: 3-train");
  });

  it("defaults to the standard wording when nobody says", () => {
    /* #232's RULE APPLIED TO A FLAG. A caller that has not been taught the parameter must not be treated as
       "playing the variant" -- and the two-argument call is what every existing caller and fixture uses. */
    expect(purchaseWarnings({ ...PHASE }, DEPOT).find((w) => w.key === "rust")!.label).toBe(
      "Rusts in 2 Buys: 3-train",
    );
  });

  it("stops promising a destruction the variant postpones", () => {
    /* THE ACTUAL INACCURACY, in the field a screen reader gets. The badge is short; `detail` is where the
       whole fact lives (#839), so it is where "destroys every 3-Train in play" was most misleading. */
    expect(rustOf(1, true).detail).toContain("final run");
    expect(rustOf(1, true).detail).not.toContain("destroys every");
    expect(rustOf(1, false).detail).toContain("destroys every 3-Train in play");
  });
});

/* ------------------------------------------------------------------ */
/* Item 1b -- the pulse                                               */
/* ------------------------------------------------------------------ */

describe("the pulse is spent on the event that is actually happening", () => {
  it("keeps the rust badge red but still under the variant", () => {
    /* ASKED: "remove or greatly reduce the fading/flashing/pulsing from the 2-buys-away and 1-buy-away badges
       so that the gentle rust fade pulse is more meaningful?"
       BOTH HALVES ASSERTED TOGETHER, because the tempting implementation is to suppress `imminent` -- which
       would take the RED with it and quietly demote a warning that is still the most serious thing in the
       row. One field answering two questions is #732's rule; `pulses` exists so it does not have to. */
    expect(rustOf(1, true).imminent).toBe(true);
    expect(rustOf(1, true).pulses).toBe(false);
  });

  it("still pulses the rust badge under standard rules", () => {
    // Nothing is postponed there: the next purchase really does destroy the train.
    expect(rustOf(1, false).pulses).toBe(true);
  });

  it("leaves the train-limit badge pulsing under both", () => {
    /* THE BOUNDARY, AND THE CASE THAT STOPS THIS BECOMING "the variant makes the bar quieter". Gentle Rust
       postpones rust and postpones nothing about the limit -- the trim fires the instant the phase turns, and
       a gently-rusted train is the first thing it takes (#979). Softening this warning would remove a pulse
       from an event that genuinely is imminent. */
    const limitOf = (gentle: boolean) => at(1, gentle).find((w) => w.key === "train-limit")!;
    expect(limitOf(true).pulses).toBe(true);
    expect(limitOf(false).pulses).toBe(true);
  });

  it("is the field the bar animates on", () => {
    /* #1006's LESSON. A flag the rendering caller never reads is not a flag, and BOTH badge rows have to read
       it -- the bar renders this list twice, and fixing one of two identical call sites is the half-fix this
       codebase keeps producing. */
    expect(BAR.split('warning.pulses ? "app-phase-shift-critical" : undefined').length - 1).toBe(2);
    expect(BAR).not.toContain('warning.imminent ? "app-phase-shift-critical"');
  });

  it("still takes its colour from imminence", () => {
    /* THE CONTROL ON THE SPLIT. `pulses` was carved out of `imminent`, so the thing to check is that the
       original consumer did not follow it across. */
    expect(
      BAR.split("warning.imminent ? styles.phaseShiftBadgeCritical : styles.phaseShiftBadgeWarn")
        .length - 1,
    ).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Item 1c -- the post-purchase badge                                 */
/* ------------------------------------------------------------------ */

describe("the badge becomes a Final Run notice once the trains are marked", () => {
  it("names the state the trains are actually in", () => {
    /* RULED: "the badge must dynamically update to read 'Final Run: [type]-trains'." */
    const D = String.fromCharCode(36);
    expect(BAR).toContain("Final Run: " + D + "{tiers.map(");
    expect(BAR).toContain(D + "{tier}-trains");
  });

  it("no longer says 'Rust Imminent' here", () => {
    /* THE COLLISION THIS AVOIDS, and the reason #1004's verbatim label could not simply stay. #1033 gives the
       PRE-purchase countdown "Rust Imminent:" at one buy away. Two badges, identical words, two different
       states -- one buy from the trigger versus condemned and running its last -- is the #891 shape. */
    const D = String.fromCharCode(36);
    expect(BAR).not.toContain("Rust Imminent: " + D + "{tiers.map(");
    expect(rustOf(1, true).label).toBe("Rust Imminent: 3-trains");
  });

  it("keeps the badge derived from the marks rather than from the depot", () => {
    /* #1004'S ACTUAL SUBJECT, UNCHANGED BY THE RENAME. The depot has moved past this tier by the time the
       badge is needed, so the corporation's own marks are the only surviving record. A relabelling that also
       moved the source would reintroduce the disappearing badge #1004 was reported for. */
    expect(BAR).toContain("const marks = activeCorporation?.reprievedTrains ?? [];");
    expect(BAR).toContain("if (marks.length === 0) return null;");
  });

  it("keeps the final-run pulse it shares with the chips", () => {
    /* THE PULSE THIS BATCH IS CLEARING SPACE FOR. Damping the countdown is only worth anything if this one
       still fires -- and #755's argument for one shared class over two hand-tuned ones stands. */
    expect(BAR).toContain('className="app-train-final-run"');
  });

  it("is told which variant the table is playing", () => {
    /* THE WIRING, and the shortcut it must not take. Deriving `gentleRust` from `reprievedTrains.length > 0`
       type-checks and is empty in exactly the case it is consulted for -- marks exist only AFTER the trigger
       is bought, and both strings this changes are shown before that. #1006's shape. */
    expect(APP).toContain("gentleRust={resolveVariants(gameState?.variants).gentleRust}");
    expect(BAR).toContain("purchaseWarnings(phase ?? null, depot, gentleRust)");
  });
});

/* ------------------------------------------------------------------ */
/* Item 2 -- the ledger folds away                                    */
/* ------------------------------------------------------------------ */

describe("the Game Ledger is three collapsed panels", () => {
  it("uses a disclosure element for each of the three sections", () => {
    /* RULED: "Wrap the Bank, Player, and Corporation sections into three separate collapsible accordion
       panels (e.g., using HTML <details>/<summary>)". */
    expect(LEDGER.split("<details ").length - 1).toBe(3);
    expect(LEDGER.split("</details>").length - 1).toBe(3);
    expect(LEDGER.split("<summary ").length - 1).toBe(3);
  });

  it("leaves no section un-collapsed", () => {
    /* THE HALF-CONVERSION THIS CATCHES. Three panels and one bare `<section>` is the state a partial edit
       leaves behind, and it reads as a rendering fault rather than as a deliberate exception. */
    expect(LEDGER).not.toContain("<section ");
  });

  it("defaults to collapsed", () => {
    /* RULED: "Set them to default to a collapsed state to save screen real estate."
       ASSERTED AS THE ABSENCE OF `open`, which is what `<details>` means by collapsed -- there is no state to
       initialise and therefore none to get wrong on a remount. A control that hard-coded `open` would satisfy
       every other case in this describe. */
    expect(LEDGER).not.toContain("<details open");
    expect(LEDGER).not.toContain("open={");
  });

  it("keeps each panel's colour coding on the panel", () => {
    /* #9's SECTION COLOURS ARE WHAT TELL THE THREE APART at a glance, and they are the only thing doing that
       once the bodies are shut -- a row of three identical grey summaries would be a worse ledger than the
       long one. */
    expect(LEDGER).toContain("...styles.section, ...styles.sectionBank");
    expect(LEDGER).toContain("...styles.section, ...styles.sectionPlayers");
    expect(LEDGER).toContain("...styles.section, ...styles.sectionCorps");
  });

  it("keeps the titles as the summaries rather than beside them", () => {
    /* A HEADING NESTED IN A SUMMARY puts the title into the accessibility tree twice -- once as the
       disclosure's label, once as a heading -- and a summary with a heading still inside the body would leave
       the panel unlabelled when shut. */
    expect(LEDGER).toContain("Bank Treasury");
    expect(LEDGER).toContain("Player Assets");
    expect(LEDGER).toContain("Corporation Assets");
    expect(LEDGER).not.toContain("<h3 ");
  });

  it("marks the summary as something to click", () => {
    // Without a cursor change the title looks like a heading that happens to be clickable.
    expect(LEDGER).toContain("sectionSummary");
    expect(LEDGER).toContain('cursor: "pointer"');
  });
});
