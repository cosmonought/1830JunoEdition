// frontend/src/components/PlayerCards.tsx
//
// THE PLAYERS, AS CARDS -- the Stock Round's half of the ledger's table.
//
// ==================================================================
//  DESIGN NOTE 563: A TABLE SCANS, A CARD READS
// ==================================================================
//
// INSTRUCTED: "while I love the table/spreadsheet in Game Ledger for Player
// Assets, I wonder if in the Stock Round it would be better to create
// tiles/cards like we did for the corporations but for players instead."
//
// Both, and for a stated reason rather than as a compromise. The two screens
// ask different questions of the same data:
//
//   THE LEDGER asks "how does everyone compare" -- a ranking question,
//   answered by a column of aligned figures you read DOWN. A table is the
//   right shape and the existing one stays untouched.
//
//   THE STOCK ROUND asks "what is this player holding, and what can they
//   afford" -- a question about one person at a time, answered by a block
//   you read ACROSS. Their corporations, their privates and their spending
//   power belong together, and a table splits them across columns that
//   cannot show a per-corporation breakdown at all.
//
// SO THE CARD MATCHES THE CORPORATION CARD deliberately -- same livery
// stripe, same two-column figure tables, same private-company table at the
// foot. A Stock Round is a screen of cards, and a player card that looked
// like a different kind of object would read as a different kind of thing.
//
// ==================================================================
//  DESIGN NOTE 563a: THE PRIVATE TABLE IS ABSENT, NOT EMPTY
// ==================================================================
//
// Instructed explicitly ("this last table does not need to display if they
// have no private companies") and worth keeping as a rule: an empty table
// with headers is a promise of data that is not there, and four of them on
// one screen is most of the screen saying nothing. A card with no private
// section is shorter, which is itself the information.
//
// The same is NOT done for the holdings table, and the difference is the
// point: every player has cash and certificates, so a player with no shares
// has an empty holdings list which is a real and readable state ("bought
// nothing yet"). Owning no privates after the auction is equally real, but
// the auction is over by then and the table has no further story to tell.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import { CorporateLogo } from "./CorporateLogo";
import { PresidentCrown } from "./PresidentCrown";
import { bestContrastTextColor } from "../styles/corporationLivery";
import type { PlayerFinances } from "../utils/playerFinance";

export interface PlayerCardsProps {
  /** In seating order. */
  players: readonly PlayerFinances[];
  label: (address: string) => string;
  /** Whose turn it is. `null` outside a seat-driven round. */
  activeAddress: string | null;
  /** Who holds the Priority Deal, and so opens the next Stock Round. */
  priorityAddress: string | null;
  /** This browser's own seat, for the YOU marker. */
  viewerAddress: string | null;
  /** The corporation's livery, for the herald column. */
  colorForCompany: (companyId: number) => string;
  /** A player's own stripe colour. Distinct per seat. */
  colorForSeat: (index: number) => string;
}

/** Design note #563: the seat palette. Deliberately NOT the corporation
 *  liveries -- a player stripe in the PRR's red would read as a claim about
 *  the PRR. Six, because 1830 seats six, and spaced around the hue circle so
 *  adjacent seats never look alike. */
export const SEAT_STRIPE_COLORS = [
  "#3f6fa8",
  "#a8593f",
  "#4f8a5c",
  "#7a5aa8",
  "#a88a3f",
  "#3f8a94",
] as const;

export function seatStripeColor(index: number): string {
  return SEAT_STRIPE_COLORS[index % SEAT_STRIPE_COLORS.length];
}

function money(value: number | null): string {
  /* Design note #562: an em dash, never "$0". A missing figure and a figure
     that is genuinely zero are different facts about a player's position,
     and only one of them means they are broke. */
  return value === null ? "—" : `$${Math.round(value)}`;
}

export function PlayerCards({
  players,
  label,
  activeAddress,
  priorityAddress,
  viewerAddress,
  colorForCompany,
  colorForSeat,
}: PlayerCardsProps) {
  if (players.length === 0) return null;

  return (
    <div style={styles.grid}>
      {players.map((player, seatIndex) => {
        const stripe = colorForSeat(seatIndex);
        const ink = bestContrastTextColor(stripe);
        const isActive = player.address === activeAddress;
        return (
          <section
            key={player.address}
            style={{ ...styles.card, ...(isActive ? styles.cardActive : {}) }}
            aria-label={`${label(player.address)}'s assets`}
          >
            {/* ---- Name stripe, and the Priority Deal marker in it ---- */}
            <header style={{ ...styles.stripe, backgroundColor: stripe, color: ink }}>
              <span style={styles.stripeName}>{label(player.address)}</span>
              <span style={styles.stripeMarks}>
                {player.address === viewerAddress && <span style={styles.youTag}>YOU</span>}
                {player.address === priorityAddress && (
                  /* Design note #563: the Priority Deal lives in the stripe
                     because it is a property of the SEAT rather than of the
                     portfolio -- it says who opens the next Stock Round, not
                     what this player owns. Everything below the stripe is
                     holdings; this is not. */
                  <span
                    style={{ ...styles.priorityTag, color: ink, borderColor: ink }}
                    title="Priority Deal: starts the next Stock Round."
                  >
                    PD
                  </span>
                )}
              </span>
            </header>

            <div style={styles.body}>
              {/* ---- Left: the figures ---- */}
              <table style={styles.figures}>
                <tbody>
                  <tr>
                    <th scope="row" style={styles.figureKey}>Cash</th>
                    <td style={styles.figureValue}>{money(player.cash)}</td>
                  </tr>
                  <tr>
                    <th scope="row" style={styles.figureKey}>Net Worth</th>
                    <td style={styles.figureValue} title="Cash plus every share at its market price.">
                      {money(player.netWorth)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" style={styles.figureKey}>Liquidity</th>
                    <td
                      style={styles.figureValue}
                      /* Design note #562a: the gap between this and Net Worth
                         is what the card exists to show. */
                      title="Cash plus only the shares that could legally be sold right now — a president's block cannot be sold unless another player already holds 20%."
                    >
                      {money(player.liquidity)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" style={styles.figureKey}>Certs</th>
                    <td style={styles.figureValue}>
                      {player.certificateLimit === null
                        ? player.certificates
                        : `${player.certificates} / ${player.certificateLimit}`}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" style={styles.figureKey}>Shares</th>
                    <td style={styles.figureValue}>{player.shares}</td>
                  </tr>
                </tbody>
              </table>

              {/* ---- Right: what they hold, corporation by corporation ---- */}
              <table style={styles.holdings}>
                <thead>
                  <tr>
                    <th style={styles.holdingHeadIcon} aria-label="Herald" />
                    <th style={styles.holdingHead}>Co.</th>
                    <th style={styles.holdingHeadNum}>%</th>
                  </tr>
                </thead>
                <tbody>
                  {player.holdings.length === 0 ? (
                    <tr>
                      <td colSpan={3} style={styles.holdingEmpty}>
                        No shares yet.
                      </td>
                    </tr>
                  ) : (
                    player.holdings.map((holding) => (
                      <tr key={holding.companyId}>
                        <td style={styles.holdingIcon}>
                          <CorporateLogo
                            ticker={holding.ticker}
                            size={14}
                            color={colorForCompany(holding.companyId)}
                          />
                        </td>
                        <td style={styles.holdingName}>
                          {holding.isPresident && (
                            <PresidentCrown scale={0.9} style={styles.holdingCrown} />
                          )}
                          {holding.ticker}
                        </td>
                        <td style={styles.holdingNum}>{holding.percentage}%</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* ---- Privates, only when there are some (design note #563a) ---- */}
            {player.privates.length > 0 && (
              <table style={styles.privates}>
                <thead>
                  <tr>
                    <th style={styles.privateHead}>Private Company</th>
                    <th style={styles.privateHeadNum}>Value</th>
                    <th style={styles.privateHeadNum}>Income</th>
                  </tr>
                </thead>
                <tbody>
                  {player.privates.map((entry) => (
                    <tr key={entry.privateId}>
                      <td style={styles.privateName} title={entry.name}>
                        {entry.acronym ?? entry.name}
                      </td>
                      <td style={styles.privateNum}>${entry.value}</td>
                      <td style={styles.privateNum}>${entry.income}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}

export default PlayerCards;

const styles: Record<string, React.CSSProperties> = {
  /* Design note #563: the same reflow the corporation grid uses -- as many
     across as fit, never fewer than one, so six seats on a narrow window
     stack rather than clipping. */
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: "10px",
    alignItems: "start",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "9px",
    border: "1px solid #2b3242",
    backgroundColor: "#f4f1e8",
    color: "#23252b",
    overflow: "hidden",
  },
  /* The seat on turn, marked the same way the roster pills are -- green,
     which means exactly this everywhere else in the app. */
  cardActive: { borderColor: "#3f7a55", boxShadow: "0 0 0 2px rgba(63,122,85,0.35)" },
  stripe: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "6px 10px",
    minWidth: 0,
  },
  stripeName: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    letterSpacing: "0.2px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  stripeMarks: { display: "inline-flex", alignItems: "center", gap: "6px", flex: "none" },
  youTag: { fontSize: FONT_SIZE.micro, fontWeight: 800, opacity: 0.85 },
  priorityTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 900,
    letterSpacing: "0.5px",
    padding: "1px 5px",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
  },
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    gap: "8px",
    padding: "8px 10px",
  },
  figures: { borderCollapse: "collapse", width: "100%", fontVariantNumeric: "tabular-nums" },
  figureKey: {
    textAlign: "left",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#5f636d",
    padding: "1px 0",
    whiteSpace: "nowrap",
  },
  figureValue: {
    textAlign: "right",
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    padding: "1px 0",
    whiteSpace: "nowrap",
  },
  holdings: { borderCollapse: "collapse", width: "100%", fontVariantNumeric: "tabular-nums" },
  holdingHeadIcon: { width: "18px" },
  holdingHead: {
    textAlign: "left",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#5f636d",
  },
  holdingHeadNum: {
    textAlign: "right",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#5f636d",
  },
  holdingIcon: { width: "18px", lineHeight: 0 },
  holdingName: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  holdingCrown: { color: "#c9a94c", marginRight: "3px" },
  holdingNum: { textAlign: "right", fontSize: FONT_SIZE.micro, fontWeight: 800 },
  holdingEmpty: { fontSize: FONT_SIZE.micro, color: "#8a8f99", fontStyle: "italic" },
  privates: {
    borderCollapse: "collapse",
    width: "100%",
    borderTop: "1px solid #ddd7c8",
    fontVariantNumeric: "tabular-nums",
  },
  privateHead: {
    textAlign: "left",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#5f636d",
    padding: "3px 10px",
  },
  privateHeadNum: {
    textAlign: "right",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#5f636d",
    padding: "3px 10px",
  },
  privateName: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "2px 10px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  privateNum: {
    textAlign: "right",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    padding: "2px 10px",
  },
};
