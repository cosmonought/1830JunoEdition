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
// SUPERSEDED IN PART BY DESIGN NOTE 1097 -- READ THIS BEFORE RELYING ON THE PARAGRAPH BELOW. That note
// re-cut the three failing seat colours, and against white ink ALL SIX NOW CLEAR 4.5:1 (the weakest is Ochre
// `#847400` at 4.69:1). The measurement this decision rested on no longer says what it said.
//
// THE DECISION IS LEFT STANDING ANYWAY, and deliberately: the stripe was also chosen because a full-surface
// seat colour makes the modal's ground change identity from player to player, which was never a contrast
// argument. But that is now the WHOLE case rather than half of it, so anyone reopening this should reopen it
// on those grounds and not by re-running the numbers below -- which no longer fail.
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

// Design note #1052: `useEffect` left with the Escape listener -- one exit, and no hook to hold it open.
import React from "react";

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

/** One of the viewer's privates, already formatted. The display shape #984 established, plus #1052's number. */
export interface PrivateRevenueLine {
  /** Design note #1052: the catalog's own number, so this panel numbers a private the way every other one does. */
  privateId: number;
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
  /** ==================================================================
   *   DESIGN NOTE 1052: WHERE THIS SEAT NOW STANDS
   *  ==================================================================
   *
   * ASKED: "it might also be useful for the other players' information to show their $before + $payout > $new
   * cash holdings."
   *
   * THE PAYOUT AND THE STANDING, NOT THE FULL MOVEMENT. Three figures on every row, for up to five rows of
   * information the reader is not acting on, is a table rather than a glance -- and the `before` is the one
   * of the three that is a subtraction away. What a player actually tracks across a game is what a rival
   * HOLDS, so the row says what arrived and what it arrived at.
   * `null` WHEN THE STATE DID NOT REPORT IT, and the row then shows the payout alone rather than inventing a
   * balance (#232, and #562's rule that a missing figure and a zero are different facts). */
  cashAfter: number | null;
}

export interface PrivateRevenueModalProps {
  /** `null` renders nothing. Raised only when the VIEWER collected -- see the note below. */
  round: {
    viewerName: string;
    viewerSeatColor: string | null;
    lines: readonly PrivateRevenueLine[];
    total: number;
    /** ==================================================================
     *   DESIGN NOTE 1052: THE MOVEMENT, WHICH IS HOW THIS APP REPORTS MONEY
     *  ==================================================================
     *
     * ASKED: "on payouts, we usually include $before > $after somewhere."
     *
     * AND IT IS THE HOUSE FORM, not a nicety -- #670 settled it for the dividend report and #682 rebuilt the
     * Stock Round's projection around it: money moving is TWO facts, what arrived and where it left you, and
     * they read as a before and an after rather than as one figure. This panel reported only the first.
     *
     * BOTH `null` WHEN THE STATE DID NOT SAY, and the line is then omitted entirely rather than printed with
     * an em dash on one side. A movement is a claim about two numbers; with one of them missing there is no
     * movement to state, and #562's dash is for a missing figure in a column of figures, not for half a
     * sentence. */
    cashBefore: number | null;
    cashAfter: number | null;
    others: readonly PrivateRevenueOther[];
  } | null;
  /** Which Operating Round this is, so the modal names the moment rather than floating free of it. */
  roundLabel: string | null;
  onAcknowledge: () => void;
}

export function PrivateRevenueModal({ round, roundLabel, onAcknowledge }: PrivateRevenueModalProps) {
  /* ==================================================================
      DESIGN NOTE 1052: ONE EXIT, AND #1049 ARGUED THE OPPOSITE
     ==================================================================
     #1049 GAVE THIS MODAL ESCAPE AND A BACKDROP CLICK, on the argument that #896's reason for removing both
     from `FleetLossModal` does not apply: "nothing is lost by dismissing this one. The money is already paid
     ... what the modal supplies is the CEREMONY, and ceremony a player wants to skip should be skippable."
     REPORTED FROM PLAYTEST: "clicking anywhere on the screen dismisses the modal: I think it's better to make
     players click the Begin Operations button since an accidental click elsewhere immediately dismisses it."
     AND THE ARGUMENT WAS ABOUT THE WRONG COST. It priced what a player LOSES by dismissing -- correctly,
     nothing -- and never priced how easily they dismiss it BY ACCIDENT. A modal that opens under the cursor
     at the start of every Operating Round will eat a click the player had aimed at the board underneath, and
     the ceremony this panel exists to restore is gone before it has been read. The cost of a mis-click is not
     lost information, it is the whole feature not happening.
     SO IT IS ONE EXIT, the same shape #896 chose for the same practical reason and not for its stated one.
     Escape goes with the backdrop click: it is the less likely accident of the two, but two exits is exactly
     what the report asks to remove, and the footer button carries `autoFocus` so a keyboard player presses
     Enter rather than hunting for it.
     THE EFFECT IS GONE, NOT NEUTERED. A listener that captured Escape and did nothing would leave a reader
     wondering which of the two was intended. */

  if (!round) return null;

  const stripe = round.viewerSeatColor;
  const stripeInk = stripe ? bestContrastTextColor(stripe) : CARD_INK;

  return (
    /* Design note #1052: NO `onClick` ON THE BACKDROP, and the absence is deliberate enough to be worth the
       same comment `FleetLossModal` carries -- every other modal in this app closes on a backdrop click, so a
       later tidy-up would otherwise "restore" it for consistency and reintroduce the mis-click. */
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label="Private company payouts">
      <div style={styles.card}>
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
            {/* ==================================================================
                 DESIGN NOTE 1052: THE STRIPE IS IDENTITY AND NOTHING ELSE
                ==================================================================
                IT CARRIED THE TOTAL, and #1049 defended that: "the stripe answers 'how much did I get' at a
                glance and the column closes underneath." REPORTED: "the sum does not need to be listed in the
                player color stripe since it's printed a few lines below that." Which is right, and the
                defence was thin -- four lines apart is not two registers, it is the same number twice.
                AND IT PUTS THE BAND BACK TO WHAT #1050 ARGUED IT WAS FOR. That note's case for the stripe was
                that a reader who has looked at their player card already knows what a coloured band with a
                name means; the player card's header carries no figure either. The figure was my addition to a
                borrowed component, and it is the part that did not belong. */}
            <span style={styles.stripeName}>{round.viewerName}</span>
          </header>

          {/* Design note #984's two-column grid, unchanged in substance: names flush left, figures right in
              tabular numerals, because "easily comparable" is a claim about a column of digits. */}
          <div style={styles.lines}>
            {round.lines.map((line) => (
              /* The label is the key: a player cannot hold the same private twice, so it is unique by the
                 rules rather than by construction. */
              <React.Fragment key={line.label}>
                {/* Design note #1052: `${private_id}. ${name}`, the form the Ledger, the player cards, the
                    trade panel, the auction dashboard and the action bar all already use. */}
                <span style={styles.lineLabel}>
                  <span style={styles.lineNumber}>{line.privateId}.</span> {line.label}
                </span>
                <span style={styles.lineValue}>{line.value}</span>
              </React.Fragment>
            ))}
            {round.lines.length > 1 && (
              /* Design note #1047: ONLY WHEN THERE IS SOMETHING TO ADD UP. One private is its own total, and a
                 "Total" row under a single line restates it -- #697's argument against the padded receipt.
                 Design note #1052: THE PARAGRAPH THAT STOOD HERE DEFENDED THE STRIPE'S COPY OF THIS FIGURE and
                 is gone with it -- the total appears once now, at the foot of the column it totals. */
              <>
                <span style={styles.totalLabel}>Total</span>
                <span style={styles.totalValue}>${round.total}</span>
              </>
            )}
            {round.cashBefore !== null && round.cashAfter !== null && (
              /* ==================================================================
                  DESIGN NOTE 1052: WHERE THE MONEY LEFT YOU
                 ==================================================================
                 ASKED: "on payouts, we usually include $before > $after somewhere." It is #670's rule and
                 #682's block: money moving is two facts, and this panel was reporting only the arrival.
                 INSIDE THE SAME GRID as the rows above, so the arrow column lines up with the figures rather
                 than sitting in a block of its own with its own spacing -- which is precisely the drift #951
                 fixed when the Stock Round's price move was built beside the cash row instead of inside it. */
              <>
                <span style={styles.cashLabel}>Cash</span>
                <span style={styles.cashValue}>
                  ${round.cashBefore} → ${round.cashAfter}
                </span>
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
                  {/* Design note #1052: what arrived, then what it arrived AT. The `+` is on the payout so the
                      two figures cannot be read as one before/after pair -- without it, "$20 → $455" claims a
                      seat went from twenty dollars to four hundred. */}
                  <span style={styles.otherPaid}>+${other.total}</span>
                  {other.cashAfter !== null && (
                    <span style={styles.otherHeld}>→ ${other.cashAfter}</span>
                  )}
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
  // Design note #1052: `stripeTotal` is deleted, not emptied -- the stripe carries identity only now, and an
  // unused style is an invitation to put a figure back in the band #1050 cleared for a name.
  lineNumber: { color: CARD_INK_FAINT, fontVariantNumeric: "tabular-nums" },
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
  /* ==================================================================
      DESIGN NOTE 1052: THE SUM IS MONEY ARRIVING, SO IT IS GREEN
     ==================================================================
     REPORTED: "the revenue numbers are in green, but the sum is in black."
     AND THE INCONSISTENCY WAS INHERITED RATHER THAN CHOSEN. The dark total came from the toast, where #1030
     had darkened every figure against a cream ground and the rows had no green to be consistent WITH. Carried
     onto a panel whose rows are `CARD_INK_POSITIVE`, it made the one figure that sums the others the only one
     that did not look like income.
     #670's RULE IS THE WHOLE ARGUMENT: green means money, or a thing arriving. A column of green figures with
     a black sum says the sum is a different kind of quantity, which is exactly what it is not. */
  totalValue: {
    color: CARD_INK_POSITIVE,
    textAlign: "right",
    fontWeight: 800,
    fontVariantNumeric: "tabular-nums",
    borderTop: `1px solid ${CARD_DIVIDER}`,
    paddingTop: "4px",
    marginTop: "3px",
  },
  /* Design note #1052: the movement, quieter than the sum above it. The sum is what the phase paid and is the
     figure being checked against the column; this is where it landed, which is context rather than the claim.
     MONOSPACED FOR THE ARROW, matching #738's treatment of the same before/after on the dividend receipt --
     "a pair of figures rather than a sentence" -- so two panels reporting one kind of fact look alike. */
  cashLabel: { color: CARD_INK_MUTED, textAlign: "left", paddingTop: "2px" },
  cashValue: {
    color: CARD_INK_POSITIVE,
    textAlign: "right",
    fontWeight: 700,
    paddingTop: "2px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontVariantNumeric: "tabular-nums",
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
  /* Design note #1052: what arrived, in the income green the viewer's own rows use -- it is the same kind of
     fact about a different seat, and using a second colour for it would say otherwise. */
  otherPaid: {
    color: CARD_INK_POSITIVE,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    flex: "none",
  },
  /* And where it landed, quieter: a rival's standing is context. Monospaced with the arrow, matching the
     viewer's own cash line so the two read as one kind of statement at two levels of detail. */
  otherHeld: {
    color: CARD_INK_MUTED,
    fontVariantNumeric: "tabular-nums",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
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
