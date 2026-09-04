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
import { MarketToken } from "./MarketToken";
import { stackOffset, stackOrder } from "../utils/marketStack";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { INK, INK_TEXT, INK_TEXT_MUTED, RULE, RULE_STRONG } from "../styles/palette";

/* ==================================================================
    DESIGN NOTE 1156: THE WHOLE CHART, BECAUSE THE WINDOW WAS THE COMPROMISE
   ==================================================================
   ASKED: "given that the mini-camera already shrinks the stock market board, does it make sense to just
   render the entire stock market instead of a 5x5 grid?"
   IT DID NOT FIT AT THE OLD DIALOG WIDTH, and that is the whole of why it was a window. The board is 19
   columns by 11 rows -- 120 cells -- and the dialog was capped at 420px, which is 22px a column: narrower
   than a token and far too narrow for "$100". #1141's `previewCentre` existed to choose WHICH five columns
   to sacrifice, and #1141's own note admits the cost ("centring on the token drops the destination off the
   edge of a 5x5 window on any two-cell move").
   SO THE DIALOG GREW INSTEAD OF THE CHART SHRINKING. At 900px a column is 44px, which carries a three-digit
   price at micro size and a token at 22px; eleven rows come to roughly 380px -- a dialog, not a page.
   WHAT THAT BUYS is what the report asked for: the ledges, the ceiling and every rival token, with no
   decision about what to crop.
   ON A NARROW SCREEN the chart scrolls inside the dialog rather than shrinking below legibility -- the same
   trade this file already made, moved to a different axis. */
const CELL = 44;
const GAP = 3;

/** The token's drawn diameter. Deliberately below #430's 26px threshold: at this size a herald is exactly the
 *  smudge that note measured, so every token on this chart carries its acronym instead. */
const TOKEN = 22;

/** The board's own extent, read from the grid rather than typed -- a variant that adds a row must not need
 *  this file edited before it can be drawn. */
const BOARD_X = {
  min: Math.min(...PRICE_GRID.map((cell) => cell.x)),
  max: Math.max(...PRICE_GRID.map((cell) => cell.x)),
};
const BOARD_Y = {
  min: Math.min(...PRICE_GRID.map((cell) => cell.y)),
  max: Math.max(...PRICE_GRID.map((cell) => cell.y)),
};

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
    DESIGN NOTE 1156: `previewCentre` IS GONE, AND SO IS THE QUESTION IT ANSWERED
   ==================================================================
   IT CHOSE WHICH FIVE COLUMNS TO SHOW -- the midpoint of the move, clamped inward so a corner token still got
   a full window -- and #1141 argued it carefully because centring on the token drops the destination off the
   edge of any two-cell move. That was a real problem and it was a problem ABOUT CROPPING. With the whole
   board drawn there is nothing to crop and nothing to centre, so the function is deleted rather than left
   exported with no caller. Its tests go with it; what replaced them is the assertion that every cell renders.
*/

export function StockMarketPreview({
  company,
  startNode,
  projectedNode,
  positions,
  action,
}: StockMarketPreviewProps) {

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

  /* Design note #1156: top row first, so the chart reads the way the board does -- `y` counts UP from the
     bottom in `REAL_MARKET_ROWS`, and a chart drawn bottom-first would be upside down. */
  const rows: number[] = [];
  for (let y = BOARD_Y.max; y >= BOARD_Y.min; y -= 1) rows.push(y);
  const columns: number[] = [];
  for (let x = BOARD_X.min; x <= BOARD_X.max; x += 1) columns.push(x);

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
            /* ==================================================================
                DESIGN NOTE 1157: THE CAMERA HIGHLIGHTS WHERE THE TOKEN ENDS, ALWAYS
               ==================================================================
               REPORTED: "the mini-camera view highlights the cell it ends at when it moves, but highlights
               nothing when it doesn't move. it should always highlight wherever it ends."
               THE HIGHLIGHT WAS KEYED ON `projectedNode` BEING NON-NULL, so the one case where a player most
               needs telling where the token IS -- the case where nothing happens, which the line above now
               describes only as "(unchanged)" -- was the case with nothing marked. The two omissions
               compounded: no words, and no highlight either.
               THE END CELL IS THE PROJECTION OR THE START, which is the same `at` the token itself uses, so
               the mark and the token cannot disagree about where the move finishes. */
            const endNode = projectedNode ?? startNode;
            const isLanding = x === endNode.x && y === endNode.y;
            const others = occupantsAt(x, y);
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
                {/* Design note #1155: the neighbours are the chart's own token now -- livery disc, computed
                    ink, #430's herald-or-acronym threshold -- rather than the bare herald this file drew. */}
                {/* Design note #1159: the same pile the full chart draws, from the same `stackOrder` -- so the
                    camera cannot show a different precedence from the board it is a picture of. */}
                <span className="market-token-cluster" style={styles.stack}>
                  {stackOrder(others).map((other, index) => (
                    <MarketToken
                      key={other.company_id}
                      className="market-token"
                      companyId={other.company_id}
                      ticker={other.ticker}
                      diameterPx={TOKEN}
                      title={`${other.ticker} at $${cell.price}`}
                      style={{
                        position: "absolute",
                        left: `${(CELL - TOKEN) / 2}px`,
                        top: `${(CELL - TOKEN) / 2 + stackOffset(index, others.length, TOKEN)}px`,
                        zIndex: 10 + (others.length - index),
                      }}
                    />
                  ))}
                </span>
              </div>
            );
          }),
        )}
        {/* ==================================================================
              DESIGN NOTE 1158: THE TOKEN COULD NEVER HAVE SLID FROM INSIDE A CELL
            ==================================================================
            REPORTED: "the 'animation' is not really an animation: the token blinks from one spot to another.
            I was really wanting it to slide across the board to emphasize the directionality of the stock
            market."
            AND IT COULD NOT HAVE DONE. The moving token was rendered INSIDE whichever cell currently held it,
            so when the phase flipped React unmounted it from the origin cell and mounted a DIFFERENT element
            in the destination cell. A CSS transition animates a property changing on ONE element; there was
            never one element, so `transition: transform 420ms` -- sitting on this token since #1141, with
            #1142's snap-back logic built around it -- could not fire and never had. Two design notes describe
            an animation that was structurally impossible.
            WHICH IS ALSO WHY "APPLY A CSS TRANSITION" WAS THE WRONG PRESCRIPTION: the transition was there.
            ONE ELEMENT, ABSOLUTELY POSITIONED OVER THE GRID, moved by `transform: translate(...)` between the
            two cells' offsets. The offsets are ARITHMETIC on the cell size rather than measured, so they need
            no layout read and cannot disagree with the grid that placed the cells -- #1144's lesson about
            measured pixels applies to anything that would have reached for `getBoundingClientRect` here.
            #1142'S SNAP-BACK IS UNCHANGED IN INTENT: the reset leg still kills the transition for exactly the
            render that returns the token to its start, so the only motion an eye sees is the real one. It
            now has an element for that to be true of. */}
        <MarketToken
          companyId={company.company_id}
          ticker={company.ticker}
          diameterPx={TOKEN}
          title={company.ticker}
          style={{
            ...styles.movingToken,
            ...(phase.animate ? {} : styles.movingTokenInstant),
            transform: `translate(${(at.x - BOARD_X.min) * (CELL + GAP) + (CELL - TOKEN) / 2}px, ${
              (BOARD_Y.max - at.y) * (CELL + GAP) + (CELL - TOKEN) / 2
            }px)`,
          }}
        />
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
    borderRadius: RADIUS.card,
    boxShadow: "0 18px 48px rgba(0, 0, 0, 0.55)",
  },
  grid: {
    /* Design note #1158: the moving token is a child of this grid but not of any cell, so the grid is what
       its `translate` is measured from. */
    position: "relative",
    display: "grid",
    gridTemplateColumns: `repeat(${BOARD_X.max - BOARD_X.min + 1}, ${CELL}px)`,
    gridAutoRows: `${CELL}px`,
    gap: `${GAP}px`,
  },
  /* Design note #1141: the hole where the chart stops. Faintly outlined rather than blank, so it reads as
     "no cell here" rather than as a rendering gap -- which is the difference between showing a ledge and
     appearing to have lost one. */
  voidCell: {
    borderRadius: RADIUS.control,
    border: `1px dashed ${RULE}`,
    opacity: 0.35,
  },
  cell: {
    position: "relative",
    borderRadius: RADIUS.control,
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
  /* Design note #1159: the pile's positioning context. `absolute` children centred on the cell and offset
     along one axis, so the overlap reads as a stack rather than as a row. */
  stack: { position: "absolute", inset: 0 },
  /* Design note #1141: the transition that makes the move legible. `transform` and `opacity` only -- both are
     compositor properties, so the slide does not re-lay-out five rows of grid on every frame. */
  /* Design note #1158: `top`/`left` at the grid's origin, and every move expressed as a transform from
     there -- a transform animates on the compositor and never triggers layout, which is what keeps a slide
     over 120 cells smooth. `zIndex` clears the neighbours it passes over. */
  movingToken: {
    position: "absolute",
    top: 0,
    left: 0,
    zIndex: 5,
    transition: "transform 420ms cubic-bezier(0.22, 0.61, 0.36, 1)",
  },
  /* Design note #1142: the reset leg. `none` rather than `0ms` because a zero-duration transition still
     fires `transitionend` and still counts as an animation to anything watching for one. */
  movingTokenInstant: { transition: "none" },
  caption: {
    margin: 0,
    /* Design note #1156: the caption wraps to the chart it captions, whatever width that now is. */
    maxWidth: `${(BOARD_X.max - BOARD_X.min + 1) * (CELL + GAP)}px`,
    fontSize: FONT_SIZE.micro,
    lineHeight: 1.5,
    color: INK_TEXT_MUTED,
  },
  captionMove: { color: INK_TEXT, fontWeight: 700 },
};
