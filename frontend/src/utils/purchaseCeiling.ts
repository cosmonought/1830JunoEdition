// frontend/src/utils/purchaseCeiling.ts
//
// Which rule stopped the quantity list where it did, and where that answer belongs.
//
// Design note #700: TWO MOODS, NOT TWO SENTENCES.
//
// #247 established that a player facing "2 in the depot, 1 selectable" had no way to reconcile the numbers,
// and answered it with one string shown permanently beside the Buy button. That was right when neither figure
// was readable anywhere else on the panel.
//
// REPORTED since: "after a player purchases a train, the line with the Buy button reads: 'Buy from bank ·
// Current Train Limit 2 / 4 · Only 2 left in the depot.' I am not sure the 'Only 2 left in the depot' is
// needed."
//
// It is not, and #247 is not wrong -- it is OUT OF DATE. Both of its supports were removed by later work on
// the same panel:
//
//   #687 bolted the depot count out of the smallest, dimmest type in the row. "2 / 4 left" now sits legibly
//        one row above the sentence that restates it.
//   #696 replaced the `<select>` with a segmented row, so the ceiling stopped being a hidden clamp and became
//        THE NUMBER OF BUTTONS -- a figure a player counts without reading anything.
//
// So the depot's ceiling is now drawn twice before this string is reached, and the string is a third.
//
// THE LIMIT'S CEILING IS NOT, and the asymmetry is the whole rule. `limitHeadroom` is a SUBTRACTION the panel
// never performs on screen -- the rail says "2 / 4", not "room for 2" -- and a purchase that drops the train
// limit announces a phase change that appears nowhere else. Neither is readable off a figure already drawn.
//
// Hence: a CAPTION, volunteered permanently, carries only what is not already visible; a REASON, asked for by
// hovering an option that will not click, carries whatever actually bound. Same facts, different threshold for
// spending the reader's attention.
//
// See docs/ai_architecture/ui_shell_layout.md, TrainPurchasePanel.tsx #700.

export interface PurchaseCeilingInput {
  /** `false` when the depot is empty -- there is no ceiling to explain, only an absence. */
  hasTierForSale: boolean;
  /** The corporation is already train-locked. A ceiling note would be answering a question the panel's own
   *  blocking message has already answered more completely. */
  atTrainLimit: boolean;
  /** Trains this corporation may still add before the phase's limit. */
  limitHeadroom: number;
  /** Trains of the purchasable tier left in the bank depot. */
  depotSupply: number;
  /** The phase's cap, for naming it. */
  trainLimit: number;
  /** This purchase would advance the phase and cut the limit. */
  limitDropsOnPurchase: boolean;
  /** What the limit becomes if it does. */
  limitAfterPurchase: number | null;
}

export interface PurchaseCeiling {
  /** Shown beside the Buy button, always, unasked. `null` for "say nothing". */
  caption: string | null;
  /** The tooltip on an option the player cannot choose. `null` when there is nothing to explain. */
  reason: string | null;
}

/** A supply figure this large is the sentinel for "not tracked", never a real count of trains. */
const UNTRACKED_SUPPLY = 99;

export function purchaseCeiling(input: PurchaseCeilingInput): PurchaseCeiling {
  const {
    hasTierForSale,
    atTrainLimit,
    limitHeadroom,
    depotSupply,
    trainLimit,
    limitDropsOnPurchase,
    limitAfterPurchase,
  } = input;

  if (!hasTierForSale || atTrainLimit) return { caption: null, reason: null };

  /* THE LIMIT BINDS when it leaves less room than the depot has stock. Strictly less: on a tie the depot's
     count is the figure already on screen, so the caption defers to it and says nothing -- #247's own "a
     permanent explanation of a constraint nobody is hitting is noise", applied to a constraint the reader can
     already see. */
  const limitBinds = limitHeadroom < depotSupply;

  const caption = limitBinds
    ? limitDropsOnPurchase && limitAfterPurchase !== null
      ? `Room for ${limitHeadroom} more — this purchase drops the limit to ${limitAfterPurchase}.`
      : `Room for ${limitHeadroom} more before the ${trainLimit}-train limit.`
    : null;

  /* Asked for, so it answers whatever actually bound -- including the depot, which the caption drops. The
     count is the entire answer to "why can I not click 3", and a tooltip costs nothing until it is wanted. */
  const reason =
    caption ?? (depotSupply < UNTRACKED_SUPPLY ? `Only ${depotSupply} left in the depot.` : null);

  return { caption, reason };
}
