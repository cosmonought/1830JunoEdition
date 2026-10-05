// frontend/src/components/PrivateCompaniesSection.tsx
//
// The Stock Round's Private Companies section, and its pointer in the consent-prompt slot.
//
// ==================================================================
//  6.5-B (K-01): WHERE A PLAYER SELLS A PRIVATE TO ANOTHER PLAYER, OR OFFERS TO BUY ONE
// ==================================================================
//
// OWNER RULING (K-01, 2026-09-28 04:04): during a Stock Round the current player may start a private-company
// transaction with another player in EITHER direction -- a sell offer on a private they own (they choose the recipient
// and the asking price) or a buy offer on a private another player owns (they choose the price; the owner is the
// recipient). The recipient accepts or rejects; the proposer may rescind. The authority has supported all of it since
// Batch 7.4 (D-24, #1593); this is the surface.
//
// PLACEMENT, as ruled: its own section at the bottom of the Stock Round panel, below the corporation listing -- NOT
// the Action Bar's trading UI and not a modal. One card per private company. The outstanding offer is shown ON ITS
// CARD, to every seat. The consent-prompt slot carries only a pointer to it (`PlayerPrivateTradePrompt`), so an
// offer cannot freeze the table unseen when its recipient is on another tab.
//
// PRESENTATIONAL. The shell hands a view computed from the board (`privateTradeSectionModel`) and a function that
// asks the authority's proposal predicate at the price typed; every greyed control carries that sentence. The three
// messages go out through the shell's handlers, unchanged in meaning: `ProposePrivateTrade`, `AnswerPrivateTrade`
// (off-turn, the consent-answer exemption), `RescindPrivateTrade`.

import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  ACTION_GREEN,
  ACTION_GREEN_BORDER,
  ACTION_GREEN_INK,
  CARD_BORDER,
  CARD_DIVIDER,
  CARD_INK,
  CARD_INK_FAINT,
  CARD_INK_MUTED,
  CARD_SURFACE,
} from "../styles/palette";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import {
  parseWholeDollars,
  PRICE_ENTRY_PROMPT,
  type PrivateTradeCardView,
  type PrivateTradeOfferView,
  type PrivateTradeSectionModel,
} from "../utils/stockRoundPrivateTrade";
// Phase 3 W2-F (OD-1, U-6): the one waiting line every consent / discard prompt prints.
import { WaitingOnLine } from "./WaitingOnLine";
// Phase 3 W3-I (AUD-19.01 / AUD-03.11): the room link's queue, as the shell reads it.
import { type LinkQueueView } from "../utils/useLinkQueue";

export interface PrivateTradeIntent {
  privateId: number;
  seller: string;
  buyer: string;
  price: number;
}

export interface PrivateCompaniesSectionProps {
  model: PrivateTradeSectionModel;
  /** The viewer's player id, or `null` for a seatless watcher. */
  viewer: string | null;
  /** Why this proposal would be refused right now, or `null` -- the authority's predicate with the viewer as the
   *  actor, already labelled for display. */
  proposalRefusal: (intent: PrivateTradeIntent) => string | null;
  onPropose: (intent: PrivateTradeIntent) => void;
  onAnswer: (privateId: number, accept: boolean) => void;
  onRescind: (privateId: number) => void;
  /** The session can act at all (the same first condition as the rest of the panel). */
  sessionReady: boolean;
  /** The viewer's last press has not landed yet (#1173). */
  actionInFlight?: boolean;
  /** Phase 3 W3-I (AUD-19.01 / I-1): the room link's queue (`linkQueueView`). While the link still holds this tab's last
   *  submission the section's controls take no second press, and the open form says why ("Queued — will send on
   *  reconnect." while it waits for a socket). Absent / idle: as before. */
  linkQueue?: LinkQueueView | null;
}

type Draft =
  | { privateId: number; mode: "sell"; recipient: string; price: string }
  | { privateId: number; mode: "buy"; price: string };

function ownerLine(card: PrivateTradeCardView): string {
  switch (card.owner.kind) {
    case "player":
      return card.owner.label;
    case "corporation":
      return `${card.owner.ticker} (a corporation; not for sale)`;
    case "closed":
      return "Closed";
    case "unsold":
      return "Unsold";
  }
}

export function PrivateCompaniesSection({
  model,
  viewer,
  proposalRefusal,
  onPropose,
  onAnswer,
  onRescind,
  sessionReady,
  actionInFlight = false,
  linkQueue = null,
}: PrivateCompaniesSectionProps) {
  const [draft, setDraft] = useState<Draft | null>(null);

  /* A half-typed offer belongs to the turn it was typed in and to a table with no offer standing: it closes when
     either stops being true, so the next seat never inherits a form. */
  const openersKey = model.cards.map((card) => `${card.privateId}:${card.control ?? "-"}`).join(",");
  useEffect(() => {
    setDraft((current) => {
      if (current === null) return null;
      const card = model.cards.find((entry) => entry.privateId === current.privateId);
      return card && card.control === current.mode ? current : null;
    });
  }, [openersKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The on-turn controls (propose, rescind) and the off-turn answer share the two conditions that are about the
     viewer's own session rather than the board. The board's conditions are already in the model. */
  const busyReason = !sessionReady
    ? "Initialize the session key to act."
    : /* Phase 3 W3-I: the link's own sentence first -- the shell's latch has a backstop and can release while the link
         still holds the submission, and "queued" says more than "sending". */
      linkQueue?.blocked === true
      ? linkQueue.reason
      : actionInFlight
        ? "Sending your last action — one moment."
        : null;

  /* Phase 3 W3-J (AUD-25.13 #1, W2-F's deferred LOW): THE OFFER COMES TO THE PLAYER WHO MUST ANSWER IT. This section is
     mounted exactly where the player-trade pointer stands aside (I-3: the Stocks tab with a Stock Round model), and it
     sits below the corporation listing -- so a recipient already on the Stocks tab lost the pointer and nothing brought
     the offer's card into view. When an offer THIS viewer must answer appears (`viewerRole` -- the seat authority's
     counterparty; a watcher or a scrubbed board is never one), its card is scrolled into view once per offer (the
     authority's instance), as the pointer's "Show on Stocks" does. No focus is moved. jsdom has no scrollIntoView. */
  const sectionRef = useRef<HTMLElement>(null);
  const scrolledForRef = useRef<string | null>(null);
  const answering = model.offer !== null && model.offer.viewerRole === "counterparty" ? model.offer : null;
  const answerCardId = answering?.privateId ?? null;
  const answerKey =
    answering === null
      ? null
      : `${answering.privateId}:${answering.instance ?? `${answering.proposer}:${answering.price}`}`;
  useEffect(() => {
    if (answerKey === null || answerCardId === null) {
      scrolledForRef.current = null;
      return;
    }
    if (scrolledForRef.current === answerKey) return;
    scrolledForRef.current = answerKey;
    sectionRef.current
      ?.querySelector<HTMLElement>(`[data-testid="private-trade-card-${answerCardId}"]`)
      ?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [answerKey, answerCardId]);

  return (
    <section ref={sectionRef} style={styles.section} aria-label="Private Companies" data-testid="private-companies-section">
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Private Companies</span>
        {!model.viewerSeated && <span style={styles.sectionHint}>Read only</span>}
      </div>
      {model.firstRoundNote && (
        <p style={styles.note} data-testid="private-trade-first-round">
          {model.firstRoundNote}
        </p>
      )}
      <div style={styles.grid}>
        {model.cards.map((card) => (
          <PrivateTradeCard
            key={card.privateId}
            card={card}
            model={model}
            viewer={viewer}
            draft={draft !== null && draft.privateId === card.privateId ? draft : null}
            setDraft={setDraft}
            busyReason={busyReason}
            proposalRefusal={proposalRefusal}
            onPropose={onPropose}
            onAnswer={onAnswer}
            onRescind={onRescind}
          />
        ))}
      </div>
    </section>
  );
}

function PrivateTradeCard({
  card,
  model,
  viewer,
  draft,
  setDraft,
  busyReason,
  proposalRefusal,
  onPropose,
  onAnswer,
  onRescind,
}: {
  card: PrivateTradeCardView;
  model: PrivateTradeSectionModel;
  viewer: string | null;
  draft: Draft | null;
  setDraft: React.Dispatch<React.SetStateAction<Draft | null>>;
  busyReason: string | null;
  proposalRefusal: (intent: PrivateTradeIntent) => string | null;
  onPropose: (intent: PrivateTradeIntent) => void;
  onAnswer: (privateId: number, accept: boolean) => void;
  onRescind: (privateId: number) => void;
}) {
  const inactive = card.owner.kind === "closed";
  return (
    <div
      style={{ ...styles.card, ...(inactive ? styles.cardInactive : {}), ...(card.offer ? styles.cardOffer : {}) }}
      data-testid={`private-trade-card-${card.privateId}`}
      id={`private-trade-card-${card.privateId}`}
    >
      <div style={styles.cardHeader}>
        <span style={styles.cardName}>
          {card.acronym && <span style={styles.acronym}>{card.acronym}</span>}
          {card.name}
        </span>
        <span style={styles.figures}>
          {card.faceValue !== null && <span>Face ${card.faceValue}</span>}
          {card.revenue !== null && <span>Revenue ${card.revenue}/OR</span>}
        </span>
      </div>
      {card.powerSummary && <p style={styles.power}>{card.powerSummary}</p>}
      <div style={styles.ownerRow}>
        <span style={styles.ownerLabel}>Owner</span>
        <span style={styles.ownerValue} data-testid={`private-trade-owner-${card.privateId}`}>
          {ownerLine(card)}
        </span>
      </div>

      {card.offer && (
        <OfferBlock offer={card.offer} busyReason={busyReason} onAnswer={onAnswer} onRescind={onRescind} />
      )}

      {card.control !== null && draft === null && (
        <div style={styles.actions}>
          <button
            type="button"
            data-testid={`private-trade-${card.control}-${card.privateId}`}
            style={{
              ...styles.button,
              ...(card.controlRefusal !== null || busyReason !== null ? styles.buttonDisabled : {}),
            }}
            disabled={card.controlRefusal !== null || busyReason !== null}
            title={card.controlRefusal ?? busyReason ?? undefined}
            onClick={() =>
              setDraft(
                card.control === "sell"
                  ? {
                      privateId: card.privateId,
                      mode: "sell",
                      recipient: model.recipients[0]?.address ?? "",
                      price: "",
                    }
                  : { privateId: card.privateId, mode: "buy", price: "" },
              )
            }
          >
            {card.control === "sell" ? "Sell…" : "Buy…"}
          </button>
        </div>
      )}

      {card.control !== null && draft !== null && viewer !== null && card.owner.kind === "player" && (
        <OfferForm
          card={card}
          model={model}
          viewer={viewer}
          owner={card.owner.address}
          draft={draft}
          setDraft={setDraft}
          busyReason={busyReason}
          proposalRefusal={proposalRefusal}
          onPropose={onPropose}
        />
      )}
    </div>
  );
}

function OfferForm({
  card,
  model,
  viewer,
  owner,
  draft,
  setDraft,
  busyReason,
  proposalRefusal,
  onPropose,
}: {
  card: PrivateTradeCardView;
  model: PrivateTradeSectionModel;
  viewer: string;
  owner: string;
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft | null>>;
  busyReason: string | null;
  proposalRefusal: (intent: PrivateTradeIntent) => string | null;
  onPropose: (intent: PrivateTradeIntent) => void;
}) {
  const price = parseWholeDollars(draft.price);
  /* THE DIRECTION IS THE WHOLE POINT. A sell offer: the viewer is the seller and the chosen recipient the buyer.
     A buy offer: the displayed owner is the seller (the recipient) and the viewer the buyer. */
  const intent: PrivateTradeIntent | null =
    price === null
      ? null
      : draft.mode === "sell"
        ? { privateId: card.privateId, seller: viewer, buyer: draft.recipient, price }
        : { privateId: card.privateId, seller: owner, buyer: viewer, price };
  const refusal = intent === null ? PRICE_ENTRY_PROMPT : (busyReason ?? proposalRefusal(intent));
  /* Phase 3 W3-I (AUD-03.11 / R4): THE TYPED FORM IS KEPT. The Send used to close it (`setDraft(null)`) at the press, so
     a proposal the link dropped -- or one refused -- took the typed recipient and price with it. The form now stays
     until the proposal lands: an offer standing on the board withdraws every opener, and the section's own effect then
     closes the draft (the `openersKey` reset above). Until then it is greyed by `busyReason` -- the shell's latch and
     the link's queue -- and if the send does not land it is simply live again, with what was typed.
     `sendLatch` covers the one window those cannot: a second press in the same task, before React has committed the
     first (W2-C's `submitLatch`, for the same reason). Released after the next commit. */
  const sendLatch = useRef(false);
  const [, setSendCommit] = useState(0);
  useEffect(() => {
    sendLatch.current = false;
  });

  /* Each recipient, at the price typed, says why they could not take it -- cash or the certificate limit. */
  const recipientNotes = useMemo(() => {
    if (draft.mode !== "sell" || price === null) return new Map<string, string | null>();
    return new Map(
      model.recipients.map((recipient) => [
        recipient.address,
        proposalRefusal({ privateId: card.privateId, seller: viewer, buyer: recipient.address, price }),
      ]),
    );
  }, [draft.mode, price, model.recipients, proposalRefusal, card.privateId, viewer]);

  return (
    <div style={styles.form} data-testid={`private-trade-form-${card.privateId}`}>
      {draft.mode === "sell" ? (
        <label style={styles.field}>
          <span style={styles.fieldLabel}>Sell to</span>
          <select
            data-testid="private-trade-recipient"
            value={draft.recipient}
            style={styles.input}
            onChange={(event) => setDraft({ ...draft, recipient: event.target.value })}
          >
            {model.recipients.map((recipient) => {
              const note = recipientNotes.get(recipient.address) ?? null;
              return (
                <option key={recipient.address} value={recipient.address}>
                  {note ? `${recipient.label} — ${note}` : recipient.label}
                </option>
              );
            })}
          </select>
        </label>
      ) : (
        <div style={styles.field}>
          <span style={styles.fieldLabel}>Offer to</span>
          <span style={styles.ownerValue}>{card.owner.kind === "player" ? card.owner.label : ""}</span>
        </div>
      )}
      <label style={styles.field}>
        <span style={styles.fieldLabel}>{draft.mode === "sell" ? "Asking price" : "Offered price"}</span>
        <span style={styles.priceBox}>
          <span aria-hidden="true">$</span>
          <input
            data-testid="private-trade-price"
            type="text"
            inputMode="numeric"
            placeholder="0"
            value={draft.price}
            style={{ ...styles.input, ...styles.priceInput }}
            onChange={(event) => setDraft({ ...draft, price: event.target.value })}
          />
        </span>
      </label>
      <span style={styles.formNote}>Any whole-dollar price, $0 included — the corporation price band does not apply.</span>
      {refusal !== null && (
        <span style={styles.refusal} data-testid="private-trade-refusal">
          {refusal}
        </span>
      )}
      <div style={styles.actions}>
        <button
          type="button"
          data-testid="private-trade-send"
          style={{ ...styles.button, ...styles.primary, ...(refusal !== null ? styles.buttonDisabled : {}) }}
          disabled={refusal !== null}
          title={refusal ?? undefined}
          onClick={() => {
            if (intent === null || refusal !== null || sendLatch.current) return;
            sendLatch.current = true;
            setSendCommit((count) => count + 1);
            onPropose(intent);
          }}
        >
          Send Offer
        </button>
        <button type="button" data-testid="private-trade-cancel" style={styles.button} onClick={() => setDraft(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function OfferBlock({
  offer,
  busyReason,
  onAnswer,
  onRescind,
}: {
  offer: PrivateTradeOfferView;
  busyReason: string | null;
  onAnswer: (privateId: number, accept: boolean) => void;
  onRescind: (privateId: number) => void;
}) {
  const acceptBlocked = busyReason ?? offer.acceptRefusal;
  return (
    <div style={styles.offer} role="status" data-testid={`private-trade-offer-${offer.privateId}`}>
      <span style={styles.offerTag}>{offer.direction === "sell" ? "Sell offer" : "Buy offer"}</span>
      <p style={styles.offerText}>{offer.summary}</p>
      {offer.viewerRole === "counterparty" && (
        <>
          {offer.acceptRefusal !== null && (
            <span style={styles.refusal} data-testid="private-trade-accept-refusal">
              {offer.acceptRefusal}
            </span>
          )}
          <div style={styles.actions}>
            <button
              type="button"
              data-testid="private-trade-reject"
              style={{ ...styles.button, ...(busyReason !== null ? styles.buttonDisabled : {}) }}
              disabled={busyReason !== null}
              title={busyReason ?? undefined}
              onClick={() => onAnswer(offer.privateId, false)}
            >
              Reject
            </button>
            <button
              type="button"
              data-testid="private-trade-accept"
              style={{ ...styles.button, ...styles.primary, ...(acceptBlocked !== null ? styles.buttonDisabled : {}) }}
              disabled={acceptBlocked !== null}
              title={acceptBlocked ?? `Accept: ${offer.buyerLabel} pays ${offer.sellerLabel} $${offer.price}.`}
              onClick={() => onAnswer(offer.privateId, true)}
            >
              Accept
            </button>
          </div>
        </>
      )}
      {offer.viewerRole === "proposer" && (
        <div style={styles.actions}>
          <button
            type="button"
            data-testid="private-trade-rescind"
            style={{ ...styles.button, ...(busyReason !== null ? styles.buttonDisabled : {}) }}
            disabled={busyReason !== null}
            title={busyReason ?? "Withdraw your offer."}
            onClick={() => onRescind(offer.privateId)}
          >
            Rescind
          </button>
        </div>
      )}
    </div>
  );
}

/* ==================================================================
    THE POINTER IN THE CONSENT SLOT
   ==================================================================
   The card is the primary surface. This is what makes the offer impossible to miss from another tab: the standing
   offer holds the whole table, so every seat is told who it waits on; the recipient also gets the answer here, the
   proposer the withdrawal, and everybody a way back to the card. Nobody else gets an answer control (K-09's rule). */
export interface PlayerPrivateTradePromptProps {
  offer: PrivateTradeOfferView | null;
  /** Session readiness for the recipient's answer and the proposer's withdrawal, as on the card. */
  answerBlockedReason: string | null;
  onAnswer: (privateId: number, accept: boolean) => void;
  /** The proposer's `RescindPrivateTrade`, one click from any tab. */
  onRescind: (privateId: number) => void;
  onShowCard: (privateId: number) => void;
  /** Phase 3 W2-F (OD-1, U-6): the hold's own sentence (`dockHold.turnHoldReason`) for the one waiting line. */
  waitingSentence?: string | null;
  /** Phase 3 W2-F (AUD-03.10 / I-3): `true` while the Private Companies section itself is on screen (the Stocks tab in
   *  a Stock Round). That section is this offer's primary surface -- the offer on its own card with the same answer and
   *  withdrawal, and the hold's sentence above the share controls -- so the fixed pointer stands aside there instead of
   *  covering a card. Everywhere else it shows exactly as before. */
  standAside?: boolean;
}

export function PlayerPrivateTradePrompt({
  offer,
  answerBlockedReason,
  onAnswer,
  onRescind,
  onShowCard,
  waitingSentence = null,
  standAside = false,
}: PlayerPrivateTradePromptProps) {
  if (!offer || standAside) return null;
  const isRecipient = offer.viewerRole === "counterparty";
  const acceptBlocked = answerBlockedReason ?? offer.acceptRefusal;
  return (
    <div style={styles.promptRoot} role="alertdialog" aria-label="Private company trade offer" data-testid="player-private-trade-prompt">
      <div style={styles.promptHeader}>
        <span style={styles.promptDot} aria-hidden="true" />
        <span style={styles.promptTitle}>{isRecipient ? "Offer received" : "Private company offer"}</span>
      </div>
      <p style={styles.promptBody}>{offer.summary}</p>
      {/* Phase 3 W2-F (OD-1, U-6): the one waiting line; the proposer's withdrawal is the Rescind button below. */}
      <WaitingOnLine
        who={isRecipient ? "you" : offer.counterpartyLabel}
        viewerDecides={isRecipient}
        sentence={waitingSentence}
        style={styles.promptWho}
      />
      {isRecipient && offer.acceptRefusal !== null && <p style={styles.promptRefusal}>{offer.acceptRefusal}</p>}
      <div style={styles.promptActions}>
        <button type="button" data-testid="player-private-trade-show" style={styles.promptButton} onClick={() => onShowCard(offer.privateId)}>
          Show on Stocks
        </button>
        {offer.viewerRole === "proposer" && (
          <button
            type="button"
            data-testid="player-private-trade-rescind"
            style={{ ...styles.promptButton, ...(answerBlockedReason !== null ? styles.buttonDisabled : {}) }}
            disabled={answerBlockedReason !== null}
            title={answerBlockedReason ?? "Withdraw your offer."}
            onClick={() => onRescind(offer.privateId)}
          >
            Rescind
          </button>
        )}
        {isRecipient && (
          <>
            <button
              type="button"
              data-testid="player-private-trade-reject"
              style={{ ...styles.promptButton, ...styles.promptReject, ...(answerBlockedReason !== null ? styles.buttonDisabled : {}) }}
              disabled={answerBlockedReason !== null}
              title={answerBlockedReason ?? undefined}
              onClick={() => onAnswer(offer.privateId, false)}
            >
              Reject
            </button>
            <button
              type="button"
              data-testid="player-private-trade-accept"
              style={{ ...styles.promptButton, ...styles.promptAccept, ...(acceptBlocked !== null ? styles.buttonDisabled : {}) }}
              disabled={acceptBlocked !== null}
              title={acceptBlocked ?? undefined}
              onClick={() => onAnswer(offer.privateId, true)}
            >
              Accept
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "6px" },
  sectionHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px" },
  sectionTitle: { fontSize: FONT_SIZE.strong, fontWeight: 700, color: "#f2f0eb" },
  sectionHint: { fontSize: FONT_SIZE.micro, color: "#8a8a86", textTransform: "uppercase", letterSpacing: "0.06em" },
  note: { margin: 0, fontSize: FONT_SIZE.small, color: "#c9a94c", fontWeight: 600 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "10px" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 12px",
    boxSizing: "border-box",
    backgroundColor: CARD_SURFACE,
    /* Longhands, never the `border` shorthand: `cardOffer` overlays `borderColor` (#1449). */
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: CARD_BORDER,
    borderRadius: RADIUS.card,
    color: CARD_INK,
    minWidth: 0,
  },
  cardInactive: { opacity: 0.6 },
  cardOffer: { borderColor: "#c9a94c", boxShadow: "0 0 0 1px #c9a94c inset" },
  cardHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" },
  cardName: { fontSize: FONT_SIZE.body, fontWeight: 700, display: "inline-flex", gap: "6px", alignItems: "baseline" },
  acronym: { fontSize: FONT_SIZE.micro, fontWeight: 700, letterSpacing: "0.06em", color: CARD_INK_MUTED },
  figures: { display: "inline-flex", gap: "10px", fontSize: FONT_SIZE.small, color: CARD_INK_MUTED, fontVariantNumeric: "tabular-nums" },
  power: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: 1.35, color: CARD_INK_MUTED },
  ownerRow: { display: "flex", gap: "8px", alignItems: "baseline", borderTop: `1px solid ${CARD_DIVIDER}`, paddingTop: "6px" },
  ownerLabel: { fontSize: FONT_SIZE.micro, textTransform: "uppercase", letterSpacing: "0.06em", color: CARD_INK_FAINT },
  ownerValue: { fontSize: FONT_SIZE.small, fontWeight: 700, color: CARD_INK },
  offer: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "8px",
    borderRadius: RADIUS.card,
    backgroundColor: "rgba(201, 169, 76, 0.12)",
  },
  offerTag: { fontSize: FONT_SIZE.micro, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#8a6d1f" },
  offerText: { margin: 0, fontSize: FONT_SIZE.small, lineHeight: 1.4, color: CARD_INK },
  actions: { display: "flex", gap: "8px", flexWrap: "wrap" },
  button: {
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    padding: "6px 12px",
    borderRadius: RADIUS.card,
    // Longhands: `primary` overlays `borderColor` (#1449).
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a3a3a",
    backgroundColor: "#1c1c1c",
    color: "#f2f0eb",
    cursor: "pointer",
  },
  primary: { backgroundColor: ACTION_GREEN, borderColor: ACTION_GREEN_BORDER, color: ACTION_GREEN_INK },
  buttonDisabled: { opacity: 0.45, cursor: "not-allowed" },
  form: { display: "flex", flexDirection: "column", gap: "6px" },
  field: { display: "flex", flexDirection: "column", gap: "2px" },
  fieldLabel: { fontSize: FONT_SIZE.micro, textTransform: "uppercase", letterSpacing: "0.06em", color: CARD_INK_FAINT },
  input: { fontSize: FONT_SIZE.small, padding: "4px 6px", borderRadius: RADIUS.control, border: `1px solid ${CARD_DIVIDER}`, minWidth: 0 },
  priceBox: { display: "inline-flex", alignItems: "center", gap: "4px" },
  priceInput: { width: "90px", fontVariantNumeric: "tabular-nums" },
  formNote: { fontSize: FONT_SIZE.micro, color: CARD_INK_FAINT },
  refusal: { fontSize: FONT_SIZE.micro, lineHeight: 1.4, color: "#a0561f" },
  /* The consent slot's shape and register, copied from `PrivateTradePrompt` / `TrainTradePrompt` (#932: an Action
     Required alert in the corner), so a player learns one affordance for "somebody is asking you to agree". */
  promptRoot: {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    zIndex: 65,
    width: "min(400px, calc(100vw - 40px))",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "14px 16px",
    borderRadius: RADIUS.layer,
    border: "2px solid #c9a227",
    backgroundColor: "#2a2415",
    boxShadow: "0 10px 34px rgba(0,0,0,0.6), 0 0 18px rgba(201, 162, 39, 0.35)",
  },
  promptHeader: { display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" },
  promptDot: { width: "9px", height: "9px", borderRadius: RADIUS.pill, backgroundColor: "#e6cf7a", flexShrink: 0 },
  promptTitle: { fontSize: FONT_SIZE.small, fontWeight: 800, color: "#e6cf7a", textTransform: "uppercase", letterSpacing: "0.06em" },
  promptBody: { margin: 0, fontSize: FONT_SIZE.body, color: "#f0e6cc", lineHeight: 1.5 },
  promptWho: { margin: 0, fontSize: FONT_SIZE.small, color: "#c4b384" },
  promptRefusal: { margin: 0, fontSize: FONT_SIZE.small, color: "#f0b27a", lineHeight: 1.45 },
  promptActions: { display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" },
  promptButton: {
    padding: "7px 16px",
    borderRadius: RADIUS.card,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#6b5a2a",
    backgroundColor: "#1c1c1c",
    color: "#f0e6cc",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  promptAccept: { backgroundColor: ACTION_GREEN, borderColor: ACTION_GREEN_BORDER, color: ACTION_GREEN_INK },
  promptReject: { backgroundColor: "#3a1f22", borderColor: "#b91c1c", color: "#fda4af" },
};

export default PrivateCompaniesSection;
