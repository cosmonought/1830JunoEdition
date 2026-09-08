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
//
// THE ALLOWLIST IS THE ONLY JUDGEMENT CALL, and it is small: a few messages legitimately change nothing.
// `AcceptTrainOffer` and its siblings address an offer register the sandbox does not model (`sandboxSession`
// says so outright: "UNMODELLABLE here, not merely unmodelled"); `RevertTo` is an instruction about the log
// rather than a move; a chat or setup event is not a move either. Naming them positively means a NEW
// message that silently does nothing has to justify itself here rather than inherit an exemption.
//
// #750 AND #768'S PRINCIPLE, applied to the log itself: report what the authority DID by comparing two
// states, never what a message was asked to do.

import type { GameplayExecuteMsg } from "./sessionKey";
import type { GameStateResponse } from "./gameState";
import { sharePurchaseBlock, type PriceZone } from "./sharePurchase";
import { shareSaleBlock } from "./shareSale";
import { dividendRefusal } from "./dividendGate";
// Design note #1019: the purchase gate, asked here on the same state the reducer asked it on.
import { trainPurchaseRefusal } from "./trainPurchaseGate";
import { depotInventory } from "./gamePhase";
import { boPresidencyRefusal, returnedTrainRefusal } from "./sandboxSession";
import { BO_TICKER } from "./gameConstants";
import { dieselExchangeRefusal } from "./dieselExchange";

/** Messages that legitimately leave sandbox state untouched, so an unchanged board is not a refusal.
 *  Kept as an explicit list for the reason in the note: an exemption should be a decision. */
export const NO_OP_MESSAGE_KEYS: readonly string[] = [
  // The offer register is its own query; an accepted offer settles via `BuyTrainFromCorporation`.
  "AcceptTrainOffer",
  "RejectTrainOffer",
  "RescindTrainOffer",
  "ProposeTrainOffer",
  // An instruction about the log, already honoured by `effectiveActions` before the reducer sees it.
  "RevertTo",
  "UndoLastAction",
  // Not moves.
  "SetupGame",
  "Chat",
  // The contract's own round driver; the sandbox settles transitions itself.
  "ExecuteOperatingRound",
  /* #1248: every client's countdown and any player's button all send this, and the reducer lets the first
     one win (#899). The second through fourth are the design working, not a rule declining anything. */
  "CloseRoom",
];

/** Whether this message is one that may do nothing without it meaning anything went wrong. */
export function mayLegitimatelyDoNothing(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return true;
  return NO_OP_MESSAGE_KEYS.some((key) => key in msg);
}

/** #1248: whether a message that changed nothing should print NOTHING -- not a success line, not a refusal.
 *
 *  Narrower than `mayLegitimatelyDoNothing` on purpose. That list says "an unchanged board is not a refusal";
 *  most of its members still earn their line (an undo, a chat). These are the ones #899 wanted silent: "a
 *  player whose timer lost the race has done nothing wrong, and logging it would put four identical scare
 *  lines in the Activity Log of a finished game." The shell's branch used to `return` before the log for
 *  them; with the branch gone (#1248) the quiet has to be a rule the general path can ask. */
const SILENT_WHEN_UNCHANGED: readonly string[] = ["CloseRoom"];
export function silentWhenUnchanged(msg: unknown, before: unknown, after: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  if (before === null || before === undefined || before !== after) return false;
  return SILENT_WHEN_UNCHANGED.some((key) => key in msg);
}

/** Whether the reducer declined this action.
 *
 *  `before === after` by REFERENCE, which is what every gate produces when it refuses. A reducer that
 *  legitimately computes an identical-but-new object would read as applied, and that is the safe direction
 *  to be wrong in: a false "refused" on a real action would be a lie in the other direction. */
export function actionWasRefused(
  before: unknown,
  after: unknown,
  msg: GameplayExecuteMsg | Record<string, unknown>,
): boolean {
  if (before === null || before === undefined) return false;
  if (mayLegitimatelyDoNothing(msg)) return false;
  return before === after;
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
  marketZoneFor?: (companyId: number) => PriceZone;
  marketPricesByCompany?: Readonly<Record<number, number>> | null;
  zoneForPrice?: (price: number | null | undefined) => PriceZone;
}

export function refusalReasonFor(
  before: GameStateResponse | null | undefined,
  msg: GameplayExecuteMsg | Record<string, unknown>,
  ctx?: RefusalContext,
): string | null {
  if (!before || typeof msg !== "object" || msg === null) return null;

  if ("BuyStock" in msg && ctx?.actor && ctx.marketZoneFor) {
    const buy = (msg as { BuyStock: { protocol_id: number; source: "Ipo" | "Bank"; quantity?: number } })
      .BuyStock;
    return sharePurchaseBlock({
      state: before,
      buyer: ctx.actor,
      companyId: buy.protocol_id,
      source: buy.source,
      quantity: buy.quantity ?? 1,
      zone: ctx.marketZoneFor(buy.protocol_id),
      marketPrices: ctx.marketPricesByCompany ?? null,
      zoneForPrice: ctx.zoneForPrice,
    });
  }

  if ("SellStock" in msg && ctx?.actor) {
    const sell = (msg as { SellStock: { protocol_id: number; percentage: number } }).SellStock;
    return shareSaleBlock({
      state: before,
      seller: ctx.actor,
      companyId: sell.protocol_id,
      percentage: sell.percentage,
    });
  }

  if ("DeclareDividends" in msg) {
    const declare = (msg as { DeclareDividends: { protocol_id: number } }).DeclareDividends;
    return dividendRefusal(before, declare.protocol_id);
  }

  /* ==================================================================
      DESIGN NOTE 1019: THE PURCHASE OWNS UP TOO
     ==================================================================
     REPORTED: "the reducer partially executed, drained the $340 to $0, failed to award the train, but still
     printed a success log."

     THE SUCCESS LOG WAS A CONSEQUENCE, NOT A SECOND BUG. #778 detects a refusal by identity, and a reducer
     that mutates has not refused -- so the log was reporting exactly what happened. With the gate in place the
     purchase returns its state unchanged, the drain sees the identity, and this arm supplies the sentence.

     THE SAME CALL THE REDUCER MADE, on the same `before` state and the same tier lookup -- #784's whole
     argument for this function existing. A second opinion assembled here would be a guess about which rule
     fired, and a confident wrong reason in an authoritative log is what cost an earlier session three
     investigations.

     BOTH MESSAGES, because both reach `buyDepotTrain`. `EmergencyBuyHardware` waives only the funds check --
     it has already covered the shortfall by the time the reducer charges -- so it is asked with
     `requireFunds: false` here for the same reason it is there: a reason that named a shortfall the president
     had just paid would be a false accusation. */
  // Design note #1314: a purchase naming a returned train has its own gate.
  if ("BuyHardwareFromPool" in msg) {
    const buy = (msg as { BuyHardwareFromPool: { protocol_id: number; returned_model_type?: string } })
      .BuyHardwareFromPool;
    if (buy.returned_model_type !== undefined) {
      return returnedTrainRefusal(before, buy.protocol_id, buy.returned_model_type);
    }
  }
  const purchase =
    "BuyHardwareFromPool" in msg
      ? { companyId: (msg as { BuyHardwareFromPool: { protocol_id: number } }).BuyHardwareFromPool.protocol_id, requireFunds: true }
      : "EmergencyBuyHardware" in msg
        ? { companyId: (msg as { EmergencyBuyHardware: { protocol_id: number } }).EmergencyBuyHardware.protocol_id, requireFunds: false }
        : null;
  if (purchase) {
    const tier = depotInventory(before).find(
      (row) => row.remaining === null || row.remaining > 0,
    );
    return trainPurchaseRefusal(before, purchase.companyId, {
      cost: tier?.cost ?? null,
      trainLimit: tier?.trainLimit ?? null,
      requireFunds: purchase.requireFunds,
    });
  }

  // Design note #1303: the same gate the reducer asked, on the same `before` state.
  if ("ExchangeTrainForDiesel" in msg) {
    const { protocol_id, model_type } = (
      msg as { ExchangeTrainForDiesel: { protocol_id: number; model_type: string } }
    ).ExchangeTrainForDiesel;
    return dieselExchangeRefusal(before, protocol_id, model_type);
  }

  /* #1246: the B&O grant's own refusal (#904b), the same call the reducer's arm makes on the same state. The
     shell used to print this sentence itself before falling through; now the REFUSED line carries it. */
  if ("SetBoPar" in msg) return boPresidencyRefusal(before, BO_TICKER);

  /* #1247: a second answer finds the question settled (#662). The arm returns the state unchanged, which the
     drain reads as a refusal -- and it is one, of the harmless kind, so the line says which. */
  if ("AnswerPrivatePurchase" in msg || "AnswerTrainPurchase" in msg) {
    const offer =
      "AnswerPrivatePurchase" in msg ? before.private_purchase_offer : before.train_purchase_offer;
    return !offer || offer.accepted
      ? "That offer had already been answered."
      : "That answer did not match the offer on the table.";
  }

  return null;
}

/** #778's line, with the rule appended when one owns up to it. */
export function refusedActionLineWithReason(label: string, reason: string | null): string {
  return reason === null
    ? refusedActionLine(label)
    : `REFUSED — ${label} ${reason}`;
}
