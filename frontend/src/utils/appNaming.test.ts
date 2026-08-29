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

/** The file with its COMMENTS REMOVED, line numbering preserved.
 *
 *  A character scanner rather than a line test, and the first draft's failure is why. Testing whether a line
 *  "starts with `//` or `*`" misses three shapes this codebase is full of: indented prose continuing a `/* *\/`
 *  block, a trailing `//` after real code, and JSX `{/* *\/}`. It reported eleven design notes as offenders.
 *
 *  What survives the scan is CODE, STRING LITERALS AND JSX TEXT -- which is exactly the set a player can end
 *  up reading, and exactly the set the comments are not in. */
function withoutComments(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
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

describe("no player reads the number 1830", () => {
  it("has it in no live string outside the storage keys", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // A test file's own prose is documentation, same as a comment.
      if (/\.test\.tsx?$/.test(file)) continue;
      withoutComments(file).forEach((text, index) => {
        if (!text.includes("1830")) return;
        if (text.includes(STORAGE_KEY_NAMESPACE)) return;
        offenders.push(`${path.relative(SRC, file)}:${index + 1}  ${text.trim().slice(0, 110)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("still lets the design notes cite the rulebook", () => {
    /* THE OTHER HALF, and the one a blunter rename would have broken. #706's whole argument rests on quoting
       1830 verbatim; a scan that forbade the string everywhere would have taken the citation with it. */
    const reducer = fs.readFileSync(path.join(SRC, "utils", "sandboxSession.ts"), "utf8");
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
    for (const [file, needle] of [
      ["components/Lobby.tsx", "APP_NAME}: create room"],
      ["components/Lobby.tsx", "APP_NAME}: join room"],
      ["context/WalletContext.tsx", "APP_NAME}: authorize session key"],
      ["context/WalletContext.tsx", "APP_NAME}: revoke session key"],
      ["utils/sessionKey.ts", "APP_NAME} move"],
    ] as const) {
      expect(fs.readFileSync(path.join(SRC, file), "utf8")).toContain(needle);
    }
  });

  it("does not template the rules sentences", () => {
    /* BRANDING ONLY. "Project 18XX has no $0 dividend" is a SENTENCE, and turning an ordinary sentence into a
       template buys nothing and costs its readability. The constant exists for the places the app introduces
       itself, not for every place it is mentioned. */
    const bar = fs.readFileSync(path.join(SRC, "panels", "ContextualActionBar.tsx"), "utf8");
    expect(bar).toContain("Project 18XX has no $0 dividend");
  });
});
