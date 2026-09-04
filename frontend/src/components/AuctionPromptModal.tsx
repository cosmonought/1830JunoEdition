// The two decisions the auction can leave behind, in one card: the B&O's par
// price and the handoff into Stock Round 1.
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

import React, { useState } from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { PAR_VALUE_LADDER } from "./StockRoundPanel";

export interface AuctionPromptModalProps {
  /* Design note #543: `parPending` means "THIS viewer sets the par", never "a
     par is outstanding somewhere". Every client applies every action (#522), so
     the prompt is raised on all screens; the identity test lives in `App.tsx` and
     arrives here already resolved. `awaitingParFrom` carries the other half. */
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
  rungActive: { borderColor: "#4d8ee0", backgroundColor: "#1d3a55", color: "#f2f0eb" },
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
