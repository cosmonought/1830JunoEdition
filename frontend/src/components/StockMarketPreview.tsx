// frontend/src/components/StockMarketPreview.tsx
//
// ==================================================================
//  DESIGN NOTE 1141: THE MINI-CAMERA
// ==================================================================
//
// RULED, after the alternative was argued and rejected: "a 2-cell inline strip loses critical tactical
// context (like ledges, cliffs, and the stacking order of other corporations' tokens). I want the full
// spatial context, but gated behind a deliberate click/tap so we don't bloat the permanent UI."
//
// WHAT THIS IS NOT: a second opinion about the market. Every fact on this chart is read from the same places
// the full renderer reads them -- `PRICE_GRID` for which cells exist and what zone they are, the four
// `project*Move` functions for where the token lands, `marketGrid.positions` for who else is standing there.
// It computes NOTHING. That is deliberate and it is the whole reason this file can exist at all: #891's
// standing fault in this codebase is two components working out the same fact and disagreeing, and a preview
// that walked its own step would be that fault with a magnifying glass on it.
//
// WHAT IT ADDS OVER THE INLINE READOUT, which is the case for building it: `MarketMoveLine` states a PRICE
// ($76 -> $82). It cannot state that the move turns a corner at a ledge, that the destination is one cell
// from the right cliff, or that two other corporations are already sitting on the square. Those are facts
// about the BOARD rather than about the number, and a player who wants them currently changes tab.
//
// GATED ON A CLICK, NOT A HOVER. The permanent readouts stay exactly as they are -- #509a's "show the money
// moving, do not describe it" and #951's consolidation both survive untouched -- and this opens on a
// deliberate press, which is also the only version of the feature that works on a touch screen.
//
// FIVE BY FIVE, CENTRED ON THE MOVE rather than on the token: a destination that fell outside its own
// preview would be the one thing this cannot afford to get wrong.

import React from "react";

import {
  PRICE_GRID,
  ZONE_TEXT_COLORS,
  marketZoneTooltip,
  type MarketPositionEntry,
  type PriceCell,
  type ZoneType,
} from "./StockMarketRenderer";
import { CorporateLogo } from "./CorporateLogo";
import { FONT_SIZE } from "../styles/typography";
import { INK, INK_TEXT, INK_TEXT_MUTED, RULE, RULE_STRONG } from "../styles/palette";

/** How many cells across and down. Odd, so there is a true centre to aim the camera at. */
const WINDOW = 5;
const HALF = Math.floor(WINDOW / 2);

/** Design note #1141: one cell's drawn size. Big enough that a ticker fits inside a token and small enough
 *  that five of them plus the frame stay inside a popover rather than becoming a second board. */
const CELL = 46;
const GAP = 3;

export interface StockMarketPreviewProps {
  /** The corporation the move belongs to -- the token that animates. */
  company: { company_id: number; ticker: string };
  /** Where it stands now. */
  startNode: { x: number; y: number };
  /** Where the move puts it, or `null` when the board cannot move it (a floor, a ceiling, a corner). */
  projectedNode: { x: number; y: number } | null;
  /** Every corporation's position, so the neighbours are the real ones. The SAME array the full chart
   *  draws from -- see the header for why this component is given facts rather than allowed to derive them. */
  positions: readonly MarketPositionEntry[];
  /** What the player pressed, for the caption. */
  action: "pay" | "withhold" | "sell";
}

const ACTION_CAPTION: Readonly<Record<StockMarketPreviewProps["action"], string>> = {
  pay: "Paying dividends moves the token right.",
  withhold: "Withholding moves the token left.",
  sell: "Selling drops the token one row per 10% block.",
};

const ZONE_GRADIENTS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "linear-gradient(155deg, #7a6a1c 0%, #5c5015 55%, #453b0f 100%)",
  Orange: "linear-gradient(155deg, #7a4d1c 0%, #5c3a15 55%, #45290f 100%)",
  Brown: "linear-gradient(155deg, #54371a 0%, #3d2811 55%, #2c1c0a 100%)",
};

const NORMAL_CELL = "#3a3a3a";

function cellAt(x: number, y: number): PriceCell | undefined {
  return PRICE_GRID.find((candidate) => candidate.x === x && candidate.y === y);
}

/* ==================================================================
    DESIGN NOTE 1141: THE CAMERA FRAMES THE MOVE, NOT THE TOKEN
   ==================================================================
   Centring on `startNode` is the obvious reading of "centre on the company's token" and it has one failure
   that matters: a two-cell move, or a sale of four blocks, walks the destination off the edge of a 5x5
   window -- so the preview would omit the single cell it was opened to show.
   THE MIDPOINT OF THE TWO IS THE CENTRE, then clamped so the window never runs past the chart. Where there
   is no move at all the midpoint IS the token, which is the original behaviour arrived at by the general
   rule rather than special-cased. */
export function previewCentre(
  startNode: { x: number; y: number },
  projectedNode: { x: number; y: number } | null,
): { x: number; y: number } {
  const to = projectedNode ?? startNode;
  const xs = PRICE_GRID.map((cell) => cell.x);
  const ys = PRICE_GRID.map((cell) => cell.y);
  const midX = Math.round((startNode.x + to.x) / 2);
  const midY = Math.round((startNode.y + to.y) / 2);
  const clamp = (value: number, lo: number, hi: number) =>
    Math.min(Math.max(value, lo + HALF), hi - HALF);
  return {
    x: clamp(midX, Math.min(...xs), Math.max(...xs)),
    y: clamp(midY, Math.min(...ys), Math.max(...ys)),
  };
}

export function StockMarketPreview({
  company,
  startNode,
  projectedNode,
  positions,
  action,
}: StockMarketPreviewProps) {
  const centre = previewCentre(startNode, projectedNode);

  /* ==================================================================
      DESIGN NOTE 1142: THE MOVE REPEATS, AND THE RETURN TRIP IS NOT PART OF IT
     ==================================================================
     RULED: "if it plays once on click players may not have time to take everything in, so looping it lets
     them get settled and see it clearly."
     THE OBVIOUS LOOP IS WRONG AND WRONG IN A WAY THAT TEACHES THE OPPOSITE. Toggling the destination on a
     timer animates the token BACK as well as forward -- so a withhold preview would show the price rising
     for half of every cycle, which is not a rougher version of the truth, it is the other decision. The
     player is looking at this picture precisely because they have not yet internalised which way the token
     goes.
     SO THE CYCLE IS: rest at the start, SLIDE to the destination, hold there long enough to read the cell,
     then SNAP back with the transition switched off. The only motion the eye ever sees is the real one; the
     reset is a cut, the way a looping clip cuts rather than playing itself backwards.
     THE PHASE CARRIES ITS OWN `animate` FLAG for that reason -- the transition has to be off for exactly one
     render, and a duration toggled by the same state that moves the token is the only way to guarantee the
     snap is not interpolated.
     TIMINGS: 420ms of travel matches `movingToken`'s transition, 1100ms of hold is long enough to look at
     the destination and its neighbours, 500ms of rest separates one pass from the next so the loop reads as
     a repeat rather than as a stutter. */
  const SLIDE_MS = 420;
  const HOLD_MS = 1100;
  const REST_MS = 500;

  /* Design note #1142: reduced motion gets the ANSWER, not the animation. A player who has asked their
     system for less movement still needs to know where the token lands, so the preview places it at the
     destination and never loops -- #606's rule, which this app already applies wherever it moves anything. */
  const prefersReducedMotion = React.useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const [phase, setPhase] = React.useState<{ atStart: boolean; animate: boolean }>({
    atStart: true,
    animate: false,
  });
  const timerRef = React.useRef(0);

  React.useEffect(() => {
    window.clearTimeout(timerRef.current);
    if (!projectedNode) {
      setPhase({ atStart: true, animate: false });
      return undefined;
    }
    if (prefersReducedMotion) {
      setPhase({ atStart: false, animate: false });
      return undefined;
    }
    setPhase({ atStart: true, animate: false });
    /* A CHAINED TIMEOUT RATHER THAN AN INTERVAL. The three legs have different lengths, and an interval
       long enough for the whole cycle cannot also fire the snap in the middle of it. Each leg schedules the
       next, so the chain is self-correcting if a frame is slow. */
    const rest = () => {
      timerRef.current = window.setTimeout(() => {
        setPhase({ atStart: false, animate: true });
        timerRef.current = window.setTimeout(() => {
          // The snap: back to the start with the transition OFF, so nothing travels backwards.
          setPhase({ atStart: true, animate: false });
          rest();
        }, SLIDE_MS + HOLD_MS);
      }, REST_MS);
    };
    rest();
    return () => window.clearTimeout(timerRef.current);
  }, [projectedNode, startNode.x, startNode.y, prefersReducedMotion]);

  const at = !phase.atStart && projectedNode ? projectedNode : startNode;

  /* The neighbours, grouped per cell in the order the chart itself stacks them -- see the note on the token
     row below for why the order is preserved rather than sorted. */
  const occupantsAt = React.useCallback(
    (x: number, y: number) =>
      positions.filter(
        (position) =>
          position.x === x && position.y === y && position.company_id !== company.company_id,
      ),
    [positions, company.company_id],
  );

  const rows: number[] = [];
  for (let dy = HALF; dy >= -HALF; dy -= 1) rows.push(centre.y + dy);
  const columns: number[] = [];
  for (let dx = -HALF; dx <= HALF; dx += 1) columns.push(centre.x + dx);

  const originCell = cellAt(startNode.x, startNode.y);
  const landingCell = projectedNode ? cellAt(projectedNode.x, projectedNode.y) : undefined;

  return (
    <div style={styles.root}>
      <div style={styles.grid}>
        {rows.map((y) =>
          columns.map((x) => {
            const cell = cellAt(x, y);
            /* ==================================================================
                DESIGN NOTE 1141: A MISSING CELL IS THE LEDGE
               ==================================================================
               The 1830 chart is jagged -- `buildPriceGrid` walks `REAL_MARKET_ROWS` rather than filling a
               rectangle -- so the cliffs and ledges the report asks to see are not drawn anywhere. They are
               the ABSENCE of a cell. Rendering an empty slot rather than skipping it is what makes the shape
               of the board visible: the player sees the chart run out, which is what a ledge is. */
            if (!cell) {
              return <div key={`${x}:${y}`} style={styles.voidCell} aria-hidden="true" />;
            }
            const isOrigin = x === startNode.x && y === startNode.y;
            const isLanding =
              projectedNode !== null && x === projectedNode.x && y === projectedNode.y;
            const others = occupantsAt(x, y);
            const holdsToken = at.x === x && at.y === y;
            return (
              <div
                key={`${x}:${y}`}
                style={{
                  ...styles.cell,
                  ...(cell.zoneType === "Normal"
                    ? { backgroundColor: NORMAL_CELL }
                    : { backgroundImage: ZONE_GRADIENTS[cell.zoneType] }),
                  ...(isLanding ? styles.cellLanding : {}),
                  ...(isOrigin && !isLanding ? styles.cellOrigin : {}),
                }}
                title={marketZoneTooltip(cell.zoneType) ?? `$${cell.price}`}
              >
                <span
                  style={{
                    ...styles.price,
                    ...(cell.zoneType === "Normal"
                      ? {}
                      : { color: ZONE_TEXT_COLORS[cell.zoneType] }),
                  }}
                >
                  {cell.price}
                </span>
                {/* ==================================================================
                     DESIGN NOTE 1141: THE STACK, IN THE ORDER THE BOARD HAS IT
                    ==================================================================
                    RULED: "ensure it lands in the correct visual stacking order if it enters a cell occupied
                    by other tokens." `positions` arrives in the order the chart itself received it and is
                    NOT re-sorted here -- a preview that ordered the pile differently from the board would be
                    telling the player something about precedence that is not true.
                    THE MOVING TOKEN GOES ON TOP OF THE PILE IT JOINS, which is what a physical token does
                    when it is placed onto a square that already has tokens on it. */}
                <span style={styles.stack}>
                  {others.map((other) => (
                    <CorporateLogo
                      key={other.company_id}
                      ticker={other.ticker}
                      size={15}
                      title={`${other.ticker} at $${cell.price}`}
                    />
                  ))}
                  {holdsToken && (
                    <span
                      className="market-preview-token"
                      style={{
                        ...styles.movingToken,
                        // Design note #1142: no transition on the snap back, or the token travels the wrong way.
                        ...(phase.animate ? {} : styles.movingTokenInstant),
                      }}
                      title={`${company.ticker} at $${cell.price}`}
                    >
                      <CorporateLogo ticker={company.ticker} size={17} />
                    </span>
                  )}
                </span>
              </div>
            );
          }),
        )}
      </div>

      {/* Design note #1141: the caption says what the picture cannot -- WHICH decision this is a preview of.
          The prices come from the two cells rather than from the caller, so the words and the chart cannot
          disagree about where the token started. */}
      <p style={styles.caption}>
        {ACTION_CAPTION[action]}{" "}
        {landingCell && originCell ? (
          <span style={styles.captionMove}>
            ${originCell.price} &rarr; ${landingCell.price}
          </span>
        ) : (
          <span style={styles.captionMove}>
            The board cannot move it from ${originCell?.price ?? "?"}.
          </span>
        )}
      </p>
    </div>
  );
}

export default StockMarketPreview;

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "12px",
    backgroundColor: INK,
    border: `1px solid ${RULE}`,
    borderRadius: "10px",
    boxShadow: "0 18px 48px rgba(0, 0, 0, 0.55)",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: `repeat(${WINDOW}, ${CELL}px)`,
    gridAutoRows: `${CELL}px`,
    gap: `${GAP}px`,
  },
  /* Design note #1141: the hole where the chart stops. Faintly outlined rather than blank, so it reads as
     "no cell here" rather than as a rendering gap -- which is the difference between showing a ledge and
     appearing to have lost one. */
  voidCell: {
    borderRadius: "4px",
    border: `1px dashed ${RULE}`,
    opacity: 0.35,
  },
  cell: {
    position: "relative",
    borderRadius: "4px",
    border: `1px solid ${RULE}`,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "3px",
    boxSizing: "border-box",
    overflow: "hidden",
  },
  // Where the token came from -- a quiet outline, since the eye should end on the destination.
  cellOrigin: { borderColor: RULE_STRONG, borderStyle: "dashed" },
  // Where it lands. The one cell this whole popover exists to point at.
  cellLanding: { borderColor: "#e3c951", borderWidth: "2px", padding: "2px" },
  price: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    color: INK_TEXT,
    lineHeight: 1,
  },
  stack: {
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-end",
    gap: "1px",
    minHeight: "17px",
  },
  /* Design note #1141: the transition that makes the move legible. `transform` and `opacity` only -- both are
     compositor properties, so the slide does not re-lay-out five rows of grid on every frame. */
  movingToken: {
    display: "inline-flex",
    transition: "transform 420ms cubic-bezier(0.22, 0.61, 0.36, 1)",
    filter: "drop-shadow(0 2px 4px rgba(0, 0, 0, 0.8))",
  },
  /* Design note #1142: the reset leg. `none` rather than `0ms` because a zero-duration transition still
     fires `transitionend` and still counts as an animation to anything watching for one. */
  movingTokenInstant: { transition: "none" },
  caption: {
    margin: 0,
    maxWidth: `${WINDOW * (CELL + GAP)}px`,
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.5,
    color: INK_TEXT_MUTED,
  },
  captionMove: { color: INK_TEXT, fontWeight: 700 },
};
