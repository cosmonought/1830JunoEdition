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
//    -- see `utils/gameState.ts`'s `certificateCount`/
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
//    (4) **Corporate Stock Distribution -- MERGED AWAY (design note #14).**
//    Its three real per-company fields (`player_holdings[].percentage`
//    summed, `ipo_pool_percentage`, `bank_pool_percentage`) are now the last
//    three columns of Corporation Assets rather than a second table over the
//    same rows. Its Total column is deleted -- see design note #14 for why a
//    reconciliation check that reads 100% on every row of every game is not
//    actually checking anything.

import React from "react";

import type { GameStateResponse, PlayerNetWorthResponse, QueryCapableClient } from "../utils/gameState";
import { PRIORITY_DEAL_TOOLTIP } from "../utils/gameState";
import { FONT_SIZE } from "../styles/typography";
// Design note #170 (ContextualSubPanel): a name beats a truncated hash, and
// this returns `null` for a real wallet so live rooms are unchanged.
import { sandboxPlayerLabel } from "../utils/sandboxState";
import { CHIP_INERT_BG, CHIP_INERT_BORDER, CHIP_INERT_INK } from "../styles/palette";
import { corporationFullName, corporationTitle } from "../utils/corporationNames";
import { depotInventory, derivePhase, rustOutlook } from "../utils/gamePhase";
import { formatNativeAmountCompact, NATIVE_DENOM_DISPLAY } from "../config";
import { stationTickerColor } from "./hexContractTypes";
import { CapacityPill, LastRoutePayout, TrainChips } from "./TrainBadges";
import { marketZoneForPrice, type MarketGridResponse } from "./StockMarketRenderer";
import {
  certificateBreakdown,
  formatCertificateCount,
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
  /** Live market prices (`QueryMsg::GetMarketGrid`). Market price is not on
   *  `GameStateResponse`, so the Corporation Assets table's Market Price
   *  column needs it separately or renders a dash. */
  marketGrid?: MarketGridResponse | null;
}

export function FinancialLedger({
  gameState,
  loading,
  error,
  className,
  queryClient,
  contractAddress,
  gameId,
  marketGrid,
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
            marketGrid={marketGrid}
            netWorths={netWorths}
            netWorthsEnabled={netWorthsEnabled}
            netWorthsLoading={netWorthsLoading}
            netWorthsError={netWorthsError}
          />
          {/* Design note #14: exactly three tables -- Bank, Players,
              Corporations. */}
          <CorporationAssetsSection gameState={gameState} marketGrid={marketGrid} />
          {error && (
            <p style={styles.staleNote}>Showing last known state — latest refresh failed: {error}</p>
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
    <section style={{ ...styles.section, ...styles.sectionBank }}>
      <h3 style={{ ...styles.sectionTitle, ...styles.sectionTitleBank }}>Bank Treasury</h3>
      <div style={styles.tableScroll}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.thB}>Metric</th>
              <th style={styles.thNum}>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={styles.tdB}>Starting Bank Cash</td>
              <td style={styles.tdNum}>${gameState.virtual_bank_start}</td>
            </tr>
            <tr>
              <td style={styles.tdB}>Remaining Bank Cash</td>
              <td style={styles.tdNum}>${gameState.virtual_bank_vgp}</td>
            </tr>
            <tr>
              <td style={styles.tdB}>Paid Out So Far</td>
              <td style={styles.tdNum}>{spentPercent !== null ? `${spentPercent}%` : "--"}</td>
            </tr>
            <tr>
              {/* Design note #12: the pool arrives as `ujuno` -- micro-JUNO,
                  the Cosmos base unit -- so a 40 JUNO pool reads as
                  40000000 raw. Converted through `formatNativeAmountCompact`
                  rather than by dividing here: that helper does the six
                  decimal places with integer string math, because a
                  `Uint128` above 2^53 loses precision the moment it becomes
                  a double, and a pool of real money is the last place to be
                  quietly wrong. */}
              <td style={styles.tdB}>Real JUNO Ante Pool</td>
              <td style={styles.tdNum}>
                {formatNativeAmountCompact(gameState.total_juno_pool)} {NATIVE_DENOM_DISPLAY}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <DepotInventoryTable gameState={gameState} />
    </section>
  );
}

/* ==================================================================
 *  DESIGN NOTE 16: THE BANK DEPOT INVENTORY
 * ==================================================================
 *
 * Which trains are left, what they cost, and what buying one sets off, in
 * one place. Every one of those was previously discoverable only by
 * counting other corporations' holdings by hand, which is a lot of work to
 * answer "can I afford to wait a turn".
 *
 * It lives in the BANK section rather than with the corporations because
 * the depot belongs to the bank -- it is stock nobody owns yet. The
 * Corporation Assets table answers "who has what"; this answers "what is
 * still for sale".
 *
 * `depotInventory` (see `utils/gamePhase.ts` design note #4) supplies exact
 * per-tier counts via the queue rule, not by subtracting owned trains from
 * printed totals -- that shortcut is unsound for obsolete tiers and would
 * report rusted trains as though they were still on the shelf.
 *
 * TWO DIMMED STATES, NOT ONE. Sold out and rusted are different facts and
 * the table says so: a tier can be unbuyable while its trains still run
 * (every 3-train keeps earning through Phase 4 and 5), and only a genuinely
 * rusted tier gets the strikethrough, because only then is it gone.
 */
function DepotInventoryTable({ gameState }: { gameState: GameStateResponse }) {
  const phase = derivePhase(gameState);
  const outlook = rustOutlook(gameState);
  const tiers = depotInventory(gameState);

  return (
    <>
      <h4 style={styles.subTableTitle}>Bank Depot Train Inventory</h4>
      <div style={styles.tableScroll}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.thCenterB}>Tier</th>
              <th style={styles.thNumB}>Cost</th>
              <th style={styles.thNumB}>Depot Remaining</th>
              <th style={styles.thNumB}>Corporate Train Limit</th>
              <th style={styles.th}>Obsolescence / Event Trigger</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((row) => {
              const dimmed = row.rusted || row.soldOut;
              return (
                <tr
                  key={row.tier}
                  style={{
                    ...(row.isCurrent ? styles.depotRowCurrent : {}),
                    ...(dimmed ? styles.depotRowDimmed : {}),
                  }}
                >
                  <td style={styles.tdCenterB}>
                    {/* Design note #16: the same chip the corporation rows
                        use, so a tier looks identical wherever it appears.
                        `phase={null}` deliberately -- the rust TINT means
                        "a corporation's train is about to die", and this is
                        a price list, not a holding. The `rusted` column
                        below carries that story instead. */}
                    <TrainChips
                      trains={[row.tier]}
                      phase={null}
                      surface="dark"
                      compact
                      outlook={outlook}
                    />
                  </td>
                  <td style={styles.tdNumB}>${row.cost.toLocaleString("en-US")}</td>
                  <td style={styles.tdNumB}>
                    {row.total === null
                      ? "Unlimited"
                      : `${row.remaining ?? "?"} / ${row.total}`}
                  </td>
                  <td style={styles.tdNumB}>{row.trainLimit}</td>
                  <td style={styles.td}>
                    <span style={styles.depotTrigger}>{DEPOT_TRIGGER_NOTES[row.tier]}</span>
                    {row.rusted && <span style={styles.depotRustedBadge}>RUSTED</span>}
                    {!row.rusted && row.soldOut && (
                      <span style={styles.depotSoldOutBadge}>SOLD OUT</span>
                    )}
                    {row.isCurrent && <span style={styles.depotCurrentBadge}>CURRENT</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {phase != null && !phase.known && (
        <p style={styles.footnote}>
          Depot counts assume no trains have been bought — this room is not reporting train
          ownership.
        </p>
      )}
    </>
  );
}

/** What buying the first train of each tier sets off. Plain language: this
 *  is a player-facing table, so it names phases and consequences rather
 *  than the flags that implement them. */
const DEPOT_TRIGGER_NOTES: Readonly<Record<string, string>> = {
  "2": "Phase 2 (Rusts when 4-Train bought)",
  "3": "Phase 3 (Unlocks Green Tiles; Rusts when 6-Train bought)",
  "4": "Phase 4 (First buy rusts all 2-Trains; Rusts when D-Train bought)",
  "5": "Phase 5 (First buy unlocks Brown Tiles & closes all Private Companies; Permanent)",
  "6": "Phase 6 (First buy rusts all 3-Trains; Permanent)",
  D: "Diesel Era (First buy rusts all 4-Trains; Permanent)",
};

/* ------------------------------------------------------------------ */
/* Player Assets -- see design note #6(2)                             */
/* ------------------------------------------------------------------ */

interface PlayerAssetsSectionProps {
  gameState: GameStateResponse;
  netWorths: Record<string, PlayerNetWorthResponse>;
  netWorthsEnabled: boolean;
  netWorthsLoading: boolean;
  /** Design note #7: kept and surfaced rather than dropped when the trees
   *  section that used to display it was merged away. A failed net-worth
   *  query with no message on screen leaves two columns reading "--" for
   *  no visible reason. */
  netWorthsError: string | null;
  marketGrid?: MarketGridResponse | null;
}

function PlayerAssetsSection({
  gameState,
  netWorths,
  netWorthsEnabled,
  netWorthsLoading,
  netWorthsError,
  marketGrid,
}: PlayerAssetsSectionProps) {
  // Design note #7 in `utils/gameState.ts`: Yellow/Orange/Brown holdings
  // are exempt from the certificate limit, which needs live prices.
  const marketPrices: Record<number, number | null> = {};
  for (const entry of marketGrid?.positions ?? []) {
    const value = Number(entry.price);
    marketPrices[entry.company_id] = Number.isFinite(value) ? value : null;
  }
  // The standardized corporation order every player's share row is measured
  // against (design note #8). Taken straight from contract order rather than
  // sorted here, so the ledger, the stock round and the operating round all
  // list corporations in the same sequence.
  const companies = gameState.public_companies;
  const hasCompanies = companies.length > 0;

  /** Placeholder shared by the two query-backed money columns, so a failed or
   *  unconfigured net-worth query says WHY it is blank instead of showing a
   *  bare dash that looks like "this player owns nothing". */
  const pendingLabel = !netWorthsEnabled ? "not connected" : netWorthsLoading ? "loading..." : "--";

  return (
    <section style={{ ...styles.section, ...styles.sectionPlayers }}>
      <h3 style={{ ...styles.sectionTitle, ...styles.sectionTitlePlayers }}>Player Assets</h3>
      {gameState.player_addresses.length === 0 ? (
        <p style={styles.placeholderText}>No registered players yet.</p>
      ) : (
        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.thB} rowSpan={2}>
                  Player
                </th>
                <th style={styles.thNumB} rowSpan={2}>
                  Certs
                </th>
                <th style={styles.thNumB} rowSpan={2}>
                  Liquid Cash
                </th>
                <th style={styles.thNumB} rowSpan={2}>
                  Stock Value
                </th>
                <th style={styles.thNumB} rowSpan={2}>
                  Net Worth
                </th>
                <th style={hasCompanies ? styles.thB : styles.th} rowSpan={2}>
                  Private Companies
                </th>
                {/* One labelled Shares region spanning a column per
                    corporation -- design note #8. Rendered only when there
                    are corporations at all: `colSpan={0}` is not valid HTML. */}
                {hasCompanies && (
                  <th style={styles.thShareGroup} colSpan={companies.length}>
                    Shares
                  </th>
                )}
              </tr>
              <tr>
                {companies.map((company, index) => (
                  <th
                    key={company.company_id}
                    style={{
                      ...(index === companies.length - 1 ? styles.thTicker : styles.thTickerB),
                      // Design note #13: each corporation's own brand colour,
                      // from the SAME table the map tokens and the Operating
                      // Round rows use (`stationTickerColor`). Applied to the
                      // ink and a hairline underline rather than as a filled
                      // background: eight saturated fills across a header row
                      // would out-shout the percentages underneath, which are
                      // the data. The colour is a wayfinding aid for tracking
                      // one column down a tall table, not a highlight.
                      color: stationTickerColor(company.company_id),
                      borderBottomWidth: "2px",
                      borderBottomStyle: "solid",
                      borderBottomColor: stationTickerColor(company.company_id),
                    }}
                    title={corporationTitle(company.ticker)}
                  >
                    {company.ticker}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {gameState.player_addresses.map((player) => {
                // Liquid cash is real, queryable straight off `GetGameState`
                // -- no live `PlayerNetWorth` query needed just for this
                // column (design note #6(2)).
                const cashEntry = gameState.player_cash.find((entry) => entry.player === player);
                const netWorth = netWorths[player];
                const privates = playerPrivateCompanies(player, gameState);
                const certs = certificateBreakdown(
                  player,
                  gameState,
                  marketGrid ? marketPrices : null,
                  marketZoneForPrice,
                );
                // Indexed by company so the row can be emitted in the fixed
                // corporation order above, filling 0% for the gaps, rather
                // than in whatever order the player happens to hold things.
                const heldPercent = new Map<number, number>();
                for (const holding of playerCompanyHoldings(player, gameState)) {
                  heldPercent.set(holding.company.company_id, holding.percentage);
                }
                const hasPriorityDeal =
                  gameState.player_addresses[gameState.priority_deal_index] === player;
                return (
                  <tr key={player}>
                    <td style={styles.tdB}>
                      {truncate(player)}
                      {hasPriorityDeal && (
                        <span style={styles.priorityDealMark} title={PRIORITY_DEAL_TOOLTIP}>
                          #1
                        </span>
                      )}
                    </td>
                    <td
                      style={styles.tdNumB}
                      title={
                        certs.exempt > 0
                          ? `${certs.exempt} certificate${certs.exempt === 1 ? "" : "s"} are exempt: their corporation's price is in a Yellow, Orange or Brown zone.`
                          : undefined
                      }
                    >
                      {formatCertificateCount(certs)}
                    </td>
                    <td style={styles.tdNumB}>{cashEntry ? `$${cashEntry.cash_vgp}` : "--"}</td>
                    <td style={styles.tdNumB}>
                      {netWorth ? `$${netWorth.stock_portfolio_value}` : pendingLabel}
                    </td>
                    <td style={styles.tdNumB}>{netWorth ? `$${netWorth.net_worth}` : pendingLabel}</td>
                    <td style={hasCompanies ? styles.tdB : styles.td}>
                      {privates.length === 0 ? (
                        <span style={styles.holdingsEmpty}>None</span>
                      ) : (
                        <div style={styles.holdingsCell}>
                          {privates.map((priv) => (
                            <span key={priv.private_id} style={styles.holdingChipPrivate}>
                              {priv.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    {companies.map((company, index) => {
                      const percentage = heldPercent.get(company.company_id) ?? 0;
                      const isPresident = company.president === player;
                      const last = index === companies.length - 1;
                      const base = last ? styles.tdShare : styles.tdShareB;
                      return (
                        <td
                          key={company.company_id}
                          style={percentage === 0 ? { ...base, ...styles.tdShareZero } : base}
                        >
                          {/* Design note #15: crown LEFT of the number.
                              On the right it sat inside the right-aligned
                              edge, so a president's row was pushed left by
                              the glyph's width and its percentage no longer
                              lined up with the plain rows above and below.
                              Moving it left puts the variable-width element
                              on the ragged side and leaves the digits
                              flush, which is the entire point of a
                              right-aligned numeric column. */}
                          {isPresident && (
                            <span style={styles.presidentTag} title="President">
                              &#128081;
                            </span>
                          )}
                          {percentage}%
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {netWorthsEnabled && netWorthsError && (
        <p style={styles.footnote}>Net worth query failed: {netWorthsError}</p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* DESIGN NOTE 7: ONE PLAYER TABLE, NOT A TABLE PLUS A TREE            */
/* ------------------------------------------------------------------ */
//
// "Player Assets" and "Player Certificate Trees" were two views of one
// thing: the table had cash and net worth, the trees had certificate counts
// and the actual holdings. Answering "does Alice have the certificates AND
// the cash to take this company?" meant reading a table, scrolling to a
// grid of cards, finding the same player again, and holding both halves in
// your head.
//
// They are one table now, with Certs and the holdings themselves as columns
// (design note #8 later split those holdings into a Private Companies column
// and a per-corporation Shares group). The tree's
// per-card net-worth row is dropped as duplicative -- the table already had
// that column -- and its footnote is gone entirely: it explained that the
// certificate count was a client-side estimate, which is no longer true
// (see `certificateCount`) and was a development note in a player-facing
// UI regardless.

/* ------------------------------------------------------------------ */

/* ==================================================================
 *  DESIGN NOTE 14: ONE CORPORATION TABLE, NOT TWO
 * ==================================================================
 *
 * "Corporation Assets" and "Corporate Stock Distribution" were two tables
 * with the same rows in the same order, stacked. Answering the only
 * question the ledger exists for -- is this company worth buying into --
 * meant reading treasury and trains in one, scrolling, finding the same
 * ticker again, and reading IPO and pool split in the other.
 *
 * They are one table. The column order follows how the question is
 * actually asked: WHO it is (corporation, president), WHAT IT IS WORTH
 * (market price, treasury), WHAT IT CAN DO (trains, limit, last payout),
 * and WHO HOLDS IT (IPO, bank pool, player hands).
 *
 * THE TOTAL COLUMN IS DELETED. It summed the three ownership columns as a
 * visible reconciliation check, on the reasoning that a mismatch would
 * indicate a contract bug and should not be hidden. That reasoning was
 * sound and the column still had to go: it printed "100%" on every row of
 * every game, so the one time it mattered it would be a single digit
 * changing in a column nobody had read in months. The three columns are
 * adjacent and add up in your head; a checker that cries wolf by never
 * crying is not a checker.
 */
function CorporationAssetsSection({
  gameState,
  marketGrid,
}: {
  gameState: GameStateResponse;
  marketGrid?: MarketGridResponse | null;
}) {
  const phase = derivePhase(gameState);
  const outlook = rustOutlook(gameState);
  const priceByCompany = new Map<number, number>();
  for (const entry of marketGrid?.positions ?? []) {
    const value = Number(entry.price);
    if (Number.isFinite(value)) priceByCompany.set(entry.company_id, value);
  }

  return (
    <section style={{ ...styles.section, ...styles.sectionCorps }}>
      <h3 style={{ ...styles.sectionTitle, ...styles.sectionTitleCorps }}>Corporation Assets</h3>
      {gameState.public_companies.length === 0 ? (
        <p style={styles.placeholderText}>No corporations yet.</p>
      ) : (
        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.thB}>Corporation</th>
                <th style={styles.thB}>President</th>
                <th style={styles.thNumB}>Market Price</th>
                <th style={styles.thNumB}>Treasury</th>
                <th style={styles.thCenterB}>Trains</th>
                <th style={styles.thCenterB}>Train Limit</th>
                <th style={styles.thNumB}>Last Route Payout</th>
                <th style={styles.thNumB}>IPO</th>
                <th style={styles.thNumB}>Bank Pool</th>
                <th style={styles.thNum}>Player Hands</th>
              </tr>
            </thead>
            <tbody>
              {gameState.public_companies.map((company) => {
                const playerHandsPercentage = company.player_holdings.reduce(
                  (sum, holding) => sum + holding.percentage,
                  0,
                );
                const price = priceByCompany.get(company.company_id);
                return (
                  <tr key={company.company_id}>
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
                        {!company.is_floated && (
                          <span style={styles.unfloatedBadge}>UNFLOATED</span>
                        )}
                      </span>
                    </td>
                    <td style={styles.tdB}>
                      {company.president ? (
                        <span style={styles.presidentCell}>
                          <span aria-hidden="true">&#128081;</span>
                          <span>{sandboxPlayerLabel(company.president) ?? truncate(company.president, 8, 5)}</span>
                        </span>
                      ) : (
                        <span style={styles.holdingsEmpty}>--</span>
                      )}
                    </td>
                    <td style={styles.tdNumB}>
                      {price === undefined ? (
                        <span style={styles.holdingsEmpty}>--</span>
                      ) : (
                        `$${price}`
                      )}
                    </td>
                    <td style={styles.tdNumB}>${company.treasury}</td>
                    <td style={styles.tdCenterB}>
                      <TrainChips
                        trains={company.owned_trains}
                        phase={phase}
                        surface="dark"
                        compact
                        outlook={outlook}
                      />
                    </td>
                    <td style={styles.tdCenterB}>
                      <CapacityPill
                        trains={company.owned_trains}
                        phase={phase}
                        surface="dark"
                        compact
                      />
                    </td>
                    <td style={styles.tdNumB}>
                      <LastRoutePayout
                        surface="dark"
                        compact
                        revenue={company.last_route_revenue}
                      />
                    </td>
                    <td style={styles.tdNumB}>{company.ipo_pool_percentage}%</td>
                    <td style={styles.tdNumB}>{company.bank_pool_percentage}%</td>
                    <td style={styles.tdNum}>{playerHandsPercentage}%</td>
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
    fontSize: FONT_SIZE.heading,
    margin: 0,
  },
  placeholderText: {
    fontSize: FONT_SIZE.body,
    color: "#6f7480",
  },
  staleNote: {
    fontSize: FONT_SIZE.micro,
    color: "#8a6d1f",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  /* ---- Design note #9: section colour coding. Longhand border properties
     throughout: this file's own convention is to never mix `border` with a
     `borderColor` override, because React drops one of them depending on key
     order. ---- */
  sectionBank: {
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    borderLeftColor: "#c9a94c",
    backgroundColor: "rgba(201, 169, 76, 0.05)",
    paddingTop: "12px",
    paddingRight: "14px",
    paddingBottom: "14px",
    paddingLeft: "14px",
    borderTopRightRadius: "8px",
    borderBottomRightRadius: "8px",
  },
  sectionPlayers: {
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    borderLeftColor: "#5b8fd6",
    backgroundColor: "rgba(91, 143, 214, 0.05)",
    paddingTop: "12px",
    paddingRight: "14px",
    paddingBottom: "14px",
    paddingLeft: "14px",
    borderTopRightRadius: "8px",
    borderBottomRightRadius: "8px",
  },
  sectionCorps: {
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    borderLeftColor: "#5fa87a",
    backgroundColor: "rgba(95, 168, 122, 0.05)",
    paddingTop: "12px",
    paddingRight: "14px",
    paddingBottom: "14px",
    paddingLeft: "14px",
    borderTopRightRadius: "8px",
    borderBottomRightRadius: "8px",
  },
  sectionTitleBank: { color: "#c9a94c" },
  /* ---- Design note #16: the depot inventory sub-table. ---- */
  subTableTitle: {
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    color: "#c9a94c",
    margin: "12px 0 0",
  },
  depotRowCurrent: { backgroundColor: "rgba(201, 169, 76, 0.08)" },
  // Dimmed, not hidden: a sold-out tier is still worth knowing the cost of,
  // and a rusted one explains why a rival's fleet vanished.
  depotRowDimmed: { opacity: 0.55 },
  depotTrigger: { color: "#9aa0ac" },
  depotRustedBadge: {
    marginLeft: "8px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.4px",
    padding: "1px 7px",
    borderRadius: "999px",
    backgroundColor: "rgba(244, 63, 94, 0.18)",
    border: "1px solid #f43f5e",
    color: "#fda4af",
    // The one state that really is gone from play.
    textDecoration: "line-through",
    whiteSpace: "nowrap",
  },
  depotSoldOutBadge: {
    marginLeft: "8px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.4px",
    padding: "1px 7px",
    borderRadius: "999px",
    backgroundColor: "#232936",
    border: "1px solid #4a5163",
    color: "#9aa0ac",
    whiteSpace: "nowrap",
  },
  depotCurrentBadge: {
    marginLeft: "8px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.4px",
    padding: "1px 7px",
    borderRadius: "999px",
    backgroundColor: "rgba(201, 169, 76, 0.18)",
    border: "1px solid #c9a94c",
    color: "#e0c070",
    whiteSpace: "nowrap",
  },
  sectionTitlePlayers: { color: "#8fb4e8" },
  sectionTitleCorps: { color: "#7fc79a" },
  sectionTitle: {
    fontSize: FONT_SIZE.control,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "#9aa0ac",
    margin: 0,
  },
  /** The inline Priority Deal marker. Bare text on purpose -- no pill, no
   *  border, no background. This sits immediately beside a player's name in
   *  a dense table that already carries a crown glyph and an ACTIVE badge
   *  elsewhere; a third boxed element would turn the name column into a row
   *  of competing containers. Colour and the monospace `#1` do the whole job.
   *
   *  `cursor: help` is what signals the `title` tooltip is there at all --
   *  without it the mark looks like decoration rather than something to
   *  hover. */
  priorityDealMark: {
    marginLeft: "6px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontWeight: 700,
    // `text-sm` in the requested Tailwind spec means "one step below body".
    // This app's scale is uniformly upsized (see `styles/typography.ts`), so
    // the honest translation is `small`, not a literal 14px -- a hardcoded
    // 14px would be the one element in the table ignoring the scale.
    fontSize: FONT_SIZE.small,
    // Tailwind `tracking-tight`.
    letterSpacing: "-0.025em",
    // Tailwind `text-sky-400`.
    color: "#38bdf8",
    cursor: "help",
  },
  presidentTag: {
    // Design note #15: margin follows the glyph to the left side.
    marginRight: "5px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    // The pill is GONE. The crown emoji already carries its own colour and
    // silhouette, so wrapping it in a gold pill was two badges stacked --
    // the container read as the indicator and the glyph inside it as
    // decoration, which is backwards. Bare, it reads as one mark.
    //
    // `padding`/`borderRadius`/`backgroundColor`/`color` were removed rather
    // than zeroed: an emoji renders in its own colour font regardless, so a
    // `color` here only ever affected the fallback glyph, and leaving dead
    // declarations behind invites someone to "restore" the box later.
  },
  /* ---- Holdings chips. Only the PRIVATE companies still use a chip: the
     public holdings became real columns in design note #8, and the fourteen
     `tree*`/`netWorth*` styles the removed certificate-tree cards used were
     deleted with them rather than left to rot. ---- */
  holdingsCell: { display: "flex", flexWrap: "wrap", gap: "4px", maxWidth: "340px" },
  holdingsEmpty: { color: "#6f7480", fontStyle: "italic" },
  holdingChipPrivate: {
    display: "inline-flex",
    alignItems: "center",
    fontSize: FONT_SIZE.micro,
    padding: "2px 7px",
    borderRadius: "999px",
    backgroundColor: "#2a2314",
    color: "#d9c48a",
    whiteSpace: "nowrap",
  },
  footnote: {
    fontSize: FONT_SIZE.micro,
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
    fontSize: FONT_SIZE.body,
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
  // ---- Justification and column rules -- design note #8.
  //
  // `*Num` right-justifies; the `*B` suffix adds the vertical column rule.
  // The rule lives on borderRIGHT rather than borderLeft so the LAST column
  // of a table can simply use the plain variant and not draw an edge -- with
  // borderLeft the same trick would have to be applied to the first column,
  // which reads worse at a glance when scanning the style names. ----
  thNum: {
    textAlign: "right",
    padding: "8px 14px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  thB: {
    textAlign: "left",
    padding: "8px 14px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    borderRight: "1px solid #232733",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  thNumB: {
    textAlign: "right",
    padding: "8px 14px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    borderRight: "1px solid #232733",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  tdB: {
    padding: "8px 14px",
    borderBottom: "1px solid #1e2129",
    borderRight: "1px solid #1e2129",
  },
  tdNumB: {
    padding: "8px 14px",
    borderBottom: "1px solid #1e2129",
    borderRight: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "right",
  },
  // ---- The Shares column group ----
  thCenterB: {
    textAlign: "center",
    padding: "8px 14px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    borderRight: "1px solid #232733",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  tdCenterB: {
    padding: "8px 14px",
    borderBottom: "1px solid #1e2129",
    borderRight: "1px solid #1e2129",
    textAlign: "center",
  },
  corpCell: { display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
  corpTicker: { fontWeight: 700 },
  corpFullName: { fontSize: FONT_SIZE.micro, color: "#8a90a0", whiteSpace: "nowrap" },
  presidentCell: { display: "inline-flex", alignItems: "center", gap: "6px" },
  // Same "badge only on the exception" rule the Operating Round tray uses.
  //
  // Slate, not amber -- see `palette.ts`'s CHIP_INERT_* note. This badge sat
  // a few hundred pixels from the Bank Depot's amber CURRENT pill and the
  // two read as one inconsistent style rather than two unrelated states.
  //
  // `FONT_SIZE.micro` rather than a literal 12px: `typography.ts` scaled the
  // whole app's ramp up on purpose (micro is 15px, "originally 10-11px"), so
  // a hardcoded size here would render this one chip visibly smaller than
  // every badge beside it and silently opt out of that decision.
  unfloatedBadge: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 500,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    letterSpacing: "0.4px",
    padding: "2px 8px",
    borderRadius: "4px",
    backgroundColor: CHIP_INERT_BG,
    border: `1px solid ${CHIP_INERT_BORDER}`,
    color: CHIP_INERT_INK,
    whiteSpace: "nowrap",
  },
  // Design note #13: the token dot, matching the map and the OR tray.
  tokenDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,0.35)",
  },
  thShareGroup: {
    textAlign: "center",
    padding: "6px 14px",
    color: "#8fb4e8",
    borderBottom: "1px solid #2a2e3a",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  thTicker: {
    textAlign: "right",
    padding: "6px 10px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    fontWeight: 600,
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  thTickerB: {
    textAlign: "right",
    padding: "6px 10px",
    color: "#8a90a0",
    borderBottom: "1px solid #2a2e3a",
    borderRight: "1px solid #232733",
    fontWeight: 600,
    fontSize: FONT_SIZE.micro,
    whiteSpace: "nowrap",
  },
  tdShare: {
    padding: "8px 10px",
    borderBottom: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  tdShareB: {
    padding: "8px 10px",
    borderBottom: "1px solid #1e2129",
    borderRight: "1px solid #1e2129",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  // An explicit 0% is dimmed rather than omitted -- design note #8: a blank
  // cell cannot be told apart from missing data.
  tdShareZero: { color: "#5a5f6b" },
  tdMuted: {
    padding: "8px 14px",
    borderBottom: "1px solid #1e2129",
    color: "#6f7480",
    textAlign: "right",
    fontSize: FONT_SIZE.small,
  },
};
