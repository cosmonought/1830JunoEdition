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

/** The same mark with the gradient bar orbiting it. See design note #1113 for where it is allowed. */
export const NETA_LOGO_LOOP = `${process.env.PUBLIC_URL ?? ""}/video/neta-mark-loop.mp4`;

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
  /** ==================================================================
   *   DESIGN NOTE 1113: MOVING IN THE ANTEROOM, STILL AT THE TABLE
   *  ==================================================================
   *
   * ASKED FOR: the looping mark on the lobby and waiting room, the static one on the board, "completely
   * static to prevent peripheral distraction during gameplay."
   *
   * AND THE REASONING IS RIGHT, which is why it is a prop rather than a decision made once. A player in the
   * lobby is choosing; a player mid-Operating-Round is counting revenue across a hex map, and a thing that
   * moves in the corner of that is a thing the eye keeps returning to. The app already applies this rule to
   * itself -- #606 drops animation wherever the information is the picture rather than the movement.
   *
   * NOT DEFAULTED, so a new call site has to say which surface it is. */
  animated?: boolean;
}

/* ==================================================================
    DESIGN NOTE 1116: THE TWO ASSETS DO NOT FILL THEIR FRAMES EQUALLY
   ==================================================================
   REPORTED: "the .mp4 in the Lobby footer looks much smaller than the .png in the game room footer."
   AND IT WAS 49% SMALLER, measured rather than eyeballed. The PNG was cropped to its artwork (#1099), so the
   mark fills 99% of its frame; the clip was delivered with the orbit's whole sweep as padding and filled
   only 50%. At a shared 18px element the marks were 17.8px and 9.0px.
   THE SUGGESTED FIX WAS A BIGGER ELEMENT -- 32px, or `scale(1.3)`. That corrects the mark and grows the
   FOOTER, because the element's height is the frame's height whatever fraction of it is ink; 36px was the
   figure that would actually have matched, and a 36px box in an 18px line is a taller footer on every
   screen.
   SO THE CLIP WAS CROPPED INSTEAD, to the union of the orbit's bounding box across all 240 frames plus a
   margin for the bar's round caps. The mark now fills 82% of its frame, and the last 17% is taken by this
   constant rather than by growing the element -- 22px of video against 18px of image, which puts the two
   MARKS within a pixel of each other while the footer's line height does not move.
   `object-fit: contain` WAS ALSO SUGGESTED AND IS A NO-OP HERE: with `width: auto` the element already takes
   the video's own aspect, so there is nothing for `contain` to letterbox. */
const ANIMATED_HEIGHT_RATIO = 22 / 18;

export function NetaMark({ height = 22, labelled, animated = false }: NetaMarkProps) {
  const label = "Neta DAO";

  if (animated) {
    return (
      <video
        src={NETA_LOGO_LOOP}
        aria-label={labelled ? label : undefined}
        aria-hidden={labelled ? undefined : true}
        autoPlay
        loop
        muted
        playsInline
        height={Math.round(height * ANIMATED_HEIGHT_RATIO)}
        style={{
          height: Math.round(height * ANIMATED_HEIGHT_RATIO),
          width: "auto",
          display: "block",
          flex: "none",
          /* ==================================================================
              DESIGN NOTE 1113: THE CLIP IS BRIGHT-ON-BLACK, SO IT KEYS
             ==================================================================
             `YellowSignOverlay` #1040 established this for the haunting clips and its note states the
             precondition exactly: `screen` keys out black, and it only works on footage shot bright on
             black. This clip is that -- a white N and a saturated bar on `#000`. Without it the footer would
             carry a visible black rectangle, because h264 has no alpha and the ground here is `#0f0f0f`
             rather than pure black.
             THE STATIC PNG NEEDS NO SUCH TRICK: it was cropped with a real alpha channel (#1099), which is
             the better answer where the format allows one. Video does not. */
          mixBlendMode: "screen",
        }}
      />
    );
  }

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
