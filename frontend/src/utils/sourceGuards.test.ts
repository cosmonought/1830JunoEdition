/** @jest-environment node */
//
// ==================================================================
//  APP-TEST-0A: THE META-GUARD -- NO RAW App.tsx READS, NO BARE indexOf ON SHELL TEXT
// ==================================================================
//
// `sourceScan.ts` gives every shell source-scan a reader that follows code out of `App.tsx` (`readShell`) and
// slicers that cannot return nothing. This suite keeps the old shapes from coming back, because the
// decomposition will be done one extraction at a time by people -- and models -- who will reach for the
// idiom already on the screen. It checks every test file in `src/` for five things:
//
//   G1  NO DIRECT READ OF `App.tsx`. The string "App.tsx" does not appear in test code at all (comments
//       aside), and `SHELL_ROOT_FILE` is never handed to a file reader. The shell is read through
//       `readShell()` / `readShellRaw()`; the composition root alone through `readAppRoot(why)`.
//
//   G2  NO BARE INDEX ARITHMETIC ON SHELL TEXT. On a name that holds shell text -- assigned from a shell
//       reader, or from `sliceBetween` / `sliceFrom` / `sliceBefore` / `requireMatch(...)[n]` of one --
//       `.indexOf` / `.lastIndexOf` / `.search` / `.slice` / `.substring` / `.substr` are refused. Every one of
//       them has a -1 or an empty string in its failure mode, and every one has a guarded helper. So is an
//       ordering written as `expect(anchorIndex(S, a)).toBeLessThan(anchorIndex(S, b))`: `expectOrder` is the
//       one that knows two anchors in different files have no order.
//
//   G3  NO EMPTY-STRING FALLBACK ON A SHELL REGION. `S.split(a)[1] ?? ""`, `S.match(re)?.[0] || ""` and
//       `(S.match(re) ?? [""])[0]` turn "the region is gone" into "the region is empty", which every absence
//       beside them then passes on. `sliceBetween` / `requireMatch` throw instead.
//
//   G5  NO INDENTATION-PINNED ABSENCE ON SHELL TEXT. `not.toContain("f(\n        x")` stops matching the moment
//       an extraction re-indents the code, and then passes whatever the code does. Use `not.toMatch(/f\(\s*x/)`.
//
//   G4  THE ESCAPE HATCH IS REGISTERED. `readAppRoot` / `readAppRootRaw` appear only in files listed in
//       `APP_ROOT_EXCEPTIONS` below, each with the reason its invariant belongs to the composition root rather
//       than to the shell -- and every listed file still uses it, so the list cannot rot.
//
// WHAT THIS DOES NOT POLICE: slicing or indexOf on text that is not the shell (a component, a stylesheet, the
// server). Those files are not being decomposed, the vacuity there is a separate job, and a guard that
// refused every `indexOf` in the test tree would block legitimate exact tests.
//
// ITS BLIND SPOTS, named so nobody mistakes a green run for more than it is (from APP-TEST-0A's independent
// review). Names are tracked by declaration and assignment, per FILE rather than per scope, and one level
// deep. It does not see: a function PARAMETER that receives shell text (a local `between(src, a, b)` helper
// doing raw index arithmetic -- the migration rewrote every such helper it found); an object member
// (`F.app.slice`); a destructured or indirect result (`const [body] = requireMatch(...)`,
// `const m = requireMatch(...); m[0].indexOf`); a path assembled at runtime (`"App" + ".tsx"`, a template).
// Per-file name tracking can also flag a name that holds shell text in one case and a panel in another --
// rename one. That is why the slicers and readers throw on their own: this guard keeps the idiom out of
// the tree, and the helpers make the idiom's failure loud wherever it slips past.

export {};

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const { stripComments, READ_APP_ROOT_MIN_REASON } = require("./sourceScan") as typeof import("./sourceScan");

/** The composition-root exceptions (G4). Each entry is a test file (relative to `src/`) that may call
 *  `readAppRoot` / `readAppRootRaw`, and WHY: what it pins is a fact about `App.tsx` itself -- the router, the
 *  provider tree, the modal-layer sibling -- that must NOT follow code into `shell/`. Adding an entry is a
 *  claim a reviewer should check. */
export const APP_ROOT_EXCEPTIONS: Readonly<Record<string, string>> = {
  "utils/activeGame.test.ts":
    "GameRouter holds the room pointer and seeds it from the session reader (#551); the router's room pointer is " +
    "the one piece of room state the decomposition keeps in App.tsx (audit §4.4, §12)",
  "utils/lobbyPublicRooms.test.ts":
    "GameRouter's handleEnterSandbox is the router's single door into a table (LIVE-2D); a fact about the " +
    "composition root. The same case's absences (no watch intent anywhere) stay shell-wide",
  "components/modalPortalBoundary.test.tsx":
    "design note 1648: GameRouter renders one <ModalLayerHost /> beside each screen root (Lobby and the table), " +
    "so the count of two is a fact about the router in App.tsx, which the decomposition keeps (audit §12); a " +
    "shell-wide count would stop meaning 'one per router branch' the moment a shell module rendered its own",
};

/** The harness's own suites, exempt from the sweep: they test the helpers and this guard, not the source
 *  tree, and the shapes the guard refuses are their FIXTURES. */
const HARNESS_EXEMPT: Readonly<Record<string, string>> = {
  "utils/sourceScan.test.ts":
    "the helpers' own tests: a synthetic App.tsx in a temporary directory, and the raw index arithmetic the helpers replace, shown failing",
  "utils/sourceGuards.test.ts": "this file: its fixtures are the raw shapes it refuses",
};

export interface GuardViolation {
  rule: "G1" | "G2" | "G3" | "G4" | "G5";
  line: number;
  text: string;
}

const SHELL_READER = "(?:readShell|readShellRaw|readAppRoot|readAppRootRaw)";
const REGION_SLICER = "(?:sliceBetween|sliceFrom|sliceBefore)";
const RAW_INDEXING = "(?:indexOf|lastIndexOf|search|slice|substring|substr)";
/** The rest of one statement, lazily: anything but `;`, except inside a string literal -- an anchor like
 *  `"const eraBefore = derivePhase(before)?.tier;"` must not end the statement early. */
const STATEMENT_BODY = `(?:[^;"'\`]|"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)*?`;

function lineOf(text: string, at: number): number {
  return text.slice(0, at).split("\n").length;
}

function escape(name: string): string {
  return name.replace(/[$]/g, "\\$");
}

/** The names in `code` that hold shell text: assigned from a shell reader (not through `.split` / `.match`,
 *  which make arrays), or a region slicer applied to such a name, to a fixpoint. */
export function shellTextNames(code: string): Set<string> {
  const names = new Set<string>();
  /* Declarations AND plain assignments (`let APP; beforeAll(() => { APP = readShell(); })`). `=(?![=>])`
     keeps out comparisons and arrows. */
  const decl = /(?:(?:const|let|var)\s+)?\b([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=(?![=>])\s*([^;]*)/g;
  const decls = Array.from(code.matchAll(decl)).map((m) => ({ name: m[1], rhs: m[2] }));
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, rhs } of decls) {
      if (names.has(name)) continue;
      // A function value is not text, whatever its body reads.
      if (/^\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/.test(rhs)) continue;
      const fromReader = new RegExp(`\\b${SHELL_READER}\\s*\\(`).test(rhs) && !/\.\s*(?:split|match|matchAll)\s*\(/.test(rhs);
      const known = Array.from(names).map(escape).join("|");
      const fromRegion =
        known !== "" &&
        (new RegExp(`\\b${REGION_SLICER}\\s*\\(\\s*(?:${known})\\b`).test(rhs) ||
          new RegExp(`\\brequireMatch\\s*\\(\\s*(?:${known})\\b[\\s\\S]*\\)\\s*\\[\\s*\\d+\\s*\\]`).test(rhs) ||
          new RegExp(`^\\s*(?:${known})\\s*$`).test(rhs));
      if (fromReader || fromRegion) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/** Every G1-G3 violation in one test file's text (G4 is checked across files). */
/** `stripComments`, except each comment leaves its newlines behind, so a violation's line number is the line
 *  in the file a person opens. Same pattern order as `stripComments` (#886). */
function stripKeepingLines(raw: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, "");
  return raw
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^\s*\/\/.*$/gm, blank);
}

export function lintSourceScanTest(raw: string): GuardViolation[] {
  const code = stripKeepingLines(raw);
  const out: GuardViolation[] = [];
  const add = (rule: GuardViolation["rule"], at: number, len: number) =>
    out.push({ rule, line: lineOf(code, at), text: code.slice(at, at + len).split("\n")[0].trim() });

  // Any path that ENDS in `/App.tsx` or is `App.tsx`: "src/App.tsx", "../../src/App.tsx", "./App.tsx".
  for (const m of Array.from(code.matchAll(/["'`](?:[^"'`\n]*\/)?App\.tsx["'`]/g))) add("G1", m.index as number, 40);
  for (const m of Array.from(code.matchAll(/\b(?:readStripped|readSource|readFileSync|join|resolve)\s*\([^)]*\bSHELL_ROOT_FILE\b/g))) {
    add("G1", m.index as number, 80);
  }

  const names = Array.from(shellTextNames(code)).map(escape);
  const receivers = [...names.map((n) => `\\b${n}`), `\\b${SHELL_READER}\\s*\\([^()]*\\)`];
  for (const recv of receivers) {
    for (const m of Array.from(code.matchAll(new RegExp(`${recv}\\s*\\.\\s*${RAW_INDEXING}\\s*\\(`, "g")))) {
      add("G2", m.index as number, 90);
    }
    const fallback = new RegExp(
      `${recv}\\s*\\.\\s*(?:split|match)\\s*\\([^;]*?\\)\\s*(?:\\?\\.)?\\s*\\[\\s*\\d+\\s*\\]\\s*(?:\\?\\?|\\|\\|)\\s*(?:""|''|\`\`)`,
      "g",
    );
    for (const m of Array.from(code.matchAll(fallback))) add("G3", m.index as number, 90);
    /* ORDERING BY COMPARING TWO anchorIndex CALLS is not vacuous today, but in a source set the two anchors can
       land in different files, and then the comparison is of concatenation order -- it passes or fails on
       which file sorts first. `expectOrder` refuses that; a hand comparison cannot know. */
    const handOrder = new RegExp(
      `expect\\(\\s*anchorIndex\\(\\s*${recv}${STATEMENT_BODY}\\.(?:not\\.)?toBe(?:Less|Greater)Than`,
      "g",
    );
    for (const m of Array.from(code.matchAll(handOrder))) add("G2", m.index as number, 90);
    /* G5: AN ABSENCE PINNED TO INDENTATION. `not.toContain("f(\n        x")` stops matching the moment an
       extraction moves the code one block shallower -- which is what every extraction does -- and then passes
       whether or not the call came back. The whitespace-insensitive form is `not.toMatch(/f\(\s*x/)`. */
    const indentedAbsence = new RegExp(
      `expect\\(\\s*${recv}\\s*\\)\\s*\\.not\\.toContain\\(\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\n])*)\\1`,
      "g",
    );
    for (const m of Array.from(code.matchAll(indentedAbsence))) {
      if (/\\n[ \t]{2,}/.test(m[2])) add("G5", m.index as number, 90);
    }
    /* G5 also covers the other two ways to write a literal absence: `not.toMatch("...")` and `expectAbsent`. */
    const indentedOther = new RegExp(
      `(?:expect\\(\\s*${recv}\\s*\\)\\s*\\.not\\.toMatch|expectAbsent)\\(\\s*(?:${recv}\\s*,\\s*)?(["'\`])((?:\\\\.|(?!\\1)[^\\n])*)\\1`,
      "g",
    );
    for (const m of Array.from(code.matchAll(indentedOther))) {
      if (/\\n[ \t]{2,}/.test(m[2])) add("G5", m.index as number, 90);
    }
    const arrayFallback = new RegExp(`${recv}\\s*\\.\\s*match\\s*\\([^;]*?\\)\\s*(?:\\?\\?|\\|\\|)\\s*\\[\\s*(?:""|'')\\s*\\]`, "g");
    for (const m of Array.from(code.matchAll(arrayFallback))) add("G3", m.index as number, 90);
  }

  /* G2, THROUGH A VARIABLE: `const a = anchorIndex(S, x); const b = anchorIndex(S, y); expect(a).toBeLessThan(b)`
     is the same concatenation-order comparison as the inline form. */
  const shellAlt = [...names, `${SHELL_READER}\\s*\\([^()]*\\)`].join("|");
  if (shellAlt !== "") {
    const indexNames = Array.from(
      code.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*anchorIndex\\(\\s*(?:${shellAlt})\\b`, "g")),
    ).map((m) => escape(m[1]));
    if (indexNames.length > 0) {
      const idx = indexNames.join("|");
      const byVariable = new RegExp(
        `expect\\(\\s*(?:${idx})\\s*\\)\\s*\\.(?:not\\.)?toBe(?:Less|Greater)Than(?:OrEqual)?\\(|` +
          `\\.toBe(?:Less|Greater)Than(?:OrEqual)?\\(\\s*(?:${idx})\\s*\\)`,
        "g",
      );
      for (const m of Array.from(code.matchAll(byVariable))) add("G2", m.index as number, 90);
    }
    /* G3, THROUGH A VARIABLE: `const m = S.match(re); const body = m ? m[0] : "";`. */
    const matchNames = Array.from(
      code.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${shellAlt})\\s*\\.\\s*match\\s*\\(`, "g")),
    ).map((m) => escape(m[1]));
    for (const mn of matchNames) {
      const ternary = new RegExp(
        `\\b${mn}\\s*\\?\\s*${mn}\\s*\\[\\s*\\d+\\s*\\]\\s*:\\s*(?:""|'')|\\b${mn}\\s*\\?\\.\\s*\\[\\s*\\d+\\s*\\]\\s*(?:\\?\\?|\\|\\|)\\s*(?:""|'')`,
        "g",
      );
      for (const m of Array.from(code.matchAll(ternary))) add("G3", m.index as number, 90);
    }
  }
  return out;
}

function testFiles(): string[] {
  const src = path.join(__dirname, "..");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(abs);
      } else if (/\.(test|spec)\.tsx?$/.test(e.name)) {
        found.push(path.relative(src, abs).split(path.sep).join("/"));
      }
    }
  };
  walk(src);
  return found.sort();
}

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

describe("the meta-guard's own rules (negative controls first)", () => {
  it("G1 flags every raw spelling of an App.tsx read", () => {
    const shapes = [
      'const APP = readFileSync("src/App.tsx", "utf8");',
      'const APP = readFileSync(join(ROOT, "../../src/App.tsx"), "utf8");',
      'const APP = readStripped("App.tsx");',
      'const APP = readSource("App.tsx");',
      'const APP = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");',
      "const APP = read('../App.tsx');",
      'const FILES = ["App.tsx", "index.tsx"];',
      "const APP = readStripped(SHELL_ROOT_FILE);",
      'const APP = fs.readFileSync(path.join(__dirname, "..", SHELL_ROOT_FILE), "utf8");',
    ];
    for (const shape of shapes) expect(lintSourceScanTest(shape).map((v) => v.rule)).toContain("G1");
  });

  it("G1 ignores App.tsx in a comment -- notes may name the file", () => {
    expect(lintSourceScanTest('// App.tsx wires this\n/* "App.tsx" */\nconst APP = readShell();')).toEqual([]);
  });

  it("G2 flags index arithmetic on shell text, directly and through a region", () => {
    const shapes = [
      'const APP = readShell();\nconst body = APP.slice(APP.indexOf("a"), APP.indexOf("b"));',
      'const APP = readShell();\nconst i = APP.indexOf("a");',
      'const APP = readShell();\nexpect(APP.indexOf("a")).toBeLessThan(APP.indexOf("b"));',
      'const APP = readShellRaw();\nconst at = APP.search(/x/);',
      'const APP = readShell();\nconst block = sliceBetween(APP, "a", "b");\nconst tail = block.slice(block.indexOf("c"));',
      'const APP = readAppRoot("the router is the root file\'s own job");\nconst w = APP.substring(0, 10);',
      'const head = readShell().slice(0, 100);',
      'const APP = readShell();\nexpect(anchorIndex(APP, "a")).toBeLessThan(anchorIndex(APP, "b"));',
      // An anchor with a `;` inside it must not end the statement early.
      'const APP = readShell();\nexpect(anchorIndex(APP, "const x = f(y);")).toBeGreaterThan(guard);',
      // Ordering through variables.
      'const APP = readShell();\nconst a = anchorIndex(APP, "x");\nconst b = anchorIndex(APP, "y");\nexpect(a).toBeLessThan(b);',
      'const APP = readShell();\nconst a = anchorIndex(APP, "x");\nexpect(other).toBeGreaterThan(a);',
      // A name assigned later, not declared with it.
      'let APP;\nbeforeAll(() => { APP = readShell(); });\nconst i = APP.indexOf("a");',
    ];
    for (const shape of shapes) expect(lintSourceScanTest(shape).map((v) => v.rule)).toContain("G2");
  });

  it("G3 flags an empty-string fallback on a shell region", () => {
    const shapes = [
      'const APP = readShell();\nconst part = APP.split("a")[1] ?? "";',
      'const APP = readShell();\nconst part = APP.match(/a[\\s\\S]*?b/)?.[0] || "";',
      'const APP = readShell();\nconst part = (APP.match(/a/) ?? [""])[0];',
      'const APP = readShell();\nconst m = APP.match(/a[\\s\\S]*?b/);\nconst part = m ? m[0] : "";',
      'const APP = readShell();\nconst m = APP.match(/a/);\nconst part = m?.[0] ?? "";',
    ];
    for (const shape of shapes) expect(lintSourceScanTest(shape).map((v) => v.rule)).toContain("G3");
  });

  it("G5 flags an absence pinned to indentation, and not the whitespace-insensitive form", () => {
    expect(lintSourceScanTest('const APP = readShell();\nexpect(APP).not.toContain("f(\\n        x");').map((v) => v.rule)).toEqual([
      "G5",
    ]);
    expect(lintSourceScanTest('const APP = readShell();\nexpect(APP).not.toMatch(/f\\(\\s*x/);')).toEqual([]);
    expect(lintSourceScanTest('const APP = readShell();\nexpect(APP).not.toMatch("f(\\n        x");').map((v) => v.rule)).toEqual([
      "G5",
    ]);
    expect(lintSourceScanTest('const APP = readShell();\nexpectAbsent(APP, "f(\\n        x");').map((v) => v.rule)).toEqual(["G5"]);
    // A positive assertion pinned to indentation fails loudly when code moves, so it is left alone.
    expect(lintSourceScanTest('const APP = readShell();\nexpect(APP).toContain("f(\\n        x");')).toEqual([]);
  });

  it("passes the guarded shapes, and index arithmetic on text that is not the shell", () => {
    const good = [
      'const APP = readShell();\nconst body = sliceBetween(APP, "a", "b");\nexpect(body).not.toContain("c");',
      'const APP = readShell();\nexpectOrder(APP, "a", "b");',
      'const APP = readShell();\nconst tail = sliceFrom(APP, "a", { length: 400 });',
      'const APP = readShell();\nconst m = requireMatch(APP, /a/)[0];\nexpect(APP.split("x").length - 1).toBe(1);',
      'const APP = readShell();\nconst lines = APP.split("\\n");\nconst first = lines.slice(0, 3);',
      'const PANEL = readStripped("panels/ContextualActionBar.tsx");\nconst at = PANEL.indexOf("a");',
      'const APP = readShell();\nexpect(() => anchorIndex(APP, "b", "b", { from: anchorIndex(APP, "a") })).not.toThrow();',
      'const APP = readShell();\nconst isShell = x === readShell;\nconst f = (y) => y.indexOf("a");',
      'const PANEL = readStripped("panels/Bar.tsx");\nconst a = anchorIndex(PANEL, "x");\nexpect(a).toBeLessThan(anchorIndex(PANEL, "y"));',
    ];
    for (const shape of good) expect(lintSourceScanTest(shape)).toEqual([]);
  });
});

describe("every test file in src/ (the sweep)", () => {
  const files = testFiles();

  it("finds the test tree, including this file", () => {
    /* A SWEEP OVER NOTHING PASSES. The count is a floor, not an exact figure, so adding suites never breaks it. */
    expect(files.length).toBeGreaterThan(400);
    expect(files).toContain("utils/sourceGuards.test.ts");
  });

  it("G1-G3, G5: no raw App.tsx read, no bare index arithmetic, empty fallback or indentation-pinned absence on shell text", () => {
    const violations: string[] = [];
    for (const rel of files) {
      if (rel in HARNESS_EXEMPT) continue;
      for (const v of lintSourceScanTest(read(rel))) {
        violations.push(`${rel}:${v.line} ${v.rule} ${v.text}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("G4: the composition-root escape hatch is used only where registered, and every registration is used", () => {
    const users = files.filter(
      (rel) => rel !== "utils/sourceGuards.test.ts" && rel !== "utils/sourceScan.test.ts" && /\breadAppRoot(?:Raw)?\s*\(/.test(stripComments(read(rel))),
    );
    expect(users.filter((rel) => !(rel in APP_ROOT_EXCEPTIONS))).toEqual([]);
    expect(Object.keys(APP_ROOT_EXCEPTIONS).filter((rel) => !users.includes(rel))).toEqual([]);
    for (const [rel, why] of Object.entries(APP_ROOT_EXCEPTIONS)) {
      expect([rel, why.trim().length >= READ_APP_ROOT_MIN_REASON]).toEqual([rel, true]);
    }
  });
});
