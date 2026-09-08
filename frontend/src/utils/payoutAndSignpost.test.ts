/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1163-1164 (harness): TWO THINGS THAT WERE ALREADY THERE
// ==================================================================
//
// Neither of these is a missing feature, which is why both fixes are small and both notes are long.
//
//   THE BLANK SPACE was a row hidden with `opacity: 0`. Opacity hides a box; it does not remove one, so the
//                   payer row went on occupying its full height above the one figure the animation exists to
//                   deliver. The panel was not failing to shrink -- nothing had ever asked it to.
//   THE INSTRUCTION had existed since #831, in the button's `title`: "Click a hex there to lay track." A
//                   `title` needs a hover held for a second and does not exist on a touch screen. The
//                   sentence was right and its surface was unreachable.
//
// And one word was removed rather than added: #1098 moved the player's NAME into the stripe and, in the same
// pass, wrote "your cash" underneath it -- gaining a possessive at the moment it gained the thing that made
// the possessive redundant.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const MACHINE = readStripped("components/DividendMoneyMachine.tsx");
const BAR = readStripped("panels/ContextualActionBar.tsx");
const APP = readStripped("App.tsx");

describe("the payout panel merges the figure rather than closing a gap (design note #1291)", () => {
  /* ==================================================================
      DESIGN NOTE 1163's DESCRIBE, RETIRED
     ==================================================================
     This block pinned the row COLLAPSE -- `grid-template-rows: 0fr`, the transition on the track, the
     phase classes carrying every property, the reduced-motion override restoring the row. REPORTED (16):
     "instead of merging-summing into the value below it, it simply slides out and the panel narrows to the
     updated value." The collapse was the narrowing. #1291 replaced it: the AMOUNT flies to the total and
     the panel's box never changes size. What survives of #1163's claims is asserted below in the new shape;
     what was the collapse is asserted gone. */
  const PANEL = readStripped("components/MoneyMachinePanel.tsx");

  it("never changes the panel's height: there is no track to collapse", () => {
    expect(PANEL).not.toContain("grid-template-rows");
    expect(PANEL).not.toContain("gridTemplateRows");
    expect(MACHINE).not.toContain("grid-template-rows");
  });

  it("flies the amount to the total over the fall, on layout properties", () => {
    /* `left`/`top`/`opacity` under a Web Animation, from the amount's rectangle to the total's (#1289: no
       transform under the chrome zoom). Measured in screen pixels, divided back into layout pixels. */
    const flight = sliceBetween(PANEL, "const from = amount.getBoundingClientRect();", "fill: \"forwards\"");
    expect(flight).toContain("const to = total.getBoundingClientRect();");
    expect(flight).toContain("/ scale"); // #1294: the live scale at the moment of measurement
    expect(flight).toContain("duration: MONEY_MACHINE_FALL_MS");
    expect(flight).not.toContain("transform");
  });

  it("flips the total on impact and hides the landed amount without moving the row", () => {
    expect(PANEL).toContain(
      'const shown = phase === "holding" || phase === "falling" ? holder.before : holder.after;',
    );
    expect(PANEL).toContain("amountLanded: { opacity: 0 }");
  });

  it("keeps the figure for a reader who asked for less motion", () => {
    /* #606's rule, kept: no flight means no landing, so the amount stays as a static statement. */
    expect(PANEL).toContain('if (phase === "falling") flewRef.current = true;');
    expect(PANEL).toContain('setLanded(flewRef.current && (phase === "merged" || phase === "leaving"));');
  });

  it("drops the word the stripe above it already said", () => {
    /* The seat colour and the player's own name are directly above the caption. "your" answered a question
       nobody was still asking; the caption itself stays, because #1098's argument was about RHYTHM. */
    expect(MACHINE).toContain('label: "Cash"');
    expect(MACHINE).not.toContain("your cash");
  });
});

describe("the Lay Track button says where, on a surface a finger can reach", () => {
  it("speaks on the click rather than on a hover", () => {
    /* The sentence has existed in the `title` since #831. A `title` needs a held hover and does not exist on
       touch, which is the population this step keeps confusing. */
    const jump = sliceBetween(BAR, "const goToMap = React.useCallback(() => {", "}, [mapEl, onShowMap, onSayWhereToClick]);");
    /* Design note #1164a: the sentence is a constant, because #870 had already put the same words on screen
       as `orPanelStepHint` -- and my first version of this typed them out a second time, which is one
       instruction in two literals and exactly the fault this codebase finds most often. Asserted through the
       constant so a rewording moves in one place. */
    expect(jump).toContain("onSayWhereToClick?.(LAY_TRACK_HINT);");
    expect(BAR).toContain('export const LAY_TRACK_HINT = "Click a hex on the Rail Map to lay track.";');
  });

  it("says it on every press, not only the inert one", () => {
    /* #987 made the button a no-op once the map is showing. Speaking only THEN would teach the lesson in the
       one case where the button already did something visible -- and a player who has just been moved to the
       map still has to be told what to do when they arrive. */
    const jump = sliceBetween(BAR, "const goToMap = React.useCallback(() => {", "}, [mapEl, onShowMap, onSayWhereToClick]);");
    expect(jump.indexOf("onSayWhereToClick")).toBeGreaterThan(jump.indexOf("if (!mapEl)"));
    expect(jump).not.toContain("if (mapEl) onSayWhereToClick");
  });

  it("leaves the button a signpost rather than a control", () => {
    /* RULED, and the reasoning is the reporter's: an active/"Cancel" toggle "would make Lay 1 Track something
       players think they need to click when instead it's just there to remind them it's the active action".
       #888 also lost the greying argument once already, for #732's one-channel reason. */
    const track = sliceBetween(BAR, 'key: "go-to-map"', "},");
    expect(track).toContain('label: "Lay 1 Track"');
    expect(track).not.toContain("Cancel");
    expect(track).toContain("disabled: false");
  });

  it("is optional, so a shell without a toast channel simply stays quiet", () => {
    expect(BAR).toContain("onSayWhereToClick?: (text: string) => void;");
    expect(APP).toContain("onSayWhereToClick={showActionToast}");
  });
});
