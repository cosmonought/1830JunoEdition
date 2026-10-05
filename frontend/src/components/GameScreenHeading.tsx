// frontend/src/components/GameScreenHeading.tsx
//
/* ==================================================================
    W3-A / OD-5(b), AUD-01.03: THE GAME SCREEN'S HEADING, AND THE FORCED NOTICES' FOCUS TARGET
   ==================================================================
   RULED (OD-5(b), 2026-10-04): "Add/use a stable GAME-SCREEN HEADING as the post-notice focus target. Do NOT use
   the action bar's round label" -- it changes with every round and step, and a focus target must name the page,
   not the moment.

   A REAL `<h1>`, so a screen reader's heading navigation finds the table and announces it when focus arrives.
   `tabIndex={-1}`: focusable by the notice chain, never a Tab stop. VISUALLY HIDDEN with the standard clip
   pattern, out of the flow, so receiving focus moves no layout and paints nothing; the chain focuses it with
   `preventScroll`. The text is stable for the life of the table on purpose. */

import React, { forwardRef } from "react";

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  padding: 0,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

/** The heading's text. Exported so a test names the table the way the shell does. */
export const GAME_SCREEN_HEADING_TEXT = "Game table";

export const GameScreenHeading = forwardRef<HTMLHeadingElement>(function GameScreenHeading(_props, ref) {
  return (
    <h1 ref={ref} tabIndex={-1} style={VISUALLY_HIDDEN} data-testid="game-screen-heading">
      {GAME_SCREEN_HEADING_TEXT}
    </h1>
  );
});

export default GameScreenHeading;
