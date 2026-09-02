// frontend/src/components/NetaMark.tsx
//
// The Neta DAO logo.
//
// ==================================================================
//  DESIGN NOTE 1099: THE ATTRIBUTION GETS ITS LOGO
// ==================================================================
//
// REQUESTED: "add the Neta DAO logo to the lobby screen as well as the game screen; right now the game screen
// says 'Powered by Neta DAO' at the bottom but lacks our logo; the lobby screen doesn't mention Neta DAO
// anywhere at all."
//
// THE SUPPLIED ARTWORK, NOT A REDRAWING OF IT. A first attempt at this traced the mark into SVG paths and a
// hand-mixed gradient, and that was wrong on a point that has nothing to do with how close it looked: this is
// another organisation's identity, and an approximation of somebody's logo is not their logo. `public/neta-dao.png`
// is the file as provided, cropped to the artwork and given a real alpha channel -- the source was drawn on
// black, so alpha is recovered from the premultiplied pixels rather than colour-keyed, which is what stops a
// dark fringe appearing where the mark meets a panel that is not pure black.
//
// ONE COMPONENT FOR TWO SURFACES because the footer and the lobby differ only in a number, and the sizing,
// the aspect lock and the accessible-name rule all have to be right once rather than twice.
//
// See docs/ai_architecture/ui_shell_layout.md, NetaMark.tsx #1099.

import React from "react";

/** The logo as supplied. `public/`, so CRA serves it from the app root at any deploy path. */
export const NETA_LOGO_IMAGE = `${process.env.PUBLIC_URL ?? ""}/neta-dao.png`;

export interface NetaMarkProps {
  /** Rendered height in px. Width follows the artwork's aspect. */
  height?: number;
  /** ==================================================================
   *   DESIGN NOTE 1099: DECORATIVE BESIDE A LABEL, NAMED WHEN ALONE
   *  ==================================================================
   *
   * In the footer the logo sits immediately before the words "Powered by Neta DAO", so an accessible name
   * here would make a screen reader announce the same thing twice. Anywhere it stands on its own it has to
   * carry the attribution itself.
   *
   * NOT DEFAULTED: a default would be silently wrong on whichever caller had not thought about it, and there
   * are few enough callers that saying which is cheap. */
  labelled: boolean;
}

export function NetaMark({ height = 22, labelled }: NetaMarkProps) {
  const label = "Neta DAO";
  return (
    <img
      src={NETA_LOGO_IMAGE}
      alt={labelled ? label : ""}
      height={height}
      style={{
        /* Height drives and width follows, so the 213x160 artwork cannot be stretched by a caller that
           passes only one dimension; `contain` guarantees neither is exceeded if one ever does. */
        height,
        width: "auto",
        maxHeight: "100%",
        objectFit: "contain",
        display: "block",
        flex: "none",
      }}
    />
  );
}

export default NetaMark;
