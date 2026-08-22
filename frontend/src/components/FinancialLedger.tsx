// frontend/src/components/FinancialLedger.tsx
//
// The "Game Ledger" top-level tab: bank treasury, player assets and certificates, corporation assets,
// and the bank depot inventory.
//
// Design note #1: bank cash is real, queryable data -- `virtual_bank_vgp`/`virtual_bank_start` (VGP) and
// `total_juno_pool` (real JUNO) are genuine `GameStateResponse` fields, rendered directly.
// Design note #3: the Hardware Shop is an honest DESIGN GAP, not a fabricated shop. `state.rs` has a real
// hardware pool and `hardware.rs` a real train catalog, but no `QueryMsg` reads either back -- so that gap
// surfaces as an explicit "not yet exposed by contract" cell plus one shared footnote.
// Design note #4: net worth is the real on-chain `QueryMsg::PlayerNetWorth` figure (superseded in part by
// #497, which derives the same sum locally when there is no chain to ask).
// Design note #5: "Game Ledger" is a DISPLAY-TEXT rename only -- the module keeps its name deliberately.
// Design note #6: four real `<table>` elements, each in a horizontally-scrolling container so a dense
// table degrades to a scrollbar rather than an unreadable reflow.
//
// Design history: see `docs/ai_architecture/contract_economy.md`.

import PresidentCrown from "./PresidentCrown";
import React from "react";

import type { GameStateResponse, PlayerNetWorthResponse, QueryCapableClient } from "../utils/gameState";
// Design note #497: the local valuation, for when there is no chain to ask.
import { estimatePlayerNetWorth, sharePriceFor } from "../utils/gameState";
import { PRIORITY_DEAL_TOOLTIP } from "../utils/gameState";
import { FONT_SIZE } from "../styles/typography";
// `ContextualSubPanel` design note #170: a name beats a truncated hash, and this returns `null` for a real
// wallet so live rooms are unchanged.
// Design note #559: the ROOM-AWARE resolver. Importing it from `sandboxState` got the fixture's Alice/Bob
// table, which returns null for a real room id -- so presidents rendered as raw `p-` ids here while every
// other surface showed names.
import { sandboxPlayerLabel } from "../utils/playerLabels";
import {
  CARD_HIGHLIGHT_BORDER,
  CHIP_INERT_BG,
  CHIP_INERT_BORDER,
  CHIP_INERT_INK,
} from "../styles/palette";
import { corporationFullName, corporationTitle } from "../utils/corporationNames";
import { depotInventory, derivePhase, rustOutlook } from "../utils/gamePhase";
import { formatNativeAmountCompact, NATIVE_DENOM_DISPLAY } from "../config";
import { stationTickerColor } from "./hexContractTypes";
import { PrivateCompanyPills } from "./PrivateCompanyPills";
import { CapacityPill, LastRoutePayout, TrainChips } from "./TrainBadges";
// Design note #710: the Liquidity column, from the same rules the emergency-purchase plan reads.
import { playerLiquidity } from "../utils/endgame";
import { marketZoneForPrice, type MarketGridResponse } from "./StockMarketRenderer";
import {
  certificateBreakdown,
  formatCertificateCount,
  playerCompanyHoldings,
  corporationPrivateCompanies,
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
  /** Design note #405: passed through to the Player Assets table so seats
   *  read as names rather than truncated addresses. */
  playerLabel?: (address: string) => string | null;
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
  playerLabel,
}: FinancialLedgerProps) {
  // Called unconditionally (React hook rules) even before `gameState` resolves -- the hook no-ops cleanly on
  // an empty address list, and the fresh-array-every-render is safe because it depends only on the JOINED
  // content (`gameState.ts` design note #6).
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
            playerLabel={playerLabel}
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
              {/* Design note #12: the pool arrives as `ujuno` -- micro-JUNO, the Cosmos base unit -- so a 40 JUNO pool
                 reads as 40000000 raw. Converted through `formatNativeAmountCompact` rather than by dividing here: that
                 helper does the six decimal places with integer string math, because a `Uint128` above 2^53 loses
                 precision the moment it becomes a double, and a pool of real money is the last place to be quietly wrong. */}
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

/* Design note #16: THE BANK DEPOT INVENTORY -- which trains are left, what they cost, and what buying one
   sets off, each previously discoverable only by counting other corporations' holdings by hand.
   It lives in the BANK section rather than with the corporations because the depot belongs to the bank: it
   is stock nobody owns yet. The Corporation Assets table answers "who has what"; this answers "what is
   still for sale".
   `depotInventory` (`gamePhase.ts #4`) supplies exact per-tier counts via the queue rule, not by subtracting
   owned trains from printed totals -- that shortcut is unsound for obsolete tiers and would report rusted
   trains as though they were still on the shelf.
   TWO DIMMED STATES, NOT ONE: a tier can be unbuyable while its trains still run, and only a genuinely
   rusted tier gets the strikethrough, because only then is it gone. */
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
                    {/* Design note #16: the same chip the corporation rows use, so a tier looks identical wherever it appears.
                       `phase={null}` deliberately -- the rust TINT means "a corporation's train is about to die", and this is a
                       price list, not a holding. The `rusted` column carries that story instead. */}
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
  /** Design note #405: resolves a seat to a readable name. Omitted, rows
   *  fall back to the truncated address, which is the old behaviour. */
  playerLabel?: (address: string) => string | null;
}

/* Design note #405: ONE PLAYER ASSETS TABLE, TWO PLACES. "A replication of" is the phrase that decided the
   implementation -- building a second table in `ContextualSubPanel` would replicate the LOOK and drift on
   everything else, since the certificate-limit exemption needs live market prices and the money columns
   need the net-worth query and its three pending states. The footer renders THIS component instead.
   THE RAW-ADDRESS PROBLEM IS NOT FIXED BY THE MOVE, and an earlier draft of this note claimed it was: this
   table truncated exactly as the footer did, only shorter. The fix is an optional `playerLabel`, resolved
   the way every other roster resolves a seat. Recorded rather than quietly corrected, because a note
   asserting a fix that does not exist is worse than no note. */
export function PlayerAssetsSection({
  gameState,
  netWorths,
  netWorthsEnabled,
  netWorthsLoading,
  netWorthsError,
  marketGrid,
  playerLabel,
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

  /** Placeholder shared by the two money columns when NEITHER the chain nor the local estimate can answer, so
   *  a blank cell says WHY instead of showing a bare dash that looks like "this player owns nothing".
   *  Design note #497: "not connected" is the LAST RESORT now rather than the offline default -- reached only
   *  when there is no query AND no market grid to value holdings against, at which point the cell really does
   *  have nothing behind it. */
  const pendingLabel = !netWorthsEnabled ? "not connected" : netWorthsLoading ? "loading..." : "--";

  /* Design note #555: THIS IS ARITHMETIC, NOT AN ESTIMATE. The `~` was answering a real question with the
     wrong symbol: #497a added it so a client total could not pass for the chain's, which is a sound concern.
     But the two are not an approximation and an authority -- they are the SAME SUM over the same inputs, with
     nothing rounded, sampled or inferred. The distinction that matters is PROVENANCE, and `~` does not mean
     "computed here", it means "roughly", which is a claim about accuracy that was never true.
     THE TOOLTIP STAYS AND DOES THE JOB PROPERLY -- provenance belongs in words, attached to precisely the
     cells the client computed. (`estimateCertificateCount` was renamed for the same reason.) */
  /* One sentence, shared by the header and every cell, so the column cannot explain itself two ways. It names
     the president rule specifically because that is the restriction a player is most likely to be surprised
     by -- the pool cap at least announces itself on the market. Matches `PlayerCards`' wording deliberately. */
  const LIQUIDITY_TOOLTIP =
    "Cash plus only the shares that could legally be sold right now — a president's block cannot be sold " +
    "unless another player already holds 20%, the bank pool cannot exceed 50% of a corporation, and a " +
    "corporation nobody has parred yet has no price to sell at.";

  const ESTIMATE_TOOLTIP =
    "Calculated in this browser from the board's own holdings and live market " +
    "prices — exact, not approximate. The contract's PlayerNetWorth query answers " +
    "this when a chain is connected; offline and in sandbox it is the same " +
    "arithmetic, run here.";

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
                {/* Design note #710: "Liquid Cash" was a tautology -- cash is liquid by definition, and the
                    adjective was doing the job of a column that did not exist. REPORTED: "Cash is by
                    definition liquid. I think what is missing in this table is a LIQUIDITY column that shows
                    cash + sellable stocks." */}
                <th style={styles.thNumB} rowSpan={2} title="Cash in hand.">
                  Cash
                </th>
                <th
                  style={styles.thNumB}
                  rowSpan={2}
                  title="Every share this player holds, at its market price."
                >
                  Stock Value
                </th>
                {/* BETWEEN THE TWO TOTALS, as reported, and the position earns its keep: Liquidity and Net
                    Worth are the same sum over different sets of shares, so side by side the GAP between them
                    reads at a glance. #562a: "$2,000 of net worth against $200 of liquidity is one bad train
                    purchase from bankruptcy, and a single Net Worth column has never been able to say so." */}
                <th
                  style={styles.thNumB}
                  rowSpan={2}
                  title={LIQUIDITY_TOOLTIP}
                >
                  Liquidity
                </th>
                <th
                  style={styles.thNumB}
                  rowSpan={2}
                  title="Cash plus every share at market price. The score."
                >
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
                      // Design note #13: each corporation's own brand colour, from the SAME table the map tokens and the
                      // Operating Round rows use. Applied to the ink and a hairline underline rather than as a filled background:
                      // eight saturated fills across a header row would out-shout the percentages underneath, which are the data.
                      // The colour is a wayfinding aid for tracking one column down a tall table, not a highlight.
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
                /* Design note #497: the local valuation, computed only when
                   the chain has not answered. `null` when a held corporation
                   has no market price -- an unknown total rather than a
                   wrong one. */
                const estimated = netWorth
                  ? null
                  : estimatePlayerNetWorth(player, gameState, marketPrices);
                /* Design note #710: cash + only what could legally be sold. `playerLiquidity` owns the
                   arithmetic and `sellableHoldings` owns the rules, so this column and the player card cannot
                   drift apart -- they differ only in the price resolver handed in, which is #566's
                   distinction and is stated there. */
                const liquidity = playerLiquidity(
                  gameState,
                  player,
                  cashEntry ? Number(cashEntry.cash_vgp) || 0 : null,
                  /* Design note #711: the shared ladder -- market, then par, then $0 for a corporation nobody
                     has parred. NOT the bare `marketPrices` this table also feeds to the net-worth estimate:
                     a parred corporation whose token is not yet on the chart has a real price, and reading
                     $0 there would call a sellable share worthless. */
                  (companyId) => {
                    const company = gameState.public_companies.find(
                      (entry) => entry.company_id === companyId,
                    );
                    return company ? sharePriceFor(company, marketPrices) : null;
                  },
                );
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
                      {/* Design note #405: a name when there is one. */}
                      {playerLabel?.(player) ?? truncate(player)}
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
                    {/* Design note #497: THE CHAIN FIRST, THEN THE BOARD. Precedence, most authoritative first: the on-chain
                       `PlayerNetWorth`, still preferred wherever there is a chain to ask; then the same arithmetic over the
                       holdings and live prices this table already has in hand, which is what a sandbox shows instead of "not
                       connected"; then the placeholder.
                       THE PROVENANCE IS MARKED, by the tooltip. Design note #555: the `~` is gone -- it claimed the figure was
                       approximate, which it never was. What #4 warned against was a client total silently PASSING FOR the
                       contract's, and the tooltip says which arithmetic ran and where, on exactly the cells the client computed. */}
                    <td style={styles.tdNumB} title={netWorth ? undefined : ESTIMATE_TOOLTIP}>
                      {netWorth
                        ? `$${netWorth.stock_portfolio_value}`
                        : estimated
                          ? `$${Math.round(estimated.stockValue)}`
                          : pendingLabel}
                    </td>
                    {/* Design note #710: ALWAYS COMPUTED HERE, never taken from `PlayerNetWorth`. The
                       contract answers net worth and stock value; it has no notion of what may be SOLD, which
                       depends on the pool's 50% cap and on whether another player can succeed a president --
                       both facts this table already holds. So there is no chain figure to prefer, and the
                       tooltip marks the provenance the same way the two client-computed cells beside it do.
                       Design note #711: there is no strict-versus-loose reading left to choose between --
                       `sharePriceFor` is the one ladder, and the only thing that withholds this figure now is
                       a player whose cash the state has not reported. */}
                    <td style={styles.tdNumB} title={liquidity === null ? undefined : LIQUIDITY_TOOLTIP}>
                      {liquidity === null ? pendingLabel : `$${Math.round(liquidity)}`}
                    </td>
                    <td style={styles.tdNumB} title={netWorth ? undefined : ESTIMATE_TOOLTIP}>
                      {netWorth
                        ? `$${netWorth.net_worth}`
                        : estimated
                          ? `$${Math.round(estimated.netWorth)}`
                          : pendingLabel}
                    </td>
                    <td style={hasCompanies ? styles.tdB : styles.td}>
                      {/* Design note #423: THE SAME PILLS THE AUCTION USES. This cell and the auction's seating table were two
                         hand-rolled renderers for one thing, and they had already drifted into disagreeing about what a private
                         looks like -- a bare numeral there, the full name with revenue appended here, and neither clickable.
                         The full name and the revenue #407 wanted on screen are not lost: they lead the panel the pill opens,
                         alongside rules text that was previously not reachable from this table at all.
                         IT ALSO FIXES THIS COLUMN'S HEIGHT -- full names wrapped, so a player holding three privates got a
                         three-line row and the whole table went ragged. Acronyms on one non-wrapping line do not. */}
                      <PrivateCompanyPills
                        privates={privates}
                        surface="table"
                        emptyLabel="None"
                      />
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
                          {/* Design note #15: crown LEFT of the number. On the right it sat inside the right-aligned edge, so a
                             president's row was pushed left by the glyph's width and its percentage no longer lined up with the plain
                             rows above and below. Moving it left puts the variable-width element on the ragged side and leaves the
                             digits flush, which is the entire point of a right-aligned numeric column. */}
                          {/* Design note #552: our own crown, not U+1F451 --
                              same drawing on every device, and it takes this
                              cell's ink instead of a vendor's. */}
                          {isPresident && (
                            <PresidentCrown style={styles.presidentTag} scale={1.15} />
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

// Design note #7: ONE PLAYER TABLE, NOT A TABLE PLUS A TREE. They were two views of one thing -- the table
// had cash and net worth, the trees had certificate counts and the actual holdings -- so answering "does
// Alice have the certificates AND the cash to take this company?" meant reading a table, scrolling to a
// grid of cards, finding the same player again, and holding both halves in your head.
// They are one table now, with certs and the holdings as columns. The tree's per-card net-worth row is
// dropped as duplicative, and its footnote is gone entirely: it explained that the certificate count was a
// client-side estimate, which is no longer true and was a development note in a player-facing UI anyway.

/* ------------------------------------------------------------------ */

/* Design note #14: ONE CORPORATION TABLE, NOT TWO. "Corporation Assets" and "Corporate Stock Distribution"
   had the same rows in the same order, stacked -- so answering the only question the ledger exists for
   meant reading treasury and trains in one, scrolling, finding the same ticker, and reading IPO and pool
   split in the other.
   The column order follows how the question is asked: WHO it is, WHAT IT IS WORTH, WHAT IT CAN DO, and WHO
   HOLDS IT.
   THE TOTAL COLUMN IS DELETED. It summed the three ownership columns as a visible reconciliation check, on
   sound reasoning -- and it still had to go: it printed "100%" on every row of every game, so the one time
   it mattered it would be a single digit changing in a column nobody had read in months. A checker that
   cries wolf by never crying is not a checker. */
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
                {/* Design note #379: what the TREASURY owns, beside what it
                    holds in cash and rolling stock. */}
                <th style={styles.thB}>Privates</th>
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
                // Design note #379: what this corporation's treasury owns.
                const corporatePrivates = corporationPrivateCompanies(
                  company.company_id,
                  gameState,
                );
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
                    {/* Design note #379: privates the treasury bought. */}
                    <td style={styles.tdB}>
                      {corporatePrivates.length === 0 ? (
                        <span style={styles.holdingsEmpty}>--</span>
                      ) : (
                        <span style={styles.corpPrivateList}>
                          {corporatePrivates.map((priv) => (
                            <span
                              key={priv.private_id}
                              style={styles.corpPrivateChip}
                              title={`${priv.name} — $${priv.revenue_per_or} per Operating Round, paid to ${company.ticker}'s treasury.`}
                            >
                              {/* Design note #407: THE REVENUE IS ON THE CHIP. Privates must display their per-OR revenue wherever they
                                 are listed outside the auction -- it is what certificate-exchange timing is judged on. Every one of these
                                 lists already KNEW the figure and spent it on a `title`: a tooltip is not a display, it needs a pointer
                                 and a pause and shows one private at a time, so comparing three meant hovering three chips in sequence
                                 and remembering two numbers. The auction is exempt because there the revenue is already the headline. */}
                              {priv.private_id}. {priv.name}
                              <span style={styles.corpPrivateRevenue}>
                                +${priv.revenue_per_or}
                              </span>
                            </span>
                          ))}
                        </span>
                      )}
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
  /** The inline Priority Deal marker. Bare text on purpose -- no pill, no border, no background: this sits
   *  beside a player's name in a dense table that already carries a crown and an ACTIVE badge elsewhere, and a
   *  third boxed element would turn the name column into a row of competing containers.
   *  `cursor: help` is what signals the tooltip is there at all -- without it the mark looks like decoration. */
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
    // Design note #15: margin follows the glyph to the left side, so the
    // variable-width element sits on the ragged side of a right-aligned
    // numeric column and the digits stay flush.
    marginRight: "5px",
    // The pill stays GONE -- the crown carries its own silhouette, and wrapping it in a gold box was two badges
    // stacked, the container reading as the indicator and the mark inside it as decoration.
    // Design note #552: `color` is BACK, and unlike before it does something. It was removed when this styled
    // an emoji, which renders in its own colour font and ignored it; the SVG fills with `currentColor`.
    color: CARD_HIGHLIGHT_BORDER,
  },
  /* Design note #423: the private-column styles are GONE with their markup -- that column renders
     `PrivateCompanyPills` now, which brings its own layout and its own pill. Deleted rather than left to rot.
     Design note #379: chips rather than a comma list -- a corporation holds at most a couple of privates, and
     each is a discrete asset with its own revenue, so they read as objects rather than as prose. */
  corpPrivateList: { display: "inline-flex", flexWrap: "wrap", gap: "4px" },
  /** Design note #407: the per-OR figure, in the money green the rest of
   *  the ledger uses for income. Kept as its own span so it stays legible
   *  when the name beside it is long. */
  corpPrivateRevenue: {
    marginLeft: "5px",
    fontWeight: 800,
    color: "#1d7a45",
    fontVariantNumeric: "tabular-nums",
  },
  corpPrivateChip: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    padding: "1px 6px",
    borderRadius: "4px",
    backgroundColor: "#2a3142",
    border: "1px solid #3a4055",
    color: "#c8cbd6",
    whiteSpace: "nowrap",
    cursor: "help",
  },
  holdingsEmpty: { color: "#6f7480", fontStyle: "italic" },
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
  // Justification and column rules -- design note #8. `*Num` right-justifies; the `*B` suffix adds the
  // vertical rule. The rule lives on `borderRight` rather than `borderLeft` so the LAST column can use the
  // plain variant and not draw an edge -- with `borderLeft` the same trick would have to be applied to the
  // first column, which reads worse at a glance when scanning the style names.
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
  // Slate, not amber: it sat a few hundred pixels from the Bank Depot's amber CURRENT pill and the two read
  // as one inconsistent style rather than two unrelated states.
  // `FONT_SIZE.micro` rather than a literal 12px -- `typography.ts` scaled the whole ramp up on purpose, so a
  // hardcoded size would render this chip visibly smaller than every badge beside it and silently opt out.
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
