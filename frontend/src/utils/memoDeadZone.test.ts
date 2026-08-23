/** @jest-environment node */
//
// No `useMemo` may read a binding declared below it. Source-level; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 762 (harness): THE ONE TYPESCRIPT CANNOT SEE
// ==================================================================
//
// REPORTED: "ReferenceError: can't access lexical declaration 'tr' before initialization", crashing both
// clients to a white screen when a share was bought while a home station was still unplaced.
//
// A `useMemo` BODY RUNS DURING RENDER, at the line where the memo is created. A `useCallback` body does not --
// it runs later, when everything has been declared. So the same reference is safe in one and fatal in the
// other, and #730 moved a ref below a memo on the strength of the callback case: "three of the four places
// that need it are callbacks defined ABOVE it". The fourth place was a memo.
//
// TYPESCRIPT CANNOT CATCH THIS AND NEITHER CAN ESLINT'S DEFAULT RULES. `tsc` flags a direct
// use-before-declaration and says nothing about one inside a closure, because it has no way to know when the
// closure runs. `npm run verify` passed on the build that shipped this crash.
//
// SO THE CHECK HAS TO BE A TEST, and this is its third outing: the same class produced `onPrivateTileHex`,
// `privatePowerHexes` and `rivalPresence` earlier in this project, each found by a crash rather than by a
// tool. Three times is a pattern, and a pattern deserves an assertion.
//
// IT SCANS ONLY `useMemo`, deliberately. Extending it to `useCallback` would flag dozens of legitimate
// forward references -- App.tsx is six thousand lines and its callbacks refer forward constantly -- and a
// check that cries wolf gets switched off.

import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

interface Offence {
  file: string;
  memoLine: number;
  name: string;
  declLine: number;
}

/** Every `const`/`let` declared at component scope, by first declaration line. */
function componentBindings(lines: readonly string[]): Map<string, number> {
  const decl = new Map<string, number>();
  lines.forEach((line, index) => {
    const single = /^\s{2}(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=]/.exec(line);
    if (single && !decl.has(single[1])) decl.set(single[1], index + 1);
    const destructured = /^\s{2}(?:const|let)\s+\[([^\]]+)\]/.exec(line);
    if (destructured) {
      for (const raw of destructured[1].split(",")) {
        const name = raw.trim();
        if (name && !decl.has(name)) decl.set(name, index + 1);
      }
    }
  });
  return decl;
}

/** The memo's BODY, bounded by the next sibling declaration rather than by brace matching.
 *
 *  THE FIRST VERSION COUNTED PARENTHESES AND OVER-MATCHED BADLY, sweeping in the declarations that followed
 *  the memo and reporting fourteen false positives on the first run. Counting brackets through strings, JSX
 *  and nested calls is a small parser, and a small parser is exactly the thing to avoid writing inside a
 *  test. Bounding by the next component-scope declaration is crude and correct for this codebase's shape,
 *  and it fails SAFE: a memo whose body somehow ran past its neighbour would be under-scanned, never
 *  falsely accused. A check that cries wolf gets switched off, so that is the right direction to err. */
function memoBody(lines: readonly string[], start: number): string {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{2}(?:const|let|function|useEffect|return|\/\*|\/\/)/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const raw = lines.slice(start, end).join("\n");
  /* The dependency array is an ARGUMENT to `useMemo`, evaluated by the caller and not by the body, so a name
     appearing only there is not a dead-zone read. */
  return raw.replace(/,\s*\[[^\]]*\]\s*\)\s*;?\s*$/s, "");
}

/** Where each top-level function starts. A file holds several components, and a `const` two spaces in
 *  belongs to whichever one encloses it -- scanning the whole file as one scope reported `launching` from a
 *  row component as a dead-zone read by a memo in the list component above it. Scope is the fix, not a
 *  heuristic about distance. */
function topLevelBlocks(lines: readonly string[]): number[] {
  const starts: number[] = [0];
  lines.forEach((line, index) => {
    if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s/.test(line)) starts.push(index);
    else if (/^(?:export\s+)?(?:const|class)\s+[A-Za-z_$][\w$]*/.test(line)) starts.push(index);
  });
  return Array.from(new Set(starts)).sort((a, b) => a - b);
}

function scan(file: string): Offence[] {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const blocks = topLevelBlocks(lines);
  const offences: Offence[] = [];
  const seen = new Set<string>();

  blocks.forEach((start, blockIndex) => {
    const end = blocks[blockIndex + 1] ?? lines.length;
    const scopeLines = lines.slice(start, end);
    const decl = componentBindings(scopeLines);

    scopeLines.forEach((line, offset) => {
      if (!line.includes("useMemo(")) return;
      const body = memoBody(scopeLines, offset);
      /* Comments quote identifiers by name -- #762's own note names `blocksThroughCityRef` and
         `couldRunARouteIfItHadATrain` in the same breath. #490a, for the fourth time. */
      const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      /* `Array.from`, not `for...of` on the Map: the build targets es5, where iterating a Map needs
         `--downlevelIteration`. Caught by `npm run typecheck` -- which is the point of running it. */
      for (const [name, declOffset] of Array.from(decl.entries())) {
        if (declOffset <= offset + 1) continue;
        const used = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
        if (!used.test(code)) continue;
        const key = `${file}:${start + offset + 1}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        offences.push({
          file: path.relative(SRC, file),
          memoLine: start + offset + 1,
          name,
          declLine: start + declOffset,
        });
      }
    });
  });
  return offences;
}

describe("no useMemo reads a binding from its own temporal dead zone", () => {
  it("finds none anywhere in the app", () => {
    /* THE CRASH, AS A SWEEP. `blocksThroughCityRef` was declared 487 lines below the memo that read it, and
       the memo's early return kept it unreachable until a corporation had a station token on the board --
       which is why a whole session of playtesting found it and every tool did not. */
    const offences = sourceFiles(SRC).flatMap(scan);
    expect(
      offences.map((o) => `${o.file}:${o.memoLine} reads '${o.name}' declared at line ${o.declLine}`),
    ).toEqual([]);
  });

  it("actually inspects App.tsx, which is where this keeps happening", () => {
    /* A sweep that silently matched nothing would pass for ever. App is the file with six thousand lines and
       forty memos; if it is not being read, the check is decoration. */
    const app = fs.readFileSync(path.join(SRC, "App.tsx"), "utf8");
    expect((app.match(/useMemo\(/g) ?? []).length).toBeGreaterThan(20);
    expect(componentBindings(app.split("\n")).size).toBeGreaterThan(100);
  });

  it("would have caught the reported crash", () => {
    /* The scanner run against the arrangement that shipped, reconstructed inline. Without this the sweep
       above could be passing because it detects nothing at all. */
    const broken = [
      "function App() {",
      "  const thing = useMemo(() => {",
      "    return laterRef.current;",
      "  }, [dep]);",
      "  const laterRef = useRef(undefined);",
      "}",
    ];
    const decl = componentBindings(broken);
    expect(decl.get("laterRef")).toBe(5);
    expect(memoBody(broken, 1)).toContain("laterRef.current");
  });

  it("does not flag a name that appears only in the dependency array", () => {
    /* Deps are evaluated as an argument to `useMemo`, not by its body -- but a memo listing a later const in
       its deps would be a different bug, and one `tsc` DOES catch. Keeping it out of this scan is what stops
       the check crying wolf. */
    const fine = [
      "function App() {",
      "  const thing = useMemo(() => 1, [later]);",
      "  const later = 2;",
      "}",
    ];
    expect(memoBody(fine, 1)).not.toContain("later");
  });
});
