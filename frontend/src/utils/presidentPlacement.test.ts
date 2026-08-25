/** @jest-environment node */

// No runtime imports: this file reads source text. `export {}` makes it a module for `--isolatedModules`.
export {};
//
// The crown sits under the treasury, on the full name's line. No DOM.
//
// ==================================================================
//  DESIGN NOTE 805 (harness): A POSITION THAT MOVED WITH THE FLEET
// ==================================================================
//
// REQUESTED: "the president information is currently the last item on a line in small font. I wonder if it
// would make sense to place it under the Treasury information on the same line as the corporation's full
// name, if possible? This would not add vertical space to the corporation card, but would keep the president
// identifier right by the name of the corporation."
//
// THIS FACT HAS NOW BEEN MOVED THREE TIMES AND THE FIRST TWO REASONS WERE BOTH RIGHT.
//   #589 put it on the full name's line: "the Pennsylvania Railroad, Ada presiding" is one thought.
//   #671 took it off again, because "the full name is the LONGEST string here and the president's name sat
//        downstream of it. Every company shifted the crown to a different x."
// Both true. What #671 did NEXT is the part that did not hold: it parked the crown at the END of the facts
// rail -- a rail that WRAPS, and whose length changes with the number of privates a corporation owns, the
// size of its fleet and the width of the window. The fix for "no fixed place to look" was a position with
// even less fixity, and the note claimed the opposite ("where the row's own gaps give it a stable position").
//
// THE REQUEST'S OWN REASONING IS WHAT MAKES THE THIRD PLACEMENT DIFFERENT, and it is about the CARD's
// geometry rather than about the rail's: the identity block is two rows (herald over full name) and the
// facts rail was one, so the card's height has always been set by the left column. A second row on the right
// spends slack that already existed. That is a claim about layout, so it is the one thing here a source scan
// cannot check -- see the note on the alignment invariant below for what CAN be checked instead.
//
// WHAT THIS FILE PINS is the relationship the alignment depends on: the right column's first row is exactly
// as tall as the herald, so its second row shares the full name's line. Two consumers, one number. Written
// as `24` in both places it would survive about one refactor.

const read = (relative: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
};
const strip = (raw: string) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const BAR = read("panels/ContextualActionBar.tsx");
/** #490a: three notes quote the placements they replaced, including this one's. */
const CODE = strip(BAR);
const STYLES = strip(read("styles/appStyles.ts"));

/** `${...}` in a plain string trips `no-template-curly-in-string`, rightly -- see #779's harness. */
const DOLLAR = String.fromCharCode(36);

const at = (needle: string) => {
  const index = CODE.indexOf(needle);
  if (index === -1) throw new Error(`anchor not found: ${needle}`);
  return index;
};

describe("the president left the end of the rail", () => {
  it("renders inside the first fact rather than after the last", () => {
    /* THE REPORT, as order. It used to come after the privates chips -- which are themselves conditional, so
       on seven companies out of eight it came after the train limit and on the eighth it did not. */
    expect(at("styles.orContextTreasuryStack")).toBeLessThan(at("activeCorporation.presidentLabel &&"));
    expect(at("activeCorporation.presidentLabel &&")).toBeLessThan(at("<StationTokenRow"));
    expect(at("activeCorporation.presidentLabel &&")).toBeLessThan(at("<TrainChips"));
    expect(at("activeCorporation.presidentLabel &&")).toBeLessThan(
      at("activeCorporation.privates.length > 0"),
    );
  });

  it("shares a column with the treasury and nothing else", () => {
    /* The stack holds exactly two rows. A third fact moved in here would make the column a rail of its own
       and put the crown back on a line whose position depends on what is above it. */
    const stack = CODE.slice(at("styles.orContextTreasuryStack"), at("<StationTokenRow"));
    expect(stack).toContain("Treasury");
    expect(stack).toContain("<PresidentCrown");
    expect(stack).not.toContain("<TrainChips");
    expect(stack).not.toContain("Train limit:");
  });

  it("is drawn once", () => {
    // The guard on a move: a crown left behind at the old site would be the same fact in two places.
    expect(CODE.match(/<PresidentCrown/g)).toHaveLength(1);
  });
});

describe("the second rows line up because one number says so", () => {
  it("sizes the herald from the shared constant", () => {
    expect(CODE).toContain("const CORPORATION_HERALD_PX = 24;");
    expect(CODE).toContain("size={CORPORATION_HERALD_PX}");
    expect(CODE).not.toContain("size={24}");
  });

  it("floors the treasury row at the same height", () => {
    /* THE INVARIANT, and the only part of "on the same line as the corporation's full name" that a source
       scan can reach. jsdom measures nothing, so whether the two rows visually agree is a playtest question
       -- what is checkable is that they are derived from one figure rather than from two that match today. */
    expect(CODE).toContain("minHeight: `" + DOLLAR + "{CORPORATION_HERALD_PX}px`");
  });

  it("has exactly one declaration and two consumers", () => {
    /* Asserted as a count because the failure this prevents is silent: someone writes `24` back into one of
       the two sites, everything still renders, and the rows drift the next time the type scale moves. */
    expect(CODE.match(/CORPORATION_HERALD_PX/g)).toHaveLength(3);
  });

  it("spaces the two columns' rows identically", () => {
    /* `orContextIdentity` puts 1px between the herald and the full name. The stack uses the same 1px between
       the treasury and the crown, which is what makes equal first rows produce aligned second rows. */
    const identity = STYLES.slice(
      STYLES.indexOf("orContextIdentity: {"),
      STYLES.indexOf("orContextSubRow: {"),
    );
    const stack = STYLES.slice(
      STYLES.indexOf("orContextTreasuryStack: {"),
      STYLES.indexOf("orContextTreasuryStack: {") + 260,
    );
    expect(identity).toContain('gap: "1px"');
    expect(stack).toContain('gap: "1px"');
    expect(stack).toContain('flexDirection: "column"');
    expect(stack).toContain('alignItems: "flex-start"');
  });
});

describe("the president's own styling stopped being assembled at the call site", () => {
  it("carries its layout in the style key", () => {
    /* It was spreading `orContextFact` for `display: inline-flex` and then overriding that key's 6px gap
       back to zero -- because `orContextFact`'s gap is the space between a CAPTION and its value, and there
       is no caption here (the crown brings its own 3px margin). Two declarations to reach one arrangement,
       and the override is the kind of line a tidy deletes. */
    const style = STYLES.slice(
      STYLES.indexOf("orContextPresident: {"),
      STYLES.indexOf("orContextTreasuryStack: {"),
    );
    expect(style).toContain('display: "inline-flex"');
    expect(style).toContain('alignItems: "center"');
    expect(CODE).not.toContain("...styles.orContextPresident,\n                      gap: 0,");
    expect(CODE).not.toContain("gap: 0,");
  });

  it("stays a step below the figures beside it", () => {
    /* #671's typography argument, which #805 strengthens rather than replaces: the rail's values are tabular
       monospace because they are quantities a president COMPARES, and a name is not one. It matters more now
       that the name sits directly under a figure instead of beside four -- one size and one weight down that
       column would read as two rows of the same table. */
    const style = STYLES.slice(
      STYLES.indexOf("orContextPresident: {"),
      STYLES.indexOf("orContextTreasuryStack: {"),
    );
    expect(style).toContain("fontSize: FONT_SIZE.small");
    expect(style).not.toContain("ui-monospace");
    expect(style).not.toContain("tabular-nums");
  });
});

describe("nothing about the fact itself was lost in the move", () => {
  it("keeps the crown as its only caption", () => {
    /* #671: the crown IS the caption -- the mark every other surface uses for this fact (`PlayerCards` #567
       settled it the same way) -- and "PRESIDENT [crown] Ada" says it twice. It now sits under the word
       "Treasury", which is a caption, so the absence of a second one is what keeps the column from reading
       as a label above its value. */
    expect(CODE).toContain("<PresidentCrown scale={0.95}");
    const stack = CODE.slice(at("styles.orContextTreasuryStack"), at("<StationTokenRow"));
    expect(stack).not.toContain("PRESIDENT");
    expect(stack).not.toContain("orContextFactLabel, color: corporationBarInk.inkMuted }}>\n                      President");
  });

  it("carries no hidden second figure under the treasury", () => {
    /* WITHDRAWN ONE TURN AFTER I WROTE IT, on report: "we can remove the tooltip on the President's
       treasury/cash since we've added this information at the bottom panel of the screen."
       AND #805 ARGUED FOR THE REMOVAL WITHOUT NOTICING. Its note claimed the cash tooltip was "MORE
       load-bearing" once the president sat directly under the treasury, because the two purses must not read
       as one figure. That is the reasoning for deleting it: a hidden number under a visible number is exactly
       what invites the conflation. The figure is on the player cards under the board for the whole table
       (#670's strip, replaced by `PlayerCards` itself at #819 -- the surface changed, the availability did
       not, which is the only part this assertion ever depended on).
       THE UNDERLINE IS ASSERTED SEPARATELY because it is the half a tidy would leave behind -- a dotted
       underline promises that hovering says something. */
    expect(CODE).not.toContain("presidentCash");
    expect(CODE).not.toContain('textDecoration: "underline dotted 1px"');
    expect(CODE).not.toContain('cursor: "help"');
  });

  it("removed the prop as well as the tooltip", () => {
    /* #660a's rule: the shell resolved this figure on every render of the acting corporation, for one
       reader. An unread prop is legal, silent, and invisible to `tsc` -- so the deletion has to be asserted
       or it half-happens. */
    const app = read("App.tsx");
    expect(strip(app)).not.toContain("presidentCash:");
    expect(strip(read("panels/ContextualActionBar.tsx"))).not.toContain("presidentCash");
  });

  it("keeps the muted ink it is legible in", () => {
    // The bar is painted in the acting corporation's livery, so the ink is derived rather than fixed (#236).
    const stack = CODE.slice(at("styles.orContextTreasuryStack"), at("<StationTokenRow"));
    expect(stack).toContain("color: corporationBarInk.inkMuted,");
  });

  it("kept the notes for the two placements this replaces", () => {
    /* #490a: the scan runs on a comment-stripped copy, so a pass could satisfy every assertion above by
       deleting the reasoning with the code. #589's and #671's arguments are the record of why this fact has
       moved three times, and the next person to move it should have to disagree with them on purpose. */
    expect(BAR).toContain("THE PRESIDENT WAS HERE, AT THE END OF THE RAIL");
    expect(BAR).toContain("Every company shifted the crown to a different x");
  });
});

describe("the corporation card did not grow a row", () => {
  it("still lays the card out as one wrapping flex row", () => {
    /* The request's claim is that a second row on the RIGHT costs nothing because the LEFT already has two.
       That is a measurement and this file cannot make it -- what it can check is that the change did not
       reach for height some other way: no new row in the card, no minimum height, no second facts rail. */
    const card = STYLES.slice(STYLES.indexOf("orContextCard: {"), STYLES.indexOf("orContextIdentity: {"));
    expect(card).toContain('flexDirection: "row"');
    expect(card).not.toContain("minHeight");
    expect(CODE.match(/styles\.orContextFacts/g)).toHaveLength(1);
  });

  it("leaves the rail's other facts where they were", () => {
    // Stations, Trains and Privates are untouched siblings; only the first cell became a column.
    expect(CODE).toContain("<span style={styles.orContextFact}>");
    expect(CODE).toContain("<StationTokenRow");
    expect(CODE).toContain("Train limit: {activeCorporation.trains.length} / {phase.trainLimit}");
  });
});
