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

describe("the payout panel closes the gap it opens", () => {
  it("collapses the merged row's track rather than only hiding it", () => {
    /* `opacity: 0` WAS THE WHOLE OF THE OLD MERGE. The row vanished and its box stayed, which is the reported
       "large blank space above the player's cash". */
    const raw = require("fs").readFileSync(
      require("path").join(__dirname, "..", "components", "DividendMoneyMachine.tsx"),
      "utf8",
    ) as string;
    expect(raw).toContain("grid-template-rows: 0fr;");
    expect(raw).toContain("padding-top: 0;");
  });

  it("uses a track rather than a guessed ceiling", () => {
    /* A `max-height` collapse has to pick a number larger than the row, so the animation finishes early and
       then pauses at nothing -- visible as a stutter on a 500ms move. `1fr` to `0fr` resolves to the row's own
       height whatever the font does to it. */
    const row = sliceBetween(MACHINE, "payerRow: {", "\n  },");
    expect(row).toContain("transition:");
    expect(row).not.toContain("maxHeight");
  });

  it("keeps every phase-varying property OUT of the inline style", () => {
    /* ==================================================================
        DESIGN NOTE 1175: THE ASSERTION THAT WAS TRUE AND PROVED NOTHING
       ==================================================================
       REPORTED: the compression "does not happen" -- after #1163 shipped, and after this file went green.
       THIS TEST PASSED BECAUSE IT CHECKED THE TWO HALVES SEPARATELY. One case asserted the class carries
       `grid-template-rows: 0fr`; another asserted the element carries `gridTemplateRows: "1fr"`. Both were
       true. Together they are the bug: an inline declaration outranks any stylesheet rule whatever its
       specificity, so the class could never win and the row never collapsed.
       SO THE PROPERTY IS THE RELATIONSHIP, not either half. Anything a phase class sets must not also be set
       on the element, and that is checkable directly -- which is what this now does, for every property the
       three phase classes name rather than only for the two that were reported. */
    const raw = require("fs").readFileSync(
      require("path").join(__dirname, "..", "components", "DividendMoneyMachine.tsx"),
      "utf8",
    ) as string;
    const row = sliceBetween(MACHINE, "payerRow: {", "\n  },");
    /* The properties the phase classes fight over, named once. `opacity` is included even though it was never
       inline: it is the one that DID work, and the reason the row went invisible while keeping its space. */
    for (const [css, inline] of [
      ["grid-template-rows", "gridTemplateRows"],
      ["padding-top", "paddingTop"],
      ["opacity", "opacity"],
    ] as const) {
      expect([css, raw.includes(css + ":")]).toEqual([css, true]);
      expect([inline, row.includes(inline + ":")]).toEqual([inline, false]);
    }
  });

  it("gives the open state a class of its own, so the cascade has two rules to choose between", () => {
    const raw = require("fs").readFileSync(
      require("path").join(__dirname, "..", "components", "DividendMoneyMachine.tsx"),
      "utf8",
    ) as string;
    expect(raw).toContain(".app-money-machine-waiting,\n.app-money-machine-fall {");
    expect(raw).toContain("grid-template-rows: 1fr;\n  padding-top: 7px;");
  });

  it("gives the inner row what a collapsing track needs", () => {
    /* A grid track cannot reach zero around a child that refuses to shrink: `min-height: 0` is what allows it
       and `overflow: hidden` is what stops the content spilling while it does. */
    const inner = sliceBetween(MACHINE, "payerRowInner: {", "\n  },");
    expect(inner).toContain("minHeight: 0");
    expect(inner).toContain('overflow: "hidden"');
  });

  it("keeps the row for a reader who asked for less motion", () => {
    /* THE REDUCED-MOTION PATH SHOWS THE PAYOUT STATICALLY beside the total -- it needs the space as much as it
       needs the opacity, so the override has to restore BOTH or the figure it keeps visible would have
       nowhere to be. */
    const raw = require("fs").readFileSync(
      require("path").join(__dirname, "..", "components", "DividendMoneyMachine.tsx"),
      "utf8",
    ) as string;
    const reduced = raw.slice(raw.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("opacity: 1; grid-template-rows: 1fr;");
    expect(reduced).toContain("transition: none;");
  });

  it("drops the word the stripe above it already said", () => {
    /* The seat colour and the player's own name are directly above the caption. "your" answered a question
       nobody was still asking; the caption itself stays, because #1098's argument was about RHYTHM. */
    expect(MACHINE).toContain(">Cash</span>");
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
