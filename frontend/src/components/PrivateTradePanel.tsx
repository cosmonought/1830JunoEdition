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
import { ACTION_GREEN, ACTION_GREEN_BORDER, ACTION_GREEN_INK } from "../styles/palette";

import type { PrivateCompanyState } from "../utils/gameState";
import { FONT_SIZE, RADIUS } from "../styles/typography";
import { STICKY_OPTIONAL } from "../utils/stickyCollapse";
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
        {/* ==================================================================
             DESIGN NOTE 864: THE EMBEDDED FORM IS THE STEP, NOT A CARD ON IT
            ==================================================================

            REPORTED: "I'm not sure '[Corporation] proposes a purchase' is necessary for the subpanel title. I
            think it can just be deleted and go straight to the list of PCs, since clicking to open those has
            the 'Propose Purchase to Player' button already."
            AND: "each of the PC boxes in that subpanel end a weird distance from the edge of the Action Bar
            panel, if that makes sense."

            IT MAKES SENSE AND IT IS ONE CAUSE. #715 moved this out of a modal and into the bar, and kept the
            modal's shape: a heading naming the actor, a border, a background, and 14px of padding. In a modal
            all four earn their place -- a floating window has to say whose it is and where its edges are. In
            the bar they are restating what the bar already says. The step is announced above, the acting
            corporation is named across the top (#740 relies on that), and the bar has its own border and its
            own padding. So the rows sit inside two frames and two paddings, which is the "weird distance":
            the panel is inset from the bar and the rows are inset from the panel.

            THE HEADING GOES BY THE SAME ARGUMENT AS #814 AND #810 -- both removed prose from this panel for
            restating something a player already had. `{buyerTicker} proposes a purchase` is the third.
            THE MODAL KEEPS ALL OF IT. `styles.card` is untouched and the header still renders when it is not
            embedded, because a floating window still needs its title and its close button. The two callers
            genuinely need two shapes, which is what `embedded` has meant since #715. */}
        {!embedded && (
          <div style={styles.header}>
            <span style={styles.heading}>{buyerTicker} proposes a purchase</span>
            {/* Design note #715: no close button when embedded -- the panel is the step, and a control that
                dismissed it would leave the player on a step with nothing on it. */}
            <button type="button" style={styles.closeButton} onClick={onClose} aria-label="Close">
              &#10006;
            </button>
          </div>
        )}

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
                    </span>
                    {/* Design note #804 put the power in the same wrapping flex as the title, which was the
                       arrangement asked for then: "moving the special power to the same line as the name".
                       Design note #830: A LINE, BUT ALSO A COLUMN. Requested: "the powers ... are probably
                       the most important part ... I'm wondering if the special powers summary shouldn't also
                       be in a column that makes it quick to see where the information starts and ends."
                       In one flex row the power began wherever the title happened to end, so six rows had six
                       different left edges for the fact a player is actually comparing. A grid column gives
                       it one, and gives it the slack -- it is the only cell that should absorb a wide panel.
                       IT IS NOT A CONTROL. #721 made the sentence the disclosure button; the face is the
                       disclosure now, so the sentence goes back to being a sentence. */}
                    <span style={styles.rowPower}>
                      {catalog ? abilitySummary(catalog) : ""}
                    </span>
                    {/* Design note #386: WHO HOLDS IT, named -- the requirement's "clearly marking which
                     player currently owns them". For an unsold private it is also the explanation for why
                     the row is inert.
                     Design note #830: IN ITS OWN COLUMN, flush right beside the income. Requested exactly
                     that -- "moved flush right before the round income, in a column that would keep the
                     ownership quickly checkable" -- and it is what lets "held by" go: a column labels its
                     contents by position, where the phrase had to label them six times over. */}
                    <span style={styles.rowOwner}>
                      {entry.owner ? (
                        <>
                          {/* Design note #830: "held by " BECAME "Owner:", not nothing.
                             First asked as a deletion -- "'held by Player' seems like it could be reduced
                             to just 'Player' and moved flush right before the round income, in a column" --
                             and corrected a moment later: "the Player name by itself may not be intuitively
                             obvious until someone clicks to make an offer on a company."
                             THE CORRECTION IS THE INTERESTING PART. A column labels by position only once a
                             reader has learned what the column IS, and this panel has no header row to teach
                             them. So the label stays and gets shorter: "Owner:" is a noun naming the fact,
                             where "held by" was a clause that needed the name to finish it. */}
                          {"Owner: "}
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
                  {/* Design note #841: the open card is reference behind a disclosure, so it is not part of
                      the bar's resting height. Reported as "The Buy Private Companies action bar is not
                      sticky (at least, not in the first OR it is available--perhaps a similar bug as with
                      Buy Trains in OR 1.1?)" -- a good guess, and a different half of the same rule: #837
                      cut the deadlock, and this panel was simply never marked, so its 273px counted in full
                      against a 326px budget it shares with the bar. Nothing about the first OR; it is
                      whether any card happens to be open. */}
                  {isOpen && (
                    <div id={detailId} style={styles.cardBody} {...STICKY_OPTIONAL}>
                      {catalog && <p style={styles.cardRule}>{catalog.ability}</p>}
                      {blocked !== null ? (
                        <p style={styles.cardBlocked}>{blocked}</p>
                      ) : (
                        <>
                          {/* ==================================================================
                               DESIGN NOTE 842: ONE ROW FOR THE OFFER AND THE OFFER'S BUTTON
                              ==================================================================
                              ASKED: "there's currently three rows: the special power information, the Offer
                              Price, and the Propose Purchase button. Can we move the Propose Purchase button
                              to the right of the Offer price?"
                              A `<div>` WRAPPING A `<label>`, not a label wrapping both. A `<button>` inside a
                              `<label>` makes the label's click target the button as well as the field, so
                              pressing it would also focus the input -- the same class of invalid nesting
                              #804 removed when it took the input out of a button. */}
                          <div style={styles.priceRow}>
                            <label style={styles.priceField}>
                              {/* Design note #842: THE BAND IS THE LABEL NOW, AND THE FACE VALUE IS GONE.
                                 REPORTED: "'face $20 $10-$40' isn't working for me. For one thing it's all in
                                 the same green font, so green font is being used here for revenue, face
                                 value, and offer range... The current version 'empowers' players to
                                 calculate the range themselves, but I think many players may only care to be
                                 empowered enough to know what their legal options are, not WHY their legal
                                 options are."
                                 THREE FIGURES IN ONE TYPEFACE IS THE BUG UNDER THE BUG. #804 settled that
                                 monospace-green is this app's channel for A FIGURE BEING COMPARED, and here
                                 it was carrying a comparison (the band), an input (the face) and a
                                 derivation between them -- so the one channel said three things.
                                 THE FACE VALUE IS NOT DELETED, IT IS REHOMED to the Rules Reference's own
                                 table (#843), which is where a number a player looks up once belongs -- the
                                 same move #800 and #835 made for rules prose. What survives on the field is
                                 the only fact it needs: what may legally be typed into it. */}
                              <span style={styles.priceLabel}>
                                Offer price (${bounds.min}&#8211;${bounds.max})
                              </span>
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
                            </label>

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
                          </div>

                          {/* Design note #842: the problem stays on its OWN line, below the row it is about.
                             It is prose of variable length and it appears only when something is wrong;
                             putting it in the row would make the row change height as a player types, moving
                             the button they are reaching for. */}
                          {priceProblem && <p style={styles.problem}>{priceProblem}</p>}
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
  /** Design note #932: the answering player's cash before the sale, for the projection. `null` when the shell
   *  cannot say, which renders no projection rather than one with a guessed end. */
  recipientCash?: number | null;
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
  recipientCash = null,
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

      {/* ==================================================================
           DESIGN NOTE 932: WHAT ACCEPTING DOES TO THE MONEY
          ==================================================================
          REQUESTED: "include a standard financial projection on the recipient's modal: Cash: $current > $new."
          THE HOUSE FORMAT, `$before > $after`, which #509a's withhold column, #705's payout column and #913's
          train button all use -- a fourth spelling of one idea here would make the arrow mean something
          different in one place.
          THE SELLER RECEIVES, so this ADDS. The projection is shown to whoever is being asked to answer, and
          the answer they are weighing is "what do I get" -- which is exactly the fact a bottom-right prompt
          was too quiet to carry.
          ABSENT RATHER THAN GUESSED when the cash is unknown: #670's rule, the same one the dividend toast
          follows. A figure with an invented end is worse than no figure. */}
      {viewerIsOwner && recipientCash !== null && (
        <p style={styles.promptProjection}>
          Cash: ${recipientCash} &gt; ${recipientCash + proposal.price}
        </p>
      )}

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
  /* Design note #864: NO FRAME AND NO PADDING, so the rows reach the bar's own edge. The border, the fill and
     the 14px inset were the modal's, and in the bar they were a second frame inside the bar's frame -- which
     is what put the rows "a weird distance from the edge". `minWidth: 0` because this is a flex/grid child of
     the step wrapper (#859) and without it a long power summary sets a floor on the whole panel's width.
     `marginTop` survives: it is separation from the buttons above, which the bar does not supply. */
  embeddedCard: {
    width: "100%",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "10px",
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
    borderRadius: RADIUS.layer,
    border: "1px solid #3a3a3a",
    backgroundColor: "#0f0f0f",
    boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
  },
  header: { display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" },
  heading: { fontSize: FONT_SIZE.heading, fontWeight: 800, color: "#f2f0eb" },
  closeButton: {
    marginLeft: "auto",
    width: "30px",
    height: "30px",
    borderRadius: RADIUS.pill,
    border: "1px solid #4a4a4a",
    backgroundColor: "#1c1c1c",
    color: "#c8c6c0",
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
  /* ==================================================================
      DESIGN NOTE 840: THE WHITE OUTLINE WAS A BORDER REACT COULD NOT PUT BACK
     ==================================================================

     REPORTED: "Once you've clicked on a Private Company and closed it, it retains a white outline around it
     that wasn't there before and doesn't go away on subsequent clicks. So a player who clicks three PCs has
     three outlined in white and two without outlines."

     THIS ROW MIXED A SHORTHAND WITH A LONGHAND ACROSS RENDERS. The base declared `border: "1px solid
     #3a4150"`; `rowGroupOpen` overrode `borderColor` and `rowGroupBlocked` overrode `borderStyle`. On the
     render where the card CLOSES, React diffs the two style objects, finds `borderColor` gone, and sets
     `style.borderColor = ""` -- and because the `border` shorthand's value did not change between renders,
     it is not re-applied. An empty `border-color` resolves to `currentColor`, and this panel's ink is
     `#e2e6ee`. A near-white frame, on exactly the cards that have been opened and closed, permanently.

     WHICH IS WHY THREE STAY OUTLINED AND THREE DO NOT. It is not focus and it is not a leftover flag: it is
     one DOM property per card that nothing will write again.

     LONGHANDS THROUGHOUT, SO EVERY STATE NAMES EVERY PART. With `borderColor` and `borderStyle` declared in
     the base, the closing render finds them present and writes them back. The rule for this file: a key that
     any sibling state overrides must be declared as the longhand it overrides, never as a shorthand
     containing it.
     THIS IS THE CLASS #732's SWEEP LEFT UNVERIFIED -- "~38 `border`/`borderColor` pairs" noted and not
     checked. It has now produced a real report, so the rest of that list is worth the pass. */
  rowGroup: {
    display: "flex",
    flexDirection: "column",
    borderRadius: RADIUS.card,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#3a3a3a",
    backgroundColor: "#141414",
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
    backgroundColor: "#1c1c1c",
  },
  row: {
    display: "grid",
    /* ==================================================================
       DESIGN NOTE 830: FOUR COLUMNS, BECAUSE SIX ROWS ARE READ DOWNWARD
       ==================================================================

       REQUESTED: "the single line looks good for this, but the elements need a little more separation or
       definition to be quickly scannable ... I'm wondering if the special powers summary shouldn't also be in
       a column that makes it quick to see where the information starts and ends."

       #804 PUT EVERYTHING IN ONE WRAPPING FLEX, which answered the question then asked ("move the special
       power to the same line as the name") and answers this one badly: in a flex row the power begins wherever
       the title happens to end, so six privates gave the fact a player is comparing six different left edges.
       A player reading this panel is reading DOWN one column at a time -- #618 made exactly this argument
       about the depot table, "columns put every cost under every other cost", and this row is the same
       comparison in a different currency.

       TITLE | POWER | OWNER | FIGURES. The power takes the `1fr` because it is the one cell that should
       absorb a wide panel; everything else is as wide as its content and no wider. */
    gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
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
    color: "#f2f0eb",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  /* Design note #804: `rowBlocked` is GONE, not unused. It set `cursor: not-allowed` on a face button that
     was `disabled`; the face is clickable for every private now -- that is how a player reads the reason it
     is blocked -- so a "you cannot click this" cursor on it would be a false statement. #772's rule: an
     orphan key in a `Record<string, CSSProperties>` is invisible to both `tsc` and ESLint. */
  /* Design note #830: the TITLE cell now, nothing else. The owner and the power have columns of their own,
     so this no longer wraps three facts against each other -- it holds one, and `minWidth: 0` is what lets a
     long company name shorten the power's column rather than overflow the row. */
  rowName: {
    display: "flex",
    alignItems: "baseline",
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
  rowCaret: { fontSize: FONT_SIZE.micro, color: "#a8a6a0" },
  /* Design note #721: inline beside the name, so it no longer costs a grid row. `micro` because it is the
     one fact on the line that is not being compared across rows. */
  /* Design note #830: its own column, flush right beside the figures. `micro` because it is the one fact on
     the row nobody compares ACROSS rows -- you look up one private's owner, you do not rank them. */
  rowOwner: {
    fontSize: FONT_SIZE.micro,
    color: "#a8a6a0",
    whiteSpace: "nowrap",
    textAlign: "right",
  },
  /* The name only -- "held by" stays grey so the colour marks the PERSON rather than the phrase. */
  rowOwnerName: { fontWeight: 700 },
  /* Design note #804 dimmed this to `#aab0bc`, reasoning that "a summary that sits beside the title at the
     title's contrast competes with it".
     Design note #830 REVERSES THAT, on report: "the powers are in a gray font that kind of repels reading on
     the already-dark background, but they are probably the most important part. Since they are already set
     off from the title by the size of the font, what if we kept that all in white?"
     RIGHT, AND MY ARGUMENT HAD THE HIERARCHY UPSIDE DOWN. I dimmed the most important text on the row to
     protect the title -- but nobody scans this panel for the names, they scan it for what the powers DO. The
     title is a label on the thing; the summary is the thing. And the second sentence of the report is the
     answer to my objection: the size difference already separates them, so contrast was carrying a
     distinction that did not need carrying twice. */
  rowPower: {
    fontSize: FONT_SIZE.small,
    color: "#f2f0eb",
    lineHeight: 1.4,
    textAlign: "left",
    minWidth: 0,
  },
  /* Design note #804: the open card -- rule, price and submit, in the row they belong to. It is `rowDetail`
     grown a form: same inset, same well, and now a flex column because it holds three blocks rather than one
     paragraph. */
  /* ==================================================================
      DESIGN NOTE 864: A CARD THAT SIZED ITSELF TO ITS OWN SENTENCE
     ==================================================================

     REPORTED: "clicking the PCs causes them to expand to different horizontal sizes, and MH actually expands
     so wide that it overflows the Action Bar."
     `alignItems: "flex-start"` IS THE WHOLE OF IT, and the first half of the report is what identifies it.
     On a column flex container that keyword makes every child shrink-to-fit its own content instead of
     filling the line -- so each open card is as wide as ITS OWN power summary, and five open cards give five
     widths. Nothing else in this file varies per company, which is why the symptom names the cause.
     MH IS THE LONGEST OF THE FIVE ON OFFER (344 characters; only the D&H's 418 beats it, and the D&H was
     already taken in the reported game), so it is the one that runs out of room first. Its overflow is the
     same fact as the ragged widths, not a second bug.
     `stretch` IS THE DEFAULT AND THE RIGHT ONE: a card is a block in a list, and blocks in a list are the
     width of the list. `minWidth: 0` on the children so a long unbroken run shortens rather than pushing,
     and `overflowWrap` so it breaks if it has to -- the two guards that make "as wide as the panel" a
     ceiling rather than a suggestion. */
  cardBody: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    minWidth: 0,
    gap: "8px",
    margin: "0 12px 10px",
    padding: "8px 10px",
    borderRadius: RADIUS.control,
    backgroundColor: "#1c1c1c",
  },
  cardRule: {
    margin: 0,
    fontSize: FONT_SIZE.small,
    color: "#c8c6c0",
    lineHeight: 1.5,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  /* Design note #804: the reason, where a player can read it. #386 showed a blocked private and put its
     reason in a `title` attribute -- a hover, on a game played on a tablet. Amber rather than red: "still
     unsold in the auction" is the state of the board, not the player's mistake. */
  cardBlocked: { margin: 0, fontSize: FONT_SIZE.small, color: "#c9b98a", lineHeight: 1.45 },
  /* Design note #842: the field and its submit on one line. `flexWrap` survives -- on a narrow card the
     button drops below rather than squeezing the input, which is the stacked form this replaced and is the
     right fallback rather than a worse version of the new shape. */
  priceRow: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px 12px",
  },
  /* The label and its input, kept together so the pair wraps as one thing. */
  priceField: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "8px",
  },
  /* Design note #842: plain panel ink, NOT the monospace green. That channel means "a figure being
     compared" (#804), and the band is a constraint on what may be typed rather than something to weigh --
     using it here is what made revenue, face value and the offer range look like the same kind of number. */
  priceLabel: { fontSize: FONT_SIZE.small, fontWeight: 700, color: "#c8c6c0", whiteSpace: "nowrap" },
  priceInput: {
    width: "130px",
    padding: "8px 10px",
    borderRadius: RADIUS.control,
    border: "1px solid #4a4a4a",
    backgroundColor: "#141414",
    color: "#f2f0eb",
    fontSize: FONT_SIZE.control,
    fontFamily: "inherit",
  },
  /* `priceBand` is GONE, not left unused (#772): it was the monospace-green "face $20 · $10-$40" span, and
     both of its facts moved -- the band into `priceLabel`, the face value into the Rules Reference (#843). */
  problem: { margin: 0, fontSize: FONT_SIZE.small, color: "#fb7185", lineHeight: 1.45 },
  /* Design note #804: `footer` and `secondaryButton` are GONE with the panel-level submit and the Cancel
     button beside it -- #772's rule again, since neither `tsc` nor ESLint can see an orphan key here. */
  primaryButton: {
    padding: "9px 18px",
    borderRadius: RADIUS.card,
    border: `1px solid ${ACTION_GREEN_BORDER}`,
    backgroundColor: ACTION_GREEN,
    color: ACTION_GREEN_INK,
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
    backgroundColor: "#1c1c1c",
    borderColor: "#3a3a3a",
    color: "#6e6c68",
  },

  /* ==================================================================
      DESIGN NOTE 932: IT STAYS IN THE CORNER AND STOPS WHISPERING
     ==================================================================
     REPORTED: "we want to keep it there so it doesn't block the board, but it is currently too
     inconspicuous. Change its background color or styling to make it explicitly read as an Action Required
     alert."
     THE POSITION IS RIGHT AND THE PALETTE WAS THE PROBLEM. `#141a26` on a `#3a5a8a` hairline is this app's
     ordinary PANEL treatment -- the same ink every quiet surface uses -- so a prompt that blocks the game
     until somebody answers looked like a status card. Keeping it out of the board's way was never the thing
     that made it easy to miss.
     AMBER, WHICH IS THIS APP'S "SOMETHING IS WAITING ON YOU". #817 chose it for the armed-power escape hatch
     and #896's consequence line uses it for the same register; red is reserved for the broken bank (#901) and
     for refusals, and an offer is neither an error nor a danger.
     THE GLOW IS THE OTHER HALF. A stronger border alone still competes with every other bordered panel on the
     screen; a coloured shadow makes it the only lit object in that corner, which is what "conspicuous in the
     periphery" actually requires. */
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
  promptDot: {
    width: "9px",
    height: "9px",
    borderRadius: RADIUS.pill,
    // Design note #932: the dot and the title move with the panel, or the header keeps the old register.
    backgroundColor: "#e6cf7a",
    flexShrink: 0,
  },
  promptTitle: {
    fontSize: FONT_SIZE.small,
    fontWeight: 800,
    color: "#e6cf7a",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  promptBody: { margin: 0, fontSize: FONT_SIZE.body, color: "#f0e6cc", lineHeight: 1.5 },
  promptWho: { margin: 0, fontSize: FONT_SIZE.small, color: "#c4b384" },
  /* Design note #932: the projection, in the same register as the body it qualifies. */
  promptProjection: {
    margin: 0,
    fontSize: FONT_SIZE.small,
    fontWeight: 700,
    color: "#f0e6cc",
  },
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
    borderRadius: RADIUS.card,
    borderWidth: "1px",
    borderStyle: "solid",
    fontSize: FONT_SIZE.control,
    fontWeight: 700,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  promptAccept: { backgroundColor: ACTION_GREEN, borderColor: ACTION_GREEN_BORDER, color: ACTION_GREEN_INK },
  promptReject: { backgroundColor: "#3a1f22", borderColor: "#b91c1c", color: "#fda4af" },
};
