// frontend/src/components/TrainGlyph.tsx
//
// The locomotive, drawn rather than typed.
//
// Design note #617: A TRAIN THAT LOOKS LIKE A TRAIN, AND COUNTS. Inline SVG is the answer to the emoji
// problem -- drawn by this file, from these coordinates, on every device, with no font to substitute and no
// colour-emoji fallback. The objection that ruled emojis out does not apply to a path we ship.
// THE CARRIAGES ARE THE TIER, which is the part worth having: what a new player needs to learn is that the
// NUMBER IS A CAPACITY, so the glyph is a locomotive plus one carriage per revenue centre and "buy a 3"
// becomes a picture of the thing it buys.
// DIESEL IS DRAWN, NOT COUNTED -- a D-train has no fixed length, so a carriage count would be a lie in the one
// case where the number is not a number.
// `aria-hidden`: every glyph sits beside the tier already written as text.
//
// Design note #702: LIFTED OUT OF `TrainPurchasePanel`, unchanged, because the train chips now draw it too.
// Copying it would be the `markerSizeFor` mistake from #699 in a new place -- one idea, two coordinate
// systems, drifting silently because nothing compares them.
//
// `carriages: false` is the chip's variant: the locomotive alone. A 6-train's carriages are 51px wide, which
// is wider than the chip they would sit in, and the chip already prints the tier as a numeral one glyph to
// the right -- so the carriages there would be a second statement of a number that is already there, in the
// space that made the chip unreadable in the first place.
//
// See docs/ai_architecture/ui_shell_layout.md, TrainGlyph.tsx #617 / #702.

import React from "react";

export interface TrainGlyphProps {
  /** `"2"`.. `"6"` or `"D"`. */
  tier: string;
  color: string;
  /** Draw the carriages that count out the tier. `false` gives the locomotive alone -- see #702. */
  carriages?: boolean;
  /** Height in px; the width follows from it. The purchase panel's 12px is the reference drawing. */
  height?: number;
}

export function TrainGlyph({ tier, color, carriages = true, height = 12 }: TrainGlyphProps) {
  const cars = !carriages ? 0 : tier === "D" ? 3 : Math.min(6, Number(tier) || 0);
  const isDiesel = tier === "D";
  // Locomotive is 13 wide; each carriage is 5 wide on a 6px pitch.
  const width = (carriages ? 15 : 13) + cars * 6;
  // Design note #702: the drawing is authored at height 12 and SCALED by the viewBox, so a chip-sized glyph
  // is the same locomotive rather than a second set of coordinates that happen to look similar.
  const scale = height / 12;
  return (
    <svg
      width={Math.round(width * scale)}
      height={height}
      viewBox={`0 0 ${width} 12`}
      aria-hidden="true"
      focusable="false"
      style={{ flex: "none", display: "block" }}
    >
      {/* Locomotive: cab, boiler, and two wheels. */}
      <rect x={0} y={2} width={6} height={6} rx={1} fill={color} />
      <rect x={6} y={4} width={7} height={4} rx={1} fill={color} />
      <circle cx={3} cy={10} r={1.6} fill={color} />
      <circle cx={10} cy={10} r={1.6} fill={color} />
      {cars === 0
        ? null
        : isDiesel
          ? /* Design note #617: "and onward", not a count. */
            [0, 1, 2].map((index) => (
              <circle key={index} cx={18 + index * 6} cy={6} r={1.4} fill={color} opacity={0.75} />
            ))
          : Array.from({ length: cars }, (_, index) => (
              <rect
                key={index}
                x={16 + index * 6}
                y={3.5}
                width={5}
                height={5}
                rx={1}
                fill={color}
                opacity={0.8}
              />
            ))}
    </svg>
  );
}

export default TrainGlyph;
