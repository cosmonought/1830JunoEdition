// frontend/src/components/PrivateTradePanel.tsx
//
// The Private Company trade engine: a corporation proposes, the owner
// consents.
//
// ===================================================================
//  DESIGN NOTE 0: THE CONSENT STEP IS NOT ON CHAIN YET -- READ THIS
// ===================================================================
//
// In 1830 a corporation buying a private company from a player is a
// NEGOTIATION. Both sides must agree: the president names a price, the
// owner takes it or refuses. This component implements that.
//
// `ExecuteMsg::BuyPrivateCompany { game_id, protocol_id, private_id, price }`
// DOES NOT. It is single-party -- `trading.rs::execute_buy_private_company`
// authorises the buying corporation's president, checks the phase gate, the
// sub-phase cursor, the treasury and the price band, and then moves the
// private. The seller is read (`private.owner`) but never asked.
//
// So the proposal below is CLIENT-SIDE STATE, and the two deployments
// differ in what that can honestly mean:
//
//   SANDBOX -- the local reducer is the only authority there is, so the
//   full two-party flow is real. The proposal is raised, the prompt
//   appears, and accepting settles the trade. Nothing is being faked
//   relative to an authority, because there is no other authority.
//
//   A LIVE ROOM -- the seller CANNOT be sent this proposal. No message
//   carries it and no query surfaces it, so their client would never learn
//   it exists. Showing them an Accept button would be theatre. The prompt
//   is therefore shown to the PROPOSER and labelled as what it actually is:
//   a confirmation step before a purchase the contract will execute
//   unilaterally. `onConfirmUnilateral` is deliberately named to make a
//   call site that treats it as consent look wrong.
//
// THE BACKEND SHAPE THIS NEEDS ALREADY EXISTS, one feature over. Train
// trading between corporations with different presidents records a
// `TrainOffer` and waits for `AcceptTrainOffer`/`RejectTrainOffer`, with
// `RescindTrainOffer` and a `GetTrainOffers` query
// (`msg.rs`). A `PrivateCompanyOffer` mirroring it would make this
// component's live path as real as its sandbox one. That is a backend
// change and out of scope here; recorded so the gap is actionable rather
// than merely known.
//
// ===================================================================
//  DESIGN NOTE 1: THE PRICE BAND IS MIRRORED, NOT INVENTED
// ===================================================================
//
// `trading.rs`: "Pricing guardrails: `price` must land in [50%, 200%] of
// face value". The input below clamps to the same band and says so, so a
// player finds out at the point of typing rather than from a rejected
// transaction.
//
// This is client-side validation of a rule the contract also enforces --
// ordinarily the thing this codebase avoids. It is acceptable HERE for the
// same reason `evaluateHexForTileLaying`'s four gates are (`hexGeometry.ts`
// design note on click eligibility): the band is a STATIC arithmetic
// property of one number, not a stateful judgement about the board. It
// cannot go stale between render and dispatch, and the contract still has
// the final say.

import React, { useMemo, useState } from "react";

import type { PrivateCompanyState } from "../utils/gameState";
import { FONT_SIZE } from "../styles/typography";
import { corporateSaleBlockReason } from "../utils/baltimorePrivate";
import { PRIVATE_COMPANY_CATALOG } from "../utils/privateCatalog";

/** A live proposal. Client-side only -- design note #0. */
export interface PrivateTradeProposal {
  privateId: number;
  privateName: string;
  /** The wallet that owns it, and therefore the party whose consent 1830
   *  requires. */
  ownerAddress: string;
  /** Display name for the owner, when one is known. */
  ownerLabel: string;
  buyerProtocolId: number;
  buyerTicker: string;
  price: number;
}

/** The band the contract enforces, mirrored -- design note #1. */
export const PRIVATE_PRICE_MIN_FACTOR = 0.5;
export const PRIVATE_PRICE_MAX_FACTOR = 2;

export function privatePriceBounds(faceValue: number): { min: number; max: number } {
  // Integer VGP either side. `ceil` on the floor and `floor` on the ceiling
  // so a rounded bound can never fall OUTSIDE the band the contract checks
  // -- rounding the other way would offer a price that looks legal here and
  // is rejected on chain, which is the one failure this mirror exists to
  // prevent.
  return {
    min: Math.ceil(faceValue * PRIVATE_PRICE_MIN_FACTOR),
    max: Math.floor(faceValue * PRIVATE_PRICE_MAX_FACTOR),
  };
}

/* ==================================================================
 *  DESIGN NOTE 660a: `eligiblePrivatesForPurchase` DELETED
 * ==================================================================
 *
 * Found while adding the B&O sale ban to it. Nothing called it. The modal
 * renders from `purchasablePrivatesInPlay` -- the LOOSE list, which shows an
 * unsold or unbuyable private as an inert row -- and decides what may
 * actually be proposed by resolving the selection against
 * `privatePurchaseBlockReason`. This function was a third answer to a
 * question already answered twice, and the ban had been added to the one
 * copy no player could reach.
 *
 * Which is the exact failure this codebase keeps rediscovering, caught this
 * time by asking who the caller was before trusting the fix: a rule can be
 * written, tested, and enforced in a function that never runs. `tsc` and
 * ESLint are both content -- the export is used, by the test that was
 * written to prove the rule.
 *
 * THE RULE STILL HOLDS, in the two places that matter.
 * `privatePurchaseBlockReason` refuses the selection so the price field and
 * the propose button never address the B&O, and `applySandboxAction` refuses
 * the message even if one is somehow written. UI and reducer, which is where
 * design note #660 said it should be.
 *
 * THE B&O IS STILL SHOWN, inert, with its reason and its power text. Design
 * note #386's argument for rendering an unbuyable row -- "the whole point of
 * showing it is that the player learns the private exists" -- applies more
 * strongly to a certificate no corporation may ever buy, not less. Hiding it
 * would leave a player wondering where it went. */

/**
 * Privates the step is ABOUT -- everything still in play.
 *
 * ==================================================================
 *  DESIGN NOTE 386: SHOW THE UNSOLD ONES, DISABLED
 * ==================================================================
 *
 * REPORTED: the sub-phase should display all available private companies --
 * those not closed and not already owned by another corporation -- clearly
 * marking which player owns them.
 *
 * `eligiblePrivatesForPurchase` above answers a narrower question: which
 * ones can a corporation propose for RIGHT NOW. It excludes privates still
 * unsold in the auction, because there is no seller to agree, and that
 * exclusion is correct for dispatch. It was wrong for DISPLAY, and the
 * difference is what a player learns from an empty list:
 *
 *   FILTERED OUT   "No private company is available" -- which reads as
 *                  "there are none", when there may be four sitting in the
 *                  auction that this corporation could buy next round.
 *   SHOWN, DISABLED "C&SL -- unsold in the auction" -- which is the actual
 *                  state of the game, and tells the player where the
 *                  private went and what has to change.
 *
 * So this returns the wider set and the picker renders both, with the
 * un-proposable ones inert and captioned. The two functions stay separate
 * rather than one function with a flag, because they answer genuinely
 * different questions and the dispatch path must keep using the strict one
 * -- a display predicate that quietly became the legality predicate is
 * exactly how an unsendable proposal reaches the chain.
 */
export function purchasablePrivatesInPlay(
  privates: readonly PrivateCompanyState[],
): PrivateCompanyState[] {
  return privates.filter((entry) => !entry.closed && entry.owner_protocol_id === null);
}

/** Why this private cannot be proposed for, or `null` when it can be.
 *  One sentence per reason, at the row that carries it. */
export function privatePurchaseBlockReason(entry: PrivateCompanyState): string | null {
  /* Design note #660: checked FIRST, because it is the reason that cannot
     change. "Still unsold" describes a moment; the B&O ban describes the
     certificate, and telling a player to wait for an owner on a private no
     corporation may ever buy would be worse than saying nothing. */
  const corporateBan = corporateSaleBlockReason(entry);
  if (corporateBan) return corporateBan;
  if (entry.owner === null) {
    return "Still unsold in the private auction — no owner to sell it yet.";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Propose                                                            */
/* ------------------------------------------------------------------ */

export interface ProposePrivatePurchaseProps {
  open: boolean;
  buyerTicker: string;
  privates: readonly PrivateCompanyState[];
  /** Renders a wallet as a readable name. */
  labelForAddress: (address: string) => string;
  /** The buying corporation's treasury, so an unaffordable price is caught
   *  before it is proposed. */
  treasury: number;
  onPropose: (privateId: number, price: number) => void;
  onClose: () => void;
}

export function ProposePrivatePurchase({
  open,
  buyerTicker,
  privates,
  labelForAddress,
  treasury,
  onPropose,
  onClose,
}: ProposePrivatePurchaseProps) {
  // Design note #386: the wider set for DISPLAY. `selectable` below is still
  // the strict predicate, and it is what gates the row and the submit.
  const eligible = useMemo(() => purchasablePrivatesInPlay(privates), [privates]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [priceText, setPriceText] = useState("");
  /* Design note #661: which rows have their full power text open. A SET, not
     a single id, because comparing two privates is the reason a player opens
     one at all -- an accordion that closes the D&H to show the C&StL defeats
     the comparison it was opened for. */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(() => new Set());

  /* Design note #386: a row that cannot be proposed for cannot be the
     selection either. Resolving `selected` against the STRICT list means an
     unsold private can be shown and read without ever becoming the subject
     of the price field and the submit button below. */
  const selected =
    eligible.find(
      (entry) => entry.private_id === selectedId && privatePurchaseBlockReason(entry) === null,
    ) ?? null;
  const faceValue = selected ? Number(selected.cost) : 0;
  const bounds = privatePriceBounds(faceValue);
  const price = Number(priceText);

  // Each failure named separately. "Invalid price" would leave the player
  // guessing which of four things was wrong.
  const priceProblem: string | null = !selected
    ? "Choose a private company first."
    : priceText.trim() === ""
      ? `Enter a price between $${bounds.min} and $${bounds.max}.`
      : !Number.isFinite(price) || !Number.isInteger(price)
        ? "Price must be a whole number."
        : price < bounds.min
          ? `$${price} is below 50% of face value ($${bounds.min} minimum).`
          : price > bounds.max
            ? `$${price} is above 200% of face value ($${bounds.max} maximum).`
            : price > treasury
              ? `${buyerTicker}'s treasury holds $${treasury} — it cannot pay $${price}.`
              : null;

  if (!open) return null;

  return (
    <div
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Propose a private company purchase"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div style={styles.card}>
        <div style={styles.header}>
          <span style={styles.heading}>{buyerTicker} proposes a purchase</span>
          <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close">
            &#10006;
          </button>
        </div>

        <p style={styles.body}>
          A corporation may buy a private company from its owner between 50% and 200% of face
          value. The owner has to agree.
        </p>

        {eligible.length === 0 ? (
          <p style={styles.empty}>
            No private company is available. Every one is either already owned by a corporation,
            closed, or still unsold in the auction.
          </p>
        ) : (
          <div style={styles.list}>
            {eligible.map((entry) => {
              const isSelected = entry.private_id === selectedId;
              const entryBounds = privatePriceBounds(Number(entry.cost));
              // Design note #386: shown either way, inert when it cannot be
              // bought, and captioned with the reason.
              const blocked = privatePurchaseBlockReason(entry);
              const catalog = PRIVATE_COMPANY_CATALOG[entry.private_id];
              const isExpanded = expandedIds.has(entry.private_id);
              const detailId = `private-power-${entry.private_id}`;
              return (
                /* ==================================================
                     DESIGN NOTE 661: THE ROW IS A GROUP, NOT A BUTTON
                    ==================================================

                   The whole row used to BE the `<button>`, which was fine
                   while selecting was the only thing it did. It now carries
                   a second control -- the power disclosure -- and a button
                   inside a button is invalid markup that browsers repair by
                   unnesting, which would have put the toggle outside the row
                   it belongs to.

                   So the row is a container with two real buttons in it: the
                   selectable face, and the disclosure. A player can read what
                   a private DOES without selecting it, which is the point --
                   the old row made "tell me more" and "I choose this" the
                   same click. */
                <div
                  key={entry.private_id}
                  style={{
                    ...styles.rowGroup,
                    ...(isSelected && blocked === null ? styles.rowGroupSelected : {}),
                    ...(blocked !== null ? styles.rowGroupBlocked : {}),
                  }}
                >
                  <button
                    type="button"
                    disabled={blocked !== null}
                    title={blocked ?? undefined}
                    onClick={() => {
                      setSelectedId(entry.private_id);
                      // Seed at face value: the neutral offer, and the one a
                      // player most often wants. Starting blank makes them
                      // type a number before they can see whether it is in
                      // range.
                      setPriceText(String(entry.cost));
                    }}
                    style={{
                      ...styles.row,
                      ...(blocked !== null ? styles.rowBlocked : {}),
                    }}
                  >
                    <span style={styles.rowName}>
                      {entry.name}
                      {catalog && <span style={styles.rowAcronym}>{catalog.acronym}</span>}
                    </span>
                    <span style={styles.rowBand}>
                      {blocked === null
                        ? `$${entryBounds.min} - $${entryBounds.max}`
                        : "not for sale"}
                    </span>
                    <span style={styles.rowMeta}>
                      face ${entry.cost} &middot; pays ${entry.revenue_per_or}/OR
                    </span>
                    {/* Design note #386: WHO HOLDS IT, named. This is the
                        requirement's "clearly marking which player currently
                        owns them" -- and for an unsold private it is also the
                        explanation for why the row is inert, so the two facts
                        are one line rather than two. */}
                    <span style={styles.rowOwner}>
                      {entry.owner
                        ? `held by ${labelForAddress(entry.owner)}`
                        : "unsold in the auction"}
                    </span>
                    {/* Design note #661: the POWER, on the face of the row.
                        A player choosing between six privates is choosing
                        between six powers, and the face of the row named
                        every other attribute -- price, revenue, owner, band
                        -- except the one the decision turns on. */}
                    {catalog && (
                      <span style={styles.rowPower}>{catalog.abilitySummary}</span>
                    )}
                  </button>
                  {catalog && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedIds((open) => {
                          const next = new Set(open);
                          if (!next.delete(entry.private_id)) next.add(entry.private_id);
                          return next;
                        })
                      }
                      aria-expanded={isExpanded}
                      aria-controls={detailId}
                      style={styles.rowDisclosure}
                    >
                      {/* Not gated on `blocked`. An unsold private, or the
                          B&O a corporation may never buy, still has a power
                          worth reading -- design note #386's reason for
                          showing the row at all applies to its rules too. */}
                      {isExpanded ? "\u25B4 Less" : "\u25BE Full rules"}
                    </button>
                  )}
                  {catalog && isExpanded && (
                    <p id={detailId} style={styles.rowDetail}>
                      {catalog.ability}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {selected && (
          <label style={styles.priceRow}>
            <span style={styles.priceLabel}>Offer price</span>
            <input
              type="number"
              inputMode="numeric"
              value={priceText}
              min={bounds.min}
              max={bounds.max}
              step={1}
              onChange={(event) => setPriceText(event.target.value)}
              style={styles.priceInput}
              aria-label={`Offer price, between ${bounds.min} and ${bounds.max}`}
            />
            <span style={styles.priceBand}>
              ${bounds.min} - ${bounds.max}
            </span>
          </label>
        )}

        {priceProblem && selectedId !== null && (
          <p style={styles.problem}>{priceProblem}</p>
        )}

        <div style={styles.footer}>
          <button type="button" style={styles.secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={{
              ...styles.primaryButton,
              ...(priceProblem ? styles.buttonDisabled : {}),
            }}
            disabled={priceProblem !== null}
            onClick={() => {
              if (priceProblem || !selected) return;
              onPropose(selected.private_id, price);
            }}
            title={priceProblem ?? `Offer $${price} for ${selected?.name}.`}
          >
            Propose Purchase
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Accept / reject                                                    */
/* ------------------------------------------------------------------ */

export interface PrivateTradePromptProps {
  proposal: PrivateTradeProposal | null;
  /** True when the viewer is the private's owner -- i.e. the party 1830
   *  says must answer. In sandbox this is forced true so one person can
   *  drive both sides (design note #2). */
  viewerIsOwner: boolean;
  /** Design note #0: `false` in a live room, where accepting cannot record
   *  the seller's consent because no message carries it. Changes the
   *  wording from a negotiation to a confirmation -- it does NOT change who
   *  may click. */
  consentIsBinding: boolean;
  onAccept: () => void;
  onReject: () => void;
}

/* ===================================================================
 *  DESIGN NOTE 2: WHY SANDBOX LETS ONE PERSON ANSWER THEIR OWN OFFER
 * ===================================================================
 *
 * A hotseat sandbox has one wallet and one human. Requiring the owner's
 * client to answer would make this flow untestable there -- which is the
 * one place it most needs to be testable, since it is the only place the
 * whole two-party sequence can currently run end to end.
 *
 * So in sandbox the prompt is shown to whoever is looking, and the seat
 * switcher already establishes that "who you are" is a local choice there.
 * The prompt still NAMES the owner, so the person clicking Accept is
 * always told whose decision they are standing in for.
 */
export function PrivateTradePrompt({
  proposal,
  viewerIsOwner,
  consentIsBinding,
  onAccept,
  onReject,
}: PrivateTradePromptProps) {
  if (!proposal) return null;

  return (
    <div style={styles.promptRoot} role="alertdialog" aria-label="Private company offer">
      <div style={styles.promptHeader}>
        <span style={styles.promptDot} aria-hidden="true" />
        <span style={styles.promptTitle}>
          {consentIsBinding ? "Offer received" : "Confirm purchase"}
        </span>
      </div>

      <p style={styles.promptBody}>
        <strong>{proposal.buyerTicker}</strong> wants to buy{" "}
        <strong>{proposal.privateName}</strong> for <strong>${proposal.price}</strong>.
      </p>

      <p style={styles.promptWho}>
        {viewerIsOwner
          ? `This is ${proposal.ownerLabel}'s decision.`
          : `Waiting on ${proposal.ownerLabel}.`}
      </p>

      {/* Design note #0: stated plainly rather than implied by a greyed
          control. A player told this is a negotiation, whose counterparty
          was never actually asked, has been misled by the UI. */}
      {!consentIsBinding && (
        <p style={styles.promptCaveat}>
          The contract executes this purchase directly — `BuyPrivateCompany` has no accept step,
          so {proposal.ownerLabel} is not consulted on chain. Accepting buys it outright.
        </p>
      )}

      <div style={styles.promptActions}>
        <button
          type="button"
          onClick={onReject}
          style={{ ...styles.promptButton, ...styles.promptReject }}
        >
          Reject
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={!viewerIsOwner}
          style={{
            ...styles.promptButton,
            ...(viewerIsOwner ? styles.promptAccept : styles.buttonDisabled),
          }}
          title={
            viewerIsOwner
              ? `Sell ${proposal.privateName} to ${proposal.buyerTicker} for $${proposal.price}.`
              : `Only ${proposal.ownerLabel} can accept this offer.`
          }
        >
          Accept
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                             */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 70,
    backgroundColor: "rgba(6, 9, 16, 0.62)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  },
  card: {
    width: "min(560px, 100%)",
    maxHeight: "84vh",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "18px 20px",
    borderRadius: "12px",
    border: "1px solid #3a4150",
    backgroundColor: "#141a26",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
  },
  header: { display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" },
  heading: { fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#e2e6ee" },
  closeButton: {
    marginLeft: "auto",
    width: "30px",
    height: "30px",
    borderRadius: "999px",
    border: "1px solid #4a5163",
    backgroundColor: "#232936",
    color: "#c8cdd8",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  /* Design note #661: `small` -> `body`. This paragraph states the 50-200%
     rule and that the owner must agree -- both load-bearing, and both were
     set at the size used for timestamps. */
  body: { margin: 0, fontSize: FONT_SIZE.body, color: "#aab0bc", lineHeight: 1.55 },
  empty: { margin: 0, fontSize: FONT_SIZE.body, color: "#c9b98a", lineHeight: 1.55 },
  list: { display: "flex", flexDirection: "column", gap: "8px" },
  /* ==================================================================
   *  DESIGN NOTE 661: A ROW PER PRIVATE, AT A READABLE SIZE
   * ==================================================================
   *
   * INSTRUCTED: "the fonts are very small, and everything is listed in a
   * string whereas I think it might be a little more digestible with some
   * styling."
   *
   * Both halves were true and they had one cause: every secondary fact on
   * the row was `micro` (11px), the size the type scale reserves for "tiny
   * status pills and inline tags". Face value, revenue, owner and price band
   * are not tags, they are the DATA the decision is made from -- and four
   * 11px runs sitting on one line read as a single grey string however they
   * are marked up. Nothing was concatenating them; they just all looked the
   * same and none was big enough to anchor the eye.
   *
   * `small` (12px) for the facts and `body` (13px) for the power summary,
   * with the row laid out as an explicit two-column grid so each fact lands
   * in a fixed place. A player scanning six rows can now read down a column
   * rather than across a paragraph, which is the actual difference between
   * a list and a string.
   *
   * THE GROUP CARRIES THE CHROME, THE FACE CARRIES THE CLICK. Border,
   * background and selected state moved to `rowGroup` because the row now
   * holds two buttons and a paragraph, and a border drawn on one of the
   * three would frame part of a row. */
  rowGroup: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "8px",
    border: "1px solid #3a4150",
    backgroundColor: "#1b2130",
    overflow: "hidden",
  },
  rowGroupSelected: { borderColor: "#4d8ee0", backgroundColor: "#1d3a55" },
  /* Design note #386: present but plainly not actionable. Recedes rather
     than disappears -- the whole point of showing it is that the player
     learns the private exists and where it is. */
  rowGroupBlocked: {
    opacity: 0.62,
    borderStyle: "dashed",
    backgroundColor: "#171c27",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "3px 12px",
    textAlign: "left",
    padding: "10px 12px 8px",
    border: "none",
    background: "none",
    color: "#e2e6ee",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  /* `not-allowed` over the usual pointer, so the refusal is felt before it
     is clicked -- design note #386. */
  rowBlocked: { cursor: "not-allowed" },
  rowName: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "baseline",
    gap: "7px",
    minWidth: 0,
  },
  /* The acronym beside the name. Every other surface in this app identifies
     a private by acronym (`PrivateCompanyPills`, the powers panel), and this
     modal was the one place a player had to translate. */
  rowAcronym: {
    fontSize: FONT_SIZE.micro,
    fontWeight: 800,
    letterSpacing: "0.04em",
    color: "#8f98a8",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  rowBand: {
    fontSize: FONT_SIZE.small,
    color: "#7ee0a1",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  rowMeta: { fontSize: FONT_SIZE.small, color: "#aab0bc" },
  rowOwner: {
    fontSize: FONT_SIZE.small,
    color: "#aab0bc",
    textAlign: "right",
    whiteSpace: "nowrap",
  },
  /* Design note #661: the power summary spans BOTH columns and sits under
     the facts. It is the longest line on the row and the one most likely to
     wrap, so giving it the full width keeps it from squeezing the price band
     into two lines beside it. */
  rowPower: {
    gridColumn: "1 / -1",
    fontSize: FONT_SIZE.body,
    color: "#d3d8e2",
    lineHeight: 1.45,
    marginTop: "2px",
  },
  /* A quiet control. It reveals reference text rather than doing anything to
     the game, so it must not compete with the row it hangs off -- design
     note #235's distinction between a turn action and a utility, applied to
     a disclosure. */
  rowDisclosure: {
    alignSelf: "flex-start",
    margin: "0 12px 8px",
    padding: "2px 7px",
    borderRadius: "6px",
    border: "1px solid #39414f",
    backgroundColor: "transparent",
    color: "#9aa0ac",
    fontFamily: "inherit",
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    cursor: "pointer",
  },
  rowDetail: {
    margin: "0 12px 10px",
    padding: "8px 10px",
    borderRadius: "6px",
    backgroundColor: "#151a25",
    fontSize: FONT_SIZE.small,
    color: "#c1c7d3",
    lineHeight: 1.5,
  },
  priceRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" },
  priceLabel: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#c8cdd8" },
  priceInput: {
    width: "130px",
    padding: "8px 10px",
    borderRadius: "6px",
    border: "1px solid #4a5163",
    backgroundColor: "#0f1420",
    color: "#e2e6ee",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
  },
  priceBand: {
    fontSize: FONT_SIZE.small,
    color: "#7ee0a1",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  problem: { margin: 0, fontSize: FONT_SIZE.small, color: "#fb7185", lineHeight: 1.45 },
  footer: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: "8px",
    marginTop: "4px",
  },
  primaryButton: {
    padding: "9px 18px",
    borderRadius: "8px",
    border: "1px solid #4ade80",
    backgroundColor: "#16a34a",
    color: "#ffffff",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  secondaryButton: {
    padding: "9px 18px",
    borderRadius: "8px",
    border: "1px solid #4a5163",
    backgroundColor: "#232936",
    color: "#c8cdd8",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  // Inline styles cannot express `:disabled` (Lobby.tsx design note #3), so
  // the disabled look is computed.
  buttonDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
    backgroundColor: "#1f2937",
    borderColor: "#374151",
    color: "#6b7280",
  },

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
    borderRadius: "12px",
    border: "1px solid #3a5a8a",
    backgroundColor: "#141a26",
    boxShadow: "0 10px 34px rgba(0,0,0,0.6)",
  },
  promptHeader: { display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" },
  promptDot: {
    width: "9px",
    height: "9px",
    borderRadius: "999px",
    backgroundColor: "#38bdf8",
    flexShrink: 0,
  },
  promptTitle: {
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    color: "#9ec5ff",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  promptBody: { margin: 0, fontSize: FONT_SIZE.body, color: "#e2e6ee", lineHeight: 1.5 },
  promptWho: { margin: 0, fontSize: FONT_SIZE.small, color: "#9aa0ac" },
  promptCaveat: {
    margin: 0,
    fontSize: FONT_SIZE.small,
    color: "#c9b98a",
    lineHeight: 1.45,
  },
  promptActions: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: "8px",
  },
  promptButton: {
    padding: "7px 16px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  promptAccept: { backgroundColor: "#16a34a", borderColor: "#4ade80", color: "#ffffff" },
  promptReject: { backgroundColor: "#3a1f22", borderColor: "#b91c1c", color: "#fda4af" },
};
