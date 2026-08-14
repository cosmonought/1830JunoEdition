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
//    live VGP cash treasury (`player_cash`), and an ESTIMATED certificate
//    count (`estimateCertificateCount` -- see that function's own doc
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
import { estimateCertificateCount } from "../utils/gameState";
import { FONT_SIZE } from "../styles/typography";

export interface ContextualSubPanelProps {
  gameState: GameStateResponse | null;
  loading: boolean;
  error: string | null;
  className?: string;
}

export function ContextualSubPanel({ gameState, loading, error, className }: ContextualSubPanelProps) {
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
        <StockRoundPlayerIndex gameState={gameState} />
      ) : (
        <OperatingRoundCorporationPanel gameState={gameState} />
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

function StockRoundPlayerIndex({ gameState }: { gameState: GameStateResponse }) {
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
            <th style={styles.th}>Cash (VGP)</th>
            <th style={styles.th}>Certificates (est.)</th>
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
            const certCount = estimateCertificateCount(player, gameState);
            return (
              <tr key={player} style={isActive ? styles.trActive : undefined}>
                <td style={styles.td}>
                  {truncate(player)}
                  {isActive && <span style={styles.activeBadge}>ACTIVE</span>}
                </td>
                <td style={styles.td}>{cashEntry ? cashEntry.cash_vgp : "0"}</td>
                <td style={styles.td}>~{certCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={styles.footnote}>
        Certificate counts are an on-the-fly estimate (one certificate per real 10% share block,
        plus one per owned private company) -- the contract does not expose a precomputed
        certificate count. See `utils/gameState.ts` design note #3.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Operating Round: Corporation panel -- see design note #3           */
/* ------------------------------------------------------------------ */

function OperatingRoundCorporationPanel({ gameState }: { gameState: GameStateResponse }) {
  const activeCompanyId = gameState.active_operating_order[gameState.active_corporation_index];

  return (
    <>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Operating Round -- Corporations</span>
        <span style={styles.headerHint}>
          OR{gameState.macro_round_number}.{gameState.sub_round_index} of{" "}
          {gameState.operating_round_sequence_length}
        </span>
      </div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Corp</th>
            <th style={styles.th}>Treasury</th>
            <th style={styles.th}>Floated</th>
            <th style={styles.th}>President</th>
          </tr>
        </thead>
        <tbody>
          {gameState.public_companies.length === 0 && (
            <tr>
              <td style={styles.td} colSpan={4}>
                No companies registered yet.
              </td>
            </tr>
          )}
          {gameState.public_companies.map((company) => {
            const isActive = company.company_id === activeCompanyId;
            return (
              <tr key={company.company_id} style={isActive ? styles.trActive : undefined}>
                <td style={styles.td}>
                  {company.ticker}
                  {isActive && <span style={styles.activeBadge}>ACTIVE</span>}
                </td>
                <td style={styles.td}>{company.treasury}</td>
                <td style={styles.td}>{company.is_floated ? "Yes" : "No"}</td>
                <td style={styles.td}>{company.president ? truncate(company.president) : "--"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={styles.designGapBox}>
        <span style={styles.designGapTitle}>Routes &amp; Train Sheets -- not yet exposed</span>
        <p style={styles.designGapText}>
          The contract genuinely models hardware/train ownership (`state::HARDWARE_POOL` /
          `COMPANY_HARDWARE`) and traces each corporation's best-value route during
          `ExecuteOperatingRound` (`pathfinding::trace_best_route`), but no `QueryMsg` currently
          returns either -- there is no live per-corporation route or train-sheet data this panel
          can honestly display yet. Rather than show a fabricated number, this section will
          populate once a dedicated query (e.g. a `GetCorporationHardware`/`GetActiveRoutes`
          variant) is added to `src/msg.rs`.
        </p>
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
  th: {
    textAlign: "left",
    padding: "8px 12px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    fontWeight: 600,
  },
  td: {
    padding: "9px 12px",
    borderBottom: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  trActive: {
    backgroundColor: "#1f2a1f",
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
  designGapBox: {
    marginTop: "6px",
    padding: "12px 14px",
    borderRadius: "8px",
    backgroundColor: "#1e1a12",
    border: "1px solid #4a3f1f",
  },
  designGapTitle: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    color: "#d4a94c",
  },
  designGapText: {
    fontSize: FONT_SIZE.control,
    color: "#b3a479",
    margin: "6px 0 0",
    lineHeight: 1.45,
  },
};
