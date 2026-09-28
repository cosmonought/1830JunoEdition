// frontend/src/utils/stockRoundPrivateTrade.ts
//
// The Stock Round's Private Companies section: what each seat is shown, and which controls it gets.
//
// ==================================================================
//  6.5-B (K-01): THE PLAYER <-> PLAYER PRIVATE TRADE GETS A SURFACE
// ==================================================================
//
// D-24 (rulebook 3.1; #1593): during a Stock Round other than the first, on the buyer's or the seller's own turn, a
// private company may change hands between two players at any whole price, $0 included, with no corporation band.
// Either party proposes (`ProposePrivateTrade`), the OTHER answers off-turn (`AnswerPrivateTrade`), the proposer may
// withdraw (`RescindPrivateTrade`), and while the offer stands it holds the table (`pendingOfferBlock`). The
// authority has carried all of it since Batch 7.4; nothing a player could see ever sent it. This module is the
// view the section draws, computed from the board and the viewer only.
//
// NOTHING HERE DECIDES LEGALITY. Every refusal a control shows is asked of the authority's own predicates --
// `proposePrivateTradeRefusal`, `answerPrivateTradeRefusal`, `privateTradeRefusal`, `pendingOfferBlock` -- with the
// viewer as the actor, so a greyed control carries the sentence the server would have answered with (#619). The
// only presentation step is `labelSentence`, which swaps a seated player's id for their name.
//
// WHO GETS WHICH CONTROL (owner ruling K-01, 04:04; 6.5-A §3.1):
//   - propose (Sell / Buy): only the Stock Round seat holder, only on an open player-owned private, only while no
//     offer of any kind stands. Sell on the viewer's own private (the viewer picks the recipient); Buy on another
//     seated player's (the recipient is the owner).
//   - Rescind: only the proposer of the standing trade offer.
//   - Accept / Reject: only the counterparty (`tradeCounterparty`). Third parties and watchers get neither.

import type { GameStateResponse, PrivateTradeOffer } from "../gameEngine/gameState";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import {
  answerPrivateTradeRefusal,
  privateTradeRefusal,
  proposePrivateTradeRefusal,
  stockRoundSeat,
  tradeCounterparty,
} from "../gameEngine/privateTradeAuthority";
import { anyOfferStands, pendingOfferBlock } from "../gameEngine/pendingOfferHold";
import { isFirstStockRound } from "../gameEngine/stockTransactionAuthority";
import { PRIVATE_COMPANY_CATALOG, abilitySummary } from "./privateCatalog";

export type PrivateCardOwner =
  | { kind: "player"; address: string; label: string }
  | { kind: "corporation"; ticker: string }
  | { kind: "closed" }
  | { kind: "unsold" };

/** The standing player <-> player trade offer, as one viewer sees it. */
export interface PrivateTradeOfferView {
  privateId: number;
  privateName: string;
  /** `sell`: the owner proposed (a sell offer); `buy`: the other player proposed (a buy offer). */
  direction: "sell" | "buy";
  proposer: string;
  proposerLabel: string;
  seller: string;
  sellerLabel: string;
  buyer: string;
  buyerLabel: string;
  /** The party who must answer: whichever of buyer and seller did not propose. */
  counterparty: string;
  counterpartyLabel: string;
  price: number;
  /** The viewer's part in it. `other` covers third players and seatless watchers alike. */
  viewerRole: "proposer" | "counterparty" | "other";
  /** One sentence every seat reads on the card. */
  summary: string;
  /** Why the counterparty's Accept would be refused on this board right now (`answerPrivateTradeRefusal`), or
   *  `null`. Asked for the counterparty whoever is viewing, so a third seat's card says the same thing. */
  acceptRefusal: string | null;
}

export interface PrivateTradeCardView {
  privateId: number;
  name: string;
  acronym: string | null;
  faceValue: number | null;
  revenue: number | null;
  /** The special power in one line, from the catalog the rest of the app prints (#661/#772). */
  powerSummary: string | null;
  owner: PrivateCardOwner;
  /** The standing trade offer, when it is for this card. */
  offer: PrivateTradeOfferView | null;
  /** The opener this viewer gets on this card, or `null` for none. */
  control: "sell" | "buy" | null;
  /** Why the opener is greyed (the authority's round-level sentence, e.g. the first Stock Round), or `null`. */
  controlRefusal: string | null;
}

export interface PrivateTradeSectionModel {
  cards: PrivateTradeCardView[];
  /** The seated players other than the viewer, as recipients for a sell offer. */
  recipients: Array<{ address: string; label: string }>;
  /** The first Stock Round's sentence (rule 1), shown once for the whole section. `null` in any later round. */
  firstRoundNote: string | null;
  /** The standing trade offer, wherever it is. */
  offer: PrivateTradeOfferView | null;
  /** Whether the viewer holds a seat at all. A seatless viewer reads the section and acts on nothing. */
  viewerSeated: boolean;
}

/** A seated player's id replaced by their name, wherever it appears in an authority sentence. Display only: the
 *  sentence is otherwise the authority's own. Longest ids first, so no id is a prefix-match of another. */
export function labelSentence(
  sentence: string,
  players: readonly string[],
  labelFor: (address: string) => string,
): string {
  let out = sentence;
  [...players]
    .filter((address) => address.length > 0)
    .sort((a, b) => b.length - a.length)
    .forEach((address) => {
      const label = labelFor(address);
      if (label && label !== address) out = out.split(address).join(label);
    });
  return out;
}

/** A price typed as whole dollars, or `null` when it is not one. `$0` is a price (a gift, D-24). */
export function parseWholeDollars(text: string): number | null {
  const trimmed = text.trim().replace(/^\$/, "");
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

export const PRICE_ENTRY_PROMPT = "Enter a price in whole dollars ($0 or more).";

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The standing trade offer as `viewer` sees it, or `null` when none stands. */
export function privateTradeOfferView(
  state: GameStateResponse,
  viewer: string | null,
  labelFor: (address: string) => string,
): PrivateTradeOfferView | null {
  const offer: PrivateTradeOffer | null = state.private_trade_offer ?? null;
  if (offer === null) return null;
  const counterparty = tradeCounterparty(offer);
  const direction = offer.proposer === offer.seller ? "sell" : "buy";
  const proposerLabel = labelFor(offer.proposer);
  const counterpartyLabel = labelFor(counterparty);
  const price = Number(offer.price);
  const summary =
    direction === "sell"
      ? `${proposerLabel} offers to sell ${offer.private_name} to ${counterpartyLabel} for $${price} — waiting for ${counterpartyLabel}.`
      : `${proposerLabel} offers ${counterpartyLabel} $${price} for ${offer.private_name} — waiting for ${counterpartyLabel}.`;
  const refusal = answerPrivateTradeRefusal(state, { private_id: offer.private_id, accept: true }, counterparty);
  return {
    privateId: offer.private_id,
    privateName: offer.private_name,
    direction,
    proposer: offer.proposer,
    proposerLabel,
    seller: offer.seller,
    sellerLabel: labelFor(offer.seller),
    buyer: offer.buyer,
    buyerLabel: labelFor(offer.buyer),
    counterparty,
    counterpartyLabel,
    price,
    viewerRole: viewer === null ? "other" : viewer === offer.proposer ? "proposer" : viewer === counterparty ? "counterparty" : "other",
    summary,
    acceptRefusal: refusal === null ? null : labelSentence(refusal, state.player_addresses, labelFor),
  };
}

/** The whole section as `viewer` sees it. `null` outside a Stock Round, where the section is not drawn. */
export function privateTradeSectionModel(
  state: GameStateResponse | null,
  viewer: string | null,
  labelFor: (address: string) => string,
): PrivateTradeSectionModel | null {
  if (!state || state.current_round_type !== "StockRound") return null;
  const seated = viewer !== null && state.player_addresses.includes(viewer);
  const seat = stockRoundSeat(state);
  const offer = privateTradeOfferView(state, seated ? viewer : null, labelFor);
  const offerStands = anyOfferStands(state);
  const firstRound = isFirstStockRound(state);

  const cards = [...(state.private_companies ?? [])]
    .sort((a, b) => (toNumber(a.cost) ?? 0) - (toNumber(b.cost) ?? 0) || a.private_id - b.private_id)
    .map<PrivateTradeCardView>((priv) => {
      const catalog = PRIVATE_COMPANY_CATALOG[priv.private_id];
      const corporateOwner = priv.owner_protocol_id !== null && priv.owner_protocol_id !== undefined;
      const owner: PrivateCardOwner = priv.closed
        ? { kind: "closed" }
        : corporateOwner
          ? {
              kind: "corporation",
              ticker:
                state.public_companies.find((company) => company.company_id === priv.owner_protocol_id)?.ticker ??
                `#${priv.owner_protocol_id}`,
            }
          : priv.owner
            ? { kind: "player", address: priv.owner, label: labelFor(priv.owner) }
            : { kind: "unsold" };

      /* The opener: the seat holder, an open private a SEATED player owns, and no offer of any kind standing. */
      let control: PrivateTradeCardView["control"] = null;
      if (
        seated &&
        viewer === seat &&
        !offerStands &&
        owner.kind === "player" &&
        state.player_addresses.includes(owner.address)
      ) {
        control = owner.address === viewer ? "sell" : "buy";
      }
      /* Greyed with the round's own sentence in the first Stock Round -- rule 1 is asked first, so any intent
         names it. Later rounds leave the opener live and let the form ask the full predicate at the price typed. */
      const controlRefusal =
        control !== null && firstRound
          ? privateTradeRefusal(state, {
              privateId: priv.private_id,
              seller: owner.kind === "player" ? owner.address : "",
              buyer: control === "sell" ? "" : (viewer as string),
              price: 0,
            })
          : null;

      return {
        privateId: priv.private_id,
        name: priv.name,
        acronym: catalog?.acronym ?? null,
        faceValue: toNumber(priv.cost),
        revenue: toNumber(priv.revenue_per_or),
        powerSummary: catalog ? abilitySummary(catalog) : null,
        owner,
        offer: offer !== null && offer.privateId === priv.private_id ? offer : null,
        control,
        controlRefusal,
      };
    });

  return {
    cards,
    recipients: seated
      ? state.player_addresses
          .filter((address) => address !== viewer)
          .map((address) => ({ address, label: labelFor(address) }))
      : [],
    /* Rule 1's own sentence (asked of the predicate, which answers it before looking at the intent), and where
       the player goes from here. */
    firstRoundNote: firstRound
      ? `${privateTradeRefusal(state, { privateId: 0, seller: "", buyer: "", price: 0 }) ?? ""} Trading between players opens in the next Stock Round.`.trim()
      : null,
    offer,
    viewerSeated: seated,
  };
}

/** Why `viewer` may not propose this trade right now, labelled for display, or `null`. The authority's own
 *  proposal predicate with the viewer as the actor (`proposePrivateTradeRefusal`), so the Send button is greyed
 *  with exactly what ingress would answer. */
export function privateTradeProposalRefusal(
  state: GameStateResponse,
  viewer: string | null,
  intent: { privateId: number; seller: string; buyer: string; price: number },
  labelFor: (address: string) => string,
): string | null {
  if (viewer === null || !state.player_addresses.includes(viewer)) return "Only a seated player can propose a trade.";
  const refusal = proposePrivateTradeRefusal(
    state,
    { private_id: intent.privateId, seller: intent.seller, buyer: intent.buyer, price: intent.price },
    viewer,
  );
  return refusal === null ? null : labelSentence(refusal, state.player_addresses, labelFor);
}

/** The standing-offer hold as an ordinary action on this board meets it, labelled, or `null` when no player trade
 *  offer stands. Asked of `pendingOfferBlock` with an ordinary `PassTurn`, so the greyed controls carry the hold's
 *  own sentence ("...nothing else can happen until it is answered or withdrawn."). */
export function privateTradeHoldReason(
  state: GameStateResponse | null,
  labelFor: (address: string) => string,
): string | null {
  if (!state || (state.private_trade_offer ?? null) === null) return null;
  const hold = pendingOfferBlock(state, { PassTurn: { game_id: state.game_id } } as SandboxLogMsg);
  return hold === null ? null : labelSentence(hold, state.player_addresses, labelFor);
}

/* ==================================================================
    THE THREE MESSAGES, BUILT ONCE
   ==================================================================
   The shell's handlers send exactly these, and the harness drives a real room with the same builders, so what the
   tests prove is what the table sends. `price` is an `int` on the wire (`messageSchema.ts`): whole VGP, $0 allowed. */

/** `ProposePrivateTrade` for a sell offer (`seller` = the viewer) or a buy offer (`buyer` = the viewer). */
export function proposePrivateTradeMsg(
  gameId: number,
  intent: { privateId: number; seller: string; buyer: string; price: number },
): SandboxLogMsg {
  return {
    ProposePrivateTrade: {
      game_id: gameId,
      private_id: intent.privateId,
      seller: intent.seller,
      buyer: intent.buyer,
      price: intent.price,
    },
  };
}

/** `AnswerPrivateTrade`, the counterparty's; the shell sends it with `offTurn` (the consent-answer exemption). */
export function answerPrivateTradeMsg(gameId: number, privateId: number, accept: boolean): SandboxLogMsg {
  return { AnswerPrivateTrade: { game_id: gameId, private_id: privateId, accept } };
}

/** `RescindPrivateTrade`, the proposer's. */
export function rescindPrivateTradeMsg(gameId: number, privateId: number): SandboxLogMsg {
  return { RescindPrivateTrade: { game_id: gameId, private_id: privateId } };
}
