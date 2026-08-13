// frontend/src/components/StockRoundPanel.tsx
//
// Stock Round (SR) Action Control Panel -- Waterfall/Stock Auction pass.
// Renders directly above the Stock Market Matrix (see App.tsx's render
// block, between `ContextualActionBar` and `styles.boardPane`) whenever a
// Stock Round is live, giving the active player genuine UI-driven controls
// for the three real `GameplayExecuteMsg` variants `ContextualActionBar`'s
// old "Buy Share (mock)" / "Sell Shares (mock)" buttons used to dispatch
// with hardcoded parameters (see App.tsx design note #4's mock-action
// placeholder convention). Buy/Sell/Pass ownership moves here entirely --
// `ContextualActionBar`'s Stock-Round button branch is emptied out in the
// same pass so there are never two competing sets of controls on screen.
//
// Design notes:
// 1. **Presentational only.** Same "App.tsx owns state, child components
//    render it" split this codebase uses everywhere (TopTicker.tsx design
//    note #1, InlineQuickChat.tsx design note #2, and now this file) --
//    every piece of selection state (`selectedProtocolId`, `parValue`,
//    `source`, `sellPercentage`) is owned by App.tsx and threaded down as
//    props, with plain callback props for every mutation.
// 2. **No new backend surface.** `BuyStock`/`SellStock` already accept
//    every parameter this panel's controls produce (`source: "Ipo" |
//    "Bank"`, `par_value: string | null`, `percentage: number`) -- this is
//    a pure frontend selection layer feeding App.tsx's existing
//    `handleBuyShare`/`handleSellShares`/`runGameplayAction` dispatch
//    plumbing untouched.
// 3. **Par Value Grid only matters pre-float.** Once the selected company's
//    `is_floated` is true, App.tsx passes `par_value: null` regardless of
//    grid selection (a floated company's share price comes from the Stock
//    Market Matrix, not a fresh par choice) -- the grid stays visible for
//    context but is visually marked inactive so it never reads as "still
//    doing something."
// 4. **Float Indicator** mirrors `public_company.rs`'s real float
//    condition: shares actually reaching player hands is
//    `100 - ipo_pool_percentage - bank_pool_percentage`; the 60% threshold
//    marker is drawn on the same bar, and the `is_floated` badge is the
//    ground truth (the bar can visually read past 60% before the backend
//    has actually processed the float on a given poll tick).
// 5. **Company selector palette** intentionally mirrors
//    `StockMarketRenderer.tsx`'s own module-local `TICKER_COLORS` (that
//    map isn't exported, so this is a hand-kept duplicate of the same
//    eight colors -- same "hand-kept mirror" convention as
//    `MOCK_TRAIN_CATALOG`/`TERRAIN_BUILD_COST_LABEL` elsewhere in this
//    codebase) so a given company reads as the same color everywhere.

import React from "react";
import type { PublicCompanyState } from "../utils/gameState";

export interface StockRoundPanelProps {
  publicCompanies: readonly PublicCompanyState[];
  selectedProtocolId: number;
  onSelectProtocolId: (id: number) => void;
  parValue: string;
  onSelectParValue: (value: string) => void;
  source: "Ipo" | "Bank";
  onSelectSource: (source: "Ipo" | "Bank") => void;
  sellPercentage: number;
  onSelectSellPercentage: (percentage: number) => void;
  onBuyShare: () => void;
  onSellShares: () => void;
  onPassTurn: () => void;
  sessionReady: boolean;
  isMyTurn: boolean;
  /** F-6: the connected wallet, needed to find THIS player's own stake in
   *  `player_holdings` and so bound the sell sizes to what they can actually
   *  cover. `null` when disconnected, which zeroes every option -- correct,
   *  since a disconnected viewer holds nothing to sell. */
  connectedAddress: string | null;
}

/** Design note #5: hand-kept duplicate of StockMarketRenderer.tsx's
 *  module-local (unexported) `TICKER_COLORS`. */
const TICKER_COLORS: Readonly<Record<number, string>> = {
  1: "#c0392b", // PRR
  2: "#2980b9", // NYC
  3: "#8e44ad", // CPR
  4: "#27ae60", // B&O
  5: "#d68910", // C&O
  6: "#16a085", // ERIE
  7: "#b03a2e", // NNH
  8: "#34495e", // B&M
};
const FALLBACK_TICKER_COLOR = "#5a6270";
function tickerColor(companyId: number): string {
  return TICKER_COLORS[companyId] ?? FALLBACK_TICKER_COLOR;
}

/** Standard 1830 par ladder, per this pass's own requirement. */
const PAR_VALUE_LADDER: readonly string[] = ["67", "71", "76", "82", "90", "100"];

/** Every sell-bundle size 1830 can express: 10% certificate blocks up to the
 *  50% Bank Pool cap. F-6.
 *
 *  Was `[10, 20, 30, 40]`, which silently made a legal move unreachable: a
 *  player holding 60% could not dump 50% in one action, and a president
 *  executing a legal dump-and-transfer had no control for it at all. The
 *  backend accepts any multiple of 10 up to holdings, bounded by the pool
 *  cap; the UI simply did not offer the top step.
 *
 *  The list is now the full domain, and `sellOptionState` below decides which
 *  entries are legal RIGHT NOW. Rendering the illegal ones greyed with a
 *  reason is deliberate: an absent control teaches a player nothing, while a
 *  disabled one that says "would exceed the 50% Bank Pool cap" teaches them
 *  the rule at the moment it applies to them. */
const SELL_PERCENTAGE_OPTIONS: readonly number[] = [10, 20, 30, 40, 50];

/** The 1830 Bank Pool cap: no company may have more than 50% of its shares
 *  sitting in the pool at once. Mirrors the backend's own bound. */
const BANK_POOL_CAP_PERCENT = 50;

/** Whether one sell size is currently legal, and if not, why.
 *
 *  TWO independent limits, reported separately because they call for
 *  different actions from the player:
 *    - HOLDINGS. You cannot sell shares you do not have. Nothing to be done
 *      about it this turn.
 *    - POOL CAP. The pool has room for `50 - bank_pool_percentage` more.
 *      This one moves as other players buy out of the pool, so a player who
 *      knows the reason knows to wait rather than assuming the UI is broken.
 *
 *  Holdings is checked first: if you cannot cover the bundle at all, saying
 *  so is more useful than a pool-cap message about shares you never had. */
function sellOptionState(
  percentage: number,
  playerHoldingPercent: number,
  bankPoolPercent: number,
): { enabled: boolean; reason?: string } {
  if (percentage > playerHoldingPercent) {
    return {
      enabled: false,
      reason: `You hold ${playerHoldingPercent}% -- not enough for a ${percentage}% bundle`,
    };
  }
  const poolRoom = Math.max(0, BANK_POOL_CAP_PERCENT - bankPoolPercent);
  if (percentage > poolRoom) {
    return {
      enabled: false,
      reason:
        `Bank Pool is at ${bankPoolPercent}% and caps at ${BANK_POOL_CAP_PERCENT}% -- ` +
        `only ${poolRoom}% more can be sold into it`,
    };
  }
  return { enabled: true };
}

const FLOAT_THRESHOLD_PERCENT = 60;

export function StockRoundPanel({
  publicCompanies,
  selectedProtocolId,
  onSelectProtocolId,
  parValue,
  onSelectParValue,
  source,
  onSelectSource,
  sellPercentage,
  onSelectSellPercentage,
  onBuyShare,
  onSellShares,
  onPassTurn,
  sessionReady,
  isMyTurn,
  connectedAddress,
}: StockRoundPanelProps) {
  const selectedCompany = publicCompanies.find((c) => c.company_id === selectedProtocolId) ?? null;
  const soldPercentage = selectedCompany
    ? Math.max(0, 100 - selectedCompany.ipo_pool_percentage - selectedCompany.bank_pool_percentage)
    : 0;
  const isFloated = selectedCompany?.is_floated ?? false;
  const controlsDisabled = !sessionReady;

  // F-6: this player's own stake in the selected company, which is what
  // bounds the sell sizes. `player_holdings` OMITS anyone holding exactly 0%
  // (see `gameState.ts`), so an absent entry means zero, not missing data.
  const playerHoldingPercent =
    selectedCompany?.player_holdings.find((holding) => holding.player === connectedAddress)
      ?.percentage ?? 0;
  const bankPoolPercent = selectedCompany?.bank_pool_percentage ?? 0;

  // Keep the committed selection legal. Without this, a player who selects
  // 50%, then watches the pool fill as others sell, is left with an illegal
  // size selected and an enabled Sell button that the contract will reject --
  // the UI would be inviting a transaction it knows will fail.
  const selectedSellState = sellOptionState(sellPercentage, playerHoldingPercent, bankPoolPercent);

  return (
    <div style={styles.root}>
      <div style={styles.headerRow}>
        <span style={styles.headerTitle}>Stock Round Actions</span>
        {!isMyTurn && <span style={styles.headerHint}>Waiting for your turn...</span>}
      </div>

      {/* Company selector -- design note #5. */}
      <div style={styles.section}>
        <span style={styles.sectionLabel}>Company</span>
        <div style={styles.companyPillRow}>
          {publicCompanies.map((company) => {
            const color = tickerColor(company.company_id);
            const active = company.company_id === selectedProtocolId;
            return (
              <button
                key={company.company_id}
                type="button"
                style={{
                  ...styles.companyPill,
                  borderColor: color,
                  ...(active ? { backgroundColor: color, color: "#0a0e17" } : { color }),
                }}
                onClick={() => onSelectProtocolId(company.company_id)}
              >
                {company.ticker}
                {company.is_floated && <span style={styles.floatedDot} aria-label="floated" title="Floated" />}
              </button>
            );
          })}
          {publicCompanies.length === 0 && <span style={styles.emptyHint}>No companies loaded yet.</span>}
        </div>
      </div>

      {/* Corporation Float Indicator -- design note #4. */}
      {selectedCompany && (
        <div style={styles.section}>
          <span style={styles.sectionLabel}>
            Float Status
            <span style={{ ...styles.floatBadge, ...(isFloated ? styles.floatBadgeActive : {}) }}>
              {isFloated ? "FLOATED" : "NOT FLOATED"}
            </span>
          </span>
          <div style={styles.floatBarTrack}>
            <div style={{ ...styles.floatBarFill, width: `${Math.min(100, soldPercentage)}%` }} />
            <div style={{ ...styles.floatBarThreshold, left: `${FLOAT_THRESHOLD_PERCENT}%` }} title="60% float threshold" />
          </div>
          <span style={styles.floatBarCaption}>
            {soldPercentage.toFixed(0)}% sold to players ({FLOAT_THRESHOLD_PERCENT}% needed to float)
          </span>
        </div>
      )}

      <div style={styles.controlsRow}>
        {/* Initial Par Value Selection Grid. */}
        <div style={{ ...styles.section, ...(isFloated ? styles.sectionInactive : {}) }}>
          <span style={styles.sectionLabel}>Par Value{isFloated ? " (already floated)" : ""}</span>
          <div style={styles.parGrid}>
            {PAR_VALUE_LADDER.map((value) => (
              <button
                key={value}
                type="button"
                style={{
                  ...styles.parCell,
                  ...(parValue === value ? styles.parCellActive : {}),
                }}
                onClick={() => onSelectParValue(value)}
                disabled={isFloated}
              >
                ${value}
              </button>
            ))}
          </div>
        </div>

        {/* Buy Share Control. */}
        <div style={styles.section}>
          <span style={styles.sectionLabel}>Buy Share</span>
          <div style={styles.sourceToggleRow}>
            {(["Ipo", "Bank"] as const).map((s) => (
              <button
                key={s}
                type="button"
                style={{ ...styles.sourceToggle, ...(source === s ? styles.sourceToggleActive : {}) }}
                onClick={() => onSelectSource(s)}
              >
                {s === "Ipo" ? "IPO Warehouse" : "Bank Pool"}
              </button>
            ))}
          </div>
          <button
            type="button"
            style={styles.actionButton}
            onClick={onBuyShare}
            disabled={controlsDisabled || !selectedCompany}
          >
            Buy 1 Share ({source === "Ipo" ? "IPO" : "Bank"}){!isFloated ? ` @ $${parValue}` : ""}
          </button>
        </div>

        {/* Sell Share Control. */}
        <div style={styles.section}>
          <span style={styles.sectionLabel}>Sell Shares</span>
          <div style={styles.sellStepperRow}>
            {SELL_PERCENTAGE_OPTIONS.map((pct) => {
              const state = sellOptionState(pct, playerHoldingPercent, bankPoolPercent);
              return (
                <button
                  key={pct}
                  type="button"
                  // `title` carries the reason on hover. Native tooltip
                  // rather than a custom one on purpose: a disabled button
                  // does not fire pointer events in every browser, so a
                  // JS-driven tooltip is unreliable here in exactly the state
                  // it is needed.
                  title={state.reason}
                  style={{
                    ...styles.sellStep,
                    ...(sellPercentage === pct ? styles.sellStepActive : {}),
                    ...(state.enabled ? {} : styles.sellStepDisabled),
                  }}
                  disabled={controlsDisabled || !selectedCompany || !state.enabled}
                  onClick={() => onSelectSellPercentage(pct)}
                >
                  {pct}%
                </button>
              );
            })}
          </div>
          {/* The reason the CURRENT selection cannot be sold, stated inline.
              The per-button tooltip only appears on hover, which a player who
              has already committed to a size will not think to do. */}
          {selectedCompany && !selectedSellState.enabled && (
            <span style={styles.sellHint}>{selectedSellState.reason}</span>
          )}
          <button
            type="button"
            style={styles.actionButton}
            onClick={onSellShares}
            disabled={controlsDisabled || !selectedCompany || !selectedSellState.enabled}
          >
            Sell {sellPercentage}% Bundle
          </button>
        </div>
      </div>

      <div style={styles.passRow}>
        <button type="button" style={styles.passButton} onClick={onPassTurn} disabled={controlsDisabled}>
          Pass Turn
        </button>
      </div>
    </div>
  );
}

export default StockRoundPanel;

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    width: "100%",
    padding: "14px 20px",
    backgroundColor: "#171b26",
    border: "1px solid #2a2e3a",
    borderRadius: "10px",
    boxSizing: "border-box",
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    fontSize: "15px",
    fontWeight: 700,
    color: "#e6e8ef",
  },
  headerHint: {
    fontSize: "12px",
    color: "#9aa0ac",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    flex: 1,
  },
  sectionInactive: {
    opacity: 0.55,
  },
  sectionLabel: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "12px",
    fontWeight: 700,
    color: "#9aa0ac",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  },
  companyPillRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
  companyPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "13px",
    fontWeight: 700,
    padding: "6px 12px",
    borderRadius: "999px",
    border: "1.5px solid",
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  floatedDot: {
    display: "inline-block",
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    backgroundColor: "currentColor",
  },
  emptyHint: {
    fontSize: "13px",
    color: "#6f7480",
  },
  floatBadge: {
    fontSize: "11px",
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: "999px",
    backgroundColor: "#2a2e3a",
    color: "#9aa0ac",
  },
  floatBadgeActive: {
    backgroundColor: "#1d4a34",
    color: "#6fdc9b",
  },
  floatBarTrack: {
    position: "relative",
    width: "100%",
    height: "10px",
    borderRadius: "999px",
    backgroundColor: "#0a0e17",
    border: "1px solid #2a2e3a",
    overflow: "hidden",
  },
  floatBarFill: {
    height: "100%",
    backgroundColor: "#3a7bd5",
  },
  floatBarThreshold: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "2px",
    backgroundColor: "#e0c341",
  },
  floatBarCaption: {
    fontSize: "12px",
    color: "#9aa0ac",
  },
  controlsRow: {
    display: "flex",
    gap: "18px",
    flexWrap: "wrap",
  },
  parGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
  parCell: {
    fontSize: "13px",
    fontWeight: 600,
    padding: "6px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1e2129",
    color: "#c7cbd4",
    cursor: "pointer",
  },
  parCellActive: {
    backgroundColor: "#2a3a52",
    borderColor: "#4a6a92",
    color: "#e6e8ef",
  },
  sourceToggleRow: {
    display: "flex",
    gap: "6px",
  },
  sourceToggle: {
    fontSize: "12px",
    fontWeight: 600,
    padding: "6px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1e2129",
    color: "#c7cbd4",
    cursor: "pointer",
  },
  sourceToggleActive: {
    backgroundColor: "#2a3a52",
    borderColor: "#4a6a92",
    color: "#e6e8ef",
  },
  sellStepperRow: {
    display: "flex",
    gap: "6px",
  },
  sellStep: {
    fontSize: "12px",
    fontWeight: 600,
    padding: "6px 10px",
    borderRadius: "6px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1e2129",
    color: "#c7cbd4",
    cursor: "pointer",
  },
  sellStepActive: {
    backgroundColor: "#4a2a2a",
    borderColor: "#924a4a",
    color: "#e6e8ef",
  },
  // F-6: an option the rules currently forbid. Dimmed and
  // not-allowed-cursored, but still RENDERED -- an absent control teaches a
  // player nothing, while a visibly disabled one carrying its reason teaches
  // them the cap exists at the moment it binds them.
  sellStepDisabled: {
    opacity: 0.38,
    cursor: "not-allowed",
    borderColor: "#2b2f3a",
  },
  sellHint: {
    fontSize: "11px",
    lineHeight: 1.4,
    color: "#c8a24a",
  },
  actionButton: {
    fontSize: "13px",
    fontWeight: 700,
    padding: "9px 14px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  passRow: {
    display: "flex",
    justifyContent: "flex-end",
    borderTop: "1px solid #2a2e3a",
    paddingTop: "10px",
  },
  passButton: {
    fontSize: "13px",
    fontWeight: 700,
    padding: "9px 18px",
    borderRadius: "8px",
    border: "1px solid #4a3f3f",
    backgroundColor: "#2c2020",
    color: "#e8c7c7",
    cursor: "pointer",
  },
};
