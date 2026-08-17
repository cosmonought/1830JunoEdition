// frontend/src/components/corporationCardText.test.ts
//
// ==================================================================
//  DESIGN NOTE 490 (harness): NO PICTOGRAMS ON THE CARD
// ==================================================================
//
// The reported problem was that the corporation cards lean on emojis and
// tooltips. The fix is spread across JSX that jsdom cannot render without
// standing up the whole panel and its game state, so this file tests the
// SOURCE instead -- which is unusual enough to justify.
//
// WHY THE SOURCE IS THE RIGHT SUBJECT HERE. "No emoji" is a property of
// what the file contains, not of what any one render produces. A rendering
// test would have to enumerate states -- floated, unfloated, trainless, no
// tokens, president, no president -- and a pictogram reintroduced in the
// one branch nobody enumerated would pass. Reading the file catches it
// wherever it lands.
//
// A UNICODE PROPERTY ESCAPE, NOT A LIST. The same reasoning
// `feedItemText.test.ts` records: a test that looks for the specific coin
// and locomotive that were removed passes the moment somebody adds a
// different one, which is exactly when it should fail.
//
// BOTH SPELLINGS. The removed glyphs were HTML numeric entities
// (`&#128176;`), not literal characters, so a scan for literal emoji alone
// would have found nothing and reported success against the bug.

import fs from "fs";
import path from "path";

const CARD = path.join(__dirname, "StockRoundPanel.tsx");
const SOURCE = fs.readFileSync(CARD, "utf8");

/* ==================================================================
 *  DESIGN NOTE 490a (harness): THE PROSE IS NOT THE PROGRAM
 * ==================================================================
 *
 * This file is full of design notes that DISCUSS the things being removed,
 * by name, in the past tense -- and the first draft of the `cursor: "help"`
 * assertion below failed against the note explaining why `cursor: "help"`
 * was removed. That is the same trap a blanket rename fell into earlier in
 * this project: a search over source text cannot tell an implementation
 * from an account of one.
 *
 * So the checks that look for the ABSENCE of code read a comment-stripped
 * copy. Block comments go first, then whole-line `//` comments -- matched
 * only where the slashes open the line, so a `//` inside a string literal
 * survives.
 *
 * THE EMOJI CHECKS DELIBERATELY READ THE RAW SOURCE, because there is no
 * reason for a pictogram to appear in this file at all: the removed crown
 * was in the module header's prose as well as in the JSX, and a scan that
 * excused comments would have left it there. Absence of a STYLE RULE and
 * absence of a GLYPH are different requirements and get different subjects.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Any pictographic character, however new. */
const LITERAL_EMOJI = /\p{Extended_Pictographic}/u;

/** `&#NNNNN;` above the Basic Multilingual plane's punctuation -- the form
 *  the removed glyphs were actually written in. */
function entityCodepoints(source: string): number[] {
  return Array.from(source.matchAll(/&#(\d+);/g))
    .map((match) => Number(match[1]))
    .filter((codepoint) => codepoint > 0x2000);
}

describe("the corporation card carries no emoji", () => {
  it("has no literal pictographic characters", () => {
    expect(SOURCE).not.toMatch(LITERAL_EMOJI);
  });

  it("has no pictographic HTML entities either", () => {
    // The coin (128176), the locomotive (128642) and the crown (128081)
    // were all written this way. Reported as characters so a failure names
    // what came back rather than a number.
    const found = entityCodepoints(SOURCE).map((cp) => String.fromCodePoint(cp));
    expect(found).toEqual([]);
  });
});

describe("the labels are words", () => {
  it("captions the trains and stations rows in text", () => {
    // The requirement, literally: write the labels out rather than relying
    // on icons or tooltips.
    expect(SOURCE).toContain(">Trains<");
    expect(SOURCE).toContain(">Stations<");
  });

  it("names the president in a word rather than a glyph", () => {
    expect(SOURCE).toContain(">President<");
  });

  it("captions treasury on the figures row", () => {
    // Design note #489 moved it up beside market, IPO/par and last run, and
    // a caption is what makes it a column rather than a loose number.
    expect(SOURCE).toContain(">treasury<");
    expect(SOURCE).toContain(">last run<");
  });
});

describe("the asset row no longer advertises a tooltip", () => {
  it("does not set a help cursor", () => {
    /* `cursor: "help"` was on the row whose captions lived in `title`
       attributes. With the captions on the card, a help cursor promises an
       explanation that is already visible -- and it was the visible tell
       that the row expected to be hovered, which is the interaction the
       report is about. */
    expect(CODE).not.toContain('cursor: "help"');
  });
});
