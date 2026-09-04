/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1153 (harness): THE PANEL WAS STRETCHED, NOT SPACIOUS
// ==================================================================
//
// REPORTED across five lettered items, and they are one fault seen from five angles: the two halves of every
// fact on this panel were as far apart as the layout could put them.
//
//   `dividendPanel` was `1fr 1fr` -- each column took half the bar, several hundred pixels on a wide screen.
//   `dividendRow` was `space-between` and the figures carried `marginLeft: auto`, so within that half the
//   holder went to one end and the money to the other.
//
// SO THE PAYOUT SIDE READ AS TWO DISCONNECTED COLUMNS ("the entities and Market Move are far to the left of
// it") while the withhold side, being one short string, happened to sit under its own button and read
// cleanly. The report worked out the fix itself: "the consequence subpanel on Pay Out could also be
// 'compressed' ... we might be able to significantly narrow them together, and then use that for the
// Withhold."
//
// A RESTATEMENT OF THE REQUEST INVERTED IT -- "compress the Pay Out list ... matching the clean, readable
// column feel of the Withhold side" -- and the report says in the previous item that the Withhold side has no
// columns at all, it is "a single string". Compressing Pay and then giving that form to Withhold is the
// opposite operation. These cases assert the one that was asked for.

export {};

const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const BAR = readStripped("panels/ContextualActionBar.tsx");
const STYLES = readStripped("styles/appStyles.ts");

describe("both sides state their figure the same way", () => {
  it("puts the total on the withhold button", () => {
    /* REPORTED: "'Withhold to Treasury' does not [list the value]. It should say 'Withhold $x to Treasury.'" */
    expect(BAR).toContain("`Withhold $${declaredRevenue} to Treasury`");
  });

  it("puts the total on the pay button too, which is what makes the headings deletable", () => {
    /* THE PUSHBACK THE REPORT INVITED, and the only substantive one. The buttons did NOT already carry every
       amount: Pay had the per-share figure and the HEADING had the total, so deleting the headings as they
       stood would have removed the only visible statement of what the corporation earned -- leaving it in a
       `title`, which a tablet never shows. */
    expect(BAR).toContain("`Pay Dividends $${declaredRevenue} ($${declaredPerShare}/share)`");
  });

  it("leaves the $0 branch alone", () => {
    /* #414's rule is that a $0 withhold is a different sentence about a different situation -- there is no Pay
       button beside it to mirror, so there is nothing to make consistent. */
    expect(BAR).toContain('"Withhold $0 — Share Price Steps Left"');
  });
});

describe("the headings are gone and nothing went with them", () => {
  it("removes both restatements of the buttons above", () => {
    expect(BAR).not.toContain("Pay out ${declaredRevenue}");
    expect(BAR).not.toContain("Withhold ${dividendRevenue}</span>");
  });

  it("takes their styles out rather than leaving them orphaned", () => {
    /* An unused style entry is the half of a deletion that gets forgotten, and this table has been caught with
       one before. Both names are absent from the declarations; they survive only in prose saying where they
       went, which is why this reads the STRIPPED source. */
    expect(STYLES).not.toContain("dividendHeading:");
    expect(STYLES).not.toContain("dividendRow:");
  });

  it("gives the freed emphasis to the figures, as asked", () => {
    /* "The font size/emphasis used on these (unnecessary) titles could be applied to the entities and payouts
       without harm." `dividendHeading` was this panel's only `FONT_SIZE.strong`; the label and figure cells
       take it now, so the panel gains a size step rather than only losing two lines. */
    const holder = sliceBetween(STYLES, "dividendHolder: {", "\n  },");
    expect(holder).toContain("fontSize: FONT_SIZE.strong");
    expect(sliceBetween(STYLES, "treasuryMove: {", "\n  },")).toContain("fontSize: FONT_SIZE.strong");
  });
});

describe("the columns are sized to their contents and centred under their buttons", () => {
  it("stops giving each side half the bar", () => {
    /* `1fr 1fr` IS WHERE THE GAP CAME FROM. Centring the pair is what puts each column under the centred
       button it belongs to -- the thing the report wanted from the withhold side and could not see how to get
       from pay. */
    const panel = sliceBetween(STYLES, "dividendPanel: {", "\n  },");
    expect(panel).not.toContain('gridTemplateColumns: "1fr 1fr"');
    expect(panel).toContain('justifyContent: "center"');
  });

  it("makes each column a content-width two-cell grid", () => {
    const column = sliceBetween(STYLES, "dividendColumn: {", "\n  },");
    expect(column).toContain('gridTemplateColumns: "max-content max-content"');
  });

  it("stops pushing the figures to the far end", () => {
    /* `marginLeft: auto` was the other half of the separation, and it is the one that would survive a change
       to the panel's own columns -- so it is asserted separately from them. */
    expect(sliceBetween(STYLES, "dividendMoveGroup: {", "\n  },")).not.toContain("marginLeft");
  });

  it("spans the empty-shareholders sentence across both cells", () => {
    /* It is a SENTENCE where every other row is a pair. Left in one cell it would wrap inside the label column
       against a figures column holding nothing. */
    expect(sliceBetween(STYLES, "dividendNote: {", "\n  },")).toContain('gridColumn: "1 / -1"');
  });
});

describe("every row is a label cell and a figures cell", () => {
  it("dissolves the row wrapper so its halves join the column's grid", () => {
    /* A row box of its own is exactly what stopped the figures aligning: each row sized itself, so no two
       `$before + $amount -> $after` shared an edge. `React.Fragment` puts both cells in the column's grid. */
    expect(BAR).toContain("<React.Fragment key={row.holder}>");
    expect(BAR).toContain("<span style={styles.dividendHolder} title={describeDividendRow(row)}>");
  });

  it("keeps the tooltip on something that has a box", () => {
    /* The `title` moved down a level with the wrapper. A `display: contents` element has no box, so a title on
       it has nothing to hover -- an easy way to delete a tooltip by accident while moving markup. */
    expect(BAR).not.toContain("style={styles.dividendRow}");
  });

  it("names the withhold balance instead of only its owner", () => {
    /* REPORTED: "on Withhold, we currently have [herald] $current > $new. Let's have it read: '[herald]
       Treasury $current > $new'." #509a's herald answered WHOSE and left WHAT to inference -- and the share
       price is also on this panel, also moving between two values. */
    /* ANCHORED ON CODE, NOT ON THE NOTE BESIDE IT. The first draft of this case sliced from the design-note
       heading -- which `readStripped` removes, so it was reading from a marker that cannot exist in the string
       it searches. The label cell and its herald are the claim; they are what is asserted. */
    const withhold = sliceBetween(BAR, "${activeCorporation.ticker} treasury`}", "</span>");
    expect(withhold).toContain("Treasury");
    expect(BAR).toContain("<span style={styles.dividendHolder}>");
  });

  it("splits the market move so its prices land in the figures column", () => {
    /* THE LINE THE REPORT OPENS WITH. As one span its figures began wherever the words "Market move:" ended,
       so the only line on the panel that shares its grammar with the rows was the one whose numbers did not
       share their column. */
    expect(BAR).toContain("<span style={styles.dividendMoveLabel}>Market move</span>");
    expect(STYLES).toContain("dividendMoveLabel: {");
    expect(BAR).not.toContain("Market move: <ZonedPrice");
  });
});
