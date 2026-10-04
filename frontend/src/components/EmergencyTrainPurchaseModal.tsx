// The forced train purchase, guided -- for the obligated president only.
//
// 1830 (rulebook 6.6.2 / 6.6.3 / 6.7): a corporation with a route and no train must buy one. It may buy from another
// railroad; otherwise it buys the cheapest train the bank sells, spending its whole treasury, its president covering
// the difference from personal cash, and selling shares (and optionally private companies) for what is still short.
// `gameEngine/emergencyFunding.ts` owns every figure, every legality and every automatic step; this file renders them
// in the order a president meets them.
//
// ==================================================================
//  PHASE 3 W2-G, RECONCILED TO RULES v13 (OD-4, W3-K): THE SURFACE PRESENTS THE AUTHORITY'S STATE MACHINE
// ==================================================================
// NON-DISMISSIBLE (kept from the accepted W2-G UX). The surface opens itself for the obligated president and cannot
// be closed or escaped (`dismissible={false}` -> `closedby="none"`, #1651); the authoritative hold
// (`emergencyFundingBlock`) stands until the purchase is made or the game ends. There is no Back that leaves the
// obligation: the only "Back" buttons cancel a confirmation that has not been sent.
//
// THE SEQUENCE IS W3-K's (`emergencyStageFor`):
//   - an outstanding offer (a private funding offer, or the corporation's offer for another's train): answer or
//     withdraw it -- nothing else moves while it stands;
//   - the intercorporate trade window, while the authority says it is open: buy or offer for another corporation's
//     train within the pre-liquidation budget, or leave it with `ForgoTrainTrade` (a real message now -- the window
//     never reopens). No share sale or private sale is offered while it is open, so liquidation is never presented as
//     a way to pay for a traded train (owner rule: illegal);
//   - funded: the treasury and the president's cash are committed AUTOMATICALLY and the game derives the
//     `EmergencyBuyHardware` -- a status, never a Buy button (W3-K's no-server forwarding sends it where no server
//     does; this file sends nothing for it);
//   - still short: ONE `EmergencySellPortfolio`, composed from the authority's legal bundles and judged whole by
//     `emergencyPortfolioRefusal` -- never a sequential `SellStock`; and the optional private sale only while the exact
//     authority says it could still matter, with `ForgoPrivateFunding`;
//   - bankruptcy: the authority's derived result, settled by the reducer. There is no player bankruptcy control.
//
// VIEWER SCOPE (OD-1): this component is mounted only for the obligated president's own screen. Every other seat
// and every watcher sees `EmergencyPurchaseWaitingCard` -- one read-only status, no controls.
//
// LATCH. Every control that sends is greyed while a send is in flight (the shell's `actionInFlight`) and, inside this
// component, from the press until the board answers -- so a double click cannot send twice. Nothing automatic is
// latched here: the derived purchase is not this surface's message.

import React from "react";

import { FONT_SIZE, RADIUS } from "../styles/typography";
import { ACTION_GREEN, ACTION_GREEN_BORDER, ACTION_GREEN_INK } from "../styles/palette";
import type { EmergencyFunding, LegalPrivateSale, RescueCorporation } from "../gameEngine/emergencyFunding";
import type { PrivatePurchaseOffer } from "../gameEngine/gameState";
import {
  EMPTY_PORTFOLIO_DRAFT,
  trainSourceName,
  withPortfolioChoice,
  type DecisionConsequence,
  type EmergencyStage,
  type IntercorporateOption,
  type IntercorporateStep,
  type PortfolioDraft,
  type PortfolioVerdict,
} from "../utils/emergencyPurchaseView";
import { NativeModal } from "./NativeModal";

export interface EmergencyPurchasePlan {
  /** Which step of the authority's sequence stands (`emergencyStageFor`). */
  stage: EmergencyStage;
  /** The train the corporation is obliged to buy: the cheapest the bank sells. */
  trainModel: string;
  trainCost: number;
  /** K-25: where that train actually is -- "Bank Pool" or "Bank Depot". */
  trainSourceName: "Bank Pool" | "Bank Depot";
  corporationId: number;
  corporationTicker: string;
  /** The whole treasury, committed automatically (6.6.2: "All of the railroad's money must be spent"). */
  treasury: number;
  presidentAddress: string;
  presidentLabel: string;
  presidentCash: number;
  /** The president's cash committed automatically: the difference the treasury leaves, up to what they hold. */
  fromPlayerCash: number;
  /** What a share portfolio (or a private sale) must still raise -- the authority's `shortfall`. */
  shortfall: number;
  /** v13: `automatic.tradeWindow` (`null` on a legacy board). */
  tradeWindow: "open" | "closed" | "unavailable" | null;
  /** v13: each corporation's legal emergency bundles (`automatic.rescue.corporations`), ascending. */
  rescue: RescueCorporation[];
  /** v13: the most any legal portfolio raises (`automatic.rescue.maximumProceeds`). */
  rescueMaximum: number;
  /** v13: whether a legal portfolio can fund the shortfall alone (`automatic.rescue.canFund`). */
  rescueCanFund: boolean;
  /** v13: `automatic.privateFunding` (`null` on a legacy board). */
  privateFunding: "relevant" | "forgone" | "irrelevant" | null;
  /** #1541: the privates the president may offer, each with its band and the corporations that could buy. */
  privateSales: LegalPrivateSale[];
  /** #1541: the offer awaiting the buying president's answer, if one stands. */
  privateOffer: PrivatePurchaseOffer | null;
  /** The label of the president who must answer `privateOffer`. */
  privateOfferBuyerPresidentLabel: string | null;
}

/* ==================================================================
    DESIGN NOTE 1540: THE PLAN IS THE AUTHORITY'S OBLIGATION, RENDERED
   ==================================================================
   The reducer derives the obligation (`emergencyFundingFor`) after every real action; this function only shapes it
   for the surface. Nothing is summed into a ceiling and nothing is decided here. */
export function buildEmergencyPurchasePlan(args: {
  funding: EmergencyFunding;
  stage: EmergencyStage;
  labelForAddress: (address: string) => string;
  /** The BUYING corporation's current president, when a funding offer stands -- read off the board by the caller. */
  privateOfferBuyerPresident?: string | null;
}): EmergencyPurchasePlan {
  const { funding, labelForAddress } = args;
  const presidentLabel = labelForAddress(funding.president);
  const buyerPresident = funding.privateOffer === null ? null : args.privateOfferBuyerPresident ?? null;
  const automatic = funding.automatic;
  return {
    stage: args.stage,
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
    shortfall: funding.shortfall,
    tradeWindow: automatic?.tradeWindow ?? null,
    rescue: automatic?.rescue.corporations ?? [],
    rescueMaximum: automatic?.rescue.maximumProceeds ?? 0,
    rescueCanFund: automatic?.rescue.canFund ?? false,
    privateFunding: automatic?.privateFunding ?? null,
    privateSales: funding.legalPrivateSales,
    privateOffer: funding.privateOffer,
    privateOfferBuyerPresidentLabel: buyerPresident === null ? null : labelForAddress(buyerPresident),
  };
}

/** One "forgo" decision as the shell hands it over: the authority's refusal and the authority's projected outcome. */
export interface ForgoDecision {
  refusal: string | null;
  consequence: DecisionConsequence | null;
}

export interface EmergencyTrainPurchaseModalProps {
  plan: EmergencyPurchasePlan | null;
  /** Rooms (and the offline table) can complete the flow; the contract path has no emergency message. */
  sandbox: boolean;
  /** The shell's latch: a send is in flight. */
  actionInFlight?: boolean;
  /** Renders a seat id as a readable name. */
  labelForAddress: (address: string) => string;
  /** The authority's view of buying from another corporation. `null` hides the trade controls. */
  intercorporate: IntercorporateStep | null;
  /** The authority's verdict on one composed intercorporate offer, or `null`. */
  intercorporateOfferRefusal: (draft: { sellerId: number; model: string; gilded?: boolean; price: string }) => string | null;
  onProposeTrade: (option: IntercorporateOption, price: string) => void;
  onRescindTrade: (sellerId: number) => void;
  /** `ForgoTrainTrade`: `forgoTrainTradeRefusal` and the projected outcome. */
  forgoTrade: ForgoDecision;
  onForgoTrainTrade: () => void;
  /** The authority's verdict on the composed portfolio (`emergencyPortfolioRefusal`, projected proceeds). */
  portfolioVerdict: (draft: PortfolioDraft) => PortfolioVerdict;
  /** ONE `EmergencySellPortfolio` -- every leg, in the president's order. */
  onSellPortfolio: (legs: PortfolioVerdict["legs"]) => void;
  /** `fundingPrivateOfferRefusal` for one composed private offer, or `null`. */
  privateOfferRefusal: (draft: { privateId: number; buyerId: number | null; price: string }) => string | null;
  onOfferPrivate: (privateId: number, buyerProtocolId: number, price: number) => void;
  onRescindPrivateOffer: (privateId: number) => void;
  /** When the obligated president also presides over the BUYING corporation, the answer is theirs and must be
   *  offered here -- this surface covers the ordinary prompt. `null` refusal = this viewer answers. */
  fundingAnswerRefusal?: string | null;
  /** The acceptance's own verdict (`fundingPrivateAnswerRefusal` with `accept: true`), or `null`: Accept may be sent. */
  fundingAcceptRefusal?: string | null;
  onAnswerFundingOffer?: (privateId: number, accept: boolean) => void;
  /** `ForgoPrivateFunding`: `forgoPrivateFundingRefusal` and the projected outcome. */
  forgoPrivate: ForgoDecision;
  onForgoPrivateFunding: () => void;
}

/** A signature of everything the board could change in answer to a press. When it changes, the press was answered
 *  and the latch is released (and any unsent draft or confirmation belongs to the old board). */
function boardSignature(plan: EmergencyPurchasePlan, intercorporate: IntercorporateStep | null): string {
  return JSON.stringify([
    plan.stage,
    plan.treasury,
    plan.presidentCash,
    plan.shortfall,
    plan.tradeWindow,
    plan.privateFunding,
    plan.rescue.map((corp) => [corp.companyId, corp.heldPercent, corp.pricePerShare, corp.options.map((option) => option.percentage)]),
    plan.privateSales.map((sale) => sale.privateId),
    plan.privateOffer?.private_id ?? null,
    intercorporate?.standingOffer
      ? [intercorporate.standingOffer.seller_protocol_id, intercorporate.standingOffer.price, intercorporate.standingOffer.accepted ?? false]
      : null,
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
  labelForAddress,
  intercorporate,
  intercorporateOfferRefusal,
  onProposeTrade,
  onRescindTrade,
  forgoTrade,
  onForgoTrainTrade,
  portfolioVerdict,
  onSellPortfolio,
  privateOfferRefusal,
  onOfferPrivate,
  onRescindPrivateOffer,
  fundingAnswerRefusal = "Not your answer.",
  fundingAcceptRefusal = "Not your answer.",
  onAnswerFundingOffer,
  forgoPrivate,
  onForgoPrivateFunding,
}: EmergencyTrainPurchaseModalProps) {
  /* Draft state only -- intentions not yet sent (#400: the reducer settles, the shell narrates). */
  const [tradeKey, setTradeKey] = React.useState<string | null>(null);
  const [tradePrice, setTradePrice] = React.useState("");
  const [confirming, setConfirming] = React.useState<"trade" | "private" | null>(null);
  const [draft, setDraft] = React.useState<PortfolioDraft>(EMPTY_PORTFOLIO_DRAFT);
  const [privateDrafts, setPrivateDrafts] = React.useState<Record<number, { buyer: number | null; price: string }>>({});

  const signature = plan ? boardSignature(plan, intercorporate) : "";
  const [pressed, press] = usePressLatch(signature, actionInFlight);
  /* A draft belongs to the board it was composed on; a new board (anything settled) clears every one of them. */
  React.useEffect(() => {
    setDraft(EMPTY_PORTFOLIO_DRAFT);
    setConfirming(null);
    setTradeKey(null);
    setTradePrice("");
    setPrivateDrafts({});
  }, [signature]);

  /* AFTER the hooks, never before (rules of hooks). A legacy (revision-1) board has no v13 controls, and a forced
     surface with nothing to press would trap its president -- the shell does not mount it there
     (`emergencySurfaceFor`), and it renders nothing if it is. */
  if (!plan || plan.stage === "legacy") return null;

  const latched = pressed || actionInFlight;
  const blocked: string | null = !sandbox
    ? "The emergency purchase is available only at a hosted table."
    : latched
      ? SEND_IN_FLIGHT
      : null;

  const tradeStage = plan.stage === "trade-window" || plan.stage === "train-offer";

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
          <li style={tradeStage ? styles.stepCurrent : styles.stepDone}>Another corporation</li>
          <li style={tradeStage ? styles.stepLater : styles.stepCurrent}>{plan.trainSourceName}</li>
        </ol>

        {plan.stage === "train-offer" && (
          <StandingTradeOffer plan={plan} step={intercorporate} blocked={blocked} labelForAddress={labelForAddress} onRescind={(sellerId) => press(() => onRescindTrade(sellerId))} />
        )}

        {plan.stage === "trade-window" && (
          <TradeStep
            plan={plan}
            step={intercorporate}
            blocked={blocked}
            tradeKey={tradeKey}
            tradePrice={tradePrice}
            setTradeKey={setTradeKey}
            setTradePrice={setTradePrice}
            refusalFor={intercorporateOfferRefusal}
            onPropose={(option, price) => press(() => onProposeTrade(option, price))}
            forgo={forgoTrade}
            confirming={confirming === "trade"}
            setConfirming={(value) => setConfirming(value ? "trade" : null)}
            onForgo={() => press(onForgoTrainTrade)}
          />
        )}

        {plan.stage === "private-offer" && plan.privateOffer && (
          <StandingPrivateOffer
            plan={plan}
            offer={plan.privateOffer}
            blocked={blocked}
            fundingAnswerRefusal={fundingAnswerRefusal}
            fundingAcceptRefusal={fundingAcceptRefusal}
            onAnswer={onAnswerFundingOffer ? (privateId, accept) => press(() => onAnswerFundingOffer(privateId, accept)) : undefined}
            onRescind={(privateId) => press(() => onRescindPrivateOffer(privateId))}
          />
        )}

        {(plan.stage === "automatic-purchase" || plan.stage === "bankruptcy" || plan.stage === "funding") && (
          <BankStep
            plan={plan}
            blocked={blocked}
            draft={draft}
            setDraft={setDraft}
            portfolioVerdict={portfolioVerdict}
            onSellPortfolio={(legs) => press(() => onSellPortfolio(legs))}
            privateDrafts={privateDrafts}
            setPrivateDrafts={setPrivateDrafts}
            privateOfferRefusal={privateOfferRefusal}
            onOffer={(privateId, buyer, price) => press(() => onOfferPrivate(privateId, buyer, price))}
            forgo={forgoPrivate}
            confirming={confirming === "private"}
            setConfirming={(value) => setConfirming(value ? "private" : null)}
            onForgo={() => press(onForgoPrivateFunding)}
          />
        )}
      </div>
    </NativeModal>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1: another corporation                                           */
/* ------------------------------------------------------------------ */

function StandingTradeOffer({
  plan,
  step,
  blocked,
  labelForAddress,
  onRescind,
}: {
  plan: EmergencyPurchasePlan;
  step: IntercorporateStep | null;
  blocked: string | null;
  labelForAddress: (address: string) => string;
  onRescind: (sellerId: number) => void;
}) {
  const standing = step?.standingOffer ?? null;
  if (!standing || !step) {
    return (
      <section style={styles.section} aria-label="Train offer waiting">
        <p style={styles.body}>A train offer is waiting for an answer. Nothing else can happen until it is answered or withdrawn.</p>
      </section>
    );
  }
  const answerer = step.standingOfferAnswerer === null ? `${standing.seller_ticker}'s president` : labelForAddress(step.standingOfferAnswerer);
  return (
    <section style={styles.section} aria-label="Offer to another corporation">
      <span style={styles.sectionTitle}>Buy from another corporation</span>
      <p style={styles.body}>
        {plan.corporationTicker} offered <strong>${standing.price}</strong> for {standing.seller_ticker}&#39;s{" "}
        {standing.model_type}-train.{" "}
        {standing.accepted ? "The offer was accepted and is being settled." : `Waiting on ${answerer} to answer.`}
      </p>
      {!standing.accepted && (
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
      )}
      <p style={styles.note}>Nothing else can happen until this offer is answered or withdrawn.</p>
    </section>
  );
}

function TradeStep({
  plan,
  step,
  blocked,
  tradeKey,
  tradePrice,
  setTradeKey,
  setTradePrice,
  refusalFor,
  onPropose,
  forgo,
  confirming,
  setConfirming,
  onForgo,
}: {
  plan: EmergencyPurchasePlan;
  step: IntercorporateStep | null;
  blocked: string | null;
  tradeKey: string | null;
  tradePrice: string;
  setTradeKey: (key: string) => void;
  setTradePrice: (price: string) => void;
  refusalFor: EmergencyTrainPurchaseModalProps["intercorporateOfferRefusal"];
  onPropose: (option: IntercorporateOption, price: string) => void;
  forgo: ForgoDecision;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  onForgo: () => void;
}) {
  const legal = step?.legal ?? [];
  const chosen = legal.find((option) => option.key === tradeKey) ?? legal[0] ?? null;
  const refusal = chosen === null ? "Choose a train." : refusalFor({ sellerId: chosen.sellerId, model: chosen.model, gilded: chosen.gilded, price: tradePrice });
  const direct = chosen !== null && chosen.sellerPresident === plan.presidentAddress;
  const unavailable = (step?.options ?? []).filter((option) => option.refusal !== null);
  const forgoReason = blocked ?? forgo.refusal;

  return (
    <section style={styles.section} aria-label="Buy from another corporation">
      <span style={styles.sectionTitle}>Step 1 — Buy from another corporation</span>
      <p style={styles.body}>
        {plan.corporationTicker} may buy one of these trains instead, using only <strong>${plan.treasury}</strong> from
        its treasury and <strong>${plan.presidentCash}</strong> of {plan.presidentLabel}&#39;s cash — never money raised
        by selling shares or private companies. The selling corporation&#39;s president must agree.
      </p>
      {legal.length > 0 && (
        <div style={styles.table}>
          <div style={styles.formRow}>
            <select
              style={styles.select}
              aria-label="Train to buy from another corporation"
              value={chosen?.key ?? ""}
              onChange={(event) => setTradeKey(event.target.value)}
            >
              {legal.map((option) => (
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
      )}
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

      {!confirming ? (
        <div style={styles.actions}>
          <button
            type="button"
            style={{ ...styles.secondaryButton, ...(forgoReason ? styles.buttonDisabled : {}) }}
            disabled={forgoReason !== null}
            title={forgoReason ?? "Leave this opportunity for good and buy from the Bank."}
            onClick={() => setConfirming(true)}
          >
            Buy from the {plan.trainSourceName} instead
          </button>
          {forgo.refusal && <span style={styles.reason}>{forgo.refusal}</span>}
        </div>
      ) : (
        <ConsequenceConfirm
          title="Before you leave this opportunity"
          consequence={forgo.consequence}
          lead="A train from another corporation will not be offered again for this purchase."
          blocked={forgoReason}
          confirmLabel={`Buy from the ${plan.trainSourceName}`}
          onBack={() => setConfirming(false)}
          onConfirm={onForgo}
        />
      )}
    </section>
  );
}

/** The confirmation of a "forgo" decision: the authority's projected outcome, prominent when it is bankruptcy.
 *  "Back" only withdraws the confirmation -- nothing was sent, and the obligation is untouched. */
function ConsequenceConfirm({
  title,
  lead,
  consequence,
  blocked,
  confirmLabel,
  onBack,
  onConfirm,
}: {
  title: string;
  lead: string;
  consequence: DecisionConsequence | null;
  blocked: string | null;
  confirmLabel: string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const prominent = consequence?.severity === "prominent";
  return (
    <div role="alert" style={prominent ? styles.warningProminent : styles.warningNotice}>
      <strong style={styles.warningTitle}>{prominent ? "Warning: this ends the game in bankruptcy" : title}</strong>
      <span>
        {lead} {consequence?.text ?? ""}
      </span>
      <div style={styles.actions}>
        <button type="button" style={styles.secondaryButton} onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          style={{ ...(prominent ? styles.dangerButton : styles.primaryButton), ...(blocked ? styles.buttonDisabled : {}) }}
          disabled={blocked !== null}
          title={blocked ?? undefined}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* An outstanding private funding offer                                  */
/* ------------------------------------------------------------------ */

function StandingPrivateOffer({
  plan,
  offer,
  blocked,
  fundingAnswerRefusal,
  fundingAcceptRefusal,
  onAnswer,
  onRescind,
}: {
  plan: EmergencyPurchasePlan;
  offer: PrivatePurchaseOffer;
  blocked: string | null;
  fundingAnswerRefusal: string | null;
  fundingAcceptRefusal: string | null;
  onAnswer?: (privateId: number, accept: boolean) => void;
  onRescind: (privateId: number) => void;
}) {
  return (
    <section style={styles.section} role="status" aria-label="Private company on offer">
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
              title={blocked ?? undefined}
              onClick={() => onAnswer(offer.private_id, false)}
            >
              Reject for {offer.buyer_ticker}
            </button>
            <button
              type="button"
              style={{ ...styles.primaryButton, ...(blocked || fundingAcceptRefusal ? styles.buttonDisabled : {}) }}
              disabled={blocked !== null || fundingAcceptRefusal !== null}
              title={blocked ?? fundingAcceptRefusal ?? undefined}
              onClick={() => onAnswer(offer.private_id, true)}
            >
              Accept for {offer.buyer_ticker}
            </button>
            {fundingAcceptRefusal !== null && <span style={styles.reason}>{fundingAcceptRefusal}</span>}
          </>
        ) : (
          <button
            type="button"
            style={{ ...styles.secondaryButton, ...(blocked ? styles.buttonDisabled : {}) }}
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => onRescind(offer.private_id)}
          >
            Withdraw offer
          </button>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2: the Bank / Bank Pool purchase                                 */
/* ------------------------------------------------------------------ */

function BankStep({
  plan,
  blocked,
  draft,
  setDraft,
  portfolioVerdict,
  onSellPortfolio,
  privateDrafts,
  setPrivateDrafts,
  privateOfferRefusal,
  onOffer,
  forgo,
  confirming,
  setConfirming,
  onForgo,
}: {
  plan: EmergencyPurchasePlan;
  blocked: string | null;
  draft: PortfolioDraft;
  setDraft: React.Dispatch<React.SetStateAction<PortfolioDraft>>;
  portfolioVerdict: EmergencyTrainPurchaseModalProps["portfolioVerdict"];
  onSellPortfolio: EmergencyTrainPurchaseModalProps["onSellPortfolio"];
  privateDrafts: Record<number, { buyer: number | null; price: string }>;
  setPrivateDrafts: React.Dispatch<React.SetStateAction<Record<number, { buyer: number | null; price: string }>>>;
  privateOfferRefusal: EmergencyTrainPurchaseModalProps["privateOfferRefusal"];
  onOffer: (privateId: number, buyer: number, price: number) => void;
  forgo: ForgoDecision;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  onForgo: () => void;
}) {
  const short = plan.shortfall;

  return (
    <section style={styles.section} aria-label={`Buy from the ${plan.trainSourceName}`}>
      <span style={styles.sectionTitle}>Buy from the {plan.trainSourceName}</span>
      {plan.tradeWindow === "closed" && (
        <p style={styles.note}>
          {plan.corporationTicker}&#39;s president chose to buy from the Bank, so a train from another corporation is no
          longer possible for this purchase.
        </p>
      )}
      {plan.tradeWindow === "unavailable" && (
        <p style={styles.note}>No other corporation can sell {plan.corporationTicker} a train within its budget.</p>
      )}

      {/* The cascade, automatic: the player never types these. */}
      <div style={styles.ledger}>
        <Row label={`${plan.trainModel}-train from the ${plan.trainSourceName}`} value={plan.trainCost} emphasis />
        <Row label={`${plan.corporationTicker} treasury — all of it`} hint="Committed automatically." value={-plan.treasury} />
        <Row
          label={`${plan.presidentLabel}'s cash`}
          hint={
            plan.fromPlayerCash < plan.presidentCash
              ? `Committed automatically, of $${plan.presidentCash} held.`
              : plan.presidentCash > 0
                ? "Committed automatically — their whole balance."
                : "They hold no cash."
          }
          value={-plan.fromPlayerCash}
        />
        <div style={styles.ledgerRule} />
        <Row label="Still to raise" value={short} emphasis danger={short > 0} />
      </div>

      {plan.stage === "automatic-purchase" && (
        <p style={styles.autoNotice} role="status">
          <strong>Funded.</strong> The game buys the {plan.trainModel}-train from the {plan.trainSourceName}{" "}
          automatically: {plan.corporationTicker} pays ${plan.treasury}
          {plan.fromPlayerCash > 0 ? ` and you pay $${plan.fromPlayerCash}` : ""}. There is nothing to press.
        </p>
      )}

      {plan.stage === "bankruptcy" && (
        <p style={styles.bankruptNotice} role="status">
          <strong>No legal rescue remains.</strong> Bankruptcy is automatic: {plan.presidentLabel}&#39;s shares are sold
          as far as the rules allow, all of their money goes to {plan.corporationTicker}, and the game ends.
        </p>
      )}

      {plan.stage === "funding" && (
        <>
          <PortfolioSection plan={plan} blocked={blocked} draft={draft} setDraft={setDraft} verdictFor={portfolioVerdict} onSell={onSellPortfolio} />
          {plan.privateFunding === "relevant" && (
            <PrivateSection
              plan={plan}
              blocked={blocked}
              privateDrafts={privateDrafts}
              setPrivateDrafts={setPrivateDrafts}
              privateOfferRefusal={privateOfferRefusal}
              onOffer={onOffer}
              forgo={forgo}
              confirming={confirming}
              setConfirming={setConfirming}
              onForgo={onForgo}
            />
          )}
          {plan.privateFunding === "forgone" && (
            <p style={styles.note}>You chose not to pursue private-company funding for this train.</p>
          )}
          <p style={styles.note}>Bankruptcy is decided by the game, never declared by a player.</p>
        </>
      )}
    </section>
  );
}

function PortfolioSection({
  plan,
  blocked,
  draft,
  setDraft,
  verdictFor,
  onSell,
}: {
  plan: EmergencyPurchasePlan;
  blocked: string | null;
  draft: PortfolioDraft;
  setDraft: React.Dispatch<React.SetStateAction<PortfolioDraft>>;
  verdictFor: EmergencyTrainPurchaseModalProps["portfolioVerdict"];
  onSell: EmergencyTrainPurchaseModalProps["onSellPortfolio"];
}) {
  const short = plan.shortfall;
  if (plan.rescue.length === 0) {
    return (
      <div style={styles.subsection}>
        <span style={styles.sectionTitle}>Sell shares</span>
        <p style={styles.note}>No share you hold can legally be sold right now.</p>
      </div>
    );
  }
  const verdict = verdictFor(draft);
  const reason = blocked ?? verdict.refusal;
  const tickerOf = (id: number) => plan.rescue.find((corp) => corp.companyId === id)?.ticker ?? String(id);
  const cashAfter = plan.presidentCash + verdict.total;
  /* What the automatic purchase then takes from the president: the train's price less the whole treasury (6.6.2) --
     the same figure the ledger above commits, now that the sale has covered it. */
  const leftAfterPurchase = cashAfter - Math.max(0, plan.trainCost - plan.treasury);
  return (
    <div style={styles.subsection}>
      <span style={styles.sectionTitle}>Sell shares — one transaction</span>
      <p style={styles.note}>
        Choose every share to sell. They are sold together, in the order you choose them, and the sale must raise the
        whole ${short}. Any combination the rules allow is yours to pick.
      </p>
      {!plan.rescueCanFund && (
        <p style={styles.reason}>
          Your shares can raise at most ${plan.rescueMaximum} of the ${short} needed
          {plan.privateFunding === "relevant" ? " — a private-company sale would have to come first." : "."}
        </p>
      )}
      <div style={styles.table}>
        {plan.rescue.map((corp) => {
          const value = draft.percent[corp.companyId] ?? 0;
          return (
            <div key={corp.companyId} style={styles.saleBlock}>
              <div style={styles.formRow}>
                <span style={styles.ticker}>{corp.ticker}</span>
                <span style={styles.meta}>
                  you hold {corp.heldPercent}% · ${corp.pricePerShare}/share
                </span>
                <select
                  style={styles.select}
                  aria-label={`Shares of ${corp.ticker} to sell`}
                  value={value}
                  onChange={(event) => setDraft((prev) => withPortfolioChoice(prev, corp.companyId, Number(event.target.value)))}
                >
                  <option value={0}>none</option>
                  {corp.options.map((option) => (
                    <option key={option.percentage} value={option.percentage}>
                      {option.percentage}% · ${option.proceeds}
                    </option>
                  ))}
                </select>
              </div>
              {corp.restriction && <span style={styles.note}>Not every bundle is allowed: {corp.restriction}</span>}
            </div>
          );
        })}
      </div>
      {verdict.legs.length > 1 && (
        <span style={styles.note}>Sold in this order: {verdict.legs.map((leg) => tickerOf(leg.protocol_id)).join(", ")}.</span>
      )}
      <span style={styles.projection}>
        This sale raises <strong style={styles.cashAfter}>${verdict.total}</strong> of the ${short} needed · Your cash $
        {plan.presidentCash} &rarr; <strong style={styles.cashAfter}>${cashAfter}</strong>
        {verdict.total < short ? (
          <span style={styles.stillShort}> — still ${short - verdict.total} short</span>
        ) : (
          <span style={styles.covers}>
            {" "}
            — covers the ${short} needed; the game then buys the train automatically and you keep ${leftAfterPurchase}
          </span>
        )}
      </span>
      <div style={styles.footer}>
        <button
          type="button"
          style={{ ...styles.confirmButton, ...(reason !== null ? styles.confirmButtonDisabled : {}) }}
          disabled={reason !== null}
          title={reason ?? undefined}
          onClick={() => onSell(verdict.legs)}
        >
          {verdict.legs.length === 0 ? "Sell the chosen shares" : `Sell the chosen shares together — $${verdict.total}`}
        </button>
        {reason !== null && <span style={styles.reason}>{reason}</span>}
      </div>
    </div>
  );
}

function PrivateSection({
  plan,
  blocked,
  privateDrafts,
  setPrivateDrafts,
  privateOfferRefusal,
  onOffer,
  forgo,
  confirming,
  setConfirming,
  onForgo,
}: {
  plan: EmergencyPurchasePlan;
  blocked: string | null;
  privateDrafts: Record<number, { buyer: number | null; price: string }>;
  setPrivateDrafts: React.Dispatch<React.SetStateAction<Record<number, { buyer: number | null; price: string }>>>;
  privateOfferRefusal: EmergencyTrainPurchaseModalProps["privateOfferRefusal"];
  onOffer: (privateId: number, buyer: number, price: number) => void;
  forgo: ForgoDecision;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  onForgo: () => void;
}) {
  const forgoReason = blocked ?? forgo.refusal;
  return (
    <div style={styles.subsection}>
      <span style={styles.sectionTitle}>Offer a private company — optional</span>
      <p style={styles.note}>
        Another corporation may buy a private company you own; its president must accept. You are never required to
        offer one — but while one could still help, the game waits until you offer it or decline.
      </p>
      <div style={styles.table}>
        {plan.privateSales.map((sale) => {
          const privateDraft = privateDrafts[sale.privateId] ?? { buyer: sale.buyers[0]?.companyId ?? null, price: String(sale.minPrice) };
          const refusal = privateOfferRefusal({ privateId: sale.privateId, buyerId: privateDraft.buyer, price: privateDraft.price });
          const reason = blocked ?? refusal;
          const buyer = sale.buyers.find((entry) => entry.companyId === privateDraft.buyer) ?? null;
          return (
            <div key={sale.privateId} style={styles.saleBlock}>
              <div style={styles.formRow}>
                <span style={styles.ticker}>{sale.name}</span>
                <span style={styles.meta}>
                  face ${sale.faceValue} · ${sale.minPrice}–${sale.maxPrice}
                </span>
                <select
                  style={styles.select}
                  value={privateDraft.buyer ?? ""}
                  aria-label={`Corporation to offer ${sale.name} to`}
                  onChange={(event) =>
                    setPrivateDrafts((prev) => ({ ...prev, [sale.privateId]: { ...privateDraft, buyer: Number(event.target.value) } }))
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
                  value={privateDraft.price}
                  aria-label={`Price for ${sale.name}`}
                  onChange={(event) =>
                    setPrivateDrafts((prev) => ({ ...prev, [sale.privateId]: { ...privateDraft, price: event.target.value } }))
                  }
                />
                <button
                  type="button"
                  style={{ ...styles.primaryButton, ...(reason ? styles.buttonDisabled : {}) }}
                  disabled={reason !== null}
                  title={reason ?? `Offer ${sale.name} to ${buyer?.ticker ?? ""} for $${privateDraft.price.trim()}.`}
                  onClick={() => {
                    if (privateDraft.buyer === null) return;
                    onOffer(sale.privateId, privateDraft.buyer, Number(privateDraft.price.trim()));
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
      {!confirming ? (
        <div style={styles.actions}>
          <button
            type="button"
            style={{ ...styles.secondaryButton, ...(forgoReason ? styles.buttonDisabled : {}) }}
            disabled={forgoReason !== null}
            title={forgoReason ?? "Decline private-company funding for this train."}
            onClick={() => setConfirming(true)}
          >
            Don&#39;t sell a private company
          </button>
          {forgo.refusal && <span style={styles.reason}>{forgo.refusal}</span>}
        </div>
      ) : (
        <ConsequenceConfirm
          title="Before you decline"
          consequence={forgo.consequence}
          lead="A private company will not be offered again for this purchase."
          blocked={forgoReason}
          confirmLabel="Decline private-company funding"
          onBack={() => setConfirming(false)}
          onConfirm={onForgo}
        />
      )}
    </div>
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
    width: "min(580px, 100%)",
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
  /* A decision the authority says ends the game: the same orange as the prominent warning around it. */
  dangerButton: {
    padding: "6px 14px",
    borderRadius: RADIUS.control,
    border: "1px solid #f97316",
    backgroundColor: "#7c2d12",
    color: "#fdf2e9",
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
  /* Prominent: the authority's projection says the decision ends the game in bankruptcy. */
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
  autoNotice: {
    margin: 0,
    padding: "10px 12px",
    fontSize: FONT_SIZE.small,
    lineHeight: 1.45,
    color: "#d8f3e2",
    backgroundColor: "#12241a",
    border: "1px solid #2f6b46",
    borderRadius: RADIUS.card,
  },
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
