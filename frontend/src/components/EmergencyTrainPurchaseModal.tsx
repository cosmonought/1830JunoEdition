// The president pays the difference.
//
// 1830: a corporation owning NO trains must buy one; treasury first, then the
// president's personal cash, then forced share sales, then bankruptcy.
// `utils/endgame.ts` owns the cascade (#0) and the legality of each sale (#1);
// this renders those two IN ORDER, because the sequence is the sentence a
// president needs and cannot be recovered from a total.
//
// UNSKIPPABLE (#3): "enforced elsewhere" is not enforcement, and the deadlock in
// the bankrupt case is the rule rather than a UI failure to route around. Sale
// controls remain sandbox-only -- `ExecuteMsg` has no variant marking a sale as
// funding a mandatory buy.
//
// See docs/ai_architecture/stock_market.md, EmergencyTrainPurchaseModal.tsx
// #0 / #1 / #3.

import React from "react";

import { FONT_SIZE } from "../styles/typography";
import type { GameStateResponse, PublicCompanyState } from "../utils/gameState";
import {
  resolveEmergencyFunding,
  sellableHoldings,
  type SellableHolding,
} from "../utils/endgame";

export interface EmergencyPurchasePlan {
  /** The train the corporation is obliged to buy. */
  trainModel: string;
  trainCost: number;
  corporationId: number;
  corporationTicker: string;
  /** Stage 1 of the cascade -- `endgame.ts` design note #0. */
  treasuryContribution: number;
  treasury: number;
  /** What the president must find after the treasury is emptied. */
  shortfall: number;
  presidentAddress: string | null;
  presidentLabel: string;
  presidentCash: number;
  /** Stage 2: what their cash covers. */
  fromPlayerCash: number;
  /** Stage 3: what must still be raised by selling. */
  mustRaiseBySelling: number;
  holdings: SellableHolding[];
  /** The ceiling those sales could reach. */
  maxSaleProceeds: number;
  /** Design note #2 in `endgame.ts`: cash plus sellable assets still cannot
   *  cover it, so the game ends. */
  bankrupt: boolean;
}

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

  const presidentAddress = corporation.president;
  const presidentCash = presidentAddress
    ? Number(state.player_cash.find((row) => row.player === presidentAddress)?.cash_vgp ?? 0) || 0
    : 0;

  /* The corporation being rescued is excluded from its own rescue: its
     president cannot sell its shares to fund its train, and the presidency
     question makes the general case a contract matter. */
  const holdings = presidentAddress
    ? sellableHoldings(state, presidentAddress, priceForCompany, corporation.company_id)
    : [];

  const funding = resolveEmergencyFunding({
    trainCost,
    treasury: Number(corporation.treasury) || 0,
    playerCash: presidentCash,
    holdings,
  });

  return {
    trainModel,
    trainCost,
    corporationId: corporation.company_id,
    corporationTicker: corporation.ticker,
    treasuryContribution: funding.fromTreasury,
    treasury: Number(corporation.treasury) || 0,
    shortfall: trainCost - funding.fromTreasury,
    presidentAddress,
    presidentLabel: presidentAddress ? labelForAddress(presidentAddress) : "No president",
    presidentCash,
    fromPlayerCash: funding.fromPlayerCash,
    mustRaiseBySelling: funding.mustRaiseBySelling,
    holdings: funding.holdings,
    maxSaleProceeds: funding.maxSaleProceeds,
    bankrupt: funding.bankrupt,
  };
}

export interface EmergencyTrainPurchaseModalProps {
  plan: EmergencyPurchasePlan | null;
  /** Design note #3: there is no `onClose`. The modal is unskippable.
   *  Sells the legal block for one company, in sandbox. */
  onSellShares?: (companyId: number, percentage: number) => void;
  /** Fires the ordinary depot purchase. Enabled only when the president's
   *  cash already covers the shortfall, because that is the one path this
   *  build can complete end to end. */
  onConfirm: () => void;
  /** Design note #1: sandbox-only, and the modal says so. */
  sandbox: boolean;
}

export function EmergencyTrainPurchaseModal({
  plan,
  onSellShares,
  onConfirm,
  sandbox,
}: EmergencyTrainPurchaseModalProps) {
  if (!plan) return null;

  const confirmReason = plan.bankrupt
    ? `${plan.presidentLabel} cannot raise $${plan.trainCost}. In Project 18XX this ends the game.`
    : plan.mustRaiseBySelling > 0
      ? `${plan.presidentLabel} must raise $${plan.mustRaiseBySelling} more by selling shares first.`
      : !sandbox
        ? "Emergency purchases are not yet wired to the contract — see this file's design note #1."
        : null;

  return (
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label="Emergency Train Purchase">
      <div style={styles.panel}>
        {/* Design note #3: no close control. The header is a title, not a
            title bar -- there is nothing here to dismiss to. */}
        <div style={styles.header}>
          <span style={styles.title}>Emergency Train Purchase</span>
          <span style={styles.mandatoryTag}>Mandatory</span>
        </div>

        <p style={styles.lede}>
          <strong>{plan.corporationTicker}</strong> owns no trains and must buy one. Its treasury
          cannot cover the cheapest train in the Bank Depot, so the shortfall is funded in order:
          the company&#39;s entire treasury, then its President&#39;s cash, then forced share sales.
        </p>

        {/* ---- The cascade, in its three stages. ---- */}
        <div style={styles.ledger}>
          <Row label={`Mandatory purchase — ${plan.trainModel}-train`} value={plan.trainCost} emphasis />
          <Row
            label={`1. ${plan.corporationTicker} treasury`}
            value={-plan.treasuryContribution}
            hint={
              plan.treasury > plan.trainCost ? undefined : `The whole treasury: $${plan.treasury}.`
            }
          />
          <Row
            label={`2. ${plan.presidentLabel}'s personal cash`}
            value={-plan.fromPlayerCash}
            hint={
              plan.fromPlayerCash < plan.presidentCash
                ? `Of $${plan.presidentCash} held.`
                : plan.presidentCash > 0
                  ? "Their entire balance."
                  : undefined
            }
          />
          <div style={styles.ledgerRule} />
          <Row
            label="3. Must be raised by selling shares"
            value={plan.mustRaiseBySelling}
            emphasis
            danger={plan.mustRaiseBySelling > 0}
          />
        </div>

        {/* ---- The legal sale set. ---- */}
        {plan.mustRaiseBySelling > 0 && (
          <div style={styles.section}>
            <span style={styles.sectionTitle}>
              Shares {plan.presidentLabel} may sell
            </span>
            {plan.holdings.length === 0 ? (
              <p style={styles.emptyHoldings}>
                {plan.presidentLabel} holds no shares in any other corporation.
              </p>
            ) : (
              <div style={styles.holdingsTable}>
                {plan.holdings.map((holding) => (
                  <div key={holding.companyId} style={styles.holdingRow}>
                    <span style={styles.holdingTicker}>{holding.ticker}</span>
                    <span style={styles.holdingPercent}>
                      {holding.sellablePercent}%
                      {holding.sellablePercent < holding.heldPercent && (
                        <span style={styles.holdingHeld}> of {holding.heldPercent}%</span>
                      )}
                      {/* Design note #6 in `endgame.ts`: dumping a
                          presidency is a far bigger decision than selling a
                          share, so the row says so on its face rather than
                          only in the tooltip. */}
                      {holding.sellsPresidency && (
                        <span style={styles.holdingPresidency}>PRES</span>
                      )}
                    </span>
                    <span style={styles.holdingValue}>
                      {holding.pricePerShare === null ? "unpriced" : `$${holding.proceeds}`}
                    </span>
                    <button
                      type="button"
                      style={{
                        ...styles.sellButton,
                        ...(sandbox && holding.sellableCertificates > 0
                          ? styles.sellButtonLive
                          : styles.sellButtonDisabled),
                      }}
                      disabled={!sandbox || holding.sellableCertificates === 0}
                      onClick={() =>
                        onSellShares?.(holding.companyId, holding.sellablePercent)
                      }
                      title={
                        holding.restriction ??
                        (sandbox
                          ? `Sell ${holding.sellableCertificates} certificate${holding.sellableCertificates === 1 ? "" : "s"} of ${holding.ticker} for $${holding.proceeds}.`
                          : "Emergency share sales need a contract message that does not exist yet (ExecuteMsg has no variant marking a sale as funding a mandatory train buy).")
                      }
                    >
                      Sell {holding.sellableCertificates || ""}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Design note #1 in `endgame.ts`: the two restrictions, stated
                once under the table rather than repeated on every row that
                happens to hit one. */}
            <span style={styles.restrictionNote}>
              A President&#39;s Certificate may only be sold when another player already holds 20%
              of that corporation and the Bank Pool has room for the whole 20% block. No
              corporation may hold more than 50% of its shares in the Bank Pool.
            </span>
          </div>
        )}

        {plan.bankrupt && (
          <p style={styles.bankruptNotice}>
            <strong>Bankruptcy.</strong> Every legal source is exhausted: $
            {plan.treasuryContribution} from the treasury, ${plan.presidentCash} in cash and at most
            ${plan.maxSaleProceeds} from sellable shares — short of the ${plan.trainCost} required.
            In Project 18XX this ends the game immediately.
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
  /* Design note #3: the badge replaces the close control -- the corner that
     used to offer an exit now states that there is not one. */
  mandatoryTag: {
    marginLeft: "auto",
    flexShrink: 0,
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#f0c9c9",
    border: "1px solid #6b2f2f",
    backgroundColor: "#2a1618",
    borderRadius: "999px",
    padding: "2px 9px",
  },
  emptyHoldings: { margin: 0, fontSize: FONT_SIZE.small, color: "#8a919e" },
  holdingHeld: { color: "#6f7480", fontWeight: 400 },
  /* Design note #6: amber, not red. Selling the presidency is legal and
     sometimes correct -- it is consequential, not wrong. */
  holdingPresidency: {
    marginLeft: "5px",
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.06em",
    color: "#e0b062",
    border: "1px solid #6b5a1f",
    borderRadius: "4px",
    padding: "0 4px",
  },
  restrictionNote: {
    fontSize: FONT_SIZE.micro,
    color: "#7f8798",
    lineHeight: 1.45,
  },
  title: {
    fontSize: FONT_SIZE.heading,
    fontWeight: 800,
    color: "#f0e2b8",
    flex: "1 1 auto",
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
  /* Design note #1: live in sandbox, where the sale has somewhere to go. */
  sellButtonLive: {
    borderColor: "#2f7d55",
    backgroundColor: "#1d5c40",
    color: "#eafff2",
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
