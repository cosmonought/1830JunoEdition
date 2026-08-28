/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 881 (harness): UNDO SITS IN THE SAME COLUMN IN BOTH ROUNDS
// ==================================================================
//
// REPORTED: "in the Stock Round the 'Undo Last Action' button is not flush right in the action bar like it
// is in the Operating Rounds, and I don't know why."
//
// BECAUSE THE TWO BRANCHES USED THEIR THIRD GRID COLUMN DIFFERENTLY. Both are `minmax(0, 1fr) auto
// minmax(0, 1fr)`; the OR branch has had Undo in its right rail since #451, and this branch had Undo as the
// last child of the CENTRED group with an empty, `aria-hidden` spacer in the rail.
//
// THE TRAP THIS FILE EXISTS FOR IS THE `aria-hidden`, NOT THE ALIGNMENT. Moving a real control into an
// element carrying `aria-hidden="true"` leaves it clickable with a mouse and invisible to assistive tech and
// keyboard focus -- present, working, unreachable, and undetectable by every screenshot.
//
// Source scan only, so this file takes the node environment per the project's testing rules.

/* #490a: the note quotes the markup it replaced, so code assertions read a comment-stripped copy. */

import { readSource, stripComments } from "../utils/sourceScan";

const BAR = stripComments(readSource("panels/ContextualActionBar.tsx"));
const STYLES = stripComments(readSource("styles/appStyles.ts"));

describe("the Stock Round bar puts Undo in the trailing rail", () => {
  it("renders the button inside the rail, not merely after it", () => {
    /* ==================================================================
        ORDER IS NOT CONTAINMENT, AND THE FIRST DRAFT ASSERTED ORDER
       ==================================================================
       THE NEGATIVE CONTROL FOUND THIS. The first version of this test read, on one line per #814:
       `expect(undoAt).toBeGreaterThan(centreEnd);` -- Undo's index after the rail's. Mutating the source to
       self-close the rail and put Undo in a BARE span beside it passed: the rail still appears first, so the
       ordering holds while the button sits in a fourth grid column that #654's `1fr auto 1fr` does not have.
       Rendered, that is the reported bug back again with the fix's markup still in place.
       CONTAINMENT IS PROVED BY THE ABSENCE OF A CLOSING TAG. If no `</span>` separates the rail's opening tag
       from the button's label, the rail has not closed and the button is inside it. That is the one textual
       fact that distinguishes the two shapes -- an index comparison cannot.
       ANCHORS PINNED FIRST: `indexOf` returning -1 is less than every real index, so an unpinned comparison
       would pass for a rail that does not exist at all. */
    const railOpen = BAR.indexOf("<span style={styles.actionBarRailTrail}>");
    const undoAt = BAR.indexOf("Undo Last Action");
    expect(railOpen).toBeGreaterThan(-1);
    expect(undoAt).toBeGreaterThan(railOpen);
    const inside = BAR.slice(railOpen, undoAt);
    expect(inside).not.toBe("");
    expect(inside).not.toContain("</span>");
    expect(inside).toContain("<button");
  });

  it("closes the centre group before the rail opens", () => {
    /* The check above would also pass for a rail nested INSIDE the centre group, which would render
       identically at wide widths and wrongly at narrow ones. The centre's closing tag has to come first. */
    const centreOpen = BAR.indexOf("styles.actionBarButtonsCentre");
    const railOpen = BAR.indexOf("styles.actionBarRailTrail");
    expect(centreOpen).toBeGreaterThan(-1);
    expect(railOpen).toBeGreaterThan(centreOpen);
    const between = BAR.slice(centreOpen, railOpen);
    expect(between).not.toBe("");
    expect(between).toContain("</span>");
  });

  it("does not hide the rail from assistive technology", () => {
    /* THE SHARP EDGE. `aria-hidden` on an ancestor hides the entire subtree, so this is not a nicety about
       one attribute -- it is whether the only Undo control in a Stock Round exists for a keyboard user.
       Asserted on the RAIL specifically rather than on the file, because `aria-hidden` is legitimate
       elsewhere in this component and a file-wide ban would be a rule nobody meant to make. */
    const railOpen = BAR.indexOf("styles.actionBarRailTrail");
    expect(railOpen).toBeGreaterThan(-1);
    const railTag = BAR.slice(railOpen, BAR.indexOf(">", railOpen));
    expect(railTag).not.toBe("");
    expect(railTag).not.toContain("aria-hidden");
  });

  it("leaves no divider stranded at the end of the centre group", () => {
    /* #540's rule -- "a divider needs something on both sides" -- reached this time by moving the neighbour
       rather than by the neighbour being absent. The surviving rule is the one BEFORE `contextualButtons`,
       which is gated on that group being non-empty; the one that used to sit before Undo is gone.
       BOUNDED SLICE, so this cannot accidentally read the Operating Round branch's dividers. */
    const centreOpen = BAR.indexOf("styles.actionBarButtonsCentre");
    const railOpen = BAR.indexOf("styles.actionBarRailTrail");
    expect(centreOpen).toBeGreaterThan(-1);
    expect(railOpen).toBeGreaterThan(centreOpen);
    const centre = BAR.slice(centreOpen, railOpen);
    /* ONE divider in this group, and it is the conditional one. A bare count would survive the conditional
       being swapped for the unconditional, so the gate is asserted by identity. */
    expect((centre.match(/styles\.actionBarDivider/g) ?? []).length).toBe(1);
    expect(centre).toContain("{contextualButtons.length > 0 && <span style={styles.actionBarDivider} />}");
  });
});

describe("the rail can hold a control", () => {
  it("lays its child out flush right", () => {
    const at = STYLES.indexOf("actionBarRailTrail: {");
    expect(at).toBeGreaterThan(-1);
    const decl = STYLES.slice(at, STYLES.indexOf("},", at));
    expect(decl).not.toBe("");
    /* `justifyContent`, NOT `justifySelf`. The element already spans its `1fr` track, so `justifySelf` moves
       the rail within a track it fills -- which is nothing at all, and would render as the unchanged bug
       while looking like a fix. This is the assertion that tells those two apart. */
    expect(decl).toContain('justifyContent: "flex-end"');
    expect(decl).toContain('display: "flex"');
  });

  it("keeps the shrink floor #654 put on it", () => {
    /* `minWidth: 0` was load-bearing while the rail was empty and is more so now: a `1fr` track has an
       `auto` minimum, so a rail holding a real button refuses to shrink and drags the centred group off
       true on a narrow bar. Dropping it is the regression this change makes possible. */
    const at = STYLES.indexOf("actionBarRailTrail: {");
    const decl = STYLES.slice(at, STYLES.indexOf("},", at));
    expect(decl).toContain("minWidth: 0");
  });
});
