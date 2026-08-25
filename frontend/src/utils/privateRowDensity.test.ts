/** @jest-environment node */

// No runtime imports: this file reads source text. `export {}` makes it a module anyway, which
// `--isolatedModules` requires -- caught by `tsc` after Jest had happily run it.
export {};
//
// The Buy Private row: numbered, one title, the holder in their colour, and shorter. No React.
//
// ==================================================================
//  DESIGN NOTE 779 (harness): SIX ROWS, SO EVERY PIXEL COUNTS SIX TIMES
// ==================================================================
//
// REPORTED, four asks against one panel:
//   i)   "the private companies here lack the numbering we've given them everywhere else"
//   ii)  "'held by [Player]' -- the Player could be printed in their player color"
//   iii) the acronym should read "1. Schuylkill Valley (SV)" rather than sitting "on the same line and in
//        the same font as the 'held by' information"
//   iv)  "considerably reduce the padding from their name to their special power"
//
// (i) AND (iii) ARE ONE FIX, and #423 is why. That note settled that the acronym is the private's IDENTITY
// -- "away from that list, `3` names nothing" -- while #341, which it corrected, was right that players say
// the number WHILE the numbered list is in front of them. Both are true. The row was rendering them as three
// separate spans, one of which (`micro`, grey) was styled identically to "held by Ada", so a reader had to
// work out which of the three named the piece. One title carries both.
//
// WHY THIS FILE IS MOSTLY A SOURCE SCAN, stated plainly: this is a layout change, and jsdom measures nothing.
// What can be pinned exactly is the string the row composes and the fact that the padding figures went DOWN
// rather than being renamed. Whether the panel now fits the sticky bar is a playtest question.
//
// AND ONE REAL ASSERTION UNDERNEATH: `colorForAddress` is optional, and the panel must fall back to grey
// rather than to a wrong colour. On a table where colour identifies a person, the wrong colour is worse than
// none -- the same reasoning `seatColor` gives for indexing rather than hashing.

const PANEL = (() => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(
    path.join(__dirname, "..", "components", "PrivateTradePanel.tsx"),
    "utf8",
  );
})();

/** #490a: the notes quote the old markup while explaining what replaced it. */
const CODE = PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("the title is one title", () => {
  it("numbers the private", () => {
    /* "1. Schuylkill Valley" -- the same numbering the auction list and the Ledger use.
       The dollar sign is built from its char code, which looks absurd and is the honest answer:
       `no-template-curly-in-string` fires on `${...}` inside a plain string and it is RIGHT to -- that
       pattern is almost always a template literal somebody forgot to backtick. This is the rare case where
       the text really is source code being searched for, so the rule is sidestepped rather than switched
       off, and the reason is written here so the next reader does not "tidy" it back. */
    const dollar = String.fromCharCode(36);
    const composed = `\`${dollar}{entry.private_id}. ${dollar}{entry.name}\``;
    expect(CODE).toContain(composed);
  });

  it("puts the acronym in parentheses", () => {
    expect(CODE).toContain("({catalog.acronym})");
  });

  it("no longer styles the acronym like the owner line", () => {
    /* THE ACTUAL COMPLAINT in (iii): both were `FONT_SIZE.micro` and both were grey, so the acronym read as
       a fact ABOUT the private rather than as its name. It takes the title's size and weight now. */
    const acronym = CODE.slice(CODE.indexOf("rowAcronym: {"), CODE.indexOf("rowFigures: {"));
    expect(acronym).toContain("fontSize: FONT_SIZE.strong");
    expect(acronym).not.toContain("fontSize: FONT_SIZE.micro");
  });

  it("keeps the monospace on it", () => {
    /* Not everything about the old style was wrong: monospace is what makes an acronym read as a code rather
       than as a short word, and #423's whole argument is that the acronym is an identifier. */
    const acronym = CODE.slice(CODE.indexOf("rowAcronym: {"), CODE.indexOf("rowFigures: {"));
    expect(acronym).toContain("ui-monospace");
  });
});

describe("the holder is marked by colour and by weight", () => {
  it("takes the colour from an injected lookup", () => {
    /* `seatColor` needs the roster INDEX and this panel has a lookup by address, so the shell answers. The
       same injection rule `utils/` follows for rules tables (#7). */
    expect(CODE).toContain("colorForAddress?: (address: string) => string | null;");
    expect(CODE).toContain("colorForAddress?.(entry.owner)");
  });

  it("falls back to the default rather than to a wrong colour", () => {
    /* The conditional spread: absent lookup means the grey it had before. On a table where colour identifies
       a person, a confident wrong colour is the worse failure -- `seatColor`'s own reason for indexing
       rather than hashing ("roughly a third of the time at six players"). */
    expect(CODE).toContain("? { color: colorForAddress(entry.owner) as string }");
    expect(CODE).toContain(": {}),");
  });

  it("colours the name and not the phrase", () => {
    // "held by" stays grey so the colour marks the PERSON.
    expect(CODE).toContain('{"held by "}');
    expect(CODE).toContain("styles.rowOwnerName");
  });

  it("carries weight as well as hue", () => {
    // #732's rule: colour alone is not a distinction every player can read.
    expect(CODE).toContain("rowOwnerName: { fontWeight: 700 }");
  });
});

describe("the row got shorter", () => {
  it("trimmed the face padding", () => {
    /* Asserted as the literal new figures rather than "is smaller": six rows stack, so this is 6x on the
       panel, and a later tidy that restores 9px would otherwise pass silently. */
    expect(CODE).toContain('padding: "6px 12px 2px"');
    expect(CODE).not.toContain('padding: "9px 12px 5px"');
  });

  it("trimmed the disclosure padding", () => {
    expect(CODE).toContain('padding: "0 12px 6px"');
    expect(CODE).not.toContain('padding: "0 12px 9px"');
  });

  it("did not reach the fix by deleting a fact", () => {
    /* THE GUARD ON THIS WHOLE PASS. Height was the complaint, and the cheapest way to satisfy it would have
       been to drop the income, the face value or the owner. All four survive; only the spacing moved. */
    for (const kept of ["rowIncome", "rowFace", "rowOwner", "rowAcronym"]) {
      expect(CODE).toContain(kept);
    }
  });
});

describe("the shell supplies the colour", () => {
  const read = (relative: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  };

  it("threads it through the bar", () => {
    expect(read("panels/ContextualActionBar.tsx")).toContain(
      "colorForAddress={privatePurchase.colorForAddress}",
    );
  });

  it("resolves the seat index where the roster is", () => {
    const app = read("App.tsx");
    expect(app).toContain("colorForAddress: (address: string) => {");
    expect(app).toContain("return seat === -1 ? null : seatColor(address, seat);");
  });
});
