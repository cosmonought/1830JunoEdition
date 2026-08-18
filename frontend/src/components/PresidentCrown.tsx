// frontend/src/components/PresidentCrown.tsx
//
// ==================================================================
//  DESIGN NOTE 552: OUR OWN CROWN, DRAWN NOT TYPED
// ==================================================================
//
// REPORTED: the word "PRESIDENT" takes up a lot of space and a long player
// name starts running into the next column. Bring the crown back -- but not
// as an emoji, since those look different on every device.
//
// BOTH HALVES OF THAT ARE RIGHT, and they were previously traded against
// each other rather than solved. Design note #15 used the crown emoji and
// design note #490 removed it, each correctly:
//
//   #15  wanted a compact mark, because the president tag sits inside a
//        right-aligned numeric column and a wide one pushes the digits out
//        of alignment.
//   #490 removed it because "a pictogram that renders in a platform colour
//        font at a platform weight is decoration rather than a third
//        channel" -- U+1F451 is a different picture on Windows, macOS,
//        Android and Linux, at a weight and hue this app does not choose.
//        So it could not be relied on to MEAN anything, and the word had to
//        carry the meaning instead.
//
// An inline SVG answers both. It is the same drawing on every device
// because we ship the drawing; it inherits `currentColor` so it takes the
// row's own ink rather than a vendor's; and it is roughly one character
// wide instead of nine.
//
// IT IS STILL NOT A COLOUR-ONLY CUE, which is the constraint #490 was
// actually defending and the one worth restating so it is not lost again:
// the crown is a SHAPE, distinguishable with no colour vision at all, and
// it carries a real accessible name so a screen reader announces
// "President" where a sighted reader sees the silhouette. Colour, shape and
// text-alternative -- three channels, none of them load-bearing alone.
//
// SIZED IN `em`, NOT PIXELS. It sits beside text in five different type
// scales (the ledger's micro rows, the stock card's ownership list, the
// corporation table). An absolute size would be right in one of them.
//
// THE GEOMETRY is a three-peak crown on a plinth, and deliberately coarse:
// this renders at roughly 11-13px, where a fourth peak or a row of jewels
// closes up into a grey smear. Drawn as one filled path so it stays solid
// at small sizes rather than relying on a stroke width that would round to
// nothing.

import React from "react";

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
