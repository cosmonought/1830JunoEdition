// frontend/src/utils/turnAuthority.ts
//
// Whether this actor may send this message right now.
//
// ==================================================================
//  DESIGN NOTE 1205: THE QUESTION THAT DEFEATED THE REDUCER TWICE
// ==================================================================
//
// #1174 AND #1182 BOTH DIED HERE. The first put `offTurnRefusal(state, msg, actor)` inside the reducer and
// broke ten tests across four suites -- including `replayAttribution`, #549's own divergence harness, whose
// whole subject is that the reducer must not read the seat cursor. The second compared a message's
// `protocol_id` against `active_corporation_index` and reached real players, producing three separate-looking
// reports that were one bug.
//
// THE REASON THEY FAILED IS NOT THE REASON IT LOOKED LIKE. Both notes conclude that a refusal may only compare
// values identical on every client BY CONSTRUCTION, and neither cursor was: two browsers whose market charts
// had drifted built different operating orders, so a refusal keyed on the queue made a board's CONTENTS depend
// on that disagreement.
//
// THAT OBJECTION DOES NOT SURVIVE A SERVER. It was never about the rule; it was about there being two
// judges. One writer cannot disagree with itself, so the thing #1174 could not do inside a replay is exactly
// what an authority is for. This module is therefore NOT the refusal those notes forbid -- it is the check
// they said belonged somewhere else, finally somewhere else.
//
// AND IT IS NOT A SECOND IMPLEMENTATION OF "WHOSE TURN IS IT". `actingAddress` in `gameState.ts` already
// answers all four cases and has for a long time: the mini-auction's own cursor (#544), the waterfall
// rotation, the Stock Round seat, and the Operating Round's PRESIDENT rather than any seat index (#411).
// What the reducer lacked was never the rule -- it was the auction atom, which `actingAddress` needs and
// `applyOneAction` was never passed. `RoomEngine` holds both. So this file resolves the actor, asks that
// function, and spends its length on the EXEMPTIONS, which is where the real complexity always was.
//
// THE EXEMPTIONS ARE THREE, NOT FOUR, and correcting that is worth recording. #1174's note lists four flows
// as "legitimately off-turn", and the fourth -- "a `SellStock` that does not advance the seat at all" -- is an
// observation about the CURSOR rather than about authority. A sale that leaves the seat where it is still
// happens on the seller's turn. The shell's own gate has exactly three exemptions
// (`isRemoteReplay`, `automatic`, `offTurn`) and no arm for `SellStock`, which settles it.
//
// A REFUSAL HERE REFUSES AN ACTION. On the client this rule greyed a button; here it rejects a request, so
// every exemption below is a case where a player would otherwise be locked out of a move the rules allow.

import type { GameStateResponse, WaterfallStateResponse } from "./gameState";
import { actingAddress } from "./gameState";
/* #1220: the SAME predicate the shell dispatches by (#546), not a second list. A copy here would drift the
   moment an eleventh message joined the family, and drift in this direction locks players out of moves. */
import { isSandboxOnlyMsg } from "./gameSetup";
import type { GameplayExecuteMsg } from "../utils/sessionKey";
import { BO_PRIVATE_ID, BO_TICKER } from "./gameConstants";
import { DH_PRIVATE_ID } from "./dhPower";
import { effectiveActions, type RevertableAction } from "./logRevert";
import { pendingDiscardBlock, pendingTrainDiscards } from "./trainDiscard";
import {
  declareBankruptcyRefusal,
  emergencyFundingBlock,
  emergencyFundingFor,
  emergencyPurchaseRefusal,
  fundingPrivateOfferRefusal,
  fundingPrivateRescindRefusal,
} from "./emergencyFunding";
import type { MapGridResponse } from "../components/hexContractTypes";
import { dividendAmountRefusal, routeSetRefusal, routeSkipRefusal } from "./routeAuthority";
// Design note #1617 (Slice 8.2, S8-14): the paid station placement's two reducer questions, asked at the lock too.
import { operatingIdentityRefusal } from "./operatingIdentity";
import { stationPlacementRefusal } from "./stationPlacementGate";
import { tileEraFor } from "./gameConstants";
/* Design note #1570 (Batch 7.2): the SAME predicates the reducer's core asks, so the two locks cannot
   disagree about a stock transaction. Ingress answers with the sentence; the reducer remains the law. */
import {
  chartContextFromState,
  parLadderRefusal,
  purchaseIntentOf,
  stockPurchaseRefusal,
  stockSaleRefusal,
} from "./stockTransactionAuthority";
import { withRules } from "./boardSelection";
import { resolveVariants } from "./gameVariants";
/* Design note #1580 (Batch 7.3): the private auction's rules, from the one module that owns them. Not a
   second implementation -- `turnAuthority` states no auction rule of its own. */
import { auctionRefusal, isAuctionMessage } from "./auctionAuthority";
/* Design notes #1590-#1595 (Batch 7.4): the ordinary offers' hold and their three authorities -- the same
   predicates the reducer's core asks, so the two locks cannot disagree; ingress answers with the sentence. */
import { legacyOfferMessageRefusal, pendingOfferBlock } from "./pendingOfferHold";
import {
  answerPrivatePurchaseRefusal,
  privatePurchaseRefusal,
  proposePrivatePurchaseRefusal,
  rescindPrivatePurchaseRefusal,
} from "./privatePurchaseAuthority";
import {
  answerTrainPurchaseRefusal,
  proposeTrainPurchaseRefusal,
  rescindTrainPurchaseRefusal,
  trainSaleRefusal,
} from "./trainSaleAuthority";
import {
  answerPrivateTradeRefusal,
  proposePrivateTradeRefusal,
  rescindPrivateTradeRefusal,
} from "./privateTradeAuthority";
/* Design notes #1610-#1612 (Slice 8.2): the home station's hold and its placement's legality -- the same
   predicates the reducer asks, so the two locks cannot disagree; ingress answers with the sentence. */
import {
  boardHomeHexToAxial,
  homePlacementRefusal,
  homeStationHold,
  type HomePlacement,
} from "./homeStationAuthority";

export interface TurnAuthorityInput {
  state: GameStateResponse;
  /** #544: the mini-auction's cursor lives here, and it SUSPENDS the main rotation while a contest runs. */
  waterfall: WaterfallStateResponse | null;
  /** Who sent it. `null` is a legitimate state, not a missing one -- see the solo exemption below. */
  actor: string | null;
  msg: GameplayExecuteMsg;
  /** Generated by the server itself (#1203). The authority does not audit its own output. */
  derived?: boolean;
  /** #1249: the room's host, from the room document. `undefined` means the caller has no room document (a
   *  test, a CLI replay) and the host-only checks are skipped -- #232: absent is "not said", never "nobody". */
  host?: string | null;
  /** #1249: the log as it stands, for `RevertTo` -- the one message whose authority is about history rather
   *  than about the board. Same rule as `undoReachFor`; `undefined` skips it for the same reason as `host`. */
  log?: readonly RevertableAction[];
  /** #1540: the board's grid, for the one obligation that needs a route walk (the forced train purchase).
   *  `undefined` -- a test, a caller without a grid -- skips that hold, on #757's rule. */
  mapGrid?: MapGridResponse;
}

/** Why this actor may not send this message now, or `null` if they may. */
export function turnRefusal(input: TurnAuthorityInput): string | null {
  const { state, waterfall, actor, msg, derived = false } = input;

  /* ---- EXEMPTION 1: the game's own actions (#1203, and the shell's `automatic`) ----
     The server generated these in `RoomEngine.submit` after a player's move -- the forced withhold, the
     auto-skip, the turn that ended itself. Checking them would be the authority interrogating itself, and
     they are by definition not on anybody's turn: a corporation whose turn just ended is exactly who the
     `PassTurn` is for. */
  if (derived) return null;

  /* ---- EXEMPTION 2: solo play and attribution-less actions (#549b) ----
     A null actor is a POSITIVE STATE, not a missing field: `applyOneAction` resolves it to "the cursor" for
     solo play deliberately. Refusing here would make a single-player game unplayable, and there is nobody to
     take a turn from. */
  if (actor === null) return null;

  /* ---- THE HOLD (#1530): WHILE A DISCARD IS OWED, NO SEAT HAS A TURN ----
     Rulebook 6.6.1/2.0: the limit is in force the moment the phase turns, and the president's discard is
     what the game is waiting for. Until every over-limit corporation is compliant the board is not one any
     move was written against, so every other move is refused HERE with its reason -- rather than appended
     and no-op'd by the reducer's gate, which is the second line of the same defence. Exempt: the discard
     itself (its owner is checked below), and the room's `RevertTo` and `CloseRoom`, which are instructions
     about the log and the room and keep their own owners. */
  if (!("DiscardTrain" in msg) && !("RevertTo" in msg) && !("CloseRoom" in msg)) {
    const held = pendingDiscardBlock(state, msg);
    if (held !== null) return held;
  }

  /* ---- THE SECOND HOLD (#1540): A TRAIN THAT MUST BE FUNDED, AND A GAME THAT HAS ENDED ----
     Rulebook 6.6.2-6.7 (`emergencyFunding.ts`). While the operating corporation must buy a train it cannot
     pay for, only the messages that resolve it pass; after `GameEnd`, only `CloseRoom`. The forced sale and
     the emergency purchase have one owner -- the rescued corporation's president -- checked here by name,
     narrowly, so the seat rule below is not the only thing standing between another player and somebody
     else's shares. */
  {
    const held = emergencyFundingBlock(state, msg, input.mapGrid);
    if (held !== null) return held;
    if ("SellStock" in msg || "EmergencyBuyHardware" in msg) {
      const funding = emergencyFundingFor(state, input.mapGrid);
      if (funding !== null && actor !== funding.president) {
        return `Only ${funding.ticker}'s president can resolve its train purchase.`;
      }
    }
    /* The emergency purchase is an obligation's action, so its standing is answered here with its reason
       (owed at all; the right corporation; funded) rather than appended as a no-op the reducer declines. */
    if ("EmergencyBuyHardware" in msg && input.mapGrid !== undefined) {
      const refusal = emergencyPurchaseRefusal(state, msg.EmergencyBuyHardware.protocol_id, input.mapGrid, actor);
      if (refusal !== null) return refusal;
    }
    /* #1541: the funding offer, its withdrawal and the declaration are the obligated president's, by name,
       and each is answered with its standing. The offer's ANSWER is the buying president's -- exemption 3. */
    if ("OfferPrivateForFunding" in msg) {
      const funding = input.mapGrid === undefined ? null : emergencyFundingFor(state, input.mapGrid);
      if (funding === null) return "No forced train purchase is owed, so no private company can be offered to fund one.";
      const refusal = fundingPrivateOfferRefusal(state, funding, msg.OfferPrivateForFunding, actor);
      if (refusal !== null) return refusal;
    }
    if ("RescindFundingPrivateOffer" in msg) {
      const refusal = fundingPrivateRescindRefusal(state, msg.RescindFundingPrivateOffer, actor);
      if (refusal !== null) return refusal;
    }
    if ("DeclareBankruptcy" in msg) {
      const funding = input.mapGrid === undefined ? null : emergencyFundingFor(state, input.mapGrid);
      const refusal = declareBankruptcyRefusal(funding, actor);
      if (refusal !== null) return refusal;
    }
  }

  /* ---- THE THIRD HOLD (#1590, Batch 7.4): ONE ORDINARY OFFER, AND NOTHING ELSE WHILE IT STANDS ----
     After the discard's and the funding's, so a board under one of those reports that reason; before the
     consent exemption, whose messages the hold itself lets through. And the chain-era offer messages are
     refused on a pinned board (ruled Q11 / D-23) rather than appended and no-op'd. */
  {
    const legacy = legacyOfferMessageRefusal(state, msg);
    if (legacy !== null) return legacy;
    const held = pendingOfferBlock(state, msg);
    if (held !== null) return held;
  }

  /* ---- THE FOURTH HOLD (#1612, Slice 8.2 -- S8-12): THE OPERATING CORPORATION'S HOME STATION ----
     While the corporation under the Operating Round cursor owes its home station (the start of its first
     operating turn), only the placement -- whose legality is judged in the room-message branch below -- and the
     room's `RevertTo` / `CloseRoom` pass. After the offer hold, so a board under one of the first three reports
     that reason; before the consent exemption, whose answers the hold refuses like everything else. The SAME
     predicate and the same sentence the reducer asks before anything moves (#1613), with this table's board in
     effect (#1300: this boundary is not already inside a `withRules` scope). Before Slice 8.2 ingress had no
     home hold at all, so a held proposal was appended to the log and no-op'd by the core (R74-C). */
  {
    const held = withTableRules(state, () => homeStationHold(state, msg, boardHomeHexToAxial));
    if (held !== null) return held;
  }

  /* ---- EXEMPTION 3: consent answers on a two-party trade (#701) ----
     THE OWED ANSWER IS ALWAYS OFF-TURN, BY CONSTRUCTION. A corporation on its turn OFFERS; the private's
     owner or the selling president ANSWERS, and that player is by definition not the one operating. The
     shell marks these `offTurn: true` at all four dispatch sites for exactly this reason.
     ASKED AGAINST THE BOARD, NOT AGAINST A FLAG. #1198 put both offers on the state, so "is this actor the
     counterparty of an open offer" is a state read rather than something the sender asserts about itself --
     which matters when the sender is a network client rather than the shell's own code. */
  const consent = consentAnswerRefusal(state, actor, msg, input.mapGrid);
  if (consent !== "not-a-consent-answer") return consent;

  /* ==================================================================
      EXEMPTION 4 (#1220): THE MESSAGES THAT ARE NOT A SEAT'S TO SEND
     ==================================================================
     REPORTED, after four separate one-button fixes: "'Proceed to Stock Round 1' button doesn't work. It
     seems like we are iteratively needing to fix every single button and transition." And the server said
     `refused: p-qnvjx852 sent OpenStockRound — It is not your turn.`

     IT WAS ALWAYS ONE BUG. Exemption 1 above claims to cover "#1203, and the shell's `automatic`", and that
     conflation is the whole fault: `derived` is only what the SERVER generates. The shell's `automatic` flag
     covers a much larger family -- every message in `isSandboxOnlyMsg` is dispatched with it, at every one of
     its call sites -- and not one of them is derived. So the client let them through and the server refused
     them, one button at a time, in the order the playtest happened to reach them.

     THESE ARE NOT MOVES. `OpenStockRound` and `SetBoPar` close a phase; `PlaceHomeStation` places a token the
     rules place for you; `ExchangePrivate` is the M&H's own right, explicitly exercisable between other
     players' turns; `RevertTo` and `CloseRoom` are the room's, not a seat's. Asking "is it your turn" of a
     phase transition is a category error -- the transition belongs to the GAME, and the seat cursor at that
     moment usually points at somebody who has just finished.

     DECIDED FROM THE MESSAGE, NEVER FROM A FLAG, and that distinction is the reason this is safe. A client
     asserting `automatic: true` on the wire would be a client granting itself an exemption, which is exactly
     what #1207 keeps off the wire. `isSandboxOnlyMsg` is a property of the message the server can see for
     itself, and it is the SAME PREDICATE the shell uses (#546) rather than a second list that would drift
     from it -- #1184's shape, avoided by construction.

     THE CONSENT ANSWERS ARE IN THIS FAMILY TOO AND MUST NOT REACH HERE. Exemption 3 runs first and returns
     for all four negotiation messages, so their real owner checks stand. The order of these blocks is load-
     bearing; moving this one above it would hand every trade answer to anybody.

     WHAT #1220 LEFT UNGUARDED, in its own words: "any player in the room may send `OpenStockRound`,
     `SetBoPar`, `PlaceHomeStation`, `ExchangePrivate`, `RevertTo` or `CloseRoom` at any time ... a real gap
     and it is recorded in the migration plan as one." #1249 closes it -- see `roomMessageRefusal`. The
     exemption from the SEAT stands; what each message gets instead is its own owner. */
  if (isSandboxOnlyMsg(msg)) {
    const owner = roomMessageRefusal(input, actor);
    if (owner !== null) return owner;
    /* #1570: `roomMessageRefusal` asks "is this yours to send" and deliberately nothing else. The B&O par is
       the one legality question in that family that a socket boundary should answer, because the alternative
       is a silent reducer no-op on a message the player believes started their corporation (S8-9 / U-29). */
    if ("SetBoPar" in msg) {
      return stockChartRefusal(state, () =>
        parLadderRefusal(msg.SetBoPar.par_value, chartContextFromState(state), BO_TICKER),
      );
    }
    /* #1611 (Slice 8.2, S8-6): the home placement is the other legality question in this family a socket
       boundary should answer -- owed now, on a candidate home, in a legal circle -- because the alternative is a
       placement the player believes landed and the reducer quietly declined. The owner rule above stays first.
       The D&H's free station is not a home placement (#1615) and keeps its owner check alone. */
    if ("PlaceHomeStation" in msg) {
      const placement = msg.PlaceHomeStation as HomePlacement;
      if (placement.kind === "dh") return null;
      return withTableRules(state, () => homePlacementRefusal(state, placement, input.mapGrid, boardHomeHexToAxial));
    }
    return null;
  }

  /* ==================================================================
      EXEMPTION 5 (#1530): THE DISCARD BELONGS TO THE PRESIDENT WHO OWES IT
     ==================================================================
     Rulebook 6.6.1: after a phase change the president of each over-limit corporation chooses a train to
     discard, highest share value first. That president is usually NOT the seat that is operating -- the
     buyer of the phase-changing train is -- so the seat cursor is the wrong question, and it is not widened
     to ask it. `DiscardTrain` gets its own owner instead: the president of the corporation that must decide
     NEXT (`pendingTrainDiscards`, derived from the board), and nobody else. A corporation further down the
     queue, its president, any other seat: refused. With no obligation standing there is no owner at all.
     THE REDUCER ASKS THE SAME QUESTION of the entry's author (#549), so a client that bypassed this gate
     meets the answer again in `applySandboxActionCore`. */
  if ("DiscardTrain" in msg) {
    const pending = pendingTrainDiscards(state);
    if (pending === null) return "No corporation is over its train limit, so there is no train to discard.";
    const { required } = pending;
    const { protocol_id } = msg.DiscardTrain;
    if (protocol_id !== required.companyId) {
      return `${required.ticker} must discard first — its president decides before anyone else.`;
    }
    if (required.president !== null && actor !== required.president) {
      return `Only ${required.ticker}'s president can choose which train ${required.ticker} discards.`;
    }
    return null;
  }

  /* ---- THE RULE ITSELF ----
     One function, four cases, and the auction atom it always needed. */
  const acting = actingAddress(state, waterfall);

  /* AN UNRESOLVABLE CURSOR ALLOWS THE ACTION THROUGH, matching `dividendGate` and `trainPurchaseGate`
     exactly: "an unknown cursor is allowed through, deliberately ... refusing there would brick a board on
     the strength of a missing field rather than a broken rule". `actingAddress` returns `null` for an empty
     roster, an unseated president, or a corporation the queue cannot name -- none of which is evidence that
     THIS player is out of turn. */
  if (acting !== null && actor !== acting) return "It is not your turn.";
  /* ==================================================================
      DESIGN NOTE 1570 (ingress): THE STOCK TRANSACTION IS ANSWERED WITH ITS REASON (Batch 7.2)
     ==================================================================
     The reducer refuses these by identity (`applySandboxActionCore`, the second lock); asked here first, on
     the seat that is allowed to send them, so the submitter hears the sentence rather than meeting a control
     that appears to do nothing (S10-1 / U-29) -- the #1530/#1540/#1550 shape.

     THE SAME PREDICATES AND THE SAME CHART, so the two locks cannot disagree: the context is built from
     `state.market_positions` by the same function the reducer uses, and the whole call is scoped with
     `withRules` (#1300) because the par ladder and the zone table are the TABLE's chart and this boundary,
     unlike the reducer, is not already standing inside it.

     SEAT AUTHORITY STAYS HERE AND ONLY HERE (ruling Q10 / D-9): the predicates below add round and action
     legality, never historical seat authority. */
  if ("BuyStock" in msg) {
    return stockChartRefusal(state, () =>
      stockPurchaseRefusal({
        state,
        buy: purchaseIntentOf(msg.BuyStock),
        actor,
        ctx: chartContextFromState(state),
      }),
    );
  }
  if ("SellStock" in msg) {
    return stockChartRefusal(state, () =>
      stockSaleRefusal({
        state,
        sell: { companyId: msg.SellStock.protocol_id, percentage: msg.SellStock.percentage },
        actor,
        mapGrid: input.mapGrid,
        ctx: chartContextFromState(state),
      }),
    );
  }
  /* ==================================================================
      DESIGN NOTE 1580 (ingress): THE AUCTION IS ANSWERED WITH ITS REASON (Batch 7.3)
     ==================================================================
     The reducer refuses these by identity, above the auction atom (`applySandboxActionOnBoard`); asked here
     first so the submitter hears the sentence -- S10-1/U-29's shape, and it matters more here than anywhere
     because three of these refusals answer a control the dashboard currently DRAWS as available (a bid on
     the lowest card, a sub-$5 raise, a main-rotation action during a contest).

     THE SEAT RULE HAS ALREADY RUN, and during a contest it named the contest's current player
     (`actingAddress` reads `mini_auction.current_turn`, #1232) -- which is exactly why S7-15 was reachable:
     the player moving the main rotation mid-contest passes the seat check. The auction's own rules are what
     refuse it, and they are asked here and nowhere else in this file. */
  if (isAuctionMessage(msg)) {
    return auctionRefusal(state, waterfall, msg);
  }
  /* ==================================================================
      DESIGN NOTE 1617 (ingress): A PAID STATION PLACEMENT IS ANSWERED WITH ITS REASON (Slice 8.2, S8-14)
     ==================================================================
     The reducer asks a `PlaceStationToken` two questions, in this order: is the corporation it names the one
     operating (#1510), and is the placement legal (`stationPlacementRefusal`, #1511 -- the step, the allowance, the
     treasury, the circle, the home reservations including a tiled OO home hex closed to other corporations, #1617,
     and connectivity). Ingress asked neither, so a refused placement reached the log and was no-op'd by the core
     (S8-12's shape). The same two predicates, in the same order, with this table's board in effect (#1300). */
  if ("PlaceStationToken" in msg) {
    return (
      operatingIdentityRefusal(state, msg) ??
      withTableRules(state, () => stationPlacementRefusal(state, msg.PlaceStationToken, input.mapGrid))
    );
  }
  /* ==================================================================
      DESIGN NOTE 1550 (ingress): THE ROUTE, THE DIVIDEND AND THE SKIP ARE ANSWERED WITH THEIR REASON
     ==================================================================
     Batch 6. The reducer refuses these by identity (`applySandboxActionCore`, the second lock); asked here
     first, on the seat that is allowed to send them, so the submitter hears the sentence rather than a silent
     no-op -- the #1530/#1540 shape. Same predicates, same grid, so the two locks cannot disagree. */
  return operatingLegalityRefusal(state, msg, input.mapGrid, actor);
}

/** Ask a chart-reading refusal with THIS TABLE's board, tray and market chart in effect (#1300).
 *
 *  THE REDUCER IS ALREADY INSIDE ONE -- `applySandboxAction` opens a `withRules` scope before any arm runs --
 *  and this boundary is not: `RoomSession.submit` calls `turnRefusal` directly. A par ladder or a price zone
 *  read outside the scope is read off whichever chart was last activated, which on a server with two rooms is
 *  the other table's. One line, so the two locks read one chart. */
function stockChartRefusal(state: GameStateResponse, ask: () => string | null): string | null {
  return withRules(resolveVariants(state.variants), ask);
}

/** #1612: the same scope for the home station's questions, which read the board's home table, heralds and
 *  printed cities. */
function withTableRules(state: GameStateResponse, ask: () => string | null): string | null {
  return withRules(resolveVariants(state.variants), ask);
}

/** The Batch-6 authority questions, in the order the reducer asks them. `null` when nothing objects. */
export function operatingLegalityRefusal(
  state: GameStateResponse,
  msg: GameplayExecuteMsg,
  mapGrid: MapGridResponse | undefined,
  /** #1591/#1592: the sender, for the consent half of the two direct settlements. Absent skips it (#549b). */
  actor?: string | null,
): string | null {
  if ("RunMultipleRoutes" in msg) {
    return routeSetRefusal(state, msg.RunMultipleRoutes, mapGrid, mapGrid ? tileEraFor(state) : undefined);
  }
  if ("RunManualRoute" in msg && typeof state.rules_engine_version === "number") {
    return "RunManualRoute is a legacy replay message; a live game runs its trains with RunMultipleRoutes.";
  }
  if ("DeclareDividends" in msg) return dividendAmountRefusal(state, msg.DeclareDividends);
  /* Design notes #1591/#1592 (ingress, Batch 7.4): the two direct settlements are answered with their reason.
     The seat rule has already run (the operating president); what is asked here is the transaction -- the
     Operating turn, the phase or the step, the card or the train, the price, the treasury and CONSENT: a
     matching accepted offer, or one principal on both sides. The reducer asks the same predicate by identity. */
  if ("BuyPrivateCompany" in msg) {
    const { protocol_id, private_id, price } = msg.BuyPrivateCompany;
    return privatePurchaseRefusal(state, { buyerId: protocol_id, privateId: private_id, price }, actor, "settlement");
  }
  if ("BuyTrainFromCorporation" in msg) {
    const { buyer_protocol_id, seller_protocol_id, model_type, price } = msg.BuyTrainFromCorporation;
    return trainSaleRefusal(
      state,
      { buyerId: buyer_protocol_id, sellerId: seller_protocol_id, model: model_type, price },
      actor,
      mapGrid,
      "settlement",
    );
  }
  return routeSkipRefusal(state, msg, mapGrid);
}

/* ==================================================================
    DESIGN NOTE 1249: EACH ROOM MESSAGE HAS AN OWNER, EVEN THOUGH NONE HAS A SEAT
   ==================================================================
   #1220 exempted the whole family from the seat and said so was a gap. It was, and the reason it was left
   open is worth restating: "the answers are per-message and mostly need the room document (who is host) or
   the reducer's own legality checks, neither of which belongs in a turn gate." Half of that is still true --
   the reducer's legality checks stay the reducer's -- and the other half is answered by two more inputs, the
   host and the log, both of which the server holds and hands over.

   THE RULES, ONE PER MESSAGE, and each is the question the SHELL already asks before it shows the button:
     SetupGame        the host starts the game (the Start button is the host's), on an undealt board.
     OpenStockRound   the auction must be over -- `auctionHandoffPending` in the shell: round is the auction
                      and the atom has no private left to sell. Anybody may press it, as anybody may in the
                      shell; the board decides whether it is true.
     SetBoPar         the B&O private's owner, and the message must name them (#549: the winner travels).
     PlaceHomeStation the corporation's president; a D&H placement additionally by the D&H's owner.
     ExchangePrivate  the private's owner, named in the message.
     RevertTo         `undoReachFor`'s rule, on the server's own log: the host reverts anything; anybody else
                      only their own last non-derived action, and only when it is the last one standing.
     CloseRoom        at GameEnd. A close that lost the race is still allowed through so #899's silence holds
                      (the reducer no-ops it); what is refused is closing a game that is not over.

   REFUSED BY THE OWNER, NEVER BY LEGALITY. Whether the B&O CAN be parred (`boPresidencyRefusal`), whether a
   token IS owed, whether an exchange is legal -- those are the reducer's, and a refusal here that duplicated
   them would be #1184's shape. This asks only "is this yours to send".
   (Batch 7.2 #1570 and Slice 8.2 #1611 add two legality questions AFTER this function, in `turnRefusal`: the
   B&O par ladder and the home placement -- asked of the SAME predicates the reducer asks, which is the opposite
   of #1184's duplicate. Whether a D&H station is legal stays the D&H's.)

   `undefined` HOST OR LOG SKIPS THAT CHECK, deliberately. The replay harness and the CLI run this without a
   room document; refusing there would be a gate judging on a field nobody gave it. On the server both are
   always supplied (`RoomSession.submit`). */
function roomMessageRefusal(input: TurnAuthorityInput, actor: string): string | null {
  const { state, waterfall, msg, host, log } = input;

  if ("SetupGame" in msg) {
    /* #538's rule read from the other side -- "a room's roster is not the fixture, corrected; it is nothing,
       until the log says otherwise" -- so a non-empty roster IS the record that the deal has happened. */
    if (state.player_addresses.length > 0) return "This game has already been dealt.";
    if (host !== undefined && host !== null && actor !== host) return "Only the host can start the game.";
    return null;
  }

  if ("OpenStockRound" in msg) {
    if (state.current_round_type !== "WaterfallAuction") return "The Stock Round is already open.";
    const unsold = waterfall?.privates.length ?? 0;
    if (unsold > 0) {
      return `The auction is not over yet — ${unsold} private ${unsold === 1 ? "company is" : "companies are"} still for sale.`;
    }
    return null;
  }

  if ("SetBoPar" in msg) {
    const { player } = msg.SetBoPar as { player: string };
    const owner = state.private_companies.find((entry) => entry.private_id === BO_PRIVATE_ID)?.owner ?? null;
    if (actor !== player || (owner !== null && owner !== actor)) {
      return `Only the ${BO_TICKER} private's owner pars the ${BO_TICKER}.`;
    }
    return null;
  }

  if ("PlaceHomeStation" in msg) {
    const { company_id, kind } = msg.PlaceHomeStation as { company_id: number; kind?: string };
    const company = state.public_companies.find((entry) => entry.company_id === company_id);
    if (!company) return "That corporation is not in this game.";
    if (company.president !== actor) return `Only ${company.ticker}'s president places its station.`;
    if (kind === "dh") {
      const dh = state.private_companies.find((entry) => entry.private_id === DH_PRIVATE_ID);
      if (dh && dh.owner !== actor) return "Only the Delaware & Hudson's owner can use its free station.";
    }
    return null;
  }

  if ("ExchangePrivate" in msg) {
    const { player, private_id } = msg.ExchangePrivate as { player: string; private_id: number };
    const priv = state.private_companies.find((entry) => entry.private_id === private_id);
    if (actor !== player || (priv !== undefined && priv.owner !== actor)) {
      return `Only the ${priv?.name ?? "private company"}'s owner can exchange it.`;
    }
    return null;
  }

  if ("RevertTo" in msg) {
    if (log === undefined) return null;
    if (host !== undefined && host !== null && actor === host) return null;
    const { index } = msg.RevertTo as { index: number };
    const live = effectiveActions(log);
    const target = live.find((entry) => entry.index === index) ?? null;
    if (target === null) return "There is nothing at that point in the log to undo.";
    const last = [...live].reverse().find((entry) => entry.derived !== true) ?? null;
    if (last === null || last.index !== target.index || target.actor !== actor) {
      return "Other players have acted since your last move. Only the host can undo past somebody else's turn.";
    }
    return null;
  }

  if ("CloseRoom" in msg) {
    return state.current_round_type === "GameEnd" ? null : "The game is not over yet.";
  }

  /* ==================================================================
      DESIGN NOTE 1450: THE PROPOSER IS THE BUYER'S PRESIDENT, NOT THE OWNER BEING ASKED
     ==================================================================
     #1220 named this family "a real gap" and #1249 closed six of it. These two were missed, and the
     consequence is exactly what that note warned of: both are seat-exempt through `isSandboxOnlyMsg`, and
     `roomMessageRefusal` had no branch for either, so they fell to the `return null` at the foot of this
     function. Verified before it was fixed -- a player who owned nothing could offer a private company
     belonging to somebody else, or offer a train out of a corporation they did not preside over.

     THE DIRECTION IS THE WHOLE OF IT, AND IT IS EASY TO GET BACKWARDS. #701 states it: "A corporation on
     its turn OFFERS; the private's owner or the selling president ANSWERS." So on a PROPOSE the owner named
     in the payload (`owner`, `seller_president`) is the RESPONDER -- the party whose consent is being
     sought -- and binding authorization to them would refuse every legitimate offer and admit none. The
     party who may initiate is the president of `buyer_protocol_id`, which both payloads carry and which
     `App.tsx` fills from the operating cursor at both dispatch sites.

     OWNERSHIP ONLY, on this layer's rule. Whether that corporation is the one operating, whether it is at a
     step where it may buy, whether the price is payable, whether the private is for sale at all: every one
     of those is the reducer's, and `consentAnswerRefusal` still owns the answering half. This asks the one
     question a socket boundary can answer for itself -- "is this yours to send". */
  /* Design note #1595 (ingress, Batch 7.4): AND NOW THE WHOLE TRANSACTION, not ownership only. #1450's
     "is this yours to send" is the first line of each proposal predicate (the buyer's CURRENT president);
     the rest -- the Operating turn, the phase or the step, the card or the train, the band or the $1 floor,
     the treasury, the one-offer rule -- is the same predicate the reducer's core asks by identity, so the
     submitter hears the sentence (S10-1). The payload's `owner` / `seller_president` are not read. */
  if ("ProposePrivatePurchase" in msg) {
    return proposePrivatePurchaseRefusal(state, msg.ProposePrivatePurchase as { private_id: number; buyer_protocol_id: number; price: number }, actor);
  }
  if ("ProposeTrainPurchase" in msg) {
    return proposeTrainPurchaseRefusal(
      state,
      msg.ProposeTrainPurchase as { seller_protocol_id: number; buyer_protocol_id: number; model_type: string; price: string },
      actor,
      input.mapGrid,
    );
  }
  /* #1594: the withdrawals are the buyer's current president's; the trade's is its proposer's. */
  if ("RescindPrivatePurchase" in msg) {
    return rescindPrivatePurchaseRefusal(state, msg.RescindPrivatePurchase as { private_id: number }, actor);
  }
  if ("RescindTrainPurchase" in msg) {
    return rescindTrainPurchaseRefusal(state, msg.RescindTrainPurchase as { seller_protocol_id: number }, actor);
  }
  if ("RescindPrivateTrade" in msg) {
    return rescindPrivateTradeRefusal(state, msg.RescindPrivateTrade as { private_id: number }, actor);
  }
  /* #1593: the player <-> player trade is proposed by the seat holder, who must be the buyer or the seller;
     the predicate says so, and the rest of the rule (3.1) with it. */
  if ("ProposePrivateTrade" in msg) {
    return proposePrivateTradeRefusal(
      state,
      msg.ProposePrivateTrade as { private_id: number; seller: string; buyer: string; price: number },
      actor,
    );
  }

  /* Design note #1323: THE LICENCE IS THE OPERATING PRESIDENT'S TO BUY. It is sandbox-only (the chain has
     never heard of it) so it lands here rather than at the seat cursor, and its owner is the president of the
     corporation named -- the same test `PlaceHomeStation` makes. Whether that corporation is the one
     operating, at the Lay Track step, with the money, is `kanawhaLicenseRefusal`'s question and the arm's. */
  if ("BuyKanawhaLicense" in msg) {
    const { protocol_id } = msg.BuyKanawhaLicense as { protocol_id: number };
    const company = state.public_companies.find((entry) => entry.company_id === protocol_id);
    if (!company) return "That corporation is not in this game.";
    if (company.president !== actor) return `Only ${company.ticker}'s president buys its Kanawha Licence.`;
    return null;
  }

  return null;
}

/** `"not-a-consent-answer"` when the message is not one; otherwise a refusal or `null`.
 *
 *  A THREE-VALUED ANSWER ON PURPOSE. Folding "this is not a consent answer" into `null` would exempt every
 *  message that happens not to match, which is the whole gate. #232's rule about absence, applied to a
 *  branch rather than to a field. */
function consentAnswerRefusal(
  state: GameStateResponse,
  actor: string,
  msg: GameplayExecuteMsg,
  mapGrid?: MapGridResponse,
): string | null | "not-a-consent-answer" {
  if ("AnswerPrivatePurchase" in msg) {
    const offer = state.private_purchase_offer ?? null;
    /* #662: answering an offer that is no longer there is not an error -- the first answer settles it and
       the second finds nothing. The reducer's arm returns the state unchanged; refusing here would turn a
       harmless duplicate into an error message on somebody's screen. */
    if (!offer) return null;
    // #1541: a funding offer is the seller's own; its answer belongs to the buying president, not to this arm.
    if (offer.funding) return "That offer is answered by the buying corporation's president (AnswerFundingPrivateOffer).";
    /* #1595 (Batch 7.4): the answerer is the private's CURRENT owner, re-derived from the board -- the offer's
       `owner` is what the proposal recorded and is not the authority -- and a yes is re-validated against the
       board of this moment. Same function as the reducer's core. */
    return answerPrivatePurchaseRefusal(state, msg.AnswerPrivatePurchase as { private_id: number; accept: boolean }, actor);
  }

  /* #1593: the trade's answer is the OTHER party's -- whichever of buyer and seller did not propose. */
  if ("AnswerPrivateTrade" in msg) {
    return answerPrivateTradeRefusal(state, msg.AnswerPrivateTrade as { private_id: number; accept: boolean }, actor);
  }

  /* #1541: the funding private offer is answered by the BUYING corporation's president -- the reverse of the
     ordinary private offer above, and off-turn like every consent answer. */
  if ("AnswerFundingPrivateOffer" in msg) {
    const offer = state.private_purchase_offer ?? null;
    if (!offer || !offer.funding) return null; // settled or withdrawn already: a harmless duplicate (#662)
    const buyer = state.public_companies.find((company) => company.company_id === offer.buyer_protocol_id);
    return buyer?.president === actor ? null : `Only ${offer.buyer_ticker}'s president can answer this offer.`;
  }

  if ("AnswerTrainPurchase" in msg) {
    const offer = state.train_purchase_offer ?? null;
    if (!offer) return null;
    /* THE SELLER'S PRESIDENT ANSWERS, and it is the BUYER who is on turn -- #701 states the direction
       explicitly, and getting it backwards would refuse every train trade in the game. #1595: the seller's
       CURRENT president, re-derived from the board; the offer's `seller_president` is narration. */
    return answerTrainPurchaseRefusal(state, msg.AnswerTrainPurchase as { seller_protocol_id: number; accept: boolean }, actor, mapGrid);
  }

  return "not-a-consent-answer";
}
