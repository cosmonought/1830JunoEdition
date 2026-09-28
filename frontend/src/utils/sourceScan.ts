// frontend/src/utils/sourceScan.ts
//
// ==================================================================
//  DESIGN NOTE 886: ONE READER, ONE STRIPPER, AND NO BACKWARDS SLICES
// ==================================================================
//
// ASKED, after a feedback turn ran long: "Has this codebase really become this complicated? This is way too
// slow to be iterating UI fixes."
//
// PART OF THE ANSWER IS HERE. 100 of this project's 188 suites read source off disk and assert on substrings.
// That style is what catches this codebase's signature bug -- a design note claiming something the code does
// not do -- and #490a is the rule that makes it work: "a source-scan test can't tell an implementation from a
// design note quoting it. Scan a comment-stripped copy for absences; assert the note separately against raw
// text." What it did not have was one implementation.
//
// SEVENTY-FOUR SUITES HAND-ROLL A COMMENT STRIPPER. Twelve name it `strip`; the rest inline the same regexes
// into a local `read`, which is why a first survey counted twelve. Eight of the twelve carry a `{/* ... */}`
// pattern for JSX comments and four do not, and the difference LOOKS like a correctness split.
//
// IT IS NOT, AND THE REASON IS WORTH WRITING DOWN, because the obvious reading is wrong in the reassuring
// direction. Every one of them runs the block-comment replace FIRST:
//
//     source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
//
// The first pattern already matches the `/* ... */` inside `{/* ... */}`, so the JSX pattern has nothing left
// to match by the time it runs. It is an unreachable arm (#788) that eight authors wrote believing it did
// something. The comment TEXT comes off either way -- so #490a has been holding, in all seventy-four -- and
// what every one of them actually leaves behind is `{}` where the note was: 165 of those across `App.tsx` and
// `ContextualActionBar.tsx` alone. Harmless to a `not.toContain`, noise inside a bounded slice, and a copy
// that does not say what its author thinks it says.
//
// SO THE ORDER IS THE FIX, not a fourth `replace`: JSX comments come off first, braces and all, then block
// comments, then line comments.
//
// MIGRATION IS DELIBERATELY PARTIAL. The twelve that named the helper are converted; the rest are not, and
// converting them by regex is the wrong tool -- the first attempt at exactly that silently replaced a
// read-AND-strip with a plain read in `privatePowerFlow.test.ts`, because that file's stripper lived inside
// its `read` and the survey had not seen it. One suite caught it. Sixty-two more edits of that shape is a
// bad trade against a saved import. New suites use this module; the others convert when they are next opened
// for a reason of their own, which costs nothing because the file is already in front of you.
//
// ------------------------------------------------------------------
//  WHY `sliceBetween` THROWS
// ------------------------------------------------------------------
//
// The recurring vacuity in these tests is not a wrong assertion, it is an assertion with nothing under it:
//
//     const body = CODE.slice(CODE.indexOf(start), CODE.indexOf(end));
//     expect(body).not.toContain("thing");           // passes -- `body` is ""
//
// `indexOf` returns -1 for a missing anchor, -1 is less than every real index, and a backwards slice is the
// empty string, which satisfies every `not.toContain` beside it. This session alone it appeared four times --
// twice in tests written this session, once in `stepJumpButton.test.ts` (whose end anchor was an element
// deleted three notes earlier), and once caught only by a negative control.
//
// THE HABIT THAT GUARDS IT is four lines of `expect(...).toBeGreaterThan(-1)` before every slice, remembered
// every time by every author. `sliceBetween` throws instead, naming the anchor it could not find. A rule the
// tool enforces costs nothing to remember, and a test that fails with "end anchor not found: ..." is telling
// the truth where a silent pass was not.
//
// ------------------------------------------------------------------
//
// TEST-ONLY, and it lives in `utils/` because that is where this project already keeps test-only helpers
// (`mockFixtures.ts`). `fs` is reached through `require` inside the functions rather than a top-level import,
// so nothing can pull a Node built-in into the browser bundle by importing this file from production code by
// mistake. The file is not named `*.test.ts`, so Jest does not collect it as a suite.
//
// ==================================================================
//  APP-TEST-0A: THE SHELL SOURCE SET, AND GUARDS THAT CANNOT PASS ON NOTHING
// ==================================================================
//
// THE DECOMPOSITION OF `App.tsx` (Project `APP_TSX_DECOMPOSITION_AUDIT_2026-09-28` §8 Pass 0.1) WILL MOVE CODE
// OUT OF THE FILE ~170 SUITES READ AS TEXT. An assertion written as "App.tsx does not contain X" keeps passing
// when the code that must not contain X moves to `shell/Foo.ts` -- it is then a statement about a file that no
// longer holds the code. So the reader follows the code instead of the filename:
//
//   `readShell()`       the composition root `App.tsx` PLUS every `src/shell/**/*.{ts,tsx}` (discovered, sorted,
//                       tests and fixtures excluded), comments stripped, line endings normalised, concatenated
//                       with a per-file marker. A missing `shell/` is fine; a missing or empty `App.tsx`, or one
//                       without its root witness, THROWS -- so an absence asserted on it has searched something.
//   `readShellRaw()`    the same, unstripped: for assertions ABOUT design notes (#490a's other half).
//   `readAppRoot(why)`  the ESCAPE HATCH: `App.tsx` alone, for invariants that belong to the composition root
//                       itself (provider order, the router, the `ModalLayerHost` sibling). The reason is a
//                       required argument, so every use says why it is not a shell-wide invariant.
//   `shellSourcePaths()` the same set as a list of paths, for suites that analyse each file on its own; it makes
//                       the same root checks as `readShell()` before it hands the list out (Integration Pass 2).
//
// THE MARKER IS WHAT KEEPS A CONCATENATION HONEST. `anchorIndex` refuses an anchor found in two files (which one
// did the test mean?), `sliceBetween`/`sliceFrom`/`sliceBefore` refuse a slice that crosses from one file into
// the next, `expectOrder` refuses to order anchors that live in different files (their order in the
// concatenation means nothing), and `requireMatch` refuses a match that spans a boundary. None of this can
// trigger today -- `App.tsx` is the only file in the set -- and all of it is what makes the set safe to grow.
//
// AND EVERY REGION IS NON-EMPTY BY CONSTRUCTION. A slice whose body (the text after its start anchor) is
// whitespace throws unless the caller passes `{ allowEmpty: true }`, so `expect(region).not.toContain(...)`
// after any of the slicers here has searched a region that exists and has something in it. `expectAbsent` is
// the same promise for an arbitrary string, with optional witnesses that prove it is the region meant.
//
// THE META-GUARD (`sourceGuards.test.ts`) keeps the raw shapes from coming back: no test reads `App.tsx` except
// through these readers, and no test slices shell text with a bare `indexOf`.

/** Read a source file, relative to `src/`. Line endings are normalised to `\n`, so an anchor written with
 *  `\n` means the same thing in a CRLF checkout as in an LF one. */
export function readSource(relativeToSrc: string): string {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  return normalizeEol(fs.readFileSync(path.join(__dirname, "..", relativeToSrc), "utf8"));
}

/** `\r\n` and lone `\r` to `\n`. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Every comment removed, so an absence assertion cannot be satisfied -- or defeated -- by a design note
 *  quoting the string it is about (#490a).
 *
 *  ORDER IS LOAD-BEARING: `{/* ... *\/}` first, because the block pattern below would otherwise consume its
 *  interior and leave the braces behind as `{}`. That was the bug in all twelve hand-written copies. */
export function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The common case: read a file and strip it, in one call. */
export function readStripped(relativeToSrc: string): string {
  return stripComments(readSource(relativeToSrc));
}

/* ==================================================================
    SOURCE SETS (APP-TEST-0A)
   ================================================================== */

/** The composition root. It stays in `App.tsx` for the whole decomposition (audit §12): providers, the
 *  router, the `ModalLayerHost` sibling. */
export const SHELL_ROOT_FILE = "App.tsx";

/** What must be in `App.tsx` for a shell read to count as a read of the shell at all. `App()` is the one
 *  declaration the decomposition plan keeps in the root file forever, so a stripped `App.tsx` without it is
 *  empty, truncated, or not the file this project calls its composition root -- and an absence asserted on
 *  it would be asserted on nothing. */
export const SHELL_ROOT_WITNESS = "export default function App(";

/** Where extracted shell modules go (audit §7). Discovered recursively, so an extraction never has to edit a
 *  list here -- and the directory not existing yet is the normal state before Pass A. */
export const SHELL_SOURCE_DIR = "shell";

/** The separator between files in a source set. `\u0000` cannot occur in a source file or in any needle a
 *  test writes, so a concatenation can never produce a match that straddles two files by accident, and the
 *  guards below can tell exactly where each file begins.
 *
 *  THE PATH INSIDE THE MARKER IS NOT TEXT A TEST CAN FIND. It is written in Private Use Area code points (one
 *  per character, `U+E000 + code`), so `toContain("useDrainEffect")` cannot be satisfied -- and
 *  `not.toContain("useDrainEffect")` cannot be defeated -- by a module merely being NAMED `useDrainEffect.ts`,
 *  `\w` does not match it, and an anchor cannot land inside it. (Found by APP-TEST-0A's independent review:
 *  the first draft wrote the path as plain text.) */
const FILE_MARK = "\u0000";
const PATH_BASE = 0xe000;
const MARKER_RE = /\u0000([\ue000-\uf8ff]*)\u0000\n/g;

function markerFor(rel: string): string {
  let encoded = "";
  for (let i = 0; i < rel.length; i++) {
    const code = rel.charCodeAt(i);
    if (code > 0xf8ff - PATH_BASE) throw new Error(`sourceScan: source-set path has an unsupported character: ${rel}`);
    encoded += String.fromCharCode(PATH_BASE + code);
  }
  return `${FILE_MARK}${encoded}${FILE_MARK}\n`;
}

function decodePath(encoded: string): string {
  let rel = "";
  for (let i = 0; i < encoded.length; i++) rel += String.fromCharCode(encoded.charCodeAt(i) - PATH_BASE);
  return rel;
}

function srcRoot(): string {
  const path = require("path") as typeof import("path");
  return path.join(__dirname, "..");
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** Is this a file a source set should carry? Source only: never a test (`.test` or `.spec`, both of which
 *  Create React App's Jest collects), a story, a declaration file, or anything under a `__fixtures__` /
 *  `__mocks__` / `__tests__` directory. */
function isSetSource(rel: string): boolean {
  return (
    /\.(ts|tsx)$/.test(rel) &&
    !/\.(test|spec)\.tsx?$/.test(rel) &&
    !/\.stories\.tsx?$/.test(rel) &&
    !/\.d\.ts$/.test(rel) &&
    !/(^|\/)__(fixtures|mocks|tests)__(\/|$)/.test(rel)
  );
}

/** Every source file under `dir` (relative to `root`), recursively, as sorted `/`-separated paths relative to
 *  `root`. A directory that does not exist yields nothing -- that is not an error. The sort is by UTF-16 code
 *  unit, which does not depend on the machine's locale, so two checkouts concatenate in the same order. */
export function discoverSources(dir: string, root: string = srcRoot()): string[] {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) return [];
  const found: string[] = [];
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const rel = toPosix(path.relative(root, child));
        if (isSetSource(rel)) found.push(rel);
      }
    }
  };
  walk(base);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The shell's files, in the order a shell read concatenates them: `App.tsx` first, then `shell/**` sorted.
 *
 *  THROWS EXACTLY AS `readShell` DOES -- it makes a shell read first, so the root must exist, have code and
 *  carry its witness, with the same messages (APP-TEST-0A Integration Pass 2). A per-file loop over this list
 *  reads each file itself, usually `readStripped(rel)`, and an emptied or truncated root would otherwise be
 *  iterated as `""`, so every absence in the loop would pass for it: the P0 probe found twelve such tests
 *  passing on an emptied `App.tsx`. The list is only handed out once the root is proved to be the root. */
export function shellSourcePaths(root: string = srcRoot()): string[] {
  readShell({ root });
  return listShellSourcePaths(root);
}

function listShellSourcePaths(root: string): string[] {
  return [SHELL_ROOT_FILE, ...discoverSources(SHELL_SOURCE_DIR, root)];
}

export interface SourceSetOptions {
  /** Keep comments (for assertions about design notes). Default: stripped. */
  raw?: boolean;
  /** The `src/` directory to read from. Only the harness's own tests pass this. */
  root?: string;
}

interface ReadSetOptions extends SourceSetOptions {
  /** Paths that may be empty after stripping (the shell's modules may be a placeholder with only a header
   *  note; its ROOT may not, and is checked by its witness instead). */
  mayBeEmpty?: (rel: string) => boolean;
}

/** Read `paths` (relative to `root`) as one source set. THROWS on an empty list, a missing file, or a file with
 *  no code in it after stripping -- each of those would let an absence pass on nothing. */
export function readSourceSet(paths: readonly string[], options: ReadSetOptions = {}): string {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const root = options.root ?? srcRoot();
  if (paths.length === 0) throw new Error("sourceScan: a source set needs at least one file");
  let out = "";
  for (const rel of paths) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) throw new Error(`sourceScan: source-set file not found: ${rel}`);
    const text = normalizeEol(fs.readFileSync(abs, "utf8"));
    const body = options.raw ? text : stripComments(text);
    if (body.trim() === "" && !options.mayBeEmpty?.(rel)) throw new Error(`sourceScan: source-set file has no code: ${rel}`);
    if (body.includes(FILE_MARK)) throw new Error(`sourceScan: source-set file contains a NUL character: ${rel}`);
    out += markerFor(rel) + body + (body.endsWith("\n") ? "" : "\n");
  }
  return out;
}

function readShellSet(options: SourceSetOptions): string {
  const text = readSourceSet(listShellSourcePaths(options.root ?? srcRoot()), {
    ...options,
    mayBeEmpty: (rel) => rel !== SHELL_ROOT_FILE,
  });
  const root = sourceSetFiles(text).find((f) => f.path === SHELL_ROOT_FILE);
  if (!root || !root.text.includes(SHELL_ROOT_WITNESS)) {
    throw new Error(
      `sourceScan: ${SHELL_ROOT_FILE} does not contain its root witness ${JSON.stringify(SHELL_ROOT_WITNESS)}; ` +
        "a shell read without it would search a file that is not the composition root",
    );
  }
  return text;
}

/** THE DEFAULT READER FOR SHELL BEHAVIOUR: `App.tsx` plus `shell/**`, comments stripped. Use it for every
 *  invariant about what the shell does, wherever in the shell the code lives. */
export function readShell(options: Omit<SourceSetOptions, "raw"> = {}): string {
  return readShellSet({ ...options, raw: false });
}

/** `readShell()` with comments kept -- for assertions about design notes, never for absences of code. */
export function readShellRaw(options: Omit<SourceSetOptions, "raw"> = {}): string {
  return readShellSet({ ...options, raw: true });
}

/** THE ESCAPE HATCH: `App.tsx` alone, comments stripped. For invariants that belong to the composition root
 *  itself -- provider order, the router, the `ModalLayerHost` sibling, what the root file imports. `why` is
 *  required and must say why the assertion is about the root file rather than the shell; the meta-guard
 *  enforces that it is a real sentence. */
export function readAppRoot(why: string, options: Omit<SourceSetOptions, "raw"> = {}): string {
  return readRootFile(why, { ...options, raw: false });
}

/** `readAppRoot` with comments kept. */
export function readAppRootRaw(why: string, options: Omit<SourceSetOptions, "raw"> = {}): string {
  return readRootFile(why, { ...options, raw: true });
}

/** How long `readAppRoot`'s reason must be: a sentence, not a label. The meta-guard's registry holds its
 *  entries to the same floor. */
export const READ_APP_ROOT_MIN_REASON = 40;

function readRootFile(why: string, options: SourceSetOptions): string {
  if (typeof why !== "string" || why.trim().length < READ_APP_ROOT_MIN_REASON) {
    throw new Error("sourceScan: readAppRoot needs a reason: why is this invariant about App.tsx itself?");
  }
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const abs = path.join(options.root ?? srcRoot(), SHELL_ROOT_FILE);
  const text = normalizeEol(fs.readFileSync(abs, "utf8"));
  const body = options.raw ? text : stripComments(text);
  if (!body.includes(SHELL_ROOT_WITNESS)) {
    throw new Error(`sourceScan: ${SHELL_ROOT_FILE} does not contain its root witness ${JSON.stringify(SHELL_ROOT_WITNESS)}`);
  }
  return body;
}

export interface SourceSetFile {
  /** Path relative to `src/`, `/`-separated. */
  path: string;
  /** Offset of the file's first character in the set's text. */
  start: number;
  /** Offset one past its last character. */
  end: number;
  text: string;
}

/* One-entry cache: a suite asks about the same shell string hundreds of times. `===` is a VALUE comparison,
   so the cache cannot go stale, and on the same string object V8 answers it without reading the text. The
   segments are frozen because they are shared with every caller. */
let lastSegmented: string | null = null;
let lastSegments: readonly SourceSetFile[] = [];

/** The files inside a source-set string, in order. A plain (single-file) string is one anonymous file. */
export function sourceSetFiles(source: string): readonly SourceSetFile[] {
  if (source === lastSegmented) return lastSegments;
  const marks = Array.from(source.matchAll(MARKER_RE));
  const segments =
    marks.length === 0
      ? [{ path: "", start: 0, end: source.length, text: source }]
      : marks.map((m, i) => {
          const start = (m.index as number) + m[0].length;
          const end = i + 1 < marks.length ? (marks[i + 1].index as number) : source.length;
          return { path: decodePath(m[1]), start, end, text: source.slice(start, end) };
        });
  lastSegmented = source;
  lastSegments = Object.freeze(segments.map((segment) => Object.freeze(segment)));
  return lastSegments;
}

/** The file of a source set that contains offset `at`, or `null` for a plain string. A marker's own offsets
 *  belong to no file. */
export function fileAt(source: string, at: number): SourceSetFile | null {
  if (!isSourceSet(source)) return null;
  return sourceSetFiles(source).find((f) => at >= f.start && at < f.end) ?? null;
}

/** Was this string made by `readSourceSet` / `readShell` (as opposed to one plain file)? */
export function isSourceSet(source: string): boolean {
  return sourceSetFiles(source)[0].path !== "";
}

function where(source: string, at: number): string {
  const file = fileAt(source, at);
  const text = file ? file.text : source;
  const offset = file ? at - file.start : at;
  const line = text.slice(0, offset).split("\n").length;
  return file ? `${file.path}:${line}` : `line ${line}`;
}

/* ==================================================================
    ANCHORS AND REGIONS
   ================================================================== */

function allIndexes(source: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === "") return out;
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) out.push(at);
  return out;
}

export interface AnchorOptions {
  /** Search from this offset (like `indexOf(anchor, from)`); with `last`, search backwards from it. */
  from?: number;
  /** The LAST occurrence instead of the first (like `lastIndexOf`). */
  last?: boolean;
}

/** The index of `anchor`, or a thrown error naming it.
 *
 *  NEVER -1. That value is what makes an ordering assertion vacuous -- it is less than every real index, so
 *  `expect(a).toBeLessThan(b)` passes for an `a` that does not exist. Use this for both sides of an ordering
 *  check and the comparison means what it says.
 *
 *  IN A SOURCE SET, AN ANCHOR FOUND IN TWO FILES THROWS: the first one in concatenation order is not "the"
 *  anchor, it is whichever file sorts first. Within one file the first occurrence wins, as it always has.
 *  `options.from` / `options.last` are `indexOf(anchor, from)` / `lastIndexOf(anchor, from)` without the -1. */
export function anchorIndex(source: string, anchor: string, label = "anchor", options: AnchorOptions = {}): number {
  if (anchor === "") throw new Error(`sourceScan: ${label} is the empty string`);
  const at = options.last
    ? source.lastIndexOf(anchor, options.from ?? Infinity)
    : source.indexOf(anchor, options.from ?? 0);
  if (at === -1) {
    const scope = options.from === undefined ? "" : ` ${options.last ? "before" : "after"} offset ${options.from}`;
    throw new Error(`sourceScan: ${label} not found${scope}: ${JSON.stringify(anchor)}`);
  }
  if (isSourceSet(source)) {
    const files = new Set(allIndexes(source, anchor).map((i) => fileAt(source, i)?.path));
    if (files.size > 1) {
      throw new Error(
        `sourceScan: ${label} is ambiguous across files (${Array.from(files).join(", ")}): ${JSON.stringify(anchor)}`,
      );
    }
    /* `from` MEANS "IN THIS FILE, AFTER (OR BEFORE) HERE". An occurrence found by running on into the next file
       is not after the offset in any sense the test meant -- it is after it in the concatenation -- so it is
       refused, and "the receipt comes after the rebuild" cannot pass because the receipt moved to a module
       that sorts later. */
    if (options.from !== undefined) {
      const home = fileAt(source, Math.min(Math.max(options.from, 0), source.length - 1));
      const found = fileAt(source, at);
      if (home && found && home.path !== found.path) {
        throw new Error(
          `sourceScan: ${label} not found in ${home.path} ${options.last ? "before" : "after"} offset ${options.from} ` +
            `(the next occurrence is in ${found.path}): ${JSON.stringify(anchor)}`,
        );
      }
    }
  }
  return at;
}

/** Every index of `needle`, in order. THROWS when there are none unless `allowNone` -- a loop over the call
 *  sites of something that no longer exists would otherwise assert nothing, once per nothing. */
export function occurrences(source: string, needle: string, options: { allowNone?: boolean } = {}): number[] {
  if (needle === "") throw new Error("sourceScan: occurrences of the empty string");
  const all = allIndexes(source, needle);
  if (all.length === 0 && !options.allowNone) {
    throw new Error(`sourceScan: no occurrence of ${JSON.stringify(needle)}`);
  }
  return all;
}

/** `anchorIndex`, and THROWS unless the anchor occurs exactly once -- for regions whose meaning depends on
 *  there being one of them ("the" drain effect, "the" submit site). */
export function requireUniqueAnchor(source: string, anchor: string, label = "anchor"): number {
  const at = anchorIndex(source, anchor, label);
  const count = allIndexes(source, anchor).length;
  if (count !== 1) {
    throw new Error(`sourceScan: ${label} must occur exactly once, found ${count}: ${JSON.stringify(anchor)}`);
  }
  return at;
}

export interface RegionOptions {
  /** Permit a region whose body -- the text after its start anchor -- is only whitespace. */
  allowEmpty?: boolean;
}

function checkRegion(source: string, from: number, to: number, bodyFrom: number, what: string, opts: RegionOptions) {
  if (source.slice(from, to).includes(FILE_MARK)) {
    throw new Error(
      `sourceScan: ${what} crosses a file boundary (${where(source, from)} into ${fileAt(source, to)?.path ?? "?"})`,
    );
  }
  if (!opts.allowEmpty && source.slice(bodyFrom, to).trim() === "") {
    throw new Error(`sourceScan: ${what} is empty after its anchor (${where(source, from)})`);
  }
}

/** The text between two anchors, `start` inclusive.
 *
 *  `end` IS SEARCHED FROM `start`, not from the beginning of the file -- an end anchor that also appears
 *  earlier would otherwise produce a backwards slice, which is the same empty string by another route.
 *  THROWS rather than returning `""` when either anchor is missing or the order is wrong, so a slice that
 *  reaches a test is a slice with something in it -- and (APP-TEST-0A) when nothing but whitespace follows the
 *  start anchor, or when the slice would run from one file of a source set into the next. */
export function sliceBetween(source: string, start: string, end: string, options: RegionOptions = {}): string {
  const from = anchorIndex(source, start, "start anchor");
  const to = source.indexOf(end, from + start.length);
  if (to === -1) {
    throw new Error(
      `sourceScan: end anchor not found after start: ${JSON.stringify(end)} (start was ${JSON.stringify(start)})`,
    );
  }
  checkRegion(source, from, to, from + start.length, `slice ${JSON.stringify(start)}..${JSON.stringify(end)}`, options);
  return source.slice(from, to);
}

export interface SliceFromOptions extends RegionOptions {
  /** At most this many characters, counted from the start of the anchor. Default: to the end of the file. */
  length?: number;
}

/** From `start` (inclusive) to the end of ITS FILE, or `length` characters, whichever is first.
 *
 *  THE REPLACEMENT FOR `S.slice(S.indexOf(x))` AND `S.slice(i, i + N)`. The first becomes the file's last
 *  character when `x` is missing; the second becomes `""`. Both then satisfy every `not.toContain` beside
 *  them. This throws instead, and in a source set it stops at the file boundary rather than running on into
 *  whichever file sorts next. */
export function sliceFrom(source: string, start: string, options: SliceFromOptions = {}): string {
  const from = anchorIndex(source, start, "start anchor");
  const fileEnd = fileAt(source, from)?.end ?? source.length;
  const to = options.length === undefined ? fileEnd : Math.min(fileEnd, from + options.length);
  checkRegion(source, from, to, from + start.length, `slice from ${JSON.stringify(start)}`, options);
  return source.slice(from, to);
}

/** The `length` characters BEFORE `end` (exclusive), clipped to the start of `end`'s file. The replacement
 *  for `S.slice(Math.max(0, i - N), i)`. */
export function sliceBefore(source: string, end: string, length: number, options: RegionOptions = {}): string {
  const to = anchorIndex(source, end, "end anchor");
  const fileStart = fileAt(source, to)?.start ?? 0;
  const from = Math.max(fileStart, to - length);
  checkRegion(source, from, to, from, `slice before ${JSON.stringify(end)}`, options);
  return source.slice(from, to);
}

/** The first match of `pattern`, or a thrown error naming it. The replacement for
 *  `(S.match(re) ?? [""])[0]` and `S.match(re)?.[0] ?? ""`, which are the empty string when the pattern
 *  stops matching. A match that spans two files of a source set throws too. `g`/`y` flags are ignored. */
export function requireMatch(source: string, pattern: RegExp, label = "pattern"): RegExpExecArray {
  const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
  const m = re.exec(source);
  if (!m) throw new Error(`sourceScan: ${label} did not match: ${String(pattern)}`);
  /* An empty match is a region with nothing in it -- `/x*\/` "matches" every file. */
  if (m[0] === "") throw new Error(`sourceScan: ${label} matched the empty string: ${String(pattern)}`);
  if (m[0].includes(FILE_MARK)) {
    throw new Error(`sourceScan: ${label} matched across a file boundary at ${where(source, m.index)}: ${String(pattern)}`);
  }
  /* LIKE `anchorIndex`: a pattern that matches in two files of a set has no "first" match that means
     anything, so it is refused rather than resolved by sort order. */
  if (isSourceSet(source)) {
    const all = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "") + "g");
    const files = new Set<string | undefined>();
    for (let hit = all.exec(source); hit !== null; hit = all.exec(source)) {
      if (hit[0] === "") {
        all.lastIndex += 1;
        continue;
      }
      if (!hit[0].includes(FILE_MARK)) files.add(fileAt(source, hit.index)?.path);
    }
    if (files.size > 1) {
      throw new Error(`sourceScan: ${label} is ambiguous across files (${Array.from(files).join(", ")}): ${String(pattern)}`);
    }
  }
  return m;
}

/** THE ORDERING ASSERTION. Every anchor must exist (no -1), must not be ambiguous across files, must be in the
 *  SAME file as the others (order across files is concatenation order, which means nothing), and must come
 *  after the one before it. Throws naming the first pair that is out of order; returns the indices. */
export function expectOrder(source: string, ...anchors: string[]): number[] {
  if (anchors.length < 2) throw new Error("sourceScan: expectOrder needs at least two anchors");
  const at = anchors.map((a, i) => anchorIndex(source, a, `order anchor #${i + 1}`));
  const files = new Set(at.map((i) => fileAt(source, i)?.path));
  if (files.size > 1) {
    throw new Error(
      `sourceScan: ordered anchors live in different files (${Array.from(files).join(", ")}); ` +
        "their order in the concatenation means nothing -- assert each file's order separately",
    );
  }
  for (let i = 1; i < at.length; i++) {
    if (!(at[i - 1] < at[i])) {
      throw new Error(
        `sourceScan: expected ${JSON.stringify(anchors[i - 1])} (${where(source, at[i - 1])}) before ` +
          `${JSON.stringify(anchors[i])} (${where(source, at[i])})`,
      );
    }
  }
  return at;
}

export interface AbsentOptions {
  /** Text that MUST be present in `source`, proving it is the region the absence is about. */
  witness?: string | readonly string[];
  /** Names the region in failure messages. */
  label?: string;
}

/** THE ABSENCE ASSERTION THAT CANNOT PASS ON NOTHING. Throws when `source` is empty or whitespace, when any
 *  witness is missing, or when any needle is present -- naming where (file and line, in a source set). */
export function expectAbsent(
  source: string,
  needles: string | RegExp | ReadonlyArray<string | RegExp>,
  options: AbsentOptions = {},
): void {
  const label = options.label ?? "region";
  if (source.trim() === "") throw new Error(`sourceScan: ${label} is empty; an absence there proves nothing`);
  const witnesses = options.witness === undefined ? [] : typeof options.witness === "string" ? [options.witness] : options.witness;
  for (const w of witnesses) {
    if (!source.includes(w)) throw new Error(`sourceScan: ${label} witness not found: ${JSON.stringify(w)}`);
  }
  const list: ReadonlyArray<string | RegExp> = Array.isArray(needles) ? needles : [needles as string | RegExp];
  if (list.length === 0) throw new Error("sourceScan: expectAbsent needs at least one needle");
  for (const needle of list) {
    let at = -1;
    if (typeof needle === "string") at = source.indexOf(needle);
    else {
      const m = new RegExp(needle.source, needle.flags.replace(/[gy]/g, "")).exec(source);
      at = m ? m.index : -1;
    }
    if (at !== -1) {
      throw new Error(`sourceScan: ${label} must not contain ${String(typeof needle === "string" ? JSON.stringify(needle) : needle)}, found at ${where(source, at)}`);
    }
  }
}
