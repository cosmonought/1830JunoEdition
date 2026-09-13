// frontend/src/components/accoladeGlyphs.tsx -- design note #1416/#1417.
//
// PLACEHOLDER GLYPHS, one per accolade, shared by the ceremony and the standings row so the two agree. A drawn
// SVG emblem per accolade replaces this table once the ceremony's mechanics are signed off; the keys stay.
// #1427: Carcosan Railways is the first with real art -- the Yellow Sign itself -- so `AccoladeGlyph` renders
// an image where one exists and the text glyph otherwise; every surface goes through it.

import React from "react";
import type { Accolade, AccoladeKey } from "../utils/accolades";
import { RADIUS } from "../styles/typography";
import { YELLOW_SIGN_IMAGE } from "./TrainBadges";

export const ACCOLADE_GLYPH: Readonly<Record<AccoladeKey, string>> = {
  "robber-baron": "💰",
  "master-of-the-line": "🚂",
  "track-boss": "🛤",
  "market-manipulator": "📈",
  workhorse: "🐴",
  gravedigger: "⚰",
  "rust-belt": "🦀",
  "train-robber": "🎩",
  "the-wall": "🧱",
  "phase-rusher": "⏩",
  fundraiser: "👛",
  "corporate-raider": "🏴",
  "mr-monopoly": "🎯",
  "mountain-mover": "⛰",
  "last-call": "🔔",
  scrooge: "🪙",
  "paper-millionaire": "📄",
  "early-adopter": "🔌",
  "capitalist-pig": "🐷",
  "fleet-admiral": "⚓",
  "shell-corporation": "🐚",
  salvager: "♻",
  "carcosan-railways": "👁", // unused: the sign's image renders instead (`ACCOLADE_IMAGE`)
  redeemer: "🩸",
  // #1429
  bagholder: "💼",
  "wrong-way-down": "📉",
  orphanage: "🧸",
  passenger: "🎟",
  "greater-fool": "🃏",
  "human-stop-loss": "✂",
  farmhand: "🐄",
  juggernaut: "💥",
  "golden-goose": "🥚",
  "dividend-machine": "🏧",
  "little-engine": "🚃",
  "white-elephant": "🐘",
  "comeback-kid": "🪃",
  // #1438
  "scrooge-company": "🧤",
  "salt-daddy": "🧂",
  "sugar-daddy": "🍬",
  "railroad-baron": "🎩",
};

/** #1427: accolades drawn with an image rather than a text glyph. */
export const ACCOLADE_IMAGE: Readonly<Partial<Record<AccoladeKey, string>>> = {
  "carcosan-railways": YELLOW_SIGN_IMAGE,
};

/** The glyph for an accolade, at `size` px: the image where there is one, the text glyph otherwise. */
export function AccoladeGlyph({ accoladeKey, size }: { accoladeKey: AccoladeKey; size: number }) {
  const image = ACCOLADE_IMAGE[accoladeKey];
  if (image) {
    return <img src={image} alt="" aria-hidden="true" style={{ height: size, width: "auto", objectFit: "contain", display: "block" }} />;
  }
  return <>{ACCOLADE_GLYPH[accoladeKey] ?? "★"}</>;
}

/* ==================================================================
    DESIGN NOTE 1433: THE BADGES ON THE TABLES
   ==================================================================
   The ceremony is its own stage now (GameOverModal), so the settled accolades page is gone -- and what a
   player or corporation won is shown where their row is: a run of small pills after the name on the
   Standings and Corporations tables, the glyph and nothing else, the title and detail on hover. Small on
   purpose: the tables are the figures, the badges are the flourish. */
export function AccoladeBadges({ accolades, size = 15 }: { accolades: readonly Accolade[]; size?: number }) {
  if (accolades.length === 0) return null;
  return (
    <span style={badgeStyles.run} data-testid="accolade-badges">
      {accolades.map((a) => (
        <span key={a.key} style={badgeStyles.pill} title={`${a.title} — ${a.detail}`} aria-label={a.title} data-testid={`table-badge-${a.key}`}>
          <AccoladeGlyph accoladeKey={a.key} size={size} />
        </span>
      ))}
    </span>
  );
}

const badgeStyles: Record<string, React.CSSProperties> = {
  run: { display: "inline-flex", alignItems: "center", gap: "3px", flexWrap: "wrap" },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "22px",
    height: "22px",
    padding: "0 4px",
    borderRadius: RADIUS.pill,
    border: "1px solid #4a3e18",
    backgroundColor: "#241d0e",
    fontSize: "14px",
    lineHeight: 1,
    cursor: "default",
  },
};
