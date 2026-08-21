// frontend/src/components/playerCardAlignment.test.ts
//
// ==================================================================
//  DESIGN NOTE 658 (harness): THE TWO TABLES START ON ONE LINE
// ==================================================================
//
// REPORTED: "the two double-column tables 'start' at different heights ...
// P1's 'Corp' label sits in a row between 'Cash' and 'Net worth,' while PRR
// and C&O seem to be widely spaced apart to fill up the size of the table."
//
// Design note #611 already fixed this once, correctly, in the markup: the
// figures table has no `<thead>`, so `Cash` and `Corp.` genuinely are both
// row one. It stayed broken anyway, because the defect was never in which
// row things were in -- it was that `body` is a grid, grid items stretch,
// and a stretched HTML table distributes its surplus height across its own
// rows rather than sitting at the top of the space.
//
// So this file asserts the two properties that actually produce the reported
// layout, rather than the DOM order that was already right:
//
//   1. NOTHING STRETCHES. `alignItems: "start"` on the grid.
//   2. THE ROWS ARE THE SAME HEIGHT. Every cell in both tables carries the
//      same VERTICAL padding and vertical alignment.
//
// Neither is checkable by `tsc` or ESLint -- a missing `padding` key on one
// style object of six is precisely the silent no-op this codebase keeps
// rediscovering -- so it is checked here.
//
// Design note #680: THIS FILE USED TO COMPARE THE WHOLE `padding` STRING, and
// that was measuring more than #658 ever needed. Row height is a function of
// vertical padding alone; the horizontal half was identical only because the
// figures table happens not to need any. When the holdings table was asked for
// a column gap -- `Corp.` and `%` were reported as "too tight" -- the string
// comparison failed on a change that cannot affect a single row's height.
// So the assertion narrowed to what it was protecting. The horizontal rhythm
// is now asserted too, in its own block, because it is a real requirement of
// its own rather than a side effect of the vertical one.

import { styles, TABLE_ROW_CELL } from "./PlayerCards";

/** Every cell style in the two side-by-side tables. If a seventh is added,
 *  it belongs in this list; a cell that opts out of the shared metric is the
 *  bug, not an exception. */
const ROW_CELL_KEYS = [
  "figureKey",
  "figureValue",
  "holdingHead",
  "holdingHeadNum",
  "holdingName",
  "holdingNum",
] as const;

/** The top and bottom of a CSS `padding` shorthand, whatever arity it was
 *  written at. Design note #680: row height depends on these two and on
 *  nothing else, so this is the comparison the harness actually wants. */
function verticalPadding(padding: unknown): [string, string] {
  const parts = String(padding ?? "").trim().split(/\s+/);
  if (parts.length === 1) return [parts[0], parts[0]];
  if (parts.length === 2 || parts.length === 3) return [parts[0], parts[2] ?? parts[0]];
  return [parts[0], parts[2]];
}

/** The right and left of the same shorthand. NAMED rather than a tuple: CSS
 *  orders these clockwise from the top and the reader of an assertion should
 *  not have to remember that to know which edge is being checked. */
function horizontalPadding(padding: unknown): { right: string; left: string } {
  const parts = String(padding ?? "").trim().split(/\s+/);
  if (parts.length === 1) return { right: parts[0], left: parts[0] };
  if (parts.length === 2 || parts.length === 3) return { right: parts[1], left: parts[1] };
  return { right: parts[1], left: parts[3] };
}

describe("the card body does not stretch its tables", () => {
  it("aligns grid items to the start", () => {
    /* THE REPORTED BUG in one assertion. Without this, the holdings table is
       inflated to the height of the five-row figures table and spreads its
       header and rows across the surplus -- which is the "widely spaced
       apart to fill up the size of the table" in the report. */
    expect(styles.body.alignItems).toBe("start");
  });

  it("still lets the figures column take the remaining width", () => {
    /* Design note #609's fix, which this must not undo: the holdings column
       sizes to its content and hands the rest to the figures. `alignItems`
       is about the cross axis and cannot affect this -- asserted so that a
       future pass reaching for `place-items` finds out here. */
    expect(styles.body.gridTemplateColumns).toBe("minmax(0, 1fr) auto");
  });
});

describe("both tables share one row metric", () => {
  it("defines it once", () => {
    expect(TABLE_ROW_CELL.padding).toBe("1px 0");
    expect(TABLE_ROW_CELL.verticalAlign).toBe("top");
  });

  it.each(ROW_CELL_KEYS)("applies it to %s", (key) => {
    /* The failure this catches is the one that happened: `holdingHead` had no
       padding while `figureKey` had 2px, so the two columns began level and
       drifted a little further apart with every row -- small enough to read
       as sloppiness rather than as a bug.
       Design note #680: compared on the VERTICAL edges only. A cell may take
       horizontal padding for its own column's sake without moving any row. */
    expect(styles[key]).toBeDefined();
    expect(verticalPadding(styles[key].padding)).toEqual(
      verticalPadding(TABLE_ROW_CELL.padding),
    );
    expect(styles[key].verticalAlign).toBe(TABLE_ROW_CELL.verticalAlign);
  });

  it("gives the holdings columns the privates table's 20px gap", () => {
    /* Design note #680. `Corp.` and `%` inherited a metric built for the
       figures table, where the two columns are a caption and a right-aligned
       number and need no separation -- so they sat flush against each other.
       Ten off the right of one and ten off the left of the other reproduces
       the boundary `Value` and `Income` share below. */
    expect(styles.holdingHead.padding).toBe("1px 10px 1px 0");
    expect(styles.holdingName.padding).toBe("1px 10px 1px 0");
    expect(styles.holdingHeadNum.padding).toBe("1px 0 1px 10px");
    expect(styles.holdingNum.padding).toBe("1px 0 1px 10px");
  });

  it("leaves the % column flush right, where Income is", () => {
    /* THE ASYMMETRY IS THE POINT and would be undone by a well-meaning `1px
       10px`. `%` ends at the holdings table's right edge -- the card's, less
       the body's own 10px -- and `Income` ends ten inside a privates table
       that runs the full card width. They land on the same x. Padding `%` on
       both sides would move it ten left of the column it lines up with. */
    expect(horizontalPadding(styles.holdingNum.padding).right).toBe("0");
    expect(horizontalPadding(styles.holdingHeadNum.padding).right).toBe("0");
    // And the gap is on the inside edges, where it separates the two columns.
    expect(horizontalPadding(styles.holdingNum.padding).left).toBe("10px");
    expect(horizontalPadding(styles.holdingHead.padding).right).toBe("10px");
  });

  it("keeps the header cells the same size as the figure labels", () => {
    /* `Corp.` sits ON `Cash`, not merely beside it, which needs the two to
       be the same type. Both are `micro`/700 captions; the VALUE columns
       differ deliberately (`figureValue` is `small`, a figure rather than a
       caption) and that is not asserted. */
    expect(styles.holdingHead.fontSize).toBe(styles.figureKey.fontSize);
    expect(styles.holdingHead.fontWeight).toBe(styles.figureKey.fontWeight);
    expect(styles.holdingHeadNum.fontSize).toBe(styles.figureKey.fontSize);
    expect(styles.holdingHeadNum.fontWeight).toBe(styles.figureKey.fontWeight);
  });

  it("names no style key that does not exist", () => {
    /* The phantom-key check, run over this file's own list. A test that
       asserts against `styles.holdingHed` passes every `toBeDefined` it is
       given if the assertion is written the other way round -- so the list
       is checked against the object rather than trusted. */
    for (const key of ROW_CELL_KEYS) {
      expect(Object.keys(styles)).toContain(key);
    }
  });
});
