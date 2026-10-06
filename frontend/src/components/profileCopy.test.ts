/** @jest-environment node */
//
// LIVE-2E: NO PLAYER READS "GUEST", "SEAT PIN", "CLAIM SEAT" OR "TRANSFER CODE". Profiles are mandatory -- there is
// no anonymous play to call anything a guest, seats are the server's (no PINs, no claiming), and a second device is
// LINKED to the profile rather than handed a seat's transfer code.
//
// PARSED, NOT GREPPED. Design notes quote the old words (#490a) and must keep doing so, so this reads each file with
// the TypeScript parser and looks only at what a player can end up reading: string literals, template text and JSX
// text. A comment -- a `//`, a block, or a JSX `{/* */}` -- is never a node of those kinds, whatever it says.

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

import { shellSourcePaths } from "../utils/sourceScan";

const SRC = path.join(__dirname, "..");

/** The production UI: every non-test source under these, plus the two roots. The shell is its whole source set
 *  (`App.tsx` plus every extracted `shell/**` module), so copy that moves out of the root is still scanned. */
const ROOTS = ["components", "panels", "context", "utils"];
const FILES = [...shellSourcePaths(), "index.tsx"];

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ["guest", /\bguests?\b/i],
  ["seat PIN", /\bseat[\s-]?pins?\b/i],
  ["claim seat", /\bclaim(?:ing|ed)?[\s-]+(?:a\s+|your\s+|this\s+|the\s+)?seats?\b/i],
  ["transfer code", /\btransfer[\s-]+codes?\b/i],
  ["NO_SEAT_IDENTITY", /NO_SEAT_IDENTITY/],
];

function sources(): string[] {
  const out: string[] = FILES.map((file) => path.join(SRC, file));
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("__")) walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== "sourceScan.ts") {
        out.push(full);
      }
    }
  };
  for (const root of ROOTS) walk(path.join(SRC, root));
  return out;
}

/** Every piece of text in `file` a player could read: string literals, template text and JSX text. */
function readableText(file: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      /* An import's module name is not text anybody reads. */
      if (!(ts.isStringLiteral(node) && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))) {
        found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("no player-visible guest or seat-PIN vocabulary (LIVE-2E)", () => {
  const files = sources();

  it("scans the whole production UI", () => {
    expect(files.length).toBeGreaterThan(150);
    for (const name of [...shellSourcePaths(), "index.tsx", "components/AccountDialog.tsx", "components/ProfileMenu.tsx", "components/SessionEndedNotice.tsx", "utils/roomProtocol.ts"]) {
      expect(files).toContain(path.join(SRC, name));
    }
  });

  it("has none of the retired words in any string or JSX text", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { line, text } of readableText(file)) {
        for (const [label, pattern] of FORBIDDEN) {
          if (pattern.test(text)) offenders.push(`${path.relative(SRC, file)}:${line} ${label}: ${JSON.stringify(text.trim().slice(0, 80))}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds the words when they are there (a negative control on the parser)", () => {
    const probe = path.join(require("os").tmpdir(), `profile-copy-probe-${process.pid}.tsx`);
    fs.writeFileSync(
      probe,
      [
        "// a guest in a comment is fine",
        "/* so is a seat PIN */",
        'const a = "Continue as a new guest";',
        "const b = <p>Enter your seat PIN {/* not this guest */}</p>;",
        ["const c = `claim seat $", "{a}`;"].join(""),
      ].join("\n"),
    );
    try {
      const texts = readableText(probe).map((found) => found.text);
      expect(texts.filter((text) => FORBIDDEN.some(([, pattern]) => pattern.test(text)))).toEqual([
        "Continue as a new guest",
        "Enter your seat PIN ",
        "claim seat ",
      ]);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  it("the profile screens name no id: no principal, profile, session or key selector, and no game id", () => {
    /* PHASE 3 FINAL: `RecoveryKeyReveal.tsx` is deleted (no recovery key); the account's new screens are scanned instead. */
    for (const name of ["components/AccountDialog.tsx", "components/ProfileMenu.tsx", "components/TableAccountNotice.tsx", "components/SessionEndedNotice.tsx", "components/TrustFacts.tsx", "components/ConfirmItsYou.tsx", "utils/authorizationWalletFlow.ts", "utils/profileAuthorizationV1.ts"]) {
      for (const { text } of readableText(path.join(SRC, name))) {
        expect([name, text, /\b(?:pr|pf|se|rk)_[0-9a-z]/i.test(text) || /\bg_[0-9a-z]{6,}/i.test(text)]).toEqual([name, text, false]);
      }
    }
  });

  it("the profile screens never read the cookie or keep a credential in storage or a URL", () => {
    for (const name of [
      "components/AccountDialog.tsx",
      "components/ConfirmItsYou.tsx",
      "components/TrustFacts.tsx",
      "utils/accountPrompt.ts",
      "utils/trustApi.ts",
      "components/ProfileMenu.tsx",
      /* PHASE 3 FINAL: the Authorization Wallet's screens and helpers, and the open table's account guard, in place of
         the deleted `RecoveryKeyReveal.tsx`. */
      "components/TableAccountNotice.tsx",
      "utils/authorizationWalletFlow.ts",
      "utils/profileAuthorizationV1.ts",
      "utils/tableAccountGuard.ts",
      "components/SessionEndedNotice.tsx",
      "utils/profileApi.ts",
      "utils/sessionBootstrap.ts",
      "utils/useSession.ts",
    ]) {
      const code = fs
        .readFileSync(path.join(SRC, name), "utf8")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const banned of ["document.cookie", "localStorage", "sessionStorage", "console.", "history.pushState", "history.replaceState", "location.hash", "location.search"]) {
        /* PHASE 3 FINAL: the ONE exception -- the open table's account guard keeps, per table in this tab's sessionStorage,
           a FINGERPRINT of the account it was opened as and the display name shown there (no username, no credential),
           so a reload still asks; pinned below. */
        if (name === "utils/tableAccountGuard.ts" && banned === "sessionStorage") continue;
        expect([name, banned, code.includes(banned)]).toEqual([name, banned, false]);
      }
      if (name === "utils/tableAccountGuard.ts") {
        expect(code).toContain("[gameId, { key: baseline.key, name: baseline.name }]");
        expect(code).toContain("{ key: tag, name, local: changes }");
        expect(code).toContain("const tag = key === null ? null : fingerprintOf(key);");
      }
    }
  });
});
