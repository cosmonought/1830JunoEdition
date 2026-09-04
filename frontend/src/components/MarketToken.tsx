// frontend/src/components/MarketToken.tsx
//
// ==================================================================
//  DESIGN NOTE 1155: ONE TOKEN, DRAWN THE SAME WAY WHEREVER THE MARKET IS
// ==================================================================
//
// REPORTED of the mini-camera: "it seems to just be using the corporation's heralds and not their actual
// tokens -- this is troubling because some of the heralds don't match the corporation's color, and not all of
// the heralds are round, e.g., NNH's herald is two letters on top of each other and look like weird
// squiggles."
//
// AND THE CHART HAD ALREADY SOLVED THIS, WHICH IS WHY THIS IS AN EXTRACTION RATHER THAN A DESIGN. Design note
// #430 measured a THRESHOLD -- "these tokens run from 46px down to about 14px, and a herald legible at the top
// of that range is a coloured smudge at the bottom ... the PRR keystone survives a ~15px inner box, the NYC
// oval does not" -- and settled on 26px, below which the token carries its ACRONYM instead. The disc under it
// takes the corporation's livery with computed ink (#430 again), so the colour is the corporation's own
// rather than whatever the herald artwork happens to be.
//
// THE PREVIEW BYPASSED ALL OF IT and drew a bare `CorporateLogo` at 15px: no disc, no livery, no threshold --
// and 15px is BELOW the size the chart had already determined heralds fail at. So the one surface that drew
// heralds small was the surface whose own sibling had measured that heralds do not survive being small. That
// is #891 in its purest form: two components rendering one object, one of them unaware of the rule the other
// established.
//
// APPEARANCE ONLY, PLACEMENT LEFT TO THE CALLER. The chart positions tokens absolutely with a scatter vector
// and a z-index; the preview stacks them. Those are different questions about WHERE, and folding them in here
// would make this component the union of two layouts rather than the intersection of two drawings.

import React from "react";

import { CorporateLogo } from "./CorporateLogo";
import { corporationLiveryColor, bestContrastTextColor } from "../styles/corporationLivery";
import { corporationLabel } from "../utils/corporationNames";
import { RADIUS } from "../styles/typography";

/** Design note #430, kept as the exported rule rather than a literal in two files: at or above this diameter
 *  a token carries its herald; below it, the acronym. Measured against the marks themselves. */
export const MIN_LOGO_TOKEN_DIAMETER_PX = 26;

export function MarketToken({
  companyId,
  ticker,
  diameterPx,
  fontSizePx,
  title,
  style,
  className,
}: {
  companyId: number;
  ticker: string;
  diameterPx: number;
  /** The chart derives this from its cell size; the preview from the token. Defaults to a ratio of the disc. */
  fontSizePx?: number;
  title?: string;
  /** Placement -- absolute offsets, z-index, transforms. See the note above on why it lives at the call site. */
  style?: React.CSSProperties;
  className?: string;
}) {
  const fill = corporationLiveryColor(companyId);
  const ink = bestContrastTextColor(fill);
  const label = title ?? corporationLabel(ticker);
  return (
    <span
      className={className}
      style={{
        ...styles.token,
        backgroundColor: fill,
        color: ink,
        width: `${diameterPx}px`,
        height: `${diameterPx}px`,
        fontSize: `${fontSizePx ?? Math.round(diameterPx * 0.42)}px`,
        ...style,
      }}
      title={label}
    >
      {diameterPx >= MIN_LOGO_TOKEN_DIAMETER_PX ? (
        <CorporateLogo
          ticker={ticker}
          size={Math.round(diameterPx * 0.56)}
          /* Design note #429: bounded to the circle, or a wide herald runs out of both sides and the disc's
             `overflow: hidden` crops it. */
          maxWidth={Math.round(diameterPx * 0.78)}
          color={ink}
          title={label}
        />
      ) : (
        ticker
      )}
    </span>
  );
}

export default MarketToken;

const styles: Record<string, React.CSSProperties> = {
  token: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontWeight: 700,
    borderRadius: RADIUS.circle,
    border: "2px solid rgba(0, 0, 0, 0.4)",
    boxShadow: "0 2px 4px rgba(0, 0, 0, 0.55)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    lineHeight: 1,
    textAlign: "center",
    boxSizing: "border-box",
  },
};
