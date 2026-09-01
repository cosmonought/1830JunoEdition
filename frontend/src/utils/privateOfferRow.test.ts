/** @jest-environment node */

//
// The private company card: what it frames, what it costs, and where the face value lives.
//
// ==================================================================
//  DESIGN NOTE 840 (harness): A BORDER REACT COULD NOT PUT BACK
// ==================================================================
//
// REPORTED: "Once you've clicked on a Private Company and closed it, it retains a white outline around it
// that wasn't there before and doesn't go away on subsequent clicks. So a player who clicks three PCs has
// three outlined in white and two without outlines."
//
// NOT FOCUS, WHICH IS THE FIRST GUESS AND IS RULED OUT BY THE COUNT -- one element holds focus, and three
// cards were outlined at once. It is a style diff:
//
//   `rowGroup`       declared `border: "1px solid #3a4150"`   (a SHORTHAND)
//   `rowGroupOpen`   overrode  `borderColor`                  (a LONGHAND inside it)
//
// On the render where a card CLOSES, React finds `borderColor` absent from the new style object and writes
// `style.borderColor = ""`. The `border` shorthand's value did not change between the two renders, so React
// does not re-apply it -- there is nothing to diff. An empty `border-color` resolves to `currentColor`, and
// this panel's ink is `#e2e6ee`. One near-white frame per card that has been opened and closed, forever.
//
// THE RULE THAT PREVENTS IT: a property any sibling state overrides must be declared in the base as the
// LONGHAND it overrides, never as a shorthand containing it. `rowGroupBlocked` overrides `borderStyle`, so
// that one is covered by the same fix.
//
// AND THIS IS THE CLASS #732's SWEEP LEFT OPEN -- "~38 unverified `border`/`borderColor` shorthand pairs",
// noted and never checked. It has now produced a user-visible report, which is the argument for finishing it.

import { readSource, stripComments } from "./sourceScan";

import { PRIVATE_COMPANY_CATALOG, abilitySummary } from "./privateCatalog";
import { SANDBOX_PRIVATES } from "./sandboxState";

// #490a: the notes below quote the broken declaration while explaining it.

const PANEL_RAW = readSource("components/PrivateTradePanel.tsx");
const PANEL = stripComments(PANEL_RAW);
const RULES = stripComments(readSource("components/RulesReference.tsx"));

describe("no shorthand a sibling state overrides (design note #840)", () => {
  it("declares the row's border as longhands", () => {
    expect(PANEL).toContain('borderWidth: "1px"');
    expect(PANEL).toContain('borderStyle: "solid"');
    /* Design note #1092 retoned this to `#3a3a3a`. #840's rule is about the DECLARATION FORM -- three
       longhands, never a `border` shorthand a sibling state can half-override -- so the hue is incidental
       and the two assertions above it are the ones carrying the claim. */
    expect(PANEL).toContain('borderColor: "#3a3a3a"');
  });

  it("leaves no border shorthand on a key whose siblings override its parts", () => {
    /* SCOPED TO `rowGroup`, not to the file. `priceInput` and `primaryButton` also use `border:` shorthands
       and are correct: nothing overrides a PART of either, so React never has a longhand to clear. A
       file-wide ban would fail on code that has no bug, which is the proxy-assertion mistake #776's harness
       made -- an absence standing in for a local property. */
    const start = PANEL.indexOf("  rowGroup: {");
    expect(start).toBeGreaterThan(-1);
    const group = PANEL.slice(start, PANEL.indexOf("rowGroupBlocked", start));
    expect(group.length).toBeGreaterThan(0);
    expect(group).not.toContain("border: ");
  });

  it("keeps both overriding states, because neither was the bug", () => {
    // The blue "you are acting on this" frame and the dashed blocked frame both survive; only the base moved.
    expect(PANEL).toContain('rowGroupOpen: { borderColor: "#4d8ee0"');
    expect(PANEL).toContain('borderStyle: "dashed"');
  });
});

describe("the open card is reference, not resting height (design note #841)", () => {
  it("marks the card body", () => {
    /* REPORTED: "The Buy Private Companies action bar is not sticky (at least, not in the first OR it is
       available--perhaps a similar bug as with Buy Trains in OR 1.1?)". A good guess and a different half of
       the same rule: #837 cut the deadlock in the bar, and this panel was simply never marked -- so its
       273px counted in full against a 326px budget it shares with a 149px bar. Nothing to do with the first
       OR; it is whether any card happens to be open. */
    expect(PANEL).toContain("style={styles.cardBody} {...STICKY_OPTIONAL}");
  });

  it("marks the body and not the row", () => {
    /* THE ROW IS THE PANEL. Marking the whole list would make the resting height zero and the bar would
       claim it can pin at any size -- `canPinWithoutTrapping` reads a non-positive height as "unmeasurable,
       so stick", so the mistake would present as a fix. */
    expect(PANEL.match(/\{\.\.\.STICKY_OPTIONAL\}/g) ?? []).toHaveLength(1);
  });
});

describe("one row for the offer (design note #842)", () => {
  it("puts the band in the label and drops the face value", () => {
    /* REPORTED: "'face $20 $10-$40' isn't working for me. For one thing it's all in the same green font, so
       green font is being used here for revenue, face value, and offer range." Three figures in one channel,
       where #804 established that monospace-green means A FIGURE BEING COMPARED. */
    expect(PANEL).toContain("Offer price (");
    expect(PANEL).not.toContain("face $");
    expect(PANEL).not.toContain("priceBand");
  });

  it("puts the button in the row rather than under it", () => {
    /* ASKED: "Can we move the Propose Purchase button to the right of the Offer price?" */
    const start = PANEL.indexOf("<div style={styles.priceRow}>");
    expect(start).toBeGreaterThan(-1);
    const row = PANEL.slice(start, PANEL.indexOf("{priceProblem &&", start));
    expect(row.length).toBeGreaterThan(0);
    expect(row).toContain("Propose Purchase to");
  });

  it("does not nest the button inside the label", () => {
    /* A `<button>` inside a `<label>` makes the label's click target the button as well as the field, so
       pressing it would also focus the input -- the same invalid nesting #804 removed when it took the input
       out of a button. The label wraps the field only. */
    const start = PANEL.indexOf("<label style={styles.priceField}>");
    expect(start).toBeGreaterThan(-1);
    const label = PANEL.slice(start, PANEL.indexOf("</label>", start));
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toContain("<button");
  });

  it("keeps the price problem on its own line", () => {
    /* Prose of variable length that appears only when something is wrong. In the row it would change the
       row's height as a player types, moving the button they are reaching for. */
    expect(PANEL.indexOf("{priceProblem &&")).toBeGreaterThan(
      PANEL.indexOf("Propose Purchase to"),
    );
  });
});

describe("the face value's new home (design note #843)", () => {
  it("agrees with the setup list, company by company", () => {
    /* TWO TABLES OF THE SAME SIX NUMBERS is exactly the shape this codebase keeps finding wrong (#829's two
       acronym vocabularies, #815's three chip rows). They are not merged -- one is presentation data and one
       is the sandbox's setup -- so they are PINNED TOGETHER instead, and a divergence is a failing test
       rather than a table that quietly lies to a player. */
    SANDBOX_PRIVATES.forEach((setup) => {
      expect(PRIVATE_COMPANY_CATALOG[setup.id].faceValue).toBe(setup.cost);
      expect(PRIVATE_COMPANY_CATALOG[setup.id].revenue).toBe(setup.revenue);
    });
  });

  it("covers all six", () => {
    // A loop over a list proves nothing about entries the list omits.
    expect(Object.keys(PRIVATE_COMPANY_CATALOG)).toHaveLength(6);
    expect(SANDBOX_PRIVATES).toHaveLength(6);
  });

  it("carries the canonical 1830 face values", () => {
    /* THE ONE PLACE A LITERAL IS RIGHT. The two tables above could agree with each other and both be wrong;
       these are the printed values from the box. */
    expect(
      Object.values(PRIVATE_COMPANY_CATALOG).map((entry) => entry.faceValue).sort((a, b) => a - b),
    ).toEqual([20, 40, 70, 110, 160, 220]);
  });

  it("renders the table from the catalog rather than a second list", () => {
    expect(RULES).toContain("PRIVATE_COMPANY_CATALOG");
    expect(RULES).toContain("PRIVATE_CATALOG_ROWS.map");
    expect(RULES).toContain("<h3 style={styles.sectionTitle}>Private Companies</h3>");
  });

  it("describes the power with the same words the card uses", () => {
    // `abilitySummary` is #661's join of the bullets the private's own card renders.
    expect(RULES).toContain("abilitySummary(entry)");
    expect(abilitySummary(PRIVATE_COMPANY_CATALOG[1])).toContain("No special power");
  });
});
