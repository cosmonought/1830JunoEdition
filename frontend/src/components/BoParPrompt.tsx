// frontend/src/components/BoParPrompt.tsx
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
// waved away because every other modal is optional. This one has no cancel
// path because there is no legal state on the other side of cancelling: the
// private is already won and the certificate is already owed.
//
// THE LADDER IS THE SAME SIX RUNGS the Stock Round uses, read from one
// exported constant rather than retyped, so the price a player may set here
// can never differ from the price they could set there.

import React, { useState } from "react";

import { FONT_SIZE } from "../styles/typography";
import { PAR_VALUE_LADDER } from "./StockRoundPanel";

export interface BoParPromptProps {
  /** `null` when no B&O par is outstanding -- the modal renders nothing. */
  open: boolean;
  /** The name of the player who won the private, for the heading. */
  winnerLabel: string;
  /** Receives the chosen par. The caller grants the certificate with it. */
  onConfirm: (parValue: string) => void;
}

export function BoParPrompt({ open, winnerLabel, onConfirm }: BoParPromptProps) {
  /* Seeded at the top of the ladder rather than left blank. Every rung is
     legal, so there is no "unset" state worth representing -- and a
     pre-selected value means the player can confirm in one click if they do
     not care, rather than being made to choose before they can proceed. */
  const [selected, setSelected] = useState<string>(
    PAR_VALUE_LADDER[PAR_VALUE_LADDER.length - 1],
  );

  if (!open) return null;

  return (
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label="Set the B&O par value">
      <div style={styles.card}>
        <span style={styles.heading}>{winnerLabel} wins the Baltimore &amp; Ohio</span>
        <p style={styles.body}>
          The B&amp;O private hands you the 20% President&rsquo;s Certificate free of charge. Set
          the price the B&amp;O floats at &mdash; every other share will be bought from its IPO at
          this price.
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
            abstract number until it is multiplied by ten, which is what the
            treasury receives at float (design note #134). */}
        <span style={styles.consequence}>
          Floats with ${Number(selected) * 10} in its treasury once 60% is sold.
        </span>

        <button type="button" style={styles.confirm} onClick={() => onConfirm(selected)}>
          Take the President&rsquo;s Certificate at ${selected}
        </button>
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
};

export default BoParPrompt;
