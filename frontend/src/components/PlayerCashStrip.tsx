// frontend/src/components/PlayerCashStrip.tsx
//
// EVERY SEAT'S CASH, AND WHAT JUST HAPPENED TO IT.
//
// Design note #670: REPORTED -- "when players click Pay Dividends, it is very
// hard to tell if the game is actually doing so."
//
// The payout worked and the Activity Log described it in a full sentence. Two
// things were missing and only one of them is obvious.
//
//   THE CASH WAS NOT ON SCREEN. `PlayerCards` renders during the Stock Round
//   and the auction; the Operating Round's surface is the Rail Map, whose
//   footer is the corporation panel. So the round in which money is EARNED was
//   the one round showing nobody's balance.
//
//   AND A BALANCE ALONE WOULD NOT HAVE FIXED IT. "$540" confirms a payout only
//   to a reader who had memorised "$530". The badge is the actual answer; the
//   row is what gives it somewhere to sit. `cashDelta.ts` owns the arithmetic.
//
// WHY A STRIP AND NOT THE CARDS. `PlayerCards` is a card per player -- holdings,
// privates, net worth, liquidity -- and it is tall. Underneath an already-tall
// corporation panel, on the one tab where the board is competing for every
// vertical pixel, it would push the thing a player is looking at off screen. The
// question here is narrow ("did that money arrive?") and so is the answer: one
// row per seat, name, cash, badge.
//
// IT IS NOT A SECOND LEDGER, and the omissions are the design. No net worth, no
// holdings, no certificate count -- the Game Ledger answers all three and a
// second opinion on any of them is a fact in two places, which is how the two
// come to disagree (`playerFinance.ts` #562).
//
// See docs/ai_architecture/ui_shell_layout.md, PlayerCashStrip.tsx #670.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import { bestContrastTextColor } from "../styles/corporationLivery";
import { formatCashDelta, type CashDelta } from "../utils/cashDelta";

export interface PlayerCashRow {
  address: string;
  /** `null` when the balance is genuinely unknown -- offline, or before the
   *  first poll. Rendered as an em dash, never as `$0`: design note #562's
   *  rule, and the difference between a player who is broke and a figure
   *  nobody has. */
  cash: number | null;
}

export interface PlayerCashStripProps {
  /** In seating order. */
  players: readonly PlayerCashRow[];
  label: (address: string) => string;
  /** A seat's own colour, by index -- the same resolver every other surface
   *  uses, so a player is one colour everywhere. */
  colorForSeat: (index: number) => string;
  /** Live badges, keyed by address. Absent means nothing recent. */
  deltas: Readonly<Record<string, CashDelta>>;
  /** Whose turn it is, or the seat whose corporation is operating. `null`
   *  outside both, and nothing is marked. */
  activeAddress?: string | null;
  /** Design note #567's rule, applied here: the YOU mark earns its place only
   *  where two seats share a display name. */
  viewerAddress?: string | null;
}

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

/** Design note #562: an em dash, never "$0". */
function money(value: number | null): string {
  return value === null ? "—" : `$${Math.round(value)}`;
}

/** The badge itself, exported because the Stock Round shows cash on
 *  `PlayerCards` rather than here -- and "every cash change is confirmed" is a
 *  claim about the whole app, not about one round. One component, so the two
 *  surfaces cannot drift into signalling the same event two ways.
 *
 *  It carries its own keyframes: a badge that animates on one tab and snaps on
 *  another is a bug the second reader reports and the first cannot reproduce. */
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

export function PlayerCashStrip({
  players,
  label,
  colorForSeat,
  deltas,
  activeAddress = null,
  viewerAddress = null,
}: PlayerCashStripProps) {
  if (players.length === 0) return null;

  /* Design note #567: "is this name shared" is a question about the ROSTER,
     so it is answered once for the strip rather than per row. */
  const nameCounts = new Map<string, number>();
  for (const player of players) {
    const name = label(player.address);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  return (
    <section style={styles.root} aria-label="Player cash">
      <style>{CASH_DELTA_MOTION_CSS}</style>
      <h4 style={styles.title}>Cash</h4>
      <div style={styles.rows}>
        {players.map((player, seatIndex) => {
          const stripe = colorForSeat(seatIndex);
          const delta = deltas[player.address];
          const isActive = player.address === activeAddress;
          const name = label(player.address);
          return (
            <div
              key={player.address}
              style={{
                ...styles.row,
                ...(isActive ? { ...styles.rowActive, borderColor: stripe } : {}),
              }}
              /* The badge is a live region so it is ANNOUNCED rather than merely
                 present: a screen reader lands on this row when it is read, not
                 when the money moves, and a payout that is only visible is a
                 payout half the table cannot confirm. `polite`, because a
                 dividend is news and not an interruption. */
              aria-live="polite"
              aria-label={
                delta
                  ? `${name}, ${money(player.cash)}, ${
                      delta.amount < 0 ? "down" : "up"
                    } ${Math.abs(Math.round(delta.amount))}`
                  : `${name}, ${money(player.cash)}`
              }
            >
              <span
                style={{ ...styles.seatChip, backgroundColor: stripe, color: bestContrastTextColor(stripe) }}
                aria-hidden="true"
              >
                {name.slice(0, 1).toUpperCase()}
              </span>
              <span style={styles.name}>{name}</span>
              {player.address === viewerAddress && (nameCounts.get(name) ?? 0) > 1 && (
                <span style={styles.youTag}>YOU</span>
              )}
              <span style={styles.cash}>{money(player.cash)}</span>
              {delta && <CashDeltaBadge amount={delta.amount} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default PlayerCashStrip;

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "14px 20px",
    backgroundColor: "#161922",
    border: "1px solid #2a2e3a",
    borderRadius: "10px",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  title: {
    margin: 0,
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#c8cbd6",
  },
  /* Wraps rather than scrolls. Six players on a narrow window becomes two
     lines of three, which is readable; a horizontal scroller would hide a seat
     behind a gesture, and a hidden balance is the problem this strip exists to
     solve. */
  rows: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    borderRadius: "8px",
    border: "1px solid #2a2e3a",
    backgroundColor: "#1b1f2a",
    minHeight: "30px",
  },
  rowActive: {
    backgroundColor: "#212736",
  },
  seatChip: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    borderRadius: "4px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
  },
  name: {
    fontSize: FONT_SIZE.body,
    color: "#c8cbd6",
  },
  youTag: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    letterSpacing: "0.06em",
    color: "#8a90a0",
  },
  /* Tabular figures: the balances sit in a wrapping row, and proportional
     digits make two seats' money look like different quantities of text. */
  cash: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.body,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    color: "#e6e8ef",
  },
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
