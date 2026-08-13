// frontend/src/components/TrainTradePanel.tsx
//
// Corporation-to-corporation train sales -- the UI half of Audit G-15.
//
// Design notes:
//
// 1. THREE AUDIENCES, ONE PANEL. Every offer is visible to everyone, but what
//    you can DO with it depends on which president you are:
//      - the SELLER's president sees Accept / Reject;
//      - the BUYER's president sees Rescind;
//      - anyone else sees a read-only row.
//    The backend resolves both presidents onto each offer
//    (`TrainOfferEntry.seller_president` / `buyer_president`) precisely so
//    this decision needs no cross-referencing of the company list here.
//
//    Read-only rows are shown rather than hidden on purpose. A pending offer
//    is public information at the table -- everyone can see two players
//    negotiating -- and hiding it would make the blocked turn inexplicable to
//    the other players waiting on it.
//
// 2. THE BLOCKED TURN IS THE HEADLINE. While a corporation has an offer
//    outstanding it cannot end its Operating Round turn. That is enforced
//    on-chain (`operations::PendingTrainOfferBlocksTurn`), so if this panel
//    said nothing the player would simply find "End Turn" failing with an
//    error and no visible cause. The banner states the block and puts Rescind
//    next to it, because rescinding is the one thing that clears it and it is
//    entirely in the buyer's hands.
//
// 3. SAME-PRESIDENT SALES NEVER APPEAR HERE. If one player is president of
//    both corporations the contract settles immediately and writes no offer,
//    so there is nothing to display. The compose form still shows those
//    corporations as sellers -- the sale just completes on submit instead of
//    creating a row. The form says so, rather than letting the difference
//    surprise the player after they click.
//
// 5. UNAVAILABLE MODELS ARE DISABLED, NOT HIDDEN, and carry counts. A
//    corporation that owns no 4-train shows "4-train -- none owned", greyed.
//    Hiding the row would leave the player wondering whether the model exists
//    at all; showing it greyed answers "can I buy a 4-train from them" with a
//    definite no. Models the seller DOES own show how many, because two
//    2-trains and one 2-train are different negotiating positions.
//
// 4. PRICES ARE STRINGS ALL THE WAY THROUGH. `price` is `Uint128` on-chain
//    and arrives as a JSON string. The input is validated as a non-negative
//    integer string and passed on unparsed -- the same no-float discipline
//    the contract holds itself to. A price above 2^53 is not realistic in
//    VGP, but parsing to `Number` here would be a silent precision bug for no
//    benefit whatsoever.

import React, { useEffect, useMemo, useState } from "react";

/** Mirrors `msg::TrainOfferEntry` exactly. */
export interface TrainOfferEntry {
  offer_id: number;
  buyer_protocol_id: number;
  seller_protocol_id: number;
  model_type: string;
  /** `Uint128` -- arrives as a JSON string. Never parsed to a number here. */
  price: string;
  seller_president: string | null;
  buyer_president: string | null;
}

/** The subset of a corporation this panel needs. */
export interface TradeCompany {
  company_id: number;
  ticker: string;
  president: string | null;
  /** Models this corporation currently owns, e.g. `["2", "2", "4"]`.
   *  Duplicates are meaningful and drive the "(2 available)" counts.
   *
   *  `null`/`undefined` means UNKNOWN -- a contract predating
   *  `PublicCompanyState.owned_trains` -- not "owns nothing". See
   *  `ownedCounts` for why the distinction is load-bearing. */
  owned_train_models?: string[] | null;
}

export interface TrainTradePanelProps {
  /** Every pending offer in the room, from `GetTrainOffers`. */
  offers: readonly TrainOfferEntry[];
  companies: readonly TradeCompany[];
  /** The corporation whose Operating Round turn it is -- the only one that
   *  may make an offer. `null` outside an Operating Round. */
  activeProtocolId: number | null;
  connectedAddress: string | null;
  /** Disabled while the session key is not ready, matching every other
   *  action panel in this app. */
  sessionReady: boolean;
  onMakeOffer: (input: {
    sellerProtocolId: number;
    modelType: string;
    price: string;
  }) => void;
  onAccept: (offerId: number) => void;
  onReject: (offerId: number) => void;
  onRescind: (offerId: number) => void;
}

/** Every train model, in roster order. Mirrors `hardware::TRAIN_CATALOG`. */
const TRAIN_MODELS: readonly string[] = ["2", "3", "4", "5", "6", "D"];

/** A price is any integer of at least 1 -- `train_trade::MINIMUM_TRAIN_PRICE`.
 *  Validated as a STRING; see design note #4. */
function priceError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "Enter a price.";
  if (!/^\d+$/.test(trimmed)) return "Whole numbers only.";
  if (/^0+$/.test(trimmed)) return "A train must sell for at least $1.";
  return null;
}

function tickerFor(companies: readonly TradeCompany[], id: number): string {
  return companies.find((c) => c.company_id === id)?.ticker ?? `#${id}`;
}

export function TrainTradePanel({
  offers,
  companies,
  activeProtocolId,
  connectedAddress,
  sessionReady,
  onMakeOffer,
  onAccept,
  onReject,
  onRescind,
}: TrainTradePanelProps) {
  const [sellerId, setSellerId] = useState<number | null>(null);
  const [model, setModel] = useState<string>(TRAIN_MODELS[0]);
  const [price, setPrice] = useState<string>("1");

  const activeCompany = companies.find((c) => c.company_id === activeProtocolId) ?? null;
  const iAmActivePresident =
    !!connectedAddress && !!activeCompany && activeCompany.president === connectedAddress;

  // Design note #2: the buying corporation's own outstanding offer, which is
  // what is holding its turn open.
  const myBlockingOffer = useMemo(
    () => offers.find((offer) => offer.buyer_protocol_id === activeProtocolId) ?? null,
    [offers, activeProtocolId],
  );

  // Everyone except the active corporation is a possible seller. A
  // corporation cannot buy from itself (`train_trade::SelfTrade`).
  const sellers = companies.filter((c) => c.company_id !== activeProtocolId);
  const selectedSeller = sellers.find((c) => c.company_id === sellerId) ?? null;

  // Design note #3: warn BEFORE submitting that this will settle instantly.
  const sameP =
    !!selectedSeller &&
    !!activeCompany &&
    !!selectedSeller.president &&
    selectedSeller.president === activeCompany.president;

  // How many of each model the selected seller owns -- design note #5.
  //
  // `undefined` means the CHAIN DID NOT SAY (a contract predating
  // `owned_trains`), which is emphatically not "owns nothing". In that case
  // every model stays selectable and the contract remains the authority;
  // greying everything out against an older chain would make trading look
  // broken rather than unsupported.
  const ownedModels = selectedSeller?.owned_train_models ?? null;
  const ownedCounts = useMemo(() => {
    if (!ownedModels) return null;
    const counts: Record<string, number> = {};
    for (const m of ownedModels) counts[m] = (counts[m] ?? 0) + 1;
    return counts;
  }, [ownedModels]);

  const modelAvailable = (candidate: string): boolean =>
    !ownedCounts || (ownedCounts[candidate] ?? 0) > 0;
  const modelUnavailable = !modelAvailable(model);

  // Keep the SELECTION legal as the seller changes. Without this, picking a
  // seller who owns no 2-train leaves "2-train" selected and disabled, and
  // the player has to notice and fix a choice the UI made for them.
  const firstAvailableModel = TRAIN_MODELS.find(modelAvailable) ?? null;
  useEffect(() => {
    if (firstAvailableModel && !modelAvailable(model)) setModel(firstAvailableModel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellerId, firstAvailableModel]);

  const priceProblem = priceError(price);
  const canOffer =
    sessionReady &&
    iAmActivePresident &&
    !myBlockingOffer &&
    !!selectedSeller &&
    !priceProblem &&
    !modelUnavailable;

  return (
    <div style={styles.root}>
      <div style={styles.headerRow}>
        <span style={styles.headerTitle}>Train Trading</span>
        {!iAmActivePresident && (
          <span style={styles.headerHint}>
            Only the operating corporation&apos;s President may make an offer.
          </span>
        )}
      </div>

      {/* ---- The blocked-turn banner. Design note #2. ---- */}
      {myBlockingOffer && (
        <div style={styles.blockBanner}>
          <div style={styles.blockText}>
            <strong>Turn held open.</strong>{" "}
            {tickerFor(companies, myBlockingOffer.buyer_protocol_id)} has offered $
            {myBlockingOffer.price} to {tickerFor(companies, myBlockingOffer.seller_protocol_id)} for
            a {myBlockingOffer.model_type}-train. You cannot end this turn until it is answered
            &mdash; or until you rescind it. You may still buy from the Bank meanwhile.
          </div>
          {myBlockingOffer.buyer_president === connectedAddress && (
            <button
              type="button"
              style={styles.rescindButton}
              disabled={!sessionReady}
              onClick={() => onRescind(myBlockingOffer.offer_id)}
            >
              Rescind Offer
            </button>
          )}
        </div>
      )}

      {/* ---- Compose an offer. ---- */}
      <div style={styles.section}>
        <span style={styles.sectionLabel}>Buy a train from another corporation</span>

        <div style={styles.formRow}>
          <select
            style={styles.select}
            value={sellerId ?? ""}
            disabled={!sessionReady || !iAmActivePresident || !!myBlockingOffer}
            onChange={(event) =>
              setSellerId(event.target.value === "" ? null : Number(event.target.value))
            }
          >
            <option value="">Select a corporation...</option>
            {sellers.map((company) => (
              <option key={company.company_id} value={company.company_id}>
                {company.ticker}
              </option>
            ))}
          </select>

          <select
            style={styles.select}
            value={model}
            disabled={!sessionReady || !iAmActivePresident || !!myBlockingOffer}
            onChange={(event) => setModel(event.target.value)}
          >
            {TRAIN_MODELS.map((m) => {
              const count = ownedCounts?.[m] ?? null;
              const available = modelAvailable(m);
              return (
                <option key={m} value={m} disabled={!available}>
                  {m}-train
                  {count !== null && count > 0 ? ` (${count} available)` : ""}
                  {!available ? " -- none owned" : ""}
                </option>
              );
            })}
          </select>

          <input
            style={styles.priceInput}
            value={price}
            inputMode="numeric"
            aria-label="Offer price in VGP"
            disabled={!sessionReady || !iAmActivePresident || !!myBlockingOffer}
            onChange={(event) => setPrice(event.target.value)}
          />

          <button
            type="button"
            style={styles.actionButton}
            disabled={!canOffer}
            onClick={() =>
              selectedSeller &&
              onMakeOffer({
                sellerProtocolId: selectedSeller.company_id,
                modelType: model,
                price: price.trim(),
              })
            }
          >
            {sameP ? "Buy Now" : "Send Offer"}
          </button>
        </div>

        {/* Reasons, stated at the moment they bind. */}
        {priceProblem && <span style={styles.warn}>{priceProblem}</span>}
        {modelUnavailable && (
          <span style={styles.warn}>
            {selectedSeller?.ticker} owns no {model}-train.
          </span>
        )}
        {sameP && !priceProblem && (
          <span style={styles.note}>
            You are President of both corporations, so this sale completes immediately &mdash; no
            offer is sent and nothing needs accepting.
          </span>
        )}
        {myBlockingOffer && (
          <span style={styles.note}>
            One offer at a time. Answer or rescind the outstanding one first.
          </span>
        )}
        <span style={styles.note}>
          Any price of $1 or more is legal, with no upper limit. A train bought this way does not
          advance the game phase and triggers no rusting.
        </span>
      </div>

      {/* ---- Every pending offer. Design note #1. ---- */}
      <div style={styles.section}>
        <span style={styles.sectionLabel}>Pending offers</span>
        {offers.length === 0 ? (
          <span style={styles.note}>No offers outstanding.</span>
        ) : (
          offers.map((offer) => {
            const iAmSeller = !!connectedAddress && offer.seller_president === connectedAddress;
            const iAmBuyer = !!connectedAddress && offer.buyer_president === connectedAddress;
            return (
              <div key={offer.offer_id} style={styles.offerRow}>
                <span style={styles.offerText}>
                  <strong>{tickerFor(companies, offer.buyer_protocol_id)}</strong> offers{" "}
                  <strong>${offer.price}</strong> to{" "}
                  <strong>{tickerFor(companies, offer.seller_protocol_id)}</strong> for a{" "}
                  {offer.model_type}-train
                </span>
                <span style={styles.offerActions}>
                  {iAmSeller && (
                    <>
                      <button
                        type="button"
                        style={styles.acceptButton}
                        disabled={!sessionReady}
                        onClick={() => onAccept(offer.offer_id)}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        style={styles.rejectButton}
                        disabled={!sessionReady}
                        onClick={() => onReject(offer.offer_id)}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {iAmBuyer && !iAmSeller && (
                    <button
                      type="button"
                      style={styles.rescindButton}
                      disabled={!sessionReady}
                      onClick={() => onRescind(offer.offer_id)}
                    >
                      Rescind
                    </button>
                  )}
                  {!iAmSeller && !iAmBuyer && (
                    <span style={styles.waitingNote}>Awaiting their answer</span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default TrainTradePanel;

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    padding: "14px 18px",
    backgroundColor: "#12141b",
    border: "1px solid #3a3f4b",
    borderRadius: "10px",
  },
  headerRow: { display: "flex", alignItems: "baseline", gap: "12px" },
  headerTitle: { fontSize: "16px", fontWeight: 700, color: "#e6e8ef" },
  headerHint: { fontSize: "12px", color: "#8a919e" },
  section: { display: "flex", flexDirection: "column", gap: "8px" },
  sectionLabel: {
    fontSize: "12px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#9aa0ac",
  },
  formRow: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" },
  select: {
    fontSize: "14px",
    padding: "7px 10px",
    borderRadius: "7px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1b1e27",
    color: "#e6e8ef",
  },
  priceInput: {
    width: "110px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "14px",
    padding: "7px 10px",
    borderRadius: "7px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#1b1e27",
    color: "#e6e8ef",
  },
  actionButton: {
    fontSize: "14px",
    fontWeight: 700,
    padding: "8px 16px",
    borderRadius: "8px",
    border: "1px solid #3a3f4b",
    backgroundColor: "#242833",
    color: "#e6e8ef",
    cursor: "pointer",
  },
  // The block is amber, not red: it is a live commitment the player chose to
  // make, not an error state.
  blockBanner: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1px solid #6b5a24",
    backgroundColor: "#2a2413",
  },
  blockText: { flex: 1, fontSize: "13px", lineHeight: 1.5, color: "#e0c97a" },
  offerRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "8px 10px",
    borderRadius: "7px",
    backgroundColor: "#171a22",
    border: "1px solid #2b2f3a",
  },
  offerText: { flex: 1, fontSize: "13px", lineHeight: 1.5, color: "#c8ccd6" },
  offerActions: { display: "flex", gap: "6px", alignItems: "center" },
  acceptButton: {
    fontSize: "13px",
    fontWeight: 700,
    padding: "6px 12px",
    borderRadius: "7px",
    border: "1px solid #2f6f3f",
    backgroundColor: "#1a3d26",
    color: "#8fe0a8",
    cursor: "pointer",
  },
  rejectButton: {
    fontSize: "13px",
    fontWeight: 700,
    padding: "6px 12px",
    borderRadius: "7px",
    border: "1px solid #7a3030",
    backgroundColor: "#3a1c1c",
    color: "#e79a9a",
    cursor: "pointer",
  },
  rescindButton: {
    fontSize: "13px",
    fontWeight: 700,
    padding: "6px 12px",
    borderRadius: "7px",
    border: "1px solid #6b5a24",
    backgroundColor: "#3a3116",
    color: "#e0c97a",
    cursor: "pointer",
  },
  waitingNote: { fontSize: "12px", color: "#6f7684" },
  warn: { fontSize: "12px", color: "#c8a24a" },
  note: { fontSize: "12px", lineHeight: 1.5, color: "#8a919e" },
};
