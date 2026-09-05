/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1175 (harness): A COMMENT THE APP READ ALOUD
// ==================================================================
//
// REPORTED: "I clicked Run Routes and a large line of text suddenly appeared over my Dividends Action Bar
// reading: '$920->$950/* ... DESIGN NOTE 1154: THE WHOLE LINE OPENS THE CHART ...'. This also seems to have
// eaten the Withhold table."
//
// A BARE `/* ... */` IN JSX CHILDREN IS NOT A COMMENT. It is a text node. JSX only treats a block comment as
// a comment inside an expression container -- `{/* ... */}` -- and #1154's note was typed without the braces
// three lines below three others that had them. Nothing objected: it is valid JSX, valid TypeScript, and
// renders exactly what it says.
//
// WHY IT LIVED SO LONG. That branch draws only during the Dividends sub-phase of an Operating Round, so it
// was invisible until somebody ran routes. And it did not merely look wrong -- the parent is the dividend
// column's grid (#1153), so a stray text node is a stray GRID ITEM and every cell after it shifted, which is
// the "eaten" Pay Out and Withhold tables.
//
// THIS FILE IS THE SWEEP, NOT THE FIX. One occurrence was a typo; a typo that no tool catches and that hides
// until a specific sub-phase renders is a class. The detector below was validated against the committed file
// that carried the bug -- it finds that one and nothing else in the tree.

export {};

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");

const SRC = path.join(__dirname, "..");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

/**
 * Block comments that open where JSX children are expected.
 *
 * THE TEST IS THE PRECEDING LINE, not the comment itself. A `/*` at the start of a line is ordinary
 * everywhere in this codebase -- design notes open that way by the hundred. What makes one a text node is
 * sitting directly after a line that ENDS a JSX tag or opens a fragment, because that is the point where the
 * parser is reading children rather than code.
 *
 * `=>` IS EXCLUDED because an arrow ends in `>` and a comment after one is a comment on the body. This is
 * the false positive the first draft produced, and the reason the detector is written down rather than run
 * once by hand.
 */
function bareJsxComments(source: string): number[] {
  const lines = source.split("\n");
  const found: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("/*")) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j -= 1;
    if (j < 0) continue;
    const prev = lines[j].trim();
    const opensChildren =
      prev.endsWith("<>") ||
      (prev.endsWith(">") && !prev.startsWith("//") && !prev.startsWith("*") && !prev.endsWith("=>"));
    if (opensChildren) found.push(i + 1);
  }
  return found;
}

describe("no design note is rendered to the player", () => {
  it("finds the reported fault in the version that shipped it", () => {
    /* THE DETECTOR IS TESTED BEFORE IT IS TRUSTED. A sweep that reports "0 problems" is worth nothing until
       it has been shown to report 1 on a known case -- `sourceScan` #886's rule about assertions with nothing
       under them, applied to a scanner instead of an expectation. The fixture is the exact shape of #1154:
       a fragment opened, then a block comment with no braces. */
    const shipped = [
      "  return (",
      "    <>",
      "  /* ==================================================================",
      "      DESIGN NOTE 1154: THE WHOLE LINE OPENS THE CHART",
      "     ================================================================== */",
      "      <span>Market move</span>",
      "    </>",
      "  );",
    ].join("\n");
    expect(bareJsxComments(shipped)).toEqual([3]);
  });

  it("does not flag a comment on an arrow body", () => {
    /* The false positive the first draft produced: `=>` ends in `>`. */
    const arrow = ["const f = () =>", "  /* a note about the body */", "  1;"].join("\n");
    expect(bareJsxComments(arrow)).toEqual([]);
  });

  it("does not flag the braced form the rest of the file uses", () => {
    const braced = ["    <>", "      {/* a proper JSX comment */}", "      <span />", "    </>"].join("\n");
    expect(bareJsxComments(braced)).toEqual([]);
  });

  it("leaves none anywhere in the tree", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      for (const line of bareJsxComments(fs.readFileSync(file, "utf8"))) {
        offenders.push(`${path.relative(SRC, file)}:${line}`);
      }
    }
    /* NAMED, NOT COUNTED. A failure here should say which file and which line, because the fix is one pair of
       braces and finding it by eye in a four-thousand-line panel is the expensive part. */
    expect(offenders).toEqual([]);
  });
});
