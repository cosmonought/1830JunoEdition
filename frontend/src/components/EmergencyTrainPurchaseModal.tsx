// frontend/src/components/EmergencyTrainPurchaseModal.tsx
//
// The president pays the difference.
//
// ===================================================================
//  DESIGN NOTE 0: THE RULE THIS SURFACE IS FOR
// ===================================================================
//
// 1830: a corporation that owns NO trains must buy one, and if its treasury
// cannot cover the cheapest train in the Bank Depot, its PRESIDENT makes up
// the shortfall out of their own pocket. If their personal cash is not
// enough either, they must sell shares until it is -- and if even that
// cannot raise the money, the corporation is bankrupt and the game ends.
//
// `App.tsx` design note #232 already enforces the first half: `mustBuyTrain`
// blocks End Turn while the roster is reported and empty. What it could not
// do is tell the president HOW MUCH of their own money the obligation is
// about to cost them, which is the entire decision. The player was left to
// subtract a treasury figure on one panel from a train price on another.
//
// ===================================================================
//  DESIGN NOTE 1: A SCAFFOLD, AND IT SAYS SO
// ===================================================================
//
// This is deliberately a SCAFFOLD, and the honest boundary runs straight
// through the middle of it. The ARITHMETIC is real and complete: the
// shortfall, the treasury contribution, the president's cash and the value
// of what they hold are all computed from live state and are correct.
//
// WHAT IS NOT WIRED is the share sale that raises the money. Selling into
// the Bank Pool during an emergency is `trading.rs`'s `SellStock` under a
// different set of rules from an ordinary Stock Round sale -- the 50% pool
// cap, the presidency transfer, and the "sell only as much as you need"
// constraint all behave differently mid-emergency -- and `ExecuteMsg` has
// no variant that says "this sale is funding a mandatory train buy".
//
// So the holdings table lists what could be sold and what it is worth, and
// its per-row control is DISABLED with a tooltip naming the missing message.
// This codebase has twice removed a button that dispatched something the
// chain would reject (`App.tsx` design notes #162 and #193), and a control
// that silently sold shares through the ordinary path -- with none of the
// emergency rules applied -- would be a third instance of the same mistake
// wearing a more convincing disguise.
//
// A DISABLED CONTROL WITH A REASON is the right shape here, where design
// note #279 removed a placeholder string outright, because these rows carry
// real information whether or not the button works: the president needs to
// see what they hold and what it is worth to know whether they can survive
// this at all. The button is the only dead part, and it admits it.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import type { GameStateResponse, PublicCompanyState } from "../utils/gameState";
import { playerCompanyHoldings } from "../utils/gameState";

/** One line of the president's sellable assets. */
export interface EmergencyHolding {
  companyId: number;
  ticker: string;
  percentage: number;
  /** Market price per 10% certificate, or `null` when the company has no
   *  price yet -- an unfloated company's shares cannot be sold at all, and
   *  a `$0` here would read as "worthless" rather than "not sellable". */
  pricePerShare: number | null;
  /** `percentage / 10 * pricePerShare`, or `null` when unpriced. */
  estimatedValue: number | null;
}

export interface EmergencyPurchasePlan {
  /** The train the corporation is obliged to buy. */
  trainModel: string;
  trainCost: number;
  corporationId: number;
  corporationTicker: string;
  /** Everything the treasury can put toward it -- capped at the price, so a
   *  treasury larger than the train never reports a negative shortfall. */
  treasuryContribution: number;
  treasury: number;
  /** What the president must find. Zero means the treasury covers it and
   *  this modal should not be open at all. */
  shortfall: number;
  presidentAddress: string | null;
  presidentLabel: string;
  presidentCash: number;
  /** Shortfall minus personal cash, floored at zero: what must be raised by
   *  selling. */
  mustRaiseBySelling: number;
  holdings: EmergencyHolding[];
  /** Total of every priced holding. */
  holdingsValue: number;
  /** Design note #2: cash plus sellable assets still cannot cover it. */
  bankrupt: boolean;
}

/* ==================================================================
 *  DESIGN NOTE 2: THE THREE OUTCOMES, DECIDED BY ARITHMETIC
 * ==================================================================
 *
 * A president in this position is in exactly one of three states, and the
 * modal has to say which without making them work it out:
 *
 *   COVERED BY CASH   personal cash >= shortfall. One payment, no sales.
 *   MUST SELL         cash is short, but cash + holdings can reach it.
 *   BANKRUPT          cash + everything they could sell still falls short.
 *
 * The third is a GAME-ENDING condition in 1830, so it is stated plainly
 * rather than implied by a disabled button. Getting told "you cannot afford
 * this" by a control that will not click is the worst version of that news.
 *
 * `bankrupt` is computed against PRICED holdings only. Shares in an
 * unfloated company have no market price and cannot be sold, so counting
 * them would let the modal report a rescue that does not exist.
 */
export function buildEmergencyPurchasePlan(args: {
  state: GameStateResponse;
  corporation: PublicCompanyState;
  trainModel: string;
  trainCost: number;
  /** Market price per 10% certificate by `company_id`. Injected because the
   *  chart lives in `StockMarketRenderer` and `utils/` must not import it --
   *  the same one-way rule `sandboxSession.ts` follows. */
  priceForCompany: (companyId: number) => number | null;
  labelForAddress: (address: string) => string;
}): EmergencyPurchasePlan {
  const { state, corporation, trainModel, trainCost, priceForCompany, labelForAddress } = args;

  const treasury = Number(corporation.treasury) || 0;
  const treasuryContribution = Math.min(Math.max(0, treasury), trainCost);
  const shortfall = Math.max(0, trainCost - treasuryContribution);

  const presidentAddress = corporation.president;
  const presidentCash = presidentAddress
    ? Number(state.player_cash.find((row) => row.player === presidentAddress)?.cash_vgp ?? 0) || 0
    : 0;

  const holdings: EmergencyHolding[] = presidentAddress
    ? playerCompanyHoldings(presidentAddress, state)
        // A president cannot sell the presidency of the company being
        // rescued out from under itself to fund its own train, and the
        // certificate limit and pool cap make the general case a contract
        // question -- so the company in trouble is listed but never counted.
        .filter((entry) => entry.company.company_id !== corporation.company_id)
        .map((entry) => {
          const pricePerShare = priceForCompany(entry.company.company_id);
          return {
            companyId: entry.company.company_id,
            ticker: entry.company.ticker,
            percentage: entry.percentage,
            pricePerShare,
            estimatedValue:
              pricePerShare === null ? null : Math.round((entry.percentage / 10) * pricePerShare),
          };
        })
    : [];

  const holdingsValue = holdings.reduce((sum, entry) => sum + (entry.estimatedValue ?? 0), 0);
  const mustRaiseBySelling = Math.max(0, shortfall - presidentCash);

  return {
    trainModel,
    trainCost,
    corporationId: corporation.company_id,
    corporationTicker: corporation.ticker,
    treasuryContribution,
    treasury,
    shortfall,
    presidentAddress,
    presidentLabel: presidentAddress ? labelForAddress(presidentAddress) : "No president",
    presidentCash,
    mustRaiseBySelling,
    holdings,
    holdingsValue,
    bankrupt: presidentCash + holdingsValue < shortfall,
  };
}

export interface EmergencyTrainPurchaseModalProps {
  plan: EmergencyPurchasePlan | null;
  /** Dismiss. Deliberately NOT a "cancel the obligation" -- see design
   *  note #3. */
  onClose: () => void;
  /** Fires the ordinary depot purchase. Enabled only when the president's
   *  cash already covers the shortfall, because that is the one path this
   *  build can complete end to end. */
  onConfirm: () => void;
  /** Design note #1: sandbox-only, and the modal says so. */
  sandbox: boolean;
}

/* ==================================================================
 *  DESIGN NOTE 3: DISMISSIBLE, BECAUSE THE OBLIGATION IS ELSEWHERE
 * ==================================================================
 *
 * The tempting design is a modal with no way out: the buy is mandatory, so
 * trapping the player expresses that. It would be wrong twice over.
 *
 * The obligation is already enforced where it belongs -- `mustBuyTrain`
 * disables End Turn, so a president who closes this cannot simply move on.
 * They can, however, look at the board, check a route, or read the depot
 * before committing their own money, and a modal that forbids that makes
 * the app worse without making the rule any more binding.
 *
 * The second reason is sharper: a trap with a disabled confirm button is a
 * DEADLOCK. In the bankrupt case there is no legal action available inside
 * this modal at all, and a player who cannot dismiss it cannot reach the
 * rest of the UI either.
 */
export function EmergencyTrainPurchaseModal({
  plan,
  onClose,
  onConfirm,
  sandbox,
}: EmergencyTrainPurchaseModalProps) {
  if (!plan) return null;

  const cashCovers = plan.presidentCash >= plan.shortfall;
  const confirmReason = plan.bankrupt
    ? `${plan.presidentLabel} cannot raise $${plan.shortfall}. In 1830 this ends the game.`
    : !cashCovers
      ? `${plan.presidentLabel} must raise $${plan.mustRaiseBySelling} more by selling shares first.`
      : !sandbox
        ? "Emergency purchases are not yet wired to the contract — see this file's design note #1."
        : null;

  return (
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label="Emergency Train Purchase">
      <div style={styles.panel}>
        <div style={styles.header}>
          <span style={styles.title}>Emergency Train Purchase</span>
          <button type="button" style={styles.closeButton} onClick={onClose} title="Close. The purchase is still required — End Turn stays disabled until a train is bought.">
            ✕
          </button>
        </div>

        <p style={styles.lede}>
          <strong>{plan.corporationTicker}</strong> owns no trains and must buy one. Its treasury
          cannot cover the cheapest train in the Bank Depot, so its President makes up the
          difference personally.
        </p>

        {/* ---- The obligation, as a ledger. ---- */}
        <div style={styles.ledger}>
          <Row label={`Mandatory purchase — ${plan.trainModel}-train`} value={plan.trainCost} emphasis />
          <Row
            label={`${plan.corporationTicker} treasury contributes`}
            value={-plan.treasuryContribution}
            hint={
              plan.treasury > plan.trainCost
                ? undefined
                : `The whole treasury: $${plan.treasury}.`
            }
          />
          <div style={styles.ledgerRule} />
          <Row label={`${plan.presidentLabel} must pay`} value={plan.shortfall} emphasis danger />
        </div>

        {/* ---- What the president has. ---- */}
        <div style={styles.section}>
          <span style={styles.sectionTitle}>President's resources</span>
          <div style={styles.ledger}>
            <Row label="Personal cash" value={plan.presidentCash} />
            <Row
              label="Sellable shares (estimated)"
              value={plan.holdingsValue}
              hint={
                plan.holdings.length === 0
                  ? "No holdings in other corporations."
                  : undefined
              }
            />
            {plan.mustRaiseBySelling > 0 && (
              <>
                <div style={styles.ledgerRule} />
                <Row label="Still to raise by selling" value={plan.mustRaiseBySelling} danger emphasis />
              </>
            )}
          </div>
        </div>

        {plan.holdings.length > 0 && (
          <div style={styles.section}>
            <span style={styles.sectionTitle}>Holdings</span>
            <div style={styles.holdingsTable}>
              {plan.holdings.map((holding) => (
                <div key={holding.companyId} style={styles.holdingRow}>
                  <span style={styles.holdingTicker}>{holding.ticker}</span>
                  <span style={styles.holdingPercent}>{holding.percentage}%</span>
                  <span style={styles.holdingValue}>
                    {holding.estimatedValue === null
                      ? "unpriced"
                      : `$${holding.estimatedValue}`}
                  </span>
                  {/* Design note #1: the one dead control, and it says why. */}
                  <button
                    type="button"
                    style={{ ...styles.sellButton, ...styles.sellButtonDisabled }}
                    disabled
                    title={
                      holding.pricePerShare === null
                        ? `${holding.ticker} has no market price yet, so its shares cannot be sold.`
                        : "Emergency share sales need a contract message that does not exist yet (ExecuteMsg has no variant marking a sale as funding a mandatory train buy). Sell through the Stock Round for now."
                    }
                  >
                    Sell
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {plan.bankrupt && (
          <p style={styles.bankruptNotice}>
            <strong>Bankruptcy.</strong> {plan.presidentLabel} holds ${plan.presidentCash} and could
            raise at most ${plan.holdingsValue} more — short of the ${plan.shortfall} required. In
            1830 this ends the game immediately.
          </p>
        )}

        <div style={styles.footer}>
          {confirmReason && <span style={styles.footerReason}>{confirmReason}</span>}
          <button
            type="button"
            style={{
              ...styles.confirmButton,
              ...(confirmReason !== null ? styles.confirmButtonDisabled : {}),
            }}
            disabled={confirmReason !== null}
            onClick={onConfirm}
            title={
              confirmReason ??
              `${plan.corporationTicker} pays $${plan.treasuryContribution} and ${plan.presidentLabel} pays $${plan.shortfall}.`
            }
          >
            Buy {plan.trainModel}-train for ${plan.trainCost}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One ledger line. Negative values render as a contribution rather than a
 *  minus sign -- "treasury contributes -$40" reads as a debt. */
function Row({
  label,
  value,
  hint,
  emphasis,
  danger,
}: {
  label: string;
  value: number;
  hint?: string;
  emphasis?: boolean;
  danger?: boolean;
}) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>
        {label}
        {hint && <span style={styles.rowHint}>{hint}</span>}
      </span>
      <span
        style={{
          ...styles.rowValue,
          ...(emphasis ? styles.rowValueEmphasis : {}),
          ...(danger ? styles.rowValueDanger : {}),
        }}
      >
        {value < 0 ? `−$${Math.abs(value)}` : `$${value}`}
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1400,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(8, 10, 14, 0.72)",
    padding: "24px",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    width: "min(520px, 100%)",
    maxHeight: "86vh",
    overflowY: "auto",
    padding: "18px 20px",
    backgroundColor: "#161922",
    border: "1px solid #3a4055",
    borderTop: "3px solid #c9a227",
    borderRadius: "10px",
    boxShadow: "0 18px 48px rgba(0,0,0,0.6)",
    boxSizing: "border-box",
  },
  header: { display: "flex", alignItems: "center", gap: "10px" },
  title: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 800,
    color: "#f0e2b8",
    flex: "1 1 auto",
  },
  closeButton: {
    flexShrink: 0,
    padding: "2px 8px",
    fontSize: FONT_SIZE.body,
    color: "#8a919e",
    backgroundColor: "transparent",
    border: "1px solid #2f3543",
    borderRadius: "6px",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  lede: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: 1.45, color: "#c8cbd6" },
  section: { display: "flex", flexDirection: "column", gap: "6px" },
  sectionTitle: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#7f8798",
  },
  ledger: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "10px 12px",
    backgroundColor: "#1b1f29",
    border: "1px solid #2a2e3a",
    borderRadius: "8px",
  },
  ledgerRule: { height: "1px", backgroundColor: "#2f3543", margin: "3px 0" },
  row: { display: "flex", alignItems: "baseline", gap: "10px" },
  rowLabel: {
    flex: "1 1 auto",
    display: "flex",
    flexDirection: "column",
    fontSize: FONT_SIZE.small,
    color: "#c8cbd6",
  },
  rowHint: { fontSize: FONT_SIZE.micro, color: "#7f8798" },
  rowValue: {
    flexShrink: 0,
    fontSize: FONT_SIZE.body,
    fontVariantNumeric: "tabular-nums",
    color: "#e6e8ef",
  },
  rowValueEmphasis: { fontWeight: 800, fontSize: FONT_SIZE.strong },
  rowValueDanger: { color: "#e8a0a0" },
  holdingsTable: {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    padding: "8px 10px",
    backgroundColor: "#1b1f29",
    border: "1px solid #2a2e3a",
    borderRadius: "8px",
  },
  holdingRow: { display: "flex", alignItems: "center", gap: "10px" },
  holdingTicker: {
    flex: "0 0 56px",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#e6e8ef",
  },
  holdingPercent: {
    flex: "0 0 44px",
    fontSize: FONT_SIZE.small,
    fontVariantNumeric: "tabular-nums",
    color: "#a8b0c0",
  },
  holdingValue: {
    flex: "1 1 auto",
    textAlign: "right",
    fontSize: FONT_SIZE.small,
    fontVariantNumeric: "tabular-nums",
    color: "#7ee0a1",
  },
  sellButton: {
    flexShrink: 0,
    padding: "3px 10px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 700,
    fontFamily: "inherit",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    cursor: "pointer",
  },
  sellButtonDisabled: {
    borderColor: "#343b48",
    backgroundColor: "#20242e",
    color: "#6f7480",
    cursor: "not-allowed",
  },
  bankruptNotice: {
    margin: 0,
    padding: "10px 12px",
    fontSize: FONT_SIZE.small,
    lineHeight: 1.45,
    color: "#f0c9c9",
    backgroundColor: "#2a1618",
    border: "1px solid #6b2f2f",
    borderRadius: "8px",
  },
  footer: { display: "flex", flexDirection: "column", gap: "6px" },
  footerReason: { fontSize: FONT_SIZE.micro, color: "#8a919e", lineHeight: 1.4 },
  confirmButton: {
    padding: "9px 14px",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    color: "#0d1117",
    backgroundColor: "#e0b062",
    border: "1px solid #c9a227",
    borderRadius: "8px",
    cursor: "pointer",
  },
  confirmButtonDisabled: {
    borderColor: "#343b48",
    backgroundColor: "#20242e",
    color: "#6f7480",
    cursor: "not-allowed",
  },
};

export default EmergencyTrainPurchaseModal;
