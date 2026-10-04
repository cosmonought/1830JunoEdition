// frontend/src/utils/refusedAction.ts
//
// Whether an action the log recorded actually did anything.
//
// ==================================================================
//  DESIGN NOTE 778: THE LOG REPORTED A PURCHASE THAT NEVER HAPPENED
// ==================================================================
//
// REPORTED: "player was at 60% corporation limit. The activity log printed the purchase went through but it
// didn't. There was no notification that the player was at certificate limit."
//
// THE LOG WROTE `status: "success"` UNCONDITIONALLY. Every dispatch that reached the drain got a success
// entry describing the MESSAGE, whether or not the reducer did anything with it. Since #712 the reducer has
// been refusing illegal messages by returning the state unchanged -- #712's own reasoning, that "a replay
// must not halt on an entry the log already contains" -- and #748, #757, #763 and #774 all added gates on
// the same pattern. Every one of them is silent by construction, and the log has been announcing all of
// their refusals as successes.
//
// THIS IS WHY THIS SESSION WAS HARD. Half of today's reports were of the form "the log says X but Y
// happened", and I read several of them as arithmetic bugs. A log that cannot distinguish "did it" from
// "declined it" is worse than no log: it is an authoritative-looking account that quietly disagrees with the
// board, and it sent me looking for phantom mechanisms three times.
//
// A REFUSAL IS AN IDENTITY, NOT A HEURISTIC. Every gate returns the SAME OBJECT it was given -- `return
// state` -- so `after === before` is exact rather than a guess about intent. No deep comparison, no field
// list to keep in step with the reducer.
// [#1685, Stage 10.2: no longer true on a charted board -- the comparison is by content now; see below.]
//
// THE ALLOWLIST IS THE ONLY JUDGEMENT CALL, and it is small: a few messages legitimately change nothing.
// `AcceptTrainOffer` and its siblings address an offer register the sandbox does not model (`sandboxSession`
// says so outright: "UNMODELLABLE here, not merely unmodelled"); `RevertTo` is an instruction about the log
// rather than a move; a chat or setup event is not a move either. Naming them positively means a NEW
// message that silently does nothing has to justify itself here rather than inherit an exemption.
//
// #750 AND #768'S PRINCIPLE, applied to the log itself: report what the authority DID by comparing two
// states, never what a message was asked to do.

import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";
import {
  UNCHANGED_IS_NOT_A_REFUSAL,
  atomsUnchanged,
  authorityDeclined,
  unchangedMeansRefused,
} from "../gameEngine/actionOutcome";
import type { PriceZone } from "../gameEngine/sharePurchase";
import { dividendRefusal } from "../gameEngine/dividendGate";
import { dividendAmountRefusal } from "../gameEngine/routeAuthority";
// Design note #1019: the purchase gate, asked here on the same state the reducer asked it on.
import { trainPurchaseRefusal } from "../gameEngine/trainPurchaseGate";
import { depotInventory, openDepotTiers } from "../gameEngine/gamePhase";
import {
  SANDBOX_NOMINAL_SHARE_PRICE,
  boPresidencyRefusal,
  limitInForce,
  returnedTrainRefusal,
} from "../gameEngine/sandboxSession";
import { BO_TICKER } from "../gameEngine/gameConstants";
import { auctionLifecycleRefusal, isAuctionLifecycleMessage } from "../gameEngine/auctionAuthority";
import { dieselExchangeRefusal } from "../gameEngine/dieselExchange";
// UR-3 (OD-UR-1 = 1-A, D-37): the pinned table's refusal of a client-sent Yellow Sign, shared with ingress and the gate.
import { yellowSignRequestRefusal } from "../gameEngine/yellowSign";
import { roundTransitionRefusal } from "../gameEngine/roundTransitionAuthority"; // RR2A-F1
import { discardTrainRefusal } from "../gameEngine/trainDiscard";
import {
  declareBankruptcyRefusal,
  emergencyFundingFor,
  emergencyPurchaseRefusal,
  forcedSaleRefusal,
  fundingPrivateAnswerRefusal,
  fundingPrivateOfferRefusal,
  fundingPrivateRescindRefusal,
} from "../gameEngine/emergencyFunding";
/* W1-H (Phase 3): the remaining predicates the reducer asks -- the hold composition (#1613), the offers' three
   authorities and the pinned-board refusal of the chain-era messages (#1590-#1595), the train obligation (#1513),
   the must-sell pass (DA-5), the stock transaction (#1570) -- and the scope ingress judges in (R12-2). */
import { authoritativeHoldRefusal } from "../gameEngine/authoritativeHolds";
import { boardHomeHexToAxial, type HomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { legacyOfferMessageRefusal } from "../gameEngine/pendingOfferHold";
import { HARMLESS_DUPLICATE_ANSWER_SENTENCE, harmlessDuplicateAnswer } from "../gameEngine/harmlessDuplicate";
import {
  answerPrivatePurchaseRefusal,
  privatePurchaseRefusal,
  proposePrivatePurchaseRefusal,
  rescindPrivatePurchaseRefusal,
} from "../gameEngine/privatePurchaseAuthority";
import {
  answerTrainPurchaseRefusal,
  proposeTrainPurchaseRefusal,
  rescindTrainPurchaseRefusal,
  trainSaleRefusal,
} from "../gameEngine/trainSaleAuthority";
import {
  answerPrivateTradeRefusal,
  proposePrivateTradeRefusal,
  rescindPrivateTradeRefusal,
} from "../gameEngine/privateTradeAuthority";
import { cheapestPurchasableTrain, trainObligationRefusal } from "../gameEngine/trainAvailability";
import { divestmentPassRefusal } from "../gameEngine/forcedDivestment";
import {
  chartContextFromState,
  parLadderRefusal,
  purchaseIntentOf,
  stockPurchaseRefusal,
  stockSaleRefusal,
  type StockChartContext,
} from "../gameEngine/stockTransactionAuthority";
import { routeRulesRevisionOf, withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";

/* ==================================================================
    DESIGN NOTE 1685 (Stage 10.2, S10-1): THE IDENTITY BELOW WAS DEFEATED BY THE CHART, AND IS GONE
   ==================================================================
   #778's "a refusal is an identity" stopped being observable at #1197: the chart step returns a fresh object
   for every charted action, and the shell hands the reducer a fresh `{ ...before, market_positions, waterfall }`
   anyway, so `before === after` was false for every dispatch in room play and in every replay -- the REFUSED
   receipt never fired, and #899's CloseRoom silence (#1248) never held. The comparison is now CONTENT, and it
   is not this file's: `authorityDeclined` (`gameEngine/actionOutcome.ts`) is the one definition the server's
   transport also asks, over the same atoms (the board, with its chart and auction, and the tile grid when the
   caller has one). The allowlist is that module's too, and it is shorter than #778's -- see #1685a for why
   `SetupGame`, `UndoLastAction`, `ExecuteOperatingRound` and the chain-era offer messages left it. */

/** Messages that legitimately leave the board untouched, so an unchanged board is not a refusal (#1685a). */
export const NO_OP_MESSAGE_KEYS: readonly string[] = UNCHANGED_IS_NOT_A_REFUSAL;

/** Whether this message is one that may do nothing without it meaning anything went wrong. With `before` (the
 *  board it was judged on), #1687's harmless duplicate answers are recognised too. */
export function mayLegitimatelyDoNothing(msg: unknown, before?: GameStateResponse): boolean {
  return !unchangedMeansRefused(msg, before);
}

/** The two tile grids around an action, when the caller holds them (the shell's `mapGridRef`). */
export interface GridPair {
  before: MapGridResponse | undefined;
  after: MapGridResponse | undefined;
}

/** #1248: whether a message that changed nothing should print NOTHING -- not a success line, not a refusal.
 *
 *  Narrower than `mayLegitimatelyDoNothing` on purpose. That list says "an unchanged board is not a refusal";
 *  most of its members still earn their line (an undo). These are the ones #899 wanted silent: "a player whose
 *  timer lost the race has done nothing wrong, and logging it would put four identical scare lines in the
 *  Activity Log of a finished game." #1685: "changed nothing" is `atomsUnchanged`, by content. */
const SILENT_WHEN_UNCHANGED: readonly string[] = ["CloseRoom"];
export function silentWhenUnchanged(msg: unknown, before: unknown, after: unknown, grids?: GridPair): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  if (before === null || before === undefined || after === null || after === undefined) return false;
  if (!SILENT_WHEN_UNCHANGED.some((key) => key in msg)) return false;
  return atomsUnchanged(
    { state: before as GameStateResponse, grid: grids?.before },
    { state: after as GameStateResponse, grid: grids?.after },
  );
}

/** Whether the authority declined this action.
 *
 *  #1685: BY CONTENT, through `authorityDeclined` -- the same function, over the same atoms, that decides
 *  whether the server appends a submission. `before` is the board the reducer was HANDED (the shell passes the
 *  object carrying its chart and auction mirrors), `after` the board it returned. */
export function actionWasRefused(
  before: unknown,
  after: unknown,
  msg: SandboxLogMsg,
  grids?: GridPair,
): boolean {
  if (before === null || before === undefined || after === null || after === undefined) return false;
  return authorityDeclined(
    msg,
    { state: before as GameStateResponse, grid: grids?.before },
    { state: after as GameStateResponse, grid: grids?.after },
  );
}

/** The line the Activity Log shows in place of the success sentence.
 *
 *  NAMES THE ACTION AND SAYS THE BOARD DID NOT MOVE, without claiming to know which rule refused it. The
 *  gates return no reason to the drain -- they return state -- and inventing a likely one here would be the
 *  same mistake in a smaller font. The panel's own tooltip carries the rule; this line's job is to stop the
 *  log asserting something false. */
export function refusedActionLine(label: string): string {
  return `REFUSED — ${label} The board did not change; a rule declined this action.`;
}

/* ==================================================================
 *  DESIGN NOTE 784: THE REFUSAL NAMES ITS RULE
 * ==================================================================
 *
 * #778 stopped the log claiming a refused action had happened, and deliberately declined to say WHY -- "the
 * gates return state, not reasons, so any rule named here would be a guess".
 *
 * THAT WAS TRUE OF THE DRAIN AND IS NOT TRUE OF THIS FUNCTION, because of where it stands. The reducer
 * refuses by calling `sharePurchaseBlock`, `shareSaleBlock` and `dividendRefusal` on the BEFORE state; this
 * asks the SAME functions on the SAME state. It is not a second opinion about what should have happened --
 * it is the identical call, so whatever it returns is what the reducer acted on.
 *
 * WHY IT MATTERS BEYOND TIDINESS. Reported: "player was at 60% corporation limit ... There was no
 * notification that the player was at certificate limit." The rule was written (#712), rendered (#681) and
 * put in a disabled button's `title` -- which is invisible on a tablet and easy to miss anywhere. Worse, that
 * tooltip only exists when the BUTTON knows; here the button did not, and the reducer did.
 *
 * WHICH IS THE OTHER HALF OF THAT REPORT AND IS NOT FIXED HERE: the panel and the reducer disagreed about
 * whether the purchase was legal, or the button would have been disabled and no message sent. Most likely the
 * panel read a `gameState` a frame behind the ref the reducer used -- this project's recurring ref/state pair
 * -- but that is a hypothesis, and #750's lesson is to instrument rather than guess. This makes the
 * disagreement VISIBLE and named every time it happens, which is what a next playtest can act on.
 *
 * `null` WHEN NOTHING CLAIMS IT. A refusal this cannot attribute stays unattributed rather than picking the
 * likeliest arm: a confident wrong reason in an authoritative-looking log is precisely what cost this session
 * three investigations. */
export interface RefusalContext {
  actor?: string | null;
  /** #1540: the board's grid, for the forced-purchase obligation's reasons (a route walk). */
  mapGrid?: MapGridResponse;
  marketZoneFor?: (companyId: number) => PriceZone;
  /** W1-H: widened to the reducer's own type (`SandboxActionContext`), so the server's chart injections pass as-is. */
  marketPricesByCompany?: Readonly<Record<number, number | null>> | null;
  zoneForPrice?: (price: number | null | undefined) => string | null;
  /** W1-H: the board's label table for the home-station hold; absent, the board's own (`boardHomeHexToAxial`). */
  homeHexToAxial?: HomeHexToAxial;
}

export function refusalReasonFor(
  before: GameStateResponse | null | undefined,
  msg: SandboxLogMsg,
  ctx?: RefusalContext,
): string | null {
  if (!before || typeof msg !== "object" || msg === null) return null;
  /* W1-H (Phase 3, AUD-14.03): ASKED WITH THE TABLE'S OWN BOARD, TRAY AND CHART IN EFFECT -- `turnRefusal`'s R12-2
     scope, for the same reason. The reducer is already inside one (`applySandboxAction`); the server's refusal
     transport (`RoomSession.submit`) is not, so a par ladder, a price zone or a home table read there was read off
     whichever board was last activated. Nested, it is the same scope (the shell's receipt). */
  const board = before;
  return withRules(
    resolveVariants(board.variants),
    () => refusalReasonOnTableBoard(board, msg, ctx),
    routeRulesRevisionOf(board),
  );
}

/* ==================================================================
    W1-H (Phase 3 -- AUD-14.03 / U-30, AUD-14.04 / U-29, AUD-14.05 / ING-2 + I-6): EVERY ARM IS THE REDUCER'S
   ==================================================================
   #784's rule, applied to the arms it had not reached: the Activity Log's REFUSED line (and the server's `refused`
   frame, which asks this function when ingress let a message through and the reducer then declined it) carries the
   sentence of the predicate the reducer asked, on the same board, in the reducer's order -- the board gate
   (`applySandboxActionOnBoard`: the four holds, the auction lifecycle, the round transition) and then the core
   (`applySandboxActionCoreJudged`). Nothing here states a rule; each arm is one call into the module that owns it.
   What W1-H added:
     * the four holds as ONE composition (`authoritativeHoldRefusal`) -- the standing ordinary offer and the home
       station joined the discard and the forced purchase (U-29: a held proposal read "a rule declined this");
     * the three offer kinds' proposals, answers and withdrawals, and the two consented settlements (U-29);
     * the stock transaction through `stockPurchaseRefusal` / `stockSaleRefusal` -- the reducer's and ingress's
       predicates -- instead of the two inner blocks, so the round, the first-Stock-Round ban, the price, the
       card's availability and affordability carry their sentences (U-30, I-6);
     * the Pass that a train purchase or a curable must-sell still owes (ING-2), and the B&O's par ladder;
     * the train purchase priced at the tier and limit the reducer prices it at (I-6). */
function refusalReasonOnTableBoard(
  before: GameStateResponse,
  msg: SandboxLogMsg,
  ctx?: RefusalContext,
): string | null {
  const actor = ctx?.actor ?? null;

  /* ---- the board gate (#1613): the four holds, in their priority -------------------------------------------
     #1530 the discard, #1540 the forced purchase and the finished game, #1590 a standing ordinary offer, #1612 the
     operating corporation's home station. The home table defaults to the board's own -- what ingress asks with and
     what both reducer contexts inject (`sandboxReplayProviders().chartInjections`). */
  const held = authoritativeHoldRefusal(before, msg, {
    mapGrid: ctx?.mapGrid,
    homeHexToAxial: ctx?.homeHexToAxial ?? boardHomeHexToAxial,
  });
  if (held !== null) return held;

  /* DA-3 (DA-F1, DA-F2, DA-F7): the auction's own gate, the handoff's, and the B&O private's owner -- the lifecycle
     predicate the board gate asks. */
  if (isAuctionLifecycleMessage(msg)) {
    const auction = auctionLifecycleRefusal(before, before.waterfall ?? null, msg);
    if (auction !== null) return auction;
  }

  /* RR2A-F1: a pinned table's rounds turn over by themselves. */
  {
    const round = roundTransitionRefusal(before, msg);
    if (round !== null) return round;
  }

  /* ---- the core ---------------------------------------------------------------------------------------------- */

  /* #1530: THIS discard -- the right corporation's, its president's, of a train it holds. */
  if ("DiscardTrain" in msg) {
    const { protocol_id, model_type } = msg.DiscardTrain;
    return discardTrainRefusal(before, { protocol_id, model_type }, actor);
  }

  /* UR-3 (OD-UR-1): a `YellowSignEvent` on a pinned table. */
  if ("YellowSignEvent" in msg) {
    const sign = yellowSignRequestRefusal(before);
    if (sign !== null) return sign;
  }

  /* #1540/#1541: the forced purchase's own actions, each with the reducer's reason. */
  {
    const funding = ctx?.mapGrid === undefined ? null : emergencyFundingFor(before, ctx.mapGrid);
    if (funding !== null && "SellStock" in msg && actor) {
      const forced = forcedSaleRefusal(before, funding, actor, msg.SellStock.protocol_id, msg.SellStock.percentage);
      if (forced !== null) return forced;
    }
    if ("EmergencyBuyHardware" in msg && ctx?.mapGrid !== undefined) {
      const refusal = emergencyPurchaseRefusal(before, msg.EmergencyBuyHardware.protocol_id, ctx.mapGrid, actor);
      if (refusal !== null) return refusal;
    }
    if ("OfferPrivateForFunding" in msg) {
      if (funding === null) return "No forced train purchase is owed, so no private company can be offered to fund one.";
      return fundingPrivateOfferRefusal(before, funding, msg.OfferPrivateForFunding, actor);
    }
    if ("AnswerFundingPrivateOffer" in msg) {
      return fundingPrivateAnswerRefusal(before, msg.AnswerFundingPrivateOffer, actor, ctx?.mapGrid);
    }
    if ("RescindFundingPrivateOffer" in msg) {
      return fundingPrivateRescindRefusal(before, msg.RescindFundingPrivateOffer, actor);
    }
  }

  /* Q11 / D-23: the chain-era offer messages, on a pinned board. */
  {
    const legacy = legacyOfferMessageRefusal(before, msg);
    if (legacy !== null) return legacy;
  }

  /* #1595 (Batch 7.4): the three ordinary offers' proposals, answers and withdrawals, each judged against the
     board by its transaction's own predicate. AN ANSWER THAT FOUND NOTHING TO ANSWER is #662's harmless duplicate,
     and the server answers it with one no-blame sentence (C2-02); the receipt says the same (I-6). */
  if (harmlessDuplicateAnswer(before, msg)) return HARMLESS_DUPLICATE_ANSWER_SENTENCE;
  if ("ProposePrivatePurchase" in msg) return proposePrivatePurchaseRefusal(before, msg.ProposePrivatePurchase, actor);
  if ("AnswerPrivatePurchase" in msg) return answerPrivatePurchaseRefusal(before, msg.AnswerPrivatePurchase, actor);
  if ("RescindPrivatePurchase" in msg) return rescindPrivatePurchaseRefusal(before, msg.RescindPrivatePurchase, actor);
  if ("ProposeTrainPurchase" in msg) {
    return proposeTrainPurchaseRefusal(before, msg.ProposeTrainPurchase, actor, ctx?.mapGrid);
  }
  if ("AnswerTrainPurchase" in msg) {
    return answerTrainPurchaseRefusal(before, msg.AnswerTrainPurchase, actor, ctx?.mapGrid);
  }
  if ("RescindTrainPurchase" in msg) return rescindTrainPurchaseRefusal(before, msg.RescindTrainPurchase, actor);
  if ("ProposePrivateTrade" in msg) return proposePrivateTradeRefusal(before, msg.ProposePrivateTrade, actor);
  if ("AnswerPrivateTrade" in msg) return answerPrivateTradeRefusal(before, msg.AnswerPrivateTrade, actor);
  if ("RescindPrivateTrade" in msg) return rescindPrivateTradeRefusal(before, msg.RescindPrivateTrade, actor);

  if ("DeclareBankruptcy" in msg) {
    const funding = ctx?.mapGrid === undefined ? null : emergencyFundingFor(before, ctx.mapGrid);
    return declareBankruptcyRefusal(funding, actor);
  }

  /* #1513 (ING-2): THE TURN DOES NOT END WHILE A TRAIN IS OWED that the treasury can pay for -- the gate that
     answered a `PassTurn` / `AdvanceOperatingSubPhase` at Buy Trains with the generic sentence. */
  {
    const owed = trainObligationRefusal(before, msg, ctx?.mapGrid);
    if (owed !== null) return owed;
  }

  /* #774, then Batch 6 (#1552): the step that owns the choice, then the declared amount against the run. */
  if ("DeclareDividends" in msg) {
    return (
      dividendRefusal(before, msg.DeclareDividends.protocol_id) ??
      dividendAmountRefusal(before, msg.DeclareDividends)
    );
  }

  /* ==================================================================
      DESIGN NOTE 1019: THE PURCHASE OWNS UP TOO
     ==================================================================
     REPORTED: "the reducer partially executed, drained the $340 to $0, failed to award the train, but still
     printed a success log." THE SAME CALL THE REDUCER MADE, on the same `before` state -- #784's whole argument for
     this function existing. W1-H (I-6): AND THE SAME TRAIN AND LIMIT. The depot purchase is priced at the tier the
     arm will deliver (`openDepotTiers`, the named shelf tier under the Level Playing Field) against the limit in
     force (#1530); the emergency purchase at the cheapest train for sale (#1513), against the current row's limit.
     A named tier that is not for sale is refused by the reducer without a predicate, so it stays unattributed. */
  // Design note #1314: a purchase naming a returned train has its own gate.
  if ("BuyHardwareFromPool" in msg && msg.BuyHardwareFromPool.returned_model_type !== undefined) {
    return returnedTrainRefusal(before, msg.BuyHardwareFromPool.protocol_id, msg.BuyHardwareFromPool.returned_model_type);
  }
  if ("EmergencyBuyHardware" in msg) {
    const cheapest = cheapestPurchasableTrain(before);
    if (!cheapest) return null;
    const limitRow = depotInventory(before).find((row) => row.isCurrent);
    return trainPurchaseRefusal(before, msg.EmergencyBuyHardware.protocol_id, {
      cost: cheapest.cost,
      trainLimit: limitRow?.trainLimit ?? null,
      requireFunds: false,
    });
  }
  /* Design note #1592 / #1591: the two consented settlements, as the reducer's core judges them (U-29). */
  if ("BuyTrainFromCorporation" in msg) {
    const { buyer_protocol_id, seller_protocol_id, model_type, price, gilded } = msg.BuyTrainFromCorporation;
    return trainSaleRefusal(
      before,
      { buyerId: buyer_protocol_id, sellerId: seller_protocol_id, model: model_type, price, gilded },
      actor,
      ctx?.mapGrid,
      "settlement",
    );
  }
  if ("BuyPrivateCompany" in msg) {
    const { protocol_id, private_id, price } = msg.BuyPrivateCompany;
    return privatePurchaseRefusal(before, { buyerId: protocol_id, privateId: private_id, price }, actor, "settlement");
  }
  if ("BuyHardwareFromPool" in msg) {
    const named = msg.BuyHardwareFromPool.model_type;
    const open = openDepotTiers(before);
    const tier = named === undefined ? open[0] : open.find((row) => row.tier === named);
    if (named !== undefined && !tier) return null;
    return trainPurchaseRefusal(before, msg.BuyHardwareFromPool.protocol_id, {
      cost: tier?.cost ?? null,
      trainLimit: limitInForce(before) ?? tier?.trainLimit ?? null,
      requireFunds: true,
    });
  }

  // Design note #1303: the same gate the reducer asked, on the same `before` state.
  if ("ExchangeTrainForDiesel" in msg) {
    const { protocol_id, model_type } = msg.ExchangeTrainForDiesel;
    return dieselExchangeRefusal(before, protocol_id, model_type);
  }

  /* ==================================================================
      DESIGN NOTE 1570: THE STOCK TRANSACTION, AS THE REDUCER JUDGES IT (W1-H: U-30, I-6)
     ==================================================================
     `stockPurchaseRefusal` / `stockSaleRefusal` are the predicates the reducer's core and ingress both ask; they
     compose `sharePurchaseBlock` / `shareSaleBlock` (which this arm used to ask alone) with the round, the
     corporation, the price, the card's availability, the Brown continuation and affordability. The chart context
     is the reducer's (`stockChartContext`): the zone rules from the caller's injection and from nowhere else --
     #712's "absent means unenforced" -- and the price and the pin from the board's own positions (#1196). */
  if ("BuyStock" in msg || "SellStock" in msg) {
    const fromState = chartContextFromState(before);
    const chart: StockChartContext = {
      parCellFor: fromState.parCellFor,
      marketZoneFor: ctx?.marketZoneFor,
      marketPricesByCompany: ctx?.marketPricesByCompany ?? null,
      zoneForPrice: ctx?.zoneForPrice,
      priceFor: fromState.priceFor,
      pinnedBoard: fromState.pinnedBoard,
      nominalPrice: SANDBOX_NOMINAL_SHARE_PRICE,
    };
    if ("BuyStock" in msg) {
      return stockPurchaseRefusal({ state: before, buy: purchaseIntentOf(msg.BuyStock), actor, ctx: chart });
    }
    return stockSaleRefusal({
      state: before,
      sell: { companyId: msg.SellStock.protocol_id, percentage: msg.SellStock.percentage },
      actor,
      mapGrid: ctx?.mapGrid,
      ctx: chart,
    });
  }

  /* DA-5 (D-53, D-58): #759's must-sell hold on the Stock Round pass -- only a curable excess is owed. */
  if ("PassTurn" in msg) {
    const owed = divestmentPassRefusal(before);
    if (owed !== null) return owed;
  }

  /* #1246 / #1570: the B&O grant -- the private's ownership (the lifecycle gate, above), the par ladder (the core),
     then the presidency (#904b, the arm). */
  if ("SetBoPar" in msg) {
    return (
      parLadderRefusal(msg.SetBoPar.par_value, chartContextFromState(before), BO_TICKER) ??
      boPresidencyRefusal(before, BO_TICKER)
    );
  }

  return null;
}

/** #778's line, with the rule appended when one owns up to it. */
export function refusedActionLineWithReason(label: string, reason: string | null): string {
  return reason === null
    ? refusedActionLine(label)
    : `REFUSED — ${label} ${reason}`;
}
