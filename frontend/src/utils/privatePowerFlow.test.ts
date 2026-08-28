/** @jest-environment node */

//
// A private power walked through, not guessed at.
//
// ==================================================================
//  DESIGN NOTE 847 (harness): TWO HALVES THAT DID NOT KNOW EACH OTHER
// ==================================================================
//
// REPORTED: "I gave you a whole work-flow for using DH's Private Power including modals and a means to
// 'escape' the Private Power, but it seems that only the 'Station Marker' modal pops up."
//
// BOTH HALVES EXISTED AND EACH WORKED. #725 gave the panel two buttons, one per step. #818 gave the second
// step a modal. Nothing tied them together, so a player met a button called "Lay Track", used it, and was
// then ambushed by a question about a token they had not been told was coming -- and #845's prompt, added a
// report later, asked "use this power?" and then dropped them on the board.
//
// AND 6a IS THE SAME GAP FROM THE OTHER SIDE: "Once I clicked the 'Lay Track' button in the Private Powers
// panel for DH, there is no way to escape/cancel that track lay." There WAS one -- #817's amber cancel on
// the action bar -- and the player was looking at the map. An exit nobody can find is not an exit, which is
// #279's own test applied to a control instead of a sentence.

import { readSource, readStripped, stripComments } from "./sourceScan";

import { powerFlowOpen, privatePowerFlow } from "./privatePowerFlow";

const dh = (layDone: boolean, station: "pending" | "placed" | "forfeited") =>
  privatePowerFlow({ abilityKey: "dh-tile", holder: "NNH", hexLabel: "F16", layDone, station });
const csl = (layDone: boolean) =>
  privatePowerFlow({ abilityKey: "csl-tile", holder: "NNH", hexLabel: "B20", layDone, station: "none" });
const mh = (revenuePerOr?: number) =>
  privatePowerFlow({ abilityKey: "mh-exchange", holder: "B", revenuePerOr });

describe("the D&H is two steps, in order", () => {
  it("opens with the lay live and the station greyed", () => {
    /* SPECIFIED: "a 'Lay Track on F16' button that is activated, and a line below it ... with a grayed out
       'Place Station Token' and 'Forfeit Free Placement' buttons beside it." */
    const flow = dh(false, "pending");
    expect(flow.steps.map((step) => step.enabled)).toEqual([true, false]);
    expect(flow.steps[0].actionLabel).toBe("Lay Track on F16");
    expect(flow.steps[1].actionLabel).toBe("Place Station Token");
  });

  it("hands the station step over once the tile is down", () => {
    const flow = dh(true, "pending");
    expect(flow.steps.map((step) => step.enabled)).toEqual([false, true]);
    expect(flow.steps[0].done).toBe(true);
  });

  it("greys the station rather than hiding it, because the greying IS the rule", () => {
    /* #548: the token REQUIRES the lay -- there is nothing to put a marker on until the tile is down. A
       hidden step would look like a power with one half; a greyed one shows the order. */
    expect(dh(false, "pending").steps).toHaveLength(2);
  });

  it("is complete only when the station is answered either way", () => {
    expect(dh(true, "pending").complete).toBe(false);
    expect(dh(true, "placed").complete).toBe(true);
    expect(dh(true, "forfeited").complete).toBe(true);
  });

  it("closes itself when complete", () => {
    // A modal whose last button answered its last question is asking nothing.
    expect(powerFlowOpen(dh(true, "placed"))).toBe(false);
    expect(powerFlowOpen(dh(true, "pending"))).toBe(true);
    expect(powerFlowOpen(null)).toBe(false);
  });
});

describe("the escape is a window (design note #847)", () => {
  it("offers the X while nothing is committed", () => {
    /* SPECIFIED: "an X button to cancel the private power usage (which should disappear once they've
       committed to its first action)." */
    expect(dh(false, "pending").cancellable).toBe(true);
    expect(csl(false).cancellable).toBe(true);
  });

  it("withdraws it the moment the tile is laid", () => {
    /* THE REASON IS #818's, one layer up: after the lay, an X would have to mean "forfeit the free
       placement", and the button that says so in words is on the line below it. Two controls for one
       outcome, and the silent one wins by accident. */
    expect(dh(true, "pending").cancellable).toBe(false);
    expect(csl(true).cancellable).toBe(false);
  });
});

describe("the C&SL is the same shape, one entry long", () => {
  it("has a single step", () => {
    /* ASKED: "Although it should be much simpler, I think CSL should have an identical modal flow for its
       one bonus track lay." One renderer, one machine, a shorter list -- not a second modal to drift. */
    expect(csl(false).steps).toHaveLength(1);
    expect(csl(false).steps[0].key).toBe("lay");
  });

  it("offers no forfeit, because there is nothing to forfeit", () => {
    expect(csl(false).steps[0].declineLabel).toBeNull();
  });

  it("completes on the lay", () => {
    expect(csl(true).complete).toBe(true);
  });
});

describe("the copy carries the rules difference", () => {
  it("says the D&H's tile costs terrain and spends the ordinary lay", () => {
    /* #548/#725: "the mountain costs the usual $120 and only the TOKEN is free", and the tile CONSUMES the
       corporation's lay. The two powers being opposites is the mistake players and maintainers both make. */
    const text = dh(false, "pending").steps[0].text;
    expect(text).toContain("ignoring the rules for connectivity");
    expect(text).toContain("usual terrain cost");
    expect(text).toContain("ordinary tile lay");
  });

  it("says the C&SL's is free and EXTRA", () => {
    // #726: "IN ADDITION TO its normal tile lay", which is the opposite of the D&H's and reads alike.
    const text = csl(false).steps[0].text;
    expect(text).toContain("at no cost");
    expect(text).toContain("two tiles this turn");
  });

  it("names what forfeiting actually costs (design note #847a)", () => {
    /* CORRECTED ON REPORT: "'Forfeit Station Token' could be 'Forfeit Free Station Token' or something
       similar, since players are not actually forfeiting a station token, only its free placement."
       A RULES POINT, NOT A WORDING ONE: the marker returns to the supply and can be placed later at the
       ordinary price, so a label naming the PIECE describes a loss twice as large as the real one. */
    const station = dh(true, "pending").steps[1];
    expect(station.declineLabel).toBe("Forfeit Free Placement");
    expect(station.declineLabel).not.toContain("Station Token");
    expect(station.text).toContain("Declining keeps the marker");
  });

  it("names the hex in every label, because the player has to go there", () => {
    expect(dh(false, "pending").steps[0].actionLabel).toContain("F16");
    expect(csl(false).steps[0].actionLabel).toContain("B20");
  });
});

describe("the shell derives the flow instead of remembering it (design note #849)", () => {
    const APP = stripComments(readSource("App.tsx"));

  it("raises the modal on an unresolved D&H without being told to", () => {
    /* THE REOPENING IS A DERIVATION, not an event. The D&H's second step happens after the lay, and a D&H
       lay ENDS the Track step -- so a flag set at the click site would have to survive a dispatch, a
       sub-phase change and a re-render. A laid tile with an unresolved station IS the open question. */
    /* ==================================================================
        DESIGN NOTE 887: THIS PAIR MOVED FROM SCANNING TO CALLING
       ==================================================================
       IT READ, on one line per #814: `expect(APP).toContain('const key: PowerAbilityKey | null = dhOwed ? "dh-tile" : privatePowerRequest;');`
       -- true of `App.tsx`'s text and silent about whether the derivation WORKS. It would have passed for a
       memo whose dependency array never fired and for a condition written inverted.
       THE RULE IS THE SAME AND IS NOW EXERCISED: `activePrivatePower.test.ts` raises the D&H's station
       question with `request: null` and asserts the station step comes back enabled, then asserts the
       obligation outranks a competing `mh-exchange` request. What survives here is the SHELL's half -- that
       the shell asks the extracted function at all, and hands it the standing-obligation inputs rather than
       only the click. */
    expect(APP).toContain("deriveActivePowerFlow({");
    const at = APP.indexOf("deriveActivePowerFlow({");
    expect(at).toBeGreaterThan(-1);
    const call = APP.slice(at, APP.indexOf("});", at));
    expect(call).not.toBe("");
    expect(call).toContain("request: privatePowerRequest,");
    expect(call).toContain("usedAbilities: usedPrivateAbilities,");
    expect(call).toContain("dhStationForfeited,");
  });

  it("retires the prompt cursor rather than keeping a second account", () => {
    // #772: a state machine nobody consults is a second truth waiting to disagree with the first.
    expect(APP).not.toContain("setDhStationPrompt");
    expect(APP).not.toContain("dhStationPromptNext(");
  });

  it("keeps the forfeit apart from the placement", () => {
    /* #818: `usedPrivateAbilities` records a token that was PLACED; forfeiting spends the ability without
       placing anything. Collapsing the two would make the modal unable to say which happened. */
    expect(APP).toContain("const [dhStationForfeited, setDhStationForfeited] = useState(false);");
    expect(APP).toContain("setDhStationForfeited(true);");
  });

  it("logs the forfeit in the words the button uses", () => {
    // #717: a thing that quietly stopped being available is this app's worst failure mode.
    expect(APP).toContain("the free placement on F16 was forfeited");
  });

  it("labels the chips for the power, not for the first step", () => {
    /* ==================================================================
        DESIGN NOTE 885: THE SUBJECT MOVED FROM THE PANEL TO THE CHIP
       ==================================================================
       THIS ASSERTED, on one line per #814: `expect(PANEL.match(/label: "Use Power"/g) ?? []).toHaveLength(2);`
       -- two "Use Power" buttons in `PrivatePowerPanel.tsx`, plus the absence of `label: "Lay Track (F16)"`
       and `label: "Lay Track (B20)"`.
       #849's RULE IS WHAT IT WAS PROTECTING and the rule outlived the panel: "A BUTTON LABELLED WITH ONE STEP
       IS A BUTTON THAT LIES ABOUT A TWO-STEP POWER ... What each one actually does is the modal's first
       line." The panel is deleted (#885); the chips are where a player presses now, and `privatePowerOffer.ts`
       composes their labels as `Use <ACRONYM> Power`.
       IT WAS ALSO A BARE COUNT. `toHaveLength(2)` could not tell the D&H's button from the C&SL's, so it
       would have passed for two labels on one power. The replacement asserts the composition itself. */
    const OFFERS = stripComments(readSource("utils/privatePowerOffer.ts"));
    const dollar = String.fromCharCode(36);
    expect(OFFERS).toContain("chipLabel: `Use " + dollar + "{catalog.acronym} Power`");
    expect(OFFERS).not.toContain('"Lay Track (F16)"');
    expect(OFFERS).not.toContain('"Lay Track (B20)"');
  });

  it("makes every door ask rather than arm", () => {
    /* ==================================================================
        DESIGN NOTE 885: THE PANEL BUTTON WAS THE DOOR THIS DESCRIBED
       ==================================================================
       IT ASSERTED, on one line per #814: `expect(APP).toContain('if (action.key === "dh-tile" || action.key === "csl-tile") {');`
       -- `handleUsePrivateAbility`'s branch raising the modal instead of arming the errand directly.
       6a IS THE REPORT IT DEFENDS and it is unchanged: "there is no way to escape/cancel that track lay."
       There was one -- #817's cancel on the action bar -- and the player was on the map, so the escape had
       to be where they were looking. #849 made the panel ASK; #885 removed the panel, leaving the chip as
       the only door, and `handleChipPowerOffer` raises the same request.
       SO THE PROPERTY IS NOW AN ABSENCE PLUS A PRESENCE: nothing arms an errand from an entry point, and the
       one entry point that exists sets a request. The absence is the half that would silently come back --
       a future "convenience" that arms directly from a chip is exactly 6a again. */
    expect(APP).toContain("if (offer) setPrivatePowerRequest(offer.abilityKey);");
    const start = APP.indexOf("const handleChipPowerOffer");
    expect(start).toBeGreaterThan(-1);
    /* BOUNDED AT `runPrivateExchange`'s OWN DECLARATION, which is the next thing in the file. The first
       draft bounded at `handlePowerFlowAct` and swept the declaration INTO the slice, so the
       `not.toContain` below failed on the definition rather than on a call -- an anchor placed downstream
       of the thing being looked for, which is the same trap as an anchor placed upstream and reads as a
       real failure rather than as a vacuous pass. */
    const end = APP.indexOf("const runPrivateExchange", start);
    expect(end).toBeGreaterThan(start);
    const chip = APP.slice(start, end);
    expect(chip).not.toBe("");
    expect(chip).not.toContain("armPrivateHexErrand");
    expect(chip).not.toContain("runPrivateExchange");
  });

  it("does not mount the modal over a placement in flight", () => {
    /* #818's own condition: once accepted, the board is the thing to look at.
       DESIGN NOTE 866 ADDED THE SECOND HALF, and this test's own name is why it belongs here. The condition
       was `homeStationPlacement === null` alone, which is "no errand is armed" -- and that was a sufficient
       proxy only while every free placement began by arming one. Auto-staging skips the errand entirely, so
       a placement genuinely in flight had `homeStationPlacement === null` and the modal would have mounted
       over the confirmation it had just produced. A PROXY THAT STOPPED STANDING FOR THE THING, which is the
       failure this session keeps turning up; the fix is to ask about the placement directly.
       The needle is matched loosely across the two lines because the condition now wraps. */
    expect(APP).toContain("powerFlowOpen(activePowerFlow) &&");
    expect(APP).toMatch(
      /powerFlowOpen\(activePowerFlow\) &&\s*homeStationPlacement === null &&\s*pendingToken === null/,
    );
  });
});

describe("one hex, one question (design note #850)", () => {
  const APP = readSource("App.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("refuses the tile picker while a token placement is staged", () => {
    /* REPORTED: "the tileselector radial menu popped up on top of the checkmark/x for the station. I then
       had to click off the hex to remove the tileselector menu and only see the checkmark/x."
       REFUSED RATHER THAN RE-LAYERED: a `z-index` fight leaves both mounted, so a click can still land on
       the wrong one. A hex with an unanswered placement is not accepting a second question. */
    expect(APP).toContain("if (pendingTokenRef.current !== null) return;");
  });

  it("asks before the ring opens, not after", () => {
    const guard = APP.indexOf("if (pendingTokenRef.current !== null) return;");
    const open = APP.indexOf("setRadialSelector({");
    expect(guard).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(open);
  });

  it("sends the ring's X back to the modal rather than forfeiting", () => {
    /* #818: cancelling a PLACEMENT is not declining a POWER. Clearing the errand returns the player to the
       flow, where the forfeit is a button that says what it does -- so the red X keeps the single meaning it
       has everywhere else in this app. */
    const start = APP.indexOf("const handleCancelTokenPlacement");
    expect(start).toBeGreaterThan(-1);
    const end = APP.indexOf("}, []);", start);
    expect(end).toBeGreaterThan(start);
    const body = APP.slice(start, end);
    expect(body).toContain("setPendingToken(null);");
    expect(body).toContain("setHomeStationPlacement(null);");
    expect(body).not.toContain("dh-token");
  });
});

// ==================================================================
//  DESIGN NOTE 871 (harness): ONE QUESTION, AND A WAY OUT OF IT
// ==================================================================
//
// SPECIFIED: "let's have a modal pop up when a player clicks it that basically says 'Exchanging this Private
// Company for an NYC share forfeits its $20/OR revenue. Are you sure?' and allows them to escape by
// selecting no."
describe("the M&H is one question (design note #871)", () => {
  it("asks once and names the revenue it costs", () => {
    const flow = mh(20);
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0].key).toBe("exchange");
    expect(flow.steps[0].text).toBe(
      "Exchanging this Private Company for an NYC share forfeits its $20/OR revenue. Are you sure?",
    );
  });

  it("names the loss without a figure when the room has not reported one", () => {
    /* `|| 0` WOULD BE THE TEMPTING WRONG ANSWER -- it would tell a player they are giving up nothing, which
       is the opposite of the fact the sentence exists to carry. */
    expect(mh().steps[0].text).toContain("forfeits its Operating Round revenue");
    expect(mh().steps[0].text).not.toContain("$");
  });

  it("offers a No as well as an X", () => {
    /* "allows them to escape by selecting no" -- so the escape is a NAMED BUTTON, not only the corner X.
       Both are present and both mean the same thing here, which is correct rather than redundant: nothing is
       committed until the exchange fires, so every exit is the same exit. */
    const flow = mh(20);
    expect(flow.steps[0].declineLabel).toBe("No, Keep the Private");
    expect(flow.cancellable).toBe(true);
  });

  it("promises nothing is lost by declining", () => {
    /* THE DIFFERENCE FROM THE D&H, in the words a player reads. #845: "Declining THIS one costs nothing: the
       power is still unspent... Two modals, two rules, and the difference is whether the question can be
       asked again." */
    expect(mh(20).steps[0].declineHint).toContain("untouched");
    expect(dh(true, "pending").steps[1].declineHint).toContain("Give up the free placement");
  });

  it("is live the moment it opens", () => {
    // No ordering to respect: there is one step and nothing before it.
    expect(mh(20).steps[0].enabled).toBe(true);
    expect(mh(20).steps[0].done).toBe(false);
    expect(powerFlowOpen(mh(20))).toBe(true);
  });

  it("names its holder as a player, not a corporation", () => {
    /* Design note #872: the modal used to write "{ticker} holds this power." itself, which is right for the
       two corporate hex powers and wrong for this one -- the M&H belongs to a PERSON (#441). */
    expect(mh(20).holderLine).toBe("B holds this power.");
    expect(dh(false, "pending").holderLine).toBe("NNH holds this power.");
  });
});

describe("the modal writes no copy of its own (design note #872)", () => {
  /* Design note #886: `readStripped`, NOT `readSource`. This binding came from a describe-local `read` that
     did the comment-stripping INSIDE itself rather than through a named `strip` -- so the survey that found
     "twelve copies of strip" missed it, and the migration replaced a read-and-strip with a plain read. The
     suite caught it on `not.toContain("holds this power.")`, which #872's own note quotes two lines above the
     code it describes. A thirteenth stripper, wearing a different name. */
  const MODAL = readStripped("components/PrivatePowerFlowModal.tsx");

  it("takes the holder line from the flow", () => {
    expect(MODAL).toContain("{flow.holderLine}");
    expect(MODAL).not.toContain("holds this power.");
  });

  it("takes the decline hint from the step", () => {
    /* THE STRING THAT WOULD HAVE LIED TO AN M&H OWNER: "Give up the free placement. The marker stays in the
       supply for an ordinary placement later." True of the only decline that existed when it was written. */
    expect(MODAL).toContain("step.declineHint");
    expect(MODAL).not.toContain("Give up the free placement");
  });
});
