// frontend/src/utils/purchaseWarnings.ts
//
// What the next train purchase is about to destroy.
//
// ==================================================================
//  DESIGN NOTE 839: OUT OF THE TOOLTIP AND OUT FROM BEHIND THE CARET
// ==================================================================
//
// ASKED: "I can't remember what warnings we have: Phase Change is one, but maybe we should add warning badges
// for 'Rust Event' and 'Train Limit Reduction'?" -- and, on being told both facts already existed elsewhere:
// "Right now, the Phase Change warning includes a tooltip that explains an imminent rust event. Keeping with
// our policy of not hiding critical information in hover tooltips, let's add Rust Event AND Train Limit
// Reduction to the warning badges. The Phase Change can stay and have its tooltip removed."
//
// BOTH FACTS WERE ON SCREEN AND NEITHER WAS VISIBLE. The rust lived in `phase.shiftWarning`, which is a
// `title` -- and #806 already withdrew a tooltip from this same bar on the same grounds. The train-limit drop
// lived in the depot table's relabelled limit line, which #837 folds away on the scroll that pins the bar. A
// fact behind a hover on a fact behind a caret is not a warning; it is a thing the game could have told you.
//
// THE ESCALATION IS NOT DUPLICATED. `phaseAlertLevel` already owns "how loud" (#7 in `gamePhase.ts`), and
// these read it rather than re-deriving urgency from `depotRemaining` -- which is exactly the second
// implementation that would drift. This module owns WHAT is coming; that one owns HOW LOUD.
//
// AND THE COUNTS ARE THE ONES ALREADY COMPUTED. `purchasesUntilRust` and `purchasesUntilPhaseChange` are
// `gamePhase.ts`'s, including its rule that "buying out the rest of the current tier does not itself rust
// anything -- the rust fires on the FIRST purchase of the next tier". Recomputing that here is how the badge
// and the chips would come to disagree about the same turn.
//
// PURE, and separate from the bar that renders it: a component deriving its own warnings is a component that
// can be wrong on its own.

import type { DepotTier, GamePhase } from "./gamePhase";

export interface PurchaseWarning {
  /** Stable identity, for keys and for tests that must name one. */
  key: "rust" | "train-limit";
  /** The badge's text. Short enough to sit beside "Phase Shift Imminent" without wrapping the rail. */
  label: string;
  /** The whole fact, for assistive technology. NOT a tooltip carrying anything the label omits -- that is
   *  the failure this note exists to correct. */
  detail: string;
  /** `true` when the very next purchase does it. Drives the same red the phase badge uses. */
  imminent: boolean;
}

/** The train limit once `phase`'s successor arrives, or `null` when nothing follows or the depot cannot say.
 *
 *  THE NEXT TIER'S OWN NUMBER, not a table here. `DepotTier.trainLimit` is "trains one corporation may hold
 *  once this tier is the current phase" -- so the answer is a property of the tier that is coming, and
 *  looking it up rather than encoding it is what keeps one rule in one place. */
export function limitAfterNextPhase(
  phase: GamePhase | null,
  depot: readonly DepotTier[],
): number | null {
  if (!phase) return null;
  const index = depot.findIndex((row) => row.tier === phase.tier);
  if (index < 0) return null;
  const next = depot[index + 1];
  return next === undefined ? null : next.trainLimit;
}

/** The warnings the next purchase earns, in the order they should be read.
 *
 *  RUST FIRST. It destroys trains a corporation already paid for; a limit reduction only forces a discard,
 *  and only for a corporation at the ceiling. Ordering the pair by consequence rather than by phase order is
 *  the whole reason this returns a list rather than two booleans. */
export function purchaseWarnings(
  phase: GamePhase | null,
  depot: readonly DepotTier[],
): readonly PurchaseWarning[] {
  if (!phase) return [];
  const warnings: PurchaseWarning[] = [];

  /* NOTHING RUSTS UNLESS SOMETHING IS SCHEDULED TO. `rustingTier` is `null` when the coming phase change
     destroys nothing -- 5s, 6s and Diesels are permanent -- and a badge that appeared anyway would teach a
     player that this row means "a purchase is coming", which every row already means. */
  if (phase.rustingTier !== null && phase.purchasesUntilRust !== null) {
    const buys = phase.purchasesUntilRust;
    warnings.push({
      key: "rust",
      label:
        buys <= 1
          ? `Rust Event: ${phase.rustingTier}-Trains`
          : `Rust in ${buys} Buys: ${phase.rustingTier}-Trains`,
      detail:
        buys <= 1
          ? `The next train purchase destroys every ${phase.rustingTier}-Train in play, in every corporation.`
          : `${buys} more train purchases and every ${phase.rustingTier}-Train in play is destroyed, in every corporation.`,
      imminent: buys <= 1,
    });
  }

  /* A DROP, NOT A CHANGE. 1830's limit only ever falls, but the badge claims a direction and so the
     comparison is made rather than assumed -- if a future variant raises it, this stays silent instead of
     announcing a reduction that is an increase. */
  const after = limitAfterNextPhase(phase, depot);
  if (after !== null && after < phase.trainLimit) {
    const buys = phase.purchasesUntilPhaseChange;
    warnings.push({
      key: "train-limit",
      label:
        buys !== null && buys > 1
          ? `Limit ${phase.trainLimit} → ${after} in ${buys} Buys`
          : `Train Limit Drops: ${phase.trainLimit} → ${after}`,
      detail:
        `The next phase lowers the train limit from ${phase.trainLimit} to ${after} for every corporation. ` +
        `Anything held above ${after} is discarded when the phase turns.`,
      imminent: buys !== null && buys <= 1,
    });
  }

  return warnings;
}
