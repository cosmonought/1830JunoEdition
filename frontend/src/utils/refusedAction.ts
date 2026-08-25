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
];

/** Whether this message is one that may do nothing without it meaning anything went wrong. */
export function mayLegitimatelyDoNothing(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return true;
  return NO_OP_MESSAGE_KEYS.some((key) => key in msg);
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

  return null;
}

/** #778's line, with the rule appended when one owns up to it. */
export function refusedActionLineWithReason(label: string, reason: string | null): string {
  return reason === null
    ? refusedActionLine(label)
    : `REFUSED — ${label} ${reason}`;
}
