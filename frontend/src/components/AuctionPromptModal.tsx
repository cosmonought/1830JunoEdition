// frontend/src/components/AuctionPromptModal.tsx
//
// THE TWO DECISIONS THE AUCTION CAN LEAVE BEHIND, in one card.
//
// ==================================================================
//  DESIGN NOTE 399 (UI half): SET THE B&O'S PRICE, NOW
// ==================================================================
//
// REPORTED: buying the B&O private must prompt the player to select a par
// value and award them the President's Certificate.
//
// The certificate half already worked (`grantBOPresidency`). The prompt half
// was implicit -- the Stock Round panel's par ladder shows while `par_value`
// is null, and design note #354 called that the prompt. See design note #399
// in `sandboxSession.ts` for why that stopped being true: the B&O is won
// during the AUCTION, on a different tab and a different round from the
// ladder, and design note #396 has since hidden every card's controls behind
// an active-card click. A prompt nobody encounters is not a prompt.
//
// SO IT IS A MODAL, and blocking, for the same reason the emergency train
// purchase is: this is not a decision the player may defer. Until it is
// answered the B&O has a president and no price, which design note #387
// makes a genuinely unrenderable state -- no market token, no market figure,
// a corporation that exists but cannot be valued.
//
// NO DISMISSAL, NO BACKDROP CLOSE. Every other modal in this codebase can be
// waved away because every other modal is optional. Neither of these has a
// cancel path because there is no legal state on the other side of
// cancelling: the private is already won and the certificate is already
// owed, and an auction with no companies left in it is not a round anybody
// can keep playing.
//
// THE LADDER IS THE SAME SIX RUNGS the Stock Round uses, read from one
// exported constant rather than retyped, so the price a player may set here
// can never differ from the price they could set there.
//
// ==================================================================
//  DESIGN NOTE 547: ONE CARD, NOT TWO MODALS IN A ROW
// ==================================================================
//
// INSTRUCTED: "the B&O winner could set the par in their pop-up and then
// within that same modal have a 'Proceed to Stock Round 1' button, so that
// they don't need two modals in a row."
//
// Which is also why "Proceed" stopped being a button at the foot of the
// auction panel. That banner was the last thing on a scrolling grid of six
// cards -- exactly where a player who has finished reading stops looking --
// and design note #306 had already noticed the deeper version of the
// problem: "is concluding" is not a state a player can leave, so the round
// was waiting on an action nobody could see they had to take.
//
// TWO INDEPENDENT SECTIONS, NOT TWO STEPS. `parPending` and `handoffPending`
// are separate booleans and each renders its own section, which gets the
// merge for free and without any internal step state:
//
//   - B&O won mid-auction  -> par only. There is no round to hand over yet.
//   - Auction ends, no par -> handoff only.
//   - B&O won on the last  -> both, in one card. Confirming the par flips
//     `parPending` false while `handoffPending` stays true, so the SAME
//     mounted card loses its ladder and keeps its Proceed button. The
//     player sees one modal change, not a second one open.
//
// A step machine would have had to know which of those three it was in, and
// would have been wrong in the case where the par is confirmed but the
// auction still has companies left.
//
// WAITING IS RENDERED, NOT HIDDEN. When somebody else owes the B&O a par
// price, the other players get the card with Proceed disabled and that
// player named. The alternative -- showing them nothing -- is a table that
// has visibly stopped with no explanation on screen, and the reason it
// stopped is a fact about another player that only this modal knows.

import React, { useState } from "react";

import { FONT_SIZE } from "../styles/typography";
import { PAR_VALUE_LADDER } from "./StockRoundPanel";

export interface AuctionPromptModalProps {
  /* ==================================================================
   *  DESIGN NOTE 543: A PRIZE IS SHOWN TO WHOEVER WON IT
   * ==================================================================
   *
   * REPORTED: at the end of the auction BOTH players were told they had won
   * the B&O and both could set its par price.
   *
   * The prompt is raised wherever the winning action is APPLIED, and in a
   * room every client applies every action -- that is the whole design
   * (design note #522). So it was raised on both screens, correctly, and
   * then rendered on both because the open test asked only whether a prompt
   * existed and not whose it was.
   *
   * The identity test lives in `App.tsx` with the identity, and arrives here
   * already resolved: `parPending` means "THIS viewer sets the par", never
   * "a par is outstanding somewhere". `awaitingParFrom` carries the other
   * half for everybody else. */
  parPending: boolean;
  /** The winner's name, for the heading. Only read when `parPending`. */
  parWinnerLabel: string;
  onConfirmPar: (parValue: string) => void;

  /** The auction is over and the round has to be handed to the Stock Round. */
  handoffPending: boolean;
  /** Somebody OTHER than this viewer still owes the B&O a par price, by
   *  name. Blocks the handoff -- a corporation with a president and no price
   *  cannot be carried into a Stock Round. `null` when nothing is owed. */
  awaitingParFrom: string | null;
  onProceed: () => void;
}

export function AuctionPromptModal({
  parPending,
  parWinnerLabel,
  onConfirmPar,
  handoffPending,
  awaitingParFrom,
  onProceed,
}: AuctionPromptModalProps) {
  /* Seeded at the top of the ladder rather than left blank. Every rung is
     legal, so there is no "unset" state worth representing -- and a
     pre-selected value means the player can confirm in one click if they do
     not care, rather than being made to choose before they can proceed. */
  const [selected, setSelected] = useState<string>(
    PAR_VALUE_LADDER[PAR_VALUE_LADDER.length - 1],
  );

  if (!parPending && !handoffPending) return null;

  const blocked = awaitingParFrom !== null;

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={parPending ? "Set the B&O par value" : "The Waterfall Auction is complete"}
    >
      <div style={styles.card}>
        {parPending ? (
          <>
            <span style={styles.heading}>
              {parWinnerLabel} wins the Baltimore &amp; Ohio
            </span>
            <p style={styles.body}>
              The B&amp;O private hands you the 20% President&rsquo;s Certificate free of
              charge. Set the price the B&amp;O floats at &mdash; every other share will be
              bought from its IPO at this price.
            </p>

            <div style={styles.ladder} role="group" aria-label="Par value">
              {PAR_VALUE_LADDER.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected === value}
                  style={{
                    ...styles.rung,
                    ...(selected === value ? styles.rungActive : {}),
                  }}
                  onClick={() => setSelected(value)}
                >
                  ${value}
                </button>
              ))}
            </div>

            {/* The consequence of the choice, stated in money. A par is an
                abstract number until it is multiplied by ten, which is what
                the treasury receives at float (design note #134). */}
            <span style={styles.consequence}>
              Floats with ${Number(selected) * 10} in its treasury once 60% is sold.
            </span>

            <button
              type="button"
              style={styles.confirm}
              onClick={() => onConfirmPar(selected)}
            >
              Take the President&rsquo;s Certificate at ${selected}
            </button>
          </>
        ) : (
          <>
            <span style={styles.heading}>The Waterfall Auction is complete</span>
            <p style={styles.body}>
              Every private company has been allocated. Stock Round 1 opens next &mdash;
              corporations can be started and shares bought from their IPOs.
            </p>

            {blocked && (
              /* Design note #547: named, because "waiting" without a name is
                 indistinguishable from being stuck. */
              <span style={styles.waiting}>
                Waiting for {awaitingParFrom} to set the B&amp;O&rsquo;s par price.
              </span>
            )}

            <button
              type="button"
              style={{ ...styles.confirm, ...(blocked ? styles.confirmDisabled : {}) }}
              onClick={onProceed}
              disabled={blocked}
              title={
                blocked
                  ? "The B&O has a president and no share price yet."
                  : "Close the auction and open Stock Round 1."
              }
            >
              Proceed to Stock Round 1 &#8250;
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 4000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    backgroundColor: "rgba(8, 10, 16, 0.72)",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    width: "min(460px, 100%)",
    padding: "18px 20px",
    borderRadius: "12px",
    border: "1px solid #3a4150",
    backgroundColor: "#161b26",
    color: "#e2e6ee",
    boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
  },
  heading: { fontSize: FONT_SIZE.heading, fontWeight: 800 },
  body: { margin: 0, fontSize: FONT_SIZE.body, lineHeight: 1.5, color: "#aeb6c4" },
  ladder: { display: "flex", flexWrap: "wrap", gap: "6px" },
  rung: {
    flex: "1 1 auto",
    padding: "9px 4px",
    borderRadius: "7px",
    border: "1px solid #3a4150",
    backgroundColor: "#1b2130",
    color: "#e2e6ee",
    font: "inherit",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
  },
  rungActive: { borderColor: "#4d8ee0", backgroundColor: "#1d3a55", color: "#ffffff" },
  consequence: {
    fontSize: FONT_SIZE.micro,
    color: "#8f98a8",
    fontVariantNumeric: "tabular-nums",
  },
  waiting: {
    fontSize: FONT_SIZE.small,
    color: "#d9c08a",
    fontWeight: 700,
  },
  confirm: {
    padding: "11px 16px",
    borderRadius: "8px",
    border: "1px solid #4d8ee0",
    backgroundColor: "#2f6fb2",
    color: "#f2f7ff",
    font: "inherit",
    fontWeight: 800,
    fontSize: FONT_SIZE.strong,
    cursor: "pointer",
  },
  confirmDisabled: { opacity: 0.45, cursor: "not-allowed" },
};

export default AuctionPromptModal;
