/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1035 (harness): THE CLOSURE WARNING THAT IS NOT A BADGE
// ==================================================================
//
// REQUESTED: "Add a new warning badge to the Action Bar, styled similarly to the existing Rust and Train Limit
// warnings ... If Phase 5 has not yet been reached, display a badge that reads 'Privates Close: 5-train'."
//
// I BUILT THAT AND WITHDREW IT, and the first describe below is what stopped it. #867 exists because a player
// reported badges on disagreeing countdowns; #868's coverage table has tier 2 earning no badges at all,
// because its phase change takes nothing away. A badge counting to a tier three phases off breaks both, and
// seven existing assertions failed the moment it landed -- which is the harness doing its job rather than
// getting in the way.
//
// RULED INSTEAD, after the objection was put: "Could we just make the PC lines/chips on the player cards (in
// Stock Round and Operating Round) and on the player information on the Game Ledger using the amber/red alert
// system when two/one buy away from closure?" Plus, separately: "I don't think we have added the ... 'Closes
// on purchase of first 5-train' on the Auction Round PC cards to flag this to players at the start."
//
// SO THE ARITHMETIC IS DRIVEN AND THE PLACEMENT IS SCANNED, this repo's standing division: `privateClosureAlert`
// is pure and has an answer for every phase, while "which surfaces read it" is a claim about wiring that jsdom
// cannot check for a tree with no component renderer.

export {};

const { privateClosureAlert, privateClosureTier, purchasesUntilTier, purchaseWarnings } =
  require("./purchaseWarnings") as typeof import("./purchaseWarnings");
const { readStripped } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const PILLS = readStripped("components/PrivateCompanyPills.tsx");
const CARDS = readStripped("components/PlayerCards.tsx");
const LEDGER = readStripped("components/FinancialLedger.tsx");
const SUBPANEL = readStripped("components/ContextualSubPanel.tsx");
const AUCTION = readStripped("components/WaterfallAuctionDashboard.tsx");
const WARNINGS = readStripped("utils/purchaseWarnings.ts");

type Phase = NonNullable<Parameters<typeof privateClosureAlert>[0]>;
type Tier = Parameters<typeof purchasesUntilTier>[1][number];

const tier = (t: string, remaining: number | null) =>
  ({
    tier: t,
    cost: 0,
    total: null,
    remaining,
    trainLimit: 3,
    isCurrent: false,
    soldOut: false,
    rusted: false,
    rustedBy: null,
    rustPhaseLabel: null,
  }) as unknown as Tier;

const phaseAt = (t: string) =>
  ({ tier: t, label: `Phase ${t}`, trainLimit: 3 }) as unknown as Phase;

/** A depot with `fours` 4-trains left and everything cheaper sold out. */
const depotWith = (twos: number, threes: number, fours: number) => [
  tier("2", twos),
  tier("3", threes),
  tier("4", fours),
  tier("5", 2),
  tier("6", 2),
];

/* ------------------------------------------------------------------ */
/* The badge that is deliberately absent                              */
/* ------------------------------------------------------------------ */

describe("the warning row is left alone", () => {
  it("adds no privates badge to the row", () => {
    /* THE WITHDRAWAL, PINNED. #868's coverage table asserts each tier earns exactly a named set of keys and
       #867 asserts the row is silent outside the two-buy window; a privates badge breaks both. This case is
       what makes the absence deliberate rather than an oversight the next reader "fixes". */
    const all = purchaseWarnings(phaseAt("4"), depotWith(0, 0, 1)).map((w) => w.key);
    expect(all).not.toContain("privates");
  });

  it("keeps the union closed against one", () => {
    // A widened type with nothing constructing the member is an invitation. Asserted on RAW source (#490a).
    expect(WARNINGS).toContain('key: "rust" | "train-limit";');
  });
});

/* ------------------------------------------------------------------ */
/* The countdown                                                      */
/* ------------------------------------------------------------------ */

describe("counting to a named tier rather than to the next one", () => {
  it("sums every cheaper tier and adds the purchase that turns the phase", () => {
    /* THE DEPOT SELLS CHEAPEST-FIRST, so reaching 5 means clearing 2s, 3s and 4s and then buying one 5.
       6 + 5 + 4 + 1 = 16, which is the figure a fresh game would show. */
    expect(purchasesUntilTier("5", depotWith(6, 5, 4))).toBe(16);
    expect(purchasesUntilTier("5", depotWith(0, 0, 1))).toBe(2);
    expect(purchasesUntilTier("5", depotWith(0, 0, 0))).toBe(1);
  });

  it("ignores stock at or above the target tier", () => {
    /* THE 5s AND 6s IN THE FIXTURE MUST NOT COUNT. A sum over the whole depot would report 20 here and the
       badge would never reach zero -- the off-by-a-lot version of this bug. */
    expect(purchasesUntilTier("5", depotWith(0, 0, 2))).toBe(3);
  });

  it("refuses to guess when a cheaper tier cannot say", () => {
    // #232: an unknown count would silently under-report, and a player plans against this figure.
    expect(purchasesUntilTier("5", [tier("2", null), tier("3", 1), tier("4", 1)])).toBeNull();
  });

  it("reads the closing tier off the schedule rather than a literal", () => {
    /* #736's LESSON: this rule once lived in a caption while the code did something else. `applyPhaseChange`
       asks `closesPrivateCompanies`; so does this. A "5" typed here would be a third statement of it. */
    expect(privateClosureTier()).toBe("5");
    expect(WARNINGS).toContain("TIER_ORDER.find((tier) => closesPrivateCompanies(tier))");
  });
});

/* ------------------------------------------------------------------ */
/* The alert level                                                    */
/* ------------------------------------------------------------------ */

describe("the alert escalates on the same schedule as everything else", () => {
  it("says nothing while the closure is far off", () => {
    /* THE HALF THAT KEEPS THIS QUIET. Sixteen buys out there is nothing to warn about, and a surface that
       went amber from turn one would be the badge's problem moved onto the chips. */
    expect(privateClosureAlert(phaseAt("2"), depotWith(6, 5, 4))).toBeNull();
    expect(privateClosureAlert(phaseAt("4"), depotWith(0, 0, 3))).toBeNull();
  });

  it("warns at two buys and escalates at one", () => {
    /* TWO AND ONE, matching `phaseAlertLevel` and therefore the rust and train-limit badges. A fourth
       schedule would be the exact fault #867 was reported for. */
    expect(privateClosureAlert(phaseAt("4"), depotWith(0, 0, 1))).toBe("warn");
    expect(privateClosureAlert(phaseAt("4"), depotWith(0, 0, 0))).toBe("critical");
  });

  it("goes silent permanently once the closure has happened", () => {
    /* RULED: "The moment the first 5-train is purchased and the private companies are cleared from the board,
       this badge must permanently disappear." Both halves are one event -- `applyPhaseChange` closes the
       privates in the transition that turns the phase -- so asking the phase asks about the closure itself.
       PERMANENT FALLS OUT OF `TIER_ORDER` being monotonic: there is no state that walks back to phase 4. */
    expect(privateClosureAlert(phaseAt("5"), depotWith(0, 0, 0))).toBeNull();
    expect(privateClosureAlert(phaseAt("6"), depotWith(0, 0, 0))).toBeNull();
    expect(privateClosureAlert(phaseAt("D"), depotWith(0, 0, 0))).toBeNull();
  });

  it("says nothing when there is no phase to place", () => {
    expect(privateClosureAlert(null, depotWith(0, 0, 0))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Where it is read                                                   */
/* ------------------------------------------------------------------ */

describe("every surface that draws a private reads the same alert", () => {
  it("derives it once in the shell", () => {
    /* ONE DERIVATION, NOT ONE PER CARD -- the division `outlook` and `depot` already follow. Components are
       handed a value rather than each reaching for `gameState`. */
    expect(APP).toContain("privateClosureAlert(currentPhase ?? null, depot)");
  });

  it("reaches the player cards in both rounds", () => {
    /* RULED: "the player cards (in Stock Round and Operating Round)". `PlayerCards` is rendered twice from the
       shell and both must be told -- fixing one of two identical call sites is the half-fix this codebase
       keeps producing, and a bare `toContain` would be satisfied by either. */
    expect(APP.split("privateClosureAlert={closureAlert}").length - 1).toBe(2);
  });

  it("colours the NAME and leaves the income alone", () => {
    /* ==================================================================
        THIS CASE ASSERTED THE OPPOSITE AND WAS WRONG
       ==================================================================
       IT READ "colours the INCOME rather than the whole row", on the reasoning that the per-OR income is
       "the figure that dies". Corrected on sight: "I don't like the color being on the income column -- the
       income is green until it's gone."
       AND THE INCOME HAS NOT CHANGED. A private two buys from closure pays exactly what it paid last round;
       recolouring the number claims otherwise. What is ending is the ASSET, so its NAME carries the warning
       -- which is also what the pills and the corporation chips already do, where the acronym is the whole
       chip. The correction made this file consistent with the two surfaces it was already describing.
       THE NEGATIVE HALF IS THE POINT: a control that recoloured the income again would pass a bare "the name
       escalates" assertion. */
    expect(CARDS).toContain("privateNameCritical");
    expect(CARDS).toContain("privateNameWarn");
    expect(CARDS).not.toContain("privateNumCritical");
    expect(CARDS).not.toContain("privateNumWarn");
    expect(CARDS).toContain("<td style={styles.privateNum}>${entry.income}</td>");
  });

  it("warns on a private with no rules text too", () => {
    /* THE BRANCH A ONE-SITE FIX WOULD MISS. A private whose `description` is null renders as a plain span
       rather than an expandable button, and would otherwise be the one row on the card that never warns --
       the same "fixed one of two identical sites" shape this batch's own wiring case guards against. */
    expect(CARDS.split("...closureInk").length - 1).toBe(2);
  });

  it("reaches the Ledger's player pills and its corporation chips", () => {
    /* RULED: "the player information on the Game Ledger". The corporation column is included because it is a
       SECOND hand-rolled chip renderer in the same file -- #423 records that two renderers for one thing is
       how they came to disagree -- and a corporation's privates close on the same purchase. */
    expect(LEDGER).toContain("closureAlert={closureAlert}");
    expect(LEDGER).toContain("corpPrivateChipCritical");
  });

  it("reaches the Operating Round corporations table", () => {
    expect(SUBPANEL).toContain("closureAlert={closureAlert}");
  });

  it("takes the alert as an input rather than deriving it in the pill", () => {
    /* #1004's SHAPE, for #1004's reason. A pill renderer handed a list of privates knows nothing about the
       depot; threading the phase into it so it could recompute a figure `privateClosureAlert` already
       produces is the second implementation this project keeps finding. */
    expect(PILLS).toContain("closureAlert?: PrivateClosureAlert | null;");
    expect(PILLS).not.toContain("derivePhase");
  });

  it("escalates on border and ink, never a fill", () => {
    /* #702's RULE, WHICH COST A BATCH TO LEARN: translucent alert backgrounds let the corporation's livery
       through and made the chip look faulty. These pills sit on two surfaces, so they use the two properties
       that read identically on both. */
    expect(PILLS).toContain("pillWarn: { borderColor: ALERT_WARN_BORDER, color: ALERT_WARN_INK }");
    expect(PILLS).not.toContain("pillWarn: { backgroundColor");
  });

  it("keeps the open pill distinguishable from an alerting one", () => {
    /* #423: a pressed pill is the one the panel below belongs to and that link has to stay unambiguous. The
       open style is spread AFTER the alert so it wins, which is a fact about source order and cannot be
       asserted any other way here. */
    const at = (needle: string) => PILLS.indexOf(needle);
    expect(at("styles.pillOpen")).toBeGreaterThan(at("styles.pillCritical"));
  });
});

/* ------------------------------------------------------------------ */
/* The auction card                                                   */
/* ------------------------------------------------------------------ */

describe("the auction card states when the income ends", () => {
  it("says so on the card, at the start of the game", () => {
    /* REPORTED: the rule is nowhere on the Auction Round cards. It is the figure that completes the two the
       card already pairs -- revenue per OR is half a valuation without knowing how many ORs there are. */
    expect(AUCTION).toContain("Closes when the first {closingTier}-train is bought");
  });

  it("looks the tier up rather than typing it", () => {
    expect(AUCTION).toContain("const closingTier = privateClosureTier();");
    expect(AUCTION).not.toContain("first 5-train is bought");
  });

  it("does not shout on a card where nothing is imminent", () => {
    /* SIX OF THESE ARE ON SCREEN AT ONCE and the game has not started. This is small print in the same faint
       ink as the figure labels it qualifies -- the amber belongs to the mid-game chips. */
    expect(AUCTION).toContain("privateCardClosure: {");
    expect(AUCTION).not.toContain("privateCardClosure: { color: ALERT_WARN_INK");
  });
});
