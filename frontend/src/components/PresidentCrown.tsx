// Design note #552: an inline SVG crown, replacing both the nine-character word
// "PRESIDENT" (#490) and the crown emoji (#15).
//
// We ship the drawing, so it is the same picture on every platform; it inherits
// `currentColor`, so it takes the row's ink rather than a vendor's; and it is
// about one character wide. Still not a colour-only cue -- a SHAPE plus a real
// accessible name, three channels with none load-bearing alone.
//
// Sized in `em`, not pixels: it sits beside text in five type scales. The
// geometry is deliberately coarse (three peaks on a plinth, one filled path),
// because at 11-13px a fourth peak or a stroke closes up into a grey smear.
//
// See docs/ai_architecture/ui_shell_layout.md, PresidentCrown.tsx #552.

import React from "react";

/** The crown's gold, for the surfaces that set it rather than inheriting it.
 *
 *  ==================================================================
 *   DESIGN NOTE 974: TWO PANELS HAD ALREADY TYPED THIS HEX
 *  ==================================================================
 *
 *  THE DEFAULT IS STILL `currentColor` and that is still right -- on a table row or a right-aligned numeric
 *  column the crown should take the row's ink, which is the entire argument #552 makes for shipping a drawing
 *  instead of an emoji.
 *
 *  BUT THREE SURFACES OVERRIDE IT, and until now each did so with its own literal: `ContextualSubPanel`'s
 *  president column, `PlayerCards`' holding crown, and now the Operating Round bar. Three copies of one hex
 *  is the shape this project keeps finding -- `PRIVATE_POWER_STAR_FILL` exists for exactly this reason, one
 *  component over, and its note says why: "Exported so the button cannot drift to a near-miss."
 *
 *  NOT IMPORTED FROM `palette.ts`, although `CARD_BORDER_ACTIVE` happens to be the same string. That token
 *  means "this card is the active one" and this one means "president"; they agree today by coincidence, and
 *  a change to the active-card border should not silently repaint every crown in the app. */
export const PRESIDENT_CROWN_GOLD = "#c9a94c";

export interface PresidentCrownProps {
  /** Multiplier on the surrounding font size. */
  scale?: number;
  /** Overrides the accessible name. `null` marks it decorative, for the one
   *  case where adjacent text already says "President" and a screen reader
   *  would otherwise announce it twice. */
  label?: string | null;
  style?: React.CSSProperties;
}

export function PresidentCrown({
  scale = 1,
  label = "President",
  style,
}: PresidentCrownProps) {
  const size = `${scale}em`;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      focusable="false"
      role={label === null ? "presentation" : "img"}
      aria-hidden={label === null ? true : undefined}
      aria-label={label === null ? undefined : label}
      style={{ display: "inline-block", verticalAlign: "-0.12em", flex: "none", ...style }}
    >
      {/* A `<title>` as well as `aria-label`: the first is the native hover
          tooltip, the second is what assistive tech reads. They say the same
          thing on purpose. */}
      {label !== null && <title>{label}</title>}
      <path
        // Peaks at x=4, 12, 20; valleys at 8 and 16; plinth across the foot.
        d="M2.6 7.2 L7.4 11.4 L12 4.4 L16.6 11.4 L21.4 7.2 L21.4 16.6 L2.6 16.6 Z
           M2.6 18.2 L21.4 18.2 L21.4 20.6 L2.6 20.6 Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default PresidentCrown;
