// frontend/src/utils/trainLimit.ts
//
// How many trains a corporation may buy right now, and why not more.
//
// Design note #703: THE LIMIT IS CHECKED AT THE INSTANT OF PURCHASE.
//
// 1830 caps what a corporation may HOLD, by phase. Two consequences follow from reading that cap at the moment
// the purchase resolves, and this codebase got one of them right and the other backwards:
//
//   RUSTING DOES NOT CREATE HEADROOM IN ADVANCE. A corporation at its limit may not buy a train even when the
//   purchase would rust one of its own and leave it legal afterwards. The limit is tested BEFORE the purchase
//   resolves, so the rusting has not happened yet.
//
//   A PHASE SHIFT DOES NOT REMOVE HEADROOM IN ARREARS. A corporation legally under the current limit may buy
//   the train that starts the next phase, even when the new phase's limit is lower than its resulting
//   holdings. The purchase was legal when it was made; the phase change is a consequence of it, not a
//   condition on it.
//
// REPORTED: "NNH owns three trains, the next available train to purchase is a 4-train, and there is a red text
// that says 'Buying a 4-train would start the next phase and cut the limit to 3, and NNH already holds 3.'
// This misunderstands the rule ... you may have confused this with a related rule: a player cannot purchase a
// train that exceeds the train limit even if doing so would rust their current trains to bring them under the
// limit."
//
// Exactly so, and design note #296 states the mistaken reasoning in as many words: "ENFORCEMENT STAYS ON THE
// AFTER-VALUE: buying the first 4-train starts Phase 4 and the limit drops with it, so capping against the old
// one would offer a quantity the rules take back." The rules take nothing back. What #296 had hold of was the
// FIRST consequence above, applied to the second one, where it inverts.
//
// EXTRACTED HERE because the panel is the only surface that ENFORCES and it was the only surface that had this
// wrong -- `App.tsx`'s auto-skip gate, `TrainBadges`' capacity pill and the action bar's rail all read the
// current phase and always did. A rule that lives in one component's local arithmetic is a rule nobody can
// check; this one has now been wrong across two design notes.
//
// THE OBLIGATION THAT FOLLOWS is the other half of the rule: a corporation left over the limit by a phase
// change must discard down to it. That is NOT this file's job and it is not missing -- `applyPhaseChange`
// (`sandboxSession.ts` #284) has rusted and then trimmed fleets cheapest-first since long before #703.
//
// The first draft of this note claimed nothing in the codebase did it, which was wrong and worth recording as
// wrong: the trim was hard to find precisely BECAUSE #296's block kept it from firing on the buyer. Refusing
// the purchase meant the buyer never went over, so the only fleets the trim ever touched were bystanders'.
// A rule prevented from running looks a lot like a rule that was never written.
//
// What WAS missing is that the trim never said anything -- see #704 and `describeFleetLosses`.
//
// See docs/ai_architecture/contract_economy.md, trainLimit.ts #703.

export interface TrainLimitInput {
  /** Trains the corporation holds right now. */
  owned: number;
  /** The limit of the phase IN FORCE -- `depot.find(isCurrent).trainLimit`, never the tier being bought. */
  currentLimit: number | null;
  /** Trains of the purchasable tier left in the depot. */
  depotSupply: number;
  /** Buying this tier's first train advances the phase. */
  advancesPhase: boolean;
  /** The limit the new phase brings, when it does. */
  limitAfterPurchase: number | null;
}

/** The most a corporation may buy in one go, walking the ceiling as it moves.
 *
 *  A LOOP RATHER THAN A SUBTRACTION, because the ceiling changes ONCE -- between the first purchase and the
 *  second -- and no single arithmetic cap can express a ceiling that moves mid-transaction. This is where
 *  #296's worry was actually true: buying two 4-trains at once IS two purchases, the first legal under the old
 *  limit and the second judged by the new one. It is a cap on the quantity, never a block on the first buy. */
export function buyableNow(input: TrainLimitInput): number {
  const { owned, currentLimit, depotSupply, advancesPhase, limitAfterPurchase } = input;
  if (depotSupply <= 0) return 0;
  /* AN UNREADABLE PHASE IS NOT A LIMIT OF ZERO -- guessing one would take a legal purchase away, the same
     reasoning `App.tsx`'s auto-skip gate gives for never skipping on an unknown fleet.
     RETURNED RATHER THAN LOOPED, and that is load-bearing: with no ceiling the walk below never breaks, and
     one caller asks this question with `depotSupply` set to `MAX_SAFE_INTEGER` to isolate the limit's own
     ceiling from the depot's. An unbounded loop there would hang the tab. */
  if (currentLimit === null) return depotSupply;
  let held = owned;
  let ceiling = currentLimit;
  let allowed = 0;
  for (let bought = 1; bought <= depotSupply; bought += 1) {
    if (held >= ceiling) break;
    held += 1;
    allowed = bought;
    // The phase turns on the FIRST purchase of a tier, and only then.
    if (bought === 1 && advancesPhase && limitAfterPurchase !== null) ceiling = limitAfterPurchase;
  }
  return allowed;
}

/** Whether the corporation is train-locked: at or over the limit IN FORCE.
 *
 *  `>=` rather than `>`, and `currentLimit` rather than the tier's: a corporation holding exactly the limit
 *  has no room, and one holding MORE than it (left there by a phase change) has none either. */
export function isTrainLocked(owned: number, currentLimit: number | null): boolean {
  return currentLimit !== null && owned >= currentLimit;
}

/** How many options the quantity selector shows.
 *
 *  Design note #719: THE ROW'S LENGTH IS ONE RULE, AND ITS GREYING IS THE OTHERS.
 *
 *  REPORTED: "when a corporation owns a train in, e.g., Phase 2, the [selector] only shows 1 / 2 / 3 options,
 *  but I think it would be better to show 1 / 2 / 3 / 4 with the 4 option grayed out. The selector should only
 *  drop options when the train limit forces it, not just because a corporation can't hold that many."
 *
 *  THE ROW WAS SAYING TWO THINGS WITH ONE MEASUREMENT. #696 set its length to `buyableNow`, which is
 *  `min(depot stock, limit headroom)` -- so a row of three meant "the limit is three", or "you already own
 *  one of four", or "the depot has three left", and nothing on screen said which. A control whose SHAPE
 *  encodes a rule can only ever encode one, and this one was carrying three.
 *
 *  SO THE LENGTH IS THE TRAIN LIMIT, FULL STOP -- the one rule that is a property of the phase rather than of
 *  this corporation's position in it. It still shrinks as the phases turn, which is the property #696 wanted
 *  and the reason a row is viable at all; what it no longer does is shrink because you bought something. A
 *  player who owns one of four now sees four options with one unreachable, which states their position
 *  instead of hiding it, and the row stops moving under them mid-phase.
 *  Everything else -- holdings, depot stock, a limit about to drop -- greys an option and explains itself on
 *  hover through `purchaseCeiling`, which already distinguishes those reasons and was already written.
 *
 *  NULL MEANS UNBOUNDED, and an unbounded row cannot be drawn. Falling back to what is actually buyable is the
 *  conservative answer and matches the pre-#719 behaviour exactly, so a chain that does not report a limit
 *  renders as it always did rather than rendering nothing.
 *
 *  @param currentLimit the phase's train limit, or `null` where the chain did not say
 *  @param buyable      `buyableNow` for this corporation -- the floor under the fallback
 */
export function quantityOptionCount(currentLimit: number | null, buyable: number): number {
  const floor = Math.max(1, buyable);
  if (currentLimit === null || !Number.isFinite(currentLimit)) return floor;
  /* Never SHORTER than what the player can buy. With a finite limit `buyableNow` cannot exceed it, so this is
     unreachable today -- and it is the guard that keeps a future rule (a private power, a variant) from
     producing a row too short to select a legal quantity. */
  return Math.max(floor, Math.max(1, Math.floor(currentLimit)));
}
