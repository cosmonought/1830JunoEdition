// frontend/src/components/SeatOrderTrail.tsx
//
// WHOSE TURN, AND WHOSE NEXT -- the seat-driven rounds' breadcrumb.
//
// Design note #595: AN ORDINAL IS NOT AN ORDER. "1st" beside a player's name in a game with a score is
// genuinely ambiguous -- in 1830 the thing players most want ranked IS net worth -- and a grid of pills can
// only imply sequence through layout, which stops meaning anything the moment the grid wraps.
// A CHEVRON TRAIL SAYS IT OUT LOUD: `Ada > Ben > Cai` is not a ranking, it is a queue. The separator carries
// the meaning position alone could not, and no reader mistakes a chevron for a scoreboard.
//
// THE SAME COMPONENT SHAPE AS THE OPERATING ROUND'S STEP TRAIL, deliberately -- a player has already learned
// to read `Track > Tokens > Routes` as a sequence, so reusing that grammar costs them nothing to learn.
// NOT A COPY OF THAT COMPONENT, though: it knows about eras, private companies and which steps exist this
// phase, and inheriting it to reuse a chevron would drag a rules engine into a list of names.
//
// Design notes #597b/#597c/#599/#603/#603a/#610/#639: see `docs/ai_architecture/ui_shell_layout.md`.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import { bestContrastTextColor } from "../styles/corporationLivery";

export interface SeatOrderTrailProps {
  /** Every seat, in turn order. */
  seats: ReadonlyArray<{
    address: string;
    label: string;
    color: string;
    /* Design note #639: RIVALS' MONEY HERE, YOURS ON YOUR CARD. Taking the figures off entirely (#637) was the
       correct answer to a duplication problem -- the acting seat's cash appeared on the trail AND on the card
       beneath it -- but it also took away every OTHER seat's, which was never duplicated anywhere on the sticky
       bar. #342's rule survives after all: in an auction the question that decides a bid is what can THEY spend.
       SO THE FIGURE IS SUPPRESSED ON EXACTLY ONE SEGMENT -- the lit one. The card below states it in full,
       labelled, with escrow spelled out; the trail would repeat it two inches away in the compressed form that
       caused the "+$200 looks like earnings" reading in the first place.
       IT ALSO KEEPS SIX SEATS FITTING: dropping ~35px from the busiest segment is width bought back where the row
       needs it. ESCROW RIDES WITH IT and is likewise inactive-only -- it is the number that decides whether a
       rival can still raise. */
    available?: number | null;
    /** Design note #317: what is locked in standing bids. Zero or omitted
     *  outside the auction, where there is no escrow to report. */
    escrowed?: number | null;
    /* Design note #610: THIS SEAT HAS PASSED SINCE ANYONE LAST ACTED. The worry raised alongside the request was
       that players might read it as a permanent pass; the mitigation is structural rather than a rule this
       component enforces -- the passed set derives from `consecutive_passes`, which the reducer zeroes the instant
       anybody buys or sells. So the stamps cannot outlive the round of passing that produced them, and no timer,
       no local state and no cleanup pass is involved.
       WHAT IT COSTS IS ONE READING, AND IT IS WORTH IT: "PASSED" beside four names is a picture of how far round
       the table the passing has got -- which is what the auction header's "3 consecutive pass(es) so far" was
       trying to say in prose, against a roster the reader then had to map it onto themselves. */
    passed?: boolean;
  }>;
  /** Whose turn it is now. `null` renders the trail with nobody marked,
   *  which is honest during the moment a round is turning over. */
  activeAddress: string | null;
  /** Who opens the next Stock Round, marked in place rather than in a
   *  separate legend — it is a fact about a seat's position in this queue. */
  priorityAddress?: string | null;
  /* Design note #597c: THE CHIPS CARRY NO BADGES. Both "PD" and "(you)" were paying for themselves in width on
     the one row that has least of it, and neither was needed: the player CARD already marks the Priority Deal in
     its stripe, and a player does not need telling which seat is theirs on a screen they are looking at -- #567
     reached that conclusion about the YOU badge two passes ago and I put it back on the trail without noticing.
     `viewerAddress` STAYS ON THE INTERFACE, unused by the render, because a caller passing it is stating
     something true -- removing the prop would make re-adding the distinction a plumbing job rather than a styling
     one. */
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
                    : seat.passed
                      ? /* Design note #610: the tooltip carries the
                           reassurance the stamp is too small to give. "Passed
                           this time round" is the whole distinction a new
                           player might otherwise get wrong -- and it says
                           what un-does it, so nobody has to discover that by
                           waiting. */
                        `${seat.label} passed this time round. They act again on their next turn, and the mark clears as soon as anyone buys or sells.`
                      : isDone
                        ? `${seat.label} has acted.`
                        : `${seat.label} acts later this round.`
                }
              >
                {/* Design note #599: the seat's colour DOT is gone. It was doing identity work the fill now does for the one
                   seat that matters, and on the four seats it survived on it was a third token in a segment the request asks
                   to hold two. The player CARD still carries the colour, which is where a reader goes to ask "which one am I". */}
                <span
                  style={{
                    ...styles.seatName,
                    /* Design note #610: struck through, so the stamp is legible even at a glance too quick to read the tag -- and
                       so the two cues agree. A strike alone would be ambiguous (eliminated? bankrupt?); the tag alone is four
                       small capitals in a crowded row. */
                    ...(seat.passed && !isCurrent ? styles.seatNamePassed : {}),
                  }}
                >
                  {seat.label}
                </span>
                {seat.passed && !isCurrent && (
                  <span style={styles.passedTag}>PASSED</span>
                )}
                {/* Design note #639: the acting seat's own money is on the
                    card below, labelled. Repeating it here compressed is the
                    duplication #637 removed. */}
                {!isCurrent && typeof seat.available === "number" && (
                  /* Design note #342: AVAILABLE cash, not the total -- during
                     an auction the total is the one figure that cannot be
                     spent. */
                  <span style={styles.cash}>${seat.available}</span>
                )}
                {!isCurrent && typeof seat.escrowed === "number" && seat.escrowed > 0 && (
                  <span
                    style={styles.escrow}
                    title={`$${seat.escrowed} of ${seat.label}'s money is committed to standing bids. It is not spendable now, and it comes back if those bids lose.`}
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
  /* Design note #599: ONE RECTANGLE, NOT FIVE OBJECTS. #597b restyled the SEGMENTS and left the container a bare
     flex row with a 2px gap -- the half that matters least. A row of transparent segments floating on the bar's
     own surface has no edge to belong to, so the eye groups by the only boundary it can find (the lit fill) and
     reads five loose objects. The chevrons were already there and were not enough.
     A DRAWN BORDER IS THE THING THAT WAS MISSING: once the row has one outline the segments are subdivisions of a
     single object, and a subdivision that fills with colour is unmistakably the live one. This is why the par
     ladder works and why copying only its segment padding did not.
     SO: `gap: 0`. The segments must be FLUSH -- any non-zero gap reintroduces the whitespace that made them read
     as separate chips, and undoes the border. The chevron is the separator; it needs no help.
     Design note #603: THE FILL HAS TO REACH THE EDGES. #599 stopped one step short AGAIN, one level in: the
     container had 2px of padding and the segments a 4px radius, so the lit fill floated clear of the rectangle's
     own edges. A shape that does not touch its container is a shape sitting INSIDE its container, which is the
     definition of the pill this was supposed to stop being.
     NO PADDING, NO RADIUS, `alignItems: stretch` -- the lit segment runs border to border, a slice of the object
     rather than an object on a tray, which is what makes the chevrons read as pointing OUT of the filled block.
     `overflow: hidden` lets both be true at once: the segments stay square and the end ones are clipped by the
     container's own radius, so a lit end seat cannot poke square corners through the rounded frame. */
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
    /* Design note #603: NO WRAP. A wrapped row would leave a half-width second line inside the frame, and the
       segments-of-one-bar reading dies the moment the bar has two rows. Six seats of short labels is the designed
       case; longer ones are handled by the container scrolling rather than by breaking the shape. */
    flexWrap: "nowrap",
    gap: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
    minWidth: 0,
  },
  item: { display: "inline-flex", alignItems: "stretch", minWidth: 0 },
  /* Design note #597b: the `>` the request asks for, in the ladder's own separator weight.
     Design note #603a: THE CHEVRON IS THE POINT, SO IT GETS TO BE SEEN. #597b set it small and faint so it would
     "join the segments rather than compete with them" -- treating it as punctuation. But this glyph is not
     punctuation here: it is the ONLY thing on the bar that says the row is a sequence rather than a list. #595 is
     explicit that the separator carries the meaning position alone could not, and then #597b styled it like it
     carried none.
     SO IT MOVES UP THE SCALE, not just in colour -- 12px reads as a comma at this weight whatever colour it is.
     STILL DIMMER THAN THE LIT SEGMENT, which is the one hierarchy worth keeping. */
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
  /* Design note #597b: THE PAR LADDER'S SHAPE, NOT A PILL. Better than the pills for a reason the request
     implies rather than states: the par ladder is a row of INTERCHANGEABLE options of which exactly one is lit,
     which is precisely the shape of a turn queue. A pill is a self-contained badge -- five read as five separate
     objects that happen to be adjacent, and the rounded ends fight the chevron's attempt to join them.
     PADDING IS THIS FILE'S OWN, slightly larger than the ladder's: that value is defended in `StockRoundPanel` by
     a specific width budget, and a name is longer than a par value. Copying the number rather than the intent
     would make the ladder's constraint govern a row it knows nothing about. */
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
    /* Design note #610: shrinkable, so the name inside can ellipsize. A flex
       item defaults to a `min-width: auto` floor sized to its content, which
       silently refuses to shrink and pushes the overflow onto the frame
       instead. */
    minWidth: 0,
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
  /* Design note #599: an explicit span carrying no styling of its own. It exists so the name and the treasury are
     two flex items on one baseline. Deliberately NO `overflow: hidden` -- on an inline-level box that moves the
     baseline to the bottom margin edge, and the figure beside it would stop lining up.
     Design note #610: the names now clip rather than push. The trail is `nowrap` inside a frame with `overflow:
     hidden`, so before the PASSED tags existed an over-wide row would have silently lost a whole end segment.
     Truncating a long nickname is a far better failure than dropping a player off the queue. */
  seatName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  seatNamePassed: { textDecoration: "line-through", textDecorationThickness: "1.5px" },
  /* Design note #610: THE STAMP, AND WHY IT IS NOT A STAMP. "Stamped over their player name" means the rotated,
     distressed overprint -- the right IDEA and the wrong artefact for a 24px-tall segment read left-to-right at
     speed, because rotated text in a row this dense costs legibility on the name underneath it.
     So it reads as a stamp without being one: small caps, wide tracking, a warning tint, immediately after the
     struck-through name. Same thing at the same glance, in about 34px.
     AMBER, NOT RED. Passing is an ordinary move in both these rounds -- in the Stock Round very often the correct
     one -- and red would grade it. Amber marks a state without judging it, and stays clear of the green this app
     spends on positive figures. */
  passedTag: {
    flex: "none",
    fontSize: "9px",
    fontWeight: 900,
    letterSpacing: "0.08em",
    color: "#e0b050",
    border: "1px solid #6b5a2a",
    borderRadius: "3px",
    padding: "0 3px",
    lineHeight: 1.5,
  },
  /* Design note #639: back, and inactive-only. `escrow` stays deliberately
     quiet -- it qualifies the figure beside it rather than competing with
     it, and on a segment that is already the dim half of the row it does not
     need to shout. */
  cash: { fontWeight: 800 },
  escrow: { fontSize: "10px", fontWeight: 600, opacity: 0.65 },
};
