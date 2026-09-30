// frontend/src/utils/appNaming.test.ts
//
// ==================================================================
//  DESIGN NOTE 708 (harness): WHAT THE GAME CALLS ITSELF
// ==================================================================
//
// REQUESTED: remove "1830" from the text players read, and use "Project 18XX" instead.
//
// The rename itself is a find-and-replace; what is worth holding is that it STAYS done. "1830" appeared in
// twenty-one player-visible strings scattered across nine files -- rules sentences, modal copy, wallet
// signature prompts, a transaction memo and a placeholder -- and there was nothing anywhere saying they were
// one fact. The next feature that needs a sentence about the rules will reach for the name it has read a
// hundred times in the design notes.
//
// SO THIS SCANS THE SOURCE, which is a weak instrument used deliberately: the strings live inside JSX and
// template literals in components that need a DOM to render, so there is nothing to import and assert. The
// same instrument `privateOffer.test.ts` and `ownershipColumnFit.test.ts` use, and for the same reason.
//
// COMMENTS ARE EXEMPT, and that is the whole design of the scan. The design notes cite 1830's rulebook
// constantly and MUST keep doing so -- "1830: 'Shares in the bank pool pay dividends to the corporate
// treasury'" (#706) is a citation, and a rename that erased it would destroy the reason the code is the way it
// is. What is forbidden is 1830 in a STRING a player can read.
//
// THREE DELIBERATE EXCEPTIONS, listed rather than pattern-matched so that adding a fourth requires saying why:
// the three `localStorage` keys in `TutorialModal`. Renaming those would silently reset every existing
// player's tutorial preferences -- a stored key is not a label, it is an address.

import fs from "fs";
import path from "path";

import { APP_NAME } from "../config";
import { SHELL_ROOT_FILE, normalizeEol, readSource } from "./sourceScan";

const SRC = path.join(__dirname, "..");

/** Keys, not labels. Renaming these would reset saved preferences for anyone who has already played. */
/* ==================================================================
    THE EXCEPTION IS A NAMESPACE, NOT A LIST OF THREE KEYS
   ==================================================================
   IT WAS AN ENUMERATION of the three `TutorialModal` keys, and it rotted exactly the way an enumeration of
   allowed strings does: `fleetLossNotice`'s `1830juno.fleet_loss_silence.v1.` was added later, is the same
   KIND of thing for the same reason, and turned this case red without anybody having done anything wrong.
   `1830juno.` IS THE PROPERTY THAT MATTERS. A `localStorage` key is a persisted identifier -- renaming one
   silently discards every player's saved preference -- which is the whole reason these are exempt, and it is
   true of the namespace rather than of three particular members of it. A new key in it is exempt by
   construction; a "1830" anywhere else is still an offender. */
const STORAGE_KEY_NAMESPACE = "1830juno.";

/* ==================================================================
    R12-W1: THE SCAN READS THE LIVE SURFACE, NOT EVERY FILE UNDER src/
   ==================================================================
   THE INVARIANT IS "A PLAYER DOES NOT READ 1830", not "the byte sequence 1830 appears in no file". The scan used to
   walk every non-test `.ts(x)` under `src/`, which was the same set while every non-test file was app code. It is not
   any more: `src/` now also holds the ROUTE ORACLE's certification harness (`routeOracle/**`, which production never
   imports -- a source guard pins that) and the settlement certification's test support (`settlementV12Forks.ts`,
   "TEST SUPPORT ONLY"). Their fixture titles name the 1830+ map because that is what they certify. Deleting that
   evidence to satisfy a scan would be the #706 mistake again, in the other direction.

   SO THE SURFACE IS COMPUTED, not listed: the transitive import closure of the browser's entry (`index.tsx`) plus
   every frontend module the game server imports (the server sends engine strings -- refusal reasons -- to players).
   A module that neither the bundle nor the server can reach cannot put a sentence in front of anyone. A new file is
   in scope the moment anything live imports it, and nobody has to remember to add it.

   INSIDE THE LIVE SURFACE ONE REGION IS CLASSIFIED, one by one below, with the reason and a guard: the rules
   engine's developer changelog. Its notes are certification records for developers. They are exported and never
   rendered, and the guard fails the moment any live module other than the definition and its re-export names the
   changelog. */

const SERVER_SRC = path.join(SRC, "..", "..", "server", "src");

/** `src/`-relative with forward slashes, so a classification means the same file on Windows and POSIX. */
const relOf = (file: string): string => path.relative(SRC, file).split(path.sep).join("/");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const isTestFile = (file: string): boolean => /\.test\.tsx?$/.test(file);

/** The file with its COMMENTS REMOVED, line numbering preserved.
 *
 *  A character scanner rather than a line test, and the first draft's failure is why. Testing whether a line
 *  "starts with `//` or `*`" misses three shapes this codebase is full of: indented prose continuing a `/* *\/`
 *  block, a trailing `//` after real code, and JSX `{/* *\/}`. It reported eleven design notes as offenders.
 *
 *  What survives the scan is CODE, STRING LITERALS AND JSX TEXT -- which is exactly the set a player can end
 *  up reading, and exactly the set the comments are not in.
 *
 *  R12-W1: line endings are normalised first (`sourceScan.normalizeEol`), so a CRLF checkout scans the same lines. */
function withoutComments(file: string): string[] {
  return withoutCommentsOf(normalizeEol(fs.readFileSync(file, "utf8")));
}

function withoutCommentsOf(source: string): string[] {
  const out: string[] = [""];
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let at = 0; at < source.length; at += 1) {
    const ch = source[at];
    const next = source[at + 1];
    if (ch === "\n") {
      if (state === "line") state = "code";
      out.push("");
      continue;
    }
    if (state === "line") continue;
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        at += 1;
      }
      continue;
    }
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        at += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        at += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") state = ch;
      out[out.length - 1] += ch;
      continue;
    }
    // Inside a string: an escape consumes the next character, whatever it is.
    if (ch === "\\") {
      out[out.length - 1] += ch + (next ?? "");
      at += 1;
      continue;
    }
    if (ch === state) state = "code";
    out[out.length - 1] += ch;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  The live surface: the import closure of what actually runs          */
/* ------------------------------------------------------------------ */

/** Relative module specifiers only: every import of this project's own code is relative (no `baseUrl`), and a bare
 *  specifier is a package. Read off the comment-stripped text, so a design note quoting an import is not one. A
 *  `import type` is followed too -- it bundles nothing, and following it only widens the scan, which is the safe
 *  direction. */
const IMPORT_SPECIFIERS: readonly RegExp[] = [
  /\b(?:import|export)\s[^;]*?\bfrom\s*["'](\.[^"']*)["']/g,
  /\bimport\s*["'](\.[^"']*)["']/g,
  /\b(?:require|import)\(\s*["'](\.[^"']*)["']\s*\)/g,
];

function importsOf(file: string): string[] {
  const code = withoutComments(file).join("\n");
  const out: string[] = [];
  for (const pattern of IMPORT_SPECIFIERS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (let hit = re.exec(code); hit !== null; hit = re.exec(code)) {
      const resolved = resolveModule(file, hit[1]);
      if (resolved !== null) out.push(resolved);
    }
  }
  return out;
}

/** A `.ts`/`.tsx` module, or `null` for anything else (a stylesheet, a JSON table, an asset). */
function resolveModule(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (/\.tsx?$/.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const insideFrontendSrc = (file: string): boolean => !path.relative(SRC, file).startsWith("..");

/** Every frontend module the browser bundle or the game server can reach. Tests are never live. */
function liveSurface(): string[] {
  const roots = [path.join(SRC, "index.tsx")];
  for (const file of sourceFiles(SERVER_SRC)) {
    if (isTestFile(file)) continue;
    for (const target of importsOf(file)) if (insideFrontendSrc(target)) roots.push(target);
  }
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || isTestFile(file) || !insideFrontendSrc(file)) continue;
    seen.add(file);
    queue.push(...importsOf(file));
  }
  return Array.from(seen).sort();
}

/* ------------------------------------------------------------------ */
/*  Developer metadata inside the live surface, classified one by one  */
/* ------------------------------------------------------------------ */

interface MetadataRegion {
  file: string;
  start: string;
  end: string;
  why: string;
}

const DEVELOPER_METADATA: readonly MetadataRegion[] = [
  {
    file: "gameEngine/rulesVersion.ts",
    start: "export const RULES_ENGINE_CHANGELOG",
    end: "\n];\n",
    why:
      "the rules engine's version changelog: certification records for developers (R12-2/R12-4 cite the 1830+ board " +
      "data they certify), exported and never rendered -- pinned by the guard below",
  },
];

/** The 1-based line numbers a classified region covers in `lines`. THROWS when either anchor is missing, so an
 *  exemption cannot outlive the region it was written for and silently exempt nothing (or everything). */
function metadataLines(lines: readonly string[], region: MetadataRegion): Set<number> {
  const code = lines.join("\n");
  const from = code.indexOf(region.start);
  if (from === -1) throw new Error(`appNaming: metadata region start not found in ${region.file}: ${region.start}`);
  const to = code.indexOf(region.end, from + region.start.length);
  if (to === -1) throw new Error(`appNaming: metadata region end not found in ${region.file}: ${JSON.stringify(region.end)}`);
  const lineOf = (at: number) => code.slice(0, at).split("\n").length;
  const out = new Set<number>();
  for (let line = lineOf(from); line <= lineOf(to + 1); line += 1) out.add(line);
  return out;
}

/** Every live line that says 1830, outside the storage namespace and the classified developer metadata. */
function offendersIn(files: readonly string[], read: (file: string) => string[] = withoutComments): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relOf(file);
    const lines = read(file);
    const exempt = new Set<number>();
    for (const region of DEVELOPER_METADATA) {
      if (region.file === rel) metadataLines(lines, region).forEach((line) => exempt.add(line));
    }
    lines.forEach((text, index) => {
      if (!text.includes("1830")) return;
      if (text.includes(STORAGE_KEY_NAMESPACE)) return;
      if (exempt.has(index + 1)) return;
      offenders.push(`${rel}:${index + 1}  ${text.trim().slice(0, 110)}`);
    });
  }
  return offenders;
}

const LIVE = liveSurface();
const LIVE_REL = LIVE.map(relOf);
const abs = (rel: string) => path.join(SRC, ...rel.split("/"));

describe("no player reads the number 1830", () => {
  it("has it in no live string outside the storage keys", () => {
    expect(offendersIn(LIVE)).toEqual([]);
  });

  it("scans a live surface that is really the app (the scope cannot pass on a small or wrong set)", () => {
    /* THE SCOPE'S OWN NEGATIVE CONTROL. A resolver that stopped following imports would leave `index.tsx` alone in
       the set and the scan above green over nothing. The app's own surfaces must be in it; the certification
       harness and the test support must not. */
    expect(LIVE.length).toBeGreaterThan(150);
    for (const rel of [
      "index.tsx",
      SHELL_ROOT_FILE,
      "components/Lobby.tsx",
      "panels/ContextualActionBar.tsx",
      "gameEngine/sandboxSession.ts",
      "gameEngine/rulesVersion.ts",
      "context/WalletContext.tsx",
    ]) {
      expect([rel, LIVE_REL.includes(rel)]).toEqual([rel, true]);
    }
    for (const rel of ["utils/sourceScan.ts", "routeOracle/harness/knownDefects.ts", "utils/settlementV12Forks.ts"]) {
      expect([rel, LIVE_REL.includes(rel)]).toEqual([rel, false]);
    }
    expect(LIVE_REL.some((rel) => rel.startsWith("routeOracle/"))).toBe(false);
  });

  it("catches a 1830 injected into a real player-facing sentence", () => {
    /* THE SCAN'S NEGATIVE CONTROL, on a real live file and a real sentence a player reads at the Dividends step. */
    const bar = abs("panels/ContextualActionBar.tsx");
    const sentence = "Project 18XX has no $0 dividend";
    const lines = withoutComments(bar);
    expect(lines.some((line) => line.includes(sentence))).toBe(true);
    const injected = (file: string) =>
      withoutComments(file).map((line) => (file === bar ? line.split(sentence).join("1830 has no $0 dividend") : line));
    const found = offendersIn([bar], injected);
    expect(found).toHaveLength(lines.filter((line) => line.includes(sentence)).length);
    for (const entry of found) expect(entry.startsWith("panels/ContextualActionBar.tsx:")).toBe(true);
  });

  it("exempts the changelog region only -- a 1830 elsewhere in the same file is caught", () => {
    const rules = abs("gameEngine/rulesVersion.ts");
    const real = withoutComments(rules);
    /* The real changelog does name 1830 (R12-2's board data) -- the exemption is doing work, not decoration. */
    const region = metadataLines(real, DEVELOPER_METADATA[0]);
    expect(real.some((line, index) => line.includes("1830") && region.has(index + 1))).toBe(true);
    const appended = offendersIn([rules], () => [...real, 'export const LEAK = "the 1830 map";']);
    expect(appended).toEqual([`gameEngine/rulesVersion.ts:${real.length + 1}  export const LEAK = "the 1830 map";`]);
  });

  it("keeps the changelog a developer record: no live module renders it", () => {
    /* THE GUARD ON THE CLASSIFICATION. The exemption is sound only while the changelog is never shown. The
       definition and the engine index's re-export may name it; any other live module -- or any server module --
       that does is a new surface, and the exemption must be re-argued rather than inherited. */
    const readers = [...LIVE, ...sourceFiles(SERVER_SRC).filter((file) => !isTestFile(file))]
      .filter((file) => withoutComments(file).join("\n").includes("RULES_ENGINE_CHANGELOG"))
      .map((file) => path.relative(path.join(SRC, "..", ".."), file).split(path.sep).join("/"));
    expect(readers.sort()).toEqual(["frontend/src/gameEngine/index.ts", "frontend/src/gameEngine/rulesVersion.ts"]);
    /* And inside those two, only the definition and the re-export: a helper in `rulesVersion.ts` that hands the notes
       to a caller would be a reader the file-level check above cannot see. */
    const count = (rel: string) => withoutComments(abs(rel)).join("\n").split("RULES_ENGINE_CHANGELOG").length - 1;
    expect([count("gameEngine/rulesVersion.ts"), count("gameEngine/index.ts")]).toEqual([1, 1]);
  });

  it("classifies the certification modules as not live, and would catch them if they became live", () => {
    /* Excluded by REACH, not by blindness: the scanner does see 1830 in each, so an import of either from app code
       puts its strings in the scan above and turns it red. */
    for (const rel of ["routeOracle/harness/knownDefects.ts", "utils/settlementV12Forks.ts"]) {
      expect([rel, LIVE_REL.includes(rel)]).toEqual([rel, false]);
      expect([rel, offendersIn([abs(rel)]).length > 0]).toEqual([rel, true]);
    }
  });

  it("still lets the design notes cite the rulebook", () => {
    /* THE OTHER HALF, and the one a blunter rename would have broken. #706's whole argument rests on quoting
       1830 verbatim; a scan that forbade the string everywhere would have taken the citation with it. */
    const reducer = readSource("gameEngine/sandboxSession.ts");
    expect(reducer).toContain("Shares in the bank pool pay dividends to the corporate treasury");
    expect(reducer).toContain("1830");
  });
});

describe("the name is stated once", () => {
  it("is what the branding constant says", () => {
    expect(APP_NAME).toBe("Project 18XX");
  });

  it("is read from the constant everywhere the app names ITSELF", () => {
    /* The five prompts a wallet shows and a chain records. Written out five times before #708, so a rename
       meant finding every literal -- and a signature prompt that disagrees with the one before it is what a
       cautious user reads as a phishing attempt.
       The needles drop the leading `${`, which is not squeamishness: written in full they are literal
       `${...}` inside a plain string, and `no-template-curly-in-string` flags every one as a template the
       author forgot to write. The interpolation is the POINT here, so the rule is sidestepped rather than
       silenced -- `APP_NAME}` is just as unambiguous a match. */
    /* LIVE-2D (RUST-RETIRE-1 2B.3): the Lobby's two chain prompts -- "create room" and "join room" -- went with the
       on-chain staging lobby they signed for. The three that remain are still read from the constant, and the Lobby
       signs nothing: a table is a server `room-op`, not a transaction. */
    expect(readSource("components/Lobby.tsx")).not.toMatch(/: (create|join) room/);
    for (const [file, needle] of [
      ["context/WalletContext.tsx", "APP_NAME}: authorize session key"],
      ["context/WalletContext.tsx", "APP_NAME}: revoke session key"],
      ["utils/sessionKey.ts", "APP_NAME} move"],
    ] as const) {
      expect(readSource(file)).toContain(needle);
    }
  });

  it("does not template the rules sentences", () => {
    /* BRANDING ONLY. "Project 18XX has no $0 dividend" is a SENTENCE, and turning an ordinary sentence into a
       template buys nothing and costs its readability. The constant exists for the places the app introduces
       itself, not for every place it is mentioned. */
    const bar = readSource("panels/ContextualActionBar.tsx");
    expect(bar).toContain("Project 18XX has no $0 dividend");
  });
});
