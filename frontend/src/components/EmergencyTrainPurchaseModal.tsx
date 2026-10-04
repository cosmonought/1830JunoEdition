// The forced train purchase, guided -- for the obligated president only.
//
// 1830 (rulebook 6.6.2 / 6.6.3 / 6.7): a corporation with a route and no train must buy one. It may buy from another
// railroad; otherwise it buys the cheapest train the bank sells, spending its whole treasury, its president covering
// the difference from personal cash, and selling shares (and optionally private companies) for what is still short.
// `gameEngine/emergencyFunding.ts` owns every figure and every legality; this file renders them in the order a
// president meets them.
//
// ==================================================================
//  PHASE 3 W2-G: THE OWNER'S RULING (OD-4), AND WHAT IT REPLACED
// ==================================================================
// NON-DISMISSIBLE. The surface opens itself for the obligated president and cannot be closed or escaped
// (`dismissible={false}` -> `closedby="none"`, #1651); the authoritative hold (`emergencyFundingBlock`) stands
// until the purchase is made or the game ends. #751 had made it a button-opened modal so that a rival's train
// stayed reachable on another panel -- and once opened, that panel was unreachable (A-9). The ruling keeps the
// rival's train reachable by making it the FIRST STEP of this surface instead.
//
// THE SEQUENCE: (1) buy from another corporation -- the authority's legal candidates, an offer the seller answers
// (or a direct buy when one president sits over both), and its withdrawal; (2) Skip, after a consequence warning,
// prominent whenever the authority already establishes that no share sale can fund the Bank purchase; (3) the
// Bank / Bank Pool purchase, with the treasury and the president's cash applied AUTOMATICALLY and shown as figures;
// (4) legal share sales, one actual sale at a time, re-read after each; (5) the optional private sale.
//
// NO BANKRUPTCY BUTTON. Bankruptcy is the authority's result (`settleBankruptcy`), not a player's decision. The
// player-facing "Declare bankruptcy" control is gone; the `DeclareBankruptcy` message and its authority stay for
// compatibility until the v13 rules batch decides the transition (see the W2-G report).
//
// VIEWER SCOPE (OD-1): this component is mounted only for the obligated president's own screen. Every other seat
// and every watcher sees `EmergencyPurchaseWaitingCard` -- one read-only sentence, no controls.
//
// LATCH. Every control is greyed while a send is in flight (the shell's `actionInFlight`) and, inside this
// component, from the press until the board answers -- so a double click cannot send twice.

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { ACTION_GREEN, ACTION_GREEN_BORDER, ACTION_GREEN_INK } from "../styles/palette";
import type { EmergencyFunding, LegalForcedSale, LegalPrivateSale } from "../gameEngine/emergencyFunding";
import type { PrivatePurchaseOffer } from "../gameEngine/gameState";
import { SHARE_BLOCK_PERCENT } from "../gameEngine/endgame";
import {
  skipConsequenceFor,
  trainSourceName,
  type IntercorporateOption,
  type IntercorporateStep,
  type SkipConsequence,
} from "../utils/emergencyPurchaseView";
import { NativeModal } from "./NativeModal";

export interface EmergencyPurchasePlan {
  /** The train the corporation is obliged to buy: the cheapest the bank sells. */
  trainModel: string;
  trainCost: number;
  /** K-25: where that train actually is -- "Bank Pool" or "Bank Depot". */
  trainSourceName: "Bank Pool" | "Bank Depot";
  corporationId: number;
  corporationTicker: string;
  /** The whole treasury, applied automatically (6.6.2: "All of the railroad's money must be spent"). */
  treasury: number;
  presidentAddress: string;
  presidentLabel: string;
  presidentCash: number;
  /** The president's cash applied automatically: the difference the treasury leaves, up to what they hold. */
  fromPlayerCash: number;
  /** What legal sales must still raise -- the authority's `shortfall`. Zero: the purchase can and must be made. */
  mustRaiseBySelling: number;
  /** The authority's legal forced sales, bundle by bundle, on the current board. */
  sales: LegalForcedSale[];
  /** #1541: the privates the president may offer, each with its band and the corporations that could buy. */
  privateSales: LegalPrivateSale[];
  /** #1541: the offer awaiting the buying president's answer, if one stands. */
  privateOffer: PrivatePurchaseOffer | null;
  /** The label of the president who must answer `privateOffer`. */
  privateOfferBuyerPresidentLabel: string | null;
  /** The authority's derived bankruptcy (the reducer ends the game in the same transition, so this is defensive). */
  bankrupt: boolean;
  /** What skipping the intercorporate opportunity commits the president to. */
  skipConsequence: SkipConsequence;
}

/* ==================================================================
    DESIGN NOTE 1540: THE PLAN IS THE AUTHORITY'S OBLIGATION, RENDERED
   ==================================================================
   The reducer derives the obligation (`emergencyFundingFor`) after every real action; this function only shapes it
   for the surface. Nothing is summed into a ceiling and nothing is decided here. */
export function buildEmergencyPurchasePlan(args: {
  funding: EmergencyFunding;
  labelForAddress: (address: string) => string;
  /** The BUYING corporation's current president, when a funding offer stands -- read off the board by the caller. */
  privateOfferBuyerPresident?: string | null;
}): EmergencyPurchasePlan {
  const { funding, labelForAddress } = args;
  const presidentLabel = labelForAddress(funding.president);
  const buyerPresident = funding.privateOffer === null ? null : args.privateOfferBuyerPresident ?? null;
  return {
    trainModel: funding.train.tier,
    trainCost: funding.train.cost,
    trainSourceName: trainSourceName(funding.train.source),
    corporationId: funding.companyId,
    corporationTicker: funding.ticker,
    treasury: funding.treasury,
    presidentAddress: funding.president,
    presidentLabel,
    presidentCash: funding.presidentCash,
    fromPlayerCash: Math.min(funding.presidentCash, Math.max(0, funding.train.cost - funding.treasury)),
    mustRaiseBySelling: funding.shortfall,
    sales: funding.legalSales,
    privateSales: funding.legalPrivateSales,
    privateOffer: funding.privateOffer,
    privateOfferBuyerPresidentLabel: buyerPresident === null ? null : labelForAddress(buyerPresident),
    bankrupt: funding.bankrupt,
    skipConsequence: skipConsequenceFor(funding, presidentLabel),
  };
}

export interface EmergencyTrainPurchaseModalProps {
  plan: EmergencyPurchasePlan | null;
  /** Rooms (and the offline table) can complete the flow; the contract path has no emergency message. */
  sandbox: boolean;
  /** The shell's latch: a send is in flight. */
  actionInFlight?: boolean;
  /** Step 1: the authority's view of buying from another corporation. `null` hides the step. */
  intercorporate: IntercorporateStep | null;
  /** The authority's verdict on one composed intercorporate offer, or `null`. */
  intercorporateOfferRefusal: (draft: { sellerId: number; model: string; gilded?: boolean; price: string }) => string | null;
  onProposeTrade: (option: IntercorporateOption, price: string) => void;
  onRescindTrade: (sellerId: number) => void;
  /** One `SellStock` -- one actual sale; the plan is re-read before the next. */
  onSellShares: (companyId: number, percentage: number) => void;
  /** `fundingPrivateOfferRefusal` for one composed private offer, or `null`. */
  privateOfferRefusal: (draft: { privateId: number; buyerId: number | null; price: string }) => string | null;
  onOfferPrivate: (privateId: number, buyerProtocolId: number, price: number) => void;
  onRescindPrivateOffer: (privateId: number) => void;
  /** When the obligated president also presides over the BUYING corporation, the answer is theirs and must be
   *  offered here -- this surface covers the ordinary prompt. `null` refusal = this viewer answers. */
  fundingAnswerRefusal?: string | null;
  onAnswerFundingOffer?: (privateId: number, accept: boolean) => void;
  /** `EmergencyBuyHardware`: the Bank / Bank Pool purchase, once funded. */
  onConfirm: () => void;
  /** The authority's `emergencyPurchaseRefusal` for this viewer, or `null` when the purchase may be made now. */
  purchaseRefusal: string | null;
  /** Renders a seat id as a readable name. */
  labelForAddress: (address: string) => string;
}

/** A signature of everything the board could change in answer to a press. When it changes, the press was answered
 *  and the latch is released. */
function boardSignature(plan: EmergencyPurchasePlan, intercorporate: IntercorporateStep | null): string {
  return JSON.stringify([
    plan.treasury,
    plan.presidentCash,
    plan.mustRaiseBySelling,
    plan.sales.map((sale) => [sale.companyId, sale.heldPercent, sale.pricePerShare, sale.bundles]),
    plan.privateSales.map((sale) => sale.privateId),
    plan.privateOffer?.private_id ?? null,
    intercorporate?.standingOffer ? [intercorporate.standingOffer.seller_protocol_id, intercorporate.standingOffer.price, intercorporate.standingOffer.accepted ?? false] : null,
  ]);
}

/** The backstop: a press the board never answered (a refusal that changed nothing) releases after this long. */
const PRESS_LATCH_BACKSTOP_MS = 4000;

function usePressLatch(signature: string, actionInFlight: boolean): [boolean, (send: () => void) => void] {
  const pressedRef = React.useRef(false);
  const [pressed, setPressed] = React.useState(false);
  const sawFlightRef = React.useRef(false);
  const release = React.useCallback(() => {
    pressedRef.current = false;
    sawFlightRef.current = false;
    setPressed(false);
  }, []);
  // Answered: the board moved.
  React.useEffect(() => {
    release();
  }, [signature, release]);
  // Answered: the shell's send completed (true -> false), whether or not the board moved.
  React.useEffect(() => {
    if (actionInFlight) sawFlightRef.current = true;
    else if (sawFlightRef.current) release();
  }, [actionInFlight, release]);
  React.useEffect(() => {
    if (!pressed) return undefined;
    const timer = window.setTimeout(release, PRESS_LATCH_BACKSTOP_MS);
    return () => window.clearTimeout(timer);
  }, [pressed, release]);
  const press = React.useCallback((send: () => void) => {
    if (pressedRef.current) return;
    pressedRef.current = true;
    setPressed(true);
    send();
  }, []);
  return [pressed, press];
}

const SEND_IN_FLIGHT = "Sending your last action — one moment.";

export function EmergencyTrainPurchaseModal({
  plan,
  sandbox,
  actionInFlight = false,
  intercorporate,
  intercorporateOfferRefusal,
  onProposeTrade,
  onRescindTrade,
  onSellShares,
  privateOfferRefusal,
  onOfferPrivate,
  onRescindPrivateOffer,
  fundingAnswerRefusal = "Not your answer.",
  onAnswerFundingOffer,
  onConfirm,
  labelForAddress,
  purchaseRefusal,
}: EmergencyTrainPurchaseModalProps) {
  /* Draft state only -- intentions not yet sent (#400: the reducer settles, the shell narrates). */
  const [tradeKey, setTradeKey] = React.useState<string | null>(null);
  const [tradePrice, setTradePrice] = React.useState("");
  const [skipped, setSkipped] = React.useState(false);
  const [confirmingSkip, setConfirmingSkip] = React.useState(false);
  const [saleChoice, setSaleChoice] = React.useState<Record<number, number>>({});
  const [privateDrafts, setPrivateDrafts] = React.useState<Record<number, { buyer: number | null; price: string }>>({});

  const signature = plan ? boardSignature(plan, intercorporate) : "";
  const [pressed, press] = usePressLatch(signature, actionInFlight);
  /* A sale's choice belongs to the board it was made on; a new board (any sale settled) clears it. */
  React.useEffect(() => {
    setSaleChoice({});
  }, [signature]);

  /* AFTER the hooks, never before (rules of hooks). */
  if (!plan) return null;

  const latched = pressed || actionInFlight;
  const blocked: string | null = !sandbox
    ? "The emergency purchase is available only at a hosted table."
    : latched
      ? SEND_IN_FLIGHT
      : null;

  const standingTrade = intercorporate?.standingOffer ?? null;
  const legalTrades = intercorporate?.legal ?? [];
  /* Step 1 shows while an offer of ours stands (it must be answered or withdrawn), or until the president skips it,
     as long as the authority admits at least one candidate -- and never while a private offer freezes the board. */
  const showTradeStep =
    plan.privateOffer === null && (standingTrade !== null || (!skipped && legalTrades.length > 0));

  return (
    <NativeModal
      name="Emergency Train Purchase"
      /* #1651 / W2-G (OD-4): A FORCED SURFACE. `closedby="none"` refuses Escape outright; there is no scrim click and
         no close control. `restoreOpener={false}`: nothing opened it -- it opens itself. */
      dismissible={false}
      restoreOpener={false}
      scrimStyle={styles.backdrop}
    >
      <div style={styles.panel}>
        <div style={styles.header}>
          <span style={styles.title}>Emergency Train Purchase</span>
          <span style={styles.mandatoryTag}>Mandatory</span>
        </div>

        <p style={styles.lede}>
          <strong>{plan.corporationTicker}</strong> owns no train and must buy one. Its treasury (${plan.treasury})
          cannot pay for the cheapest train for sale: a {plan.trainModel}-train at ${plan.trainCost} in the{" "}
          {plan.trainSourceName}. This stays open until the train is bought or the game ends.
        </p>

        <ol style={styles.steps} aria-label="Emergency purchase steps">
          <li style={showTradeStep ? styles.stepCurrent : styles.stepDone}>Another corporation</li>
          <li style={showTradeStep ? styles.stepLater : styles.stepCurrent}>{plan.trainSourceName}</li>
        </ol>

        {showTradeStep && intercorporate ? (
          <TradeStep
            plan={plan}
            step={intercorporate}
            blocked={blocked}
            tradeKey={tradeKey}
            tradePrice={tradePrice}
            setTradeKey={setTradeKey}
            setTradePrice={setTradePrice}
            refusalFor={intercorporateOfferRefusal}
            confirmingSkip={confirmingSkip}
            setConfirmingSkip={setConfirmingSkip}
            onSkip={() => {
              setConfirmingSkip(false);
              setSkipped(true);
            }}
            onPropose={(option, price) => press(() => onProposeTrade(option, price))}
            onRescind={(sellerId) => press(() => onRescindTrade(sellerId))}
            labelForAddress={labelForAddress}
          />
        ) : (
          <BankStep
            plan={plan}
            tradeNote={
              intercorporate && intercorporate.legal.length === 0 && plan.privateOffer === null
                ? noTradeNote(intercorporate)
                : null
            }
            blocked={blocked}
            saleChoice={saleChoice}
            setSaleChoice={setSaleChoice}
            privateDrafts={privateDrafts}
            setPrivateDrafts={setPrivateDrafts}
            privateOfferRefusal={privateOfferRefusal}
            fundingAnswerRefusal={fundingAnswerRefusal}
            onSell={(companyId, percentage) => press(() => onSellShares(companyId, percentage))}
            onOffer={(privateId, buyer, price) => press(() => onOfferPrivate(privateId, buyer, price))}
            onRescindPrivate={(privateId) => press(() => onRescindPrivateOffer(privateId))}
            onAnswer={
              onAnswerFundingOffer ? (privateId, accept) => press(() => onAnswerFundingOffer(privateId, accept)) : undefined
            }
            onBuy={() => press(onConfirm)}
            purchaseRefusal={purchaseRefusal}
          />
        )}
      </div>
    </NativeModal>
  );
}

/** One sentence saying why step 1 was passed over, from the authority's refusals. */
function noTradeNote(step: IntercorporateStep): string {
  if (step.options.length === 0) return "No other corporation owns a train, so the train must come from the Bank.";
  return "No train can be bought from another corporation right now.";
}

/* ------------------------------------------------------------------ */
/* Step 1: another corporation                                           */
/* ------------------------------------------------------------------ */

function TradeStep({
  plan,
  step,
  blocked,
  tradeKey,
  tradePrice,
  setTradeKey,
  setTradePrice,
  refusalFor,
  confirmingSkip,
  setConfirmingSkip,
  onSkip,
  onPropose,
  onRescind,
  labelForAddress,
}: {
  plan: EmergencyPurchasePlan;
  step: IntercorporateStep;
  labelForAddress: (address: string) => string;
  blocked: string | null;
  tradeKey: string | null;
  tradePrice: string;
  setTradeKey: (key: string) => void;
  setTradePrice: (price: string) => void;
  refusalFor: EmergencyTrainPurchaseModalProps["intercorporateOfferRefusal"];
  confirmingSkip: boolean;
  setConfirmingSkip: (value: boolean) => void;
  onSkip: () => void;
  onPropose: (option: IntercorporateOption, price: string) => void;
  onRescind: (sellerId: number) => void;
}) {
  const standing = step.standingOffer;
  if (standing) {
    const answerer = step.standingOfferAnswerer === null ? `${standing.seller_ticker}'s president` : labelForAddress(step.standingOfferAnswerer);
    return (
      <section style={styles.section} aria-label="Offer to another corporation">
        <span style={styles.sectionTitle}>Buy from another corporation</span>
        <p style={styles.body}>
          {plan.corporationTicker} offered <strong>${standing.price}</strong> for {standing.seller_ticker}&#39;s{" "}
          {standing.model_type}-train.{" "}
          {standing.accepted
            ? "The offer was accepted and is being settled."
            : `Waiting on ${answerer} to answer.`}
        </p>
        <div style={styles.actions}>
          <button
            type="button"
            style={{ ...styles.secondaryButton, ...(blocked || step.rescindRefusal ? styles.buttonDisabled : {}) }}
            disabled={blocked !== null || step.rescindRefusal !== null}
            title={blocked ?? step.rescindRefusal ?? "Withdraw the offer and return to your options."}
            onClick={() => onRescind(standing.seller_protocol_id)}
          >
            Withdraw offer
          </button>
        </div>
        <p style={styles.note}>The Bank purchase is available once this offer is answered or withdrawn.</p>
      </section>
    );
  }

  const chosen = step.legal.find((option) => option.key === tradeKey) ?? step.legal[0] ?? null;
  const refusal = chosen === null ? "Choose a train." : refusalFor({ sellerId: chosen.sellerId, model: chosen.model, gilded: chosen.gilded, price: tradePrice });
  const direct = chosen !== null && chosen.sellerPresident === plan.presidentAddress;
  const unavailable = step.options.filter((option) => option.refusal !== null);

  return (
    <section style={styles.section} aria-label="Buy from another corporation">
      <span style={styles.sectionTitle}>Step 1 — Buy from another corporation</span>
      <p style={styles.body}>
        {plan.corporationTicker} may buy one of these trains instead. Without selling anything it can put{" "}
        <strong>${step.treasury}</strong> from its treasury and <strong>${step.presidentCash}</strong> of{" "}
        {plan.presidentLabel}&#39;s cash toward the price. The selling corporation&#39;s president must agree.
      </p>
      <div style={styles.table}>
        <div style={styles.formRow}>
          <select
            style={styles.select}
            aria-label="Train to buy from another corporation"
            value={chosen?.key ?? ""}
            onChange={(event) => setTradeKey(event.target.value)}
          >
            {step.legal.map((option) => (
              <option key={option.key} value={option.key}>
                {option.sellerTicker} — {option.model}-train
                {option.faceValue !== null ? ` (face $${option.faceValue})` : ""}
                {option.bloodPrice ? " — gold-trimmed: the Blood Price" : ""}
              </option>
            ))}
          </select>
          <input
            style={styles.priceInput}
            type="text"
            inputMode="numeric"
            aria-label="Price offered"
            placeholder="Price"
            value={tradePrice}
            onChange={(event) => setTradePrice(event.target.value)}
          />
          <button
            type="button"
            style={{ ...styles.primaryButton, ...(blocked || refusal ? styles.buttonDisabled : {}) }}
            disabled={blocked !== null || refusal !== null}
            title={blocked ?? refusal ?? undefined}
            onClick={() => chosen && onPropose(chosen, tradePrice.trim())}
          >
            {direct ? `Buy for $${tradePrice.trim() || "…"}` : `Offer $${tradePrice.trim() || "…"}`}
          </button>
        </div>
        {(blocked ?? refusal) && <span style={styles.reason}>{blocked ?? refusal}</span>}
      </div>
      {unavailable.length > 0 && (
        <details style={styles.details}>
          <summary style={styles.note}>
            Trains that cannot be bought now ({unavailable.length}) — each judged at the lowest price, $1
          </summary>
          <ul style={styles.unavailableList}>
            {unavailable.map((option) => (
              <li key={option.key} style={styles.note}>
                {option.sellerTicker} {option.model}-train — {option.refusal}
              </li>
            ))}
          </ul>
        </details>
      )}

      {!confirmingSkip ? (
        <div style={styles.actions}>
          <button
            type="button"
            style={styles.secondaryButton}
            onClick={() => setConfirmingSkip(true)}
          >
            Skip — buy from the {plan.trainSourceName}
          </button>
        </div>
      ) : (
        <div
          role="alert"
          style={plan.skipConsequence.severity === "prominent" ? styles.warningProminent : styles.warningNotice}
        >
          <strong style={styles.warningTitle}>
            {plan.skipConsequence.severity === "prominent" ? "Warning: this risks bankruptcy" : "Before you skip"}
          </strong>
          <span>{plan.skipConsequence.text}</span>
          <div style={styles.actions}>
            <button type="button" style={styles.secondaryButton} onClick={() => setConfirmingSkip(false)}>
              Back
            </button>
            <button type="button" style={styles.primaryButton} onClick={onSkip}>
              Skip and continue
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2: the Bank / Bank Pool purchase                                 */
/* ------------------------------------------------------------------ */

function BankStep({
  plan,
  tradeNote,
  blocked,
  saleChoice,
  setSaleChoice,
  privateDrafts,
  setPrivateDrafts,
  privateOfferRefusal,
  fundingAnswerRefusal,
  onSell,
  onOffer,
  onRescindPrivate,
  onAnswer,
  onBuy,
  purchaseRefusal,
}: {
  plan: EmergencyPurchasePlan;
  purchaseRefusal: string | null;
  tradeNote: string | null;
  blocked: string | null;
  saleChoice: Record<number, number>;
  setSaleChoice: React.Dispatch<React.SetStateAction<Record<number, number>>>;
  privateDrafts: Record<number, { buyer: number | null; price: string }>;
  setPrivateDrafts: React.Dispatch<React.SetStateAction<Record<number, { buyer: number | null; price: string }>>>;
  privateOfferRefusal: EmergencyTrainPurchaseModalProps["privateOfferRefusal"];
  fundingAnswerRefusal: string | null;
  onSell: (companyId: number, percentage: number) => void;
  onOffer: (privateId: number, buyer: number, price: number) => void;
  onRescindPrivate: (privateId: number) => void;
  onAnswer?: (privateId: number, accept: boolean) => void;
  onBuy: () => void;
}) {
  const short = plan.mustRaiseBySelling;
  const offer = plan.privateOffer;
  /* The purchase's legality is the authority's (`emergencyPurchaseRefusal`); only the latch is added here. */
  const buyReason = plan.bankrupt ? null : blocked ?? purchaseRefusal;

  return (
    <section style={styles.section} aria-label={`Buy from the ${plan.trainSourceName}`}>
      <span style={styles.sectionTitle}>Buy from the {plan.trainSourceName}</span>
      {tradeNote && <p style={styles.note}>{tradeNote}</p>}

      {/* The cascade, automatic: the player never types these. */}
      <div style={styles.ledger}>
        <Row label={`${plan.trainModel}-train from the ${plan.trainSourceName}`} value={plan.trainCost} emphasis />
        <Row label={`${plan.corporationTicker} treasury — all of it`} hint="Applied automatically." value={-plan.treasury} />
        <Row
          label={`${plan.presidentLabel}'s cash`}
          hint={
            plan.fromPlayerCash < plan.presidentCash
              ? `Applied automatically, of $${plan.presidentCash} held.`
              : plan.presidentCash > 0
                ? "Applied automatically — their whole balance."
                : "They hold no cash."
          }
          value={-plan.fromPlayerCash}
        />
        <div style={styles.ledgerRule} />
        <Row label="Still to raise by selling" value={short} emphasis danger={short > 0} />
      </div>

      {plan.bankrupt && (
        <p style={styles.bankruptNotice} role="status">
          <strong>Bankruptcy.</strong> {plan.presidentLabel} cannot raise ${plan.trainCost} by any legal sale. The game
          ends.
        </p>
      )}

      {/* Shares: the president chooses, one actual sale at a time. */}
      {!plan.bankrupt && short > 0 && offer === null && (
        <div style={styles.subsection}>
          <span style={styles.sectionTitle}>Sell shares — your choice</span>
          {plan.sales.length === 0 ? (
            <p style={styles.note}>No share you hold can legally be sold right now.</p>
          ) : (
            <div style={styles.table}>
              {plan.sales.map((sale) => {
                const choice = saleChoice[sale.companyId] ?? sale.bundles[0];
                const certificates = choice / SHARE_BLOCK_PERCENT;
                const proceeds = certificates * sale.pricePerShare;
                const cashAfter = plan.presidentCash + proceeds;
                return (
                  <div key={sale.companyId} style={styles.saleBlock}>
                    <div style={styles.formRow}>
                      <span style={styles.ticker}>{sale.ticker}</span>
                      <span style={styles.meta}>
                        you hold {sale.heldPercent}% · ${sale.pricePerShare}/share · up to $
                        {(sale.maxPercent / SHARE_BLOCK_PERCENT) * sale.pricePerShare} now
                      </span>
                      <select
                        style={styles.select}
                        aria-label={`Certificates of ${sale.ticker} to sell`}
                        value={choice}
                        onChange={(event) =>
                          setSaleChoice((prev) => ({ ...prev, [sale.companyId]: Number(event.target.value) }))
                        }
                      >
                        {sale.bundles.map((bundle) => (
                          <option key={bundle} value={bundle}>
                            {bundle}% · ${(bundle / SHARE_BLOCK_PERCENT) * sale.pricePerShare}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        style={{ ...styles.primaryButton, ...(blocked ? styles.buttonDisabled : {}) }}
                        disabled={blocked !== null}
                        title={blocked ?? `Sell ${choice}% of ${sale.ticker} for $${proceeds}.`}
                        onClick={() => onSell(sale.companyId, choice)}
                      >
                        Sell
                      </button>
                    </div>
                    <span style={styles.projection}>
                      Your cash ${plan.presidentCash} &rarr; <strong style={styles.cashAfter}>${cashAfter}</strong>
                      {proceeds < short ? (
                        <span style={styles.stillShort}> — still ${short - proceeds} short</span>
                      ) : (
                        <span style={styles.covers}> — covers the ${short} needed</span>
                      )}
                    </span>
                    {sale.restriction && <span style={styles.note}>Not every bundle is allowed: {sale.restriction}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* #1541: the optional private sale. */}
      {!plan.bankrupt && short > 0 && offer === null && plan.privateSales.length > 0 && (
        <div style={styles.subsection}>
          <span style={styles.sectionTitle}>Offer a private company — optional</span>
          <p style={styles.note}>
            Another corporation may buy a private company you own; its president must accept. You are never required
            to offer one.
          </p>
          <div style={styles.table}>
            {plan.privateSales.map((sale) => {
              const draft = privateDrafts[sale.privateId] ?? { buyer: sale.buyers[0]?.companyId ?? null, price: String(sale.minPrice) };
              const refusal = privateOfferRefusal({ privateId: sale.privateId, buyerId: draft.buyer, price: draft.price });
              const reason = blocked ?? refusal;
              const buyer = sale.buyers.find((entry) => entry.companyId === draft.buyer) ?? null;
              return (
                <div key={sale.privateId} style={styles.saleBlock}>
                  <div style={styles.formRow}>
                    <span style={styles.ticker}>{sale.name}</span>
                    <span style={styles.meta}>
                      face ${sale.faceValue} · ${sale.minPrice}–${sale.maxPrice}
                    </span>
                    <select
                      style={styles.select}
                      value={draft.buyer ?? ""}
                      aria-label={`Corporation to offer ${sale.name} to`}
                      onChange={(event) =>
                        setPrivateDrafts((prev) => ({ ...prev, [sale.privateId]: { ...draft, buyer: Number(event.target.value) } }))
                      }
                    >
                      {sale.buyers.map((entry) => (
                        <option key={entry.companyId} value={entry.companyId}>
                          {entry.ticker} (treasury ${entry.treasury})
                        </option>
                      ))}
                    </select>
                    <input
                      style={styles.priceInput}
                      type="text"
                      inputMode="numeric"
                      value={draft.price}
                      aria-label={`Price for ${sale.name}`}
                      onChange={(event) =>
                        setPrivateDrafts((prev) => ({ ...prev, [sale.privateId]: { ...draft, price: event.target.value } }))
                      }
                    />
                    <button
                      type="button"
                      style={{ ...styles.primaryButton, ...(reason ? styles.buttonDisabled : {}) }}
                      disabled={reason !== null}
                      title={reason ?? `Offer ${sale.name} to ${buyer?.ticker ?? ""} for $${draft.price.trim()}.`}
                      onClick={() => {
                        if (draft.buyer === null) return;
                        onOffer(sale.privateId, draft.buyer, Number(draft.price.trim()));
                      }}
                    >
                      Offer
                    </button>
                  </div>
                  {refusal && <span style={styles.reason}>{refusal}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {offer !== null && (
        <div style={styles.subsection} role="status">
          <span style={styles.sectionTitle}>Private company on offer</span>
          <p style={styles.body}>
            {offer.private_name} offered to <strong>{offer.buyer_ticker}</strong> for ${offer.price}.{" "}
            {fundingAnswerRefusal === null
              ? `You preside over ${offer.buyer_ticker} too, so the answer is yours.`
              : `Waiting on ${plan.privateOfferBuyerPresidentLabel ?? `${offer.buyer_ticker}'s president`} — nothing else can happen until they answer or you withdraw it.`}
          </p>
          <div style={styles.actions}>
            {fundingAnswerRefusal === null && onAnswer ? (
              <>
                <button
                  type="button"
                  style={{ ...styles.secondaryButton, ...(blocked ? styles.buttonDisabled : {}) }}
                  disabled={blocked !== null}
                  onClick={() => onAnswer(offer.private_id, false)}
                >
                  Reject for {offer.buyer_ticker}
                </button>
                <button
                  type="button"
                  style={{ ...styles.primaryButton, ...(blocked ? styles.buttonDisabled : {}) }}
                  disabled={blocked !== null}
                  onClick={() => onAnswer(offer.private_id, true)}
                >
                  Accept for {offer.buyer_ticker}
                </button>
              </>
            ) : (
              <button
                type="button"
                style={{ ...styles.secondaryButton, ...(blocked ? styles.buttonDisabled : {}) }}
                disabled={blocked !== null}
                title={blocked ?? undefined}
                onClick={() => onRescindPrivate(offer.private_id)}
              >
                Withdraw offer
              </button>
            )}
          </div>
        </div>
      )}

      {!plan.bankrupt && short > 0 && offer === null && plan.sales.length === 0 && (
        <p style={styles.note}>Bankruptcy is decided by the game, never declared by a player.</p>
      )}

      {/* The purchase: the label is the president's own figure, and the projection is their balance (#751d). */}
      {!plan.bankrupt && (
        <div style={styles.footer}>
          <button
            type="button"
            style={{ ...styles.confirmButton, ...(buyReason !== null ? styles.confirmButtonDisabled : {}) }}
            disabled={buyReason !== null}
            title={buyReason ?? undefined}
            onClick={onBuy}
          >
            {plan.fromPlayerCash > 0
              ? `Buy the ${plan.trainModel}-train — ${plan.corporationTicker} pays $${plan.treasury}, you pay $${plan.fromPlayerCash}`
              : `Buy the ${plan.trainModel}-train for $${plan.trainCost}`}
          </button>
          {buyReason !== null ? (
            <span style={styles.reason}>{buyReason}</span>
          ) : (
            plan.fromPlayerCash > 0 && (
              <span style={styles.projection}>
                Your cash ${plan.presidentCash} &rarr;{" "}
                <strong style={styles.cashAfter}>${plan.presidentCash - plan.fromPlayerCash}</strong>
              </span>
            )
          )}
        </div>
      )}
    </section>
  );
}

/** One ledger line. A contribution renders as "−$40", never "-$-40". */
function Row({ label, value, hint, emphasis, danger }: { label: string; value: number; hint?: string; emphasis?: boolean; danger?: boolean }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>
        {label}
        {hint && <span style={styles.rowHint}>{hint}</span>}
      </span>
      <span style={{ ...styles.rowValue, ...(emphasis ? styles.rowValueEmphasis : {}), ...(danger ? styles.rowValueDanger : {}) }}>
        {value < 0 ? `−$${Math.abs(value)}` : `$${value}`}
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    /* #1651: no z-index -- this scrim is a `<dialog>` in the top layer. */
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
    width: "min(560px, 100%)",
    maxHeight: "86vh",
    overflowY: "auto",
    padding: "18px 20px",
    backgroundColor: "#0f0f0f",
    border: "1px solid #3a3a3a",
    borderTop: "3px solid #c9a227",
    /* Design note #1151: a floating layer takes the layer radius. */
    borderRadius: RADIUS.layer,
    boxShadow: "0 18px 48px rgba(0,0,0,0.6)",
    boxSizing: "border-box",
  },
  header: { display: "flex", alignItems: "center", gap: "10px" },
  title: { fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#f0e2b8", flex: "1 1 auto" },
  /* The badge where a close control would be: there is not one. */
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
    borderRadius: RADIUS.pill,
    padding: "2px 9px",
  },
  lede: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: 1.45, color: "#c8c6c0" },
  steps: { display: "flex", gap: "14px", margin: 0, padding: 0, listStyle: "none", fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" },
  stepCurrent: { color: "#f0e2b8", borderBottom: "2px solid #c9a227", paddingBottom: "2px" },
  stepDone: { color: "#6e6c68", textDecoration: "line-through" },
  stepLater: { color: "#6e6c68" },
  section: { display: "flex", flexDirection: "column", gap: "8px" },
  subsection: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" },
  sectionTitle: { fontSize: FONT_SIZE.micro, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#8a8a86" },
  body: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: 1.45, color: "#c8c6c0" },
  note: { margin: 0, fontSize: FONT_SIZE.micro, lineHeight: 1.45, color: "#8a8a86" },
  reason: { fontSize: FONT_SIZE.micro, lineHeight: 1.4, color: "#e0b062" },
  details: { fontSize: FONT_SIZE.micro, color: "#8a8a86" },
  unavailableList: { margin: "4px 0 0", paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "2px" },
  ledger: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "10px 12px",
    backgroundColor: "#141414",
    border: "1px solid #2a2a2a",
    borderRadius: RADIUS.card,
  },
  ledgerRule: { height: "1px", backgroundColor: "#2a2a2a", margin: "3px 0" },
  row: { display: "flex", alignItems: "baseline", gap: "10px" },
  rowLabel: { flex: "1 1 auto", display: "flex", flexDirection: "column", fontSize: FONT_SIZE.small, color: "#c8c6c0" },
  rowHint: { fontSize: FONT_SIZE.micro, color: "#8a8a86" },
  rowValue: { flexShrink: 0, fontSize: FONT_SIZE.body, fontVariantNumeric: "tabular-nums", color: "#f2f0eb" },
  rowValueEmphasis: { fontWeight: 800, fontSize: FONT_SIZE.strong },
  rowValueDanger: { color: "#e8a0a0" },
  table: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "8px 10px",
    backgroundColor: "#141414",
    border: "1px solid #2a2a2a",
    borderRadius: RADIUS.card,
  },
  saleBlock: { display: "flex", flexDirection: "column", gap: "3px" },
  formRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" },
  ticker: { flex: "0 0 auto", minWidth: "48px", fontSize: FONT_SIZE.small, fontWeight: 700, color: "#f2f0eb" },
  meta: { flex: "1 1 auto", fontSize: FONT_SIZE.micro, color: "#8a8a86", fontVariantNumeric: "tabular-nums" },
  select: {
    padding: "4px 8px",
    borderRadius: RADIUS.control,
    border: "1px solid #4a4a4a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.small,
    fontFamily: "inherit",
    minWidth: "96px",
  },
  priceInput: {
    width: "84px",
    padding: "4px 8px",
    borderRadius: RADIUS.control,
    border: "1px solid #4a4a4a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.small,
    fontFamily: "inherit",
  },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" },
  primaryButton: {
    padding: "6px 14px",
    borderRadius: RADIUS.control,
    border: "1px solid #4ade80",
    backgroundColor: "#166534",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  secondaryButton: {
    padding: "6px 14px",
    borderRadius: RADIUS.control,
    border: "1px solid #4a4a4a",
    backgroundColor: "#1c1c1c",
    color: "#e6e4de",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  buttonDisabled: {
    // #1449: the shorthand, not `borderColor` -- both bases are `1px solid ...`.
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#6e6c68",
    cursor: "not-allowed",
  },
  warningNotice: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "10px 12px",
    fontSize: FONT_SIZE.small,
    lineHeight: 1.45,
    color: "#e6e4de",
    backgroundColor: "#1a1a14",
    border: "1px solid #6b5a1f",
    borderRadius: RADIUS.card,
  },
  /* Prominent: the authority already says no share sale can fund the Bank purchase. */
  warningProminent: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px 14px",
    fontSize: FONT_SIZE.body,
    lineHeight: 1.45,
    color: "#f8dede",
    backgroundColor: "#3a1418",
    border: "2px solid #c2410c",
    borderRadius: RADIUS.card,
  },
  warningTitle: { fontSize: FONT_SIZE.control, letterSpacing: "0.02em" },
  projection: { fontSize: FONT_SIZE.small, color: "#a8a6a0" },
  cashAfter: { color: "#f2f0eb" },
  stillShort: { color: "#fbbf24" },
  covers: { color: "#7ee0a1" },
  bankruptNotice: {
    margin: 0,
    padding: "10px 12px",
    fontSize: FONT_SIZE.small,
    lineHeight: 1.45,
    color: "#f0c9c9",
    backgroundColor: "#2a1618",
    border: "1px solid #6b2f2f",
    borderRadius: RADIUS.card,
  },
  footer: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" },
  confirmButton: {
    padding: "9px 14px",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    /* Design note #1098 (TD-6): the confirm green every other confirm control wears. */
    color: ACTION_GREEN_INK,
    backgroundColor: ACTION_GREEN,
    border: `1px solid ${ACTION_GREEN_BORDER}`,
    borderRadius: RADIUS.card,
    cursor: "pointer",
  },
  confirmButtonDisabled: {
    // #1449: the shorthand, not `borderColor` -- the base is `1px solid ${ACTION_GREEN_BORDER}`.
    border: "1px solid #3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#6e6c68",
    cursor: "not-allowed",
  },
};

export default EmergencyTrainPurchaseModal;
