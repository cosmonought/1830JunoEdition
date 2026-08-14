// frontend/src/components/ContextualSubPanel.tsx
//
// The automated contextual block underneath the main board canvas (see
// App.tsx's restructure, item 2 of this pass): switches its entire content
// based on the room's live `GameStateResponse.current_round_type` -- a
// Player Index during a Stock Round, a Corporation panel during an
// Operating Round -- rather than a host screen manually deciding which to
// show.
//
// Design notes:
// 1. **Driven entirely by `current_round_type`, no other prop decides the
//    mode.** `RoundType` (from `utils/gameState.ts`) is exactly the three
//    real backend variants, `"WaterfallAuction"` / `"StockRound"` /
//    `"OperatingRound"` -- this component's own branch covers all three
//    explicitly (see `WaterfallAuctionNotice` below), rather than letting
//    the pre-existing Waterfall Auction genesis phase fall through into the
//    Operating Round branch by accident. `RoundType` gained
//    `"WaterfallAuction"` when the Pre-Game Waterfall Auction Engine
//    (`waterfall.rs`) was added -- every room now starts there, before
//    `"StockRound"` is reachable at all.
// 2. **Stock Round: Player Index.** Every `player_addresses` entry, its
//    live cash treasury (`player_cash`), and an ESTIMATED certificate
//    count (`certificateCount` -- see that function's own doc
//    comment in `utils/gameState.ts` design note #3 for exactly what
//    "estimated" means and why). The room's active player
//    (`active_player_index`) is highlighted.
// 3. **Operating Round: Corporation panel.** Every `public_companies`
//    entry's real treasury/floated/president fields, with the active
//    corporation in the Operating Round Corporation Turn Queue
//    (`active_operating_order[active_corporation_index]`) highlighted.
//    "Routes and train sheets" -- explicitly asked for by this pass's own
//    request -- are NOT fabricated: `src/state.rs` genuinely models
//    hardware/train ownership and `pathfinding.rs` genuinely traces routes
//    for revenue during `ExecuteOperatingRound`, but no `QueryMsg` exposes
//    either (verified against `src/msg.rs` for this pass -- see
//    `utils/gameState.ts` design note #2). This panel says so directly,
//    the same "DESIGN GAP" callout style used throughout this codebase,
//    rather than inventing plausible-looking route/train numbers.
// 4. **No live game state yet.** Before a real `GetGameState` query
//    resolves (or if the placeholder contract/game_id in `App.tsx` simply
//    can't be reached), this renders a single honest placeholder row
//    instead of an empty or broken-looking table.
// 5. **Upscaled Round Detail text (App.tsx design note #12/item 5's "Round
//    Detail Footer" bullet, final visual theme pass).** This is the
//    "structural footer pane" that item names -- `App.tsx` renders this
//    component directly underneath the board canvas. Pure typography/
//    spacing: header/table/footnote text all scaled up roughly 25-40% so
//    the active phase status (the header title, the SR/OR round badge, and
//    the active-player/active-corporation row highlight) reads clearly at
//    a glance instead of as fine print. No behavior change.

import React from "react";

import type { GameStateResponse } from "../utils/gameState";
import { corporationFullName } from "../utils/corporationNames";
import { derivePhase, rustOutlook } from "../utils/gamePhase";
import { CapacityPill, LastRoutePayout, TrainChips } from "./TrainBadges";
import { stationTickerColor } from "./hexContractTypes";
import { marketZoneForPrice, type MarketGridResponse } from "./StockMarketRenderer";
import { certificateBreakdown, formatCertificateCount } from "../utils/gameState";
import { FONT_SIZE } from "../styles/typography";

export interface ContextualSubPanelProps {
  gameState: GameStateResponse | null;
  loading: boolean;
  error: string | null;
  className?: string;
  /** Live market prices, from `QueryMsg::GetMarketGrid`. Optional: without
   *  it the Market Value column reads "--" rather than the panel refusing
   *  to render. Market price is NOT on `GameStateResponse` -- see design
   *  note #10 -- so it has to arrive separately or not at all. */
  marketGrid?: MarketGridResponse | null;
}

export function ContextualSubPanel({
  gameState,
  loading,
  error,
  className,
  marketGrid,
}: ContextualSubPanelProps) {
  if (!gameState) {
    return (
      <div style={styles.root} className={className}>
        <div style={styles.header}>
          <span style={styles.headerTitle}>Round Detail</span>
        </div>
        <p style={styles.placeholderText}>
          {loading
            ? "Loading live game state..."
            : error
              ? `No live game state available (${error}).`
              : "No live game state available yet."}
        </p>
      </div>
    );
  }

  return (
    <div style={styles.root} className={className}>
      {gameState.current_round_type === "WaterfallAuction" ? (
        <WaterfallAuctionNotice />
      ) : gameState.current_round_type === "StockRound" ? (
        <StockRoundPlayerIndex gameState={gameState} marketGrid={marketGrid} />
      ) : (
        <OperatingRoundCorporationPanel gameState={gameState} marketGrid={marketGrid} />
      )}
      {error && <p style={styles.staleNote}>Showing last known state -- latest refresh failed: {error}</p>}
    </div>
  );
}

export default ContextualSubPanel;

/* ------------------------------------------------------------------ */
/* Pre-Game Waterfall Auction: deferred to the dedicated dashboard     */
/* ------------------------------------------------------------------ */

/** `current_round_type === "WaterfallAuction"` (see design note #1's update
 *  for `RoundType`'s new third variant): this pane deliberately does NOT
 *  duplicate the six-private bid/buy/mini-auction UI here -- that lives in
 *  `WaterfallAuctionDashboard.tsx`, rendered by `App.tsx` in place of the
 *  normal board canvas for this phase (see that component's own doc
 *  comment). This is just a short pointer so the pane isn't blank or, worse,
 *  silently misrendered as an Operating Round panel the way it would have
 *  before `RoundType` gained this variant. */
function WaterfallAuctionNotice() {
  return (
    <>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Pre-Game Waterfall Auction</span>
      </div>
      <p style={styles.placeholderText}>
        Allocating the six private companies before Stock Round 1 opens -- see the Waterfall Auction
        panel above for live bidding.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Stock Round: Player Index -- see design note #2                    */
/* ------------------------------------------------------------------ */

function StockRoundPlayerIndex({
  gameState,
  marketGrid,
}: {
  gameState: GameStateResponse;
  marketGrid?: MarketGridResponse | null;
}) {
  // Design note #7 in `utils/gameState.ts`: the exemption is a market
  // POSITION rule, so the count needs prices. Without them everything
  // counts, which is the correct conservative reading.
  const marketPrices: Record<number, number | null> = {};
  for (const entry of marketGrid?.positions ?? []) {
    const value = Number(entry.price);
    marketPrices[entry.company_id] = Number.isFinite(value) ? value : null;
  }
  return (
    <>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Stock Round -- Player Index</span>
        <span style={styles.headerHint}>
          SR{gameState.macro_round_number}
          {gameState.sub_round_index > 0 ? `.${gameState.sub_round_index}` : ""}
        </span>
      </div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Player</th>
            {/* Design note #12: both money and counts are right-aligned, and
                the CELLS below use the matching variant. The Certificates
                header was `thNum` while its cells were plain `td`, so the
                header sat hard right over left-aligned digits -- the column
                read as two columns that happened to touch. */}
            <th style={{ ...styles.th, ...styles.thNum }}>Cash</th>
            <th style={{ ...styles.th, ...styles.thNum }}>Certificates</th>
          </tr>
        </thead>
        <tbody>
          {gameState.player_addresses.length === 0 && (
            <tr>
              <td style={styles.td} colSpan={3}>
                No registered players yet.
              </td>
            </tr>
          )}
          {gameState.player_addresses.map((player, index) => {
            const isActive = index === gameState.active_player_index;
            const cashEntry = gameState.player_cash.find((entry) => entry.player === player);
            const certs = certificateBreakdown(
              player,
              gameState,
              marketGrid ? marketPrices : null,
              marketZoneForPrice,
            );
            return (
              <tr key={player} style={isActive ? styles.trActive : undefined}>
                <td style={styles.td}>
                  {truncate(player)}
                  {isActive && <span style={styles.activeBadge}>ACTIVE</span>}
                </td>
                {/* In-game cash is dollars, like every other figure in the
                    app -- the bare number here was the last place it was
                    not marked as currency. */}
                <td style={{ ...styles.td, ...styles.tdNum }}>${cashEntry ? cashEntry.cash_vgp : "0"}</td>
                <td
                  style={{ ...styles.td, ...styles.tdNum }}
                  title={
                    certs.exempt > 0
                      ? `${certs.exempt} certificate${certs.exempt === 1 ? "" : "s"} sit in a Yellow, Orange or Brown zone corporation and do not count toward the limit.`
                      : undefined
                  }
                >
                  {formatCertificateCount(certs)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Operating Round: Corporation panel -- see design note #3           */
/* ------------------------------------------------------------------ */

/* ==================================================================
 *  DESIGN NOTE 10: WHAT THIS TABLE CAN AND CANNOT SOURCE
 * ==================================================================
 *
 * Five of the seven columns are straight `GameStateResponse` fields. The
 * other two are worth naming because they behave differently:
 *
 *   - MARKET VALUE is not on `GameStateResponse` at all. It lives in
 *     `QueryMsg::GetMarketGrid`, which is why `marketGrid` is a separate
 *     prop; without it the column reads "--" rather than the panel
 *     substituting par value, which is a different number and would be
 *     silently wrong for every floated company.
 *
 *   - THE PRICE-CHANGE ARROW is observed, not reported. Nothing tells us
 *     "a dividend just resolved" -- so this compares the price against the
 *     last one seen and shows the direction it moved. Inside an Operating
 *     Round that inference is sound: the only thing that moves a price
 *     during an OR is the dividend decision (pay out steps right, withhold
 *     steps left). Share sales also move prices, but those happen in Stock
 *     Rounds, so the ref is cleared whenever the round changes -- an arrow
 *     never carries over from one round into the next.
 *
 *   - ROUTES / LAST RUN CANNOT BE SOURCED AT ALL. `pathfinding::
 *     trace_best_route` really does compute each corporation's revenue
 *     during an Operating Round, but no query returns it and there is no
 *     field to reconstruct it from. The column renders "--" for every row
 *     with a plain-language tooltip. It is included rather than omitted
 *     because the layout was specified with it, and a visibly empty column
 *     is a more honest placeholder than a quietly missing one -- but the
 *     dash here means "not reported", not "did not run", and no amount of
 *     frontend work changes that until a query exists.
 */
function OperatingRoundCorporationPanel({
  gameState,
  marketGrid,
}: {
  gameState: GameStateResponse;
  marketGrid?: MarketGridResponse | null;
}) {
  const activeCompanyId = gameState.active_operating_order[gameState.active_corporation_index];
  // Design note #9: the train LIMIT is a property of the phase, not of the
  // corporation -- 4 through Phases 2-3, 3 in Phase 4, 2 from Phase 5 on --
  // so it is derived once for the table rather than per row.
  const phase = derivePhase(gameState);
  // Design note #4 in `TrainBadges.tsx`: lets every chip count, not just
  // the tier currently in the danger window.
  const outlook = rustOutlook(gameState);

  const priceByCompany = React.useMemo(() => {
    const map = new Map<number, number>();
    for (const entry of marketGrid?.positions ?? []) {
      const value = Number(entry.price);
      if (Number.isFinite(value)) map.set(entry.company_id, value);
    }
    return map;
  }, [marketGrid]);

  // Design note #10: the observed-price ref behind the change arrows.
  // Keyed by round so a Stock Round's sales cannot leave an arrow showing
  // in the Operating Round that follows.
  const roundKey = `${gameState.current_round_type}:${gameState.macro_round_number}.${gameState.sub_round_index}`;
  const previousRef = React.useRef<{ key: string; prices: Map<number, number> }>({
    key: roundKey,
    prices: new Map(),
  });
  const deltas = React.useMemo(() => {
    const previous = previousRef.current;
    const result = new Map<number, number>();
    if (previous.key === roundKey) {
      priceByCompany.forEach((price, id) => {
        const before = previous.prices.get(id);
        if (before !== undefined && before !== price) result.set(id, price - before);
      });
      // Merge rather than replace: a company whose price did not change this
      // poll must keep its ORIGINAL baseline, or a two-step move would show
      // only the second step.
      priceByCompany.forEach((price, id) => {
        if (!previous.prices.has(id)) previous.prices.set(id, price);
      });
    } else {
      previousRef.current = { key: roundKey, prices: new Map(priceByCompany) };
    }
    return result;
  }, [priceByCompany, roundKey]);

  return (
    <>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Operating Round -- Corporations</span>
        <span style={styles.headerHint}>
          OR{gameState.macro_round_number}.{gameState.sub_round_index} of{" "}
          {gameState.operating_round_sequence_length}
        </span>
      </div>
      <div style={styles.tableScroll}>
      <table style={styles.table}>
        <thead>
          <tr>
            {/* Design note #11: Corporation leads. The previous order put
                President first, on the reasoning that an Operating Round is
                about whose turn it is -- but the row IS a corporation, and a
                table whose first column is not its subject reads as sorted
                by the wrong thing. The active row is marked directly, which
                answers "whose turn" without spending the lead column on it. */}
            <th style={styles.thB}>Corporation</th>
            <th style={styles.thB}>President</th>
            <th style={styles.thNumB}>Market Value</th>
            <th style={styles.thNumB}>Treasury</th>
            <th style={styles.thNumB}>Last Route Payout</th>
            <th style={styles.thCenterB}>Trains</th>
            <th style={styles.thCenter}>Train Limit</th>
          </tr>
        </thead>
        <tbody>
          {gameState.public_companies.length === 0 && (
            <tr>
              <td style={styles.td} colSpan={7}>
                No companies registered yet.
              </td>
            </tr>
          )}
          {gameState.public_companies.map((company) => {
            const isActive = company.company_id === activeCompanyId;
            const price = priceByCompany.get(company.company_id);
            const delta = deltas.get(company.company_id);
            const trains = company.owned_trains;
            return (
              <tr key={company.company_id} style={isActive ? styles.trActive : undefined}>
                {/* ---- Corporation: token dot, ticker, full name ---- */}
                <td style={styles.tdB}>
                  <span style={styles.corpCell}>
                    <span
                      style={{
                        ...styles.tokenDot,
                        backgroundColor: stationTickerColor(company.company_id),
                      }}
                      aria-hidden="true"
                    />
                    <span style={styles.corpTicker}>{company.ticker}</span>
                    {corporationFullName(company.ticker) && (
                      <span style={styles.corpFullName}>
                        {corporationFullName(company.ticker)}
                      </span>
                    )}
                    {isActive && <span style={styles.activeBadge}>ACTIVE</span>}
                    {/* Design note #8: a badge only on the EXCEPTION. A
                        Floated Yes/No column spent a whole column restating
                        "operational" seven times to flag the one company
                        that is not. */}
                    {!company.is_floated && <span style={styles.unfloatedBadge}>UNFLOATED</span>}
                  </span>
                </td>

                {/* ---- President ---- */}
                <td style={styles.tdB}>
                  {company.president ? (
                    <span style={styles.presidentCell}>
                      <span aria-hidden="true">&#128081;</span>
                      <span>{truncate(company.president)}</span>
                    </span>
                  ) : (
                    <span style={styles.emptyCell}>--</span>
                  )}
                </td>

                {/* ---- Market Value, with an observed change arrow ---- */}
                <td style={styles.tdNumB}>
                  {price === undefined ? (
                    <span style={styles.emptyCell}>--</span>
                  ) : delta === undefined ? (
                    `$${price}`
                  ) : (
                    <span
                      style={delta > 0 ? styles.priceUp : styles.priceDown}
                      title={
                        delta > 0
                          ? `Paid dividends -- price rose from $${price - delta}.`
                          : `Withheld revenue -- price fell from $${price - delta}.`
                      }
                    >
                      {delta > 0 ? "\u2191" : "\u2193"} ${price}
                    </span>
                  )}
                </td>

                {/* ---- Treasury ---- */}
                <td style={styles.tdNumB}>${company.treasury}</td>

                {/* ---- Last route payout -- design note #10 ---- */}
                <td style={styles.tdNumB}>
                  <LastRoutePayout surface="dark" />
                </td>

                {/* ---- Trains, as chips ---- */}
                <td style={styles.tdCenterB}>
                  <TrainChips trains={trains} phase={phase} surface="dark" outlook={outlook} />
                </td>

                {/* ---- Capacity pill ---- */}
                <td style={styles.tdCenter}>
                  <CapacityPill trains={trains} phase={phase} surface="dark" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function truncate(address: string, lead = 8, trail = 5): string {
  if (address.length <= lead + trail + 3) return address;
  return `${address.slice(0, lead)}...${address.slice(-trail)}`;
}

/* ------------------------------------------------------------------ */
/* Inline styles                                                      */
/* ------------------------------------------------------------------ */

// Design note #5 (final visual theme pass, App.tsx item 5's "Round Detail
// Footer" bullet): this is the structural footer pane underneath the
// board -- text scale boosted throughout (roughly 25-40%) so the active
// phase status ("Stock Round -- Player Index" / "Operating Round --
// Corporations", the SR/OR round badge, the active-player/corporation
// highlight) is clear at a glance rather than reading as fine print.
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "18px 20px",
    backgroundColor: "#161922",
    border: "1px solid #2a2e3a",
    borderRadius: "10px",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "12px",
  },
  headerTitle: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#c8cbd6",
  },
  headerHint: {
    fontSize: FONT_SIZE.strong,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#8a90a0",
  },
  placeholderText: {
    fontSize: FONT_SIZE.strong,
    color: "#6f7480",
    margin: 0,
  },
  staleNote: {
    fontSize: FONT_SIZE.body,
    color: "#8a6d1f",
    margin: 0,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: FONT_SIZE.strong,
  },
  tableScroll: { overflowX: "auto", width: "100%" },
  /* ---- Design note #11: one header treatment for every column.
     Uppercase, 700 weight, wide tracking -- previously `th` was 600 and
     mixed-case while the numeric variants only overrode alignment, so a
     seven-column row had headers of two different weights depending on
     which cell you looked at. All four `th*` variants now differ ONLY in
     alignment and the divider, which is the whole point of having
     variants. ---- */
  th: {
    textAlign: "left",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  td: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  trActive: {
    backgroundColor: "#1f2a1f",
  },
  /** Design note #8: right-aligned numeric cells/headers.
   *
   *  ALIGNMENT-ONLY OVERRIDES -- they carry no padding, border or font, so
   *  they must be spread OVER `th`/`td` rather than used in place of them.
   *  Used bare, a cell silently loses its box and the row's borders break
   *  where that column sits. The `*B` variants further down are complete
   *  styles precisely because that trap kept catching this table. */
  thNum: { textAlign: "right" },
  tdNum: { textAlign: "right", fontVariantNumeric: "tabular-nums" },

  /* ---- Design note #11: vertical dividers.
     `borderRight` rather than `borderLeft` so the LAST column can use the
     undivided variant and not draw an edge against the panel wall. Seven
     columns is past the point where a row can be tracked by alignment
     alone. ---- */
  thB: {
    textAlign: "left",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    borderRight: "1px solid #262b36",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  thNumB: {
    textAlign: "right",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    borderRight: "1px solid #262b36",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  thCenter: {
    textAlign: "center",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  thCenterB: {
    textAlign: "center",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    borderRight: "1px solid #262b36",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  tdB: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    borderRight: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  tdNumB: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    borderRight: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  tdCenter: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    textAlign: "center",
  },
  tdCenterB: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    borderRight: "1px solid #1e2129",
    textAlign: "center",
  },

  /* ---- Cell contents ---- */
  corpCell: { display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
  // The map token, shrunk to a dot. Same colour table the canvas draws with
  // (`stationTickerColor`), so a corporation reads the same here as on the
  // board rather than being a second, unrelated colour scheme.
  tokenDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,0.35)",
  },
  presidentCell: { display: "inline-flex", alignItems: "center", gap: "6px" },
  emptyCell: { color: "#5a5f6b" },
  priceUp: { color: "#5fd38f", fontWeight: 700 },
  priceDown: { color: "#e08585", fontWeight: 700 },

  /* ---- Train chips ---- */
  // One train left in the depot of the current tier: the rust is two
  // purchases away.
  // Depot empty: the very next purchase rusts these.

  /* ---- Capacity pill ---- */
  // A corporation at its limit cannot buy another train this phase -- worth
  // marking, because the Buy Train button will simply refuse otherwise.
  corpTicker: { fontWeight: 700 },
  corpFullName: {
    marginLeft: "7px",
    fontSize: FONT_SIZE.micro,
    color: "#8a90a0",
    whiteSpace: "nowrap",
  },
  activeBadge: {
    marginLeft: "10px",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    padding: "2px 9px",
    borderRadius: "999px",
    backgroundColor: "#1f7a3f",
    color: "#eafff0",
  },
  footnote: {
    fontSize: FONT_SIZE.body,
    color: "#6f7480",
    margin: 0,
    lineHeight: 1.4,
  },
};
