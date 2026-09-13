// frontend/src/components/CarcosaMark.tsx
//
// The Yellow Sign, beside a name.
//
// ==================================================================
//  DESIGN NOTE 1091: ONE COMPONENT, FOUR SURFACES, ONE SIZE ARGUMENT
// ==================================================================
//
// RULED: "append the yellow sign icon next to the Corporation's logo or name in the Action Bar, Stocks tab,
// and Game Ledger" -- and, on the scoreboard, "next to the name of the player who is President".
//
// FOUR PLACES IS WHY THIS IS A COMPONENT rather than four `<img>` tags. The chips learned that lesson one
// batch ago from the other direction: #1088's sizing, `objectFit`, `flex` and accessibility text all had to
// be got right once, and a second hand-rolled copy is a second chance to get one of them wrong. What differs
// between these four is a number.
//
// IT IS NOT `TrainChips`' IMAGE MOVED HERE. That one sits inside a chip, matched to `TrainGlyph`'s box and
// tuned against a locomotive; this one sits beside running text and is matched to the type. Sharing the path
// constant is right; sharing the styling would make one of the two wrong.
//
// See docs/ai_architecture/ui_shell_layout.md, CarcosaMark.tsx #1091.

import React from "react";

import { YELLOW_SIGN_IMAGE } from "./TrainBadges";
import { RADIUS } from "../styles/typography";

export interface CarcosaMarkProps {
  /** Matched to the type it sits beside, in px. */
  size?: number;
  /** ==================================================================
   *   DESIGN NOTE 1091: WHAT IT MEANS DEPENDS ON WHO IS WEARING IT
   *  ==================================================================
   *
   * A corporation's mark says the fog took its train; a president's says the fog took the president. Same
   * picture, two sentences -- and a screen reader gets the sentence rather than the picture.
   *
   * NOT OPTIONAL AND NOT DEFAULTED, deliberately. A default would be silently wrong on whichever surface
   * did not think about it, and there are only two callers' worth of choice to make. */
  meaning: "corporation" | "president";
}

export function CarcosaMark({ size = 13, meaning }: CarcosaMarkProps) {
  const label =
    meaning === "president"
      ? "This player has seen the Yellow Sign." // #1421: the ruled wording
      : "This corporation has seen the Yellow Sign.";
  /* ==================================================================
      DESIGN NOTE 1427: THE SIGN GETS A PILL
     ==================================================================
     REPORTED: "the Yellow Sign badge is incredibly faint on corporation stripes and tables during the game."
     The mark is thin yellow strokes on a transparent ground, so on ERIE's yellow stripe it vanishes and on a
     dark table row it is a few hairlines. A dark pill behind it, bordered in the sign's own gold, gives it
     a ground on every surface -- livery, table, card -- and the image inside is a step larger than the type
     beside it, since a symbol needs more height than a letter to read at the same weight. */
  const pad = Math.max(2, Math.round(size * 0.22));
  return (
    <span
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        verticalAlign: "middle",
        flex: "none",
        marginLeft: "5px",
        padding: `${pad}px ${pad + 2}px`,
        borderRadius: RADIUS.pill,
        backgroundColor: "#141208",
        border: "1px solid #c9a227",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
        lineHeight: 0,
      }}
    >
      <img
        src={YELLOW_SIGN_IMAGE}
        alt={label}
        height={size + 3}
        style={{
          /* Design note #1091: height drives, width follows the 456x547 aspect, `contain` guarantees neither
             is exceeded. Block inside the pill; the pill is what sits inline with the text. */
          height: size + 3,
          width: "auto",
          objectFit: "contain",
          display: "block",
        }}
      />
    </span>
  );
}

export default CarcosaMark;
