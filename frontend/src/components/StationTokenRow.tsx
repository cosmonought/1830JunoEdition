// frontend/src/components/StationTokenRow.tsx
//
// A corporation's station allowance, as tokens rather than as a fraction.
//
// ===================================================================
//  DESIGN NOTE 0: "2/4" IS A COUNT; THE ROW IS AN INVENTORY
// ===================================================================
//
// The Operating Round bar reported stations as `2/4 - $40 ea`. Three things
// wrong with that, and only the first is cosmetic:
//
//   IT PRICED THEM ALL THE SAME. "$40 ea" is false for every token after the
//   second, which costs $100 (`utils/stationTokens.ts` design note #0). The
//   one number a president needs before deciding to place is the one the
//   readout got wrong.
//
//   IT COUNTED FORWARDS WHILE THE PRICE COUNTS BACKWARDS. "2 of 4 left" says
//   nothing about WHICH two are left, and the two remaining are not
//   interchangeable -- one costs $40 and the next $100.
//
//   IT DID NOT LOOK LIKE THE THING IT DESCRIBES. Tokens are circles on the
//   map. A fraction is not.
//
// So the row draws the corporation's whole allowance, one circle per token,
// in placement order, each captioned with what it costs. Spent tokens grey
// out in place -- the row does not shrink -- so "two placed, next one $100"
// is one glance rather than an inference.
//
// ===================================================================
//  DESIGN NOTE 1: THE ROW SITS ON THE CORPORATION'S OWN COLOUR
// ===================================================================
//
// The bar this renders into is painted with the corporation's brand colour
// (App.tsx design note #236), which creates a problem specific to this
// component: a token drawn in that same colour on that same background is
// invisible by construction.
//
// Two things fix it without giving up the brand link. The row sits in its
// own slightly darkened inset, so the tokens have a surface to read against;
// and each token carries a ring in the bar's own derived ink, which
// separates it from that surface whatever hue the corporation is.
//
// PLACED TOKENS DESATURATE RATHER THAN FADE. Alpha alone on a coloured bar
// makes a token look like the background rather than like a spent piece;
// a neutral grey fill reads as "used" against any hue.

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
  /* ==================================================================
   *  DESIGN NOTE 362: THE HOME TOKEN'S CAPTION IS ITS HEX, NOT ITS PRICE
   * ==================================================================
   *
   * REPORTED: the first station marker slot displays "$0", which is
   * unhelpful.
   *
   * It was accurate and useless in the same breath. Every other slot's
   * caption is a DECISION -- $40, then $100, the money the next placement
   * will cost -- and the home token has no decision attached: it is granted
   * free at float and goes on a hex printed on the board. So the one slot
   * that could not be priced was captioned with a price, and "$0" beside a
   * circle reads as "worth nothing" rather than "already yours".
   *
   * The hex label is the fact a player actually wants there. It answers
   * where the corporation starts, which is the question the home token
   * exists to represent, and on the Operating Round strip it is the only
   * place that answer appears at all.
   *
   * `null` falls back to the price. One core company (NNH) has no home hex
   * assigned on this board (`gameState.ts` on `home_hex_label`), and
   * inventing a label for it would be worse than the "$0" this replaces. */
  homeHexLabel?: string | null;
}

/** Neutral grey for a token already on the board -- design note #1. */
const PLACED_FILL = "#6b7280";

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
                ...(slot.isNext ? styles.tokenNext : {}),
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
  // A second, offset ring rather than a thicker border: thickening would eat
  // into a 16px circle until the fill -- the brand colour, which is the whole
  // identity -- stopped being visible.
  tokenNext: { boxShadow: "0 0 0 2px rgba(255,255,255,0.55)" },
  price: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    lineHeight: 1,
  },
  // Struck through, not just dimmed: a spent token's price is a historical
  // fact rather than an amount the player might still pay.
  pricePlaced: { textDecoration: "line-through", fontWeight: 400 },
  empty: { fontSize: FONT_SIZE.small, fontStyle: "italic" },
};
