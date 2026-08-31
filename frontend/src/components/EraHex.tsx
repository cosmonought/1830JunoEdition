// frontend/src/components/EraHex.tsx
//
// One flat blank hex in an era's colour, wherever a surface needs to say "this colour of tile".
//
// ==================================================================
//  DESIGN NOTE 1094: TWO SURFACES, ONE ANSWER TO "WHAT COLOUR IS GREEN"
// ==================================================================
//
// THIS WAS PRIVATE TO `ActionToast` (#929) and correct while the era toast was the only thing that drew a
// hex. The Bank Depot table now draws them too -- ruled: "add small, blank colored hexes (Yellow, Green,
// Brown) ... to clearly indicate tile availability" -- and a second hand-rolled copy is the shape #891 keeps
// costing this project: two surfaces answering one question two ways, discovered when they drift.
//
// #929'S ARGUMENT SURVIVES THE MOVE, AND IT IS WHY THE BOARD IS NOT INCLUDED. Its note reads: "the fills are
// this toast's own and deliberately not `PRINTED_HEX_FILL` or the tile catalog's palette: those are the
// colours a hex is DRAWN on a dark board at map scale, and a 16px glyph inside a toast needs to read against
// the toast's background instead."
//
// THE DISTINCTION IS SURFACE, NOT COMPONENT. A hex at map scale on the canvas and a hex-sized glyph in dark
// chrome are two different rendering problems, and they should keep two palettes. But the toast and the
// ledger table are the SAME problem -- a small glyph on this app's dark panel ink -- so they get one.
//
// SIZED BY THE CALLER, because that is the only thing that differs between them: the toast draws at 16px
// beside a sentence, the table at 11px inside a row of small type.

import React from "react";

/** The three eras, in the colours a small glyph needs against this app's dark chrome. */
export const ERA_HEX_FILL: Readonly<Record<string, string>> = {
  Yellow: "#d9b64a",
  Green: "#4e9d5f",
  Brown: "#8a6242",
};

export interface EraHexProps {
  /** An era name as `tierEra` returns it -- "Yellow", "Green", "Brown". */
  tone: string;
  /** Width in px; the height follows the hex's own 16:18 proportion. Design note #1094: the one difference. */
  size?: number;
}

export function EraHex({ tone, size = 16 }: EraHexProps) {
  const fill = ERA_HEX_FILL[tone] ?? "#6d7382";
  return (
    <svg
      width={size}
      height={Math.round((size * 18) / 16)}
      viewBox="0 0 16 18"
      role="presentation"
      /* Design note #1094: a hex sits in running text in the table's Phase cell, where a baseline-aligned
         inline SVG would ride low against the type. The toast's flex row is unaffected by this. */
      style={{ verticalAlign: "middle", flex: "none" }}
    >
      {/* A pointy-top hex, the orientation the board draws (#1's unit hex). */}
      <path
        d="M8 0.6 L15.2 4.8 V13.2 L8 17.4 L0.8 13.2 V4.8 Z"
        fill={fill}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth="1"
      />
    </svg>
  );
}

export default EraHex;
