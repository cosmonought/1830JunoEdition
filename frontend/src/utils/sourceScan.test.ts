/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 886 (harness): THE HARNESS'S OWN HARNESS
// ==================================================================
//
// `sourceScan.ts` is read by every source-scanning suite in this project, so a fault in it is a fault in all
// of them at once -- and a fault in a comment stripper is the quietest kind, because it makes tests PASS.
//
// THE TWO THINGS ASSERTED HERE ARE THE TWO THINGS THE TWELVE HAND-WRITTEN COPIES GOT WRONG: the order of the
// comment patterns, and what happens when an anchor is missing. Both are asserted on literal fixtures rather
// than on real project files, because a fixture can contain exactly the shape being tested and a real file
// can only be hoped to.

import { anchorIndex, sliceBetween, stripComments } from "./sourceScan";

describe("stripComments", () => {
  it("removes a JSX-child comment with its braces", () => {
    /* THE BUG IN ALL TWELVE COPIES. Running the block pattern first consumes the interior and leaves `{}` --
       165 of them across the two biggest files. Asserted as the ABSENCE of the braces specifically, because
       the note's TEXT came out either way and that is why nobody noticed for twelve copies. */
    const out = stripComments('<a x={1} />\n{/* a design note */}\n<b y={2} />');
    expect(out).not.toContain("design note");
    expect(out).not.toContain("{}");
    /* AND THE CODE EITHER SIDE SURVIVES. A stripper that removed the braces by removing everything would
       satisfy the two lines above; these are what tell the difference. */
    expect(out).toContain("<a x={1} />");
    expect(out).toContain("<b y={2} />");
  });

  it("removes block and line comments", () => {
    const out = stripComments("const a = 1; /* note */\n// note\nconst b = 2;");
    expect(out).not.toContain("note");
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
  });

  it("leaves an expression container that is not a comment alone", () => {
    /* THE CONTROL FOR THE FIRST PATTERN. `{/*` has to be matched as a unit -- a stripper keyed on `{` would
       eat every JSX expression in the file, and every `toContain` asserting on one would start failing in a
       way that reads as a real regression. */
    const out = stripComments("<a title={label} />");
    expect(out).toContain("{label}");
  });

  it("is what makes #490a work: a note quoting a string does not count as the string", () => {
    /* THE WHOLE POINT, stated as the scenario it exists for. Four of the twelve copies failed this, so an
       absence assertion in them could be defeated by the design note recording the deletion -- which is the
       one comment guaranteed to be sitting next to the code. */
    const source = '{/* the old line read `foo = 1;` */}\nconst bar = 2;';
    expect(stripComments(source)).not.toContain("foo = 1;");
  });
});

describe("anchorIndex", () => {
  it("returns the index when the anchor is there", () => {
    expect(anchorIndex("abcdef", "cd")).toBe(2);
  });

  it("throws instead of returning -1", () => {
    /* -1 IS THE VACUITY. It is less than every real index, so an ordering assertion built on it passes for
       an element that does not exist. Throwing is what makes `expect(a).toBeLessThan(b)` mean what it says.
       THE MESSAGE NAMES THE ANCHOR, because the failure a maintainer sees is usually a renamed identifier
       and the useful information is which one. */
    expect(() => anchorIndex("abcdef", "zz", "start anchor")).toThrow(/start anchor not found/);
    expect(() => anchorIndex("abcdef", "zz")).toThrow(/"zz"/);
  });
});

describe("sliceBetween", () => {
  it("returns the text from the start anchor up to the end anchor", () => {
    expect(sliceBetween("aa START mid END zz", "START", "END")).toBe("START mid ");
  });

  it("searches for the end anchor AFTER the start, not from the beginning", () => {
    /* AN END ANCHOR THAT ALSO APPEARS EARLIER would otherwise resolve to the earlier one and produce a
       backwards slice -- the same empty string as a missing anchor, by a route that looks correct. */
    expect(sliceBetween("END aa START mid END zz", "START", "END")).toBe("START mid ");
  });

  it("throws on a missing start anchor rather than slicing from -1", () => {
    expect(() => sliceBetween("aa mid END", "START", "END")).toThrow(/start anchor not found/);
  });

  it("throws on a missing end anchor rather than returning the empty string", () => {
    /* THE FAILURE THIS FILE EXISTS FOR. `stepJumpButton.test.ts` sliced to `<PrivatePowerPanel` for three
       notes after that element was deleted; the slice was `""` and its two `not.toContain` assertions passed
       on nothing. Under this helper that is a thrown error naming the anchor. */
    expect(() => sliceBetween("aa START mid zz", "START", "END")).toThrow(/end anchor not found/);
  });

  it("throws when the end anchor only appears before the start", () => {
    // The backwards-slice case, stated directly.
    expect(() => sliceBetween("END aa START mid", "START", "END")).toThrow(/end anchor not found/);
  });
});
