// The two decisions the auction can leave behind, in one card: the B&O's par
// price and the handoff into the Stock Round that follows it (Stock Round 1 in
// the standard game; a later one under the Delayed Auction -- DA-6, DA-F8b).
//
// Modal and undismissable -- the private is already won and the certificate
// already owed, so there is no legal state on the other side of cancelling.
// `parPending` and `handoffPending` are independent booleans rendering
// independent sections, so the three cases (par only / handoff only / both)
// merge without any internal step state. The par ladder is the Stock Round's
// own exported constant, not a retyped copy.
//
// See docs/ai_architecture/contract_economy.md, AuctionPromptModal.tsx #399
// and #547.

import React, { useCallback, useEffect, useRef, useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { PAR_VALUE_LADDER } from "./StockRoundPanel";

/* ==================================================================
    6.5-B (H-02): THE PROMPT FOLLOWS THE BOARD, SO THE BUTTON HOLDS ITS OWN PRESS
   ==================================================================
   The par prompt used to vanish on click (the shell cleared a latch before sending), which is what stranded a
   player whose `SetBoPar` never landed. It now stays for exactly as long as the board owes the par -- and so a
   second press while the first is still travelling would send a second `SetBoPar` for the authority to refuse.
   The confirm is therefore held while ITS OWN send is in flight. It is released:
     - at once, when the board stops owing the par (the send landed: the par card simply goes away);
     - `PAR_SETTLE_GRACE_MS` after the send settles without that happening -- a refusal, or a send the link dropped
       at the door. The grace covers the moment between the server's answer and the drain applying the entry, so a
       send that DID land is not offered a second press;
     - and in any case after `PAR_SEND_HOLD_MS`, so a send that never answers can never leave the owner without the
       control.
   A release while the par is still owed says so ("not reached the table yet"), because the reason itself -- the
   link's banner or the refusal -- is drawn under this modal's backdrop.
   This is a debounce of one button, not an obligation: whether the prompt shows is still only the board's. */
export const PAR_SEND_HOLD_MS = 4000;
export const PAR_SETTLE_GRACE_MS = 1500;
export const PAR_NOT_LANDED_NOTE = "Your par price has not reached the table yet — press again to retry.";

export interface AuctionPromptModalProps {
  /* Design note #543: `parPending` means "THIS viewer sets the par", never "a
     par is outstanding somewhere". Every client applies every action (#522), so
     the prompt is raised on all screens; the identity test lives in `App.tsx` and
     arrives here already resolved. `awaitingParFrom` carries the other half. */
  parPending: boolean;
  /** The winner's name, for the heading. Only read when `parPending`. */
  parWinnerLabel: string;
  /** 6.5-B (H-02): may return the submission's promise, so the button is held while that one send is in flight
   *  (at most `PAR_SEND_HOLD_MS`). The prompt itself stays until the board stops owing the par. */
  onConfirmPar: (parValue: string) => void | Promise<unknown>;

  /** The auction is over and the round has to be handed to the Stock Round. */
  handoffPending: boolean;
  /** Somebody OTHER than this viewer still owes the B&O a par price, by
   *  name. Blocks the handoff -- a corporation with a president and no price
   *  cannot be carried into a Stock Round. `null` when nothing is owed. */
  awaitingParFrom: string | null;
  onProceed: () => void;
  /* DA-6 (DA-F8b): the Stock Round the handoff opens -- `macro_round_number`, the slot the auction occupies (#905;
     the Activity Log's handoff line reads the same number). It said "Stock Round 1" at the end of EVERY auction,
     which under the Delayed Auction named a round the table played long ago. Absent reads as 1, the standard game. */
  nextStockRound?: number;
  /** DA-6: the table plays the Delayed Auction, so the auction is not "the Waterfall Auction" that opened the game. */
  delayedAuction?: boolean;
}

export function AuctionPromptModal({
  parPending,
  parWinnerLabel,
  onConfirmPar,
  handoffPending,
  awaitingParFrom,
  onProceed,
  nextStockRound = 1,
  delayedAuction = false,
}: AuctionPromptModalProps) {
  /* Seeded at the top of the ladder rather than left blank. Every rung is
     legal, so there is no "unset" state worth representing -- and a
     pre-selected value means the player can confirm in one click if they do
     not care, rather than being made to choose before they can proceed. */
  const [selected, setSelected] = useState<string>(
    PAR_VALUE_LADDER[PAR_VALUE_LADDER.length - 1],
  );
  /* 6.5-B (H-02): the one send in flight, by a token so a late settle of an older press cannot release a newer
     one. `null` when nothing is travelling. `notLanded`: the last press was released with the par still owed. */
  const [sending, setSending] = useState<number | null>(null);
  const [notLanded, setNotLanded] = useState(false);
  const sendSerial = useRef(0);
  const activeToken = useRef<number | null>(null);
  const release = useCallback((token: number) => {
    if (activeToken.current !== token) return;
    activeToken.current = null;
    setSending(null);
    setNotLanded(true);
  }, []);
  useEffect(() => {
    if (sending === null) return undefined;
    const timer = window.setTimeout(() => release(sending), PAR_SEND_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [sending, release]);
  // The par is no longer this viewer's to set (it landed, or was never theirs): nothing is in flight any more.
  useEffect(() => {
    if (parPending) return;
    activeToken.current = null;
    setSending(null);
    setNotLanded(false);
  }, [parPending]);

  const confirmPar = () => {
    if (sending !== null) return;
    sendSerial.current += 1;
    const token = sendSerial.current;
    activeToken.current = token;
    setSending(token);
    setNotLanded(false);
    const result = onConfirmPar(selected);
    const settled = () => {
      window.setTimeout(() => release(token), PAR_SETTLE_GRACE_MS);
    };
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(settled, settled);
    } else {
      settled();
    }
  };

  if (!parPending && !handoffPending) return null;

  const blocked = awaitingParFrom !== null;
  const stockRound = `Stock Round ${nextStockRound}`;
  const completeHeading = delayedAuction ? "The private company auction is complete" : "The Waterfall Auction is complete";

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={parPending ? "Set the B&O par value" : completeHeading}
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
              style={{ ...styles.confirm, ...(sending !== null ? styles.confirmDisabled : {}) }}
              onClick={confirmPar}
              disabled={sending !== null}
              title={sending !== null ? "Sending your par price — one moment." : undefined}
            >
              {sending !== null
                ? "Sending…"
                : <>Take the President&rsquo;s Certificate at ${selected}</>}
            </button>
            {sending === null && notLanded && (
              <span style={styles.waiting} role="status">
                {PAR_NOT_LANDED_NOTE}
              </span>
            )}
          </>
        ) : (
          <>
            <span style={styles.heading}>{completeHeading}</span>
            <p style={styles.body}>
              {delayedAuction ? (
                <>
                  Every private company has been allocated. {stockRound} opens next, and the B&amp;O is now
                  open for trading like any other corporation.
                </>
              ) : (
                <>
                  Every private company has been allocated. {stockRound} opens next &mdash;
                  corporations can be started and shares bought from their IPOs.
                </>
              )}
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
                  : `Close the auction and open ${stockRound}.`
              }
            >
              Proceed to {stockRound} &#8250;
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
    borderRadius: RADIUS.layer,
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    boxShadow: "0 18px 48px rgba(0,0,0,0.5)",
  },
  heading: { fontSize: FONT_SIZE.heading, fontWeight: 800 },
  body: { margin: 0, fontSize: FONT_SIZE.body, lineHeight: 1.5, color: "#a8a6a0" },
  ladder: { display: "flex", flexWrap: "wrap", gap: "6px" },
  rung: {
    flex: "1 1 auto",
    padding: "9px 4px",
    borderRadius: RADIUS.control,
    border: "1px solid #3a3a3a",
    backgroundColor: "#141414",
    color: "#f2f0eb",
    font: "inherit",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
  },
  // #1449: the shorthand, not `borderColor` -- the base is `1px solid #3a3a3a`.
  rungActive: { border: "1px solid #4d8ee0", backgroundColor: "#1d3a55", color: "#f2f0eb" },
  consequence: {
    fontSize: FONT_SIZE.micro,
    color: "#a8a6a0",
    fontVariantNumeric: "tabular-nums",
  },
  waiting: {
    fontSize: FONT_SIZE.small,
    color: "#d9c08a",
    fontWeight: 700,
  },
  confirm: {
    padding: "11px 16px",
    borderRadius: RADIUS.card,
    border: "1px solid #4d8ee0",
    backgroundColor: "#2f6fb2",
    color: "#f2f0eb",
    font: "inherit",
    fontWeight: 800,
    fontSize: FONT_SIZE.strong,
    cursor: "pointer",
  },
  confirmDisabled: { opacity: 0.45, cursor: "not-allowed" },
};

export default AuctionPromptModal;
