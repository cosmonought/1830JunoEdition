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

/** `&#NNNNN;` naming a PICTOGRAPHIC character -- the form the removed glyphs were actually written in.
 *
 *  Design note #713: THE FILTER NOW TESTS WHAT THE RULE SAYS. It read `codepoint > 0x2000`, a threshold
 *  chosen because the coin, locomotive and crown all sit above it -- and so does every arrow. A sale's
 *  market-move line was reported by this test as an emoji on the card, which it is not: `&#8595;` is a
 *  DOWNWARDS ARROW, `\p{Extended_Pictographic}` says so, and the literal check one line up would have let the
 *  same character through unchallenged.
 *  DECODING AND REUSING `LITERAL_EMOJI` is the point: #490's note promises this covers "BOTH SPELLINGS" of one
 *  rule, and two spellings tested by two different rules is not that. */
function entityCodepoints(source: string): number[] {
  return Array.from(source.matchAll(/&#(\d+);/g))
    .map((match) => Number(match[1]))
    .filter((codepoint) => LITERAL_EMOJI.test(String.fromCodePoint(codepoint)));
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

  it("marks the president with the shipped crown, not a font glyph", () => {
    /* ==============================================================
     *  DESIGN NOTE 552 (harness): THE RULE SURVIVED, THE ANSWER CHANGED
     * ==============================================================
     *
     * This asserted `toContain(">President<")` -- design note #490 had
     * replaced the crown emoji with the word, because a pictogram rendered
     * in a platform colour font at a platform weight is a different picture
     * on every device and therefore cannot be relied on to mean anything.
     *
     * REPORTED since: the word is nine characters wide in a column that
     * must also fit a player's name, and long names collide with the
     * column beside them.
     *
     * Both observations are right, and an inline SVG satisfies both -- so
     * what this test protects is unchanged and only its subject moved. The
     * constraint was never "use a word". It was "do not depend on a glyph
     * whose appearance somebody else chooses", and the sibling test above
     * ("has no pictographic HTML entities either") still enforces exactly
     * that. This one now pins the positive half: the mark is OURS. */
    expect(SOURCE).toContain("<PresidentCrown");
    // And the word it replaced is gone from the ownership rows, which is
    // the space the report was actually about.
    expect(SOURCE).not.toContain(">President<");
  });

  it("captions treasury on the figures row", () => {
    // Design note #489 moved it up beside market and IPO/par, and a caption
    // is what makes it a column rather than a loose number.
    expect(SOURCE).toContain(">treasury<");
  });
});

/* ==================================================================
 *  DESIGN NOTE 503 (harness): ONE SLOT, TWO LIVES
 * ==================================================================
 *
 * This block asserted `>last run<` -- the caption of a column in the figures
 * row -- and design note #503 removed that column, moving Last Run into the
 * livery stripe's badge slot where it replaces the float progress badge.
 *
 * The assertion is REPLACED rather than deleted, and it is a stronger one
 * than the string it pins. What matters about the new arrangement is not
 * that the words exist somewhere; it is that the two facts are MUTUALLY
 * EXCLUSIVE and share one slot -- an unfloated corporation shows how close
 * it is to floating, a floated one shows what it last earned, and neither
 * appears while the other does. A test for the caption alone would pass
 * against a card that rendered both at once, which is the exact regression
 * this arrangement can suffer.
 */
describe("the livery stripe's one badge slot", () => {
  it("captions the run inside the badge rather than leaving a bare figure", () => {
    /* Design note #488's objection to the previous version of this idea was
       that a naked figure beside the herald is "captioned by position",
       which means captioned by nothing. The caption is what answers it. */
    expect(SOURCE).toContain(">Last run<");
  });

  it("no longer carries last run as a column in the figures row", () => {
    // The lowercase caption was `rosterPriceLabel`'s, i.e. the stats row.
    expect(CODE).not.toContain(">last run<");
  });

  it("branches the slot on float rather than rendering both", () => {
    /* ==================================================================
        DESIGN NOTE 1148 SUPERSEDES THE PROXY, AND THE CLAIM GETS STRONGER
       ==================================================================
       THE CLAIM IS UNCHANGED and #503's harness note above states it well: the two facts are MUTUALLY
       EXCLUSIVE and share one slot, and "a test for the caption alone would pass against a card that rendered
       both at once, which is the exact regression this arrangement can suffer."
       IT WAS CHECKED BY CHARACTER DISTANCE -- `is_floated ?` within 400 characters of "Last run", and "Last
       run" within 400 of `FLOAT_THRESHOLD_PERCENT`. That worked while both readings were expressions sitting
       inside the ternary. #1148 gave the unfloated side its own component, because that slot now holds two
       readings of one number and needs state; the percentage moved with it, several hundred lines away, and
       the second distance could no longer be satisfied by any correct arrangement.
       SO THE EXCLUSIVITY IS ASSERTED ON THE BRANCHES THEMSELVES, which is what the distances were standing in
       for: one `is_floated` ternary, the last-run span on one side, the float badge on the other, and each
       rendered exactly once in the file. That fails on a card restoring the second badge -- the regression
       #503 named -- and it no longer depends on how much prose sits between two strings. */
    /* SCOPED TO THE STRIPE BEFORE ANYTHING IS ASSERTED, and that is not tidiness. The file holds TWO
       `company.is_floated ?` ternaries, so a whole-file regex with open-ended `[\s\S]*?` spans can match the
       other one paired with this one's badge and pass against an arrangement nobody wrote. Cutting the region
       first is what makes the structural test actually structural -- the previous version's real weakness was
       not the number 400, it was reasoning about distance instead of about scope. */
    const stripe = CODE.slice(
      CODE.indexOf("styles.rosterLiveryRight"),
      CODE.indexOf("styles.rosterPriceRow"),
    );
    expect(stripe).toMatch(
      /company\.is_floated \? \([\s\S]*?Last run[\s\S]*?\) : \([\s\S]*?<FloatProgressBadge/,
    );
    // Exactly one of each in the slot, so restoring the second badge beside the first goes red.
    expect(stripe.split("<FloatProgressBadge").length - 1).toBe(1);
    expect(stripe.split(">Last run<").length - 1).toBe(1);
    /* AND THE PERCENTAGE IS NOT ALSO DRAWN BESIDE THE RUN. It lives inside the badge component now, which is
       the half of the old second distance that was worth keeping. */
    expect(stripe).not.toContain("FLOAT_THRESHOLD_PERCENT");
  });
});

/* ==================================================================
 *  DESIGN NOTES 501 / 502 / 504 (harness): THE CARD'S GRAMMAR
 * ==================================================================
 *
 * Three layout requirements from one pass, and each is a RELATIONSHIP rather
 * than a value -- which is why they are pinned here instead of being left to
 * the eye. All three were wrong in the same way: the card expressed one idea
 * two different ways in two different places, and nothing noticed because
 * each half was individually correct.
 */
describe("the card's identity line", () => {
  /* READ FROM `CODE`, NOT `SOURCE`. These are ORDER assertions, and this
     file's own header note explains why that distinction matters: the design
     notes discuss these identifiers by name, at length, in between the lines
     of JSX being checked. Matching the raw source measures the distance
     between two mentions in prose rather than between two elements. The
     first draft of this block asserted a 600-character window and failed on
     a 2,479-character gap that was almost entirely design note #465. */
  it("puts the herald and the acronym in one row", () => {
    /* Design note #501. `rosterNameStack` is a column, and the acronym was
       its second CHILD -- so design note #465's "the acronym rides next to
       it" produced a stacked pair. The row wrapper is what makes the note
       and the layout agree. */
    expect(CODE).toContain("rosterIdentityRow");
    expect(CODE).toMatch(/rosterIdentityRow[\s\S]{0,400}?CorporateLogo/);
    expect(CODE).toMatch(/rosterIdentityRow[\s\S]{0,600}?rosterLiveryAcronym/);
  });

  it("keeps the full name out of that row", () => {
    // The long one still gets its own line -- it is read second and it
    // ellipsises. Only the two SHORT identifiers share a line.
    expect(CODE).toMatch(/rosterLiveryAcronym[\s\S]{0,200}?<\/span>[\s\S]{0,200}?rosterLiveryName/);
  });
});

describe("the money figures carry a dollar sign", () => {
  it("prefixes market and IPO/par", () => {
    /* Design note #502: treasury has said `$` since design note #489 put it
       on this row, and the other two did not -- one line, three figures in
       dollars, one of them saying so. */
    expect(CODE).toMatch(/\$\$\{market\}/);
    expect(CODE).toMatch(/\$\$\{company\.par_value\}/);
  });

  it("keeps the dash bare rather than rendering a currency on nothing", () => {
    // "$--" would put a unit on an absent value.
    expect(CODE).not.toContain("$--");
  });
});

describe("the asset row captions the same way round as the figures row", () => {
  it("stacks its items in a column", () => {
    /* Design note #504: `assetItem` was an inline ROW with the label first,
       so the card captioned label-then-value here and value-then-label one
       row above. */
    expect(CODE).toMatch(/assetItem: \{[\s\S]{0,200}?flexDirection: "column"/);
  });

  it("puts each label after its value in source order", () => {
    /* The property the column direction only enables. Trains: the chips (or
       the "none" fallback) come first, then the word. Same for Stations. */
    expect(CODE).toMatch(/assetEmpty[\s\S]{0,200}?>Trains</);
    expect(CODE).toMatch(/StationTokenRow[\s\S]{0,600}?>Stations</);
  });

  it("does not put a label before its value any more", () => {
    // The old order, stated as the thing that must not come back.
    expect(CODE).not.toMatch(/>Trains<[\s\S]{0,200}?TrainChips/);
    expect(CODE).not.toMatch(/>Stations<[\s\S]{0,200}?StationTokenRow/);
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
