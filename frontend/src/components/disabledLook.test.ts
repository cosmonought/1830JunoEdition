// frontend/src/components/disabledLook.test.ts
//
// ==================================================================
//  DESIGN NOTE 681 (harness): A DISABLED CONTROL HAS TO LOOK DISABLED
// ==================================================================
//
// This bug has now been reported three times, in three files, as three
// separate cosmetic complaints:
//
//   "Selling Opens in SR2 ... it is the same color as the Buy buttons."
//   "the Skip Buy Private button looks slightly dimmer" (the inverse -- a
//   control drawn as lesser that was not).
//   And #619 found three action-bar controls passing `disabled` with no style
//   at all, one of them reaching for a style key that did not exist.
//
// IT IS ONE BUG. React inline styles cannot express `:disabled` (`Lobby.tsx`
// #3), so every control in this codebase computes its own greyed look. Nothing
// enforces that. `tsc` is happy -- `disabled` is a valid prop on its own.
// ESLint is happy -- there is no rule for "you styled this inconsistently".
// And a `Record<string, CSSProperties>` sheet returns `undefined` for a
// misspelled key, which spreads to nothing, silently. Every layer of the
// toolchain passes a control that refuses clicks at full contrast.
//
// So the invariant is asserted here instead: IF A CONTROL TAKES `disabled`, ITS
// STYLE MENTIONS A DISABLED LOOK. Not which one -- the file has several and they
// mean different things -- only that the question was answered.
//
// SOURCE-LEVEL, for the reason `playerCardAlignment.test.ts` records: this JSX
// needs a game state and a rendered tree to exercise, and what is under test is
// structural. The scanner below is brace-aware rather than a regex, because the
// first attempt split attribute blocks on `>` and every arrow function in an
// `onClick` broke it -- reporting controls as having no `disabled` prop when
// they plainly did.

import fs from "fs";
import path from "path";

/** The files this invariant covers. A control anywhere else is not exempt; it
 *  simply has not been swept yet, and adding it here is how it gets swept. */
const COVERED = ["StockRoundPanel.tsx"] as const;

/** Any style whose name says "this control is unavailable". Membership is
 *  deliberately loose: what matters is that a look was CHOSEN, not which. */
const DISABLED_LOOK = /(Disabled|Empty|soldOut|Inert)/;

/** One JSX opening tag's attribute text, brace-aware.
 *
 *  Walks from `<button` counting `{}` depth and stops at the first `>` seen at
 *  depth zero, so `onClick={() => f()}` cannot end the tag early. Quotes are
 *  tracked too -- a `>` inside a title string is not a tag close either. */
function openingTags(source: string, tagName: string): string[] {
  const out: string[] = [];
  const opener = new RegExp(`<${tagName}\\b`, "g");
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 0;
    let quote: string | null = null;
    let at = match.index + match[0].length;
    for (; at < source.length; at += 1) {
      const ch = source[at];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) break;
    }
    out.push(source.slice(match.index, at));
  }
  return out;
}

function controlsIn(file: string): string[] {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  return [...openingTags(source, "button"), ...openingTags(source, "select")];
}

/** The two checks, as predicates, so they can be pointed at synthetic input.
 *  A harness nobody has watched fail is a harness nobody knows works -- and
 *  this one would pass just as happily against a file with no controls in it,
 *  which is the failure mode the "finds the controls" test above exists for. */
const missingLook = (tags: readonly string[]) =>
  tags.filter((tag) => /\bdisabled=/.test(tag)).filter((tag) => !DISABLED_LOOK.test(tag));
const missingReason = (tags: readonly string[]) =>
  tags.filter((tag) => /\bdisabled=/.test(tag)).filter((tag) => !/\btitle=/.test(tag));

describe("the scanner", () => {
  it("is not fooled by an arrow function in a handler", () => {
    /* THE BUG IN THE FIRST DRAFT OF THIS FILE, pinned so a future
       simplification back to `split(">")` fails here rather than quietly
       reporting that every control is fine. */
    const tags = openingTags(`<button onClick={() => go()} disabled={x}>hi</button>`, "button");
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain("disabled={x}");
  });

  it("is not fooled by a > inside a title string", () => {
    const tags = openingTags(`<button title="a > b" disabled={x}>hi</button>`, "button");
    expect(tags[0]).toContain("disabled={x}");
  });

  it("CATCHES a control that refuses clicks at full contrast", () => {
    /* The regression this whole file exists for, as it was actually written:
       `disabled` passed, no style computed. If this ever passes an empty array
       the checks below are decorative. */
    const bad = `<button style={{ ...styles.actionButton }} disabled={x} title="no">`;
    expect(missingLook([bad])).toEqual([bad]);
    expect(missingLook([`<button style={{ ...styles.actionButtonDisabled }} disabled={x}>`])).toEqual(
      [],
    );
  });

  it("CATCHES a greyed control that cannot say why", () => {
    const mute = `<button style={{ ...styles.actionButtonDisabled }} disabled={x}>`;
    expect(missingReason([mute])).toEqual([mute]);
  });

  it("ignores a control that is never disabled", () => {
    // Not every button is gated, and an always-live one needs neither.
    expect(missingLook([`<button onClick={go}>`])).toEqual([]);
    expect(missingReason([`<button onClick={go}>`])).toEqual([]);
  });

  it("finds the controls it is meant to be checking", () => {
    // Without this, a rename could empty the sweep and every assertion below
    // would pass against nothing.
    for (const file of COVERED) {
      const withDisabled = controlsIn(file).filter((tag) => /\bdisabled=/.test(tag));
      expect(withDisabled.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe.each(COVERED)("%s", (file) => {
  it("gives every disableable control a disabled look", () => {
    /* THE INVARIANT. A control that refuses clicks at full contrast reads as
       broken rather than as barred -- and the player's next move is to click it
       again, harder. */
    const offenders = missingLook(controlsIn(file)).map((tag) =>
      tag.replace(/\s+/g, " ").slice(0, 120),
    );
    expect(offenders).toEqual([]);
  });

  it("lets a disabled control say why", () => {
    /* The other half, and the reason #619's greyed button still confused
       people: grey answers "can I press this" and nothing else. Every
       disableable control here carries a `title`, whether its own specific
       reason or the shared one. */
    const silent = missingReason(controlsIn(file)).map((tag) =>
      tag.replace(/\s+/g, " ").slice(0, 120),
    );
    expect(silent).toEqual([]);
  });
});
