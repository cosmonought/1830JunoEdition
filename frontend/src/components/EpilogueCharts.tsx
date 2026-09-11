// frontend/src/components/EpilogueCharts.tsx
//
// The Game Over modal's charts: share prices by round, net worth by round, and the ownership split behind a
// chosen corporation. Design note #1411 (`utils/gameHistory.ts`) says where the figures come from; this file
// only draws them.
//
// HAND-DRAWN SVG, NOT A CHART LIBRARY. The app carries no charting dependency and these are two line charts
// and a table: a `<polyline>` per series, a handful of gridlines, and a legend that doubles as the selector.
// The x axis is the round index (every sample equally spaced, since "SR 3" and "OR 3.2" are the units a
// player thinks in), the y axis is dollars with a little headroom. Nothing animates; the modal is the
// post-mortem and the picture should sit still while people point at it.

import React, { useMemo, useState } from "react";
import type { GameHistory, RoundSample } from "../utils/gameHistory";
import { FONT_SIZE, RADIUS } from "../styles/typography";

const WIDTH = 900;
const HEIGHT = 340;
const PAD = { left: 56, right: 18, top: 16, bottom: 34 };

function niceStep(range: number): number {
  const rough = range / 5;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude);
  return candidates.find((c) => c >= rough) ?? candidates[candidates.length - 1];
}

interface Series {
  key: string;
  label: string;
  color: string;
  /** One point per round; `null` where the series has no value yet (a corporation not on the chart). */
  values: ReadonlyArray<number | null>;
}

function LineChart({
  rounds,
  series,
  selected,
  onSelect,
  ariaLabel,
}: {
  rounds: readonly RoundSample[];
  series: readonly Series[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  ariaLabel: string;
}) {
  const scale = useMemo(() => {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    const max = Math.max(100, ...all);
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const n = Math.max(1, rounds.length - 1);
    return {
      x: (i: number) => PAD.left + (plotW * i) / n,
      y: (v: number) => PAD.top + plotH - (plotH * v) / top,
      top,
      step,
      plotH,
    };
  }, [series, rounds.length]);

  const ticks: number[] = [];
  for (let v = 0; v <= scale.top; v += scale.step) ticks.push(v);
  // Label every round when there is room, else every other, else every third.
  const every = rounds.length > 30 ? 3 : rounds.length > 16 ? 2 : 1;

  return (
    <div style={styles.chartBlock}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={styles.svg} role="img" aria-label={ariaLabel}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={scale.y(v)} y2={scale.y(v)} stroke="#2a2a2a" strokeWidth={1} />
            <text x={PAD.left - 8} y={scale.y(v) + 4} textAnchor="end" fill="#8a8a86" fontSize={12}>
              ${v}
            </text>
          </g>
        ))}
        {rounds.map((round, i) =>
          // The last label always shows; the one just before it yields to it when labels are thinned.
          i === rounds.length - 1 || (i % every === 0 && (every === 1 || i < rounds.length - 2)) ? (
            <text key={round.label + i} x={scale.x(i)} y={HEIGHT - 10} textAnchor="middle" fill="#8a8a86" fontSize={11}>
              {round.label}
            </text>
          ) : null,
        )}
        {series.map((s) => {
          const dim = selected !== null && selected !== s.key;
          const segments: string[] = [];
          let current: string[] = [];
          s.values.forEach((v, i) => {
            if (v === null) {
              if (current.length > 0) segments.push(current.join(" "));
              current = [];
              return;
            }
            current.push(`${scale.x(i)},${scale.y(v)}`);
          });
          if (current.length > 0) segments.push(current.join(" "));
          return (
            <g key={s.key} opacity={dim ? 0.18 : 1} style={{ cursor: "pointer" }} onClick={() => onSelect(selected === s.key ? null : s.key)}>
              {segments.map((points, i) => (
                <polyline key={i} points={points} fill="none" stroke={s.color} strokeWidth={selected === s.key ? 4 : 2.5} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {s.values.map((v, i) =>
                v === null ? null : <circle key={i} cx={scale.x(i)} cy={scale.y(v)} r={selected === s.key ? 4 : 2.5} fill={s.color} />,
              )}
            </g>
          );
        })}
      </svg>
      <div style={styles.legend}>
        {series.map((s) => {
          const last = [...s.values].reverse().find((v) => v !== null) ?? null;
          const active = selected === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onSelect(active ? null : s.key)}
              style={{
                ...styles.legendItem,
                borderColor: s.color,
                ...(active ? { backgroundColor: "#1d1d1d", boxShadow: `inset 0 0 0 1px ${s.color}` } : {}),
                ...(selected !== null && !active ? { opacity: 0.45 } : {}),
              }}
              aria-pressed={active}
            >
              <span style={{ ...styles.swatch, backgroundColor: s.color }} aria-hidden="true" />
              <span>{s.label}</span>
              <span style={styles.legendValue}>{last === null ? "—" : `$${last}`}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StockPriceChart({
  history,
  corporationColor,
  playerLabel,
}: {
  history: GameHistory;
  corporationColor: (companyId: number) => string;
  playerLabel: (address: string) => string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const series = useMemo<Series[]>(
    () =>
      history.corporations
        .filter((corp) => history.rounds.some((r) => r.corporations.find((c) => c.companyId === corp.companyId)?.price != null))
        .map((corp) => ({
          key: String(corp.companyId),
          label: corp.ticker,
          color: corporationColor(corp.companyId),
          values: history.rounds.map((r) => r.corporations.find((c) => c.companyId === corp.companyId)?.price ?? null),
        })),
    [history, corporationColor],
  );
  const chosen = selected === null ? null : history.corporations.find((c) => String(c.companyId) === selected) ?? null;

  return (
    <div style={styles.page}>
      <h3 style={styles.pageTitle}>Share prices by round</h3>
      <p style={styles.pageHint}>Click a corporation to see who held its shares in each round.</p>
      <LineChart rounds={history.rounds} series={series} selected={selected} onSelect={setSelected} ariaLabel="Share prices by round" />
      {chosen && (
        <div style={styles.table} role="table" aria-label={`${chosen.ticker} ownership by round`}>
          <div style={{ ...styles.row, ...styles.headRow }} role="row">
            <span style={styles.cellRound}>Round</span>
            <span style={styles.cellNum}>Price</span>
            {history.players.map((p) => (
              <span key={p} style={styles.cellNum}>
                {playerLabel(p)}
              </span>
            ))}
            <span style={styles.cellNum}>IPO</span>
            <span style={styles.cellNum}>Pool</span>
          </div>
          {history.rounds.map((round) => {
            const corp = round.corporations.find((c) => c.companyId === chosen.companyId);
            if (!corp) return null;
            return (
              <div key={round.label} style={styles.row} role="row">
                <span style={styles.cellRound}>{round.label}</span>
                <span style={styles.cellNum}>{corp.price === null ? "—" : `$${corp.price}`}</span>
                {history.players.map((p) => {
                  const held = corp.holdings.find(([address]) => address === p)?.[1] ?? 0;
                  const president = corp.president === p;
                  return (
                    <span key={p} style={{ ...styles.cellNum, ...(president ? styles.cellPresident : {}), ...(held === 0 ? styles.cellZero : {}) }}>
                      {held === 0 ? "·" : `${held}%`}
                      {president ? " ♛" : ""}
                    </span>
                  );
                })}
                <span style={{ ...styles.cellNum, ...(corp.ipoPercentage === 0 ? styles.cellZero : {}) }}>{corp.ipoPercentage === 0 ? "·" : `${corp.ipoPercentage}%`}</span>
                <span style={{ ...styles.cellNum, ...(corp.poolPercentage === 0 ? styles.cellZero : {}) }}>{corp.poolPercentage === 0 ? "·" : `${corp.poolPercentage}%`}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function NetWorthChart({
  history,
  playerLabel,
  playerColor,
}: {
  history: GameHistory;
  playerLabel: (address: string) => string;
  playerColor: (address: string) => string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const series = useMemo<Series[]>(
    () =>
      history.players.map((address) => ({
        key: address,
        label: playerLabel(address),
        color: playerColor(address),
        values: history.rounds.map((r) => r.players.find((p) => p.address === address)?.netWorth ?? null),
      })),
    [history, playerLabel, playerColor],
  );
  const chosen = selected;
  return (
    <div style={styles.page}>
      <h3 style={styles.pageTitle}>Net worth by round</h3>
      <p style={styles.pageHint}>Cash plus shares at market. Click a player to see the cash and stock split each round.</p>
      <LineChart rounds={history.rounds} series={series} selected={selected} onSelect={setSelected} ariaLabel="Net worth by round" />
      {chosen && (
        <div style={styles.table} role="table" aria-label={`${playerLabel(chosen)} by round`}>
          <div style={{ ...styles.row, ...styles.headRow }} role="row">
            <span style={styles.cellRound}>Round</span>
            <span style={styles.cellNum}>Cash</span>
            <span style={styles.cellNum}>Stock</span>
            <span style={styles.cellNumStrong}>Net worth</span>
          </div>
          {history.rounds.map((round) => {
            const p = round.players.find((entry) => entry.address === chosen);
            if (!p) return null;
            return (
              <div key={round.label} style={styles.row} role="row">
                <span style={styles.cellRound}>{round.label}</span>
                <span style={styles.cellNum}>{p.cash === null ? "—" : `$${p.cash}`}</span>
                <span style={styles.cellNum}>{p.stockValue === null ? "—" : `$${p.stockValue}`}</span>
                <span style={styles.cellNumStrong}>{p.netWorth === null ? "—" : `$${p.netWorth}`}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: "flex", flexDirection: "column", gap: "10px" },
  pageTitle: { margin: 0, fontSize: "20px", fontWeight: 800, color: "#f0e2b8" },
  pageHint: { margin: 0, fontSize: FONT_SIZE.small, color: "#8a8a86" },
  chartBlock: { display: "flex", flexDirection: "column", gap: "8px" },
  svg: { width: "100%", height: "auto", display: "block", backgroundColor: "#141414", border: "1px solid #2a2a2a", borderRadius: RADIUS.card },
  legend: { display: "flex", flexWrap: "wrap", gap: "6px" },
  legendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 10px",
    borderRadius: RADIUS.pill,
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "transparent",
    color: "#e8e6e0",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
  legendValue: { color: "#8a8a86", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  swatch: { width: "10px", height: "10px", borderRadius: RADIUS.circle, display: "inline-block" },
  table: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "10px 12px",
    backgroundColor: "#141414",
    border: "1px solid #2a2a2a",
    borderRadius: RADIUS.card,
    maxHeight: "34vh",
    overflowY: "auto",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 6px",
    borderRadius: RADIUS.control,
    fontSize: FONT_SIZE.body,
    fontVariantNumeric: "tabular-nums",
    color: "#c8c6c0",
  },
  headRow: { fontSize: FONT_SIZE.micro, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", color: "#8a8a86" },
  cellRound: { flex: "0 0 72px", color: "#8a8a86" },
  cellNum: { flex: "1 1 80px", textAlign: "right", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  cellNumStrong: { flex: "1 1 96px", textAlign: "right", fontWeight: 800, color: "#f2f0eb" },
  cellPresident: { color: "#f0dfa8", fontWeight: 700 },
  cellZero: { color: "#4a4a48" },
};
