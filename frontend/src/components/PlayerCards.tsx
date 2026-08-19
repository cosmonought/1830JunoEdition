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
//
// ==================================================================
//  DESIGN NOTE 567: WHAT CAME OFF THE CARD, AND WHY
// ==================================================================
//
// The first pass carried three marks that each looked like information and
// were not, and the playtest found all three:
//
//   THE HERALDS. A corporate logo beside a three-letter ticker identifies
//   nothing the ticker had not already identified, at 14px where the artwork
//   is a smudge. They earn their place on a corporation CARD, which is about
//   one company and has room to be about it.
//
//   THE "YOU" BADGE. Every player is reading their own screen; the card that
//   is theirs is the one they already know. It is worth drawing only when
//   two players share a display name, which is the sole case where the
//   reader genuinely cannot tell -- so that is exactly when it appears.
//
//   "PD". An abbreviation invented to fit a space that turned out not to be
//   tight. "Priority Deal" is two words and the stripe holds them.
//
// The crown moved to the RIGHT of the acronym for the same family of
// reason: on the left it pushed every ticker in the column out of alignment
// by the width of a glyph most rows do not have, so the one column that
// should scan cleanly was ragged in proportion to how many presidencies were
// on screen.

import React, { useState } from "react";

import { FONT_SIZE } from "../styles/typography";
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
  /** Design note #567: only used to disambiguate two identical display
   *  names -- otherwise a player knows which card is theirs. */
  viewerAddress: string | null;
  /** A player's own stripe colour. Distinct per seat. */
  colorForSeat: (index: number) => string;
  /* ==================================================================
   *  DESIGN NOTE 593: THE CARDS STATE THE TURN ORDER, THEY DO NOT IMPLY IT
   * ==================================================================
   *
   * INSTRUCTED: replace the Auction's Seating Order table with these cards --
   * "The only 'problem' is that the tables make it easy to see turn order,
   * whereas the cards are less direct about that. Is there a solution?"
   *
   * There is, and it is not "rely on the order they are laid out in". The
   * grid reflows -- six players wrap to a second row on any window narrower
   * than about 1600px -- and the moment it wraps, left-to-right stops meaning
   * anything and the seat after the last card on row one is the FIRST card on
   * row two. A reader would have to know the wrap point to read the order.
   *
   * So the position is written down. "1st", "2nd" in the stripe is true at
   * any width, survives the wrap, and answers the question the table answered
   * without needing the table's shape.
   *
   * ONLY WHERE SEATS TAKE TURNS. Omitted during an Operating Round, where the
   * queue names corporations and a seat ordinal would be answering a question
   * nobody is asking -- the same distinction `actingSeatIndex` draws. */
  showSeatOrder?: boolean;
  /** Design note #568: the private's rules text, for the expandable rows.
   *  `null` renders the name as plain text rather than a control. */
  privateDescription?: (privateId: number) => string | null;
}

/* Design note #569: the palette moved to `utils/playerLabels.ts`, beside the
   room registry that can override it. A component that owned the colours
   would have been the only place that knew them, and the action bar needs
   the same answer. */

/* Design note #595: the `ordinal` helper went with the ordinals it made.
   Turn order is a chevron trail now (`SeatOrderTrail`), which cannot be
   mistaken for a ranking. */

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
  colorForSeat,
  privateDescription,
  showSeatOrder = false,
}: PlayerCardsProps) {
  /* Design note #568: which private row is open, keyed by id. One map for
     the whole grid rather than state per card -- a player may want the
     Camden & Amboy's text open on two cards at once to compare, and nothing
     about the disclosure is per-player. */
  const [openPrivates, setOpenPrivates] = useState<Readonly<Record<number, boolean>>>({});
  const togglePrivate = (privateId: number) =>
    setOpenPrivates((prev) => ({ ...prev, [privateId]: !prev[privateId] }));

  if (players.length === 0) return null;

  /* Design note #567: the YOU badge earns its place only when a name is
     ambiguous. Computed once for the grid, because "is this name shared" is
     a question about the ROSTER and not about any one card. */
  const nameCounts = new Map<string, number>();
  for (const player of players) {
    const name = label(player.address);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

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
              <span style={styles.stripeIdentity}>
                {showSeatOrder && isActive && (
                  /* ==================================================
                       DESIGN NOTE 595: "ON TURN", NOT "1st"
                      ==================================================

                       REPORTED: the ordinals "may be confusing to players if
                       they think the Player cards are referencing final
                       score" -- which is a fair reading, because 1830 DOES
                       rank players and net worth is on the same card. "1st
                       Ada $2,400" invites exactly the wrong sentence.

                       Turn ORDER moved to `SeatOrderTrail`, where a chevron
                       says "queue" in a way no number can. What stays here is
                       the other half of the request -- emphasising whose turn
                       it is -- and it says so in words rather than in a
                       position that has to be decoded. */
                  <span style={styles.stripeOnTurn}>ON TURN</span>
                )}
                <span style={styles.stripeName}>{label(player.address)}</span>
              </span>
              <span style={styles.stripeMarks}>
                {player.address === viewerAddress &&
                  (nameCounts.get(label(player.address)) ?? 0) > 1 && (
                    <span style={styles.youTag}>YOU</span>
                  )}
                {player.address === priorityAddress && (
                  /* Design note #563: the Priority Deal lives in the stripe
                     because it is a property of the SEAT rather than of the
                     portfolio -- it says who opens the next Stock Round, not
                     what this player owns. Everything below the stripe is
                     holdings; this is not. */
                  <span
                    style={{ ...styles.priorityTag, color: ink, borderColor: ink }}
                    title="Starts the next Stock Round."
                  >
                    Priority Deal
                  </span>
                )}
              </span>
            </header>

            <div style={styles.body}>
              {/* ---- Left: the figures ---- */}
              <table style={styles.figures}>
                {/* ==================================================
                     DESIGN NOTE 583: THE TWO TABLES SHARE A TOP LINE
                    ==================================================

                     REPORTED: the Corp. and % headers read "off", floating
                     in the middle, because the right-hand table had a header
                     row and the left-hand one did not -- so five figure rows
                     were distributed against six, and nothing lined up.

                     An EMPTY header row rather than removing the right-hand
                     one: the % column needs its label (a bare `30` beside a
                     ticker could be a count, a price or a percentage), and
                     the left-hand rows label themselves. So the left table
                     gains a spacer whose only job is to start both bodies on
                     the same line. `aria-hidden` because it says nothing a
                     screen reader should hear. */}
                <thead aria-hidden="true">
                  <tr>
                    <th style={styles.figureHeadSpacer} />
                    <th style={styles.figureHeadSpacer} />
                  </tr>
                </thead>
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
                    <th style={styles.holdingHead}>Corp.</th>
                    <th style={styles.holdingHeadNum}>%</th>
                  </tr>
                </thead>
                <tbody>
                  {player.holdings.length === 0 ? (
                    <tr>
                      <td colSpan={2} style={styles.holdingEmpty}>
                        No shares yet.
                      </td>
                    </tr>
                  ) : (
                    player.holdings.map((holding) => (
                      <tr key={holding.companyId}>
                        {/* Design note #567: crown AFTER the acronym, so the
                            tickers stay left-aligned with each other. */}
                        <td style={styles.holdingName}>
                          {holding.ticker}
                          {holding.isPresident && (
                            <PresidentCrown scale={0.9} style={styles.holdingCrown} />
                          )}
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
                  {player.privates.map((entry) => {
                    const description = privateDescription?.(entry.privateId) ?? null;
                    const open = openPrivates[entry.privateId] === true;
                    /* Design note #568: the NUMBER stays, on instruction --
                       "referring to Private Company 1 is easier than
                       remembering some of the names". Design note #423
                       removed the numeric chips because a bare `3` names
                       nothing away from the auction's numbered list; a
                       number IN FRONT OF the name is the opposite trade and
                       costs two characters. */
                    const title = `${entry.privateId}. ${entry.name}`;
                    return (
                      <React.Fragment key={entry.privateId}>
                        <tr>
                          <td style={styles.privateName}>
                            {description ? (
                              <button
                                type="button"
                                style={styles.privateButton}
                                onClick={() => togglePrivate(entry.privateId)}
                                aria-expanded={open}
                                title={`${title} — what it does`}
                              >
                                <span style={styles.privateCaret} aria-hidden="true">
                                  {open ? "▾" : "▸"}
                                </span>
                                <span style={styles.privateLabel}>{title}</span>
                              </button>
                            ) : (
                              <span style={styles.privateLabel} title={title}>
                                {title}
                              </span>
                            )}
                          </td>
                          <td style={styles.privateNum}>${entry.value}</td>
                          <td style={styles.privateNum}>${entry.income}</td>
                        </tr>
                        {open && description && (
                          /* The auction's own text, from the one catalog both
                             screens read (design note #391) -- so a player
                             who learned what the D&H does while bidding on it
                             reads the same sentence here. */
                          <tr>
                            <td colSpan={3} style={styles.privateDescription}>
                              {description}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
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
  /* Design note #595: emphasised, not merely outlined. The previous ring was
     a 2px halo in the turn-green, which reads at a glance only if you already
     know to look for it -- and the report is that players could not tell whose
     turn it was from these cards. A lifted card with a heavier ring is
     findable peripherally, which is what "emphasise" has to mean on a grid of
     four to six identical objects. */
  cardActive: {
    borderColor: "#7ee0a1",
    boxShadow: "0 0 0 3px rgba(126,224,161,0.45), 0 6px 18px rgba(0,0,0,0.4)",
    transform: "translateY(-2px)",
  },
  stripe: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "6px 10px",
    minWidth: 0,
  },
  stripeIdentity: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "6px",
    minWidth: 0,
  },
  /* Design note #595: on the stripe, where the seat is named -- "whose turn"
     is a fact about a PERSON, and it was the one thing the cards could not
     say without the reader counting positions. */
  stripeOnTurn: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 900,
    letterSpacing: "0.06em",
    opacity: 0.85,
    flex: "none",
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
  /* Design note #583: the gap widened from 8px. The % column is fixed at
     three characters, so the right-hand table needs far less width than an
     even split gives it -- and the reported symptom was the Corp. column
     sitting "barely separated" from the figures on its left. The columns are
     no longer equal for the same reason: the left table carries five labelled
     figures and the right carries a three-character number. */
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 0.85fr)",
    columnGap: "18px",
    padding: "8px 10px",
  },
  figures: { borderCollapse: "collapse", width: "100%", fontVariantNumeric: "tabular-nums" },
  /* Design note #583: matches the right-hand header's line box exactly, so
     the two bodies start level. Sized off the same font token rather than a
     pixel guess -- a header height typed as `14px` would drift the moment
     the micro size changed. */
  figureHeadSpacer: { fontSize: FONT_SIZE.micro, fontWeight: 700, padding: 0 },
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
  holdingName: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  holdingCrown: { color: "#c9a94c", marginLeft: "4px" },
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
  /* Design note #568: the name column takes what is left after the two
     numeric columns, and ellipsises rather than wrapping -- "Camden &
     A..." was accepted explicitly, and a wrapped name would make the rows
     different heights for no gain. */
  privateName: { padding: "2px 10px", maxWidth: 0, width: "100%" },
  privateButton: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "4px",
    width: "100%",
    padding: 0,
    border: "none",
    background: "none",
    font: "inherit",
    color: "inherit",
    textAlign: "left",
    cursor: "pointer",
    minWidth: 0,
  },
  privateCaret: { fontSize: FONT_SIZE.micro, opacity: 0.6, flex: "none" },
  privateLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  privateDescription: {
    padding: "2px 10px 7px 22px",
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.45,
    color: "#4d515a",
  },
  privateNum: {
    textAlign: "right",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    padding: "2px 10px",
  },
};
