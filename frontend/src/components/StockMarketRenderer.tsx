// frontend/src/components/StockMarketRenderer.tsx
//
// Renders `QueryMsg::GetMarketGrid` as the 1830 stock price matrix: a DOM/CSS grid keyed by
// `market::MARKET_MIN_X..=MAX_X` x `MIN_Y..=MAX_Y` (19 x 11), shaped by the verbatim board data in
// `REAL_MARKET_ROWS`, with every trading corporation's token plotted at its live `(x, y)`.
// Sibling to `HexGridRenderer.tsx`; the two are composed in `App.tsx`'s tabbed board view.
//
// Design notes #1-#26 and #43/#187/#196/#387/#402/#415/#428/#430/#434/#452/#648-#652:
// see `docs/ai_architecture/stock_market.md`.

// Design note #22: par frame recoloured to `#EAB308`; every tooltip says "certificate limit",
// the official 1830 term, and Normal cells now state their status explicitly too.

// Design note #23: par-frame stacking fix (positioned elements paint after non-positioned ones),
// par tooltip trimmed to two clauses, and tokens became circles with the tray moved below the grid.

// Design note #24: par prices centred to clear the frame's border, and same-cell tokens spread
// around a ring instead of a diagonal cascade, shrinking by `1.15 / sqrt(count)`.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { FONT_SIZE, RADIUS, VIEWPORT_RADIUS } from "../styles/typography";
import { corporationLabel } from "../utils/corporationNames";
import { bestContrastTextColor, corporationLiveryColor } from "../styles/corporationLivery";
import { CorporateLogo } from "./CorporateLogo";
import { MarketToken } from "./MarketToken";
import { stackOffset, stackOrder } from "../utils/marketStack";
/* Design note #1117: the one viewport ground, shared rather than retyped. */
import { INK_VIEWPORT } from "../styles/palette";
/* Design note #1263: the chrome's scale, so the tray can step back into it. */
import { useUiScale } from "../utils/useUiScale";
import {
  PAY_DOUBLE_JUMP_MULTIPLE,
  WITHHOLD_DOUBLE_DROP_MULTIPLE,
  resolveVariants,
  type GameVariants,
} from "../gameEngine/gameVariants";
/* #1435: the chart as data -- see the note at "Price + zone grid mirror" below. */
import {
  PRICE_GRID,
  REAL_BOARD_COLUMNS,
  cellKey,
  marketMaxY,
  priceCellByKey,
  type PriceCell,
  type ZoneType,
} from "./marketChart";
import {
  MARKET_MIN_X,
  MARKET_MAX_X,
  MARKET_MIN_Y,
  clamp,
  marketZoneForPrice,
  type MarketGridResponse,
  type MarketPositionEntry,
} from "../gameEngine/marketGeometry";

/* ------------------------------------------------------------------ */
/* Contract data mirrors + chart geometry -- see design note #1       */
/* ------------------------------------------------------------------ */

/* ==================================================================
    DESIGN NOTE 1435: THE CHART IS A VALUE, IN `marketChart.ts`
   ==================================================================
   The board data, the par ladder, `PriceCell`, `buildPriceGrid` and `PRICE_GRID` moved to a leaf module
   with no React in it, for the reason `hexBoardData.ts` #1300 gives for the hex board: a variant now
   changes the chart's shape (Dynamic Market adds a row above the top), and the chart in effect has to be
   something `boardSelection.ts` can switch per table -- which a component module cannot be imported to do
   without `utils/` importing `components/` (#7/#273). Everything this file exported from that block is
   re-exported below, so no importer moved. `PRICE_GRID` is a LIVE binding: read it at call time, never
   at module load. */
export { PRICE_GRID, type PriceCell, type ZoneType } from "./marketChart";

/* ==================================================================
    DESIGN NOTE 1501: AND THE CHART'S RULES ARE A VALUE TOO
   ==================================================================
   #1435 moved the chart's DATA out of this file; `gameEngine/marketGeometry.ts` now holds its RULES, for
   the reason #1199 wrote down and declined to act on -- the reducer's providers import the ladder's
   geometry out of this file, and this file imports React, so the server was dragging React in for a set
   of pure lookups. The functions are unchanged and every one of them is re-exported here, so no importer
   in the app or the tests moved. The renderer imports back the handful it actually draws with. */
export {
  marketCellForPrice,
  parBoxCellFor,
  PAR_BOX_PRICES,
  projectDividendFrom,
  projectShareSaleMove,
  projectRiseMove,
  projectBloodPriceMove,
  projectDividendCellMove,
  marketZoneForPrice,
  isCertificateExemptZone,
  allowsMultipleBankPoolBuys,
  type MarketProjection,
  type MarketPositionEntry,
  type MarketGridResponse,
} from "../gameEngine/marketGeometry";

/** One colour per real par value, keyed by price. Serves ONLY the `ParIpoTray`'s price-text accent
 *  since design note #20 folded the grid's par cells into the uniform Normal fill. */
const PAR_VALUE_COLORS: Readonly<Record<number, string>> = {
  100: "#e0c060",
  90: "#d4a94c",
  82: "#c89339",
  76: "#bb7d26",
  71: "#af6713",
  67: "#a35100",
};
const FALLBACK_PAR_VALUE_COLOR = "#8a6d1f";

/* ------------------------------------------------------------------ */
/* Rule zone color fills -- see design note #3                        */
/* ------------------------------------------------------------------ */

// Design note #25: `ZONE_COLORS` removed -- it painted the deleted legend's swatches; the cells use
// `ZONE_GRADIENTS`, and every non-Normal cell carries its label and rule as a `title`.

/** Gradient counterpart to the zone palette -- hand-paired lighter/darker shading, one entry per real
 *  zone colour. `Normal` has none, since an untinted cell has nothing to gradient. */
const ZONE_GRADIENTS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "linear-gradient(155deg, #7a6a1c 0%, #5c5015 55%, #453b0f 100%)",
  Orange: "linear-gradient(155deg, #7a4d1c 0%, #5c3a15 55%, #45290f 100%)",
  Brown: "linear-gradient(155deg, #54371a 0%, #3d2811 55%, #2c1c0a 100%)",
};

/** Bright, bold price-text color for zone-tinted cells only (design note
 *  #14) -- reads clearly against every `ZONE_GRADIENTS` fade, unlike the
 *  dim `styles.priceText.color` used for plain Normal-zone cells. */
const ZONE_PRICE_TEXT_COLOR = "#f5f6fa";

/** Design notes #18/#20: the uniform charcoal for EVERY `"Normal"`-tagged cell, including the six par
 *  cells. Value promoted from the former par-column neutral fill for contrast. */
/* Design note #1092: the chart is DOM/CSS grid, not canvas -- TD-2's own correction to the debt register
   says so, and this file has no `getContext` call. These three were mis-filed as canvas work twice, once by
   TD-2 and once by #1092's first pass; they are ordinary chrome and swept as such. */
const NORMAL_CELL_BACKGROUND = "#3a3a3a";

/** Design note #650: the six par cells. A flat, quiet tint -- dark enough
 *  that `styles.priceText`'s existing light ink stays legible without a
 *  per-cell contrast rule. */
const PAR_CELL_BACKGROUND = "#1e4430";

// Cumulative zone rules (each tier states what it adds), matching this project's documented
// interpretation -- design note #3. Design note #22: "certificate limit", the official 1830 term.
const ZONE_DESCRIPTIONS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "Certificates here do not count toward the certificate limit.",
  Orange:
    "Exempt from the certificate limit AND a single player may exceed the 60% corporate ownership cap.",
  Brown:
    "Exempt from the certificate limit, exceeds 60% cap, and players can buy multiple bank pool shares per turn.",
};

const ZONE_LEGEND_LABELS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "Yellow Zone",
  Orange: "Orange Zone",
  Brown: "Brown Zone",
};

/* Design note #196: the flat text ink for a zone, hand-paired with each gradient and lifted for
   contrast on a dark panel. A cell needs a multi-stop `background`; text needs one legible `color`,
   and assigning a gradient string to `color` fails silently. The PRICES still come from
   `marketZoneForPrice` -- this only says what a zone looks like as a word rather than a cell. */
export const ZONE_TEXT_COLORS: Readonly<Record<Exclude<ZoneType, "Normal">, string>> = {
  Yellow: "#e3c951",
  Orange: "#e39a51",
  Brown: "#c08a5e",
};

/** "Yellow Zone -- Certificates here do not count toward the certificate
 *  limit." One string, so a tooltip cannot show the label without the rule
 *  or the rule without the label. */
export function marketZoneTooltip(zone: ZoneType | null): string | null {
  if (zone === null || zone === "Normal") return null;
  return `${ZONE_LEGEND_LABELS[zone]} — ${ZONE_DESCRIPTIONS[zone]}`;
}

/** The flat ink for a zone, or `null` off the chart / in an ordinary cell. `null` rather than a
 *  default grey so a Normal price keeps the panel's own colour instead of looking like a fourth zone. */
export function marketZoneTextColor(zone: ZoneType | null): string | null {
  if (zone === null || zone === "Normal") return null;
  return ZONE_TEXT_COLORS[zone];
}

/** One price, tinted with its own zone's ink and carrying that zone's rule as a tooltip.
 *
 *  Design note #197 wrote this for the dividend move line: "a player reading this panel is looking at a
 *  NUMBER, not the chart, so stepping into the Yellow zone was invisible exactly when it mattered."
 *
 *  Design note #712 MOVED IT HERE, because the Stock Round's corporation cards needed exactly the same thing.
 *  REPORTED: "when a corporation is in yellow/orange/brown zones, its Market Price on the corp cards reflects
 *  that." It did not -- and the gap mattered more than a missing tint, because #712 also made those zones
 *  change what a player may BUY. A rule the board enforces and the card does not mention is the shape of
 *  problem that whole note is about.
 *  LIVING BESIDE THE ZONE TABLE is the point of the move: `marketZoneForPrice`, the ink and the tooltip are
 *  all in this file, so the tint cannot drift from the cell it is describing. */
export function ZonedPrice({ price }: { price: number | null }) {
  if (price === null) return <>--</>;
  const zone = marketZoneForPrice(price);
  const color = marketZoneTextColor(zone);
  const tooltip = marketZoneTooltip(zone);
  return (
    <span
      style={color ? { color, fontWeight: 700, cursor: "help" } : undefined}
      title={tooltip ?? undefined}
    >
      ${price}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Ticker color palette -- see design note #6                         */
/* ------------------------------------------------------------------ */

/* Design note #428: the local `TICKER_COLORS` is gone. The table lives in
   `styles/corporationLivery.ts`, so a recolour cannot reach one surface and miss another. */
const tickerColor = corporationLiveryColor;

/* ------------------------------------------------------------------ */
/* Disconnected Par/IPO Tray -- see design note #10                   */
/* ------------------------------------------------------------------ */

interface ParMarker {
  companyId: number;
  ticker: string;
  price: number;
}

/** Buckets parred companies by par price for the tray's rows -- design note #24: derived from contract
 *  state every render, not an observed cache, which could not represent a parred-but-unfloated company. */
function buildParMarkers(
  companies: ReadonlyArray<{ company_id: number; ticker: string; par_value: string | null }>,
): ReadonlyMap<number, ParMarker[]> {
  const byPrice = new Map<number, ParMarker[]>();
  for (const company of companies) {
    if (company.par_value === null) continue;
    const price = Number(company.par_value);
    if (!Number.isFinite(price)) continue;
    const marker: ParMarker = { companyId: company.company_id, ticker: company.ticker, price };
    const bucket = byPrice.get(price);
    if (bucket) bucket.push(marker);
    else byPrice.set(price, [marker]);
  }
  return byPrice;
}

/** The tray always lists all six standard prices highest-to-lowest,
 *  matching the physical game's own par track reading order. */
const PAR_TRAY_ROWS: readonly number[] = [100, 90, 82, 76, 71, 67];

/** Neutral steel-gray tray row background/border -- deliberately its own
 *  independent palette, NOT drawn from `PAR_VALUE_COLORS`/`PAR_VALUE_GRADIENTS`
 *  (the main grid's gold par-cell fills) or `ZONE_COLORS`/`ZONE_GRADIENTS`
 *  (the main grid's exception-zone fills) -- see design note #14. */
const PAR_TRAY_ROW_BG = "#1c1c1c";
const PAR_TRAY_ROW_BORDER = "#3a3a3a";

/* ------------------------------------------------------------------ */
/* Market Compass Rose -- see design note #746                         */
/* ------------------------------------------------------------------ */

/* ==================================================================
 *  DESIGN NOTE 747: FOUR ARROWS, FOUR RULES, ONE POCKET
 * ==================================================================
 *
 * ASKED FOR: "a 'compass rose' showing token movements? So an arrow right with 'Paid Dividends,' an arrow
 * left with 'Withheld Dividends,' an arrow up with 'All shares owned by players,' and an arrow down with
 * 'Per share sold'." And on placement: "The trouble is I like the current Stock Market panel and adding this
 * will create a lot of extra vertical space ... is there some way you could put this compass rose in the
 * lower horizontal space between the IPO/Par tray and the Stock Market Matrix?"
 *
 * THERE IS, AND IT COSTS NOTHING. The Par tray is a 168px column beside an eleven-row matrix and is only ever
 * about six rows tall, so the bottom of its column is already empty -- the rose drops into a pocket that
 * exists whether or not anything is in it. On a narrow window the tray wraps to its own row (#26's chosen
 * failure mode) and the rose wraps with it, still costing nothing beside it.
 *
 * WHICH IS WHY IT IS SIZED THE WAY IT IS. The pocket is roughly 120px tall at the smallest cell size and
 * several hundred at the largest, so the rose is built to fit the SMALL case: a compass, four tip labels, and
 * one clarifying line. Anything richer would have been honest on a wide monitor and a scrollbar on a laptop.
 *
 * THE COLOURS ARE THE ONES ALREADY IN USE for a market move -- #489's green rise and red fall, the same pair
 * the Dividends step draws its arrow in. Reused rather than re-picked so a player who has learned what green
 * means on one surface has not learned something else here.
 *
 * AND EVERY ARM NAMES A MOVEMENT THE CODE PERFORMS. That was not true when this was requested -- the up arrow
 * had no implementation anywhere in the frontend, which is what #746 is about. The harness asserts the
 * correspondence rather than trusting it, on #652's precedent: a legend row survived one verification cycle
 * describing a condition no cell on this board carried. */

interface CompassArm {
  /** The glyph, and the direction it means. */
  glyph: string;
  /** What the player did. Terse because the column is 168px wide. */
  label: string;
  rising: boolean;
  /** The full rule, for the tooltip and for a screen reader. */
  rule: string;
}

export const COMPASS_ARMS: Readonly<Record<"up" | "right" | "left" | "down", CompassArm>> = {
  /* SOLD OUT IS THE ONE THAT NEEDS ITS PARENTHETICAL. The other three are things a player just DID and will
     recognise; this one is a condition of the board that resolves at a moment nobody clicks, so "sold out"
     alone would leave them hunting for what they did wrong -- or right. */
  /* Design note #746c: "and again at the end of the Stock Round" REMOVED from this sentence, along with the
     second trigger it described. There is one rise and one moment. The caption was accurate about the code as
     it then stood, which is precisely why a wrong rule reaches a player: the legend agreed with the bug. */
  up: {
    glyph: "↑",
    label: "Sold out",
    rising: true,
    rule: "Every share in players' hands — IPO and Bank Pool both empty. Rises once, at the end of the Stock Round.",
  },
  right: {
    glyph: "→",
    label: "Paid",
    rising: true,
    rule: "The corporation paid dividends: one column right.",
  },
  left: {
    glyph: "←",
    label: "Withheld",
    rising: false,
    rule: "The corporation withheld dividends, including a forced $0: one column left.",
  },
  down: {
    glyph: "↓",
    label: "Each 10% sold",
    rising: false,
    rule: "One row down per 10% share sold — per block, not per sale.",
  },
};

/* ==================================================================
 *  DESIGN NOTE 962: THE ROSE HAS TO KNOW WHICH GAME IS BEING PLAYED
 * ==================================================================
 *
 * ASKED: "For Dynamic stock market: we need to update the compass rose on the Stock Market tab to reflect the
 * new movement mechanics."
 *
 * AND THE ROSE WAS A CONSTANT, which is exactly why it went stale. #908 changed what a paid dividend does to
 * the token -- nothing, one cell, or two, depending on the payout against the share price -- and this legend
 * kept saying "one column right" for every table, including the ones playing the variant. #746c already
 * recorded the shape of that failure in this very file: "The caption was accurate about the code as it then
 * stood, which is precisely why a wrong rule reaches a player: the legend agreed with the bug."
 *
 * ONE ARM CHANGES, AND ONLY UNDER THE VARIANT. Sold out, withheld and each-10%-sold are untouched by #908, so
 * they are shared between both roses rather than duplicated -- a second copy of "one row down per 10% share
 * sold" is a second thing to keep in step for no gain.
 *
 * THE SENTENCE IS THE VARIANT'S OWN, in the sense that matters: `dividendStepsFor` is the authority on how
 * many cells a payout moves, and this rule text states the same three bands in the same order. It cannot be
 * DERIVED from that function -- a legend describes the rule, not one evaluation of it -- so what keeps them
 * together is that both are named in this note and in `gameVariants`. Recording that plainly, because it is
 * the one join here that a test cannot close.
 *
 * THE LABEL GROWS A QUALIFIER rather than staying "Paid". At 168px "Paid" beside an arrow that might not move
 * the token is the same wrong-legend problem in fewer words. */
export function compassArmsFor(
  variants: GameVariants,
): Readonly<Record<"up" | "right" | "left" | "down", CompassArm>> {
  if (!variants.dynamicStockMarket) return COMPASS_ARMS;
  return {
    ...COMPASS_ARMS,
    right: {
      glyph: "→",
      label: "Paid (varies)",
      rising: true,
      /* Design note #988: THREE TIMES, from `DOUBLE_JUMP_MULTIPLE` rather than from the word "twice" typed
         here. This legend and `dividendStepsFor` are the pair #746c is about -- "The caption was accurate
         about the code as it then stood, which is precisely why a wrong rule reaches a player: the legend
         agreed with the bug" -- and a rebalance that moved the threshold while leaving "twice" on screen is
         that failure arriving on schedule. */
      rule: `Dynamic Stock Market: the corporation paid dividends. Under its own share price the token does not move; once the price, one column right; ${PAY_DOUBLE_JUMP_MULTIPLE} times the price or more, two columns.`,
    },
    /* ==================================================================
        DESIGN NOTE 994: THE WITHHOLD VARIES AFTER ALL, AND #988's ARM SAID THE OPPOSITE
       ==================================================================
       #988 GAVE THIS ARM A SENTENCE PRECISELY TO RULE THE VARIATION OUT -- "One column left, whatever the run
       was worth — the variant scales the reward, never the penalty" -- because beside a right arm labelled
       "Paid (varies)" an unqualified "Withheld" invited the wrong inference.
       RULED ONE BATCH LATER: "If a corporation Withholds revenue that is >= 3x the current share price, the
       stock must drop by 2 cells." So the inference #988 was at pains to prevent is now the rule, and the
       sentence written to prevent it would be the legend agreeing with nothing at all -- #746c's failure with
       the polarity reversed, and a good reminder that a legend written to deny a rule is as fragile as one
       written to state it.
       THE LABEL TAKES THE QUALIFIER TOO, matching the right arm. A tooltip nobody hovers is where #962 put the
       detail; the label is what is read at a glance, and "Withheld" beside "Paid (varies)" would still say
       the withhold is fixed.
       AND THE FLOOR IS IN THE SENTENCE, because it is the half a player cannot infer from the pay arm: the
       pay can move nothing at all, the withhold never can. */
    left: {
      ...COMPASS_ARMS.left,
      label: "Withheld (varies)",
      /* Design note #995: TWO TIMES HERE, THREE ON THE RIGHT ARM, and the rose is the one surface where a
         player sees both at once -- which is exactly why each arm reads its OWN constant. A shared figure
         would have made the asymmetry invisible on the legend that exists to show it. */
      rule: `Dynamic Stock Market: the corporation withheld. Always at least one column left, and ${WITHHOLD_DOUBLE_DROP_MULTIPLE} times the share price or more drops it two columns.`,
    },
  };
}

function CompassTip({ arm, stacked }: { arm: CompassArm; stacked?: boolean }) {
  return (
    <span
      style={{
        ...styles.compassTip,
        ...(arm.rising ? styles.compassRising : styles.compassFalling),
        ...(stacked ? styles.compassTipStacked : {}),
      }}
      title={arm.rule}
    >
      {arm.label}
    </span>
  );
}

function CompassGlyph({ arm }: { arm: CompassArm }) {
  return (
    <span
      style={{
        ...styles.compassGlyph,
        ...(arm.rising ? styles.compassRising : styles.compassFalling),
      }}
      role="img"
      aria-label={arm.rule}
      title={arm.rule}
    >
      {arm.glyph}
    </span>
  );
}

export function MarketCompassRose({ variants }: { variants?: Partial<GameVariants> } = {}) {
  /* Design note #962: `undefined` reads as the standard game, which is `resolveVariants`' own rule for a
     missing config (#902) and is what every caller that has not been threaded yet will pass. */
  const arms = compassArmsFor(resolveVariants(variants));
  return (
    <aside style={styles.compass}>
      <span style={styles.compassTitle}>Which way a token moves</span>

      <CompassTip arm={arms.up} stacked />
      <CompassGlyph arm={arms.up} />

      {/* The horizontal arms share one line, labels outboard of their arrows, which is what lets the whole
          rose read as a compass inside a column this narrow. */}
      <div style={styles.compassRow}>
        <CompassTip arm={arms.left} />
        <CompassGlyph arm={arms.left} />
        <span style={styles.compassHub} aria-hidden="true">
          &#9679;
        </span>
        <CompassGlyph arm={arms.right} />
        <CompassTip arm={arms.right} />
      </div>

      <CompassGlyph arm={arms.down} />
      <CompassTip arm={arms.down} stacked />

      {/* #651's rule: rules belong on screen, not only in tooltips. The one arm whose trigger is not an
          action a player takes gets its condition spelled out here rather than left to a hover. */}
      <span style={styles.compassFootnote}>
        Sold out = no shares left in the IPO or the Bank Pool.
      </span>
    </aside>
  );
}

function ParIpoTray({ markersByPrice }: { markersByPrice: ReadonlyMap<number, ParMarker[]> }) {
  return (
    <aside style={styles.parTray}>
      <div style={styles.parTrayHeader}>
        <span style={styles.parTrayTitle}>Par / IPO Tray</span>
        <span style={styles.parTrayHint} title="Par prices set here; a company moves onto the grid once it floats.">
          Reference only — markers are session-observed, not a live chain query
        </span>
      </div>
      {PAR_TRAY_ROWS.map((price) => {
        const markers = markersByPrice.get(price) ?? [];
        return (
          <div
            key={price}
            style={styles.parTrayRow}
            title={`Par $${price}`}
          >
            <span
              style={{
                ...styles.parTrayPrice,
                color: PAR_VALUE_COLORS[price] ?? FALLBACK_PAR_VALUE_COLOR,
              }}
            >
              ${price}
            </span>
            <div style={styles.parTrayMarkers}>
              {markers.length === 0 ? (
                <span style={styles.parTrayEmpty}>--</span>
              ) : (
                markers.map((marker) => (
                  <span
                    key={marker.companyId}
                    style={{
                      ...styles.parTrayMarkerBadge,
                      backgroundColor: tickerColor(marker.companyId),
                      /* Design note #430: the ink is COMPUTED, not `#ffffff` -- unreadable on C&O cyan, ERIE yellow and
                         NNH orange, and this colour is what the token's TEXT FALLBACK is drawn in. */
                      color: bestContrastTextColor(tickerColor(marker.companyId)),
                    }}
                    title={`${corporationLabel(marker.ticker)} — parred at $${price}`}
                  >
                    {/* Design note #430: the tray's pills are the largest corporate badges on this screen, so a herald
                       reads cleanly at this size -- the whole test for whether a raster mark belongs somewhere.
                       `CorporateLogo` brings its own `onError` fallback to the acronym, so no preloading or cache is
                       involved: this is the DOM, and an `<img>` that fails simply swaps itself for text. */}
                    <CorporateLogo
                      ticker={marker.ticker}
                      size={PAR_TRAY_LOGO_PX}
                      color={bestContrastTextColor(tickerColor(marker.companyId))}
                      title={`${corporationLabel(marker.ticker)} — parred at $${price}`}
                      fallbackStyle={styles.parTrayMarkerFallback}
                    />
                  </span>
                ))
              )}
            </div>
          </div>
        );
      })}
    </aside>
  );
}

/* Market Rules Legend -- design note #19/item 2. Same zone content as the old horizontal row, now a
   vertical card. */


/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export interface StockMarketRendererProps {
  /** `QueryMsg::GetMarketGrid`'s response, verbatim. */
  marketGrid: MarketGridResponse;
  /** Design note #1296: the corporations that have ALREADY operated this Operating Round -- derived by the
   *  shell from `active_operating_order` and the cursor, never logged. Their tokens flip to the barred side. */
  operatedCompanyIds?: ReadonlySet<number>;
  /** Design note #24: every corporation with a PAR PRICE SET, floated or not. Par is fixed when the
   *  President's Certificate is bought; floating is a later, separate 60% event, so the old
   *  watch-the-grid cache could never show a parred-but-unfloated company.
   *  Reads `PublicCompanyState.par_value`. Optional so the placeholder path renders an empty track. */
  parredCompanies?: ReadonlyArray<{ company_id: number; ticker: string; par_value: string | null }>;
  className?: string;
  /** Design note #962: which game is being played, so the compass rose can state the movement rule this
   *  table is actually using. Optional, and `undefined` reads as the standard game -- `resolveVariants`'
   *  own rule for a missing config (#902), which is also what a live chain that predates the field returns.
   *  PARTIAL, because that is what `GameStateResponse` actually carries -- #232's rule is that a chain
   *  reports what it reports, and a type demanding all four fields would have forced a cast at the one call
   *  site rather than admitting the shape. `resolveVariants` exists precisely to fill the gaps. */
  variants?: Partial<GameVariants>;
}

/** Fallback/default cell size, used only until the `ResizeObserver` below
 *  reports a real measurement (see design note #19 -- the same viewport-
 *  maximization item this mirrors in `HexGridRenderer.tsx`). */
const EMPTY_OPERATED: ReadonlySet<number> = new Set();
const CELL_SIZE_PX = 40;
const MIN_CELL_SIZE_PX = 22;
// Raised 72 -> 120 (design note #19/item 3): with the header-row legend
// relocated out of `boardArea`'s way, a genuinely widescreen pane can now
// measure enough available space to actually reach a much larger ceiling
// than the old ResizeObserver clamp allowed.
const MAX_CELL_SIZE_PX = 120;
const GRID_GAP_PX = 2;
// `REAL_BOARD_ROWS` is unused since design note #21/item 3 -- `cellSize` derives from available WIDTH
// alone, and a CSS grid's height is already intrinsic to its content.

/** Shrinks each token as more corporations share a cell -- design note #24(2)(b). A formula
 *  (`1.15 / sqrt(count)`, floored at 0.45x) so it degrades gracefully for any real occupant count. */
function tokenCountScale(count: number): number {
  if (count <= 1) return 1;
  return Math.max(0.45, 1.15 / Math.sqrt(count));
}

/** Station-token circle diameter -- design note #23(3)(a), recalibrated to a 0.62 cell ratio by
 *  #24(2)(b), clamped, then scaled by `tokenCountScale` for a shared cell. */
const MIN_TOKEN_DIAMETER_PX = 16;
const MAX_TOKEN_DIAMETER_PX = 46;

/* Design note #430: the diameter at or above which a token carries its herald instead of its acronym.
   26px is measured against the marks -- the PRR keystone survives a ~15px inner box, the NYC oval does
   not. The map's 18px station tokens stay on text for the same reason.
   Design note #452: hover both shrinks and scatters a cluster so the price underneath can be read;
   either effect alone is insufficient at four occupants. CSS `:hover`, not React state.
   Design note #648: the cell and the token cluster share a coordinate and only one can own the
   pointer, so the tooltip text is assembled here rather than inline. Exported alongside `PRICE_GRID`
   (design note #652) because it is where the removed "GAME END" sentence lived. */
export function cellTitleFor(cell: PriceCell): string {
  const zoneLabel = cell.zoneType !== "Normal" ? ZONE_LEGEND_LABELS[cell.zoneType] : undefined;
  const zoneDescription =
    cell.zoneType !== "Normal" ? ZONE_DESCRIPTIONS[cell.zoneType] : undefined;
  return [
    cell.isParValueLadder ? `Par Value $${cell.price}` : `$${cell.price}`,
    zoneLabel && zoneDescription ? `${zoneLabel}: ${zoneDescription}` : undefined,
    // Design note #22/item 2: standard cells state their certificate status.
    cell.zoneType === "Normal" ? "Stocks count toward certificate limit." : undefined,
    // Design note #43: what the arrow in the corner means.
    cell.isRightCliff ? "Right cliff: a price that would move right moves UP instead." : undefined,
    cell.isLeftCliff ? "Left cliff: a price that would move left moves DOWN instead." : undefined,
  ]
    .filter(Boolean)
    .join(" — ");
}

/* Design note #648's `PRICE_CELL_BY_KEY` is `priceCellByKey()` in `marketChart.ts` now (#1435): the
   chart can change per table, so the lookup is rebuilt when the chart is switched, not at module load. */

/* ==================================================================
    DESIGN NOTE 1159: THE HOVER LIFTS ONE TOKEN INSTEAD OF SCATTERING THE PILE
   ==================================================================
   #452 SHRANK AND SCATTERED THE WHOLE CLUSTER so the price underneath could be read, which was the right
   answer to a scatter: the tokens were already spread, so the only way to see past them was to move them all
   and make them smaller.
   A STACK ASKS A DIFFERENT QUESTION. The pile is deliberately overlapping now, and the thing a reader wants
   is not the price under it -- it is WHICH corporation each disc is, which the report says plainly: "mousing
   over one (or clicking on touch devices) should lift it out of the stack to see which it is."
   SO THE HOVER IS PER TOKEN, NOT PER CLUSTER, and it lifts rather than shrinks -- growing slightly and
   rising above its neighbours is what "out of the stack" looks like. `:focus-within` comes along so a
   keyboard reader gets the same lift, and a tap on a touch screen lands on `:hover` in every engine that
   matters, which is the report's "or clicking on touch devices".
   THE SCATTER VARIABLES ARE GONE with the behaviour they parameterised. */
const MARKET_TOKEN_SCATTER_CSS = `
.market-token-cluster .market-token {
  transition: transform 140ms ease, box-shadow 140ms ease;
}
.market-token-cluster .market-token-operated::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: linear-gradient(135deg, transparent 43%, #e5484d 43%, #e5484d 57%, transparent 57%);
  pointer-events: none;
}
.market-token-cluster .market-token:hover,
.market-token-cluster .market-token:focus-visible {
  transform: translateY(calc(var(--stack-lift, 6px) * -1)) scale(1.18);
  z-index: 60;
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.7);
}
@media (prefers-reduced-motion: reduce) {
  .market-token-cluster .market-token { transition: none; }
}
`;

const MIN_LOGO_TOKEN_DIAMETER_PX = 26;

/** The herald's height inside a par-tray pill. Sized to the pill's own
 *  `FONT_SIZE.strong` line rather than to a fixed box, so the badge does
 *  not change height when a logo loads or falls back to text. */
const PAR_TRAY_LOGO_PX = 17;
function deriveTokenDiameterPx(cellSize: number, occupantCount: number): number {
  const single = Math.max(MIN_TOKEN_DIAMETER_PX, Math.min(MAX_TOKEN_DIAMETER_PX, Math.round(cellSize * 0.62)));
  const scaled = Math.max(Math.round(MIN_TOKEN_DIAMETER_PX * 0.85), Math.round(single * tokenCountScale(occupantCount)));
  /* Design note #1296: and never taller than the room under the price. The row sits on the cell's bottom
     edge (2px), the price text occupies the top ~14px, so a disc taller than `cellSize - 16` would reach it.
     REPORTED: "B&O on $126 covers up the bottom half of 2 and 6". Small cells get small discs (the acronym
     takes over below #430's threshold); the value stays legible at every size. */
  return Math.max(12, Math.min(scaled, cellSize - 16));
}

/** Station-token ticker-label font size, scaled off the token's own live
 *  diameter (not cell size directly) so the label always fits the circle
 *  it's centered inside -- design note #23(3)(a). */
function deriveTokenFontSizePx(diameterPx: number): number {
  return Math.max(8, Math.round(diameterPx * 0.32));
}

/** Arranges N same-cell tokens in an evenly-spaced ring around the cell centre -- design note
 *  #24(2)(c). One occupant sits dead-centre; the old diagonal cascade buried all but the front-most. */
function deriveTokenClusterOffset(
  index: number,
  count: number,
  cellSize: number,
  diameterPx: number,
): { x: number; y: number } {
  if (count <= 1) return { x: 0, y: 0 };
  const radius = Math.min(cellSize * 0.42, Math.max(8, diameterPx * 0.6));
  const angle = (index / count) * 2 * Math.PI - Math.PI / 2;
  return { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
}

/** How far a token travels on hover, and how far it shrinks -- design note #689.
 *
 *  REPORTED: "the scatter effect on the stock market matrix when there's only one token simply shrinks the
 *  token in place, but the token (even shrunk) still covers the cell's value."
 *
 *  #452 SAID SO ITSELF and read it as a feature: "a lone occupant has a zero offset and does not move --
 *  correct, since it only needs the scale-down". The premise is the part that does not hold. A lone token
 *  renders at FULL size by #24(2) -- up to 46px -- and 0.72 of that is still ~33px sitting dead centre, while
 *  #649 puts every price in the TOP-LEFT corner. The shrink was never going to uncover it, because the token
 *  does not shrink toward a corner; it shrinks toward the middle, which is where it already was.
 *
 *  SO A LONE TOKEN GETS A DIRECTION, and the direction is not arbitrary: away from the price. Down and right is
 *  the one diagonal with nothing important on it -- the price is top-left (#649), the cliff arrows are top-right
 *  (#43), and the par badge at bottom-right is 6px of text a 23px disc can sit beside rather than on.
 *  AND A DEEPER SHRINK WITH IT. Moving alone leaves a big disc overlapping two quadrants; shrinking alone
 *  uncovers nothing. #452's own finding about clusters -- "either effect alone is insufficient" -- turns out to
 *  be true of a single token too, which is the part it did not test.
 *
 *  THE RESTING POSITION IS UNCHANGED. A lone token still sits centred at full size when nobody is pointing at
 *  it, which is what #24(2) wanted and what makes the chart readable at a glance. This is the hover vector
 *  only. */
export function deriveTokenScatterOffset(
  restingOffset: { x: number; y: number },
  count: number,
  cellSize: number,
): { x: number; y: number; scale: number } {
  if (count > 1) {
    /* A cluster travels along the spoke that already positioned it, so each token moves outward from the
       middle rather than across its neighbours. */
    return { x: restingOffset.x * 0.55, y: restingOffset.y * 0.55, scale: 0.72 };
  }
  /* Toward the free diagonal. Clamped so the token stays mostly inside its own cell -- the wrapper is
     `overflow: visible` and a cluster's members already spill a little, but a lone token sliding fully into a
     neighbouring cell would read as belonging to that price instead. */
  const travel = Math.min(cellSize * 0.28, 14);
  return { x: travel, y: travel, scale: 0.5 };
}

/** Design note #402: the gold frame's border thickness at the original cell size, kept as the ratio
 *  baseline. 4 -> 2.4px (a ~40% cut, deliberately fractional so scaling preserves it) with the floor
 *  dropped 3 -> 2, and the glow halved and made translucent rather than deleted.
 *  Design note #651: the baselines and their derive helpers went with the frame (#650). The reasoning
 *  is kept as the record of four passes spent making a gold rectangle behave. */

/** Floor a price cell's text can shrink to, even at `MIN_CELL_SIZE_PX` --
 *  see design note #13. */
const MIN_PRICE_FONT_SIZE_PX = 9;

/** Scales price-cell text proportionally to the live, dynamically-measured
 *  cell size (design note #13) -- the DOM/CSS-grid equivalent of the
 *  canvas-style `ctx.font = ...px` scaling this was requested as, translated
 *  to this component's actual rendering approach (design note #2). */
function derivePriceFontSizePx(cellSize: number): number {
  // Ratio raised 0.35 -> 0.4 (design note #19/item 3) so price text keeps
  // pace with the raised `MAX_CELL_SIZE_PX` ceiling instead of looking
  // relatively smaller inside the now-larger cells.
  return Math.max(MIN_PRICE_FONT_SIZE_PX, Math.floor(cellSize * 0.4));
}

interface CellOccupantGroup {
  key: string;
  x: number;
  y: number;
  occupants: MarketPositionEntry[];
}

export function StockMarketRenderer({
  marketGrid,
  operatedCompanyIds = EMPTY_OPERATED,
  parredCompanies,
  className,
  variants,
}: StockMarketRendererProps) {
  /* Design note #1294: the chrome scale, live, for the tray's step back into it (#1263). */
  const uiScale = useUiScale();
  // Viewport maximization (design note #19), un-clamped from HEIGHT by #21/item 3: a `ResizeObserver`
  // measures available WIDTH and derives the largest cell size that fits every column. A CSS grid needs
  // no explicit pixel height -- its content-driven height cascades up `App.tsx`'s unclamped flex chain.
  const gridWrapperRef = useRef<HTMLDivElement | null>(null);
  const [cellSize, setCellSize] = useState(CELL_SIZE_PX);

  useEffect(() => {
    const wrapper = gridWrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width } = entry.contentRect;
      if (width < 1) return;
      const cellFromWidth = (width - GRID_GAP_PX * (REAL_BOARD_COLUMNS - 1)) / REAL_BOARD_COLUMNS;
      const next = Math.floor(Math.max(MIN_CELL_SIZE_PX, Math.min(MAX_CELL_SIZE_PX, cellFromWidth)));
      setCellSize((prev) => (prev === next ? prev : next));
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Station-token sizing (design notes #23(3)(a)/#24(2)) is computed per
  // cell in the token render loop below, since diameter now also depends on
  // that cell's own live occupant count (`tokenCountScale`), which varies
  // cell by cell.
  const priceFontSizePx = derivePriceFontSizePx(cellSize);

  /* Design note #387: no par, no token. A market position is a claim that a corporation HAS a price,
     and only parring gives it one. Filtered at the renderer, not just in the fixture that produced the
     bad data, because the invariant is what a market position MEANS.
     `parredCompanies` is the same `par_value` field the par-track markers trust -- one source.
     An absent roster passes everything through: absent evidence is not evidence of absence (#385). */
  const tradingPositions = useMemo(() => {
    if (parredCompanies === undefined) return marketGrid.positions;
    const parred = new Set(
      parredCompanies
        .filter((company) => company.par_value !== null)
        .map((company) => company.company_id),
    );
    return marketGrid.positions.filter((position) => parred.has(position.company_id));
  }, [marketGrid.positions, parredCompanies]);

  // Groups live positions by cell so multi-occupant cells can be staggered (design note #5). A plain
  // typed array, not `Array.from(map.entries())`, so the render below does not depend on `Map` iterator
  // generics resolving under a bare `tsc` run.
  const cellOccupantGroups = useMemo<CellOccupantGroup[]>(() => {
    const groupsByKey = new Map<string, CellOccupantGroup>();
    for (const position of tradingPositions) {
      const x = clamp(position.x, MARKET_MIN_X, MARKET_MAX_X);
      const y = clamp(position.y, MARKET_MIN_Y, marketMaxY());
      const key = cellKey(x, y);
      const existing = groupsByKey.get(key);
      if (existing) {
        existing.occupants.push(position);
      } else {
        groupsByKey.set(key, { key, x, y, occupants: [position] });
      }
    }
    const groups: CellOccupantGroup[] = [];
    groupsByKey.forEach((group) => groups.push(group));
    return groups;
  }, [tradingPositions]);

  /* Design note #24: derived, not observed. The old module-scoped cache only knew about companies
     already ON the chart, which excluded the parred-but-unfloated case the track exists to show. */
  const parMarkersByPrice = useMemo(
    () => buildParMarkers(parredCompanies ?? []),
    [parredCompanies],
  );

  return (
    <div style={styles.root} className={className}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Stock Market</span>
        {/* Design note #387: counts the tokens actually drawn. Reading
            `marketGrid.positions` here would announce "4 companies trading"
            over an empty chart the moment any of them is unparred. */}
        <span style={styles.headerHint}>
          Game #{marketGrid.game_id} -- {tradingPositions.length}{" "}
          compan{tradingPositions.length === 1 ? "y" : "ies"} trading
        </span>
      </div>

      {/* Rule zone legend -- relocated out of this horizontal header-row
          spot into the vertical `MarketRulesLegend` side-column card next
          to `ParIpoTray` below (see design note #19/item 2). Removing it
          from here also hands `boardArea` its full available height. */}

      {/* Design note #25: matrix and par track SIDE BY SIDE. The matrix is far taller than it is wide at
         most window sizes, so a row beneath left a tall column of dead space. The legend is deleted -- every
         zone cell already carries its rule as a `title`. */}
      <div style={styles.boardRow}>
      <div style={styles.boardArea}>
        <div ref={gridWrapperRef} style={styles.gridWrapper}>
          <div
            style={{
              ...styles.grid,
              gridTemplateColumns: `repeat(${REAL_BOARD_COLUMNS}, ${cellSize}px)`,
              gridAutoColumns: `${cellSize}px`,
              gridAutoRows: `${cellSize}px`,
            }}
          >
          {/* Background price cells -- only the real, authentic-shape
              coordinates (see design note #1). Everything else in the
              backend's addressable space is simply never rendered here,
              which is what masks out the cliffside gaps. */}
          {PRICE_GRID.map((cell) => {
            // Tag-driven fill priority -- design note #20: `isGameEndCell` -> a real `zoneType` -> par tint ->
            // `NORMAL_CELL_BACKGROUND`. No column index, no price lookup.
            // Design note #650: the par cells are TINTED, not framed. An overlay drawn on top of six cells was a
            // different KIND of object from everything else here (every other meaning is a fill), which is why
            // four passes of layering fixes never made it belong. Green, muted and distinct from the game-end
            // gradient. Ordered AFTER the zone test: a zone carries a rule, the tint carries an option.
            const gradient = cell.zoneType !== "Normal"
              ? ZONE_GRADIENTS[cell.zoneType]
              : cell.isParValueLadder
                ? PAR_CELL_BACKGROUND
                : NORMAL_CELL_BACKGROUND;
            // Tooltip text -- design notes #16/#18: price, plus the zone's own name alongside its rule, never a
            // raw coordinate. Sourced from `zoneType`/`isParValueLadder` directly.

            // Design note #22: every `"Normal"` cell states its certificate-limit status explicitly, the
            // counterpart to the zones' exemption wording.

            // Design note #23(2): par tooltips trimmed to "Par Value $X" plus the certificate-limit rule.
            // Design note #648: assembled by `cellTitleFor`, which the token cluster also reads -- the cluster
            // covers the cell as a hover target and would otherwise swallow the tooltip on every occupied cell.
            const titleParts = [cellTitleFor(cell)];
            return (
              <div
                key={cellKey(cell.x, cell.y)}
                style={{
                  ...styles.cell,
                  gridColumn: cell.x + 1,
                  gridRow: marketMaxY() + 1 - cell.y, // #1435: the chart in effect decides the top row
                  // `background` always fully replaces `backgroundColor` -- design note #18/item 1 makes even the
                  // no-special-treatment case an explicit value rather than a fall-through.
                  background: gradient,
                  /* Design note #649: every price sits in the same corner. #24(1) centred the par prices to dodge the
                     gold frame; the frame is gone (#650), and a column of prices in one corner is scannable. */
                  justifyContent: "flex-start",
                  alignItems: "flex-start",
                }}
                title={titleParts.join(" — ")}
              >
                {/* Design note #43: cliff arrows. The board's edges are RULES, and a tooltip nobody hovers was the
                   only place they were stated. Colour follows CONSEQUENCE, not direction of travel: green up on the
                   right, red down on the left. Both sit top-right -- a row's two cliffs are never the same cell. */}
                {cell.isRightCliff && (
                  <span style={{ ...styles.cliffArrow, ...styles.cliffArrowUp }} aria-hidden="true">
                    &#9650;
                  </span>
                )}
                {cell.isLeftCliff && (
                  <span
                    style={{ ...styles.cliffArrow, ...styles.cliffArrowDown }}
                    aria-hidden="true"
                  >
                    &#9660;
                  </span>
                )}
                <span
                  style={{
                    ...styles.priceText,
                    // Dynamic font scaling (design note #13): sized off the
                    // live measured `cellSize`, not a fixed pixel value.
                    fontSize: `${priceFontSizePx}px`,
                    // Tag-driven text colour, mirroring the background chain exactly -- design note #20 -- so brightness
                    // can never disagree with whether a tint actually rendered.
                    color:
                      cell.zoneType !== "Normal"
                        ? ZONE_PRICE_TEXT_COLOR
                        : styles.priceText.color,
                    // Par-ladder cells keep bold weight alongside the "PAR"
                    // badge and their #650 green tint -- one more small signal
                    // (not a colour) that these six are starting options, not
                    // just ordinary Normal cells.
                    fontWeight:
                      cell.isParValueLadder || cell.zoneType !== "Normal" ? 700 : 600,
                  }}
                >
                  {cell.price}
                </span>
                {cell.isParValueLadder && <span style={styles.parBadge}>PAR</span>}
              </div>
            );
          })}

          {/* Design note #650: the gold `parGroupFrame` is gone, and with it four passes of layering fixes
             (#20's seam, #23(1)'s stacking order, #402's thinning, #24(1)'s clipped numbers). The par cells
             carry a green tint instead, so the grouping is a property of the cells rather than a box over them. */}

          {/* Live company tokens -- placed as independent grid items (see
              design note #5/#8) so a token is never silently dropped even
              if its coordinate falls outside `REAL_MARKET_ROWS`'s mask or
              has no rendered background price cell for any other reason. */}
          {cellOccupantGroups.map((group) => {
            // Design note #24(2): diameter (and therefore font size) is
            // computed per cell, off that cell's own live occupant count --
            // a lone token renders at full size; a cluster shrinks so every
            // member stays legible.
            const occupantCount = group.occupants.length;
            const tokenDiameterPx = deriveTokenDiameterPx(cellSize, occupantCount);
            const tokenFontSizePx = deriveTokenFontSizePx(tokenDiameterPx);
            return (
              <div
                key={group.key}
                className="market-token-cluster"
                style={{ ...styles.tokenWrapper, gridColumn: group.x + 1, gridRow: marketMaxY() + 1 - group.y }}
                /* Design note #648: the cell's own facts, because this box is
                   now what the pointer meets there. `undefined` for a token
                   at a coordinate with no cell -- design note #5/#8's orphan
                   case, which has no price to report. */
                title={
                  priceCellByKey().get(cellKey(group.x, group.y))
                    ? cellTitleFor(priceCellByKey().get(cellKey(group.x, group.y)) as PriceCell)
                    : undefined
                }
              >
                {/* ==================================================================
                      DESIGN NOTE 1159: A STACK, NOT A SCATTER
                    ==================================================================
                    REPORTED: "there is no such stack happening on our cells, the corporation markers are
                    simply scattered around it ... we need to stack them in a line with overlapping edges."
                    #24(2)(c) CHOSE THE SCATTER OVER A CASCADE and gave a real reason -- "the old diagonal
                    cascade buried all but the front-most" -- which is an objection to a cascade with nothing
                    to lift the buried ones out. The report supplies the missing half in the same breath
                    ("mousing over one should lift it out of the stack"), so the objection is answered rather
                    than overruled, and the cascade can carry meaning the scatter never could.
                    THE ORDER IS THE OPERATING CURSOR'S, taken from `stackOrder` so this cannot become a
                    second opinion about turn order (#891). Earliest arrival on top: it operates first, and a
                    new entrant slides underneath exactly as the cardboard does. */}
                {/* ==================================================================
                      DESIGN NOTE 1267: THE PILE RUNS ACROSS THE CELL, NOT DOWN IT
                    ==================================================================
                    REPORTED: "splay corporation tokens horizontally, not vertically. They stop covering the
                    cell value, and hovering currently lifts a token UNDERNEATH the one above it."
                    BOTH ARE THE SAME AXIS. A vertical pile climbs from the cell's centre toward its top-left
                    corner, which is where `priceText` sits, so three tokens hid the one number the chart is
                    for. And the hover lifts a token UP (`--stack-lift`), so in a vertical pile "up" was
                    straight into the neighbour above -- the lifted disc slid under it, which is the opposite
                    of "lift it out of the stack". Across, the lift is perpendicular to the pile: a token
                    rises clear of both neighbours, and the price stays readable above the whole row.
                    ANCHORED TO THE CELL'S LOWER HALF for the same reason -- the value is top-left, so the
                    row keeps its distance. #1159's order is untouched: earliest arrival first, so it is the
                    leftmost, which is where a reader's eye starts. */}
                {/* ==================================================================
                      DESIGN NOTE 1296: ONE ROW, TWO STACKS -- THE STILL-TO-OPERATE AND THE OPERATED
                    ==================================================================
                    RULED (19/19a/19b): "One row, but two stacks within it: the 'top' stack is the
                    active/still-to-play corporations, the 'bottom' is the already-operated corporations
                    flipped to their barred side ... rightmost spot is the top." So the row reads, left to
                    right: the operated stack, then the active stack, each rightmost-first splayed left -- the
                    row's rightmost token is the next to operate, and a token that has run drops into the
                    left stack, barred and desaturated (`market-token-operated`). All flip back when the
                    Operating Round ends, because "operated" is derived from the cursor and the cursor resets.
                    #1159's ORDER IS UNCHANGED within each stack: `stackOrder` gives earliest arrival first,
                    and earliest-first drawn rightmost-first is the same list read from the other end.
                    AND THE VALUE IS NEVER COVERED (19): the row is anchored to the cell's BOTTOM edge and the
                    disc is capped so its top clears the price text in the top-left corner, whatever the count. */}
                {(() => {
                  const active = stackOrder(group.occupants.filter((o) => !operatedCompanyIds.has(o.company_id)));
                  const operated = stackOrder(group.occupants.filter((o) => operatedCompanyIds.has(o.company_id)));
                  // Left to right: operated (rightmost-first), then active (rightmost-first).
                  const row = [...[...operated].reverse(), ...[...active].reverse()];
                  const gapBetweenStacks = operated.length > 0 && active.length > 0 ? tokenDiameterPx * 0.3 : 0;
                  return row.map((occupant, index) => {
                    const isOperated = operatedCompanyIds.has(occupant.company_id);
                    const extra = isOperated ? -gapBetweenStacks / 2 : gapBetweenStacks / 2;
                    const x = stackOffset(index, row.length, tokenDiameterPx) + extra;
                    return (
                      <MarketToken
                        key={occupant.company_id}
                        className={isOperated ? "market-token market-token-operated" : "market-token"}
                        companyId={occupant.company_id}
                        ticker={occupant.ticker}
                        diameterPx={tokenDiameterPx}
                        fontSizePx={tokenFontSizePx}
                        title={`${corporationLabel(occupant.ticker)} — $${occupant.price ?? "?"}${
                          isOperated ? " (has operated this round)" : ""
                        }`}
                        style={{
                          position: "absolute",
                          pointerEvents: "auto",
                          bottom: "2px",
                          left: `calc(50% + ${x}px - ${tokenDiameterPx / 2}px)`,
                          /* The rightmost token is the next to operate, and it is on top. */
                          zIndex: 10 + index,
                          ...(isOperated ? { filter: "saturate(0.35) brightness(0.9)" } : null),
                        }}
                      />
                    );
                  });
                })()}
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {/* Design note #25: the par track, in the whitespace beside the
          matrix. `flex: 0 0 auto` so it keeps its natural width and the
          grid's own `ResizeObserver` measures only what is left. */}
      {/* Design note #452: the same `<style>`-tag escape hatch the tab bar
          and the turn pulse use -- inline styles cannot express `:hover`. */}
      <style>{MARKET_TOKEN_SCATTER_CSS}</style>
      {/* Design note #747: the tray and the rose share one column, and the rose lands in the pocket the
          tray's six rows leave under it beside an eleven-row matrix -- so it costs no height at all. */}
      <div style={{ ...styles.traySlot, zoom: uiScale }}>
        <ParIpoTray markersByPrice={parMarkersByPrice} />
        <MarketCompassRose variants={variants} />
      </div>
      </div>
      <MarketCellLegend />
    </div>
  );
}

/* Design note #651: the cell-colour legend, under the matrix rather than beside it (a side column
   competes for the width the grid is maximising). Rules belong on screen, not in tooltips.
   Swatches read the same constants the cells paint with -- but that guarantee is one-directional:
   #652 proves sourcing the colour does not check that any cell uses it. Every row must name a live fill. */
function MarketCellLegend() {
  const entries: Array<{ label: string; rule: string; fill: string }> = [
    {
      label: "Par values",
      // Design note #650: the tint the six starting prices now carry.
      rule: "The six prices a corporation may be started at.",
      fill: PAR_CELL_BACKGROUND,
    },
    ...(Object.keys(ZONE_LEGEND_LABELS) as Array<Exclude<ZoneType, "Normal">>).map((zone) => ({
      label: ZONE_LEGEND_LABELS[zone],
      rule: ZONE_DESCRIPTIONS[zone],
      fill: ZONE_GRADIENTS[zone],
    })),
    {
      label: "Standard",
      rule: "Stocks count toward the certificate limit.",
      fill: NORMAL_CELL_BACKGROUND,
    },
    /* Design note #652: NO "Game end" ROW. There was one here for exactly one
       verification cycle, describing a condition no cell on this board
       carries -- which is how the dormant `isGameEndCell` flag finally got
       caught. $350 is the top of the chart and nothing more. */
  ];
  return (
    <div style={styles.cellLegend}>
      {entries.map((entry) => (
        <span key={entry.label} style={styles.cellLegendEntry}>
          <span style={{ ...styles.cellLegendSwatch, background: entry.fill }} aria-hidden="true" />
          <span style={styles.cellLegendLabel}>{entry.label}</span>
          <span style={styles.cellLegendRule}>{entry.rule}</span>
        </span>
      ))}
    </div>
  );
}

export default StockMarketRenderer;

// Inline styles -- plain style objects, matching `App.tsx`'s convention (no CSS framework here yet).

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "16px",
    // Design note #1117: the one viewport ground, shared by every tab.
    backgroundColor: INK_VIEWPORT,
    // Design note #1257: square on top, where the tab strip attaches.
    borderRadius: VIEWPORT_RADIUS,
    color: "#f2f0eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    // Design note #21/item 3: `overflow: "auto"` and `height: "100%"` both removed -- the inner scrollbar
    // and a percentage height that only resolved against a `boardPane` which no longer imposes one
    // (`App.tsx #13`). The panel sizes to its content and the page's own scrollbar takes over.
    width: "100%",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "12px",
    flexWrap: "wrap",
  },
  headerTitle: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    letterSpacing: "0.02em",
  },
  headerHint: {
    fontSize: FONT_SIZE.small,
    color: "#8a8a86",
  },
  // The old horizontal legend row went with design note #19/item 2; these styles are shared with the
  // vertical `MarketRulesLegend` card and were upscaled again by #21/item 4.
  // Design note #651: the cell-colour legend under the matrix is a wrapping row, not a fixed grid, so it
  // folds to two lines on a narrow window with no breakpoint to maintain.
  cellLegend: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px 18px",
    padding: "10px 4px 2px",
  },
  cellLegendEntry: { display: "inline-flex", alignItems: "baseline", gap: "7px", minWidth: 0 },
  /* Sized to read as a CELL rather than a dot: the thing it stands for is a
     rectangle on the grid above, and a circle would be a second shape for one
     idea. */
  cellLegendSwatch: {
    width: "18px",
    height: "13px",
    borderRadius: RADIUS.control,
    border: "1px solid rgba(0, 0, 0, 0.45)",
    flex: "none",
    alignSelf: "center",
  },
  cellLegendLabel: { fontSize: FONT_SIZE.small, fontWeight: 800, color: "#f2f0eb" },
  cellLegendRule: { fontSize: FONT_SIZE.micro, color: "#a8a6a0" },
  legendText: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 600,
    color: "#c8c6c0",
    lineHeight: 1.45,
  },
  // Column layout (design note #23(3)(b)): the grid renders first, at the
  // panel's full available width, then `belowGridRow` renders beneath it --
  // replaces the old row layout that sat the grid and a fixed-width side
  // column beside each other.
  boardArea: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    /* ==================================================================
        DESIGN NOTE 1161: `flex-basis: auto` IS WHAT WRAPPED THE TRAY, AND IT LATCHED
       ==================================================================
       REPORTED: "the Par/IPO tray is no longer on the same line as the Stock Market matrix. It has been
       pushed below it, causing a massive vertical scroll."
       #26 ALREADY INTENDED THIS TO SHRINK -- its note says "`minWidth: 0` is what actually lets the grid
       shrink-and-grow instead of squeezing the tray" -- and `minWidth: 0` cannot do that alone. A wrapping
       flex line is packed by each item's HYPOTHETICAL main size, and `flex-basis: auto` makes that the
       CONTENT width: nineteen columns at the current cell size. `min-width` is consulted when the line is
       sized, which is after the browser has already decided how many lines there are. So the grid asked for
       its full content width, the 168px tray did not fit beside it, and the row broke.
       AND THE BREAK IS SELF-SUSTAINING, which is why it reads as a hard regression rather than a squeeze.
       The `ResizeObserver` measures this column and derives `cellSize` from what it finds. Wrapped, this
       column has the WHOLE row to itself -- so the cells grow to fill it, the content gets wider still, and
       the layout can never come back. One wrap latches the tray under the matrix for the rest of the session.
       `flex: 1 1 0` UNLATCHES IT. A zero basis means the hypothetical size is zero, so this column always
       fits beside the tray and the line never breaks; it then grows into exactly the space the tray leaves,
       which is the width the observer was always meant to be measuring. The cell size follows the pane down
       instead of the pane following the cells up. */
    flex: "1 1 0",
    minWidth: 0,
  },
  // Wraps just the grid so the `ResizeObserver` measures only the matrix's own space (design note
  // #19/item 3), now the panel's full width (#23(3)(b) removed the sibling column). `overflow`/
  // `minHeight` removed by #21/item 3.
  gridWrapper: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  // Design note #23(3)(b): the tray and legend sit in a row BENEATH the matrix (a WIDTH flex basis)
  // rather than stacked beside it.
  // Design note #25: matrix + par track on one row, wrapping on a narrow window.
  // Design note #26: the MATRIX dominates -- the tray's old fixed third is now a slim column, and
  // `minWidth: 0` is what actually lets the grid shrink-and-grow instead of squeezing the tray.
  boardRow: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: "12px",
    width: "100%",
  },
  /* Design note #747: THE COLUMN, which now holds two things. The width flex-basis moved up here from
     `parTray` -- inside a column the basis would size the tray's HEIGHT, which is not what #26 meant by it.
     The tray keeps its own look and simply fills the width it is given. */
  traySlot: {
    /* ==================================================================
        DESIGN NOTE 1263: THE TRAY IS CHROME, AND IT WAS DRAWN AS A BOARD
       ==================================================================
       REPORTED: "Par/IPO tray gigantic."
       #1144 put `zoom: UI_SCALE` (0.7) on the shell and `boardPane` divides it back out, because the two
       canvases size themselves to the viewport and must not be scaled twice. This whole renderer sits inside
       that pane -- and this column is not a canvas. It is a list of prices and pills, HTML like every other
       panel, and it was being drawn at 1/0.7 of the scale everything around it uses: 168px became 240 on
       screen, its type twice the size of the action bar's. That is the "gigantic".
       ZOOMED BACK TO THE CHROME'S SCALE HERE, on the slot, so the tray and the rose under it read at the same
       size as the panels beside the matrix. The matrix keeps the pane's exemption, which is what it needs.
       `168px` is now 168 chrome pixels, which is what #25 meant by it. */
    /* Design note #1294: `zoom` is written per render from `useUiScale()`. */
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    // Design note #26's basis, unchanged in value: slim, fixed, wrapping to its own row when it must.
    flex: "0 0 168px",
    minWidth: "168px",
  },
  // ---- Disconnected Par/IPO Tray -- see design notes #10/#17. ----
  parTray: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "12px 14px",
    // Design note #747: sizing moved to `traySlot`; this fills it.
    flex: "0 0 auto",
    width: "100%",
    boxSizing: "border-box",
    backgroundColor: "#0f0f0f",
    border: "1.5px solid #2a2a2a",
    borderRadius: RADIUS.card,
  },
  // ---- Market Compass Rose -- see design note #747. ----
  compass: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
    padding: "12px 10px",
    flex: "0 0 auto",
    width: "100%",
    boxSizing: "border-box",
    backgroundColor: "#0f0f0f",
    border: "1.5px solid #2a2a2a",
    borderRadius: RADIUS.card,
    textAlign: "center",
  },
  compassTitle: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "#a8a6a0",
    marginBottom: "6px",
  },
  compassRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    width: "100%",
  },
  compassGlyph: {
    fontSize: "17px",
    lineHeight: 1,
    fontWeight: 700,
  },
  compassHub: {
    fontSize: "7px",
    color: "#6e6c68",
    margin: "0 2px",
  },
  compassTip: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  /* The vertical arms' labels sit on their own line, so they get a little breathing room the horizontal
     pair -- which is already hemmed in by the arrows either side -- must not have. */
  compassTipStacked: {
    padding: "1px 0",
  },
  // Design note #489's pair, reused: green is a rise, red is a fall, everywhere on this app.
  compassRising: { color: "#4ade80" },
  compassFalling: { color: "#f87171" },
  compassFootnote: {
    marginTop: "8px",
    fontSize: "10px",
    lineHeight: 1.35,
    color: "#6e6c68",
  },
  // ---- Market Rules Legend -- see design note #19/item 2. ----
  legendColumn: {
    display: "flex",
    flexDirection: "column",
    // Gap widened slightly (14px -> 18px) to give design note #21/item 4's
    // larger zone title/description text room to breathe between entries.
    gap: "18px",
    padding: "20px 22px",
    // Width flex basis now (design note #23(3)(b)) -- see `parTray` above.
    flex: "1 1 340px",
    minWidth: "300px",
    backgroundColor: "#0f0f0f",
    border: "1.5px solid #2a2a2a",
    borderRadius: RADIUS.card,
  },
  parTrayHeader: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginBottom: "8px",
  },
  parTrayTitle: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "#c8c6c0",
  },
  parTrayHint: {
    fontSize: FONT_SIZE.micro,
    color: "#6e6c68",
    lineHeight: 1.35,
  },
  parTrayRow: {
    // Design note #26: compact rows for the narrow column.
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "11px 16px",
    borderRadius: RADIUS.card,
    // Neutral steel-gray, decoupled from both the main chart's gold par
    // fills and its exception-zone tints -- see design note #14.
    backgroundColor: PAR_TRAY_ROW_BG,
    border: `1px solid ${PAR_TRAY_ROW_BORDER}`,
  },
  parTrayPrice: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    // Upsized well past the main chart's own necessarily-small per-cell
    // numbers -- see design note #17: this panel's only job is being an
    // easy-to-read reference sheet.
    fontSize: FONT_SIZE.display,
    fontWeight: 700,
    // Per-row color is overridden inline from `PAR_VALUE_COLORS` so the six
    // standard prices stay visually distinguishable against the now-neutral
    // row background; this is just the fallback.
    color: "#c8c6c0",
  },
  parTrayMarkers: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    justifyContent: "flex-end",
  },
  parTrayEmpty: {
    fontSize: FONT_SIZE.strong,
    // Muted steel-gray to match the tray's now-neutral background (was
    // tuned for the old gold row fill -- see design note #14).
    color: "#6e6c68",
  },
  parTrayMarkerBadge: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    // Upsized alongside `parTrayPrice` -- see design note #17.
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    /* Design note #430: `color: "#f2f0eb"` REMOVED. The ink is computed per
       livery at the call site now -- five of the eight need white and three
       need black, so a hardcoded value was wrong for three corporations. */
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "5px 11px",
    borderRadius: RADIUS.pill,
    border: "1px solid rgba(0, 0, 0, 0.35)",
    whiteSpace: "nowrap",
  },
  /* Design note #430: the par pill's TEXT fallback keeps the pill's own
     typography exactly, so a corporation whose logo is missing is
     indistinguishable from how every pill looked before this change. */
  parTrayMarkerFallback: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
  },
  // Sized to `REAL_BOARD_COLUMNS`, now the backend's full 19-column range (design note #1). A token
  // past this renders via an implicit grid track rather than being clipped.
  grid: {
    display: "grid",
    gridTemplateColumns: `repeat(${REAL_BOARD_COLUMNS}, ${CELL_SIZE_PX}px)`,
    gridAutoColumns: `${CELL_SIZE_PX}px`,
    gridAutoRows: `${CELL_SIZE_PX}px`,
    gap: "2px",
    overflow: "visible",
  },
  cell: {
    position: "relative",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "flex-start",
    backgroundColor: "#0f0f0f",
    // See design note #7 -- bright enough that adjacent cells' shared edges
    // read as a clear boundary/movement-path grid.
    border: "1px solid #3a3a3a",
    borderRadius: RADIUS.control,
    // `hidden`, not `visible` (design note #17): a gradient must never bleed past its cell into the grid
    // gap. Safe because live tokens are independent sibling grid items (#5), so a deep stack still spills.
    overflow: "hidden",
    // Explicit stacking layer -- design note #23(1): below `parGroupFrame`
    // (zIndex 6) so that overlay's border always paints over every cell's
    // own border rather than the reverse.
    zIndex: 1,
  },
  // Design note #651: `parGroupFrame` removed with the overlay it painted (#650); the six par cells are
  // told apart by their tint, which the legend under the matrix names in words.
  // Price ink promoted from the former par-column colour (#20) -- one colour for every `"Normal"` cell.
  // Design note #43: the cliff arrow is absolutely positioned in the cell's top-right corner so it never
  // displaces the dynamically-sized price text.
  cliffArrow: {
    position: "absolute",
    top: "1px",
    right: "2px",
    lineHeight: 1,
    fontSize: "9px",
    pointerEvents: "none",
    textShadow: "0 0 2px rgba(0,0,0,0.8)",
  },
  cliffArrowUp: { color: "#4ade80" },
  cliffArrowDown: { color: "#f87171" },
  priceText: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "9px",
    color: "#c8c6c0",
    padding: "2px 3px",
  },
  parBadge: {
    position: "absolute",
    right: "2px",
    bottom: "1px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "6px",
    fontWeight: 700,
    letterSpacing: "0.03em",
    color: "#1a1408",
    opacity: 0.75,
  },
  /* Design note #652: `gameEndBadge` removed with the flag that rendered it. */
  tokenWrapper: {
    position: "relative",
    overflow: "visible",
    /* Design note #648: the CELL is the hover target, not the token. `pointer-events: none` made the
       scatter its own off switch -- the pointer entered a token, the token moved out from under it, and it
       oscillated. `auto` makes the wrapper (a grid item filling the cell) the target, so the region no
       longer moves. The cost is the cell's tooltip, paid back by the wrapper carrying `cellTitleFor`. */
    pointerEvents: "auto",
    // Explicit stacking layer -- design note #23(1): above `parGroupFrame`
    // (zIndex 6), so live company tokens keep rendering in front of the par
    // frame exactly as before that fix.
    zIndex: 10,
  },
  // Station-token circle -- design note #23(3)(a). Fixed diameter (set
  // inline per-token from `deriveTokenDiameterPx`) with the ticker label
  // flex-centered inside, replacing the old auto-width text pill --
  // matching the physical 1830 game's own circular station-token pieces.
  tokenBadge: {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontWeight: 700,
    // Design note #430: computed per livery at the call site.
    borderRadius: RADIUS.circle,
    border: "2px solid rgba(0, 0, 0, 0.4)",
    boxShadow: "0 2px 4px rgba(0, 0, 0, 0.55)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    lineHeight: 1,
    textAlign: "center",
    pointerEvents: "auto",
  },
};
