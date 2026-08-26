/** @jest-environment node */

//
// The Buy Private card: one title, one line, one click. Mostly source text, plus one real function.
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
//
// ==================================================================
//  DESIGN NOTE 804 (harness): #779 DID HALF OF (iii) AND ARGUED FOR THE OTHER HALF
// ==================================================================
//
// REPORTED, four more against the same panel:
//   i)   "the abbreviated acronyms need to be in the same color and font as the title, since they are part
//        of the title. Right now you have it in the gray color for 'held by' which looks strange."
//   ii)  "let's remove the 'Face $20' tags since they can be displayed when a player clicks the private
//        company to buy it"
//   iii) "the spacing between the name+owner of the private company and its special power is randomly huge.
//        I had suggested either compressing this or moving the special power to the same line as the
//        name+owner, but it seems neither option was implemented."
//   iv)  "players click a Private Company and it expands to display the full rule, then they have to click
//        it again for the Offer Price and Purchase button to appear at the very bottom of the subpanel. Why
//        don't we have this all happen on one click inside the PC card?"
//
// (i) IS THE SAME REPORT AS #779's (iii), COMING BACK. That pass moved the acronym to the title's size and
// weight, left the grey alone, and then wrote a test called "keeps the monospace on it" defending the
// distinction the report was complaining about. The assertion below is now its inverse, and the reason is
// recorded rather than the test quietly flipped: the argument for monospace ("what makes an acronym read as
// a code rather than a word") is an argument FOR a distinction, and a part of a title is the one thing that
// must not have one. The acronym now declares nothing at all and inherits, so there is no second
// declaration to drift.
//
// (ii) AND (iii) ARE ONE BUG, WHICH IS THE FINDING THIS FILE EXISTS TO RECORD. #721 stacked income over face
// value in a right-hand grid cell two lines tall, opposite a left cell one line tall, under
// `alignItems: "start"`. The row's height came from the taller column and the name sat at the top of it --
// so a blank line appeared under the name that no rule in the file declared, which is exactly why it read as
// "randomly huge". Deleting the face tag collapses the right column to one line and the gap goes with it;
// `alignItems: "baseline"` is what stops it coming back the next time a column grows.
//
// (iv) WAS TWO ANSWERS TO ONE QUESTION. `selectedId` said which private the offer form was about,
// `expandedIds` said which rules were open, and two controls stacked in one row drove them separately. A
// player who clicked one of them got half a card. They collapse because the form moved INTO the card.
//
// AND #490a APPLIES HARDER THAN USUAL HERE: these notes quote "Face $20", "ui-monospace" and "Choose a
// private company first" while explaining their removal, so every assertion below runs against a
// comment-stripped copy -- and the notes are separately asserted to survive.

import { offerPriceProblem, privatePriceBounds } from "../components/PrivateTradePanel";

const read = (relative: string) => {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
};

const PANEL = read("components/PrivateTradePanel.tsx");

/** #490a: the notes quote the old markup while explaining what replaced it. */
const CODE = PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** `${...}` inside a plain string trips `no-template-curly-in-string`, and the rule is RIGHT to fire -- that
 *  pattern is almost always a template literal somebody forgot to backtick. This is the rare case where the
 *  text really is source code being searched for, so the rule is sidestepped rather than switched off. */
const DOLLAR = String.fromCharCode(36);

describe("the title is one title", () => {
  it("numbers the private", () => {
    // "1. Schuylkill Valley" -- the same numbering the auction list and the Ledger use.
    const composed = `\`${DOLLAR}{entry.private_id}. ${DOLLAR}{entry.name}\``;
    expect(CODE).toContain(composed);
  });

  it("puts the acronym in parentheses", () => {
    expect(CODE).toContain("({catalog.acronym})");
  });

  it("keeps the acronym inside the title rather than beside it", () => {
    /* THE STRUCTURAL HALF of "they are part of the title". #779 put them in one flex row as siblings, which
       is what let them carry different styles and still look deliberate. Nested, the acronym has nowhere to
       get a size, weight or colour from except the title. */
    const title = CODE.slice(CODE.indexOf("<span style={styles.rowTitle}>"), CODE.indexOf("styles.rowOwner"));
    expect(title).toContain("styles.rowAcronym");
  });

  it("gives the acronym no font of its own", () => {
    /* #779's "keeps the monospace on it", WITHDRAWN ON REPORT. Asserted as four absences rather than as
       "matches the title", because matching is what the previous pass did and what left it able to drift:
       a declaration that is not there cannot be wrong. */
    const acronym = CODE.slice(CODE.indexOf("rowAcronym: {"), CODE.indexOf("rowRight: {"));
    expect(acronym).not.toContain("ui-monospace");
    expect(acronym).not.toContain("color:");
    expect(acronym).not.toContain("fontSize");
    expect(acronym).not.toContain("fontWeight");
  });

  it("no longer paints it the colour of the owner line", () => {
    // THE ACTUAL COMPLAINT: "the gray color for 'held by'". That grey is `#8f98a8`; the acronym's was `#98a1b2`.
    const acronym = CODE.slice(CODE.indexOf("rowAcronym: {"), CODE.indexOf("rowRight: {"));
    expect(acronym).not.toContain("#98a1b2");
    expect(acronym).not.toContain("#8f98a8");
  });

  it("puts the size and weight on the title, where the acronym can inherit them", () => {
    expect(CODE).toContain("rowTitle: { fontSize: FONT_SIZE.strong, fontWeight: 700");
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

  it("colours the name and not the label", () => {
    /* "held by" stays grey so the colour marks the PERSON.
       DESIGN NOTE 830 SHORTENED THE LABEL AND KEPT IT. First asked as a deletion -- "'held by Player' seems
       like it could be reduced to just 'Player'" -- then corrected: "the Player name by itself may not be
       intuitively obvious until someone clicks to make an offer." A column labels by position only once a
       reader has learned the column, and this panel has no header row to teach them. So: "Owner:", a noun
       naming the fact, where "held by" was a clause needing the name to finish it. */
    expect(CODE).toContain('{"Owner: "}');
    expect(CODE).not.toContain('{"held by "}');
    expect(CODE).toContain("styles.rowOwnerName");
  });

  it("carries weight as well as hue", () => {
    // #732's rule: colour alone is not a distinction every player can read.
    expect(CODE).toContain("rowOwnerName: { fontWeight: 700 }");
  });
});

describe("the gap under the name had a cause, and the cause is gone", () => {
  it("dropped the face tag from the row", () => {
    /* REPORTED as its own item, and it is also half of the spacing report. The stacked figures column is
       what made the row two lines tall.
       ASSERTED STRUCTURALLY, and the first draft could not have failed: it searched for `face $${entry.cost}`
       out of habit from the harnesses that read template literals, and this is JSX -- the `$` is a literal
       character beside an expression, so the doubled form never existed anywhere. Worse, the correct single
       form is the string the OFFER LINE now prints, so an absence test on the text would contradict the
       presence test below. What is really being asserted is that the row's figures column is gone. */
    expect(CODE).not.toContain("styles.rowFace");
    expect(CODE).not.toContain("rowFace: {");
    expect(CODE).not.toContain("rowFigures");
  });

  it("leaves one line in the right-hand column", () => {
    /* THE PROPERTY, not just the deletion: a column that stacks two things is a column that can be taller
       than the name again. `rowRight` is a ROW, and the caret is the only thing beside the income. */
    const right = CODE.slice(CODE.indexOf("rowRight: {"), CODE.indexOf("rowIncome: {"));
    expect(right).toContain('flexDirection: "row"');
    expect(right).not.toContain('flexDirection: "column"');
  });

  it("aligns the two columns by baseline rather than by their tops", () => {
    /* THE MECHANISM, stated so a future column cannot quietly reintroduce the gap. Under
       `alignItems: "start"` the row is as tall as its tallest cell and the short cell sits at the top of it;
       under `baseline` the first lines meet and the row is as tall as its content. */
    const row = CODE.slice(CODE.indexOf("  row: {"), CODE.indexOf("rowName: {"));
    expect(row).toContain('alignItems: "baseline"');
    expect(row).not.toContain('alignItems: "start"');
  });

  it("owns its padding now that nothing renders beneath it", () => {
    /* #779 trimmed this to "6px 12px 2px" and handed the missing bottom padding to the disclosure button.
       There is no disclosure button, so the clipped figure would now just be a clipped figure. Asserted as
       literals rather than as "is smaller" -- six rows stack, so a later tidy that restores 9px is 6x on the
       panel and would otherwise pass silently. */
    expect(CODE).toContain('padding: "7px 12px"');
    expect(CODE).not.toContain('padding: "6px 12px 2px"');
    expect(CODE).not.toContain('padding: "9px 12px 5px"');
  });
});

describe("the special power sits on the title's line", () => {
  it("renders inside the name row rather than under it", () => {
    /* REQUESTED TWICE: "moving the special power to the same line as the name+owner". Structural, because
       jsdom measures nothing -- what can be proved is that the summary is a sibling of the title inside the
       same wrapping flex row, which is what "same line" means in a flex layout. */
    const nameRow = CODE.slice(
      CODE.indexOf("<span style={styles.rowName}>"),
      CODE.indexOf("<span style={styles.rowRight}>"),
    );
    expect(nameRow).toContain("styles.rowTitle");
    expect(nameRow).toContain("styles.rowOwner");
    expect(nameRow).toContain("styles.rowPower");
  });

  it("wraps rather than truncating", () => {
    /* A long summary (the D&H's) must fall to a second line intact. Truncation would trade the reported
       spacing problem for a hidden-information problem, which is the worse of the two. */
    /* DESIGN NOTE 830 MOVED THE WRAP OFF `rowName`. #804 held the title, the owner and the power in one
       wrapping flex, so wrapping was that container's job. They are grid columns now -- the power has its own
       and takes the `1fr`, which is what lets a long summary wrap without pushing anything else around. The
       property asserted is unchanged: a long power falls to a second line rather than being cut. */
    const row = CODE.slice(CODE.indexOf("  row: {"), CODE.indexOf("rowName: {"));
    expect(row).toContain('gridTemplateColumns: "auto minmax(0, 1fr) auto auto"');
    const power = CODE.slice(CODE.indexOf("rowPower: {"), CODE.indexOf("cardBody: {"));
    expect(power).not.toContain("textOverflow");
    expect(power).not.toContain("WebkitLineClamp");
  });

  it("stopped being a control", () => {
    /* #721 made the sentence the disclosure button. The face is the disclosure now, so a second button would
       be #263's "two controls for one outcome" inside a single row. */
    expect(CODE).not.toContain("rowDisclosure");
    expect(CODE).not.toContain("Read the full rule.");
  });
});

describe("one click opens the card, and the card is the whole transaction", () => {
  it("has one control on the face", () => {
    expect(CODE).toContain("onClick={() => toggleCard(entry)}");
    expect(CODE).toContain("aria-expanded={isOpen}");
    expect(CODE).toContain("aria-controls={detailId}");
  });

  it("no longer keeps a selection apart from the disclosure", () => {
    // THE TWO ANSWERS TO ONE QUESTION, as absences.
    expect(CODE).not.toContain("selectedId");
    expect(CODE).not.toContain("expandedIds");
    expect(CODE).not.toContain("setPriceText(");
  });

  it("opens a blocked private too", () => {
    /* #386 showed a blocked row and put its reason in a `title` attribute -- a hover, on a game played on a
       tablet. The face is no longer `disabled`, so the reason is reachable. */
    const face = CODE.slice(CODE.indexOf("onClick={() => toggleCard(entry)}"), CODE.indexOf("styles.rowName"));
    expect(face).not.toContain("disabled=");
    expect(CODE).toContain("<p style={styles.cardBlocked}>{blocked}</p>");
  });

  it("puts the price field and the submit inside the card", () => {
    /* THE REPORT. The form used to render once, at the bottom of the panel, about whichever private was
       selected -- so a player reading the D&H typed a price under the B&O. */
    /* Design note #841 changed the opening tag: the card body carries `{...STICKY_OPTIONAL}` now, so the bar
       does not count reference behind a disclosure as part of its resting height. The anchor is the shorter,
       stable prefix rather than the whole tag -- an anchor that includes every attribute breaks on the next
       attribute, which is what happened here. */
    const start = CODE.indexOf("<div id={detailId} style={styles.cardBody}");
    expect(start).toBeGreaterThan(-1);
    const card = CODE.slice(start, CODE.indexOf("if (embedded) return body;", start));
    expect(card.length).toBeGreaterThan(0);
    expect(card).toContain("styles.cardRule");
    expect(card).toContain("styles.priceInput");
    expect(card).toContain("onPropose(entry.private_id, price)");
    expect(card).toContain("disabled={priceProblem !== null}");
  });

  it("has exactly one submit in the file", () => {
    /* THE GUARD. A panel-level button left beside the per-card one would be two controls for one outcome and
       would reintroduce the second click. */
    expect(CODE.match(/Propose Purchase/g)).toHaveLength(1);
    expect(CODE).not.toContain("styles.footer");
    expect(CODE).not.toContain("styles.secondaryButton");
  });

  it("prices each open card separately", () => {
    /* #661's Set survives -- "comparing two privates is the reason a player opens one at all" -- so two
       cards can be open, and a single `priceText` would have shown one card's number in the other's field. */
    expect(CODE).toContain("const [openIds, setOpenIds] = useState<ReadonlySet<number>>");
    expect(CODE).toContain("const [priceTexts, setPriceTexts] = useState<ReadonlyMap<number, string>>");
    expect(CODE).toContain("priceTexts.get(entry.private_id)");
  });

  it("does not overwrite a typed price when the card is reopened", () => {
    // Identity, which is both the refusal idiom this codebase uses and what makes the re-open free.
    const seed = CODE.slice(CODE.indexOf("setPriceTexts((current) => {"), CODE.indexOf("const setPriceFor"));
    expect(seed).toContain("if (current.has(entry.private_id)) return current;");
  });
});

describe("nothing was fixed by deleting a fact", () => {
  it("keeps every figure the row was carrying", () => {
    /* THE GUARD ON THIS WHOLE PASS, inherited from #779 and updated. Height was the complaint again, and the
       cheapest way to satisfy it would have been to drop the income, the owner or the acronym. */
    for (const kept of ["rowIncome", "rowOwner", "rowAcronym", "rowPower"]) {
      expect(CODE).toContain(kept);
    }
  });

  it("moves the face value on, rather than dropping it (design note #843)", () => {
    /* #804 REHOMED IT FROM THE ROW TO THE PRICE FIELD -- "they can be displayed when a player clicks the
       private company to buy it" -- and #842 moved it once more, off the field entirely:
         "The face value does explain the range we're giving players, but in the grand scheme of things I'm
          not sure it matters that we give them the value to compute the range themselves when we already
          give them the range."
       THE GUARD IS THE POINT OF THIS DESCRIBE BLOCK, so it is kept rather than deleted: the number still
       exists, in `privateCatalog.ts` and in the Rules Reference table built from it. What is asserted is the
       DESTINATION, because "not on the field" alone would pass equally well if the fact had been lost. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const catalog = fs.readFileSync(path.join(__dirname, "privateCatalog.ts"), "utf8");
    expect(CODE).not.toContain("face " + DOLLAR + "{entry.cost}");
    expect(CODE).not.toContain("styles.priceBand");
    expect(catalog).toContain("faceValue: 220");
    expect(
      fs.readFileSync(path.join(__dirname, "..", "components", "RulesReference.tsx"), "utf8"),
    ).toContain(DOLLAR + "{row.faceValue}");
  });

  it("still shows the full rule on the same click", () => {
    expect(CODE).toContain("{catalog && <p style={styles.cardRule}>{catalog.ability}</p>}");
  });

  it("kept the notes that explain what was removed", () => {
    /* #490a: this file scans a comment-stripped copy, so the notes are asserted against the RAW source --
       otherwise a pass could satisfy every absence above by deleting the reasoning along with the code. */
    expect(PANEL).toContain("ui-monospace");
    expect(PANEL).toContain("Face $20");
    expect(PANEL).toContain("Choose a private company first.");
  });
});

describe("the offer's refusals, as a function", () => {
  /* Design note #804: lifted out of the render, where they were a six-armed ternary nobody could call. The
     Schuylkill Valley: face $20, so the band is $10-$40. */
  const SV = { faceValue: 20, treasury: 300, buyerTicker: "PRR" };

  it("asks for a price when the field is empty", () => {
    expect(offerPriceProblem({ ...SV, priceText: "" })).toBe("Enter a price between $10 and $40.");
    expect(offerPriceProblem({ ...SV, priceText: "   " })).toBe("Enter a price between $10 and $40.");
  });

  it("refuses a fraction", () => {
    // The contract deals in whole VGP; a decimal here would be rounded somewhere the player cannot see.
    expect(offerPriceProblem({ ...SV, priceText: "12.5" })).toBe("Price must be a whole number.");
    expect(offerPriceProblem({ ...SV, priceText: "abc" })).toBe("Price must be a whole number.");
  });

  it("names which end of the band was missed", () => {
    /* Each failure gets its own sentence. "Invalid price" would leave the player guessing which of five
       things was wrong, and the band is the one they most often trip on. */
    expect(offerPriceProblem({ ...SV, priceText: "9" })).toBe(
      "$9 is below 50% of face value ($10 minimum).",
    );
    expect(offerPriceProblem({ ...SV, priceText: "41" })).toBe(
      "$41 is above 200% of face value ($40 maximum).",
    );
  });

  it("names the treasury that cannot pay", () => {
    expect(offerPriceProblem({ ...SV, treasury: 30, priceText: "40" })).toBe(
      "PRR's treasury holds $30 — it cannot pay $40.",
    );
  });

  it("permits the seeded face value", () => {
    // The neutral offer, which is what the card opens with -- it must never open onto an error.
    expect(offerPriceProblem({ ...SV, priceText: "20" })).toBeNull();
    expect(offerPriceProblem({ ...SV, priceText: "10" })).toBeNull();
    expect(offerPriceProblem({ ...SV, priceText: "40" })).toBeNull();
  });

  it("no longer has a case for no selection at all", () => {
    /* THE DELETED ARM. "Choose a private company first." was reachable only while the form lived at the
       bottom of the panel; inside the card there is no such state. #788's lesson: an unreachable arm passes
       every test written for it and reads as a case that happens. */
    expect(CODE).not.toContain("Choose a private company first.");
  });
});

describe("the mirrored price band", () => {
  it("rounds inward at both ends", () => {
    /* A rounded bound must never fall OUTSIDE the band the contract checks -- rounding the other way would
       offer a price that looks legal in the panel and is rejected on chain, which is the one failure this
       mirror exists to prevent. Face $45: 50% is $22.50 and 200% is $90. */
    expect(privatePriceBounds(45)).toEqual({ min: 23, max: 90 });
  });

  it("agrees with the sentences the panel prints", () => {
    // One authority, consulted by the bound and by the refusal -- not two arithmetics that happen to match.
    const bounds = privatePriceBounds(220);
    expect(offerPriceProblem({ faceValue: 220, treasury: 9999, buyerTicker: "NYC", priceText: String(bounds.min) })).toBeNull();
    expect(offerPriceProblem({ faceValue: 220, treasury: 9999, buyerTicker: "NYC", priceText: String(bounds.min - 1) })).toContain("below 50%");
  });
});

describe("the shell supplies the colour", () => {
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
