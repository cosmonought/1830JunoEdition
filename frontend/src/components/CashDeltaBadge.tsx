// frontend/src/components/CashDeltaBadge.tsx
//
// What a player's cash just did, wherever their cash is shown.
//
// Design note #670: REPORTED -- "when players click Pay Dividends, it is very hard to tell if the game is
// actually doing so." A balance alone does not answer that: "$540" confirms a payout only to a reader who had
// memorised "$530". The badge is the actual answer, and `cashDelta.ts` owns the arithmetic behind it.
//
// ONE COMPONENT, SO TWO SURFACES CANNOT SIGNAL ONE EVENT TWO WAYS. "Every cash change is confirmed" is a claim
// about the whole app rather than about one round, so the badge is shared rather than reimplemented -- which
// is the same rule #775 applies to the dividend split and #748a to the market zone.
//
// ==================================================================
//  DESIGN NOTE 819: ITS OWN FILE, BECAUSE ITS OLD HOME HAS GONE
// ==================================================================
//
// It lived in `PlayerCashStrip.tsx` and was exported from there "because the Stock Round shows cash on
// `PlayerCards` rather than here". #819 replaced the strip with the cards in the Operating Round too, so the
// strip is deleted and the badge would have gone with it -- a shared component whose file was named after one
// of its two callers, and the one that stopped existing.
//
// IT CARRIES ITS OWN KEYFRAMES, unchanged and worth restating: a badge that animates on one tab and snaps on
// another is a bug the second reader reports and the first cannot reproduce.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import { formatCashDelta } from "../utils/cashDelta";

/* The badge ARRIVES and LEAVES, and both halves matter. A figure that appears
   instantly reads as part of the row -- something that was always there and the
   reader had not noticed -- which is the exact misreading this whole note is
   about. Sliding it up into place says "this is new".
   The fade-out is CSS-driven off the same class, so the badge's disappearance
   costs the caller nothing: it unmounts when `cashDelta.ts` expires it, and the
   animation is only ever the entrance.
   REDUCED MOTION KEEPS THE BADGE AND LOSES THE MOVEMENT. The information is the
   number, never the animation -- the same rule `PlayerCards` #606 follows for
   its lift, and the reason neither is allowed to be the sole carrier of a
   fact. */
const CASH_DELTA_MOTION_CSS = `
@keyframes app-cash-delta-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.app-cash-delta {
  animation: app-cash-delta-in 220ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
@media (prefers-reduced-motion: reduce) {
  .app-cash-delta { animation: none; }
}
`;

export function CashDeltaBadge({ amount }: { amount: number }) {
  if (amount === 0) return null;
  return (
    <>
      <style>{CASH_DELTA_MOTION_CSS}</style>
      <span
        className="app-cash-delta"
        style={{
          ...styles.delta,
          ...(amount < 0 ? styles.deltaDown : styles.deltaUp),
        }}
      >
        {formatCashDelta(amount)}
      </span>
    </>
  );
}

/* Design note #819: CARRIED OVER EXACTLY, and the first draft of this file did not. I rewrote these from
   memory as a green/red pair, which is precisely the decision the note below had already refused -- three
   lines of reasoning that would have been deleted by a move rather than by an argument. Copied verbatim
   instead, which is what moving a component means. */
const styles: Record<string, React.CSSProperties> = {
  delta: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    padding: "1px 5px",
    borderRadius: "4px",
    border: "1px solid transparent",
  },
  /* Green up, amber down -- NOT red. Red in this app marks a contested
     auction and an error toast, and money leaving a player's hand to buy a
     share is neither. It is ordinary, and it should read as ordinary. */
  deltaUp: {
    color: "#4ea172",
    backgroundColor: "rgba(78, 161, 114, 0.14)",
    borderColor: "rgba(78, 161, 114, 0.35)",
  },
  deltaDown: {
    color: "#c9a94c",
    backgroundColor: "rgba(201, 169, 76, 0.14)",
    borderColor: "rgba(201, 169, 76, 0.35)",
  },
};

export default CashDeltaBadge;
