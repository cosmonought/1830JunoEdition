// frontend/src/components/FinancialLedger.tsx
//
// The "Financial Ledger" top-level tab (see App.tsx's restructure, item 6
// of this pass): global player certificate trees, remaining Bank cash, and
// a Hardware Shop inventory section.
//
// Design notes:
// 1. **Bank cash is real, queryable data.** `GameStateResponse.virtual_bank_
//    vgp`/`virtual_bank_start` (VGP, the in-game virtual currency) and
//    `total_juno_pool` (real JUNO ante pool, a separate figure) are both
//    genuine fields on `src/msg.rs`'s `GameStateResponse` -- see
//    `utils/gameState.ts` design note #1. This section renders them
//    directly, no estimation needed.
// 2. **Certificate trees are the SAME estimate `ContextualSubPanel.tsx`
//    uses**, just laid out per-player as a tree (private companies owned,
//    then each public company holding) rather than a single summary number
//    -- see `utils/gameState.ts`'s `estimateCertificateCount`/
//    `playerCompanyHoldings`/`playerPrivateCompanies` design note #3 for
//    exactly what "estimate" means here and why a precise count isn't
//    possible against the current contract.
// 3. **Hardware Shop inventory: an honest DESIGN GAP, not a fabricated
//    shop.** Same underlying gap as `ContextualSubPanel.tsx`'s "Routes &
//    Train Sheets" section (see that file's design note #3 and
//    `utils/gameState.ts` design note #2): `src/state.rs` has a real
//    `HARDWARE_POOL`/`COMPANY_HARDWARE` map and `src/hardware.rs` has a
//    real `TRAIN_CATALOG`, but zero `QueryMsg` variant reads either back.
//    This section names exactly what backend state exists and exactly
//    what's missing to query it, rather than inventing plausible-looking
//    train inventory counts.
// 4. **Player Net Worth is a SEPARATE live query, not a client-side
//    estimate.** Unlike the certificate trees above (design note #2, an
//    honest client-side approximation), net worth is the real,
//    authoritative `QueryMsg::PlayerNetWorth` figure -- cash plus every
//    held share certificate priced at its LIVE `MARKET_GRID` value, summed
//    entirely on-chain (`query::query_player_net_worth`). This panel can't
//    compute it itself from `gameState` alone: `GameStateResponse` carries
//    each company's `par_value` but not its live market price (that's a
//    separate `GetMarketGrid` query), so reproducing the real figure
//    client-side would mean either a second query plus duplicating the
//    backend's own valuation math, or silently substituting par value for
//    market price -- both worse than just calling the dedicated endpoint.
//    `queryClient`/`contractAddress`/`gameId` are optional (mirroring
//    `HexGridRenderer.tsx`'s own click-interceptor props, design note #7
//    there): omit any of them to keep this panel query-free, in which case
//    the new Net Worth row simply reads "not connected" instead of
//    blocking the rest of the ledger.
// 5. **"Game Ledger" rename -- display text only, not the source module.**
//    Direct request to rename this tab from "Financial Ledger" to "Game
//    Ledger". Changed here (`styles.pageTitle`'s rendered string) and in
//    `App.tsx`'s `MainTabBar` tab label -- the two places a player actually
//    sees the name. The component/export/file name (`FinancialLedger`,
//    this file) is deliberately left alone: a UI copy request scoped to
//    "tab renaming, ledger tables" is read as changing what a player reads,
//    not as a mandate to rename a source module and touch every file that
//    imports it, which would be a much larger and riskier diff for a
//    request that never asked for it. If the source identifiers should
//    also be renamed later, that is a distinct, deliberate housekeeping
//    pass.
// 6. **Four comprehensive tables (Game Ledger overhaul).** Replaces the
//    prior card/tree-only layout with real `<table>` elements -- direct
//    request, and tables are also just the right shape for this data
//    (aligned columns of numbers), each wrapped in a horizontally-scrolling
//    container (`styles.tableScroll`) so a dense table degrades to a
//    scrollbar rather than an unreadable reflow on a narrow pane:
//    (1) **Bank Treasury** (`BankTreasurySection`) -- starting/baseline
//    cash (`virtual_bank_start`, which reads $12,000 on a freshly created
//    room -- 1830's real fixed bank size, also documented in the Rules
//    Reference tab's Core Limits table), remaining cash
//    (`virtual_bank_vgp`), percent paid out, and the separate real-JUNO
//    ante pool -- all fields already on `GameStateResponse`, unchanged from
//    the prior `BankCashSection` cards, just reshaped into a table.
//    (2) **Player Assets** (`PlayerAssetsSection`) -- NEW summary table:
//    Liquid Cash, Stock Portfolio Value, Total Net Worth per player. Liquid
//    cash is read straight from `gameState.player_cash` -- a real field on
//    every `GetGameState` response, needing no extra query -- while stock
//    portfolio value/net worth still come from the live `PlayerNetWorth`
//    query (design note #4, unchanged) since that valuation genuinely can't
//    be reconstructed client-side. The existing per-player certificate
//    trees (design note #2) are kept as their own section directly below
//    this table -- this new table is the aggregate dollar summary, the
//    trees are the "which specific certificates" drill-down; the two are
//    complementary, not a replacement of one by the other.
//    (3) **Corporation Assets** (`CorporationAssetsSection`) -- treasury
//    cash per corporation is real (`PublicCompanyState.treasury`). Active
//    train inventory is NOT: this is the exact same honest DESIGN GAP
//    described in design note #3 (`state.rs`'s `HARDWARE_POOL`/
//    `COMPANY_HARDWARE` and `hardware.rs`'s `TRAIN_CATALOG` are real, but no
//    `QueryMsg` variant reads either back) -- that gap now surfaces as an
//    explicit "Not yet exposed by contract" table cell per corporation plus
//    ONE shared footnote explaining why, replacing the old standalone
//    `HardwareShopSection` box (removed -- its one piece of real content,
//    the design-gap explanation, is preserved as this table's footnote
//    instead of a whole separate section for it).
//    (4) **Corporate Stock Distribution** (`StockDistributionSection`) --
//    Player Hands / IPO Warehouse / Bank Pool percentage breakdown per
//    corporation. All three figures are real, already-queried per-company
//    fields -- `player_holdings[].percentage` (summed across all players),
//    `ipo_pool_percentage`, `bank_pool_percentage` -- no estimation
//    involved, unlike the client-side certificate-count estimate elsewhere
//    in this file. A Total column sums the three per row as a visible
//    reconciliation check (should always read 100%); this project's own
//    "never silently hide a mismatch" discipline (see design note #4's
//    "never silently hide a failure" citation) applies here too -- if the
//    three ever failed to sum to 100 that would indicate a real contract
//    bug, and this table would show it rather than hide it behind a single
//    pre-summed number.

import React from "react";

import type { GameStateResponse, PlayerNetWorthResponse, QueryCapableClient } from "../utils/gameState";
import {
  estimateCertificateCount,
  playerCompanyHoldings,
  playerPrivateCompanies,
  usePlayerNetWorths,
} from "../utils/gameState";

export interface FinancialLedgerProps {
  gameState: GameStateResponse | null;
  loading: boolean;
  error: string | null;
  className?: string;
  /** Enables the live `PlayerNetWorth` query (design note #4). Provide all
   *  three to show each player's real on-chain net worth; omit any of them
   *  to keep this panel query-free, same convention as
   *  `HexGridRenderer.tsx`'s own optional click-interceptor props. */
  queryClient?: QueryCapableClient;
  contractAddress?: string;
  gameId?: number;
}

export function FinancialLedger({
  gameState,
  loading,
  error,
  className,
  queryClient,
  contractAddress,
  gameId,
}: FinancialLedgerProps) {
  // Called unconditionally (React hook rules) even before `gameState`
  // resolves -- `usePlayerNetWorths` itself no-ops cleanly on an empty
  // address list. `gameState?.player_addresses ?? []` is a fresh array
  // every render, but the hook only actually depends on its JOINED
  // CONTENT (`playersKey`, see `utils/gameState.ts` design note #6), so
  // this is safe.
  const {
    netWorths,
    loading: netWorthsLoading,
    error: netWorthsError,
  } = usePlayerNetWorths(queryClient, contractAddress ?? "", gameId ?? 0, gameState?.player_addresses ?? []);
  const netWorthsEnabled = Boolean(queryClient && contractAddress !== undefined && gameId !== undefined);

  return (
    <div style={styles.root} className={className}>
      <h2 style={styles.pageTitle}>Game Ledger</h2>

      {!gameState ? (
        <p style={styles.placeholderText}>
          {loading
            ? "Loading live game state..."
            : error
              ? `No live game state available (${error}).`
              : "No live game state available yet."}
        </p>
      ) : (
        <>
          <BankTreasurySection gameState={gameState} />
          <PlayerAssetsSection
            gameState={gameState}
            netWorths={netWorths}
            netWorthsEnabled={netWorthsEnabled}
            netWorthsLoading={netWorthsLoading}
          />
          <CertificateTreesSection
            gameState={gameState}
            netWorths={netWorths}
            netWorthsEnabled={netWorthsEnabled}
            netWorthsLoading={netWorthsLoading}
            netWorthsError={netWorthsError}
          />
          <CorporationAssetsSection gameState={gameState} />
          <StockDistributionSection gameState={gameState} />
          {error && (
            <p style={styles.staleNote}>Showing last known state -- latest refresh failed: {error}</p>
          )}
        </>
      )}
    </div>
  );
}

export default FinancialLedger;

/* ------------------------------------------------------------------ */
/* Bank Treasury -- see design note #1/#6(1)                          */
/* ------------------------------------------------------------------ */

function BankTreasurySection({ gameState }: { gameState: GameStateResponse }) {
  const start = Number(gameState.virtual_bank_start);
  const current = Number(gameState.virtual_bank_vgp);
  const spentPercent =
    Number.isFinite(start) && start > 0 ? Math.round(((start - current) / start) * 100) : null;

  return (
    <section style={styles.section}>
      <h3 style={styles.sectionTitle}>Bank Treasury</h3>
      <div style={styles.tableScroll}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Metric</th>
              <th style={styles.th}>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={styles.td}>Starting Bank Cash (1830 baseline: $12,000)</td>
              <td style={styles.tdNum}>{gameState.virtual_bank_start} VGP</td>
            </tr>
            <tr>
              <td style={styles.td}>Remaining Bank Cash</td>
              <td style={styles.tdNum}>{gameState.virtual_bank_vgp} VGP</td>
            </tr>
            <tr>
              <td style={styles.td}>Paid Out So Far</td>
              <td style={styles.tdNum}>{spentPercent !== null ? `${spentPercent}%` : "--"}</td>
            </tr>
            <tr>
              <td style={styles.td}>Real JUNO Ante Pool (separate from VGP)</td>
              <td style={styles.tdNum}>{gameState.total_juno_pool}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Player Assets -- see design note #6(2)                             */
/* ------------------------------------------------------------------ */

interface PlayerAssetsSectionProps {
  gameState: GameStateResponse;
  netWorths: Record<string, PlayerNetWorthResponse>;
  netWorthsEnabled: boolean;
  netWorthsLoading: boolean;
}

function PlayerAssetsSection({
  gameState,
  netWorths,
  netWorthsEnabled,
  netWorthsLoading,
}: PlayerAssetsSectionProps) {
  return (
    <section style={styles.section}>
      <h3 style={styles.sectionTitle}>Player Assets</h3>
      {gameState.player_addresses.length === 0 ? (
        <p style={styles.placeholderText}>No registered players yet.</p>
      ) : (
        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Player</th>
                <th style={styles.th}>Liquid Cash</th>
                <th style={styles.th}>Stock Portfolio Value</th>
                <th style={styles.th}>Total Net Worth</th>
              </tr>
            </thead>
            <tbody>
              {gameState.player_addresses.map((player) => {
                // Liquid cash is real, queryable straight off `GetGameState`
                // -- no live `PlayerNetWorth` query needed just for this
                // column (design note #6(2)).
                const cashEntry = gameState.player_cash.find((entry) => entry.player === player);
                const netWorth = netWorths[player];
                return (
                  <tr key={player}>
                    <td style={styles.td}>{truncate(player)}</td>
                    <td style={styles.tdNum}>{cashEntry ? `${cashEntry.cash_vgp} VGP` : "--"}</td>
                    <td style={styles.tdNum}>
                      {netWorth
                        ? `${netWorth.stock_portfolio_value} VGP`
                        : !netWorthsEnabled
                          ? "not connected"
                          : netWorthsLoading
                            ? "loading..."
                            : "--"}
                    </td>
                    <td style={styles.tdNum}>
                      {netWorth
                        ? `${netWorth.net_worth} VGP`
                        : !netWorthsEnabled
                          ? "not connected"
                          : netWorthsLoading
                            ? "loading..."
                            : "--"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Certificate trees -- see design note #2                            */
/* ------------------------------------------------------------------ */

interface CertificateTreesSectionProps {
  gameState: GameStateResponse;
  netWorths: Record<string, PlayerNetWorthResponse>;
  netWorthsEnabled: boolean;
  netWorthsLoading: boolean;
  netWorthsError: string | null;
}

function CertificateTreesSection({
  gameState,
  netWorths,
  netWorthsEnabled,
  netWorthsLoading,
  netWorthsError,
}: CertificateTreesSectionProps) {
  return (
    <section style={styles.section}>
      <h3 style={styles.sectionTitle}>Player Certificate Trees</h3>
      {gameState.player_addresses.length === 0 && (
        <p style={styles.placeholderText}>No registered players yet.</p>
      )}
      <div style={styles.treeGrid}>
        {gameState.player_addresses.map((player) => {
          const privates = playerPrivateCompanies(player, gameState);
          const publics = playerCompanyHoldings(player, gameState);
          const estCerts = estimateCertificateCount(player, gameState);
          const netWorth = netWorths[player];
          return (
            <div key={player} style={styles.treeCard}>
              <div style={styles.treeCardHeader}>
                <span style={styles.treeCardPlayer}>{truncate(player)}</span>
                <span style={styles.treeCardCertCount}>~{estCerts} certs</span>
              </div>
              {/* Total Net Worth row (design note #4): the real, on-chain
                  `QueryMsg::PlayerNetWorth` figure -- cash plus every held
                  share certificate at its LIVE market price -- distinct
                  from the client-side certificate-count estimate above. */}
              <div style={styles.netWorthRow}>
                {!netWorthsEnabled ? (
                  <span style={styles.netWorthPending}>Net worth: live query not connected</span>
                ) : netWorth ? (
                  <>
                    <span style={styles.netWorthLabel}>Total Net Worth</span>
                    <span style={styles.netWorthValue}>{netWorth.net_worth} VGP</span>
                    <span style={styles.netWorthBreakdown}>
                      Cash {netWorth.cash_vgp} + Stock {netWorth.stock_portfolio_value}
                    </span>
                  </>
                ) : (
                  <span style={styles.netWorthPending}>
                    {netWorthsLoading ? "Net worth: loading..." : "Net worth: unavailable"}
                  </span>
                )}
              </div>
              {privates.length === 0 && publics.length === 0 ? (
                <p style={styles.treeEmpty}>No certificates held.</p>
              ) : (
                <ul style={styles.treeList}>
                  {privates.map((priv) => (
                    <li key={`priv-${priv.private_id}`} style={styles.treeLeaf}>
                      <span style={styles.treeLeafKind}>Private</span> {priv.name}
                    </li>
                  ))}
                  {publics.map(({ company, percentage }) => (
                    <li key={`pub-${company.company_id}`} style={styles.treeLeaf}>
                      <span style={styles.treeLeafKind}>Public</span> {company.ticker} -- {percentage}%
                      {company.president === player && (
                        <span style={styles.presidentTag}>PRESIDENT</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <p style={styles.footnote}>
        Certificate counts are an on-the-fly estimate, not a value the contract returns directly --
        see `utils/gameState.ts` design note #3. Total Net Worth, above, is the opposite: a real
        on-chain `PlayerNetWorth` query result, not an estimate.
      </p>
      {netWorthsEnabled && netWorthsError && (
        <p style={styles.staleNote}>
          Showing last known net worth figures -- latest refresh failed: {netWorthsError}
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Corporation Assets -- see design note #3/#6(3)                     */
/* ------------------------------------------------------------------ */

function CorporationAssetsSection({ gameState }: { gameState: GameStateResponse }) {
  return (
    <section style={styles.section}>
      <h3 style={styles.sectionTitle}>Corporation Assets</h3>
      {gameState.public_companies.length === 0 ? (
        <p style={styles.placeholderText}>No corporations yet.</p>
      ) : (
        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Corporation</th>
                <th style={styles.th}>Floated</th>
                <th style={styles.th}>Treasury Cash</th>
                <th style={styles.th}>Active Train Inventory</th>
              </tr>
            </thead>
            <tbody>
              {gameState.public_companies.map((company) => (
                <tr key={company.company_id}>
                  <td style={styles.td}>{company.ticker}</td>
                  <td style={styles.td}>{company.is_floated ? "Yes" : "No"}</td>
                  <td style={styles.tdNum}>{company.treasury} VGP</td>
                  <td style={styles.tdMuted}>Not yet exposed by contract</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={styles.footnote}>
        Treasury cash is real, live contract state. Active train inventory is a genuine DESIGN GAP,
        not a fabricated number -- see design note #3/#6(3) in this file: the contract's
        HARDWARE_POOL/COMPANY_HARDWARE/TRAIN_CATALOG state exists, but no query currently reads it
        back. This column will populate once such a query is added.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Corporate Stock Distribution -- see design note #6(4)              */
/* ------------------------------------------------------------------ */

function StockDistributionSection({ gameState }: { gameState: GameStateResponse }) {
  return (
    <section style={styles.section}>
      <h3 style={styles.sectionTitle}>Corporate Stock Distribution</h3>
      {gameState.public_companies.length === 0 ? (
        <p style={styles.placeholderText}>No corporations yet.</p>
      ) : (
        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Corporation</th>
                <th style={styles.th}>Player Hands</th>
                <th style={styles.th}>IPO Warehouse</th>
                <th style={styles.th}>Bank Pool</th>
                <th style={styles.th}>Total</th>
              </tr>
            </thead>
            <tbody>
              {gameState.public_companies.map((company) => {
                const playerHandsPercentage = company.player_holdings.reduce(
                  (sum, holding) => sum + holding.percentage,
                  0,
                );
                const total =
                  playerHandsPercentage + company.ipo_pool_percentage + company.bank_pool_percentage;
                return (
                  <tr key={company.company_id}>
                    <td style={styles.td}>{company.ticker}</td>
                    <td style={styles.tdNum}>{playerHandsPercentage}%</td>
                    <td style={styles.tdNum}>{company.ipo_pool_percentage}%</td>
                    <td style={styles.tdNum}>{company.bank_pool_percentage}%</td>
                    <td style={styles.tdNum}>{total}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p style={styles.footnote}>
        Player Hands is the sum of every player's held percentage in that corporation. All three
        columns are real per-company contract fields (`player_holdings`, `ipo_pool_percentage`,
        `bank_pool_percentage`) -- not an estimate. Total should always read 100%; it's shown
        explicitly as a reconciliation check rather than hidden behind a single pre-summed figure.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

function truncate(address: string, lead = 10, trail = 6): string {
  if (address.length <= lead + trail + 3) return address;
  return `${address.slice(0, lead)}...${address.slice(-trail)}`;
}

/* ------------------------------------------------------------------ */
/* Inline styles                                                      */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "20px",
    padding: "24px",
    color: "#e6e8ef",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    overflowY: "auto",
    flex: 1,
  },
  pageTitle: {
    fontSize: "20px",
    margin: 0,
  },
  placeholderText: {
    fontSize: "13px",
    color: "#6f7480",
  },
  staleNote: {
    fontSize: "11px",
    color: "#8a6d1f",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  sectionTitle: {
    fontSize: "14px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#9aa0ac",
    margin: 0,
  },
  treeGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: "12px",
  },
  treeCard: {
    padding: "10px 12px",
    borderRadius: "8px",
    backgroundColor: "#161922",
    border: "1px solid #2a2e3a",
  },
  treeCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "6px",
  },
  treeCardPlayer: {
    fontSize: "12px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontWeight: 700,
  },
  treeCardCertCount: {
    fontSize: "11px",
    color: "#9aa0ac",
  },
  netWorthRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: "6px",
    padding: "6px 8px",
    marginBottom: "8px",
    borderRadius: "6px",
    backgroundColor: "#1c2130",
    border: "1px solid #33394a",
  },
  netWorthLabel: {
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "#9aa0ac",
  },
  netWorthValue: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#7fd88f",
  },
  netWorthBreakdown: {
    fontSize: "10px",
    color: "#6f7480",
  },
  netWorthPending: {
    fontSize: "11px",
    color: "#6f7480",
    fontStyle: "italic",
  },
  treeEmpty: {
    fontSize: "11px",
    color: "#6f7480",
    margin: 0,
  },
  treeList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: "3px",
  },
  treeLeaf: {
    fontSize: "12px",
    color: "#c7cbd4",
  },
  treeLeafKind: {
    fontSize: "10px",
    fontWeight: 700,
    color: "#6f7480",
    marginRight: "4px",
  },
  presidentTag: {
    marginLeft: "6px",
    fontSize: "9px",
    fontWeight: 700,
    padding: "1px 5px",
    borderRadius: "999px",
    backgroundColor: "#8a6d1f",
    color: "#fff8e0",
  },
  footnote: {
    fontSize: "10px",
    color: "#6f7480",
    margin: 0,
    lineHeight: 1.4,
  },
  // ---- Comprehensive tables -- design note #6. `tableScroll` wraps every
  // table so a narrow pane degrades to a horizontal scrollbar rather than
  // reflowing/crushing the columns -- the "responsive" half of this item's
  // ask, applied uniformly to all four new tables. ----
  tableScroll: {
    overflowX: "auto",
    width: "100%",
  },
  table: {
    borderCollapse: "collapse",
    fontSize: "13px",
    minWidth: "480px",
    width: "100%",
  },
  th: {
    textAlign: "left",
    padding: "8px 14px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  td: {
    padding: "8px 14px",
    borderBottom: "1px solid #1e2129",
  },
  tdNum: {
    padding: "8px 14px",
    borderBottom: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "right",
  },
  tdMuted: {
    padding: "8px 14px",
    borderBottom: "1px solid #1e2129",
    color: "#6f7480",
    fontStyle: "italic",
    fontSize: "12px",
  },
};
