// frontend/src/utils/gamePhase.ts
//
// Which 1830 phase the room is in, and whether the next train purchase is about to end it.
//
// Design note #1: THE PHASE IS DERIVED, NOT QUERIED -- AND IT HAS TO BE. No `QueryMsg` returns it, and
// `current_global_era` is three values for six phases: it cannot tell Phase 3 from 4, or 5 from 6, or describe
// Diesel at all. So the phase is the highest tier anybody OWNS, which is exact rather than approximate --
// 1830 advances the phase the moment a tier's first train is BOUGHT, and a bought train is owned from that
// instant. Rusting does not break it (a tier only rusts when a higher one arrives, which is what the maximum
// now reads), trading does not break it (the train stays in somebody's list), and no trains owned is Phase 2.
//
// Design note #2: the depot count is `TOTAL - owned`, which is only sound for the CURRENT tier -- and there it
// is guaranteed, because a tier rusts only when a higher tier is bought, and buying a higher tier is exactly
// what stops it being current. Nothing here exposes a per-tier table that would invite the unsound use.
//
// Design note #3: UNKNOWN IS A STATE, NOT A ZERO. `undefined` means a contract predating the field; if EVERY
// corporation reports it, this returns `known: false` rather than confidently announcing Phase 2.
//
// Design notes #4-#8/#612/#632: see `docs/ai_architecture/utils_layer.md`.

import type { GameStateResponse } from "./gameState";

/** Phase tiers in ascending order. `"D"` sorts last deliberately. */
export type TrainTier = "2" | "3" | "4" | "5" | "6" | "D";

/** Design note #905: exported so the delayed-auction trigger can ask "is the phase at or past 3" against
 *  the same ordering everything else uses, rather than restating it. */
export const TIER_ORDER: readonly TrainTier[] = ["2", "3", "4", "5", "6", "D"];

/** What the app calls a train of this tier -- `"3-Train"`, `"D-Train"`. No tier is a special case.
 *
 *  ==================================================================
 *   DESIGN NOTE 1007: ONE SPELLING, CHOSEN -- NOT ONE SPELLING, CORRECT
 *  ==================================================================
 *
 *  THIS NOTE ORIGINALLY READ "'D-TRAIN' IS NOT A THING ANYBODY SAYS", and argued that `${tier}-train` renders
 *  the sixth tier as "D-train", "which is not wrong so much as not English". THAT CLAIM WAS FALSE, and it is
 *  quoted here rather than deleted because the ERROR is the useful part: "D-train" is ordinary 18xx usage and
 *  appears in rulebooks across the family. I asserted a usage fact I had not checked, and dressed a
 *  house-style preference as a correctness argument. Reported by the player who plays these games: "I'd push
 *  back on the assertion that 'nobody says D-train'."
 *
 *  SO THE FUNCTION NO LONGER SPECIAL-CASES `D`, and every tier is named by its symbol. What survives the
 *  correction is the reason this function exists at all, which was never the "Diesel" spelling.
 *
 *  THE DEFECT IS DISAGREEMENT BETWEEN SURFACES (#891's shape), not incorrectness at any one of them. The tree
 *  has carried both spellings since v1.0alpha -- `TrainBadges.tsx` had `trigger === "D" ? "Diesel" :
 *  \`${trigger}-Train\`` inline, while `RulesReference`'s rust column said "When the first D-train is bought"
 *  -- so a player reading two panels was told two things. Either spelling would have done. Having two is the
 *  bug, and one function that every naming site calls is what stops it recurring.
 *
 *  THE BARE `${tier}-train` SITES ARE NOT SWEPT, and that is now a conclusion rather than a deferral. Roughly
 *  twenty-nine of them build the phrase inline across `App.tsx`, `RoutePlannerPanel`,
 *  `EmergencyTrainPurchaseModal` and this panel -- and with `D` no longer special, every one of them already
 *  renders what this function renders. Converting them would change no output at all. They differ only in
 *  case: the helper title-cases ("Buy D-Trains from the Bank Depot") because its callers are headings and
 *  buttons, and the inline sites are mid-sentence ("NYC bought a D-train for $1100"), where lower case is
 *  right. Churning twenty-nine call sites for an identical string is the kind of tidying that reads as
 *  progress and buys nothing.
 *
 *  THE PHASE IS NOT THE TRAIN, and that boundary is why "Diesel" still appears in this file. `depotSchedule`'s
 *  "Diesel Era" and `PHASE_EFFECTS`'s "Phase D (Diesel)" name a PHASE OF THE GAME, which is what 1830 itself
 *  calls it; `TutorialModal` and `RulesReference` use it in prose explaining that its capacity is unlimited.
 *  None of those is naming a train a corporation can buy, so none of them is this function's business.
 *
 *  HERE, BESIDE `TrainTier`, RATHER THAN IN A MODULE OF ITS OWN. Naming a tier is a property of the tier, and
 *  this file is already the authority on what tiers exist and how they order. A `trainNaming.ts` holding two
 *  functions would be a module whose only content is the thing this one is for. */
export function trainTierName(tier: string): string {
  return `${tier}-Train`;
}

/** The same name in the plural -- `"3-Trains"`, `"D-Trains"`.
 *
 *  Design note #1007: A SEPARATE FUNCTION RATHER THAN A COUNT ARGUMENT. Every caller so far knows at the call
 *  site which it wants: a heading naming a category is always plural, and a button naming one purchase is
 *  singular. A `count` parameter would make both of them pass a number they do not have in order to select a
 *  suffix they already know. `countPhrase` in `App.tsx` remains the tool for "n of these", and it composes
 *  with the singular form.
 *
 *  KEPT AS A FUNCTION THOUGH IT IS NOW ONE INTERPOLATION. It would be shorter inline at both call sites, and
 *  that is exactly the state the tree was in when it drifted into two spellings. The point of the seam is not
 *  that the rule is complicated; it is that there is one place to change it. */
export function trainTierNamePlural(tier: string): string {
  return `${trainTierName(tier)}s`;
}

/** How many of each train the Bank Depot starts with -- the printed 1830
 *  roster, mirroring `RulesReference.tsx`'s `TRAIN_ROSTER`. `D` is
 *  effectively unlimited, represented as `null` rather than a large number
 *  so "no ceiling" cannot be mistaken for "twenty left". */
const DEPOT_TOTALS: Readonly<Record<TrainTier, number | null>> = {
  "2": 6,
  "3": 5,
  "4": 4,
  "5": 3,
  "6": 2,
  D: null,
};

export type PhaseTint = "yellow" | "green" | "brown";

interface TierPresentation {
  /** The era this tier belongs to. 1830 HAS EXACTLY THREE ERAS -- Yellow, Green and Brown -- which is why Diesel
   *  is `Brown` here and not a fourth value: the era names a tile colour tier, and there is no diesel-coloured
   *  tile. Diesels arrive during the Brown era and do not start one. The badge still prints `(D-Train)` so the
   *  distinction that DOES matter -- which train is in play -- is not lost. */
  era: string;
  tint: PhaseTint;
  /** Trains one corporation may hold during this phase. Drops as the game
   *  advances: 4 through Phases 2-3, 3 in Phase 4, 2 from Phase 5 on. */
  trainLimit: number;
}

const TIER_PRESENTATION: Readonly<Record<TrainTier, TierPresentation>> = {
  "2": { era: "Yellow", tint: "yellow", trainLimit: 4 },
  "3": { era: "Green", tint: "green", trainLimit: 4 },
  "4": { era: "Green", tint: "green", trainLimit: 3 },
  "5": { era: "Brown", tint: "brown", trainLimit: 2 },
  "6": { era: "Brown", tint: "brown", trainLimit: 2 },
  D: { era: "Brown", tint: "brown", trainLimit: 2 },
};

/* Design note #632: WHICH ERA A TRAIN BELONGS TO. The mapping already exists -- the tier table has carried a
   tint since the phase badge needed one -- so this exports the lookup rather than letting `TrainPurchasePanel`
   write a second 2/3/4/5/6/D switch, which is how the depot would come to disagree with the badge about what
   colour Phase 4 is.
   THE VALUE OF THE CODING IS THAT IT IS NOT A NEW LANGUAGE: yellow, green and brown already mean tile eras on
   the map, the badge and the hexes, so a green 3-train says "this is the train that unlocks the tiles you have
   been looking at" without teaching anybody anything.
   DELIBERATELY A SEPARATE CHANNEL FROM AVAILABILITY -- the depot marks the purchasable tier with fill and
   border, and era rides on the glyph. Folding the two together would make the scheme mean two things and answer
   neither reliably. */
export function tierTint(tier: TrainTier): PhaseTint {
  return TIER_PRESENTATION[tier].tint;
}

/** The tile era a tier belongs to -- `"Yellow"`, `"Green"` or `"Brown"`.
 *
 *  Design note #868: EXPOSED SO THE WARNING CAN COMPARE TWO TIERS. `purchaseWarnings` needs to know whether
 *  the coming phase changes the tile colour, and the only alternative was a second copy of
 *  `TIER_PRESENTATION`'s era column living in that file -- the drift this module exists to prevent (#5's
 *  "ONE COUNTDOWN, NOT TWO", arrived at from the other direction).
 *  NOTE WHAT THIS IS NOT: a phase number. #612's rule is that the era names a TILE COLOUR, which is the fact
 *  a player acts on; Diesel is `Brown` because it arrives during that era rather than starting a fourth. */
export function tierEra(tier: TrainTier): string {
  return TIER_PRESENTATION[tier].era;
}

/* Design note #5: ONE COUNTDOWN, NOT TWO. The phase badge and the train chips disagreed and the badge was
   wrong: in Phase 3 with one 3-train left it read "Next buy (4-Train) triggers Phase 4" while the chip read
   "rusts after 2 more purchases". The chip had it right -- the next depot purchase is the LAST 3-TRAIN.
   The bug was structural, not arithmetic: the badge's text was a static string per tier, so it could not count
   and defaulted to "next buy", correct only when the depot happened to be empty. Both now derive from
   `purchases = depotRemaining + 1` -- empty the tier, then buy the next.
   The phase change and the rust are the SAME purchase, which is why one number serves both messages. */
const PHASE_SHIFT_TARGET: Readonly<Partial<Record<TrainTier, { phase: string; effect: string }>>> = {
  "2": { phase: "Phase 3", effect: "Unlocks Green Tiles" },
  "3": { phase: "Phase 4", effect: "Rusts all 2-Trains" },
  "4": { phase: "Phase 5", effect: "Closes all Private Companies" },
  "5": { phase: "Phase 6", effect: "Rusts all 3-Trains" },
  "6": { phase: "Phase D (Diesel)", effect: "Rusts all 4-Trains" },
};

/** `"2 purchases until Phase 4 (Rusts all 2-Trains)"`. */
function phaseShiftWarning(tier: TrainTier, purchases: number): string | null {
  const target = PHASE_SHIFT_TARGET[tier];
  if (!target) return null; // Diesel is last; nothing follows it.
  return `${purchases} purchase${purchases === 1 ? "" : "s"} until ${target.phase} (${target.effect})`;
}

/** Which tier RUSTS when the tier after the current one is first bought -- read as "while Phase 3 is running,
 *  the arrival of the 4-train will rust every 2-train". Only three entries exist because only three rust events
 *  exist in 1830: Phase 2 and Phase 4 advance without destroying anything (Phase 5 closes privates instead,
 *  which is not a rust), and Diesel is the last phase, so nothing follows it. */
const RUSTS_WHEN_NEXT_TIER_ARRIVES: Readonly<Partial<Record<TrainTier, TrainTier>>> = {
  "3": "2",
  "5": "3",
  "6": "4",
};

export interface GamePhase {
  /** The highest train tier in play -- the phase, see design note #1. */
  tier: TrainTier;
  /** `"Phase: 4 (Green)"`, ready to render -- design note #612. */
  label: string;
  tint: PhaseTint;
  /** Trains of `tier` still in the Bank Depot, or `null` for Diesel (no
   *  ceiling). See design note #2 for why this is exact. */
  depotRemaining: number | null;
  /** `depotRemaining <= 1`: the next purchase, or the one after it, ends
   *  this phase. Never true for Diesel. */
  shiftImminent: boolean;
  /** `false` when no corporation reported `owned_trains` at all -- the
   *  caller should omit the train number. See design note #3. */
  known: boolean;
  /** Trains one corporation may hold in this phase. */
  trainLimit: number;
  /** Exact consequence of the coming phase shift, or `null` when there is
   *  no shift pending or none to describe. */
  shiftWarning: string | null;
  /** The tier that will RUST when the next tier arrives, or `null` if the
   *  coming phase change destroys nothing. Independent of `shiftImminent`:
   *  the doom is scheduled regardless of how full the depot is, and callers
   *  use `depotRemaining` to decide how loudly to say so. */
  rustingTier: TrainTier | null;
  /** Purchases until the phase advances -- `depotRemaining + 1`, per design
   *  note #5. `null` for Diesel, which nothing follows. THE SINGLE SOURCE
   *  for both the action-bar tag and the chip tooltips. */
  purchasesUntilPhaseChange: number | null;
  /** How many more train purchases until the rusting tier rusts, or `null` when nothing is due to rust. Buying
   *  out the rest of the current tier does not itself rust anything -- the rust fires on the FIRST purchase of the
   *  next tier -- so the count is "empty the depot, then buy one more". */
  purchasesUntilRust: number | null;
}

/* Design note #4: THE FULL DEPOT TABLE IS EXACT -- BUT NOT BY SUBTRACTION. #2 warns that `TOTAL - owned` is
   only sound for the CURRENT tier, and this does not violate that: it never applies the subtraction to an
   obsolete tier.
   THE DEPOT IS A STRICT QUEUE. 1830 sells cheapest-first, so reaching Phase 4 at all PROVES the 3-train depot
   is empty. Each tier therefore has an exact answer: below the current tier, 0 by the queue rule; the current
   tier, `TOTAL - owned`; above it, `TOTAL` untouched, since none can have been sold.
   RUSTED IS NOT THE SAME AS SOLD OUT: a 3-train's stock is exhausted the moment Phase 4 begins, but every
   3-train already bought keeps running until the first 6-train arrives. One flag says "you can no longer buy
   this", the other says "these no longer exist". */
export interface DepotTier {
  tier: TrainTier;
  /** Face value in the Bank Depot. */
  cost: number;
  /** Printed quantity, or `null` for the unlimited Diesels. */
  total: number | null;
  /** Still purchasable from the depot; `null` for Diesel. */
  remaining: number | null;
  /** Trains one corporation may hold once this tier is the current phase. */
  trainLimit: number;
  /** This tier is the current phase. */
  isCurrent: boolean;
  /** The depot holds none of these any more. */
  soldOut: boolean;
  /** These have rusted and left play entirely. */
  rusted: boolean;
  /* Design note #8: A TIER'S FATE IS A PROPERTY OF THE TIER. The rust outlook already computed this and the
     depot cards did not read it -- so a tier that had sold out but not yet rusted said nothing about what was
     coming, which is the moment a player most needs to know: the last 3-train has left the depot, every 3-train
     on the board dies when the first 6 is bought, and the card was silent.
     Carried ON the tier rather than looked up beside it, so the card and the countdown cannot disagree about
     which tier rusts when.
     The tier whose first purchase destroys this one, or `null` when this tier is permanent -- 5s, 6s and Diesels
     never rust. */
  rustedBy: TrainTier | null;
  /** The PHASE that arrives with that purchase -- "Rusts on Phase 4". The
   *  phase a tier triggers is named by the tier itself, so this is the
   *  trigger's own label rather than a second table. */
  rustPhaseLabel: string | null;
}

/** The printed depot price per tier.
 *
 *  Design note #1046: EXPORTED, because the Yellow Sign pays a fraction of a train's depot value and needs
 *  the same figure the depot table shows. A SECOND COPY LIVES IN `sandboxSession.ts` as `TIER_COST`, used by
 *  the train-limit trim to decide which train is cheapest -- flagged rather than merged, because unifying
 *  them touches the reducer's discard ordering and that is not this batch's business. If the two ever
 *  disagree, the trim and the payout will disagree about what a train is worth. */
export const DEPOT_COST: Readonly<Record<TrainTier, number>> = {
  "2": 80,
  "3": 180,
  "4": 300,
  "5": 450,
  "6": 630,
  D: 1_100,
};

/** The tier whose first purchase destroys this one -- the inverse of
 *  `RUSTS_WHEN_NEXT_TIER_ARRIVES`. 5s, 6s and Diesels are permanent and so
 *  are absent. */
const RUSTED_BY: Readonly<Partial<Record<TrainTier, TrainTier>>> = {
  "2": "4",
  "3": "6",
  "4": "D",
};

/** The whole Bank Depot, tier by tier. See design note #4 for why every
 *  figure here is exact rather than an estimate. */
export function depotInventory(state: GameStateResponse | null): DepotTier[] {
  const phase = derivePhase(state);
  const currentIndex = phase ? TIER_ORDER.indexOf(phase.tier) : 0;

  return TIER_ORDER.map((tier, index) => {
    const total = DEPOT_TOTALS[tier];
    let remaining: number | null;
    if (total === null) {
      remaining = null; // Diesel: no ceiling.
    } else if (index < currentIndex) {
      remaining = 0; // Design note #4: the queue rule.
    } else if (index === currentIndex) {
      remaining = phase?.depotRemaining ?? total;
    } else {
      remaining = total;
    }

    const rustedByTier = RUSTED_BY[tier];
    return {
      tier,
      cost: DEPOT_COST[tier],
      total,
      remaining,
      trainLimit: TIER_PRESENTATION[tier].trainLimit,
      isCurrent: phase != null && phase.tier === tier,
      soldOut: remaining === 0,
      rusted:
        phase != null &&
        phase.known &&
        rustedByTier !== undefined &&
        currentIndex >= TIER_ORDER.indexOf(rustedByTier),
      // Design note #8: carried, so the card and the countdown cannot
      // disagree about which purchase kills this tier.
      rustedBy: rustedByTier ?? null,
      /* The phase named by the tier that triggers the rust. Buying the
         first 4-train IS the arrival of Phase 4, so the trigger's own
         phase label is the answer -- no second table, and no way for the
         two to drift. */
      rustPhaseLabel:
        rustedByTier === undefined
          ? null
          : (PHASE_SHIFT_TARGET[TIER_ORDER[TIER_ORDER.indexOf(rustedByTier) - 1]]?.phase ?? null),
    };
  });
}

/* Design note #6: EVERY TIER CAN COUNT, NOT JUST THE CURRENT ONE. A chip for a 2-train wants an answer during
   Phase 2, when the 4-train that will destroy it is still two whole depot tiers away.
   The queue makes that countable exactly: to buy the first train of the trigger tier you must first exhaust
   every cheaper tier still in the depot, so `purchases = (remaining from current up to trigger-1) + 1`, and the
   inventory supplies each of those remainders exactly (#4). No estimation, and it degrades to the single-tier
   figure when the trigger is the very next tier -- the two agree by construction rather than by coincidence. */
export interface TierRustOutlook {
  /** The tier whose first purchase destroys this one, or `null` if this
   *  tier is permanent (5, 6, D). */
  rustedBy: TrainTier | null;
  /** Depot purchases until that happens. `null` when permanent, or when
   *  train ownership is unknown. */
  purchasesAway: number | null;
  /** Already gone from play. */
  rusted: boolean;
}

/** The rust outlook for every tier -- see design note #6. */
export function rustOutlook(
  state: GameStateResponse | null,
): Readonly<Record<TrainTier, TierRustOutlook>> {
  const phase = derivePhase(state);
  const inventory = depotInventory(state);
  const remainingByTier = new Map(inventory.map((row) => [row.tier, row.remaining]));
  const rustedByTierFlag = new Map(inventory.map((row) => [row.tier, row.rusted]));
  const currentIndex = phase ? TIER_ORDER.indexOf(phase.tier) : 0;

  const out = {} as Record<TrainTier, TierRustOutlook>;
  for (const tier of TIER_ORDER) {
    const trigger = RUSTED_BY[tier] ?? null;
    if (trigger == null) {
      out[tier] = { rustedBy: null, purchasesAway: null, rusted: false };
      continue;
    }
    const rusted = rustedByTierFlag.get(tier) === true;
    if (rusted || phase == null || !phase.known) {
      out[tier] = { rustedBy: trigger, purchasesAway: null, rusted };
      continue;
    }
    // Sum the depot from wherever we are up to the tier BELOW the trigger,
    // then one more purchase for the trigger train itself.
    let purchases = 1;
    for (let i = currentIndex; i < TIER_ORDER.indexOf(trigger); i += 1) {
      purchases += remainingByTier.get(TIER_ORDER[i]) ?? 0;
    }
    out[tier] = { rustedBy: trigger, purchasesAway: purchases, rusted: false };
  }
  return out;
}

/* Design note #7: ONE COUNTDOWN, ONE ESCALATION. #5 made the two readouts agree on the NUMBER; they still
   disagreed on the URGENCY, because each derived its own severity from a different expression. Those describe
   the same two thresholds, but only the chips distinguished them -- the action bar fired the identical badge at
   two purchases and at one, so the single most consequential moment in an 1830 game, the last purchase before a
   rust, looked exactly like the moment before it. A warning that does not escalate is not a warning; it is a
   permanent fixture that players stop seeing.
   `phaseAlertLevel` is now the ONE place that decision is made, expressed in purchases rather than depot stock
   so it reads as the question actually being asked. Every caller escalates in lockstep because there is nothing
   left to keep in sync. */
export type PhaseAlertLevel = "warn" | "critical";

/** How loudly to warn about the coming phase shift, or `null` for "not yet / never". `critical` is the LAST
 *  purchase before the shift, `warn` the one before that. `null` for Diesel (nothing follows it) and on a chain
 *  that does not report train ownership -- an unknown countdown must not render as an urgent one. */
export function phaseAlertLevel(phase: GamePhase | null): PhaseAlertLevel | null {
  const purchases = phase?.purchasesUntilPhaseChange;
  if (purchases == null) return null;
  if (purchases <= 1) return "critical";
  if (purchases === 2) return "warn";
  return null;
}

/** Normalises a contract train model string to a tier. Tolerates casing and
 *  the `"4-train"` style some display code uses; returns `null` for
 *  anything unrecognised rather than guessing a tier. */
export function trainTier(model: string | null | undefined): TrainTier | null {
  if (!model) return null;
  const head = model.trim().toUpperCase().split(/[^0-9A-Z]/)[0];
  return (TIER_ORDER as readonly string[]).includes(head) ? (head as TrainTier) : null;
}

/** The room's current phase, derived per design notes #1 and #2. */
export function derivePhase(gameState: GameStateResponse | null): GamePhase | null {
  if (!gameState) return null;

  let known = false;
  let highest = 0;
  // Counted while scanning rather than in a second pass: the tier is not
  // known until the scan finishes, so tally every tier and read off the one
  // that turns out to be current.
  const ownedByTier = new Map<TrainTier, number>();

  /* Design note #897: AND THE ROSTER ITSELF IS "UNKNOWN" THE SAME WAY. The three lines below have stated
     #232's rule for `owned_trains` since this function was written, and the loop header did not ask it of the
     list holding them -- so a state that never reported a roster threw here instead of answering "phase
     unknown", which is the answer it already has for a roster full of unreported fleets.
     FOUND BY THE FIX FOR `applyPhaseChange`, not by reading: guarding the reducer moved its crash one frame
     down the stack into this function, which `limitForTier` reaches through `depotInventory`. Third instance
     of one shape -- the rule asked of a field and not of its container. */
  for (const company of gameState.public_companies ?? []) {
    const trains = company.owned_trains;
    // `undefined`/`null` is "unknown" and contributes nothing -- not even
    // evidence that the field is supported. `[]` is a real answer.
    if (trains == null) continue;
    known = true;
    /* ==================================================================
        DESIGN NOTE 1046: A GHOST TRAIN WAS NEVER IN THE DEPOT
       ==================================================================
       RULED of the Yellow Sign's gift: "it does not deplete the bank's supply." This function is where the
       supply lives -- `depotRemaining` is `TOTAL - owned`, so a train nobody bought would otherwise take one
       off the shelf. It would also pull the phase-change countdown forward and could trip "shift imminent",
       and #1035's "Privates Close in N Buys" reads the same figure.
       SUBTRACTED FROM THE TALLY, NOT FROM THE ROSTER. The ghost still counts toward `highest`, because it is
       a real train the corporation owns and the PHASE is "the highest tier anybody owns" (#1) -- a phase-6
       gift in a phase-6 game changes nothing there, and hiding it would be the #906 mistake of enforcing a
       rule by withholding a value.
       A MULTISET WALK, matching `pending_rust_trains` everywhere else: one ghost 6 and one bought 6 is one
       train off the shelf, not two and not none. */
    const ghosts = [...(company.ghost_trains ?? [])];
    for (const model of trains) {
      const tier = trainTier(model);
      if (!tier) continue;
      highest = Math.max(highest, TIER_ORDER.indexOf(tier));
      const ghostAt = ghosts.indexOf(model);
      if (ghostAt >= 0) {
        ghosts.splice(ghostAt, 1);
        continue;
      }
      ownedByTier.set(tier, (ownedByTier.get(tier) ?? 0) + 1);
    }
  }

  const tier = TIER_ORDER[highest];
  const total = DEPOT_TOTALS[tier];
  const depotRemaining = total === null ? null : Math.max(0, total - (ownedByTier.get(tier) ?? 0));
  const presentation = TIER_PRESENTATION[tier];
  const shiftImminent = known && depotRemaining !== null && depotRemaining <= 1;

  return {
    tier,
    /* Design note #612: 18XX PLAYERS SAY "PHASE 3", NOT "PHASE GREEN". The old order had the two facts exactly
       backwards: the PHASE NUMBER is the name of the thing -- what the rulebook indexes, what a player says out
       loud, and what every other 18xx tool displays -- while the tile colour is a CONSEQUENCE of the phase.
       `Phase: 3 (Green)` reads as a name with a gloss; `Phase: Green (3-Train)` read as a gloss with a name buried
       in it, and the "-Train" suffix made the number look like a train count rather than the phase -- the same
       collision `TrainBadges.tsx` already avoided in its own tooltip.
       THE UNKNOWN BRANCH STILL DROPS THE NUMBER, per design note #3: when no corporation has reported `owned_trains`
       the tier falls back to the bottom of the order rather than being measured, and printing "Phase: 2" from that
       would state a fact this function does not have. The colour survives because the board's tile colour is
       separately known. */
    label: known
      ? `Phase: ${tier} (${presentation.era})`
      : // Design note #3: no phase number we cannot stand behind.
        `Phase: ${presentation.era}`,
    tint: presentation.tint,
    depotRemaining,
    // A phase shift cannot be imminent if we do not know the phase, and
    // Diesel never runs out.
    shiftImminent,
    known,
    trainLimit: presentation.trainLimit,
    // Design note #5: both messages count from the same figure.
    purchasesUntilPhaseChange: known && depotRemaining !== null ? depotRemaining + 1 : null,
    shiftWarning:
      shiftImminent && depotRemaining !== null
        ? phaseShiftWarning(tier, depotRemaining + 1)
        : null,
    rustingTier: known ? (RUSTS_WHEN_NEXT_TIER_ARRIVES[tier] ?? null) : null,
    purchasesUntilRust:
      known && RUSTS_WHEN_NEXT_TIER_ARRIVES[tier] && depotRemaining !== null
        ? depotRemaining + 1
        : null,
  };
}
