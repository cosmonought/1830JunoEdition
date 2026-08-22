// frontend/src/utils/styleShorthand.ts
//
// Which CSS shorthands are unsafe to mix with their own longhands in a React inline style.
//
// ==================================================================
//  DESIGN NOTE 732: A CLEARED LONGHAND TAKES THE SHORTHAND WITH IT
// ==================================================================
//
// REPORTED of the Tiles tab: "when I click it to close the expansion it leaves the tile with a white
// background. Clicking it again drops the white background but opens the panel, and closing the panel restores
// the white background."
//
// THE ALTERNATION IS THE DIAGNOSIS, and it rules out every explanation involving focus rings or a stale render.
// A focus style would persist through both clicks; a stale state would put the panel out of step too, and the
// panel was always right. Something was toggling in ANTI-PHASE with the selection, which is a very specific
// shape of bug.
//
// WHAT ACTUALLY HAPPENED, in three renders:
//
//   1. UNSELECTED. The style object carries `background: "none"` -- the SHORTHAND. React writes it.
//   2. SELECTED. The object carries `background: "none"` plus `backgroundColor: "rgba(255,255,255,0.05)"` --
//      the LONGHAND, spread after. React diffs, sees `background` unchanged and skips it, sees `backgroundColor`
//      added and writes it. The tile shows the faint highlight. Correct.
//   3. UNSELECTED AGAIN. `backgroundColor` is gone from the object, so React clears it: `style.backgroundColor
//      = ""`. `background` is unchanged from render 2, so React does NOT rewrite it.
//
// And now the inline style has NO background-color declaration at all -- because clearing the longhand removes
// the shorthand's contribution to that same underlying property. The element falls back to the User Agent
// default for a `<button>`, which is `background-color: buttonface`: light grey. White, on a dark panel,
// against a tile that is supposed to be transparent.
//
// Clicking again writes `backgroundColor` explicitly, which replaces `buttonface` -- so the white "drops" on
// open and "returns" on close, exactly as reported, and exactly out of phase.
//
// THE FIX IS TO NEVER MIX THEM. If the base style says `backgroundColor` rather than `background`, then every
// render writes the same property and React's diff always has a value to set. No shorthand, no gap.
//
// WHY THIS IS A MODULE AND NOT A ONE-LINE EDIT. The mix is legal, reads fine, and misbehaves only on the
// third render of a toggle -- so it is invisible in review and invisible in any test that renders once. There
// were twenty-odd `background:` shorthands in the components directory when this was found. The scan below is
// how the class stays fixed rather than the instance.
//
// See docs/ai_architecture/ui_shell_layout.md, styleShorthand.ts #732.

/** Shorthands whose longhands this codebase actually toggles, with the longhands that clear them.
 *
 *  DELIBERATELY SHORT. `font`, `grid` and `flex` are shorthands too, and none of them is ever toggled against
 *  its own longhand here -- listing them would produce findings nobody can act on, which is how a lint rule
 *  gets switched off. Add one when a real toggle appears. */
export const RISKY_SHORTHANDS: Readonly<Record<string, readonly string[]>> = {
  background: ["backgroundColor", "backgroundImage"],
  border: ["borderColor", "borderWidth", "borderStyle"],
  borderTop: ["borderTopColor", "borderTopWidth"],
  borderBottom: ["borderBottomColor", "borderBottomWidth"],
  margin: ["marginTop", "marginBottom", "marginLeft", "marginRight"],
  padding: ["paddingTop", "paddingBottom", "paddingLeft", "paddingRight"],
};

export interface ShorthandClash {
  shorthand: string;
  longhand: string;
}

/** Every shorthand in `base` that `overlay` clears a longhand of.
 *
 *  The pairing is what matters: a shorthand alone is fine, and a longhand alone is fine. The hazard is a base
 *  style holding the shorthand while a conditional overlay holds the longhand, because the overlay is the
 *  thing that comes and goes. */
export function shorthandClashes(
  base: Readonly<Record<string, unknown>>,
  overlay: Readonly<Record<string, unknown>>,
): ShorthandClash[] {
  const found: ShorthandClash[] = [];
  for (const [shorthand, longhands] of Object.entries(RISKY_SHORTHANDS)) {
    if (!(shorthand in base)) continue;
    for (const longhand of longhands) {
      if (longhand in overlay) found.push({ shorthand, longhand });
    }
  }
  return found;
}
