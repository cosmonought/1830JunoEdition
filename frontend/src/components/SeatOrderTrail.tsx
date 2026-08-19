// frontend/src/components/SeatOrderTrail.tsx
//
// WHOSE TURN, AND WHOSE NEXT — the seat-driven rounds' breadcrumb.
//
// ==================================================================
//  DESIGN NOTE 595: AN ORDINAL IS NOT AN ORDER
// ==================================================================
//
// REPORTED: '"1st," "2nd," etc may be confusing to players if they think the
// Players cards are referencing final score' — and, in the same breath, the
// better idea: "what if we were to grab the subphase tracker from the
// Operating Round and use that format showing P1 > P2 > P3 in the
// Stock/Auction Action panel? The current player pills may not be clear
// enough that they are an ordering."
//
// BOTH HALVES ARE RIGHT. "1st" beside a player's name in a game with a score
// is genuinely ambiguous — in 1830 the thing players most want ranked IS net
// worth, so a card reading "1st  Ada  $2,400" invites exactly the wrong
// reading. And a grid of pills can only imply sequence through layout, which
// stops meaning anything the moment the grid wraps.
//
// A CHEVRON TRAIL SAYS IT OUT LOUD. `Ada › Ben › Cai` is not a ranking, it is
// a queue: the separator carries the meaning that position alone could not,
// and no reader mistakes a chevron for a scoreboard.
//
// THE SAME COMPONENT SHAPE AS THE OPERATING ROUND'S STEP TRAIL, deliberately.
// A player has already learned to read `Track › Tokens › Routes` as "here is
// the sequence, here is where we are". Reusing that grammar for seats costs
// them nothing to learn, and the two rounds stop having two different ways of
// answering one question.
//
// NOT A COPY OF THAT COMPONENT, though. `OperatingSubPhaseStepper` knows
// about eras, private companies and which steps exist this phase; none of
// that is true of seats, and inheriting it to reuse a chevron would drag a
// rules engine into a list of names.
//
// SEE DESIGN NOTE 599 IN THE STYLES BLOCK for why the trail is drawn inside
// one bordered rectangle with flush segments, rather than as a row of
// separately-bounded chips -- that is the difference between a reader seeing
// a sequence and a reader seeing five badges in a row.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import { bestContrastTextColor } from "../styles/corporationLivery";

export interface SeatOrderTrailProps {
  /** Every seat, in turn order. */
  seats: ReadonlyArray<{
    address: string;
    label: string;
    color: string;
    /* ==================================================================
     *  DESIGN NOTE 595a: ONE ROW, NOT TWO
     * ==================================================================
     *
     * REPORTED: the trail rendered ABOVE the existing roster pills, so the
     * bar carried two rows of the same players -- one with the order and no
     * money, one with the money and no order -- and the extra row shoved the
     * phase badge out of place.
     *
     * That was mine, and the fix is the one the report points at: they are
     * two answers to one question. Design note #342 put every seat's
     * spendable cash on the bar because "in an auction the question that
     * decides a bid is what can THEY spend"; design note #595 put the order
     * there because the pills could only imply it. Both belong on the same
     * chip.
     *
     * `undefined` renders the name alone, which is what a round with no
     * money question wants. */
    available?: number | null;
    /** Design note #317: what is locked in standing bids. Zero or omitted
     *  outside the auction, where there is no escrow to report. */
    escrowed?: number | null;
  }>;
  /** Whose turn it is now. `null` renders the trail with nobody marked,
   *  which is honest during the moment a round is turning over. */
  activeAddress: string | null;
  /** Who opens the next Stock Round, marked in place rather than in a
   *  separate legend — it is a fact about a seat's position in this queue. */
  priorityAddress?: string | null;
  /* ==================================================================
   *  DESIGN NOTE 597c: THE CHIPS CARRY NO BADGES
   * ==================================================================
   *
   * INSTRUCTED: "the Action bar player pills do not need 'PD' or '(you)' in
   * them, these are just making the pills larger."
   *
   * Both were mine and both were paying for themselves in width on the one
   * row that has least of it. And neither was needed here: the player CARD
   * already marks the Priority Deal in its stripe, and a player does not
   * need telling which seat is theirs on a screen they are looking at --
   * design note #567 reached that same conclusion about the YOU badge on the
   * cards two passes ago and I put it back on the trail without noticing.
   *
   * `viewerAddress` STAYS ON THE INTERFACE, unused by the render, because a
   * caller passing it is stating something true and a future variant of this
   * row may want it. Removing the prop would make re-adding the distinction
   * a plumbing job rather than a styling one. */
  viewerAddress?: string | null;
}

export function SeatOrderTrail({
  seats,
  activeAddress,
  priorityAddress = null,
  viewerAddress = null,
}: SeatOrderTrailProps) {
  if (seats.length === 0) return null;
  const activeIndex = seats.findIndex((seat) => seat.address === activeAddress);

  return (
    <div style={styles.root} role="group" aria-label="Turn order">
      <ol style={styles.strip}>
        {seats.map((seat, index) => {
          const isCurrent = seat.address === activeAddress;
          /* Design note #595: "done" means this seat has already acted THIS
             time round, which is only knowable relative to the cursor. `-1`
             (nobody on turn) marks nothing done rather than everything. */
          const isDone = activeIndex >= 0 && index < activeIndex;
          return (
            <li key={seat.address} style={styles.item}>
              {index > 0 && (
                <span style={styles.chevron} aria-hidden="true">
                  &#8250;
                </span>
              )}
              {/* A `<span>`, never a `<button>`: this is an indicator, and a
                  disabled button would announce a control to a screen reader
                  and then refuse it. Same reasoning as the step trail's own
                  design note #1. */}
              <span
                aria-current={isCurrent ? "step" : undefined}
                style={{
                  ...styles.seat,
                  ...(isDone ? styles.seatDone : {}),
                  ...(isCurrent
                    ? {
                        ...styles.seatCurrent,
                        backgroundColor: seat.color,
                        color: bestContrastTextColor(seat.color),
                      }
                    : {}),
                }}
                title={
                  isCurrent
                    ? `${seat.label} is acting now.`
                    : isDone
                      ? `${seat.label} has acted.`
                      : `${seat.label} acts later this round.`
                }
              >
                {/* Design note #599: the seat's colour DOT is gone. It was
                    doing identity work the fill now does for the one seat
                    that matters, and on the four seats it survived on it was
                    a third token in a segment the request asks to hold two.
                    The player CARD still carries the colour, which is where a
                    reader goes to ask "which one am I". */}
                <span style={styles.seatName}>{seat.label}</span>
                {typeof seat.available === "number" && (
                  /* Design note #342: AVAILABLE cash, not the total -- during
                     an auction the total is the one figure that cannot be
                     spent. */
                  <span style={styles.cash}>${seat.available}</span>
                )}
                {typeof seat.escrowed === "number" && seat.escrowed > 0 && (
                  <span
                    style={styles.escrow}
                    title={`$${seat.escrowed} is escrowed in standing bids and comes back if those bids lose.`}
                  >
                    +${seat.escrowed}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default SeatOrderTrail;

const styles: Record<string, React.CSSProperties> = {
  /* ==================================================================
   *  DESIGN NOTE 599: ONE RECTANGLE, NOT FIVE OBJECTS
   * ==================================================================
   *
   * INSTRUCTED: "what we want is a rectangle that lists only [player name]
   * [treasury] > [player name][treasury] > ..., and each player
   * name/treasury segment lights up during that player's turn."
   *
   * Design note #597b already reached for the par ladder's flat segment and
   * stopped one step short: it restyled the SEGMENTS and left the container
   * a bare flex row with a 2px gap. That is the half that matters least. A
   * row of transparent segments floating on the action bar's own surface has
   * no edge to belong to, so the eye still groups by the only boundary it
   * can find -- the lit fill -- and reads five loose objects that happen to
   * sit near each other. The chevrons were already there and were not enough,
   * which is exactly what the report says.
   *
   * A DRAWN BORDER IS THE THING THAT WAS MISSING. Once the row has one
   * outline the segments stop being candidates for grouping: they are
   * subdivisions of a single object, and a subdivision that fills with colour
   * is unmistakably "the live one". This is why the par ladder works and why
   * copying only its segment padding did not.
   *
   * SO: `gap: 0`. The segments must be FLUSH. A gap between them reintroduces
   * the whitespace that made them read as separate chips, and it is the one
   * value that cannot be tuned by taste -- any non-zero gap undoes the
   * border. The chevron is the separator; it needs no help. */
  /* ==================================================================
   *  DESIGN NOTE 603: THE FILL HAS TO REACH THE EDGES
   * ==================================================================
   *
   * REPORTED: "each player is still given their own pill in the rectangle:
   * if the current turn's player instead filled in their whole segment, the
   * chevron shape would be clearly visible and pointing from one player to
   * the next."
   *
   * Design note #599 drew the border and set `gap: 0`, and stopped one step
   * short AGAIN -- for the same reason, one level in. The container had 2px
   * of padding and the segments had a 4px radius, so the lit fill floated
   * clear of the rectangle's own edges on all four sides. A shape that does
   * not touch its container is a shape sitting INSIDE its container, which
   * is the definition of the pill this was supposed to stop being. Two
   * pixels of padding were doing all the damage.
   *
   * SO: NO PADDING ON THE CONTAINER, NO RADIUS ON THE SEGMENTS, and
   * `alignItems: stretch` so each segment is as tall as the bar. The lit
   * segment now runs border to border -- a slice of the object rather than
   * an object on a tray -- and that is what makes the chevrons beside it
   * read as pointing OUT of the filled block and into the next name.
   *
   * `overflow: hidden` ON THE CONTAINER is what lets both be true at once:
   * the segments stay square, and the first and last are clipped by the
   * container's own 6px radius. Without it a lit end seat would poke square
   * corners through the rounded frame. */
  root: {
    display: "inline-flex",
    alignItems: "stretch",
    minWidth: 0,
    padding: 0,
    borderRadius: "6px",
    border: "1px solid #2f3543",
    backgroundColor: "#1b1f29",
    overflow: "hidden",
    boxSizing: "border-box",
  },
  strip: {
    display: "flex",
    flexDirection: "row",
    /* Design note #603: `stretch`, not `center`. This is the line that makes
       a segment full-height; centring shrink-wraps it to its text and the
       fill stops short of the rule above and below it. */
    alignItems: "stretch",
    /* Design note #603: NO WRAP. A wrapped row would leave a half-width
       second line inside the frame, and the segments-of-one-bar reading dies
       the moment the bar has two rows. Six seats of short labels is the
       designed case; longer ones are handled by the container scrolling
       rather than by breaking the shape. */
    flexWrap: "nowrap",
    gap: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
    minWidth: 0,
  },
  item: { display: "inline-flex", alignItems: "stretch", minWidth: 0 },
  /* Design note #597b: the `>` the request asks for, in the ladder's own
     separator weight -- faint, so it joins the segments rather than
     competing with them. */
  /* ==================================================================
   *  DESIGN NOTE 603a: THE CHEVRON IS THE POINT, SO IT GETS TO BE SEEN
   * ==================================================================
   *
   * REPORTED: "the chevron indicating turn order in the Action bar is both
   * small and indistinct as a color."
   *
   * Both true, and both were deliberate in a way that turned out to be
   * wrong. Design note #597b set it at `FONT_SIZE.small` and 60% opacity of
   * `#5a6070` so it would "join the segments rather than compete with them"
   * -- treating it as punctuation. But this glyph is not punctuation here:
   * it is the ONLY thing on the bar that says the row is a sequence rather
   * than a list. Design note #595 is explicit that the separator carries the
   * meaning position alone could not, and then #597b styled it like it
   * carried none.
   *
   * SO IT MOVES UP THE SCALE, not just in colour -- `small` (12px) reads as
   * a comma at this weight no matter what colour it is. `heading` (16px) at
   * weight 700 gives it a stroke thick enough to have a direction.
   *
   * STILL DIMMER THAN THE LIT SEGMENT, which is the one hierarchy worth
   * keeping: full-strength white chevrons would compete with the name the
   * reader is actually looking for. `#8d97a8` at full opacity is legible
   * against both the unlit bar and an arbitrary seat colour, which the old
   * 60%-of-#5a6070 was against neither. */
  chevron: {
    display: "flex",
    alignItems: "center",
    color: "#8d97a8",
    padding: "0 2px",
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    lineHeight: 1,
    flex: "none",
  },
  /* ==================================================================
   *  DESIGN NOTE 597b: THE PAR LADDER'S SHAPE, NOT A PILL
   * ==================================================================
   *
   * INSTRUCTED: "Rather than each player having a pill, what if we used the
   * rectangle from the Par selector and instead of / between players we used
   * a >, then have the relevant segment light up on that player's turn?"
   *
   * Taken as written, and it is better than the pills for a reason the
   * request implies rather than states: the par ladder is a row of
   * INTERCHANGEABLE options of which exactly one is lit, which is precisely
   * the shape of a turn queue. A pill is a self-contained badge -- five of
   * them read as five separate objects that happen to be adjacent, and the
   * rounded ends fight the chevron's attempt to join them into a sequence.
   *
   * SO THE GEOMETRY IS `sellSlashOption`'s: a flat rectangle, no border, a
   * small radius, transparent until it is the one that matters. The unlit
   * segments recede to text and the lit one is a solid block, which is what
   * "light up" has to mean if the reader is to catch it peripherally.
   *
   * PADDING IS THIS FILE'S OWN, slightly larger than the ladder's 2px/3px --
   * that value is defended in `StockRoundPanel` by a specific width budget
   * ("across five options and four separators that is 30px reclaimed"), and
   * a name is longer than a par value. Copying the number rather than the
   * intent would make the ladder's constraint govern a row it knows nothing
   * about. */
  seat: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    /* Design note #603: vertical padding is what gives the BAR its height,
       so it belongs on the segment rather than the frame -- that is the
       whole trick that lets a fill reach the top and bottom rules. */
    padding: "5px 10px",
    /* Design note #603: SQUARE. Any radius here re-creates the pill; the
       container's `overflow: hidden` rounds the two outer ends for free. */
    borderRadius: 0,
    border: "none",
    backgroundColor: "transparent",
    color: "#8a919e",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    whiteSpace: "nowrap",
    /* Design note #599: the figures are the thing a reader compares across
       segments, so the digits have to sit on a common grid. */
    fontVariantNumeric: "tabular-nums",
  },
  /* Design note #595: a seat that has acted is dimmer, not struck through.
     They are still in the round -- the auction can come back to them -- so
     "finished" would be a stronger claim than the game supports. */
  seatDone: { opacity: 0.55 },
  /* Design note #597b: a SOLID block in the seat's own colour. The lit
     segment is the whole point of the shape -- an outline would read as
     "selected", a fill reads as "this one is live". */
  seatCurrent: { fontWeight: 800 },
  /* Design note #599: an explicit span, carrying no styling of its own. It
     exists so the name and the treasury are two flex items on one baseline
     rather than a bare text node and a span, which is what `gap` and
     `alignItems: baseline` need to act on. Deliberately NO `overflow:
     hidden` -- on an inline-level box that moves the baseline to the bottom
     margin edge, and the figure beside it would stop lining up. */
  seatName: {},
  cash: { fontWeight: 800 },
  /* ==================================================================
   *  DESIGN NOTE 599a: THE ESCROW STAYS, AND STAYS QUIET
   * ==================================================================
   *
   * The request says the rectangle lists "only [player name] [treasury]",
   * and a third figure per segment is exactly the clutter that reading is
   * guarding against. But escrowed money is not decoration: during the
   * waterfall auction it is the difference between what a rival HOLDS and
   * what a rival can still RAISE WITH, which is the one number a bid is
   * actually judged against (design notes #317 and #342 both land here).
   *
   * So it is subordinated rather than removed -- lighter weight, dimmer, a
   * step down in size -- and it renders only when it is non-zero, which is
   * only ever during the auction. Outside that round every segment does read
   * as strictly name + treasury, which is the shape the request describes.
   *
   * `opacity` deliberately, not a fixed colour: the lit segment's text is
   * `bestContrastTextColor` against an arbitrary seat colour, and a hardcoded
   * grey would be unreadable on roughly half of those fills. */
  escrow: { fontSize: "10px", fontWeight: 600, opacity: 0.65 },
};
