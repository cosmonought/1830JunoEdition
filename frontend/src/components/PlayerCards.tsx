// frontend/src/components/PlayerCards.tsx
//
// THE PLAYERS, AS CARDS -- the Stock Round's half of the ledger's table.
//
// Design note #563: A TABLE SCANS, A CARD READS. Both exist, for a stated reason: the LEDGER asks "how does
// everyone compare", a ranking question answered by aligned figures read DOWN; the STOCK ROUND asks "what is
// this player holding, and what can they afford", a question about one person answered by a block read
// ACROSS. The card matches the corporation card deliberately -- a Stock Round is a screen of cards.
// Design note #563a: the private table is ABSENT, not empty. An empty table with headers is a promise of data
// that is not there. The holdings table is NOT treated the same way: a player with no shares has an empty
// list, which is a real and readable state.
// Design note #567: the heralds, the YOU badge and "PD" all came off -- three marks that looked like
// information and were not. The YOU badge survives only where two players share a display name, which is the
// sole case where the reader genuinely cannot tell. The crown moved RIGHT of the acronym, because on the left
// it pushed every ticker out of alignment by the width of a glyph most rows do not have.
//
// Design notes #583/#593/#595/#606/#609/#658: see `docs/ai_architecture/ui_shell_layout.md`.

import React, { useState } from "react";

import { FONT_SIZE } from "../styles/typography";
import { PresidentCrown } from "./PresidentCrown";
import { bestContrastTextColor } from "../styles/corporationLivery";
// Design note #670: the same badge the Operating Round's cash strip uses. The
// cards are where cash lives in a Stock Round, so this is where the confirmation
// has to appear there -- and one component means the two rounds cannot end up
// signalling the same event two different ways.
import { CashDeltaBadge } from "./PlayerCashStrip";
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
  /* Design note #593: THE CARDS STATE THE TURN ORDER, THEY DO NOT IMPLY IT. Relying on layout fails because the
     grid reflows -- six players wrap on any window narrower than ~1600px, and the moment it wraps the seat after
     the last card on row one is the FIRST card on row two. A reader would have to know the wrap point.
     ONLY WHERE SEATS TAKE TURNS: omitted during an Operating Round, where the queue names corporations and a
     seat ordinal would answer a question nobody is asking.
     Design note #606: `showSeatOrder` is GONE, and so is the flag's job. `activeAddress` already carries the
     same fact -- a round with no seat on turn passes `null`, every card compares unequal, and nothing is marked.
     Design note #568: the private's rules text, for the expandable rows. `null` renders the name as plain text. */
  privateDescription?: (privateId: number) => string | null;
  /** Design note #670: what this player's cash has just done, or `0`/absent for
   *  nothing recent. A FUNCTION rather than a map, so the card asks the same
   *  question the strip asks and neither has to know how the answer is stored. */
  cashDelta?: (address: string) => number;
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

/* Design note #606: THE LIFT NEEDS A TRANSITION, AND AN OFF SWITCH. The raise only reads as a CARD BEING
   PICKED UP if it takes time -- snapped instantly it is just a card drawn 10px higher, which a reader
   interprets as a layout bug before they interpret it as a state. The movement is the message.
   `transform` and `box-shadow` only, never `all`: the stripe's saturation is on a different element and wants
   no transition (a fading colour during a handover reads as loading), and `all` would sweep up every future
   property anyone adds to this card.
   REDUCED MOTION KEEPS THE ANSWER, LOSES THE MOVEMENT -- the card still sits raised with its ring and shadow,
   it simply arrives there. */
const PLAYER_CARD_MOTION_CSS = `
.app-player-card {
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.3, 1), box-shadow 180ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .app-player-card { transition: none; }
}
`;

export function PlayerCards({
  players,
  label,
  activeAddress,
  priorityAddress,
  viewerAddress,
  colorForSeat,
  privateDescription,
  cashDelta,
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
      {/* Design note #606: injected, not inline. `React.CSSProperties` cannot
          express `@media (prefers-reduced-motion)`, and a lift that cannot be
          switched off is the kind of motion this app turns off everywhere
          else (see `styles/animations.ts`). */}
      <style>{PLAYER_CARD_MOTION_CSS}</style>
      {players.map((player, seatIndex) => {
        const stripe = colorForSeat(seatIndex);
        const ink = bestContrastTextColor(stripe);
        const isActive = player.address === activeAddress;
        return (
          <section
            key={player.address}
            className="app-player-card"
            style={{
              ...styles.card,
              /* Design note #606: the ring is the SEAT's colour, computed
                 here because only this scope knows it. The 1px border moves
                 with it so the card has one edge colour, not two. */
              ...(isActive
                ? {
                    ...styles.cardActive,
                    borderColor: stripe,
                    boxShadow: `0 0 0 3px ${stripe}, 0 14px 26px rgba(0,0,0,0.45)`,
                  }
                : {}),
            }}
            /* Design note #606a: THE TURN STILL HAS TO BE SPOKEN. Deleting the "ON TURN" tag deletes it for screen
               readers too, and a lift, a ring and a saturation step are all invisible to one. Colour and elevation are
               never the sole carrier of a fact -- the label says it in words, and `aria-current` marks it in the one
               attribute assistive technology already looks for. */
            aria-current={isActive ? "true" : undefined}
            aria-label={
              isActive
                ? `${label(player.address)}'s assets — on turn`
                : `${label(player.address)}'s assets`
            }
          >
            {/* ---- Name stripe, and the Priority Deal marker in it ---- */}
            <header
              style={{
                ...styles.stripe,
                backgroundColor: stripe,
                color: ink,
                ...(isActive ? {} : styles.stripeIdle),
              }}
            >
              <span style={styles.stripeIdentity}>
                <span style={styles.stripeName}>{label(player.address)}</span>
              </span>
              <span style={styles.stripeMarks}>
                {player.address === viewerAddress &&
                  (nameCounts.get(label(player.address)) ?? 0) > 1 && (
                    <span style={styles.youTag}>YOU</span>
                  )}
                {player.address === priorityAddress && (
                  /* Design note #563: the Priority Deal lives in the stripe because it is a property of the SEAT rather than of
                     the portfolio -- it says who opens the next Stock Round, not what this player owns. Everything below the
                     stripe is holdings; this is not. */
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
                {/* Design note #609: THE SPACER ROW GOES. #583 put an empty header row here so the two tables' BODIES started
                   level. That worked, and bought it by opening the left column with a blank line -- so the card's top-left
                   corner, where a reader's eye lands first, was whitespace.
                   Levelling the LABEL with the first figure is the better trade: "Corp." and "%" are captions, not data, and
                   setting them against `Cash` starts both columns saying something on the same line. There was never a
                   row-for-row correspondence to preserve -- five fixed figures against a variable-length holdings list -- so
                   aligning the bodies was aligning two things that do not correspond. */}
                <tbody>
                  <tr>
                    <th scope="row" style={styles.figureKey}>Cash</th>
                    {/* Design note #670: the badge sits INSIDE the existing cell rather than in a column of its own.
                        A sixth row, or a third column, would relayout the card for a mark that is absent almost all
                        of the time -- and #609's point about this table is that its shape is already carrying
                        meaning. Appending to the value leaves every figure where it was. */}
                    <td style={styles.figureValue}>
                      {money(player.cash)}
                      <CashDeltaBadge amount={cashDelta?.(player.address) ?? 0} />
                    </td>
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
                    /* Design note #568: the NUMBER stays, on instruction -- "referring to Private Company 1 is easier than
                       remembering some of the names". #423 removed the numeric chips because a bare `3` names nothing away from
                       the auction's numbered list; a number IN FRONT OF the name is the opposite trade and costs two characters. */
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

/* Design note #658: ONE row metric, spread into every cell of both tables. The two tables aligning is not a
   coincidence to be re-established each time somebody edits one of them -- it is the point of the layout, so
   it is a value rather than a convention. Six style keys agreeing by hand is exactly the arrangement that
   drifts: the holdings header was missing the 2px the figures rows carried, and nothing could have reported
   that.
   `verticalAlign: "top"` rides along because the same intent explains it: a cell that centres its text
   re-introduces the reported symptom the moment any row is taller than its neighbour. */
export const TABLE_ROW_CELL: React.CSSProperties = {
  padding: "1px 0",
  verticalAlign: "top",
};

export const styles: Record<string, React.CSSProperties> = {
  /* Design note #563: the same reflow the corporation grid uses -- as many across as fit, never fewer than one.
     Design note #606: the lift needs somewhere to go. A card rising 10px out of a row with a 10px gap lands
     exactly on the edge of the row above, and its ring and shadow then overlap the card behind it -- which reads
     as collision rather than elevation.
     `rowGap` ONLY, not `gap`: the clearance wanted is vertical, and widening the columns to buy it would push a
     six-player grid to a second row sooner. `paddingTop` is the same clearance for the FIRST row, which has no
     row above it to borrow from. */
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    columnGap: "10px",
    rowGap: "22px",
    paddingTop: "12px",
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
  /* Design note #606: LIFTED OUT OF THE ROW, IN THE SEAT'S OWN COLOUR. The green was inherited, not chosen --
     it came from the roster pills, where green was the only colour available because pills had no seat identity
     of their own. These cards do: the stripe two pixels above the ring is the player's colour, and the bar's
     trail lights the acting seat in that same colour. So the green was a third colour system on a surface that
     already had one, asserting "on turn" in a hue that means "positive" everywhere else and nothing about WHO.
     THE LIFT IS A REAL LIFT: `-2px` was a nudge no reader would name, and `-10px` against a 10px gap clears
     roughly a card's own edge.
     THE SHADOW IS DOING HALF THE WORK -- a translate alone reads as a card that has drifted; a translate plus a
     deeper, softer shadow reads as one that has been picked up. The two are one `box-shadow` declaration and
     cannot be split, so both are cast at the call site with the ring. */
  cardActive: {
    transform: "translateY(-10px)",
    position: "relative",
    // Above its neighbours, so the shadow falls ON the cards beside it
    // rather than under them -- which is the cue that says "in front".
    zIndex: 1,
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
  /* Design note #595: on the stripe, where the seat is named -- "whose turn" is a fact about a PERSON.
     Design note #606: THE IDLE STRIPES STEP BACK. Instructed literally, and the literal reading is correct: this
     is on the STRIPE, not on the card. Everything below the stripe is what a player is comparing across seats
     while deciding a bid, and dimming a rival's balance to advertise that it is not their turn would trade a
     fact for a decoration.
     `saturate`, NOT `opacity`: opacity would wash the stripe toward the card's cream and pull the label's
     contrast down with it, while `saturate` leaves lightness and hue in place so the ink choice stays valid.
     0.55 IS THE WHOLE BRIEF -- "not to the point that they can't be distinguished". The seat colours are already
     mid-saturation, so this lands them near 25%: muted, but all six still read as themselves side by side. */
  stripeIdle: { filter: "saturate(0.55)" },
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
  /* Design note #583: the gap widened. The % column is fixed at three characters, so the holdings table needs
     far less width than an even split gives it.
     Design note #609: THE HOLDINGS COLUMN TAKES WHAT IT NEEDS. `0.85fr` claimed its share of the row whether or
     not it had anything to put there, so a 58/42 split gave the narrow column room it could not use and
     squeezed the wide one. `auto` sizes to content and hands the remainder to the figures, per card.
     Design note #658: A GRID ITEM STRETCHES, AND A TABLE OBEYS. Grid items default to `align-self: stretch` and
     the row is as tall as the FIGURES table -- so the holdings table was stretched to match, and an HTML table
     given more height than it needs does not sit at the top of it: it distributes the surplus across its own
     rows. Nothing was positioning them; they were being inflated. `alignItems: "start"` is the whole fix.
     WHY #611 DID NOT CATCH THIS: it aligned the two tables' HEADERS and was right about the markup -- the
     figures table has no `<thead>`, so its first row and the holdings header genuinely are both row one. The
     alignment it describes is real and never survived layout, because the note was reasoning about row ORDER
     while the defect was in row HEIGHT. */
  body: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: "18px",
    padding: "8px 10px",
    alignItems: "start",
  },
  figures: { borderCollapse: "collapse", width: "100%", fontVariantNumeric: "tabular-nums" },
  figureKey: {
    ...TABLE_ROW_CELL,
    textAlign: "left",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#5f636d",
    whiteSpace: "nowrap",
  },
  figureValue: {
    ...TABLE_ROW_CELL,
    textAlign: "right",
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    whiteSpace: "nowrap",
  },
  /* Design note #609: `auto`, not `100%`. A table told to fill 100% of an
     `auto` track measures itself against a width that is being derived from
     its own content, and settles wider than it needs -- the grid track and
     the table have to agree about who is deciding, and it is the content. */
  holdings: { borderCollapse: "collapse", width: "auto", fontVariantNumeric: "tabular-nums" },
  /* Design note #658: padding and `verticalAlign: "top"` matching the figures cells exactly. `alignItems:
     "start"` puts the two tables' first rows on the same line; these make those rows the same HEIGHT, which is
     what keeps `Corp.` level with `Cash` rather than merely adjacent to it. The padding was absent here and
     present there, so the figures rows were 2px taller and the columns drifted apart down the card -- small
     enough to read as sloppiness rather than as a bug, which is how it survived #611's pass. */
  /* Design note #680: THE COLUMN GAP, BORROWED FROM THE PRIVATES TABLE. Reported as `Corp.` and `%` being "too
     tight" and asked to sit at the same horizontal spaces as `Value` and `Income` below.
     They were tight for a specific reason: `TABLE_ROW_CELL` is `padding: "1px 0"` -- no horizontal padding at
     all -- because #658 made it ONE metric shared with the figures table, where the two columns are `Cash` and a
     right-aligned figure and need no separation. Inherited by the holdings table, that put `Corp.` and `%`
     directly against each other.
     THE PRIVATES TABLE'S RHYTHM IS 20px: its cells carry `3px 10px`, so `Value` and `Income` sit ten from each
     side of the boundary between them. Split the same way here -- ten off the right of `Corp.`, ten off the left
     of `%` -- and the two tables read with one spacing.
     THE RIGHT EDGE IS WHY THE PADDING IS ASYMMETRIC, and it is the part that would break if this were a plain
     `1px 10px`. `%` currently ends flush with the holdings table's right edge, which is the card's edge less the
     body's own 10px; `Income` ends ten inside the privates table, which runs the full card width. The two land
     on the SAME x today, and padding `%` on both sides would move it ten left of a column it is meant to line up
     with. So the right stays at zero.
     VERTICAL PADDING IS UNTOUCHED at 1px, which is the half of `TABLE_ROW_CELL` #658 actually cares about --
     that note is about row HEIGHT keeping `Corp.` level with `Cash`, and horizontal padding cannot affect it.
     Written as one four-value `padding` rather than spreading the shared metric and overriding a longhand:
     shorthand-then-longhand in a single inline style object is order-dependent, and this file has already been
     bitten once by a style that silently did nothing (#619). */
  holdingHead: {
    ...TABLE_ROW_CELL,
    padding: "1px 10px 1px 0",
    textAlign: "left",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#5f636d",
  },
  holdingHeadNum: {
    ...TABLE_ROW_CELL,
    padding: "1px 0 1px 10px",
    textAlign: "right",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#5f636d",
  },
  /* Design note #680: the body cells take the header's padding exactly. A header
     indented past its own column is the drift #658 was written to stop, in the
     one direction that note did not have to think about. */
  holdingName: {
    ...TABLE_ROW_CELL,
    padding: "1px 10px 1px 0",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  holdingCrown: { color: "#c9a94c", marginLeft: "4px" },
  holdingNum: {
    ...TABLE_ROW_CELL,
    padding: "1px 0 1px 10px",
    textAlign: "right",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
  },
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
