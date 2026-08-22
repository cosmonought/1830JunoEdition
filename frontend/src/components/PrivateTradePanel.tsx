// frontend/src/components/PrivateTradePanel.tsx
//
// The Private Company trade engine: a corporation proposes, the owner consents.
//
// Design note #0: THE CONSENT STEP IS NOT ON CHAIN YET -- READ THIS. In 1830 a corporation buying a private
// from a player is a NEGOTIATION; `ExecuteMsg::BuyPrivateCompany` is single-party. It authorises the buying
// president, checks the phase gate, the cursor, the treasury and the price band, and then moves the private:
// the seller is READ and never asked.
//   SANDBOX -- the local reducer is the only authority there is, so the full two-party flow is real.
//   A LIVE ROOM -- the seller CANNOT be sent this proposal. No message carries it and no query surfaces it, so
//   showing them an Accept button would be theatre. The prompt goes to the PROPOSER and is labelled as what it
//   is; `onConfirmUnilateral` is deliberately named to make a call site that treats it as consent look wrong.
// THE BACKEND SHAPE THIS NEEDS ALREADY EXISTS, one feature over: train trading records a `TrainOffer` and waits
// for accept/reject, with a rescind path and a query. A `PrivateCompanyOffer` mirroring it would make this
// component's live path as real as its sandbox one. Recorded so the gap is actionable rather than merely known.
//
// Design note #1: the price band is MIRRORED, not invented -- [50%, 200%] of face value. Acceptable client-side
// validation only because the band is a STATIC arithmetic property of one number, not a stateful judgement
// about the board: it cannot go stale between render and dispatch, and the contract still has the final say.
//
// Design notes #2/#386/#660a/#661: see `docs/ai_architecture/contract_economy.md`.

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
  // Integer VGP either side. `ceil` on the floor and `floor` on the ceiling, so a rounded bound can never fall
  // OUTSIDE the band the contract checks -- rounding the other way would offer a price that looks legal here and
  // is rejected on chain, which is the one failure this mirror exists to prevent.
  return {
    min: Math.ceil(faceValue * PRIVATE_PRICE_MIN_FACTOR),
    max: Math.floor(faceValue * PRIVATE_PRICE_MAX_FACTOR),
  };
}

/* Design note #660a: `eligiblePrivatesForPurchase` DELETED. Found while adding the B&O sale ban to it: nothing
   called it. The modal renders from the LOOSE list and decides what may be proposed by resolving the selection
   against `privatePurchaseBlockReason` -- so this was a third answer to a question already answered twice, and
   the ban had been added to the one copy no player could reach.
   Which is the exact failure this codebase keeps rediscovering, caught this time by asking who the caller was
   before trusting the fix: a rule can be written, tested and enforced in a function that never runs. `tsc` and
   ESLint are both content -- the export is used, by the test written to prove the rule.
   THE RULE STILL HOLDS in the two places that matter: the block-reason helper refuses the selection, and the
   reducer refuses the message even if one is somehow written.
   THE B&O IS STILL SHOWN, inert, with its reason and its power text. #386's argument for rendering an unbuyable
   row applies more strongly to a certificate no corporation may ever buy, not less. */

/** Privates the step is ABOUT -- everything still in play.
 *  Design note #386: SHOW THE UNSOLD ONES, DISABLED. The strict predicate answers a narrower question -- which
 *  ones can a corporation propose for RIGHT NOW -- and excludes privates still unsold in the auction, because
 *  there is no seller to agree. Correct for dispatch, wrong for DISPLAY, and the difference is what a player
 *  learns from an empty list:
 *    FILTERED OUT: "No private company is available" -- which reads as "there are none", when there may be four
 *    sitting in the auction that this corporation could buy next round.
 *    SHOWN, DISABLED: "C&SL -- unsold in the auction" -- the actual state of the game, telling the player where
 *    the private went and what has to change.
 *  The two functions stay separate rather than one function with a flag, because they answer genuinely different
 *  questions and the dispatch path must keep using the strict one -- a display predicate that quietly became the
 *  legality predicate is exactly how an unsendable proposal reaches the chain. */
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
  /** Ignored when `embedded` -- the bar's own condition decides whether the step is on screen. */
  open: boolean;
  /** Design note #715: RENDER IN PLACE, not over the board.
   *
   *  REPORTED: "the modal that opens when you click 'Buy Private Company' should maybe be a subpanel like
   *  'Buy Trains' instead of something you only see by actively clicking into it."
   *
   *  Same argument #691 made about the depot, one step earlier in the turn: a step's own controls are not
   *  furniture to be summoned, they ARE the step. A modal additionally hides the board behind it, which is
   *  the surface a president is weighing the purchase against.
   *  `embedded` drops the backdrop, the dialog role and the two chrome buttons -- there is nothing to close
   *  and nothing to cancel when the panel is simply part of the bar. */
  embedded?: boolean;
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
  embedded = false,
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

  if (!embedded && !open) return null;

  const body = (
      <div style={embedded ? styles.embeddedCard : styles.card}>
        <div style={styles.header}>
          <span style={styles.heading}>{buyerTicker} proposes a purchase</span>
          {/* Design note #715: no close button when embedded -- the panel is the step, and a control that
              dismissed it would leave the player on a step with nothing on it. */}
          {!embedded && (
            <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close">
              &#10006;
            </button>
          )}
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
              /* Design note #721: the per-row band is gone with the cell that showed it. `privatePriceBounds`
                 is still the authority -- `bounds` below computes it for the SELECTED private, next to the
                 field where the price is actually chosen, which is where the report moved it to. */
              // Design note #386: shown either way, inert when it cannot be
              // bought, and captioned with the reason.
              const blocked = privatePurchaseBlockReason(entry);
              const catalog = PRIVATE_COMPANY_CATALOG[entry.private_id];
              const isExpanded = expandedIds.has(entry.private_id);
              const detailId = `private-power-${entry.private_id}`;
              return (
                /* Design note #661: THE ROW IS A GROUP, NOT A BUTTON. The whole row used to BE the `<button>`, fine while
                   selecting was the only thing it did. It now carries a second control -- the power disclosure -- and a button
                   inside a button is invalid markup that browsers repair by unnesting, which would have put the toggle outside
                   the row it belongs to.
                   So the row is a container with two real buttons: the selectable face, and the disclosure. A player can read
                   what a private DOES without selecting it, which is the point -- the old row made "tell me more" and "I choose
                   this" the same click. */
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
                      {/* Design note #386: WHO HOLDS IT, named -- the requirement's "clearly marking which player
                         currently owns them". For an unsold private it is also the explanation for why the row is
                         inert, so the two facts are one line rather than two.
                         Design note #721: ON THE NAME'S LINE. It had a column cell of its own, right-aligned
                         opposite the face value, which cost a grid row to say three words. */}
                      <span style={styles.rowOwner}>
                        {entry.owner
                          ? `held by ${labelForAddress(entry.owner)}`
                          : blocked !== null
                            ? "not for sale"
                            : "unsold in the auction"}
                      </span>
                    </span>
                    {/* Design note #721: THE TWO FIGURES, STACKED AND RIGHT-ALIGNED.
                       REPORTED: "the right column should list 'income' (which should be in green) followed by
                       'face value'. Let's leave the 50-200% information to the actual offer panel when you
                       click the PC to buy it."
                       THE BAND WAS THE MOST PROMINENT THING ON THE ROW AND THE LEAST USEFUL. It had the green
                       and the monospace, so six rows of "$30 - $120" read as the answer to a question nobody
                       had yet -- the price is negotiated AFTER choosing, and the offer field states the same
                       band inline the moment a private is selected. Two statements of one rule, and the
                       redundant one was shouting.
                       INCOME TAKES THE GREEN, which is what the report is really about: revenue is the number
                       a player compares across privates, and it was grey `small` text sharing a line with the
                       face value. */}
                    <span style={styles.rowFigures}>
                      <span style={styles.rowIncome}>${entry.revenue_per_or}/OR</span>
                      <span style={styles.rowFace}>face ${entry.cost}</span>
                    </span>
                  </button>
                  {/* Design note #721: THE SUMMARY IS THE DISCLOSURE.
                     REPORTED: "the 'special power summary' ... should itself be clickable to display the full
                     rule (so eliminate the 'Full rules' button)".
                     #661 put the summary on the face of the row and then added a separate "Full rules" toggle
                     beneath it -- two controls, stacked, about the same sentence, and the second one cost a
                     line of its own on every card. Making the sentence the control removes a row per private
                     and removes the question of what the button refers to.
                     STILL NOT INSIDE THE FACE BUTTON. #661's reason holds exactly: a button inside a button is
                     invalid markup that browsers repair by unnesting. It is a sibling, full width, which is
                     also why the group is a flex column rather than one grid. */}
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
                      title={isExpanded ? "Hide the full rule." : "Read the full rule."}
                    >
                      {/* Not gated on `blocked`. An unsold private, or the
                          B&O a corporation may never buy, still has a power
                          worth reading -- design note #386's reason for
                          showing the row at all applies to its rules too. */}
                      <span style={styles.rowDisclosureCaret} aria-hidden="true">
                        {isExpanded ? "▴" : "▾"}
                      </span>
                      <span style={styles.rowPower}>{catalog.abilitySummary}</span>
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
          {/* Design note #715: Cancel is a modal's word. Embedded, declining is `Skip Buy Private` on the bar
              -- the control that already exists for it, and the one #674 argued should look like a peer. */}
          {!embedded && (
            <button type="button" style={styles.secondaryButton} onClick={onClose}>
              Cancel
            </button>
          )}
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
  );

  /* Design note #715: EMBEDDED IS THE BODY ALONE. The backdrop is what makes a modal a modal -- the click
     target that dismisses it, the `aria-modal` that hides the rest of the app from a screen reader, and the
     scrim over the board. None of them belong to a panel that lives inside the bar. */
  if (embedded) return body;

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
      {body}
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

/* Design note #2: WHY SANDBOX LETS ONE PERSON ANSWER THEIR OWN OFFER. A hotseat sandbox has one wallet and one
   human, so requiring the owner's client to answer would make this flow untestable there -- which is the one
   place it most needs to be testable, since it is the only place the whole two-party sequence can currently run
   end to end.
   The prompt still NAMES the owner, so the person clicking Accept is always told whose decision they are
   standing in for. */
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
  /* Design note #715: the embedded twin. Same content, none of the chrome a floating card needs -- no fixed
     width fighting the bar's own, no drop shadow (nothing is floating), no scroll cap (the bar scrolls with
     the page). The border stays: it is what separates this block from the buttons above it, exactly as the
     depot panel's does. */
  embeddedCard: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "12px 14px",
    borderRadius: "10px",
    border: "1px solid #2b3242",
    backgroundColor: "#141a26",
    marginTop: "6px",
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
  /* Design note #661: A ROW PER PRIVATE, AT A READABLE SIZE. Both halves of the report were true and they had
     one cause: every secondary fact was `micro` (11px), the size the type scale reserves for tiny status pills.
     Face value, revenue, owner and price band are not tags, they are the DATA the decision is made from -- and
     four 11px runs on one line read as a single grey string however they are marked up. Nothing was concatenating
     them; they just all looked the same and none was big enough to anchor the eye.
     An explicit two-column grid, so a player scanning six rows can read down a column rather than across a
     paragraph -- the actual difference between a list and a string.
     THE GROUP CARRIES THE CHROME, THE FACE CARRIES THE CLICK: border, background and selected state moved to the
     group because the row now holds two buttons and a paragraph, and a border drawn on one of the three would
     frame part of a row. */
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
    /* Design note #721: ONE GRID ROW, not three. #661's two-column grid was right and it was carrying five
       cells; with the band gone, the owner inline and the power moved to its own button, the face is a single
       line -- identity on the left, the two figures on the right. */
    gap: "2px 12px",
    alignItems: "start",
    textAlign: "left",
    padding: "9px 12px 5px",
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
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: "4px 7px",
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
  /* Design note #721: `rowBand` and `rowMeta` are GONE, not left unused. The band moved to the offer field
     where the number is actually chosen, and the meta line split into `rowIncome` and `rowFace`. An orphan
     style for a thing just removed on report is how the thing comes back -- `palette.ts`'s rule for its
     retired colour token, and #696's for the dropdown it replaced. */
  rowFigures: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "1px",
    whiteSpace: "nowrap",
  },
  /* The comparison figure, in the green this panel already used for money -- freed by the band's removal. */
  rowIncome: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    color: "#7ee0a1",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  rowFace: {
    fontSize: FONT_SIZE.small,
    color: "#aab0bc",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  /* Design note #721: inline beside the name, so it no longer costs a grid row. `micro` because it is the
     one fact on the line that is not being compared across rows. */
  rowOwner: {
    fontSize: FONT_SIZE.micro,
    color: "#8f98a8",
    whiteSpace: "nowrap",
  },
  rowPower: {
    fontSize: FONT_SIZE.small,
    color: "#d3d8e2",
    lineHeight: 1.4,
    textAlign: "left",
    minWidth: 0,
  },
  /* Design note #721: the whole sentence is the control, so this is a full-width row rather than the small
     bordered pill #661 put under it. No border and no background: a bordered block per private was a second
     card inside each card, and the caret plus the hover title carry the affordance. */
  rowDisclosure: {
    display: "flex",
    alignItems: "flex-start",
    gap: "7px",
    width: "100%",
    margin: 0,
    padding: "0 12px 9px",
    border: "none",
    backgroundColor: "transparent",
    color: "#9aa0ac",
    fontFamily: "inherit",
    cursor: "pointer",
    textAlign: "left",
  },
  rowDisclosureCaret: {
    fontSize: FONT_SIZE.micro,
    color: "#8f98a8",
    lineHeight: 1.6,
    flex: "none",
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
