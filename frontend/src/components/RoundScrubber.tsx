// frontend/src/components/RoundScrubber.tsx
//
/* ==================================================================
    DESIGN NOTE 1425: THE SCRUBBER -- ONE TICK PER ROUND, UNDER THE GAME OVER STRIP
   ==================================================================
   #1430: lives in the status-line dock at the bottom of the window (fixed, above the Activity Log), so it is
   on screen for as long as the ending stands; the minimised epilogue strip at the top stays the way back. A range input does the dragging --
   keyboard arrows, touch and mouse for free -- with ◀ ▶ beside it and the round's label large; the ticks
   under the track are the first OR of each set, which is the rhythm a player remembers a game by. "Final" is the
   live board; anything else is read-only and the shell says so. */

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import type { RoundSample } from "../utils/gameHistory";

export interface RoundScrubberProps {
  rounds: readonly RoundSample[];
  /** The round shown, or `null` for the live (final) board. */
  cursor: number | null;
  onChange: (cursor: number | null) => void;
}

export function RoundScrubber({ rounds, cursor, onChange }: RoundScrubberProps) {
  /* ==================================================================
      DESIGN NOTE 1430: OPERATING ROUNDS ONLY
     ==================================================================
     RULED: "cut [the Stock Rounds] out and just have it move through Operating Rounds -- players can go to
     OR X.1 to see what happened in SR (X-1)." The stops are the ORs plus Final; `cursor` is still an index
     into the full history (the replay needs the log index), so the slider runs over the stops and maps. */
  const stops = rounds
    .map((round, index) => ({ round, index }))
    .filter(({ round, index }) => round.label.startsWith("OR ") || index === rounds.length - 1);
  if (stops.length < 2) return null;
  const last = stops.length - 1;
  const found = cursor === null ? last : stops.findIndex(({ index }) => index >= cursor);
  const at = found === -1 ? last : found;
  const set = (next: number) => onChange(next >= last ? null : stops[Math.max(0, next)].index);
  const label = stops[at]?.round.label ?? "Final";
  return (
    <div style={styles.strip} role="group" aria-label="Round replayer" data-testid="round-scrubber">
      <span style={styles.caption}>Replay</span>
      <button type="button" style={styles.step} onClick={() => set(at - 1)} disabled={at === 0} aria-label="Previous round">
        ◀
      </button>
      <span style={styles.trackWrap}>
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={at}
          onChange={(event) => set(Number(event.target.value))}
          style={styles.range}
          aria-label="Round"
          aria-valuetext={label}
          data-testid="round-scrubber-range"
        />
        <span style={styles.ticks} aria-hidden="true">
          {stops.map(({ round }, i) =>
            round.label.endsWith(".1") || i === last ? (
              <span key={round.label + i} style={{ ...styles.tick, left: `${(100 * i) / last}%` }}>
                {round.label}
              </span>
            ) : null,
          )}
        </span>
      </span>
      <button type="button" style={styles.step} onClick={() => set(at + 1)} disabled={cursor === null} aria-label="Next round">
        ▶
      </button>
      <span style={styles.label} data-testid="round-scrubber-label">
        {cursor === null ? "Final board" : label}
      </span>
      {cursor !== null && (
        <button type="button" style={styles.live} onClick={() => onChange(null)} data-testid="round-scrubber-final">
          Back to final ▸
        </button>
      )}
    </div>
  );
}

export default RoundScrubber;

const styles: Record<string, React.CSSProperties> = {
  strip: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    padding: "6px 20px 14px",
    boxSizing: "border-box",
    /* #1430: in the status-line dock at the bottom of the window, above the Activity Log. */
    backgroundColor: "#15130c",
    borderBottom: "1px solid #4a3e18",
    color: "#f0dfa8",
  },
  caption: { fontSize: FONT_SIZE.micro, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", color: "#8a8a86" },
  step: {
    padding: "2px 9px",
    borderRadius: RADIUS.control,
    border: "1px solid #4a3e18",
    backgroundColor: "#241d0e",
    color: "#f0dfa8",
    fontSize: FONT_SIZE.small,
    cursor: "pointer",
  },
  trackWrap: { position: "relative", flex: 1, minWidth: "160px", display: "flex", flexDirection: "column" },
  range: { width: "100%", margin: 0, accentColor: "#c9a227", cursor: "pointer" },
  ticks: { position: "relative", height: "12px" },
  tick: {
    position: "absolute",
    transform: "translateX(-50%)",
    fontSize: "10px",
    color: "#8a8a86",
    whiteSpace: "nowrap",
  },
  label: { fontSize: FONT_SIZE.body, fontWeight: 800, minWidth: "90px", textAlign: "center", fontVariantNumeric: "tabular-nums" },
  live: {
    padding: "3px 10px",
    borderRadius: RADIUS.control,
    border: "1px solid #7a6320",
    backgroundColor: "#3a2f10",
    color: "#f0dfa8",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
};
