// A corporation's station allowance drawn as tokens rather than as "2/4".
//
// Design note #0: the fraction priced every token at $40 when the third and
// fourth cost $100 (`utils/stationTokens.ts #0`), counted forwards while the
// price counts backwards, and did not look like the circles it describes. One
// circle per token in placement order, each captioned with its cost; spent
// tokens grey out IN PLACE so the row does not shrink.
//
// Design note #1: the bar is painted in the corporation's brand colour, so a
// token in that colour would be invisible by construction. A darkened inset
// gives the tokens a surface, and each carries a ring in the bar's derived ink.
// Placed tokens DESATURATE rather than fade -- alpha on a coloured bar reads as
// background, grey reads as spent against any hue.
//
// See docs/ai_architecture/hex_tile_math.md, StationTokenRow.tsx #0 / #1.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import type { StationTokenSlot } from "../utils/stationTokens";

export interface StationTokenRowProps {
  slots: readonly StationTokenSlot[];
  /** The corporation's brand colour -- the same `stationTickerColor` the map
   *  tokens are drawn from, so a circle here and a token there are visibly
   *  the same piece. */
  color: string;
  /** The bar's derived primary ink, for the ring and the captions. */
  ink: string;
  /** The bar's derived secondary ink, for a spent token's caption. */
  inkMuted: string;
  /** Shown when the corporation has no allowance to draw. */
  emptyLabel?: string;
  /* Design note #362: the home token's caption is its HEX, not "$0". Every other
     caption is a decision -- the money the next placement costs -- and the home
     token is granted free on a printed hex, so "$0" beside a circle read as "worth
     nothing" rather than "already yours". `null` falls back to the price: NNH has
     no home hex on this board, and inventing a label would be worse. */
  homeHexLabel?: string | null;
}

/** Neutral grey for a token already on the board -- design note #1. */
const PLACED_FILL = "#6e6c68";

export function StationTokenRow({
  slots,
  color,
  ink,
  inkMuted,
  emptyLabel = "none",
  homeHexLabel = null,
}: StationTokenRowProps) {
  if (slots.length === 0) {
    return <span style={{ ...styles.empty, color: inkMuted }}>{emptyLabel}</span>;
  }

  return (
    <span
      style={styles.row}
      role="group"
      aria-label={`Station tokens: ${slots.filter((s) => s.placed).length} of ${slots.length} placed`}
    >
      {slots.map((slot) => {
        // Design note #362: the home slot is captioned by WHERE, the rest
        // by HOW MUCH.
        const showsHex = slot.isHome && homeHexLabel !== null;
        const title = slot.isHome
          ? homeHexLabel !== null
            ? slot.placed
              ? `Home station on ${homeHexLabel} — granted free when the corporation floated.`
              : `Home station on ${homeHexLabel} — placed free when the corporation floats.`
            : slot.placed
              ? "Home station — granted free when the corporation floated."
              : "Home station — placed free when the corporation floats."
          : slot.placed
            ? `Placed. Cost $${slot.cost}.`
            : `Costs $${slot.cost} from the treasury.`;
        return (
          <span key={slot.index} style={styles.slot} title={title}>
            <span
              style={{
                ...styles.token,
                backgroundColor: slot.placed ? PLACED_FILL : color,
                borderColor: ink,
                // The next token to be bought is the one the button beside
                // this row is about to spend, so it is marked -- otherwise a
                // row of identical unplaced circles says nothing about which
                // price applies now.
                opacity: slot.placed ? 0.55 : 1,
              }}
              aria-hidden="true"
            />
            <span
              style={{
                ...styles.price,
                color: slot.placed ? inkMuted : ink,
                ...(slot.placed ? styles.pricePlaced : {}),
              }}
            >
              {showsHex ? homeHexLabel : `$${slot.cost}`}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export default StationTokenRow;

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "inline-flex",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: "8px",
    // Design note #1: the inset the tokens read against.
    padding: "4px 8px",
    borderRadius: "7px",
    backgroundColor: "rgba(0, 0, 0, 0.22)",
  },
  slot: {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
  },
  token: {
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    borderWidth: "1.5px",
    borderStyle: "solid",
    boxSizing: "border-box",
    flexShrink: 0,
  },
  /* Design note #487a: the second white ring on the next-to-buy slot is GONE. It
     made one circle in a row of identical circles look like a different component,
     to say something position already says -- `isNext: index === placedCount`
     means the next token is always the leftmost circle that has not greyed out.
     `isNext` survives on the data and still prices the placement button. */
  price: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    lineHeight: 1,
  },
  /* Design note #450: no strikethrough, for prices either. #362 made the first
     slot's caption a hex label, and a line through a place name reads as cancelled
     or no longer valid when the truth is the opposite. Dimming already carries
     "spent" without asserting anything about the text's validity, and one rule for
     the row beats two kept in step with which slot holds which kind of caption. */
  pricePlaced: { fontWeight: 400 },
  empty: { fontSize: FONT_SIZE.small, fontStyle: "italic" },
};
