// frontend/src/components/PrivateRevenueModal.tsx
//
// The private companies pay, and the table watches it happen.
//
// ==================================================================
//  DESIGN NOTE 1049: THE PHASE GETS A SURFACE THAT STOPS THE ROUND
// ==================================================================
//
// ASKED: "in the physical game, the PC payouts is a separate phase prior to any corporation acting. All
// players receive their PC income at that time, and I think the current version has minimized or obscured
// that process."
//
// AND THAT IS A FIDELITY ARGUMENT, NOT A VISIBILITY ONE, which is why #1047's answer -- a toast that waits to
// be dismissed -- was only ever going to be a near miss. A toast in the corner is ambient by construction:
// #1016 put it there for the stated reason that it "arrives when a round opens, unbidden", which is the exact
// register a phase must NOT be in. The information was legible and the ceremony was missing.
//
// #1047 ARGUED AGAINST THIS MODAL AND THE ARGUMENT IS NOW WITHDRAWN, in place rather than deleted, because
// half of it was right and stays true. It said: "a recurring modal for the least surprising event in the game
// would spend the interruption budget where it buys least, and would train players to dismiss the fleet-loss
// modal, where dismissing without reading costs a turn."
//   THE PREMISE WENT FIRST. That note leaned on #1032 -- "modals kept firing at the start of basically every
//   operating round" -- and the report behind it was then clarified: "the reason the modals happening every
//   Operating Round was annoying is that the information they were displaying was irrelevant/old." The
//   complaint was staleness, and #1032 fixed staleness. A modal whose content is always current and always
//   about money that just moved is not the thing that was annoying.
//   THE STACKING COST WAS PRICED RATHER THAN DISMISSED: "there aren't any Rust/Train Limit events in the first
//   two phases, so PC payouts won't be competing with anything. Once players hit phase 4, they might then get
//   hit with two modals in a row on one OR ... but two modals carrying meaningful information does not seem so
//   overwhelming, and one is for players, the other is for the corporation."
//   WHAT SURVIVES IS THE DESENSITISATION RISK, and it is answered by SEQUENCE rather than by absence -- see
//   `App.tsx` #1049a. This modal is shown FIRST and the fleet-loss modal is withheld until it is gone, so the
//   two never appear as an undifferentiated stack of things to click through. That ordering is also the
//   physical one: everybody collects, and then the first corporation acts.
//
// THERE IS NO SILENCE TOGGLE, and its absence is deliberate enough to be worth a line. `FleetLossModal` #896
// offers one because that notice is a WARNING, and a player who already knows the rule gains nothing from
// being told again. This is not a warning; it is a payment being made to the reader. A phase you can switch
// off is not a phase, and switching it off would put the money back in the feed this note exists to get it
// out of.
//
// ==================================================================
//  DESIGN NOTE 1050: THE SEAT COLOUR GOES WHERE IT CAN CARRY TEXT
// ==================================================================
//
// REPORTED of #1048's 5px accent rule: "I'm not sure about it. You've implemented something like this before
// and we've had to change it because it's far too subtle for human players to notice."
//
// AND THAT IS THE SECOND TIME, WHICH MAKES IT A PATTERN RATHER THAN A MISS. #1048 chose an edge over a ground
// on a measured argument -- seat colours are picked to be distinguishable from each other, not to carry ink --
// and the argument was sound about CONTRAST while being wrong about SALIENCE. A 5px rule on a panel the reader
// is not looking at is a detail you find once you already know to look for it, which is no signal at all.
//
// THE TWO OPTIONS OFFERED WERE the player card's layout ("the player name and color stripe up top, and the
// info below it") and the whole surface in the seat colour with ink adjusted per seat. THE SIZE OBJECTION TO
// THE FIRST -- "the problem with this would be that it makes the toast notification twice as large" -- WAS A
// TOAST OBJECTION AND DIED WITH THE TOAST. A modal already has the room.
//
// AND THE MEASUREMENT DECIDES THE REST. Against white ink, three of the six seat colours fall under the 4.5:1
// body-text threshold: Ochre `#a88a3f` at 3.3:1, Teal `#3f8a94` at 4.0:1, Moss `#4f8a5c` at 4.1:1. Colouring
// the whole surface therefore means either darkening every seat's ground or forcing every figure to
// large-bold, both of which change the seat colours into something that is no longer the seat colour. The
// stripe puts the colour on a band that carries ONE short bold name at heading size, where 3:1 is the
// applicable threshold and all six pass -- and `bestContrastTextColor` picks that name's ink per seat rather
// than asserting one colour for six grounds, exactly as `PlayerCards` #606 already does.
//
// SO THIS IS NOT A NEW TREATMENT, WHICH IS THE POINT. It is the player card's own header, on the card surface
// the auction's private companies already use. A reader who has looked at their player card once knows what
// the band means before reading a word of it -- which is #569's whole case for seat colour: "colour in exactly
// one place is decoration; colour meaning the same thing in several places is a language."
//
// See docs/ai_architecture/ui_shell_layout.md, PrivateRevenueModal.tsx #1049.

import React, { useEffect } from "react";

import { FONT_SIZE } from "../styles/typography";
import {
  CARD_BORDER,
  CARD_DIVIDER,
  CARD_INK,
  CARD_INK_FAINT,
  CARD_INK_MUTED,
  CARD_INK_POSITIVE,
  CARD_SURFACE,
} from "../styles/palette";
// Design note #1050: the same per-seat ink choice the player card's own stripe makes.
import { bestContrastTextColor } from "../styles/corporationLivery";

/** One of the viewer's privates, already formatted. The display shape #984 established, unchanged. */
export interface PrivateRevenueLine {
  label: string;
  value: string;
}

/** Another player's round, as one line.
 *
 *  Design note #1049: RESOLVED BY THE SHELL, not by this component. The seat colour needs the roster index and
 *  the name needs the nickname registry, both of which are `App.tsx`'s to know -- handing this component two
 *  resolver callbacks would make it ask questions it has no business asking, and would make it untestable
 *  without a room. It paints what it is given. */
export interface PrivateRevenueOther {
  name: string;
  /** `null` for an address the roster cannot place, which is #232's answer rather than a guessed colour. */
  seatColor: string | null;
  total: number;
}

export interface PrivateRevenueModalProps {
  /** `null` renders nothing. Raised only when the VIEWER collected -- see the note below. */
  round: {
    viewerName: string;
    viewerSeatColor: string | null;
    lines: readonly PrivateRevenueLine[];
    total: number;
    others: readonly PrivateRevenueOther[];
  } | null;
  /** Which Operating Round this is, so the modal names the moment rather than floating free of it. */
  roundLabel: string | null;
  onAcknowledge: () => void;
}

export function PrivateRevenueModal({ round, roundLabel, onAcknowledge }: PrivateRevenueModalProps) {
  /* ==================================================================
      DESIGN NOTE 1049: ESCAPE WORKS HERE, AND DELIBERATELY DOES NOT ON `FleetLossModal`
     ==================================================================
     #896 removed Escape, the backdrop click and the X from the fleet-loss modal, and named the reason: a rust
     or a limit drop "changes what a corporation can do with its whole turn", so an accidental dismissal costs
     the player a turn they cannot get back.
     NOTHING IS LOST BY DISMISSING THIS ONE. The money is already paid -- the reducer settled it before this
     rendered (#685) -- and every figure on this panel is also on the player cards and in the Activity Log.
     What the modal supplies is the CEREMONY, and ceremony a player wants to skip should be skippable.
     SAID OUT LOUD so a later pass does not remove Escape "for consistency with the other modal", which is the
     precise edit #896's own note warns against in the opposite direction. */
  useEffect(() => {
    if (!round) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onAcknowledge();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [round, onAcknowledge]);

  if (!round) return null;

  const stripe = round.viewerSeatColor;
  const stripeInk = stripe ? bestContrastTextColor(stripe) : CARD_INK;

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Private company payouts"
      onClick={onAcknowledge}
    >
      {/* The card stops the backdrop's click, so dismissing is a deliberate move OFF the panel rather than
          anywhere on screen -- a player reading the table must be able to click within it. */}
      <div style={styles.card} onClick={(event) => event.stopPropagation()}>
        {/* ---- The phase, named ---- */}
        <div style={styles.phaseRow}>
          <span style={styles.phaseName}>Private Company Payouts</span>
          {roundLabel && <span style={styles.phaseRound}>{roundLabel}</span>}
        </div>
        {/* Design note #1049: THE RULE, IN ONE LINE. The complaint was that the process had been "minimized or
            obscured", and a panel that shows the money without naming when it happens obscures it a second
            way. This is the sentence a player would hear at a physical table. */}
        <p style={styles.phaseCaption}>
          Paid from the bank at the start of every Operating Round, before any corporation acts.
        </p>

        {/* ---- The viewer's own stripe, borrowed from their player card ---- */}
        <div style={styles.mine}>
          <header
            style={{
              ...styles.stripe,
              ...(stripe ? { backgroundColor: stripe, color: stripeInk } : styles.stripeUnknown),
            }}
          >
            <span style={styles.stripeName}>{round.viewerName}</span>
            <span style={styles.stripeTotal}>${round.total}</span>
          </header>

          {/* Design note #984's two-column grid, unchanged in substance: names flush left, figures right in
              tabular numerals, because "easily comparable" is a claim about a column of digits. */}
          <div style={styles.lines}>
            {round.lines.map((line) => (
              /* The label is the key: a player cannot hold the same private twice, so it is unique by the
                 rules rather than by construction. */
              <React.Fragment key={line.label}>
                <span style={styles.lineLabel}>{line.label}</span>
                <span style={styles.lineValue}>{line.value}</span>
              </React.Fragment>
            ))}
            {round.lines.length > 1 && (
              /* Design note #1047: ONLY WHEN THERE IS SOMETHING TO ADD UP. One private is its own total, and a
                 "Total" row under a single line restates it -- #697's argument against the padded receipt.
                 THE TOTAL IS ALSO IN THE STRIPE ABOVE, which is not a duplication: the stripe answers "how
                 much did I get" at a glance and this closes the column the reader has just added up. They are
                 the same figure by construction, because both are `round.total`. */
              <>
                <span style={styles.totalLabel}>Total</span>
                <span style={styles.totalValue}>${round.total}</span>
              </>
            )}
          </div>
        </div>

        {/* ---- Everybody else, one line each ---- */}
        {round.others.length > 0 && (
          <div style={styles.others}>
            {/* Design note #1049: LABELLED AS THE TABLE'S, so the reader never has to work out whose figures
                these are. #967's objection was to an undifferentiated total; a named block of named rows is
                the answer to it rather than an instance of it. */}
            <span style={styles.othersLabel}>Also collected</span>
            <div style={styles.othersRows}>
              {round.others.map((other) => (
                <div key={other.name} style={styles.otherRow}>
                  {/* The swatch, not a coloured name: at this size a tinted label is the subtlety #1050 is
                      correcting, and a solid block reads at a glance. `aria-hidden` because the name beside
                      it already identifies the row. */}
                  <span
                    aria-hidden="true"
                    style={{
                      ...styles.swatch,
                      ...(other.seatColor
                        ? { backgroundColor: other.seatColor }
                        : styles.swatchUnknown),
                    }}
                  />
                  <span style={styles.otherName}>{other.name}</span>
                  <span style={styles.otherTotal}>${other.total}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={styles.footer}>
          <button type="button" style={styles.primaryButton} onClick={onAcknowledge} autoFocus>
            Begin operations
          </button>
        </div>
      </div>
    </div>
  );
}

export default PrivateRevenueModal;

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    /* ==================================================================
        DESIGN NOTE 1049a: ABOVE THE FLEET-LOSS MODAL, AND THE SEQUENCE IS THE REAL GUARD
       ==================================================================
       `FleetLossModal` sits at 3800 and #896 says it is "above everything -- the turn does not start until it
       is answered." That is still true of the TURN. This is not part of a turn: it is the phase before any
       turn begins, so when both have something to say this one is read first.
       THE Z-INDEX IS NOT WHAT ENFORCES THAT. `App.tsx` withholds the fleet notice entirely while this is
       open, so the two are never mounted together and nothing is stacked behind anything. This value is here
       so that if that suppression is ever lost, the failure is a modal in the wrong order rather than a modal
       invisible underneath another one -- the recoverable direction. */
    zIndex: 3900,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(6, 9, 15, 0.82)",
  },
  /* Design note #1048's surviving half: the auction's private-company cards' own surface, shared as a constant
     rather than matched by eye, so this panel reads as the same family of object as the cards these companies
     were bought from. */
  card: {
    width: "min(440px, 100%)",
    maxHeight: "84vh",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "16px 18px",
    borderRadius: "12px",
    border: `1px solid ${CARD_BORDER}`,
    backgroundColor: CARD_SURFACE,
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
    color: CARD_INK,
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  phaseRow: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px" },
  phaseName: { fontSize: FONT_SIZE.strong, fontWeight: 800, color: CARD_INK },
  phaseRound: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    color: CARD_INK_FAINT,
    flex: "none",
  },
  phaseCaption: { margin: 0, fontSize: FONT_SIZE.micro, color: CARD_INK_MUTED, lineHeight: 1.45 },
  mine: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "9px",
    border: `1px solid ${CARD_DIVIDER}`,
    overflow: "hidden",
    marginTop: "2px",
  },
  /* Design note #1050: the player card's own header, same padding and same weight, so the two are recognisably
     one object seen twice rather than two designs that resemble each other. */
  stripe: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "6px 10px",
    minWidth: 0,
  },
  /* No seat colour resolved: the muted paper, never a guessed hue. #232's rule -- absence is not an answer,
     and inventing a seat colour would attach an identity the roster did not give. */
  stripeUnknown: { backgroundColor: CARD_DIVIDER, color: CARD_INK },
  stripeName: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 800,
    letterSpacing: "0.2px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  stripeTotal: { fontSize: FONT_SIZE.strong, fontWeight: 800, flex: "none" },
  lines: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    columnGap: "14px",
    rowGap: "3px",
    padding: "9px 10px",
    fontSize: FONT_SIZE.small,
  },
  lineLabel: { color: CARD_INK_MUTED, textAlign: "left" },
  lineValue: {
    color: CARD_INK_POSITIVE,
    textAlign: "right",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
  },
  totalLabel: {
    color: CARD_INK_MUTED,
    textAlign: "left",
    borderTop: `1px solid ${CARD_DIVIDER}`,
    paddingTop: "4px",
    marginTop: "3px",
  },
  totalValue: {
    color: CARD_INK,
    textAlign: "right",
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    borderTop: `1px solid ${CARD_DIVIDER}`,
    paddingTop: "4px",
    marginTop: "3px",
  },
  others: { display: "flex", flexDirection: "column", gap: "5px", marginTop: "2px" },
  othersLabel: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    color: CARD_INK_FAINT,
  },
  othersRows: { display: "flex", flexDirection: "column", gap: "3px" },
  otherRow: { display: "flex", alignItems: "center", gap: "8px", fontSize: FONT_SIZE.small },
  swatch: { width: "10px", height: "10px", borderRadius: "3px", flex: "none" },
  swatchUnknown: { backgroundColor: CARD_DIVIDER },
  otherName: {
    color: CARD_INK_MUTED,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: "1 1 auto",
    minWidth: 0,
  },
  otherTotal: {
    color: CARD_INK_MUTED,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    flex: "none",
  },
  footer: { display: "flex", justifyContent: "flex-end", marginTop: "4px" },
  primaryButton: {
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid #3f7a55",
    backgroundColor: "#1d4030",
    color: "#e6f5ec",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
};
