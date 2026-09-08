// frontend/src/components/KanawhaBadge.tsx
//
// The Kanawha Licence's mark -- design note #1323.
//
// RULED: "The corporation badge for this should use the pickaxe icon used on the preprinted L8 Coalfields hex
// (and it should appear on the action bar and the corp cards everywhere they appear), and I would also put
// this icon on the action bar's 'Buy License' button."
//
// ONE GLYPH, THREE PLACES. The pickaxe is the same shape `drawCoalEmblem` (`hexCanvasPrimitives.ts`) strokes
// into Coal River's circle -- a handle from lower-left to upper-right and a curved head across it -- so a
// player who has seen the hex recognises the mark on the card and the button. Drawn as SVG here because
// these surfaces are DOM, and the canvas version cannot be reused; the two are kept alike by eye, which is
// the same arrangement `PrivatePowerStar` has with the board's star (#714).

import React from "react";

export interface PickaxeIconProps {
  /** Rendered height in px; the width follows. */
  height?: number;
  /** Stroke colour. Defaults to `currentColor` so the icon takes the text colour of wherever it sits. */
  color?: string;
  title?: string;
}

/** The pickaxe alone -- for the "Buy Kanawha Licence" button and anywhere else the mark rides beside text. */
export function PickaxeIcon({ height = 14, color = "currentColor", title }: PickaxeIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={height}
      height={height}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ display: "inline-block", flexShrink: 0, verticalAlign: "-0.15em" }}
    >
      {title ? <title>{title}</title> : null}
      {/* The handle. */}
      <path d="M4 20 L15 9" stroke={color} strokeWidth="2.6" strokeLinecap="round" fill="none" />
      {/* The head: a shallow arc across the top of the handle. */}
      <path
        d="M9 5 Q 15 2 21 8"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export interface KanawhaLicenseBadgeProps {
  /** Licences held. Nothing renders for zero. */
  count: number;
  /** The livery ink the badge sits on -- the same colour the ticker beside it uses. */
  color?: string;
  size?: number;
}

/** The corporation's licence mark: a pickaxe in a small ring, with a count only when it is more than one.
 *  Renders nothing for a corporation without one, so every card can mount it unconditionally. */
export function KanawhaLicenseBadge({ count, color = "currentColor", size = 16 }: KanawhaLicenseBadgeProps) {
  if (!Number.isFinite(count) || count <= 0) return null;
  const label = count === 1 ? "Holds a Kanawha Licence — may cross Coal River (L8)" : `Holds ${count} Kanawha Licences`;
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        height: size,
        padding: `0 ${Math.round(size * 0.3)}px`,
        borderRadius: size,
        border: `1px solid ${color}`,
        color,
        fontSize: Math.max(9, Math.round(size * 0.6)),
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      <PickaxeIcon height={Math.round(size * 0.7)} color={color} />
      {count > 1 ? <span>{count}</span> : null}
    </span>
  );
}

export default KanawhaLicenseBadge;
