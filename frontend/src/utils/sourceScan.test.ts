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

import {
  SHELL_ROOT_WITNESS,
  anchorIndex,
  expectAbsent,
  expectOrder,
  fileAt,
  readAppRoot,
  readShell,
  readShellRaw,
  readSourceSet,
  requireMatch,
  requireUniqueAnchor,
  shellSourcePaths,
  sliceBefore,
  sliceBetween,
  sliceFrom,
  sourceSetFiles,
  stripComments,
} from "./sourceScan";

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

/* ==================================================================
    APP-TEST-0A: the shell source set and the non-vacuity guards
   ==================================================================
   EVERY CASE BELOW IS A NEGATIVE CONTROL FIRST. The helpers exist so that a region that is not there makes a
   test FAIL; each case therefore builds the missing / empty / straddling shape on purpose and proves the helper
   throws on it, beside the positive case that proves it still returns the right text when nothing is wrong. */

describe("sliceBetween refuses an empty body (APP-TEST-0A)", () => {
  it("throws when only whitespace follows the start anchor", () => {
    /* THE SLICE THAT CONTAINS NOTHING BUT ITS ANCHOR. `not.toContain` on it proves nothing about the region
       it names, so it is refused unless the caller says an empty region is the point. */
    expect(() => sliceBetween("aa START   \n END zz", "START", "END")).toThrow(/empty after its anchor/);
    expect(sliceBetween("aa START   \n END zz", "START", "END", { allowEmpty: true })).toBe("START   \n ");
  });

  it("a negative assertion cannot pass on a missing or empty region", () => {
    const source = "const a = 1;\nfunction f() {\n  doThing();\n}\n";
    // Present region: the absence is meaningful and holds.
    expect(sliceBetween(source, "function f() {", "\n}")).not.toContain("forbidden");
    // Missing start anchor: throws before the `not.toContain` can run.
    expect(() => expect(sliceBetween(source, "function g() {", "\n}")).not.toContain("forbidden")).toThrow(
      /start anchor not found/,
    );
    // Empty region: throws too.
    expect(() => sliceBetween("function f() {}\n", "function f() {", "}")).toThrow(/empty after its anchor/);
  });
});

describe("requireUniqueAnchor", () => {
  it("returns the index of an anchor that occurs once", () => {
    expect(requireUniqueAnchor("a b c", "b")).toBe(2);
  });
  it("throws on zero and on two occurrences -- a duplicate is not hidden behind the first", () => {
    expect(() => requireUniqueAnchor("a b c", "z")).toThrow(/not found/);
    expect(() => requireUniqueAnchor("a b b", "b")).toThrow(/exactly once, found 2/);
  });
});

describe("sliceFrom / sliceBefore (the replacements for indexOf windows)", () => {
  it("slices from the anchor, bounded by length", () => {
    expect(sliceFrom("xx ANCHOR body tail", "ANCHOR", { length: 11 })).toBe("ANCHOR body");
    expect(sliceFrom("xx ANCHOR body tail", "ANCHOR")).toBe("ANCHOR body tail");
  });
  it("throws where `S.slice(S.indexOf(x))` would have returned the last character", () => {
    /* `"abc".slice("abc".indexOf("z"))` is "c" -- a one-character region every absence passes on. */
    expect("abc".slice("abc".indexOf("z"))).toBe("c");
    expect(() => sliceFrom("abc", "z")).toThrow(/start anchor not found/);
  });
  it("throws where `S.slice(i, i + N)` would have returned the empty string", () => {
    /* In any file longer than the window, `slice(-1, N - 1)` starts past its end: the empty string. */
    const S = "x".repeat(500) + "abc";
    const i = S.indexOf("z");
    expect(S.slice(i, i + 100)).toBe("");
    expect(() => sliceFrom(S, "z", { length: 100 })).toThrow(/start anchor not found/);
  });
  it("sliceBefore takes the text before an anchor and refuses a missing one", () => {
    expect(sliceBefore("one two THREE", "THREE", 4)).toBe("two ");
    expect(sliceBefore("one two THREE", "THREE", 100)).toBe("one two ");
    expect(() => sliceBefore("one two", "THREE", 4)).toThrow(/end anchor not found/);
  });
});

describe("requireMatch", () => {
  it("returns the match and throws when the pattern stops matching", () => {
    expect(requireMatch("const x = useMemo(() => 1, [a]);", /useMemo\([\s\S]*?\]/)[0]).toBe("useMemo(() => 1, [a]");
    /* `(S.match(re) ?? [""])[0]` is the empty string here; this names the pattern instead. */
    expect(() => requireMatch("nothing here", /useMemo\(/, "memo")).toThrow(/memo did not match/);
  });
});

describe("expectOrder", () => {
  it("passes in order and returns the indices", () => {
    expect(expectOrder("a b c", "a", "b", "c")).toEqual([0, 2, 4]);
  });
  it("fails when either side is absent -- never compares against -1", () => {
    /* THE VACUOUS SHAPE: `-1 < 2` is true, so `expect(S.indexOf("z")).toBeLessThan(S.indexOf("b"))` passed. */
    expect("a b c".indexOf("z")).toBeLessThan("a b c".indexOf("b"));
    expect(() => expectOrder("a b c", "z", "b")).toThrow(/order anchor #1 not found/);
    expect(() => expectOrder("a b c", "a", "z")).toThrow(/order anchor #2 not found/);
  });
  it("fails when out of order, naming the pair", () => {
    expect(() => expectOrder("a b c", "c", "a")).toThrow(/expected "c" .* before "a"/);
  });
});

describe("expectAbsent", () => {
  it("passes when the needle is absent from a real region", () => {
    expect(() => expectAbsent("const a = 1;", "forbidden")).not.toThrow();
  });
  it("throws on an empty region, even though the needle is 'absent' from it", () => {
    expect(() => expectAbsent("", "forbidden")).toThrow(/empty; an absence there proves nothing/);
    expect(() => expectAbsent("  \n ", "forbidden")).toThrow(/empty/);
  });
  it("throws when a witness proving the region is missing", () => {
    expect(() => expectAbsent("const a = 1;", "forbidden", { witness: "function f(" })).toThrow(/witness not found/);
  });
  it("throws when a needle (string or pattern) is present, naming where", () => {
    expect(() => expectAbsent("a\nb\nforbidden\n", "forbidden")).toThrow(/found at line 3/);
    expect(() => expectAbsent("a\nforbidden()", [/nothing/, /forbidden\(/])).toThrow(/found at line 2/);
  });
});

describe("the shell source set (real tree)", () => {
  it("finds App.tsx today, first, and nothing that is not under shell/", () => {
    /* PROVES THE SET IS NOT EMPTY TODAY and that growing it is the only way it changes: every entry after
       the root is a discovered `shell/` module, and there may be none yet. */
    const paths = shellSourcePaths();
    expect(paths[0]).toBe("App.tsx");
    for (const p of paths.slice(1)) expect(p.startsWith("shell/")).toBe(true);
  });

  it("reads the composition root, stripped, with its witness", () => {
    const shell = readShell();
    const root = sourceSetFiles(shell).find((f) => f.path === "App.tsx");
    expect(root).toBeDefined();
    expect(root!.text).toContain(SHELL_ROOT_WITNESS);
    // Stripped: a design note in App.tsx is in the raw read and not in the stripped one.
    expect(readShellRaw()).toContain("DESIGN NOTE 1648");
    expect(shell).not.toContain("DESIGN NOTE 1648");
  });

  it("is a set, so a single-file anchor still resolves to App.tsx", () => {
    const shell = readShell();
    const at = anchorIndex(shell, SHELL_ROOT_WITNESS);
    expect(fileAt(shell, at)?.path).toBe("App.tsx");
    /* (Integration Pass 2: the "a marker's path is not an anchor" check that stood here -- `anchorIndex(shell,
       "set")` on the REAL tree -- moved to the synthetic fixture below. On the real tree it would throw
       "ambiguous" the day the first extracted module says "set" in code, which is the anchor being ambiguous,
       not the marker.) */
  });

  it("readAppRoot is the documented escape hatch and demands a reason", () => {
    expect(readAppRoot("provider order is the composition root's own job")).toContain(SHELL_ROOT_WITNESS);
    expect(() => readAppRoot("")).toThrow(/needs a reason/);
  });
});

describe("the shell source set (synthetic fixture)", () => {
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");
  let root = "";

  const write = (rel: string, text: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-source-set-"));
    write("App.tsx", "// root note: forbiddenInNote()\r\nfunction AppShell() {\r\n  rootOnly();\r\n}\r\nexport default function App() {\r\n  return null;\r\n}\r\n");
    write("shell/useRoutes.ts", "export function useRoutes() {\n  movedCall();\n  shared();\n}\n");
    write("shell/nested/Workspace.tsx", "export function Workspace() {\n  shared();\n  laterCall();\n}\n");
    // Never part of the set:
    write("shell/useRoutes.test.ts", "movedCall(); testOnly();\n");
    write("shell/useRoutes.spec.ts", "specOnly();\n");
    write("shell/Workspace.stories.tsx", "storyOnly();\n");
    // A module NAMED for something it does not contain, and a placeholder that is only a header note.
    write("shell/useDrainEffect.ts", "export const drain = () => laterOnly();\n");
    write("shell/placeholder.ts", "// M3 lands here in Pass C.\n");
    write("shell/types.d.ts", "declare const declOnly: number;\n");
    write("shell/__fixtures__/fixture.ts", "fixtureOnly();\n");
    write("shell/notes.md", "markdownOnly\n");
    write("components/Elsewhere.tsx", "elsewhereOnly();\n");
  });
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("discovers App.tsx and every shell module, sorted, and nothing else", () => {
    expect(shellSourcePaths(root)).toEqual([
      "App.tsx",
      "shell/nested/Workspace.tsx",
      "shell/placeholder.ts",
      "shell/useDrainEffect.ts",
      "shell/useRoutes.ts",
    ]);
  });

  it("an absence over the shell follows code that moved out of App.tsx", () => {
    /* THE VACUITY THIS PASS EXISTS FOR, reproduced: `movedCall()` is not in App.tsx, so an App-only absence
       passes, and the same absence over the shell fails because the code is in `shell/useRoutes.ts`. */
    const appOnly = readAppRoot("fixture: stands in for the old App-only reader, to show what it missed", { root });
    expect(appOnly).not.toContain("movedCall()");
    const shell = readShell({ root });
    expect(shell).toContain("movedCall()");
    expect(() => expectAbsent(shell, "movedCall()")).toThrow(/found at shell\/useRoutes\.ts:2/);
    // Excluded files never contribute.
    for (const excluded of ["testOnly", "specOnly", "storyOnly", "declOnly", "fixtureOnly", "markdownOnly", "elsewhereOnly"]) {
      expect(shell).not.toContain(excluded);
    }
  });

  it("strips comments and normalises CRLF, per file", () => {
    const shell = readShell({ root });
    expect(shell).not.toContain("\r");
    expect(shell).not.toContain("forbiddenInNote");
    expect(readShellRaw({ root })).toContain("forbiddenInNote");
  });

  it("never matches a file's NAME: the marker's path is not searchable text", () => {
    /* FOUND BY THE INDEPENDENT REVIEW. A plain-text marker made `toContain("useDrainEffect")` pass on the
       module's name alone and `not.toContain` fail on it -- in both directions an assertion about the marker
       rather than the code. */
    const shell = readShell({ root });
    expect(shell).not.toContain("useDrainEffect");
    expect(shell).not.toContain("placeholder");
    expect(() => anchorIndex(shell, "useDrainEffect")).toThrow(/not found/);
    expect(() => requireMatch(shell, /useDrain\w+/)).toThrow(/did not match/);
    // And the set still knows the name, for its own messages.
    expect(sourceSetFiles(shell).map((f) => f.path)).toContain("shell/useDrainEffect.ts");
  });

  it("allows a shell module that is only a header note, but never an empty root", () => {
    expect(sourceSetFiles(readShell({ root })).find((f) => f.path === "shell/placeholder.ts")?.text.trim()).toBe("");
  });

  it("a search FROM an offset stays in that offset's file", () => {
    /* "the receipt comes after the rebuild" must not pass because the receipt moved to a module that sorts
       later: after the offset in the concatenation is not after it in the code. */
    const shell = readShell({ root });
    const inRoot = anchorIndex(shell, "rootOnly();");
    expect(() => anchorIndex(shell, "movedCall();", "moved", { from: inRoot })).toThrow(/not found in App\.tsx after offset/);
    const inRoutes = anchorIndex(shell, "export function useRoutes() {");
    expect(anchorIndex(shell, "movedCall();", "moved", { from: inRoutes })).toBeGreaterThan(inRoutes);
  });

  it("refuses a pattern that matches in two files, and an empty match", () => {
    const shell = readShell({ root });
    expect(() => requireMatch(shell, /shared\(\);/)).toThrow(/ambiguous across files/);
    expect(() => requireMatch(shell, /z*/)).toThrow(/matched the empty string/);
    expect(requireMatch(shell, /movedCall\(\);/)[0]).toBe("movedCall();");
  });

  it("refuses an anchor that exists in two files", () => {
    expect(() => anchorIndex(readShell({ root }), "shared();")).toThrow(/ambiguous across files/);
  });

  it("refuses a slice that would run from one file into the next", () => {
    const shell = readShell({ root });
    expect(() => sliceBetween(shell, "rootOnly();", "laterCall();")).toThrow(/crosses a file boundary/);
    // Within one file it works, and sliceFrom stops at the file's end.
    expect(sliceBetween(shell, "function AppShell() {", "export default")).toContain("rootOnly();");
    const tail = sliceFrom(shell, "export function useRoutes() {");
    expect(tail).toContain("movedCall();");
    expect(tail).not.toContain("laterCall();");
  });

  it("refuses to order anchors that live in different files", () => {
    const shell = readShell({ root });
    expect(() => expectOrder(shell, "rootOnly();", "movedCall();")).toThrow(/different files/);
    expect(expectOrder(shell, "function AppShell() {", "export default function App(")).toHaveLength(2);
  });

  it("refuses a pattern match that spans a boundary", () => {
    const shell = readShell({ root });
    expect(() => requireMatch(shell, /rootOnly\(\);[\s\S]*?movedCall/)).toThrow(/across a file boundary/);
  });

  it("a short anchor is not ambiguous merely because another file's marker spells it", () => {
    /* The marker's path is not text: a module at `shell/rootOnly/probe.ts` spells "rootOnly" in its marker, and
       the anchor still resolves to the one file whose CODE says it. */
    write("shell/rootOnly/probe.ts", "export const probe = 1;\n");
    try {
      const shell = readShell({ root });
      expect(sourceSetFiles(shell).map((f) => f.path)).toContain("shell/rootOnly/probe.ts");
      expect(fileAt(shell, anchorIndex(shell, "rootOnly"))?.path).toBe("App.tsx");
    } finally {
      fs.rmSync(path.join(root, "shell/rootOnly"), { recursive: true, force: true });
    }
  });

  it("fails loudly when the root witness, the root file or its code is missing", () => {
    /* `shellSourcePaths` makes the same three checks (Integration Pass 2): a per-file loop reads each path
       itself, so a list handed out over an emptied root would iterate it as "" and pass every absence on it. */
    write("App.tsx", "function AppShell() {}\n");
    expect(() => readShell({ root })).toThrow(/root witness/);
    expect(() => shellSourcePaths(root)).toThrow(/root witness/);
    write("App.tsx", "// only a comment\n");
    expect(() => readShell({ root })).toThrow(/has no code/);
    expect(() => shellSourcePaths(root)).toThrow(/has no code/);
    write("App.tsx", "");
    expect(() => readShell({ root })).toThrow(/has no code/);
    expect(() => shellSourcePaths(root)).toThrow(/has no code/);
    fs.rmSync(path.join(root, "App.tsx"));
    expect(() => readShell({ root })).toThrow(/not found: App\.tsx/);
    expect(() => shellSourcePaths(root)).toThrow(/not found: App\.tsx/);
    expect(() => readSourceSet([], { root })).toThrow(/at least one file/);
  });

  it("a per-file loop over shellSourcePaths cannot iterate an emptied root (negative control)", () => {
    /* THE P0 SHAPE, reproduced: the old list gave `["App.tsx", ...]` for an empty root, `readStripped` read it as
       "", and the loop's absence passed on nothing. The list is refused instead. */
    write("App.tsx", "");
    const naive = ["App.tsx"].map((rel) => stripComments(fs.readFileSync(path.join(root, rel), "utf8")));
    expect(naive.every((code) => !code.includes("forbiddenCall("))).toBe(true); // the vacuous pass the guard prevents
    expect(() => shellSourcePaths(root).map((rel) => fs.readFileSync(path.join(root, rel), "utf8"))).toThrow(/has no code/);
  });
});
