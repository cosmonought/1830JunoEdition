// How the game ended, and who won.
//
// 1830 stops when the bank breaks or a president goes bankrupt. Both were
// reachable and neither had a surface. The REASON leads and the standings
// follow (#1): a broken bank is the ordinary conclusion of a long game and a
// bankruptcy is somebody's disaster, so a modal printing only a scoreboard would
// leave the room arguing about which had occurred.
//
// See docs/ai_architecture/stock_market.md, GameOverModal.tsx #0 / #1.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import type { PlayerStanding } from "../utils/endgame";

export type GameEndReason = "bankruptcy" | "bank-broken";

export interface GameOverModalProps {
  /** `null` while the game is still running -- the modal is absent, not
   *  hidden, so nothing renders behind the rest of the UI. */
  reason: GameEndReason | null;
  standings: readonly PlayerStanding[];
  /** Who the viewer is, for the "You Won!" / "You Went Bankrupt!" line.
   *  `null` for a spectator, who gets the standings without a verdict. */
  viewerAddress: string | null;
  /** The pool the payout column divides. Displayed so the estimate is
   *  legible as an estimate. */
  totalAnte: number;
  /** Named for the bankruptcy headline. */
  bankruptLabel: string | null;
}

export function GameOverModal({
  reason,
  standings,
  viewerAddress,
  totalAnte,
  bankruptLabel,
}: GameOverModalProps) {
  if (!reason) return null;

  const viewer = standings.find((row) => row.address === viewerAddress) ?? null;
  const winner = standings.find((row) => row.isWinner) ?? null;

  /* Design note #1: the verdict is about the VIEWER, and the two headline
     cases are not opposites -- a player can be neither. A spectator, or a
     player who simply came third, gets the neutral heading rather than a
     consolation message nobody asked for. */
  const verdict = !viewer
    ? null
    : viewer.isBankrupt
      ? { text: "You Went Bankrupt!", style: styles.verdictLost }
      : viewer.isWinner
        ? { text: "You Won!", style: styles.verdictWon }
        : null;

  return (
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label="Game Over">
      <div style={styles.panel}>
        <span style={styles.kicker}>Game Over</span>

        {/* Design note #1: why, before who. */}
        <h2 style={styles.reasonHeading}>
          {reason === "bankruptcy"
            ? `${bankruptLabel ?? "A president"} went bankrupt.`
            : "The Bank has run out of money."}
        </h2>
        <p style={styles.reasonBody}>
          {reason === "bankruptcy"
            ? "A corporation could not fund its mandatory train purchase, and its President could not cover the difference from cash or by selling shares. In Project 18XX the game ends immediately."
            : "Project 18XX ends the moment the Bank cannot pay. Final standings are counted from cash, shares at their market price, and private companies at face value."}
        </p>

        {verdict && <div style={{ ...styles.verdict, ...verdict.style }}>{verdict.text}</div>}

        {/* ---- Standings ---- */}
        <div style={styles.table} role="table" aria-label="Final standings">
          <div style={{ ...styles.row, ...styles.headRow }} role="row">
            <span style={styles.cellRank}>#</span>
            <span style={styles.cellName}>Player</span>
            <span style={styles.cellNum}>Cash</span>
            <span style={styles.cellNum}>Stock</span>
            <span style={styles.cellNum}>Privates</span>
            <span style={styles.cellNumStrong}>Net worth</span>
            <span style={styles.cellNum}>Payout</span>
          </div>

          {standings.map((row) => (
            <div
              key={row.address}
              role="row"
              style={{
                ...styles.row,
                ...(row.isWinner ? styles.rowWinner : {}),
                ...(row.isBankrupt ? styles.rowBankrupt : {}),
              }}
            >
              <span style={styles.cellRank}>{row.rank}</span>
              <span style={styles.cellName}>
                {row.label}
                {row.isWinner && <span style={styles.tagWinner}>WINNER</span>}
                {row.isBankrupt && <span style={styles.tagBankrupt}>BANKRUPT</span>}
              </span>
              <span style={styles.cellNum}>${row.cash}</span>
              <span style={styles.cellNum}>${row.stockValue}</span>
              <span style={styles.cellNum}>${row.privateValue}</span>
              <span style={styles.cellNumStrong}>${row.netWorth}</span>
              <span style={styles.cellNum}>${row.expectedPayout.toFixed(2)}</span>
            </div>
          ))}
        </div>

        {/* Design note #4 in `endgame.ts`: the payout is an ESTIMATE and the
            modal says so where the number is, not in a footnote nobody
            reads. Overstating this would be promising real money on a split
            the contract has not agreed to. */}
        <p style={styles.payoutNote}>
          Payout estimated by share of net worth against a ${totalAnte} pool. The real
          distribution is settled on-chain when the room closes.
        </p>

        {winner && (
          <p style={styles.winnerLine}>
            <strong>{winner.label}</strong> wins with ${winner.netWorth}.
          </p>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(6, 8, 12, 0.86)",
    padding: "24px",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    width: "min(680px, 100%)",
    maxHeight: "88vh",
    overflowY: "auto",
    padding: "22px 24px",
    backgroundColor: "#161922",
    border: "1px solid #3a4055",
    borderTop: "3px solid #c9a227",
    borderRadius: "12px",
    boxShadow: "0 22px 60px rgba(0,0,0,0.7)",
    boxSizing: "border-box",
  },
  kicker: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: "#8a919e",
  },
  reasonHeading: { margin: 0, fontSize: FONT_SIZE.display, fontWeight: 800, color: "#f0e2b8" },
  reasonBody: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: 1.5, color: "#c8cbd6" },
  verdict: {
    margin: "4px 0",
    padding: "10px 14px",
    borderRadius: "9px",
    fontSize: FONT_SIZE.heading,
    fontWeight: 800,
    textAlign: "center",
    borderWidth: "1px",
    borderStyle: "solid",
  },
  verdictWon: { backgroundColor: "#17301f", borderColor: "#3f7a55", color: "#9fe9bb" },
  verdictLost: { backgroundColor: "#2a1618", borderColor: "#6b2f2f", color: "#f0c9c9" },
  table: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "8px 10px",
    backgroundColor: "#1b1f29",
    border: "1px solid #2a2e3a",
    borderRadius: "9px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 6px",
    borderRadius: "5px",
    fontSize: FONT_SIZE.small,
    fontVariantNumeric: "tabular-nums",
    color: "#c8cbd6",
  },
  headRow: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "#7f8798",
  },
  rowWinner: { backgroundColor: "#17301f", color: "#dff6e7" },
  rowBankrupt: { backgroundColor: "#2a1618", color: "#f0c9c9" },
  cellRank: { flex: "0 0 22px", color: "#7f8798" },
  cellName: { flex: "1 1 auto", display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
  cellNum: { flex: "0 0 78px", textAlign: "right" },
  cellNumStrong: { flex: "0 0 88px", textAlign: "right", fontWeight: 800, color: "#e6e8ef" },
  tagWinner: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    color: "#0d1117",
    backgroundColor: "#7ee0a1",
    borderRadius: "4px",
    padding: "0 5px",
  },
  tagBankrupt: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    color: "#f0c9c9",
    border: "1px solid #6b2f2f",
    borderRadius: "4px",
    padding: "0 5px",
  },
  payoutNote: { margin: 0, fontSize: FONT_SIZE.micro, color: "#7f8798", lineHeight: 1.45 },
  winnerLine: { margin: 0, fontSize: FONT_SIZE.body, color: "#e6e8ef" },
};

export default GameOverModal;
