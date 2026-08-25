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
import { PRIVATE_COMPANY_CATALOG, abilitySummary } from "../utils/privateCatalog";

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

/** Why the typed offer cannot be sent, or `null` when it can.
 *
 *  Design note #804: LIFTED OUT OF THE RENDER, AND ONE ARM DELETED. These five sentences were a nested
 *  ternary inside the component -- unreachable from a test, and the panel's entire error vocabulary. The
 *  wording is unchanged. What is gone is the sixth arm, "Choose a private company first.", and it is gone
 *  BY CONSTRUCTION: the price field now lives inside the card of the private it belongs to, so there is no
 *  longer a state in which a price has been typed for nothing.
 *
 *  DELETED RATHER THAN LEFT AS REASSURANCE, which is #788's lesson. An arm that can no longer be reached
 *  still passes every test written for it, and reads to the next maintainer as a case that happens. */
export function offerPriceProblem(input: {
  priceText: string;
  faceValue: number;
  treasury: number;
  buyerTicker: string;
}): string | null {
  const { priceText, faceValue, treasury, buyerTicker } = input;
  const bounds = privatePriceBounds(faceValue);
  const price = Number(priceText);
  /* Each failure named separately. "Invalid price" would leave the player guessing which of five things was
     wrong, and the band is the one they most often trip on. */
  if (priceText.trim() === "") return `Enter a price between $${bounds.min} and $${bounds.max}.`;
  if (!Number.isFinite(price) || !Number.isInteger(price)) return "Price must be a whole number.";
  if (price < bounds.min) return `$${price} is below 50% of face value ($${bounds.min} minimum).`;
  if (price > bounds.max) return `$${price} is above 200% of face value ($${bounds.max} maximum).`;
  if (price > treasury) {
    return `${buyerTicker}'s treasury holds $${treasury} — it cannot pay $${price}.`;
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
  /** Design note #779: the holder's seat colour, injected rather than derived.
   *  `seatColor` needs the roster INDEX and this panel is given a lookup by address, so the shell -- which
   *  has both -- answers. Optional: a caller without a roster gets the grey it had before rather than a
   *  wrong colour, which on a table where colour identifies a person is the worse failure. */
  colorForAddress?: (address: string) => string | null;
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
  colorForAddress,
  treasury,
  onPropose,
  onClose,
}: ProposePrivatePurchaseProps) {
  // Design note #386: the wider set for DISPLAY. `privatePurchaseBlockReason` is still the STRICT predicate,
  // and it is what gates the offer form and the submit inside each card.
  const eligible = useMemo(() => purchasablePrivatesInPlay(privates), [privates]);

  /* Design note #804: ONE PIECE OF STATE WHERE THERE WERE TWO.
     REPORTED: "players click a Private Company and it expands to display the full rule, then they have to
     click it again for the Offer Price and Purchase button to appear at the very bottom of the subpanel.
     Why don't we have this all happen on one click inside the PC card?"
     TWO CLICKS BECAUSE THERE WERE TWO ANSWERS TO ONE QUESTION. `selectedId` meant "which private is the
     offer form about" and `expandedIds` meant "which rules are open" -- and they were driven by two
     different controls sitting on top of each other. A player who had done one of them saw half a card.
     THEY COLLAPSE CLEANLY because the offer form moved INTO the card: a card that is open is the card being
     read and the card being offered for, so there is nothing left for a second id to say.
     #661'S SET SURVIVES, and its reason with it: "comparing two privates is the reason a player opens one at
     all". Two cards may be open at once, and each now carries its own price -- which is why the text is a
     map rather than the single string a one-at-a-time accordion could have got away with. */
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(() => new Set());
  const [priceTexts, setPriceTexts] = useState<ReadonlyMap<number, string>>(() => new Map());

  const toggleCard = (entry: PrivateCompanyState) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (!next.delete(entry.private_id)) next.add(entry.private_id);
      return next;
    });
    /* Seeded at face value, ONCE. The neutral offer, and the one a player most often wants; starting blank
       makes them type a number before they can see whether it is in range. Re-opening a card must not
       overwrite a price they already typed, so an existing entry returns the SAME map -- identity, which is
       both the refusal idiom this codebase uses and what keeps the re-open from re-rendering. */
    setPriceTexts((current) => {
      if (current.has(entry.private_id)) return current;
      const next = new Map(current);
      next.set(entry.private_id, String(entry.cost));
      return next;
    });
  };

  const setPriceFor = (privateId: number, text: string) => {
    setPriceTexts((current) => {
      const next = new Map(current);
      next.set(privateId, text);
      return next;
    });
  };

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

        {/* Design note #814: THE INTRO PARAGRAPH IS GONE, and #810 removed its twin one report earlier.
           REQUESTED: "I think we can also remove this from the Buy Private Companies subpanel ... It is
           already effective in the propose purchase window and can be in the tutorial instead."
           THE REMOVED PARAGRAPH, quoted whole and on one line each so #490a's guard can find it:
             "A corporation may buy a private company from its owner between 50% and 200% of face value."
             "The owner has to agree."
           (Kept unwrapped deliberately. A comment that wraps mid-sentence preserves the words and destroys
           the STRING, and a harness asserting the record survived searches for the string -- which is the
           third time in two passes that source text has read as contiguous and been split: a JSX `$` beside
           an expression, a `+`-joined tutorial line, and now this.)
           I FLAGGED THIS TWO REPORTS AGO AND DID NOT ACT ON IT: "#721 already made this argument -- 'two
           statements of one rule, and the redundant one was shouting' -- and I left the paragraph alone
           because it also carried 'the owner has to agree', which nothing else said." That second clause is
           the whole reason this needed a destination rather than a deletion, and it now has one.
           #661 SIZED THIS UP DELIBERATELY, from `small` to `body`, "because both halves are load-bearing".
           Both halves still are; what changed is where they load. The BAND is stated inline beside the price
           field the moment a card opens (#804), which is where a player meets it, and the CONSENT rule is in
           the Operating Round tutorial with the rest of the things that are true before you click anything.
           A rule read once does not belong on a surface read every turn -- the same conclusion #810 reached
           about the depot's caption, arrived at from the other direction. */}

        {eligible.length === 0 ? (
          <p style={styles.empty}>
            No private company is available. Every one is either already owned by a corporation,
            closed, or still unsold in the auction.
          </p>
        ) : (
          <div style={styles.list}>
            {eligible.map((entry) => {
              // Design note #386: shown either way, and captioned with the reason it cannot be bought.
              const blocked = privatePurchaseBlockReason(entry);
              const catalog = PRIVATE_COMPANY_CATALOG[entry.private_id];
              const isOpen = openIds.has(entry.private_id);
              const detailId = `private-card-${entry.private_id}`;
              const faceValue = Number(entry.cost);
              const bounds = privatePriceBounds(faceValue);
              const priceText = priceTexts.get(entry.private_id) ?? String(entry.cost);
              const price = Number(priceText);
              /* A blocked private has no offer form to complain about, so the price is not consulted for it
                 at all -- the block reason takes that space instead, which is the first time it has been
                 anywhere a player can read it rather than in a `title` no tablet ever shows. */
              const priceProblem =
                blocked !== null
                  ? null
                  : offerPriceProblem({ priceText, faceValue, treasury, buyerTicker });
              return (
                /* Design note #661: THE ROW IS A GROUP, NOT A BUTTON, and #804 keeps that for a narrower
                   reason. #661 needed it because the row carried two controls; there is one control on the
                   face now, but the open card holds a number input and a submit, and an input inside a
                   button is the same invalid markup a nested button was. So: one face button, and the card
                   as its sibling. */
                <div
                  key={entry.private_id}
                  style={{
                    ...styles.rowGroup,
                    ...(isOpen && blocked === null ? styles.rowGroupOpen : {}),
                    ...(blocked !== null ? styles.rowGroupBlocked : {}),
                  }}
                >
                  {/* Design note #804: THE WHOLE FACE IS THE ONE CLICK. Not disabled when blocked, which is
                      the change #386 was always heading towards: an unsold private and the B&O both have a
                      power worth reading and a REASON worth reading, and until now that reason lived only in
                      a `title` attribute -- invisible on the tablet this game is played on. Opening the card
                      is how a player finds out why they cannot buy it. */}
                  <button
                    type="button"
                    onClick={() => toggleCard(entry)}
                    aria-expanded={isOpen}
                    aria-controls={detailId}
                    title={
                      isOpen
                        ? `Close ${entry.name}.`
                        : blocked !== null
                          ? `${blocked} Opens the full rule.`
                          : `Open ${entry.name} to read its rule and make an offer.`
                    }
                    style={styles.row}
                  >
                    <span style={styles.rowName}>
                      {/* Design note #779: NUMBERED, AND THE ACRONYM IS PART OF THE NAME.
                         REPORTED: "the private companies here lack the numbering we've given them everywhere
                         else"; and the acronym "on the same line and in the same font as the 'held by'
                         information" read as a third fact rather than as part of the title.
                         #423 SETTLED THAT THE ACRONYM IS THE IDENTITY and #341 that the NUMBER is what
                         players say while the auction list is on screen. Both are true and they are not
                         competing -- "1. Schuylkill Valley (SV)" is one title carrying both, where three
                         separate spans made a reader work out which one named the piece. */}
                      <span style={styles.rowTitle}>
                        {`${entry.private_id}. ${entry.name}`}
                        {/* Design note #804: THE ACRONYM DECLARES NOTHING OF ITS OWN.
                           REPORTED: "the abbreviated acronyms need to be in the same color and font as the
                           title, since they are part of the title. Right now you have it in the gray color
                           for 'held by' which looks strange."
                           #779 SAID THE SAME THING AND ONLY HALF-DID IT. That pass moved the acronym to the
                           title's SIZE and WEIGHT and then argued the monospace should stay -- "what makes
                           an acronym read as a code rather than a word" -- and left the grey untouched
                           entirely, which is the half the report is about. A different face and a different
                           colour is a different fact, whatever the size says.
                           SO IT INHERITS, rather than restating the title's values in a second declaration.
                           Two declarations that happen to match are two things that can drift; this one
                           cannot be wrong about the title because it never states it. */}
                        {catalog && <span style={styles.rowAcronym}>({catalog.acronym})</span>}
                      </span>
                      {/* Design note #386: WHO HOLDS IT, named -- the requirement's "clearly marking which player
                         currently owns them". For an unsold private it is also the explanation for why the row is
                         inert, so the two facts are one line rather than two.
                         Design note #721: ON THE NAME'S LINE. It had a column cell of its own, right-aligned
                         opposite the face value, which cost a grid row to say three words. */}
                      <span style={styles.rowOwner}>
                        {entry.owner ? (
                          <>
                            {"held by "}
                            {/* Design note #779: THE HOLDER IN THEIR OWN COLOUR. Six privates against six
                               seats is exactly the lookup a colour solves -- and the colour is already how
                               this table identifies a person everywhere else (the seat trail, the cash
                               strip, the turn pulse). Weight as well as hue: #732's rule, that colour alone
                               is not a distinction a colour-blind player can read. */}
                            <span
                              style={{
                                ...styles.rowOwnerName,
                                ...(colorForAddress?.(entry.owner)
                                  ? { color: colorForAddress(entry.owner) as string }
                                  : {}),
                              }}
                            >
                              {labelForAddress(entry.owner)}
                            </span>
                          </>
                        ) : blocked !== null ? (
                          "not for sale"
                        ) : (
                          "unsold in the auction"
                        )}
                      </span>
                      {/* Design note #804: THE POWER JOINS THE TITLE'S LINE, which is the arrangement asked
                          for twice: "moving the special power to the same line as the name+owner". It is a
                          `<span>` in the same wrapping flex row rather than a block beneath one, so a short
                          summary sits beside the holder and a long one wraps -- with no dead space either
                          way, because a wrapped flex line is exactly as tall as its content.
                          IT IS NO LONGER A CONTROL. #721 made the sentence the disclosure button; the face
                          is the disclosure now, so the sentence goes back to being a sentence. */}
                      {catalog && <span style={styles.rowPower}>{abilitySummary(catalog)}</span>}
                    </span>
                    {/* Design note #804: ONE FIGURE, ON ONE LINE, AND THAT IS THE FIX FOR THE GAP.
                       REPORTED as two separate things: "let's remove the 'Face $20' tags since they can be
                       displayed when a player clicks the private company to buy it", and "the spacing
                       between the name+owner of the private company and its special power is randomly huge."
                       THEY ARE ONE BUG. #721 stacked income over face value in a right-hand grid cell two
                       lines tall, against a left cell one line tall, with `alignItems: "start"` -- so every
                       row carried a blank line under the name that belonged to a column on the other side of
                       the panel. Nothing declared that space, which is exactly why it read as random.
                       Removing the face tag collapses the column to one line and the gap goes with it. The
                       face value is not lost: it is stated in the open card, beside the field where the
                       price is chosen, which is where the report asked for it. */}
                    <span style={styles.rowRight}>
                      <span style={styles.rowIncome}>${entry.revenue_per_or}/OR</span>
                      <span style={styles.rowCaret} aria-hidden="true">
                        {isOpen ? "▴" : "▾"}
                      </span>
                    </span>
                  </button>

                  {/* Design note #804: THE CARD. Rule, price and submit in one place, opened by one click.
                      The offer form used to render once, at the BOTTOM of the panel, about whichever private
                      was selected -- so a player reading the D&H typed a price under the B&O. Inside the card
                      there is no question which private the field belongs to. */}
                  {isOpen && (
                    <div id={detailId} style={styles.cardBody}>
                      {catalog && <p style={styles.cardRule}>{catalog.ability}</p>}
                      {blocked !== null ? (
                        <p style={styles.cardBlocked}>{blocked}</p>
                      ) : (
                        <>
                          <label style={styles.priceRow}>
                            <span style={styles.priceLabel}>Offer price</span>
                            <input
                              type="number"
                              inputMode="numeric"
                              value={priceText}
                              min={bounds.min}
                              max={bounds.max}
                              step={1}
                              onChange={(event) =>
                                setPriceFor(entry.private_id, event.target.value)
                              }
                              style={styles.priceInput}
                              aria-label={`Offer price for ${entry.name}, between ${bounds.min} and ${bounds.max}`}
                            />
                            {/* The face value, rehomed from the row -- and the band beside it, so the two
                                numbers that constrain the field are read where the field is. */}
                            <span style={styles.priceBand}>
                              face ${entry.cost} · ${bounds.min}-${bounds.max}
                            </span>
                          </label>

                          {priceProblem && <p style={styles.problem}>{priceProblem}</p>}

                          <button
                            type="button"
                            style={{
                              ...styles.primaryButton,
                              ...(priceProblem ? styles.buttonDisabled : {}),
                            }}
                            disabled={priceProblem !== null}
                            onClick={() => {
                              if (priceProblem) return;
                              onPropose(entry.private_id, price);
                            }}
                            title={
                              priceProblem ??
                              `Offer $${price} to ${entry.owner ? labelForAddress(entry.owner) : "the owner"} for ${entry.name}.`
                            }
                          >
                            {/* Design note #811: THE BUTTON NAMES WHO IT GOES TO.
                               REQUESTED: "let's add who the purchase is being proposed to: e.g., 'Propose
                               Purchase to P1.' Even though the owner is listed above, it just helps cement
                               what's happening."
                               AND THE REASON IT HELPS IS SPECIFIC TO THIS TRANSACTION. Every other button in
                               this app commits a corporation against the bank or the board -- this one asks
                               another PERSON for something they may refuse (`PrivateTradePanel` #0: the
                               contract has no accept step yet, so on chain it is worse than that, it takes it
                               outright). A control that moves somebody else's property should say whose.
                               FALLS BACK TO "the owner" rather than omitting the clause, so the sentence
                               keeps its shape on a row whose holder the room has not resolved -- the same
                               reason #779's colour falls back to grey rather than to a guess. */}
                            Propose Purchase to{" "}
                            {entry.owner ? labelForAddress(entry.owner) : "the owner"}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Design note #804: THE PANEL FOOTER IS GONE WITH THE THING IT ACTED ON. It held the one
            `Propose Purchase` button, which had to reach back up to `selected` to know what it was buying --
            the indirection that made two clicks necessary. Each card submits itself now.
            AND CANCEL GOES WITH IT, which costs nothing that is reachable: #715 already withdrew it when
            embedded ("Cancel is a modal's word"), and nothing in the app renders this panel any other way --
            the bar passes `embedded` unconditionally and `onOpenPrivateTrade` is a no-op. The modal branch
            below is vestigial and its header `✖` is its only dismissal. Recorded rather than deleted:
            removing the branch is a separate change with its own props to unpick. */}
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
  /* Design note #661 sized this paragraph up from `small` to `body`, "because it states the 50-200% rule and
     that the owner must agree -- both load-bearing, and both were set at the size used for timestamps".
     Design note #814: `body` is DELETED with the paragraph. Both halves are still load-bearing and both moved
     -- the band to the offer line beside the price field, the consent rule to the Operating Round tutorial --
     so what is gone is a surface, not a fact. An orphan key here would be invisible to `tsc` and to ESLint
     alike (#772), and is how the paragraph comes back. */
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
  /* Design note #804: "selected" and "open" were the same card all along, so the key says the one thing it
     now means. Not applied to a blocked card: a blue frame is the app's affordance for "this is the one you
     are acting on", and the B&O is never that. */
  rowGroupOpen: { borderColor: "#4d8ee0", backgroundColor: "#1d3a55" },
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
    /* Design note #804: `alignItems` is BASELINE, not `start`, and that is deliberate rather than cosmetic.
       With `start`, the taller column dictated the row's height and the shorter one sat at the top of it --
       which is how a two-line figures column put a blank line under the name. Baseline aligns the two
       columns' first lines to each other, so the row is as tall as its content and no taller. */
    gap: "2px 12px",
    alignItems: "baseline",
    textAlign: "left",
    /* Design note #779: TIGHTER. Reported as "considerably reduce the padding from their name to their
       special power" -- six of these stack, so every vertical pixel here is six on the panel, which is what
       makes this subpanel too tall to sit in the sticky bar.
       Design note #804: SYMMETRIC NOW. #779's `6px 12px 2px` was clipped at the bottom to hand the remaining
       space to the disclosure button below it; there is no disclosure, so the row owns its own padding. */
    padding: "7px 12px",
    border: "none",
    background: "none",
    color: "#e2e6ee",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  /* Design note #804: `rowBlocked` is GONE, not unused. It set `cursor: not-allowed` on a face button that
     was `disabled`; the face is clickable for every private now -- that is how a player reads the reason it
     is blocked -- so a "you cannot click this" cursor on it would be a false statement. #772's rule: an
     orphan key in a `Record<string, CSSProperties>` is invisible to both `tsc` and ESLint. */
  rowName: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    /* The row gap is what a wrapped power summary falls into, so it is small: 3px reads as a continuation of
       the same block rather than as a new one. */
    gap: "3px 8px",
    minWidth: 0,
  },
  /* Design note #804: the title owns the size and weight, so the acronym inside it can inherit both. */
  rowTitle: { fontSize: FONT_SIZE.strong, fontWeight: 700, minWidth: 0 },
  /* The acronym beside the name. Every other surface in this app identifies a private by acronym
     (`PrivateCompanyPills`, the powers panel), and this modal was the one place a player had to translate.
     Design note #779 gave it the title's size and weight and kept a grey monospace face, arguing that
     monospace "is what makes an acronym read as a code rather than a word".
     Design note #804 WITHDRAWS THAT, on report: "the abbreviated acronyms need to be in the same color and
     font as the title, since they are part of the title". The argument was for a distinction, and a
     distinction is precisely what a part of a title must not have -- it is why the grey looked wrong even
     after the size was fixed. So this declares no colour, no family, no size and no weight; it inherits all
     four from `rowTitle` and cannot disagree with it. `marginLeft` stands in for the flex gap it lost by
     moving inside the title, and the letterspacing just opens up a short all-caps run. */
  rowAcronym: { marginLeft: "5px", letterSpacing: "0.02em" },
  /* Design note #721: `rowBand` and `rowMeta` are GONE, not left unused. The band moved to the offer field
     where the number is actually chosen, and the meta line split into `rowIncome` and `rowFace`. An orphan
     style for a thing just removed on report is how the thing comes back -- `palette.ts`'s rule for its
     retired colour token, and #696's for the dropdown it replaced.
     Design note #804: and now `rowFigures` and `rowFace` join them. Reported: "let's remove the 'Face $20'
     tags since they can be displayed when a player clicks the private company to buy it." The face value is
     restated in the open card beside the price field; the stacked column that held it is what made the row
     two lines tall, so removing the tag is also the fix for the gap under the name. */
  rowRight: {
    display: "flex",
    flexDirection: "row",
    alignItems: "baseline",
    gap: "8px",
    whiteSpace: "nowrap",
  },
  /* The comparison figure, in the green this panel already used for money -- freed by the band's removal.
     It keeps the monospace: this one IS a figure read down a column across six rows, which is the case
     monospace exists for and the case the acronym turned out not to be. */
  rowIncome: {
    fontSize: FONT_SIZE.strong,
    fontWeight: 700,
    color: "#7ee0a1",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  /* Design note #804: the caret moved off the deleted disclosure button and onto the row that now does its
     job. Small and grey: it is an affordance, not a fact. */
  rowCaret: { fontSize: FONT_SIZE.micro, color: "#8f98a8" },
  /* Design note #721: inline beside the name, so it no longer costs a grid row. `micro` because it is the
     one fact on the line that is not being compared across rows. */
  rowOwner: {
    fontSize: FONT_SIZE.micro,
    color: "#8f98a8",
    whiteSpace: "nowrap",
  },
  /* The name only -- "held by" stays grey so the colour marks the PERSON rather than the phrase. */
  rowOwnerName: { fontWeight: 700 },
  /* Design note #804: on the title's line now, so it takes the secondary text colour this file already uses
     for prose rather than the near-white #721 gave it when it was a control. A summary that sits beside the
     title at the title's contrast competes with it. */
  rowPower: {
    fontSize: FONT_SIZE.small,
    color: "#aab0bc",
    lineHeight: 1.4,
    textAlign: "left",
    minWidth: 0,
  },
  /* Design note #804: the open card -- rule, price and submit, in the row they belong to. It is `rowDetail`
     grown a form: same inset, same well, and now a flex column because it holds three blocks rather than one
     paragraph. */
  cardBody: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "8px",
    margin: "0 12px 10px",
    padding: "8px 10px",
    borderRadius: "6px",
    backgroundColor: "#151a25",
  },
  cardRule: { margin: 0, fontSize: FONT_SIZE.small, color: "#c1c7d3", lineHeight: 1.5 },
  /* Design note #804: the reason, where a player can read it. #386 showed a blocked private and put its
     reason in a `title` attribute -- a hover, on a game played on a tablet. Amber rather than red: "still
     unsold in the auction" is the state of the board, not the player's mistake. */
  cardBlocked: { margin: 0, fontSize: FONT_SIZE.small, color: "#c9b98a", lineHeight: 1.45 },
  priceRow: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px 10px",
  },
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
  /* Design note #804: `footer` and `secondaryButton` are GONE with the panel-level submit and the Cancel
     button beside it -- #772's rule again, since neither `tsc` nor ESLint can see an orphan key here. */
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
