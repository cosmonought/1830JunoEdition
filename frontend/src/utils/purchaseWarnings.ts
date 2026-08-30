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
// ==================================================================
//  DESIGN NOTE 867: THREE BADGES, ONE MOMENT, TWO COUNTDOWNS
// ==================================================================
//
// REPORTED: "they are on different countdowns from the Phase Change warning. Rust and Limit both appear in
// orange/amber at '3 buys' left whereas the Phase Change shows up in orange/amber at '2 buys.'"
//
// AND THE NOTE BELOW OVERCLAIMED, WHICH IS HOW IT SURVIVED. "#839: THE ESCALATION IS NOT DUPLICATED.
// `phaseAlertLevel` already owns 'how loud' ... these read it rather than re-deriving urgency" -- they did
// not. `phaseAlertLevel` was never called from this file. Each warning derived its own `imminent` from its
// own count and had NO GATE AT ALL on whether to appear, so both showed from the moment the depot could see
// the shift coming while the phase badge waited for two. Kept and corrected rather than rewritten, because a
// note that describes an intention as an accomplishment is the more useful thing to have on record.
//
// THEY ARE ONE EVENT AND THE ARITHMETIC SAYS SO. `purchasesUntilRust` and `purchasesUntilPhaseChange` are
// both `depotRemaining + 1` in `derivePhase` -- literally the same figure. Three badges counting the same
// moment on two schedules is not extra information, it is the row contradicting itself.
//
// SO `phaseAlertLevel` IS NOW ACTUALLY ASKED, and it decides both whether a warning appears and how loud it
// is. Chosen over the alternative of an earlier rust warning: "2 buys, matching the phase badge".
//
// AND THE COUNTS ARE THE ONES ALREADY COMPUTED. `purchasesUntilRust` and `purchasesUntilPhaseChange` are
// `gamePhase.ts`'s, including its rule that "buying out the rest of the current tier does not itself rust
// anything -- the rust fires on the FIRST purchase of the next tier". Recomputing that here is how the badge
// and the chips would come to disagree about the same turn.
//
// PURE, and separate from the bar that renders it: a component deriving its own warnings is a component that
// can be wrong on its own.

import { phaseAlertLevel, TIER_ORDER, type DepotTier, type GamePhase } from "./gamePhase";
// Design note #1035: the same table `applyPhaseChange` asks before it closes them (#736).
import { closesPrivateCompanies } from "./depotSchedule";

export interface PurchaseWarning {
  /** Stable identity, for keys and for tests that must name one.
   *
   *  Design note #1035: A `"privates"` MEMBER WAS ADDED HERE AND TAKEN BACK OUT. The closure warning does not
   *  belong in this row -- see the note in `purchaseWarnings` -- and leaving the union widened for a variant
   *  nothing constructs would invite the next reader to fill the slot. */
  key: "rust" | "train-limit";
  /** The badge's text. Short enough to sit beside "Phase Shift Imminent" without wrapping the rail. */
  label: string;
  /** The whole fact, for assistive technology. NOT a tooltip carrying anything the label omits -- that is
   *  the failure this note exists to correct. */
  detail: string;
  /** `true` when the very next purchase does it. Drives the same red the phase badge uses.
   *
   *  Design note #1033: THE RED, AND NO LONGER THE MOTION BY ITSELF. The action bar now also asks whether the
   *  table is playing Gentle Rust before animating a badge -- see `pulses` below, which is the field that
   *  answers that question so this one does not have to answer two. */
  imminent: boolean;
  /** Whether the badge should ANIMATE, as distinct from whether it is urgent.
   *
   *  Design note #1033: SEPARATED FROM `imminent` BECAUSE THEY DIVERGE UNDER ONE VARIANT and agreed under
   *  every rule before it. Under Gentle Rust the rust badge stays red -- it is still the most serious thing
   *  in the row -- but stops pulsing, so the pulse can belong to the final-run badge that #1004 raises when
   *  the trains are actually condemned. The train-limit badge beside it is UNAFFECTED and still pulses: the
   *  variant delays rust, and delays nothing about the limit, so its urgency is unchanged and pretending
   *  otherwise would soften a warning the player still needs at full volume. */
  pulses: boolean;
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

/** The tier whose arrival closes the private companies, or `null` if none does.
 *
 *  Design note #1035: READ OFF `depotSchedule`, WHICH IS ALSO WHAT THE REDUCER ASKS. `applyPhaseChange` calls
 *  `closesPrivateCompanies(arrivingTier)` to do the closing (#736), so a "5" typed here would be a second
 *  statement of the rule -- and #736 exists precisely because this rule once lived in a caption while the
 *  code did something else. One table, two readers. */
export function privateClosureTier(): string | null {
  return TIER_ORDER.find((tier) => closesPrivateCompanies(tier)) ?? null;
}

/** How many depot purchases remain before `tier` becomes the phase, or `null` when the depot cannot say.
 *
 *  Design note #1035: THE DEPOT SELLS CHEAPEST-FIRST, which is what makes this countable at all. Reaching a
 *  tier means exhausting every cheaper one and then buying the first of it -- so the answer is the sum of the
 *  cheaper tiers' remaining stock, plus one.
 *
 *  `null` REMAINING IS "CANNOT SAY", NOT ZERO (#232). Only the Diesels carry it in 1830 and nothing cheaper
 *  than 5 ever will, but a depot that reported an unknown tier below the target would otherwise produce a
 *  countdown that silently under-counts -- a figure a player would plan against. */
export function purchasesUntilTier(
  tier: string,
  depot: readonly DepotTier[],
): number | null {
  /* `TIER_ORDER` is `TrainTier[]` and these callers hold plain strings -- a tier read off a phase or a
     schedule key. Widened rather than narrowed, because an unrecognised tier must return `null` here
     rather than fail to compile at a call site that has no way to prove its string is a `TrainTier`. */
  const order: readonly string[] = TIER_ORDER;
  const target = order.indexOf(tier);
  if (target < 0) return null;
  let remaining = 0;
  for (const row of depot) {
    const at = TIER_ORDER.indexOf(row.tier);
    if (at < 0 || at >= target) continue;
    if (row.remaining === null) return null;
    remaining += row.remaining;
  }
  return remaining + 1;
}

/** How loud the private companies' coming closure should be drawn, or `null` when it is not near.
 *
 *  ==================================================================
 *   DESIGN NOTE 1035: THE ALERT GOES ON THE ASSET, NOT IN THE WARNING ROW
 *  ==================================================================
 *
 *  RULED, after the badge version was withdrawn: "Could we just make the PC lines/chips on the player cards
 *  (in Stock Round and Operating Round) and on the player information on the Game Ledger using the amber/red
 *  alert system when two/one buy away from closure?"
 *
 *  AND IT IS THE BETTER PLACE FOR IT, for the reason #839 gave when it took the rust warning OUT of a tooltip
 *  and onto a badge: put the fact where the player is already looking. A player wondering what happens to
 *  their privates is looking at their privates. The warning row is where facts about the NEXT PURCHASE live,
 *  and the closure is not one -- it is a fact about a tier that may be three phases away.
 *
 *  IT ALSO REACHES THE RIGHT AUDIENCE, which the badge did not. Privates are mostly held by PLAYERS, and the
 *  action bar's corporation card speaks to whoever is operating. The first placement offered was "flush right
 *  on the Action Bar's corporation card", corrected in the same message: "I now realize my previous 'solution'
 *  only matters to corporations."
 *
 *  TWO AND ONE, MATCHING EVERY OTHER ESCALATION IN THIS APP. `phaseAlertLevel` uses the same thresholds for
 *  the phase badge and #867 made the warnings share them; a fourth schedule would be the exact fault #867 was
 *  reported for. The difference is only WHAT is being counted to -- a named tier rather than the next one.
 *
 *  `null` AFTER THE CLOSURE AND BEFORE IT MATTERS, which covers the ruled cleanup ("the moment the first
 *  5-train is purchased ... this badge must permanently disappear") without a second rule: once the phase has
 *  reached the closing tier there is nothing left to count to, and `TIER_ORDER` cannot walk backwards. */
export type PrivateClosureAlert = "warn" | "critical";

export function privateClosureAlert(
  phase: GamePhase | null,
  depot: readonly DepotTier[],
): PrivateClosureAlert | null {
  if (!phase) return null;
  const closingTier = privateClosureTier();
  if (closingTier === null) return null;

  const order: readonly string[] = TIER_ORDER;
  const now = order.indexOf(phase.tier);
  const closes = order.indexOf(closingTier);
  // #232: a phase this build cannot place in the order is not a phase before the closure.
  if (now < 0 || closes < 0) return null;
  // Already closed. The privates are gone and so is the warning, permanently.
  if (now >= closes) return null;

  const buys = purchasesUntilTier(closingTier, depot);
  if (buys === null) return null;
  if (buys <= 1) return "critical";
  if (buys <= 2) return "warn";
  return null;
}

/** The warnings the next purchase earns, in the order they should be read.
 *
 *  RUST FIRST. It destroys trains a corporation already paid for; a limit reduction only forces a discard,
 *  and only for a corporation at the ceiling. Ordering the pair by consequence rather than by phase order is
 *  the whole reason this returns a list rather than two booleans. */
export function purchaseWarnings(
  phase: GamePhase | null,
  depot: readonly DepotTier[],
  /** ==================================================================
   *   DESIGN NOTE 1033: THE COUNTDOWN IS TO A TRIGGER, NOT TO A DEATH
   *  ==================================================================
   *
   * REPORTED: "The UI text for the Rust warning badge is inaccurate for the Gentle Rust variant. It currently
   * says 'Rusts in X buys', but this variant delays rusting until after the phase-change train is bought AND
   * the reprieved trains complete their final run."
   *
   * AND THE BADGE WAS MAKING A PROMISE THE VARIANT DOES NOT KEEP. "Rusts in 1 Buy" told a player their
   * 2-trains die on the next purchase; under Gentle Rust that purchase MARKS them and they run once more. A
   * president who sold a train to avoid a loss that was not coming was misled by this string.
   *
   * A PARAMETER RATHER THAN A SECOND FUNCTION. The countdown, the gate on `phaseAlertLevel` and the
   * train-limit badge beside it are all identical under both rules; only two sentences differ. A
   * `gentlePurchaseWarnings` would duplicate #867's arithmetic, which is the drift this module exists to
   * prevent -- its own header records the last time this file kept a second copy of an urgency rule.
   *
   * DEFAULTS TO `false`, so every existing caller keeps standard wording without being touched, and a caller
   * that forgets the flag under the variant degrades to the pre-#1033 string rather than to a crash. */
  gentleRust = false,
): readonly PurchaseWarning[] {
  if (!phase) return [];
  /* Design note #867: THE GATE THIS FILE NEVER HAD. `phaseAlertLevel` returns `null` until the shift is two
     purchases away, `"warn"` at two and `"critical"` at one or fewer -- and every warning below now appears
     and escalates on it, so the row cannot show one countdown beside another. */
  /* ==================================================================
      DESIGN NOTE 1035: THE PRIVATES BADGE THAT IS NOT HERE
     ==================================================================
     REQUESTED: "Add a new warning badge to the Action Bar ... If Phase 5 has not yet been reached, display a
     badge that reads 'Privates Close: 5-train'." I built it here and withdrew it before it shipped, which is
     worth recording because the next reader will have the same idea.
     TWO RULES IN THIS FILE REFUSED IT, and both came from playtest reports. #867: every badge shares one
     countdown, because "Rust and Limit both appear at '3 buys' left whereas the Phase Change shows up at '2
     buys'" was reported as a bug. #868: the row says nothing when nothing is being taken away -- its coverage
     table has tier 2 earning no badges at all. A badge counting to a tier three phases off breaks both, and
     from phase 2 it would sit in amber reading "Privates Close in 16 Buys" beside a row that is otherwise
     silent until something happens next purchase.
     SO THE WARNING MOVED TO THE THING BEING LOST. Ruled instead: alert-style the private company chips
     themselves "when two/one buy away from closure", on the player cards and in the Ledger. That puts the
     escalation on every surface that shows a private, next to the asset whose income is ending, and costs the
     warning row nothing -- which was the other half of the objection ("I'm worried there's going to be a lot
     of clutter causing precious vertical space to get eaten up").
     WHAT SURVIVES HERE is the arithmetic: `purchasesUntilTier` and `privateClosureAlert` below, which is what
     those chips read. The countdown was always the useful part; the badge was the wrong place to spend it. */
  const alert = phaseAlertLevel(phase);
  if (alert === null) return [];
  const imminent = alert === "critical";
  const warnings: PurchaseWarning[] = [];

  /* NOTHING RUSTS UNLESS SOMETHING IS SCHEDULED TO. `rustingTier` is `null` when the coming phase change
     destroys nothing -- 5s, 6s and Diesels are permanent -- and a badge that appeared anyway would teach a
     player that this row means "a purchase is coming", which every row already means. */
  if (phase.rustingTier !== null && phase.purchasesUntilRust !== null) {
    const buys = phase.purchasesUntilRust;
    warnings.push({
      key: "rust",
      /* Design note #889: ACTIVE TENSE, AND THE COUNT ALWAYS SPOKEN. Was `Rust Event: X-Trains` at one buy
         and `Rust in N Buys: X-Trains` above it -- so the most urgent state was the one that stopped saying
         how long was left. "Rusts in 1 Buy" keeps the countdown on the badge that is a countdown (#868: a
         warning is for something being taken away), and the singular is spelled rather than pluralised
         blindly. */
      /* Design note #1033: TWO VOCABULARIES, ONE COUNTDOWN. The standard strings are #889's and are
         unchanged. The gentle ones drop the number from the badge deliberately -- offered as "'Rusts Soon:'
         (when 2 buys away) and 'Rust Imminent:' (when 1 buy away)" -- because under this variant the count is
         a countdown to a TRIGGER whose own consequence is then a further turn away, and a badge carrying two
         different horizons in one line is the confusion #867 found when three badges counted one moment on
         two schedules. The full sequence stays in `detail`, where a player who wants it can read it. */
      label: gentleRust
        ? buys <= 1
          ? `Rust Imminent: ${phase.rustingTier}-trains`
          : `Rusts Soon: ${phase.rustingTier}-trains`
        : buys <= 1
          ? `Rusts in 1 Buy: ${phase.rustingTier}-train`
          : `Rusts in ${buys} Buys: ${phase.rustingTier}-train`,
      detail: gentleRust
        ? buys <= 1
          ? `The next train purchase starts the final run for every ${phase.rustingTier}-Train in play. Under Gentle Rust they run once more and are destroyed at the end of their corporation's next Run Routes step.`
          : `${buys} more train purchases and every ${phase.rustingTier}-Train in play begins its final run. Under Gentle Rust they are not destroyed until the end of their corporation's next Run Routes step.`
        : buys <= 1
          ? `The next train purchase destroys every ${phase.rustingTier}-Train in play, in every corporation.`
          : `${buys} more train purchases and every ${phase.rustingTier}-Train in play is destroyed, in every corporation.`,
      /* ==================================================================
          DESIGN NOTE 1033: THE PULSE IS SPENT ON THE WRONG EVENT UNDER THIS VARIANT
         ==================================================================
         ASKED: "I also wonder if we should remove or greatly reduce the fading/flashing/pulsing from the
         2-buys-away and 1-buy-away badges so that the gentle rust fade pulse is more meaningful?"
         YES, AND THE REASON IS THAT THE VARIANT MOVED THE EMERGENCY. `imminent` drives the red AND the
         animation, and under standard rules that is right: the next purchase really does destroy the train,
         and there is nothing after it. Under Gentle Rust the loud moment is the FINAL RUN -- the turn where
         the player has one last chance to earn from a train that is already condemned -- and that badge
         pulses too (#1004). Two pulses two turns apart teach the eye that pulsing means "rust is somewhere
         nearby", which is the opposite of what an alert is for.
         THE COLOUR IS KEPT AND ONLY THE MOTION IS SPENT. `imminent` still reports true, so the badge is still
         red and still sorts and reads as the most urgent thing in the row; the bar decides separately whether
         to animate it. Suppressing the flag itself would have been the smaller edit and would have quietly
         demoted the warning's colour as well -- one field answering two questions, which is #732's rule. */
      imminent,
      pulses: imminent && !gentleRust,
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
      /* Design note #889: CONDENSED TO THE EVENT AND ITS COUNTDOWN. Was `Limit X → Y in N Buys` / `Train
         Limit Drops: X → Y`. The two figures are still in the `detail` below, where a player who wants the
         new ceiling can read it; on the badge they made the busiest string in a row of badges, and the fact
         that decides anything is WHEN. Same shape as the rust badge beside it, which is the point -- #839:
         "a warning drawn differently from the warning beside it reads as a different KIND of thing". */
      label:
        buys !== null && buys > 1
          ? `Train Limit Drops in ${buys} Buys`
          : "Train Limit Drops in 1 Buy",
      detail:
        `The next phase lowers the train limit from ${phase.trainLimit} to ${after} for every corporation. ` +
        `Anything held above ${after} is discarded when the phase turns.`,
      imminent,
      /* Design note #1033: UNCHANGED BY THE VARIANT, deliberately. Gentle Rust postpones the destruction of
         rusted trains and postpones nothing about the limit -- the trim still fires the instant the phase
         turns, and a gently-rusted train is the first thing it takes (#979). So this warning keeps its pulse
         while the rust badge beside it loses one, which is the whole point: the two events stopped happening
         at the same moment, and the row should stop implying they still do. */
      pulses: imminent,
    });
  }

  /* ==================================================================
      DESIGN NOTE 868: A WARNING IS FOR SOMETHING BEING TAKEN AWAY
     ==================================================================

     ASKED: "I'm wondering if we can combine the Phase and Phase Change badges? and I'm wondering if we need
     the Phase Change notification for every phase or only the two that shift from Yellow to Green and Green
     to Brown?"

     MY FIRST ANSWER PUT THE ERA CHANGE IN THIS LIST as a third warning, and it was corrected: "the meaningful
     era change information (Green Tiles are now available, Brown Tiles are now available) could be a toast
     notification to every player when the threshold is crossed. The Rust and Limit warnings restrict what
     players can do, the Era change expands their repertoires."
     THAT IS THE LINE THIS MODULE IS ACTUALLY DRAWN ON, and it is a better one than "what is coming". A
     warning is a countdown to a LOSS -- trains destroyed, a limit lowered -- and it is urgent because a
     player may want to act before it lands. New tiles take nothing and need no preparation; there is nothing
     to do about them in advance, so a countdown to them is noise in a row whose colour means danger.
     SO THE ERA IS ANNOUNCED WHEN IT ARRIVES, NOT COUNTED DOWN TO. `App.tsx`'s #868 effect toasts every
     player the moment the era actually changes.

     AND THE GENERIC BADGE STILL GOES, which was the other half of the question. "Phase Shift Imminent" named
     an EVENT rather than a consequence, and the two warnings above already say what any given shift will do.
     WHAT THIS LEAVES SILENT, deliberately: the 2 -> 3 shift, whose only effect is Green tiles. Nothing is
     lost there, so the row has nothing to say and says nothing. Every OTHER transition takes something away
     and is covered:
       2 -> 3   Green tiles unlock.                          (nothing lost -- toast only)
       3 -> 4   2-Trains rust; limit 4->3.                    (rust, limit)
       4 -> 5   Brown tiles unlock; limit 3->2.               (limit; toast for the tiles)
       5 -> 6   3-Trains rust.                                (rust)
       6 -> D   4-Trains rust.                                (rust)
     Asserted as a table in the harness, because "no loss goes unannounced" is the claim the deletion rests
     on. */
  return warnings;
}
