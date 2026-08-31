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
      ? "Yellow Sign — this player's corporation was marked by Carcosa"
      : "Yellow Sign — this corporation was marked by Carcosa";
  return (
    <img
      src={YELLOW_SIGN_IMAGE}
      alt={label}
      title={label}
      height={size}
      style={{
        /* Design note #1091: the same shape rules #1088 settled for the chip -- height drives, width follows
           the 456x547 aspect, and `contain` guarantees neither is exceeded. `verticalAlign: middle` rather
           than the chip's `display: block`, because this one sits in a line of text rather than in a flex
           row: a block image beside a name would drop to its own line. */
        height: size,
        width: "auto",
        maxHeight: "100%",
        objectFit: "contain",
        verticalAlign: "middle",
        flex: "none",
        marginLeft: "5px",
      }}
    />
  );
}

export default CarcosaMark;
