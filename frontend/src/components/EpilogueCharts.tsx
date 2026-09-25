// frontend/src/components/EpilogueCharts.tsx
//
// The Game Over modal's charts and tables: share prices by round, operating revenue by round, net worth by
// round with a portfolio stack, the corporation autopsy, and the accolades. Design notes #1411 and #1414
// (`utils/gameHistory.ts`) say where the figures come from; this file only draws them.
//
// HAND-DRAWN SVG, NOT A CHART LIBRARY. The app carries no charting dependency and these are two line charts,
// one bar chart, one stacked area and three tables: a `<polyline>` per series, a handful of gridlines, and a
// legend that doubles as the selector. The x axis is the round index (every sample equally spaced, since
// "SR 3" and "OR 3.2" are the units a player thinks in), the y axis is dollars with a little headroom.
// Nothing animates; the modal is the post-mortem and the picture should sit still while people point at it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameHistory, RoundSample } from "../utils/gameHistory";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { marketZoneForPrice, ZONE_TEXT_COLORS } from "./StockMarketRenderer";
import { AccoladeBadges, AccoladeGlyph } from "./accoladeGlyphs";
import { CorporateLogo } from "./CorporateLogo";
import { mixHex, relativeLuminance } from "../styles/corporationLivery";

/* ==================================================================
    DESIGN NOTE 1423: A BLACK LINE ON A BLACK CHART
   ==================================================================
   REPORTED: "NYC is impossible to see in the Game End charts. Its acronym is also impossible to see on the
   Corporation Autopsy page." NYC's livery is near-black (#1a1a1a, `corporationLivery` #32) and every surface
   here is #0f0f0f. The livery is right for a token on a map; as INK on this ground it vanishes. So the chart
   asks for the livery and then lifts anything too dark toward white until it reads -- a dark grey line and a
   dark grey ticker, still recognisably NYC's, at about 6:1. Colours that already read pass through untouched. */
const CHART_GROUND_LUMINANCE = 0.006; // #0f0f0f
const MIN_CHART_CONTRAST = 4.5;
export function chartInk(color: string): string {
  const contrast = (hex: string) => (relativeLuminance(hex) + 0.05) / (CHART_GROUND_LUMINANCE + 0.05);
  /* #1436: "The NYC color got lightened and it's now indistinguishable from N&W." Lifting near-black by
     mixing in white lands on the same mid grey the N&W's dark grey lifts to. So a livery that is
     essentially black (NYC, #1a1a1a) goes to WHITE ink on the dark chart, and only the mid greys take the
     lift -- one is white, the other grey, as asked. */
  if (relativeLuminance(color) < 0.02) return "#ececec";
  let ink = color;
  for (let step = 0; step < 8 && contrast(ink) < MIN_CHART_CONTRAST; step += 1) ink = mixHex(ink, "#ffffff", 20);
  return ink;
}

/* ==================================================================
    DESIGN NOTE 1436: THE CHART FILLS ITS BOX, ONE CSS PIXEL PER UNIT
   ==================================================================
   REPORTED: "The Revenue chart on my screen is ridiculously small compared to the size of the modal... I'd
   expect the y-axis to print on the left side of my modal screen and the x-axis to match the width of my
   modal screen, but neither do." A fixed 900x340 viewBox at 100% width, capped at 46vh, letterboxed: on a
   wide window the SVG hit the height cap first and the drawing sat in the middle third with dead space
   either side. Now the SVG's box is MEASURED (a ResizeObserver on the wrapper the flex layout sizes) and
   the viewBox is that box in CSS pixels, so the axes are drawn at the edges of the space the page gives
   the chart, the fonts are real pixels, and the chart is as wide as the modal and as tall as what is left
   under the tabs and above the legend. `DEFAULT_BOX` is what a renderer with no ResizeObserver (jsdom)
   draws. */
interface Box { width: number; height: number }
const DEFAULT_BOX: Box = { width: 900, height: 340 };
const PAD = { left: 60, right: 18, top: 18, bottom: 34 };

function useChartBox(): [React.RefCallback<HTMLDivElement>, Box] {
  const [box, setBox] = useState<Box>(DEFAULT_BOX);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const read = () => {
      /* LAYOUT pixels (`clientWidth`), not `getBoundingClientRect` -- the shell scales the UI with CSS `zoom`
         (#1436a: "the modal still feels like it has a lot of empty space"), and the rect comes back in zoomed
         pixels, so a box measured that way and drawn at that width rendered at zoom-squared: three quarters
         of its space on a 0.75 zoom. The SVG's width attribute is a layout length; feed it layout lengths. */
      const next = { width: Math.max(320, node.clientWidth), height: Math.max(160, node.clientHeight) };
      setBox((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    read();
    observer.current = new ResizeObserver(read);
    observer.current.observe(node);
  }, []);
  return [ref, box];
}

function niceStep(range: number): number {
  const rough = range / 5;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude);
  return candidates.find((c) => c >= rough) ?? candidates[candidates.length - 1];
}

const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

interface Series {
  key: string;
  label: string;
  color: string;
  /** One point per round; `null` where the series has no value yet (a corporation not on the chart). */
  values: ReadonlyArray<number | null>;
  /** Optional per-point ring colour -- #1414: a share price's market zone. */
  rings?: ReadonlyArray<string | null>;
}

/** #1414: where the train phase changes between samples, for the vertical markers. */
function phaseMarkers(rounds: readonly RoundSample[]): Array<{ at: number; label: string }> {
  const out: Array<{ at: number; label: string }> = [];
  rounds.forEach((round, i) => {
    if (i === 0 || round.phase === null || round.phase === rounds[i - 1].phase) return;
    out.push({ at: i, label: `Phase ${round.phase}` });
  });
  return out;
}

function useScale(rounds: readonly RoundSample[], values: readonly number[], box: Box) {
  return useMemo(() => {
    const max = Math.max(100, ...values);
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const plotW = box.width - PAD.left - PAD.right;
    const plotH = box.height - PAD.top - PAD.bottom;
    const n = Math.max(1, rounds.length - 1);
    return {
      x: (i: number) => PAD.left + (plotW * i) / n,
      y: (v: number) => PAD.top + plotH - (plotH * v) / top,
      top,
      step,
      plotW,
      plotH,
      box,
    };
  }, [rounds.length, values, box]);
}

function Axes({ rounds, scale, markers }: { rounds: readonly RoundSample[]; scale: ReturnType<typeof useScale>; markers: boolean }) {
  const ticks: number[] = [];
  for (let v = 0; v <= scale.top; v += scale.step) ticks.push(v);
  /* #1436: thin the round labels by the pixels each has, not by a fixed count. */
  const perLabel = scale.plotW / Math.max(1, rounds.length - 1);
  const every = perLabel >= 44 ? 1 : perLabel >= 22 ? 2 : perLabel >= 15 ? 3 : 4;
  const { width, height } = scale.box;
  return (
    <>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={width - PAD.right} y1={scale.y(v)} y2={scale.y(v)} stroke="#2a2a2a" strokeWidth={1} />
          <text x={PAD.left - 8} y={scale.y(v) + 4} textAnchor="end" fill="#8a8a86" fontSize={12}>
            {fmt(v)}
          </text>
        </g>
      ))}
      {rounds.map((round, i) =>
        // The last label always shows; the one just before it yields to it when labels are thinned.
        i === rounds.length - 1 || (i % every === 0 && (every === 1 || i < rounds.length - 2)) ? (
          <text key={round.label + i} x={scale.x(i)} y={height - 10} textAnchor="middle" fill="#8a8a86" fontSize={11}>
            {round.label}
          </text>
        ) : null,
      )}
      {markers &&
        phaseMarkers(rounds).map((m) => (
          <g key={m.label + m.at}>
            <line x1={scale.x(m.at)} x2={scale.x(m.at)} y1={PAD.top} y2={height - PAD.bottom} stroke="#6b5a2a" strokeWidth={1} strokeDasharray="4 4" />
            <text x={scale.x(m.at) + 4} y={PAD.top + 11} fill="#c9a94c" fontSize={10} fontWeight={700}>
              {m.label}
            </text>
          </g>
        ))}
    </>
  );
}

function Legend({ series, selected, onSelect }: { series: readonly Series[]; selected: string | null; onSelect: (key: string | null) => void }) {
  return (
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
            <span style={styles.legendValue}>{last === null ? "—" : fmt(last)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** #1432: how long a line takes to draw itself on. */
export const DRAW_MS = 1400;
const CHART_CSS = `
@keyframes epilogue-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes epilogue-point { from { opacity: 0; transform: scale(0.2); } to { opacity: 1; transform: scale(1); } }
.epilogue-draw { stroke-dasharray: 1; stroke-dashoffset: 0; animation: epilogue-draw ${DRAW_MS}ms cubic-bezier(0.3, 0, 0.2, 1) both; }
.epilogue-point { transform-box: fill-box; transform-origin: center; animation: epilogue-point 260ms ease-out both; }
@keyframes epilogue-bar { from { transform: scaleY(0); } to { transform: scaleY(1); } }
.epilogue-bar { transform-box: fill-box; transform-origin: bottom; animation: epilogue-bar 420ms cubic-bezier(0.2, 0.7, 0.2, 1) both; }
@media (prefers-reduced-motion: reduce) { .epilogue-draw, .epilogue-point, .epilogue-bar { animation: none; } }
`;

function LineChart({
  rounds,
  series,
  selected,
  onSelect,
  ariaLabel,
  markers = false,
  compact = false,
  animate = false,
}: {
  rounds: readonly RoundSample[];
  series: readonly Series[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  ariaLabel: string;
  markers?: boolean;
  /** #1430: half height, when another chart shares the page. */
  compact?: boolean;
  /** #1432: draw the lines on when the chart mounts (the first time a page is seen). */
  animate?: boolean;
}) {
  const all = useMemo(() => series.flatMap((s) => s.values.filter((v): v is number => v !== null)), [series]);
  const [boxRef, box] = useChartBox(); // #1436
  const scale = useScale(rounds, all, box);
  /* ==================================================================
      DESIGN NOTE 1432: THE LINES DRAW THEMSELVES ON
     ==================================================================
     "I wonder if the first time a player views the charts or clicks a specific corporation they could
     animate?" -- they do. Every line is a polyline with `pathLength=1`, so a dash of length 1 offset by 1 is
     the line hidden, and a keyframe running the offset to 0 draws it left to right in DRAW_MS; the points
     fade in along the way, each delayed by its share of the width. Two triggers: the whole chart on the
     first mount of a page (`animate`, latched, since the parent flips it off once the page is seen), and
     the one series a player clicks -- its group is keyed on being selected, so it remounts and redraws
     alone, wider. `prefers-reduced-motion` gets the finished chart. */
  const [drawAll] = useState(animate);
  return (
    <div style={styles.chartBlock}>
      <style>{CHART_CSS}</style>
      <div ref={boxRef} style={compact ? styles.chartBoxCompact : styles.chartBox}>
      <svg viewBox={`0 0 ${box.width} ${box.height}`} width={box.width} height={box.height} style={styles.svg} role="img" aria-label={ariaLabel}>
        <Axes rounds={rounds} scale={scale} markers={markers} />
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
          const wide = selected === s.key;
          const draw = drawAll || wide;
          const n = Math.max(1, s.values.length - 1);
          return (
            <g
              key={`${s.key}:${wide ? "chosen" : ""}`}
              opacity={dim ? 0.18 : 1}
              style={{ cursor: "pointer" }}
              onClick={() => onSelect(selected === s.key ? null : s.key)}
              data-testid={draw ? "epilogue-line-drawing" : undefined}
            >
              {segments.map((points, i) => (
                <polyline
                  key={i}
                  points={points}
                  pathLength={1}
                  className={draw ? "epilogue-draw" : undefined}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={wide ? 4 : 2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
              {s.values.map((v, i) => {
                if (v === null) return null;
                const ring = s.rings?.[i] ?? null;
                return (
                  <circle
                    key={i}
                    cx={scale.x(i)}
                    cy={scale.y(v)}
                    r={ring ? (wide ? 5 : 3.5) : wide ? 4 : 2.5}
                    fill={ring ? "#141414" : s.color}
                    stroke={ring ?? s.color}
                    strokeWidth={ring ? 2 : 0}
                    className={draw ? "epilogue-point" : undefined}
                    style={draw ? { animationDelay: `${Math.round((DRAW_MS * i) / n)}ms` } : undefined}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      </div>
      <Legend series={series} selected={selected} onSelect={onSelect} />
    </div>
  );
}

/* ---- Page: share prices ---------------------------------------------- */

export function StockPriceChart({
  history,
  corporationColor,
  playerLabel,
  animate = false,
  selected: controlled,
  onSelect,
}: {
  history: GameHistory;
  corporationColor: (companyId: number) => string;
  playerLabel: (address: string) => string;
  /** #1432: draw the lines on -- the first time the page is seen. */
  animate?: boolean;
  /** #1433: the Charts page owns the chosen corporation so it carries across Revenue and Prices. */
  selected?: string | null;
  onSelect?: (key: string | null) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const selected = controlled === undefined ? own : controlled;
  const setSelected = onSelect ?? setOwn;
  const series = useMemo<Series[]>(
    () =>
      history.corporations
        .filter((corp) => history.rounds.some((r) => r.corporations.find((c) => c.companyId === corp.companyId)?.price != null))
        .map((corp) => {
          const values = history.rounds.map((r) => r.corporations.find((c) => c.companyId === corp.companyId)?.price ?? null);
          return {
            key: String(corp.companyId),
            label: corp.ticker,
            color: chartInk(corporationColor(corp.companyId)),
            values,
            /* #1414: a point in the Yellow / Orange / Brown zone wears that zone's ring -- the "dumped" half of
               the picture, without a second chart on the 2D ladder. */
            rings: values.map((price) => {
              const zone = marketZoneForPrice(price);
              return zone && zone !== "Normal" ? ZONE_TEXT_COLORS[zone] ?? null : null;
            }),
          };
        }),
    [history, corporationColor],
  );
  const chosen = selected === null ? null : history.corporations.find((c) => String(c.companyId) === selected) ?? null;

  return (
    <div style={styles.page}>
      <h3 style={styles.pageTitle}>Share prices by round</h3>
      <p style={styles.pageHint}>
        Click a corporation to see who held its shares in each round. A ringed point is a price in the yellow, orange or brown zone.
      </p>
      <LineChart rounds={history.rounds} series={series} selected={selected} onSelect={setSelected} ariaLabel="Share prices by round" animate={animate} />
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
                <span style={styles.cellNum}>{corp.price === null ? "—" : fmt(corp.price)}</span>
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

/* ---- The bar chart: revenue and dividends share it (#1414/#1434) ------ */

function BarChart({
  rounds,
  series,
  selected,
  onSelect,
  ariaLabel,
  animate,
}: {
  rounds: readonly RoundSample[];
  series: readonly Series[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  ariaLabel: string;
  animate: boolean;
}) {
  const [growAll] = useState(animate); // #1432
  const all = useMemo(() => series.flatMap((s) => s.values.filter((v): v is number => v !== null)), [series]);
  const [boxRef, box] = useChartBox(); // #1436
  const scale = useScale(rounds, all, box);
  const groupW = rounds.length > 1 ? scale.plotW / (rounds.length - 1) : scale.plotW;
  const barW = Math.max(2, Math.min(22, (groupW * 0.8) / Math.max(1, series.length)));
  return (
    <div style={styles.chartBlock}>
      <style>{CHART_CSS}</style>
      <div ref={boxRef} style={styles.chartBox}>
      <svg viewBox={`0 0 ${box.width} ${box.height}`} width={box.width} height={box.height} style={styles.svg} role="img" aria-label={ariaLabel}>
        <Axes rounds={rounds} scale={scale} markers />
        {rounds.map((round, i) => {
          const shown = series.filter((s) => s.values[i] !== null);
          const x0 = scale.x(i) - (barW * shown.length) / 2;
          return shown.map((s, j) => {
            const v = s.values[i] as number;
            const dim = selected !== null && selected !== s.key;
            /* #1432: bars grow up from the baseline, round by round; a clicked series' bars regrow. */
            const chosen = selected === s.key;
            const grow = growAll || chosen;
            return (
              <rect
                key={`${round.label}-${s.key}:${chosen ? "chosen" : ""}`}
                x={x0 + j * barW}
                y={scale.y(v)}
                width={Math.max(1, barW - 1)}
                height={Math.max(0, box.height - PAD.bottom - scale.y(v))}
                fill={s.color}
                opacity={dim ? 0.18 : 0.95}
                className={grow ? "epilogue-bar" : undefined}
                style={{ cursor: "pointer", ...(grow ? { animationDelay: `${Math.round((DRAW_MS * i) / Math.max(1, rounds.length - 1))}ms` } : {}) }}
                onClick={() => onSelect(selected === s.key ? null : s.key)}
              >
                <title>{`${round.label} · ${s.label} ${fmt(v)}`}</title>
              </rect>
            );
          });
        })}
      </svg>
      </div>
      <Legend series={series} selected={selected} onSelect={onSelect} />
    </div>
  );
}

/* ---- Page: operating revenue (#1414) ------------------------------- */

export function RevenueChart({
  history,
  corporationColor,
  animate = false,
  selected: controlled,
  onSelect,
}: {
  history: GameHistory;
  corporationColor: (companyId: number) => string;
  animate?: boolean;
  selected?: string | null;
  onSelect?: (key: string | null) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const selected = controlled === undefined ? own : controlled;
  const setSelected = onSelect ?? setOwn;
  /* Operating Rounds only: a Stock Round runs nothing, and "Final" repeats the last OR's figure. */
  const rounds = useMemo(() => history.rounds.filter((r) => r.label.startsWith("OR ")), [history]);
  const series = useMemo<Series[]>(
    () =>
      history.corporations
        .filter((corp) => rounds.some((r) => (r.corporations.find((c) => c.companyId === corp.companyId)?.revenue ?? 0) > 0))
        .map((corp) => ({
          key: String(corp.companyId),
          label: corp.ticker,
          color: chartInk(corporationColor(corp.companyId)),
          values: rounds.map((r) => {
            const c = r.corporations.find((entry) => entry.companyId === corp.companyId);
            return c && c.floated ? c.revenue : null;
          }),
        })),
    [history, rounds, corporationColor],
  );

  return (
    <div style={styles.page}>
      <h3 style={styles.pageTitle}>Operating revenue by round</h3>
      {/* UR-6 (Appendix B item 14): "ran for" is the Activity Log's own word for the revenue a turn PAID -- the turn
          sentence "B&O ran for $X." states the figure after the Unpredictable Revenue die -- and that is the figure this
          chart draws since UR-5 (OD-UR-6.1: corporation / turn revenue is the paid revenue). The hint already says it,
          on every table; checked, not changed. */}
      <p style={styles.pageHint}>What each corporation's trains ran for in every Operating Round. Click a corporation to single it out.</p>
      <BarChart rounds={rounds} series={series} selected={selected} onSelect={setSelected} ariaLabel="Operating revenue by round" animate={animate} />
    </div>
  );
}

/* ---- Page: dividends (#1434) --------------------------------------- */

/* ==================================================================
    DESIGN NOTE 1434: DIVIDENDS, PER PLAYER, PER ROUND
   ==================================================================
   ASKED: "instead of Net Worth (which maybe should be its own chart), would it make sense to show Dividends
   (per player, per round) on the Charts page?" It does: it is the player-side twin of the revenue bars --
   what the trains ran for, then what that paid whom -- and it charts the same way, grouped bars over the
   Operating Rounds in the seat colours. `PlayerSample.dividends` is written as each declaration pays, the
   way #1420 writes a run's revenue onto the round it happened in. Net worth is a different kind of picture
   (a running total, with the portfolio stack behind it) and is its own tab. */
export function DividendsChart({
  history,
  playerLabel,
  playerColor,
  animate = false,
}: {
  history: GameHistory;
  playerLabel: (address: string) => string;
  playerColor: (address: string) => string;
  animate?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const rounds = useMemo(() => history.rounds.filter((r) => r.label.startsWith("OR ")), [history]);
  const series = useMemo<Series[]>(
    () =>
      history.players.map((address) => ({
        key: address,
        label: playerLabel(address),
        color: playerColor(address),
        values: rounds.map((r) => r.players.find((p) => p.address === address)?.dividends ?? 0),
      })),
    [history, rounds, playerLabel, playerColor],
  );
  return (
    <div style={styles.page}>
      <h3 style={styles.pageTitle}>Dividends by round</h3>
      <p style={styles.pageHint}>What each player was paid in every Operating Round, across all their shares. Click a player to single them out.</p>
      <BarChart rounds={rounds} series={series} selected={selected} onSelect={setSelected} ariaLabel="Dividends by round" animate={animate} />
    </div>
  );
}

/* ---- Page: net worth, with the portfolio stack (#1414) ------------- */

export function NetWorthChart({
  history,
  playerLabel,
  playerColor,
  corporationColor,
  animate = false,
}: {
  history: GameHistory;
  playerLabel: (address: string) => string;
  playerColor: (address: string) => string;
  corporationColor: (companyId: number) => string;
  animate?: boolean;
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
  return (
    <div style={styles.page}>
      <h3 style={styles.pageTitle}>Net worth by round</h3>
      <p style={styles.pageHint}>Cash, privates and shares at market. Dashed lines mark a train phase beginning. Click a player to see how their wealth was made up each round.</p>
      <LineChart rounds={history.rounds} series={series} selected={selected} onSelect={setSelected} ariaLabel="Net worth by round" markers compact={selected !== null} animate={animate} />
      {selected && <PortfolioStack history={history} address={selected} playerLabel={playerLabel} corporationColor={corporationColor} />}
    </div>
  );
}

/** #1414: one player's wealth as stacked areas -- cash at the bottom, privates, then equity by corporation
 *  in livery colours. "Who stayed cash-heavy versus who leveraged 100% into shares" is the shape of the
 *  bottom band. */
function PortfolioStack({
  history,
  address,
  playerLabel,
  corporationColor,
}: {
  history: GameHistory;
  address: string;
  playerLabel: (address: string) => string;
  corporationColor: (companyId: number) => string;
}) {
  const rounds = history.rounds;
  const layers = useMemo(() => {
    const corps = history.corporations.filter((corp) =>
      rounds.some((r) => (r.players.find((p) => p.address === address)?.equity ?? []).some(([id, v]) => id === corp.companyId && v > 0)),
    );
    const bands: Array<{ key: string; label: string; color: string; values: number[] }> = [
      { key: "cash", label: "Cash", color: "#8a8f94", values: rounds.map((r) => r.players.find((p) => p.address === address)?.cash ?? 0) },
      { key: "privates", label: "Privates", color: "#c9a94c", values: rounds.map((r) => r.players.find((p) => p.address === address)?.privateValue ?? 0) },
      ...corps.map((corp) => ({
        key: `corp-${corp.companyId}`,
        label: corp.ticker,
        color: chartInk(corporationColor(corp.companyId)),
        values: rounds.map((r) => (r.players.find((p) => p.address === address)?.equity ?? []).find(([id]) => id === corp.companyId)?.[1] ?? 0),
      })),
    ];
    // Cumulative tops, bottom-up.
    const tops: number[][] = [];
    const running = rounds.map(() => 0);
    for (const band of bands) {
      tops.push(band.values.map((v, i) => (running[i] += v)));
    }
    return { bands, tops };
  }, [history, rounds, address, corporationColor]);
  const [boxRef, box] = useChartBox(); // #1436
  const scale = useScale(rounds, layers.tops[layers.tops.length - 1] ?? [0], box);

  return (
    <div style={styles.chartBlock}>
      <h4 style={styles.subTitle}>{playerLabel(address)}'s portfolio</h4>
      <div ref={boxRef} style={styles.chartBoxCompact}>
      <svg viewBox={`0 0 ${box.width} ${box.height}`} width={box.width} height={box.height} style={styles.svg} role="img" aria-label={`${playerLabel(address)}'s portfolio by round`}>
        <Axes rounds={rounds} scale={scale} markers />
        {layers.bands.map((band, b) => {
          const top = layers.tops[b];
          const bottom = b === 0 ? rounds.map(() => 0) : layers.tops[b - 1];
          const upper = top.map((v, i) => `${scale.x(i)},${scale.y(v)}`);
          const lower = bottom.map((v, i) => `${scale.x(i)},${scale.y(v)}`).reverse();
          return (
            <polygon key={band.key} points={[...upper, ...lower].join(" ")} fill={band.color} opacity={0.82} stroke="#141414" strokeWidth={1}>
              <title>{band.label}</title>
            </polygon>
          );
        })}
      </svg>
      </div>
      <div style={styles.legend}>
        {layers.bands.map((band) => {
          const last = band.values[band.values.length - 1] ?? 0;
          return (
            <span key={band.key} style={{ ...styles.legendItem, borderColor: band.color, cursor: "default" }}>
              <span style={{ ...styles.swatch, backgroundColor: band.color }} aria-hidden="true" />
              <span>{band.label}</span>
              <span style={styles.legendValue}>{fmt(last)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Page: corporation autopsy (#1414) ----------------------------- */

export function AutopsyTable({
  history,
  playerLabel,
  corporationColor,
}: {
  history: GameHistory;
  playerLabel: (address: string) => string;
  corporationColor: (companyId: number) => string;
}) {
  /* ==================================================================
      DESIGN NOTE 1431: THE FLEET LEDGER, BEHIND A CLICK
     ==================================================================
     RULED: "the fleet ledger behind a click is also a good solution. But I am less happy about the trains of the
     same tier being averaged; keep it at 4-trains (n): [ROI = revenue earned - price paid] where n = number of
     trains the corporation held. The downside is you can't tell the difference in a train rusting or being removed
     because of the limit or sold" -- so each model row also spells its fates (rusted / discarded / sold / traded /
     taken / kept) and the train-rounds it ran, and the corporation row carries its payback (revenue - train spend),
     which is the White Elephant's figure. Click a corporation to open its ledger; click again to close. */
  const [open, setOpen] = useState<number | null>(null);
  const signed = (n: number) => (n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`);
  return (
    <div style={styles.page}>
      <h3 style={styles.pageTitle}>Corporations</h3>{/* #1433: "Autopsy sounds grim" */}
      <p style={styles.pageHint}>
        Every corporation that floated: when, who ended up holding it, what it earned and what it kept. Click a
        corporation for its fleet ledger.
      </p>
      <div style={styles.table} role="table" aria-label="Corporations">
        <div style={{ ...styles.row, ...styles.headRow }} role="row">
          <span style={styles.cellTicker}>Corp.</span>
          <span style={styles.cellRound}>Floated</span>
          <span style={styles.cellName}>President</span>
          <span style={styles.cellNum}>Revenue</span>
          <span style={styles.cellNum}>Paid out</span>
          <span style={styles.cellNum}>Withheld</span>
          <span style={styles.cellNum}>Treasury</span>
          {/* #1436: "Final Fleet"; the Payback column is gone -- its figure lives in the ledger's ROI. */}
          <span style={styles.cellFleet}>Final fleet</span>
          <span style={styles.cellBadges}>Accolades</span>
        </div>
        {history.autopsy.map((corp) => {
          const isOpen = open === corp.companyId;
          const badges = history.ceremony.filter((a) => a.scope === "corporation" && a.companyId === corp.companyId);
          return (
            <React.Fragment key={corp.companyId}>
              <div
                style={{ ...styles.row, ...styles.rowClickable, ...(isOpen ? styles.rowOpen : null) }}
                role="row"
                onClick={() => setOpen(isOpen ? null : corp.companyId)}
                aria-expanded={isOpen}
                data-testid={`autopsy-row-${corp.ticker}`}
              >
                <span style={{ ...styles.cellTicker, color: chartInk(corporationColor(corp.companyId)) }}>
                  <span style={styles.disclosure} aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                  {/* #1436: the herald, as the ceremony draws it. */}
                  <CorporateLogo ticker={corp.ticker} size={22} color={chartInk(corporationColor(corp.companyId))} title={corp.ticker} fallbackStyle={styles.heraldFallback} />
                  {corp.ticker}
                </span>
                <span style={styles.cellRound}>{corp.floatRound ?? "—"}</span>
                <span style={styles.cellName}>{corp.finalPresident ? playerLabel(corp.finalPresident) : "—"}</span>
                <span style={styles.cellNum}>{fmt(corp.lifetimeRevenue)}</span>
                <span style={styles.cellNum}>{fmt(corp.dividendsPaid)}</span>
                <span style={styles.cellNum}>{fmt(corp.withheld)}</span>
                <span style={styles.cellNum}>{fmt(corp.treasury)}</span>
                <span style={styles.cellFleet}>{corp.fleet.length === 0 ? "none" : corp.fleet.map((m) => `${m}-train`).join(", ")}</span>
                <span style={styles.cellBadges}>
                  <AccoladeBadges accolades={badges} />
                </span>
              </div>
              {isOpen && (
                <div style={styles.ledger} role="table" aria-label={`${corp.ticker} fleet ledger`} data-testid={`autopsy-ledger-${corp.ticker}`}>
                  {corp.fleetLedger.length === 0 ? (
                    <div style={styles.ledgerEmpty}>Never owned a train.</div>
                  ) : (
                    <>
                      <div style={{ ...styles.ledgerRow, ...styles.headRow }} role="row">
                        <span style={styles.ledgerModel}>Trains</span>
                        <span style={styles.cellNum}>Paid</span>
                        {/* UR-6 (Appendix B item 14; OD-UR-6.1 / 6.2): the ledger is per TRAIN, so it counts each train's
                            COMPLETED routes at their printed value (UR-5) -- a route the Yellow Sign nullified earned
                            nothing and was no run, and under Unpredictable Revenue the die adjusts the corporation's
                            turn, not a train's route. True of every game: without the die, printed is what was paid. */}
                        <span style={styles.cellNum} title="The printed value of its completed routes">Earned</span>
                        <span style={styles.cellNum} title="Revenue earned minus price paid">ROI</span>
                        <span style={styles.cellNum} title="Completed runs, counting each train separately">Runs</span>
                        <span style={styles.ledgerFates}>Fate</span>
                      </div>
                      {corp.fleetLedger.map((row) => {
                        const net = row.earned - row.paid;
                        const fates = (Object.keys(row.fates) as Array<keyof typeof row.fates>)
                          .filter((k) => row.fates[k] > 0)
                          .map((k) => (row.count === 1 ? k : `${row.fates[k]} ${k}`))
                          .join(", ");
                        return (
                          <div key={row.model} style={styles.ledgerRow} role="row">
                            <span style={styles.ledgerModel}>
                              {row.model}-train{row.count === 1 ? "" : "s"} ({row.count})
                            </span>
                            <span style={styles.cellNum}>{fmt(row.paid)}</span>
                            <span style={styles.cellNum}>{fmt(row.earned)}</span>
                            <span style={{ ...styles.cellNum, color: net < 0 ? "#e06c65" : "#6cc070", fontWeight: 700 }} title={row.paid > 0 ? `${Math.round((100 * net) / row.paid)}% of the price paid` : undefined}>
                              {signed(net)}
                            </span>
                            <span style={styles.cellNum}>{row.trainRounds}</span>
                            <span style={styles.ledgerFates}>{fates || "—"}</span>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Page: the three charts, one at a time (#1433) ------------------ */

export type ChartKind = "revenue" | "dividends" | "prices" | "networth";
const CHART_KINDS: ReadonlyArray<{ kind: ChartKind; title: string }> = [
  { kind: "revenue", title: "Revenue" },
  { kind: "dividends", title: "Dividends" },
  { kind: "prices", title: "Share prices" },
  { kind: "networth", title: "Net worth" },
];

/* ==================================================================
    DESIGN NOTE 1433: ONE CHARTS PAGE, THREE CHARTS, ONE CHOSEN CORPORATION
   ==================================================================
   RULED: "Standings > Corporations > Charts, and within Charts have all three ... be toggleable". They do
   not overlay -- revenue is in hundreds over Operating Rounds only, prices in the tens-to-hundreds over
   every round, and the third is per PLAYER; one set of axes would flatten two of them to the baseline. So
   the toggle switches which chart is up, and what carries across is the CHOICE: the corporation singled
   out on Revenue is still singled out on Prices, which is the comparison a player is actually making ("it
   ran for that, and the market did this"). #1434: the third chart is Dividends (per player, per round) --
   Net worth, a running total with the portfolio stack behind it, moved to its own tab. Each chart draws
   itself on the first time it is shown (#1432); the page remembers which have been, through `seen`, since
   it unmounts between visits. */
export function ChartsPage({
  history,
  corporationColor,
  playerLabel,
  playerColor,
  seen,
  onShown,
}: {
  history: GameHistory;
  corporationColor: (companyId: number) => string;
  playerLabel: (address: string) => string;
  playerColor: (address: string) => string;
  /** Which chart kinds have been shown before (keys `charts:<kind>`). */
  seen: ReadonlySet<string>;
  onShown: (key: string) => void;
}) {
  const [kind, setKind] = useState<ChartKind>("revenue");
  const [corporation, setCorporation] = useState<string | null>(null);
  const key = `charts:${kind}`;
  const firstSight = !seen.has(key);
  useEffect(() => onShown(key), [key, onShown]);
  return (
    <div style={styles.page}>
      <div style={styles.chartTabs} role="tablist" aria-label="Chart">
        {CHART_KINDS.map((c) => (
          <button
            key={c.kind}
            type="button"
            role="tab"
            aria-selected={kind === c.kind}
            style={{ ...styles.chartTab, ...(kind === c.kind ? styles.chartTabOn : {}) }}
            onClick={() => setKind(c.kind)}
            data-testid={`chart-tab-${c.kind}`}
          >
            {c.title}
          </button>
        ))}
      </div>
      {kind === "revenue" && (
        <RevenueChart key={key} history={history} corporationColor={corporationColor} animate={firstSight} selected={corporation} onSelect={setCorporation} />
      )}
      {kind === "prices" && (
        <StockPriceChart
          key={key}
          history={history}
          corporationColor={corporationColor}
          playerLabel={playerLabel}
          animate={firstSight}
          selected={corporation}
          onSelect={setCorporation}
        />
      )}
      {kind === "dividends" && <DividendsChart key={key} history={history} playerLabel={playerLabel} playerColor={playerColor} animate={firstSight} />}
      {/* #1436: "put all the Charts on the same page (add Net Worth to the Charts page)". */}
      {kind === "networth" && (
        <NetWorthChart key={key} history={history} playerLabel={playerLabel} playerColor={playerColor} corporationColor={corporationColor} animate={firstSight} />
      )}
    </div>
  );
}

/* ---- Standings page: the accolades (#1414) ------------------------- */

/* #1416/#1417: the shelf that first drew the ceremony's list as a wall of blocks is GONE -- "haphazard: I
   don't immediately know what the colors represent". `AccoladesCeremony` is the page now, animated and
   settled alike. This row survives on the standings page: the core five, one line each. */
export function AccoladesRow({
  history,
  playerLabel,
  playerColor,
}: {
  history: GameHistory;
  playerLabel: (address: string) => string;
  playerColor: (address: string) => string;
}) {
  const earned = history.ceremony.filter((a) => a.core && a.holder !== null);
  if (earned.length === 0) return null;
  return (
    <div style={styles.accolades} role="list" aria-label="Accolades">
      {earned.map((a) => (
        <span key={a.key} role="listitem" style={{ ...styles.accolade, borderColor: playerColor(a.holder as string) }} title={a.detail}>
          <span style={styles.accoladeGlyph} aria-hidden="true">
            <AccoladeGlyph accoladeKey={a.key} size={18} />
          </span>
          <span style={styles.accoladeText}>
            <span style={styles.accoladeTitle}>{a.title}</span>
            <span style={styles.accoladeHolder}>
              {a.ticker ? `${a.ticker} · ` : ""}
              {playerLabel(a.holder as string)} <span style={styles.accoladeDetail}>— {a.detail}</span>
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  /* #1436: the page fills the modal body's height so the chart box below can be measured against it. */
  page: { display: "flex", flexDirection: "column", gap: "10px", flex: 1, minHeight: 0 },
  /* #1433: the chart toggle. */
  chartTabs: { display: "inline-flex", gap: "4px", alignSelf: "flex-start" },
  chartTab: {
    padding: "4px 12px",
    borderRadius: RADIUS.pill,
    border: "1px solid #3a3a3a",
    backgroundColor: "transparent",
    color: "#8a8a86",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
  // #1449: the shorthand, not `borderColor` -- the base is `1px solid #3a3a3a`.
  chartTabOn: { border: "1px solid #c9a227", color: "#f0dfa8", backgroundColor: "#2a2410" },
  pageTitle: { margin: 0, fontSize: "20px", fontWeight: 800, color: "#f0e2b8" },
  subTitle: { margin: "6px 0 0", fontSize: FONT_SIZE.strong, fontWeight: 800, color: "#e8e6e0" },
  pageHint: { margin: 0, fontSize: FONT_SIZE.small, color: "#8a8a86" },
  chartBlock: { display: "flex", flexDirection: "column", gap: "8px", flex: 1, minHeight: 0 },
  /* #1436: the MEASURED box. The flex layout sizes it (all the height the page has left), the ResizeObserver
     reads it, and the SVG is drawn at exactly that size. `chartBoxCompact` is for the net worth page when
     the portfolio stack is open beneath it -- two charts sharing the height. The old `maxHeight: 46vh`
     letterbox (#1430) is gone with the fixed viewBox that needed it. */
  chartBox: { flex: 1, minHeight: "200px", position: "relative" },
  chartBoxCompact: { flex: 1, minHeight: "150px", position: "relative" },
  svg: { position: "absolute", inset: 0, display: "block", backgroundColor: "#141414", border: "1px solid #2a2a2a", borderRadius: RADIUS.card, boxSizing: "border-box" },
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
    /* #1430: no `maxHeight: 34vh` -- that cap dated from the 960px modal (#1409) and on the full-screen one
       (#1417) it left the autopsy in a third of the page with a scrollbar. The modal's page body is what
       scrolls now, and only when it must. */
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
  cellTicker: { flex: "0 0 96px", fontWeight: 800, display: "inline-flex", alignItems: "center", gap: "6px" },
  heraldFallback: { fontSize: "10px", fontWeight: 800 },
  cellName: { flex: "1 1 110px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  cellFleet: { flex: "1 1 140px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", textAlign: "right" },
  cellBadges: { flex: "0 1 150px", display: "inline-flex", justifyContent: "flex-end", minWidth: 0 },
  /* #1431: the fleet ledger behind a click. */
  rowClickable: { cursor: "pointer" },
  rowOpen: { backgroundColor: "#1f1f1f" },
  disclosure: { display: "inline-block", width: "12px", color: "#8a8a86", fontWeight: 400 },
  ledger: { padding: "4px 12px 8px 24px", backgroundColor: "#1a1a1a", borderBottom: "1px solid #2a2a2a", color: "#c8c6c0", fontVariantNumeric: "tabular-nums" },
  ledgerRow: { display: "flex", alignItems: "center", gap: "8px", padding: "3px 0", fontSize: FONT_SIZE.small },
  ledgerModel: { flex: "0 0 110px", fontWeight: 700 },
  ledgerFates: { flex: "1 1 160px", minWidth: 0, textAlign: "right", color: "#9a978f" },
  ledgerEmpty: { padding: "4px 0", color: "#8a8a86", fontSize: FONT_SIZE.small, fontStyle: "italic" },
  cellNum: { flex: "1 1 80px", textAlign: "right", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  cellNumStrong: { flex: "1 1 96px", textAlign: "right", fontWeight: 800, color: "#f2f0eb" },
  cellPresident: { color: "#f0dfa8", fontWeight: 700 },
  cellZero: { color: "#4a4a48" },
  accolades: { display: "flex", flexWrap: "wrap", gap: "8px" },
  accolade: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 12px 6px 8px",
    borderRadius: RADIUS.card,
    borderWidth: "1px",
    borderStyle: "solid",
    backgroundColor: "#141414",
    minWidth: 0,
  },
  accoladeGlyph: { fontSize: "18px", lineHeight: 1 },
  accoladeText: { display: "flex", flexDirection: "column", minWidth: 0 },
  accoladeTitle: { fontSize: FONT_SIZE.micro, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#c9a94c" },
  accoladeHolder: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#f2f0eb" },
  accoladeDetail: { fontWeight: 500, color: "#8a8a86" },
};
