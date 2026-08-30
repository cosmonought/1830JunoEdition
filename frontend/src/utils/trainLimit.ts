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

/** How many of a fleet's trains actually occupy a train-limit slot.
 *
 *  ==================================================================
 *   DESIGN NOTE 1034: THE EXEMPTION IS A RULE NOW, NOT A HIDING PLACE
 *  ==================================================================
 *
 *  RULED, with the precedent: "1846 officially implements the 'delayed obsolescence' rule, and in that version
 *  when trains gently rust, they stop counting to the train limit and players turn the train cards sideways to
 *  indicate they have one run left." 1830's own variant text is silent, so 1846's is the one to follow.
 *
 *  THIS IS THE THIRD POSITION ON THE QUESTION AND THE FIRST ONE THAT CAN WORK. It is worth setting all three
 *  out, because two of them have already shipped:
 *    #906  -- exempt, implemented by MOVING the train out of `owned_trains`. Its own harness said so: "every
 *             surface that counts trains counts that array, so this is what implements 'a pending-rust train
 *             occupies no train-limit slot' without any of them being told."
 *    #979  -- not exempt. Adopted after #906's mechanism was found to have made the grace run unreachable:
 *             `ownedTrainRoster` is that same array, so a train outside it has no roster entry, no route
 *             draft, and cannot be run. "A rule enforced by withholding a value from every reader is enforced
 *             nowhere in particular."
 *    #1034 -- exempt, and asked. The train stays in the fleet, where the planner and the chips can see it, and
 *             every site that COUNTS subtracts it here.
 *
 *  SO THE DANGER IN THIS CHANGE IS REGRESSING TO #906, which is the tempting one-line version: the exemption
 *  is trivially "implemented" by removing the train, and that breaks the feature invisibly, because nothing
 *  fails -- the train simply never appears. #979's note is kept verbatim in this file for that reason, and the
 *  ruling that came with this one names the constraint directly: "you need to make sure the train chips for
 *  the gently rusting trains continue displaying on their final run."
 *
 *  A MULTISET SUBTRACTION, for the reason every list in this feature is one: a corporation holding a reprieved
 *  3 and a live 3 is at ONE countable train, not zero. `owned.filter(m => !reprieved.includes(m))` would
 *  exempt both -- the same off-by-one `trimToTrainLimit` and `describeFleetLosses` each record.
 *
 *  DEFENSIVE ABOUT MARKS THAT NAME NO TRAIN. A mark matching nothing in the fleet subtracts nothing, so a
 *  desynced list can never drive the count below zero and hand a corporation free slots. #1032 fixed the one
 *  known source of surplus marks; this makes the count safe regardless. */
export function countableTrainCount(
  owned: readonly string[] | null | undefined,
  reprieved: readonly string[] | null | undefined,
  /** ==================================================================
   *   DESIGN NOTE 1046: THE SECOND KIND OF EXEMPT TRAIN
   *  ==================================================================
   *
   * RULED of the Yellow Sign's gift: "it bypasses train limit checks until the end of the Operating Round."
   *
   * A SECOND LIST RATHER THAN A WIDER `reprieved`, because they expire on different clocks and for different
   * reasons: a reprieved train is dying and is exempt because it is already condemned (#1034), a ghost is
   * brand new and is exempt because the gift would otherwise be unusable. Merging them would make one
   * argument answer two questions -- #732 -- and the day one expires and the other does not, nothing would
   * say so.
   * OPTIONAL, so every existing caller keeps its behaviour untouched. */
  ghosts?: readonly string[] | null,
): number {
  // #232: `undefined` is "the chain did not say", and a fleet nobody reported has no countable trains to
  // report either. The callers already distinguish absent from empty before they get here.
  if (owned == null) return 0;
  const pool = [...(reprieved ?? []), ...(ghosts ?? [])];
  if (pool.length === 0) return owned.length;
  let countable = 0;
  for (const model of owned) {
    const at = pool.indexOf(model);
    if (at >= 0) pool.splice(at, 1);
    else countable += 1;
  }
  return countable;
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
/* ==================================================================
 *  DESIGN NOTE 979: A REPRIEVED TRAIN IS STILL A TRAIN
 * ==================================================================
 *
 * REPORTED: "The engine currently assumes 'gently rusted' trains do not count toward a corporation's train
 * limit. This is incorrect. Gently rusted trains do count toward the limit until they are permanently retired
 * at the end of their grace run."
 *
 * #906 RULED THE OPPOSITE AND IMPLEMENTED IT BY SLEIGHT OF HAND. It moved a doomed train OUT of `owned_trains`
 * into `pending_rust_trains`, and its harness states the trick in as many words: "Every surface that counts
 * trains counts that array, so this is what implements 'a pending-rust train occupies no train-limit slot'
 * without any of them being told."
 *
 * AND THAT IS EXACTLY WHY THE RULE COULD BE WRONG WITHOUT ANYTHING NOTICING. A rule enforced by hiding a value
 * from every reader is not enforced anywhere in particular, so there was no line to review, no assertion to
 * disagree with, and nothing that had to be updated when the ruling changed. It also took the train off every
 * OTHER surface that reads `owned_trains` -- including the route planner, which is where "one final run" was
 * supposed to happen. See `sandboxSession` #979 for that half.
 *
 * SO THE MECHANISM INVERTS: the train stays in `owned_trains` and `pending_rust_trains` becomes a MARKER over
 * it. Counting it against the limit then needs no rule at all, for the same reason not counting it needed
 * none -- which is the honest version of #906's argument, pointing the other way.
 *
 * WHAT NEEDS A RULE IS WHICH TRAIN GOES when the limit bites, and that is this function. */
export interface TrimInput {
  /** Every train the corporation holds, reprieved ones included. */
  owned: readonly string[];
  /** The subset under a gentle-rust reprieve, as models. A multiset, not a set: two 2-trains are two. */
  reprieved: readonly string[];
  /** The limit now in force. `Infinity` or a non-finite value means no trim. */
  limit: number;
  /** What a model is worth, for #284's cheapest-first ordering. */
  cost: (model: string) => number;
}

export interface TrimResult {
  owned: readonly string[];
  reprieved: readonly string[];
  /** What the trim took, in the order it took it -- the shell narrates from this (#704). */
  discarded: readonly string[];
}

/** Discard down to the limit, counting and taking only the trains that occupy a slot.
 *
 *  ==================================================================
 *   DESIGN NOTE 1034: A TRAIN THAT OCCUPIES NO SLOT CANNOT FREE ONE
 *  ==================================================================
 *
 *  #979 SORTED REPRIEVED TRAINS TO THE FRONT OF THE DISCARD ORDER and its reasoning was sound under its own
 *  rule: "a reprieved train is worth exactly one more run; a live train is worth every run for the rest of the
 *  game", so if something must go, it should be the one already dying. That argument only holds while a
 *  reprieved train COUNTS. Under #1034 it does not, and the same sort becomes incoherent -- discarding a train
 *  that was never occupying a slot reduces the countable fleet by nothing, so the trim would take it and then
 *  still be over the limit.
 *
 *  IT ALSO EXPLAINS A SYMPTOM I REPORTED AND COULD NOT FIX UNDER THE OLD RULE. Driving the reducer, a fleet of
 *  `["3","4","5"]` entering phase 6 had its 3 marked and then immediately trimmed away, leaving `reprieved:
 *  []` -- no grace run at all. Under #979 that was correct behaviour and I said so. It was also the variant
 *  cancelling itself in every game where the phase change drops the limit, which is most of them.
 *
 *  SO THE REPRIEVED TRAINS ARE SET ASIDE ENTIRELY: not counted, not sorted, not discarded, and returned
 *  untouched. They leave the fleet at their own expiry (`expireReprieveFor`) and by no other route.
 *
 *  CHEAPEST-FIRST AMONG THE REST, which is #284's original rule with the exception removed rather than a new
 *  ordering. Slots carry their index so the surviving fleet keeps its original order -- a fleet that re-sorted
 *  itself every phase change would move the chips under the player for no reason.
 *
 *  `reprieved` IS STILL AN INPUT, and it would be tempting to drop it now that it is not sorted on. It is what
 *  tells the walk WHICH trains to set aside, and it is a multiset: a corporation with one reprieved 3 and one
 *  live 3 must set aside exactly one of them. */
export function trimToTrainLimit(input: TrimInput): TrimResult {
  const { owned, reprieved, limit, cost } = input;

  const stillReprieved = new Map<string, number>();
  for (const model of reprieved) stillReprieved.set(model, (stillReprieved.get(model) ?? 0) + 1);
  const slots = owned.map((model, index) => {
    const left = stillReprieved.get(model) ?? 0;
    if (left > 0) stillReprieved.set(model, left - 1);
    return { model, index, isReprieved: left > 0 };
  });

  /* THE COUNT THE LIMIT IS TESTED AGAINST. `owned.length` was the old measure and is now the wrong one --
     `countableTrainCount` states the same subtraction this walk performs, and both are here rather than one
     calling the other because this one needs the per-slot marks anyway. They are asserted to agree. */
  const countable = slots.filter((slot) => !slot.isReprieved);
  if (!Number.isFinite(limit) || countable.length <= limit) {
    return { owned, reprieved, discarded: [] };
  }

  const order = [...countable].sort((a, b) => cost(a.model) - cost(b.model));
  const doomed = new Set(order.slice(0, countable.length - limit).map((slot) => slot.index));

  const keptOwned: string[] = [];
  const discarded: string[] = [];
  for (const slot of slots) {
    if (!doomed.has(slot.index)) {
      keptOwned.push(slot.model);
      continue;
    }
    discarded.push(slot.model);
  }

  /* THE MARKS SURVIVE INTACT, and that is a change of kind rather than of detail. #979 had to strip a mark
     whose train the trim had taken, or the expiry would later remove a DIFFERENT train of the same tier. No
     reprieved train can be taken now, so no mark can be orphaned here -- and `reprieved` is returned exactly
     as it arrived rather than copied and filtered, so a future edit that starts discarding them again fails
     loudly at the expiry instead of quietly retiring the wrong train. */
  return { owned: keptOwned, reprieved, discarded };
}

export function quantityOptionCount(currentLimit: number | null, buyable: number): number {
  const floor = Math.max(1, buyable);
  if (currentLimit === null || !Number.isFinite(currentLimit)) return floor;
  /* Never SHORTER than what the player can buy. With a finite limit `buyableNow` cannot exceed it, so this is
     unreachable today -- and it is the guard that keeps a future rule (a private power, a variant) from
     producing a row too short to select a legal quantity. */
  return Math.max(floor, Math.max(1, Math.floor(currentLimit)));
}
