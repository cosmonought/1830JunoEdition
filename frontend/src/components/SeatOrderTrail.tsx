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
  /** This browser's seat, so "you" can be pointed out once. */
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
          const isViewer = seat.address === viewerAddress;
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
                        borderColor: seat.color,
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
                {/* The seat's colour, so the trail and the player card agree
                    about who is who without repeating the name twice. On the
                    CURRENT seat the colour has become the fill, so the dot
                    would be invisible against it. */}
                {!isCurrent && (
                  <span
                    style={{ ...styles.dot, backgroundColor: seat.color }}
                    aria-hidden="true"
                  />
                )}
                {seat.label}
                {isViewer && <span style={styles.you}>(you)</span>}
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
                {seat.address === priorityAddress && (
                  <span style={styles.priority} title="Opens the next Stock Round.">
                    PD
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
  root: { display: "flex", alignItems: "center", minWidth: 0 },
  strip: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "2px",
    margin: 0,
    padding: 0,
    listStyle: "none",
    minWidth: 0,
  },
  item: { display: "inline-flex", alignItems: "center", minWidth: 0 },
  chevron: { color: "#5a6070", padding: "0 4px", fontSize: FONT_SIZE.small },
  seat: {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    padding: "3px 9px",
    borderRadius: "999px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#2f3543",
    backgroundColor: "#1b1f29",
    color: "#8a919e",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  /* Design note #595: a seat that has acted is dimmer, not struck through.
     They are still in the round -- the auction can come back to them -- so
     "finished" would be a stronger claim than the game supports. */
  seatDone: { opacity: 0.55 },
  seatCurrent: { fontWeight: 800 },
  dot: { width: "7px", height: "7px", borderRadius: "50%", flex: "none" },
  you: { opacity: 0.7, fontWeight: 600 },
  cash: { fontWeight: 800, fontVariantNumeric: "tabular-nums" },
  escrow: { fontSize: FONT_SIZE.micro, opacity: 0.7, fontVariantNumeric: "tabular-nums" },
  priority: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 900,
    letterSpacing: "0.04em",
    opacity: 0.8,
  },
};
