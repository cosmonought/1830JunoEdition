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
   * nobody is asking -- the same distinction `actingSeatIndex` draws.
   *
   * ==================================================================
   *  DESIGN NOTE 606: `showSeatOrder` IS GONE, AND SO IS THE FLAG'S JOB
   * ==================================================================
   *
   * The ordinals became "ON TURN" (#595) and "ON TURN" has now become the
   * lift (#606 in the styles block), so the last thing this boolean gated no
   * longer exists. It is not replaced by another flag, because `activeAddress`
   * already carries the same fact: a round with no seat on turn passes `null`,
   * every card compares unequal, and nothing is marked. A second prop saying
   * "and mean it this time" was always redundant with that. */
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

/* ==================================================================
 *  DESIGN NOTE 606: THE LIFT NEEDS A TRANSITION, AND AN OFF SWITCH
 * ==================================================================
 *
 * The raise only reads as a CARD BEING PICKED UP if it takes time. Snapped
 * instantly it is just a card drawn 10px higher than its neighbours, which
 * a reader interprets as a layout bug before they interpret it as a state.
 * The movement is the message.
 *
 * `transform` and `box-shadow` only -- never `all`. The stripe's saturation
 * is on a different element and wants no transition (a fading colour during
 * a turn handover reads as loading, not as handover), and `all` would sweep
 * up every future property anyone adds to this card.
 *
 * REDUCED MOTION KEEPS THE ANSWER, LOSES THE MOVEMENT: the card still sits
 * raised with its ring and its shadow, it simply arrives there. Same bargain
 * every animation in `styles/animations.ts` makes -- switching motion off
 * must never cost the reader the fact the motion was carrying. */
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
            /* ==================================================
                 DESIGN NOTE 606a: THE TURN STILL HAS TO BE SPOKEN
                ==================================================

                 Deleting the "ON TURN" tag deletes it for screen readers
                 too, and a lift, a ring and a saturation step are all
                 invisible to one. Colour and elevation are never the sole
                 carrier of a fact -- the label says it in words, and
                 `aria-current` marks it in the one attribute assistive
                 technology already looks for on "which of these is the
                 current item". */
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
                     DESIGN NOTE 609: THE SPACER ROW GOES
                    ==================================================

                     INSTRUCTED: "can we fix the header line for 'Corp' and
                     '%' at the same row as the 'Cash' row? This would keep
                     the cards visually balanced."

                     Design note #583 put an empty header row here so the two
                     tables' BODIES started level. That worked, and bought it
                     by opening the left column with a blank line -- so the
                     card's top-left corner, where a reader's eye lands
                     first, was whitespace, and the first thing either column
                     actually said sat one row down.

                     Levelling the LABEL with the first figure is the better
                     trade. "Corp." and "%" are captions, not data; setting
                     them against `Cash` starts both columns saying something
                     on the same line, and the holdings rows below simply run
                     against the figures rather than being registered to
                     them. There was never a row-for-row correspondence to
                     preserve -- five fixed figures against a variable-length
                     holdings list -- so aligning the bodies was aligning two
                     things that do not correspond. */}
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

/* Design note #658: ONE row metric, spread into every cell of both tables.
 *
 * The two tables aligning is not a coincidence to be re-established each time
 * somebody edits one of them -- it is the point of the layout, so it is a
 * value rather than a convention. Six style keys agreeing by hand is exactly
 * the arrangement that drifts: `holdingHead` was missing the 2px the figures
 * rows carried, and nothing could have reported that.
 *
 * `verticalAlign: "top"` rides along because the same intent explains it. A
 * cell that centres its text re-introduces the reported symptom the moment
 * any row is taller than its neighbour -- a wrapped ticker, a crown glyph --
 * and top-aligned cells simply cannot. */
export const TABLE_ROW_CELL: React.CSSProperties = {
  padding: "1px 0",
  verticalAlign: "top",
};

export const styles: Record<string, React.CSSProperties> = {
  /* Design note #563: the same reflow the corporation grid uses -- as many
     across as fit, never fewer than one, so six seats on a narrow window
     stack rather than clipping. */
  /* Design note #606: the lift needs somewhere to go. A card rising 10px out
     of a row with a 10px gap lands exactly on the edge of the row above, and
     its ring and shadow then overlap the card behind it -- which reads as
     collision rather than elevation.

     `rowGap` ONLY, not `gap`: the clearance wanted is vertical, and widening
     the columns to buy it would push a six-player grid to a second row
     sooner on the narrow windows this layout already wraps on.

     `paddingTop` is the same clearance for the FIRST row, which has no row
     above it to borrow from -- without it the top card lifts into the
     "Players" heading. */
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
  /* ==================================================================
   *  DESIGN NOTE 606: LIFTED OUT OF THE ROW, IN THE SEAT'S OWN COLOUR
   * ==================================================================
   *
   * INSTRUCTED: "rather than an 'on turn' tag on the current player card,
   * would it make more sense to desaturate the inactive player's cards and
   * to slightly 'lift'/raise the active player's card during their turn?" --
   * and, on the ring: "the green border is maybe a little weird because it
   * doesn't coordinate to the player color or anything else."
   *
   * THE GREEN WAS INHERITED, NOT CHOSEN. It came from the roster pills, where
   * green was the only colour available because pills had no seat identity of
   * their own. These cards do: the stripe two pixels above the ring is the
   * player's colour, and the action bar's trail lights the acting seat in
   * that same colour. So the green was a third colour system on a surface
   * that already had one, asserting "on turn" in a hue that means "positive"
   * everywhere else in this app and nothing about WHO.
   *
   * THE RING IS THE SEAT'S COLOUR NOW, set per card at the call site. Card
   * and trail mark the same seat the same way, which is the coordination the
   * report is asking for.
   *
   * THE LIFT IS A REAL LIFT. `-2px` was a nudge that no reader would name;
   * the request describes the card-game gesture, where a chosen card rises
   * clear of the row. `-10px` against a 10px grid gap clears roughly a card's
   * own edge, which is enough for the shadow to open up underneath and read
   * as elevation rather than as misalignment.
   *
   * THE SHADOW IS DOING HALF THE WORK. A translate alone reads as a card that
   * has drifted; a translate plus a deeper, softer shadow reads as one that
   * has been picked up. `0 14px 26px` is cast at the call site with the ring,
   * because the two are one `box-shadow` declaration and cannot be split. */
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
  /* Design note #595: on the stripe, where the seat is named -- "whose turn"
     is a fact about a PERSON, and it was the one thing the cards could not
     say without the reader counting positions. */
  /* ==================================================================
   *  DESIGN NOTE 606: THE IDLE STRIPES STEP BACK
   * ==================================================================
   *
   * INSTRUCTED: "just to desaturate the color stripes, not to the point that
   * they can't be distinguished, just enough to show they're inactive."
   *
   * Taken literally, and the literal reading is the correct one: this is on
   * the STRIPE, not on the card. Everything below the stripe -- cash,
   * certificate count, holdings, private companies -- is what a player is
   * comparing across seats while deciding a bid, and dimming a rival's
   * balance to advertise that it is not their turn would trade a fact for a
   * decoration.
   *
   * `saturate`, NOT `opacity`. Opacity would wash the stripe toward the
   * card's cream and pull the label's contrast down with it; `saturate`
   * leaves lightness and hue in place and only drains the intensity, so
   * `bestContrastTextColor`'s black-or-white choice stays valid.
   *
   * 0.55 IS THE WHOLE BRIEF: "not to the point that they can't be
   * distinguished". `SEAT_COLORS` are already mid-saturation (roughly 45%),
   * so this lands them near 25% -- muted, but slate blue, brick, moss, plum,
   * ochre and teal all still read as themselves side by side. It is the one
   * number to move if the effect is too strong or too weak, and moving it
   * far in either direction breaks a different half of the request. */
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
  /* Design note #583: the gap widened from 8px. The % column is fixed at
     three characters, so the right-hand table needs far less width than an
     even split gives it -- and the reported symptom was the Corp. column
     sitting "barely separated" from the figures on its left. The columns are
     no longer equal for the same reason: the left table carries five labelled
     figures and the right carries a three-character number. */
  /* ==================================================================
   *  DESIGN NOTE 609: THE HOLDINGS COLUMN TAKES WHAT IT NEEDS
   * ==================================================================
   *
   * REPORTED: "it seems like the 'Corp %' column is stretching to take up
   * the same space as the left column next to it. This is unnecessary."
   *
   * It was, and `0.85fr` is why -- a fractional track claims its share of the
   * row whether or not it has anything to put there. The holdings table's
   * content is a four-character ticker and a two-digit percentage; the
   * figures table has "Net Worth" and "Liquidity" against six-figure sums.
   * Splitting the card 58/42 gave the narrow column room it could not use
   * and squeezed the wide one, which is what makes the right side read as
   * padded-out empty space.
   *
   * `auto` SIZES TO CONTENT and hands the remainder to the figures. The card
   * then divides itself by what is actually in it, and does so per card --
   * a player holding one corporation is not held to the width of a player
   * holding five. */
  /* ==================================================================
   *  DESIGN NOTE 658: A GRID ITEM STRETCHES, AND A TABLE OBEYS
   * ==================================================================
   *
   * REPORTED: "the two double-column tables 'start' at different heights ...
   * P1's 'Corp' label sits in a row between 'Cash' and 'Net worth,' while
   * PRR and C&O seem to be widely spaced apart to fill up the size of the
   * table."
   *
   * Both halves of that are one line of CSS. `body` is a grid, grid items
   * default to `align-self: stretch`, and the row is as tall as the FIGURES
   * table -- five labelled rows. The holdings table is stretched to match,
   * and an HTML table given more height than it needs does not sit at the
   * top of it: it distributes the surplus across its own rows. With a header
   * and two holdings that is three tall rows, each with its text centred --
   * so `Corp.` sinks to somewhere between `Cash` and `Net Worth`, and PRR and
   * C&O drift apart. Nothing was positioning them; they were being inflated.
   *
   * `alignItems: "start"` is the whole fix. Each table takes its natural
   * height, both begin on the same line, and rows pack upward because that is
   * what rows do when nothing is stretching them.
   *
   * WHY DESIGN NOTE #611 DID NOT CATCH THIS. That note aligned the two
   * tables' HEADERS -- "setting them against `Cash` starts both columns
   * saying something on the same line" -- and it was right about the markup:
   * the figures table has no `<thead>`, so its first row and the holdings
   * header genuinely are both row one. The alignment it describes is real and
   * is what the DOM says. It just never survived layout, because the note was
   * reasoning about row ORDER while the defect was in row HEIGHT. Two
   * elements can be in the same row of the same grid and still not appear on
   * the same line. */
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
  /* Design note #658: `padding: "1px 0"` and `verticalAlign: "top"`, matching
     `figureKey`/`figureValue` exactly. `alignItems: "start"` above puts the
     two tables' first rows on the same line; these make those rows the same
     HEIGHT, which is what keeps `Corp.` level with `Cash` rather than merely
     adjacent to it. The padding was absent here and present there, so the
     figures rows were 2px taller and the two columns drifted apart down the
     card -- small enough to read as sloppiness rather than as a bug, which is
     how it survived design note #611's pass. */
  holdingHead: {
    ...TABLE_ROW_CELL,
    textAlign: "left",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#5f636d",
  },
  holdingHeadNum: {
    ...TABLE_ROW_CELL,
    textAlign: "right",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: "#5f636d",
  },
  holdingName: {
    ...TABLE_ROW_CELL,
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  holdingCrown: { color: "#c9a94c", marginLeft: "4px" },
  holdingNum: {
    ...TABLE_ROW_CELL,
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
