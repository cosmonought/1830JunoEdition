/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 882/883/884/885 (harness): THE PANEL'S THREE JOBS, REHOMED
// ==================================================================
//
// ASKED: "Given how nice the modal is ... versus how cramped and hard to read the Private Powers subpanel
// is, I'm wondering if we should scrap the Private Powers subpanel completely."
//
// AGREED, AND THE PANEL WAS CARRYING THREE THINGS NOBODY HAD PRICED. Two of them are bugs found while
// pricing the removal rather than reported:
//
//   #882  A REFUSED EXCHANGE CLOSED THE MODAL AS THOUGH IT HAD SUCCEEDED. `handlePowerFlowAct` called the
//         dispatch and then `setPrivatePowerRequest(null)` on the next line, unconditionally. The reason
//         went to the panel -- below the fold -- and to the log. Both M&H refusals are reachable.
//   #883  THE M&H CHIP WAS NOT SANDBOX-GATED. `ExchangePrivate` is not in `GAMEPLAY_MESSAGE_KEYS`, and the
//         panel's `if (!sandbox) return null` was the only thing stopping the chip offering a message the
//         session key cannot sign -- exactly the failure the panel's own #1 was written about.
//   #884  THE CHIPS SAT IN THE CENTRED GROUP, so an available power shifted Pass and Lay 1 Track sideways.
//
// Source scans plus one pure-function call, so this file takes the node environment.

import { readSource, stripComments } from "./sourceScan";

import { PRIVATE_COMPANY_CATALOG, abilitySummary } from "./privateCatalog";
import { GAMEPLAY_MESSAGE_KEYS } from "./sessionKey";

/* #490a: the notes quote the code they replaced, so every code assertion reads a comment-stripped copy. */

const APP = stripComments(readSource("App.tsx"));
const BAR = stripComments(readSource("panels/ContextualActionBar.tsx"));
const MODAL = stripComments(readSource("components/PrivatePowerFlowModal.tsx"));
const STYLES = stripComments(readSource("styles/appStyles.ts"));

describe("a refused exchange keeps the question open (design note #882)", () => {
  it("closes the modal only when the dispatch fired", () => {
    /* THE BUG, STATED AS A SHAPE: two statements with no relationship between them. The fix is that the
       close is INSIDE the success branch, which a reader can see and a future edit cannot undo by accident
       the way deleting a separate guard could. */
    const at = APP.indexOf("const handlePowerFlowAct");
    expect(at).toBeGreaterThan(-1);
    const end = APP.indexOf("const handlePowerFlowDecline", at);
    expect(end).toBeGreaterThan(at);
    const body = APP.slice(at, end);
    expect(body).not.toBe("");
    expect(body).toContain(
      'if (runPrivateExchange(MH_PRIVATE_ID, "Exchange for NYC share")) {',
    );
    /* AND THE OLD SHAPE IS GONE. Asserted separately, because the positive above would still pass if a
       stray unconditional close survived below it -- which is precisely the arrangement being removed. */
    expect(body).not.toContain(
      'runPrivateExchange(MH_PRIVATE_ID, "Exchange for NYC share");',
    );
  });

  it("reports the outcome instead of leaving the caller to guess", () => {
    /* A RETURN VALUE RATHER THAN A SECOND PIECE OF STATE the caller inspects: `ok` is what the caller needs
       and `resolvePrivateExchange` already computed it. A caller reading the error state instead would be
       reading a value written for the modal, one render late. */
    const at = APP.indexOf("const runPrivateExchange = useCallback(");
    expect(at).toBeGreaterThan(-1);
    const end = APP.indexOf("const handlePowerFlowAct", at);
    expect(end).toBeGreaterThan(at);
    const body = APP.slice(at, end);
    expect(body).not.toBe("");
    expect(body).toContain("): boolean => {");
    expect(body).toContain("return false;");
    expect(body).toContain("return true;");
  });

  it("keeps the reason attached to the power it is about", () => {
    /* THE PROXY THAT WOULD HAVE STOPPED STANDING FOR ITS SUBJECT. A bare string cannot answer "the last
       refusal FOR THIS POWER", and the D&H's modal can be raised by a standing obligation rather than by a
       click -- so there is no door to hang a clear on and a stale M&H sentence would ride along. */
    expect(APP).toContain("const [privatePowerRefusal, setPrivatePowerRefusal] = useState<{");
    expect(APP).toContain('abilityKey: "mh-exchange", reason: outcome.reason');
    expect(APP).toContain("privatePowerRefusal?.abilityKey === activePowerFlow.abilityKey");
  });

  it("clears the last answer when the question is asked again", () => {
    /* SCOPING BY KEY CANNOT CATCH THIS ONE: a SAME-power refusal goes stale the moment the player acts on
       it ("sell a share first"), and they can come straight back. Cleared where the question is raised
       rather than where the modal closes, because closing is not the event that makes it stale. */
    const at = APP.indexOf("const handleChipPowerOffer");
    expect(at).toBeGreaterThan(-1);
    const end = APP.indexOf("const runPrivateExchange", at);
    expect(end).toBeGreaterThan(at);
    const body = APP.slice(at, end);
    expect(body).not.toBe("");
    expect(body).toContain("setPrivatePowerRefusal(null);");
  });

  it("renders it above the steps, and leaves the step live", () => {
    /* A REFUSAL IS NOT A STAGE OF THE FLOW. Nothing was spent and the step it belongs to is still the live
       one, so drawing it as a fourth greyed box would say the opposite. The ordering is asserted with both
       anchors pinned -- an `indexOf` of -1 is less than every real index and would make this pass for a
       modal that renders no refusal at all. */
    const refusalAt = MODAL.indexOf("{refusal && (");
    const stepsAt = MODAL.indexOf("{flow.steps.map(");
    expect(refusalAt).toBeGreaterThan(-1);
    expect(stepsAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(stepsAt);
  });

  it("uses border longhands, because its siblings override borderColor", () => {
    /* #840's bug class, and this box sits directly among the styles that trigger it: `step` sets a
       `borderColor` and `stepLive` overrides it. A `border` shorthand here is how React comes to write
       `borderColor = ""` on the render that drops an override. */
    const at = STYLES.indexOf("actionBarPowerChip: {");
    expect(at).toBeGreaterThan(-1);
    const modalRefusal = MODAL.slice(MODAL.indexOf("refusal: {"), MODAL.indexOf("},", MODAL.indexOf("refusal: {")));
    expect(modalRefusal).not.toBe("");
    expect(modalRefusal).toContain("borderWidth:");
    expect(modalRefusal).toContain("borderColor:");
    expect(modalRefusal).not.toMatch(/^\s*border:/m);
  });
});

describe("the exchange is offered only where it can be honoured (design note #883)", () => {
  it("is a fact about the allow-list, not a guess", () => {
    /* THE PREMISE, ASSERTED RATHER THAN QUOTED. If `ExchangePrivate` is ever added to the session key's
       allow-list, this fails and the sandbox gate should be reconsidered on purpose -- which is the whole
       value of pinning a premise instead of a conclusion. */
    expect(GAMEPLAY_MESSAGE_KEYS).not.toContain("ExchangePrivate");
    /* THE CONTROL: the two hex powers' messages ARE on the list, which is why #883 gates the exchange and
       deliberately leaves them alone. Without this, "nothing is on the list" would satisfy the line above. */
    expect(GAMEPLAY_MESSAGE_KEYS).toContain("LayTile");
    expect(GAMEPLAY_MESSAGE_KEYS).toContain("PlaceStationToken");
  });

  it("hands the shell's sandbox flag to the gate", () => {
    /* ==================================================================
        DESIGN NOTE 887: THE GATE ITSELF IS ASSERTED BY CALLING IT NOW
       ==================================================================
       THIS SCANNED `App.tsx` for `if (!sandbox) return [];` inside the memo. The gate moved into
       `stockRoundExchangeOffers`, where `activePrivatePower.test.ts` calls it with `sandbox: false` and
       asserts an empty list -- the behaviour, rather than the sentence that implements it.
       WHAT IS LEFT FOR THE SHELL TO GET WRONG is the WIRING: passing a constant, passing the wrong flag, or
       omitting it from the dependency list. That is what this asserts, and it is genuinely the shell's
       business rather than the module's. */
    const at = APP.indexOf("const stockRoundPowerOffers");
    expect(at).toBeGreaterThan(-1);
    const end = APP.indexOf("const privatePowerOffersRef", at);
    expect(end).toBeGreaterThan(at);
    const body = APP.slice(at, end);
    expect(body).not.toBe("");
    expect(body).toContain("stockRoundExchangeOffers({");
    expect(body).toContain("sandbox,");
    /* IN THE DEPENDENCY ARRAY, because a dependency omitted for being constant today is a promise about the
       caller rather than about this memo. */
    expect(body).toContain("[gameState, viewerAddress, sandbox]");
  });
});

describe("the chips have their own group and their own mark (design note #884)", () => {
  it("builds them once, for every round", () => {
    /* TWO PRODUCERS WAS THE OLD SHAPE -- the Track case and the Stock Round branch, differing only in the
       hover sentence. One producer is what stops the two rounds disagreeing about what a chip is. */
    expect((BAR.match(/powerOffers\.map\(/g) ?? []).length).toBe(1);
    expect(BAR).toContain("const powerChips: ActionBarButton[] =");
  });

  it("carries the hover sentence on the offer, not in the bar", () => {
    /* #848: this component "writes no rules and no copy". The two sentences were written inline here, which
       is how #872 found two more strings that had escaped the same rule. */
    expect(BAR).toContain("offer.chipTitle ??");
    const offers = stripComments(readSource("utils/privatePowerOffer.ts"));
    expect(offers).toContain("chipTitle:");
    /* Design note #887: the sentence lives in `activePrivatePower.ts` now, beside the label it belongs to. */
    expect(stripComments(readSource("utils/activePrivatePower.ts"))).toContain(
      'chipTitle: "Opens the exchange question',
    );
  });

  it("keeps the M&H's between-turns exemption without naming the M&H", () => {
    /* #871: the exchange is "NOT TURN-GATED, and that is the M&H's own rule rather than an oversight."
       `mayActThisTurn` is `roundType !== "OperatingRound" || isMyTurn`, so it is TRUE in a Stock Round --
       applying it to the chips withdraws the hex powers from a watcher and leaves the exchange alone,
       without this file knowing which power is which. That is the assertion: one expression, reused. */
    expect(BAR).toContain('const mayActThisTurn = roundType !== "OperatingRound" || isMyTurn;');
    expect(BAR).toContain("onUsePowerOffer && mayActThisTurn");
  });

  it("renders one definition of the chip in both rails", () => {
    /* #619's hazard: "the two forms of this bar must not disagree about whether a control is available."
       Written out twice, the mark, the disabled treatment and the `type` would be two copies to keep in
       step. Asserted as ONE `<button` inside the nodes builder plus two placements of it. */
    expect(BAR).toContain("const powerChipNodes = powerChips.map((chip) => (");
    expect((BAR.match(/\{powerChipNodes\}/g) ?? []).length).toBe(2);
  });

  it("puts the mark inside the chip, leaving the border to say whether it is live", () => {
    /* ==================================================================
        THE ANSWER TO "rainbow outline, or a PC chip, or something similar"
       ==================================================================
       #732's RULE IS WHAT DECIDES IT: the border on this bar is a STATE channel --
       `actionBarButtonDisabled` overrides `borderColor`, `actionBarCancelErrand` paints it amber. A border
       that is sometimes a rainbow puts identity and state on one channel. #840 makes it concrete: a
       shorthand beside a sibling's longhand is how React comes to blank the colour.
       SO THE ASSERTION IS THAT THE MARK IS A BACKGROUND ON A CHILD, and that neither chip style touches the
       border at all -- the second half is the one that would rot, because "just tint the border" is the
       obvious next edit. */
    const chipAt = STYLES.indexOf("actionBarPowerChip: {");
    const markAt = STYLES.indexOf("actionBarPowerChipMark: {");
    expect(chipAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(chipAt);
    const chip = STYLES.slice(chipAt, markAt);
    const mark = STYLES.slice(markAt, STYLES.indexOf("},", markAt));
    expect(chip).not.toBe("");
    expect(mark).not.toBe("");
    expect(chip).not.toContain("border");
    expect(mark).toContain("backgroundImage:");
    expect(mark).not.toContain("borderColor");
  });

  it("draws it from the one palette the board already uses", () => {
    /* #727 is explicit that the MECHANISM cannot be shared between a canvas gradient and a CSS one, "so
       what must be shared is the list. Two hard-coded palettes drifting apart is how the association
       quietly stops being one." This is the third renderer of that list. */
    expect(STYLES).toContain(
      'import { PRIVATE_POWER_GLOW_STOPS } from "../utils/privatePowerGlow";',
    );
    expect(STYLES).toContain("PRIVATE_POWER_GLOW_STOPS.join(");
    /* AND NOT A COPY OF THE STOPS. A literal hue anywhere in this file's chip styles is the drift #727
       names; the first colour in the list is the cheapest fingerprint for it. */
    const markAt = STYLES.indexOf("actionBarPowerChipMark: {");
    const mark = STYLES.slice(markAt, STYLES.indexOf("},", markAt));
    expect(mark).not.toContain("#ff4d4d");
  });
});

describe("the powers panel is gone, and took nothing live with it (design note #885)", () => {
  it("leaves no import, render or prop behind", () => {
    expect(BAR).not.toContain("<PrivatePowerPanel");
    expect(BAR).not.toContain("onUsePrivateAbility");
    expect(BAR).not.toContain("privateAbilityError");
    expect(BAR).not.toContain("usedPrivateAbilities");
    expect(APP).not.toContain("PRIVATE_ABILITIES");
  });

  it("keeps the prop the bar actually reads", () => {
    /* THE TEST #885 APPLIES TO ALL SEVEN: a prop leaves with the child if the bar was only a conduit for it,
       and stays if the bar arrived at a use of its own. `privateCompanies` feeds the rust and train-limit
       warnings, so removing it with the rest would have been a silent deletion of those. */
    expect(BAR).toContain("privateCompanies: readonly PrivateCompanyState[];");
    expect(BAR).toContain("}, [currentGlobalEra, privateCompanies, orSubPhase, phase]);");
  });

  it("keeps both deleted records where a reader will find them", () => {
    /* #814: quoted on ONE LINE, because a wrapped quote preserves the words and destroys the string -- and
       a harness looking for the record searches for the string. Read off the RAW file, per #490a. */
    const appRaw = readSource("App.tsx");
    expect(appRaw).toContain(
      "Mohawk & Hudson - the owner may exchange this private for a 10% share of the New York Central (NYC). The exchange closes this private permanently.",
    );
    expect(appRaw).toContain(
      "Camden & Amboy — its purchaser received a 10% share of the Pennsylvania Railroad (PRR) free, at the moment they won it. Nothing further to trigger: the company stays open and keeps paying its revenue.",
    );
  });

  it("still says what the C&A did, in the table that replaced the row", () => {
    /* #576 kept a button-less row so "a C&A owner who finds no row at all would reasonably conclude the
       company has no power". #843's private table -- which did not exist when #576 was written -- says both
       halves and prints the revenue in a column beside them. THIS is why the row could go: the information
       was already rehomed, three hundred notes before anyone asked. */
    /* READ AT RUN TIME, NOT SCANNED. The catalog writes its em-dash as a `\u2014` escape, so a source scan
       for the sentence a player sees fails on a file that is entirely correct -- and would have been
       "fixed" by asserting the escape, which pins the encoding rather than the words. Calling
       `abilitySummary` reads what the table renders. */
    const ca = abilitySummary(PRIVATE_COMPANY_CATALOG[5]);
    expect(ca).toContain("Its auction buyer was handed a 10% PRR share on purchase.");
    expect(ca).toContain("Nothing further to trigger");
    expect(ca).toContain("the company stays open");
    /* AND THE TABLE RENDERS THAT SUMMARY rather than prose of its own -- #843's own rule, which is what
       makes the row's removal safe rather than merely tidy. */
    const rules = stripComments(readSource("components/RulesReference.tsx"));
    expect(rules).toContain("power: abilitySummary(entry)");
  });
});
