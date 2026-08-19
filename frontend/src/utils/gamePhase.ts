// frontend/src/utils/gamePhase.ts
//
// Which 1830 phase the room is in, and whether the next train purchase is
// about to end it.
//
// ===================================================================
//  DESIGN NOTE 1: THE PHASE IS DERIVED, NOT QUERIED -- AND IT HAS TO BE
// ===================================================================
//
// There is no `QueryMsg` that returns "the current phase". The closest
// thing on `GameStateResponse` is `current_global_era`, which is only
// `Yellow | Green | Brown` -- three values for six phases. It cannot tell
// Phase 3 from Phase 4 (both Green), Phase 5 from Phase 6 (both Brown), or
// describe Diesel at all. A badge built on `current_global_era` alone would
// have to print "Phase: 3 (Green)" during Phase 4, which is a wrong number in
// the most prominent chrome in the app -- and, since design note #612 put the
// phase number first, a wrong number in the position a player reads first.
//
// So the phase is derived from `owned_trains`, and this is exact rather
// than approximate. In 1830 the phase advances the moment the first train
// of a new tier is BOUGHT, and a bought train is owned by some corporation
// from that instant on. The highest tier owned by anybody therefore IS the
// phase, with no lag and no special cases:
//
//   - Rusting does not break it. A rusted train is removed from play, so it
//     leaves `owned_trains` -- but rusting only ever happens when a HIGHER
//     tier arrives, and that higher tier is what the maximum now reads.
//   - Trading does not break it. A train sold between corporations stays in
//     play and stays in somebody's `owned_trains`; the maximum is unmoved.
//   - The opening state is correct by construction. No trains owned means
//     no train has been bought, which is Phase 2 -- where 1830 starts.
//
// ===================================================================
//  DESIGN NOTE 2: THE DEPOT COUNT IS DERIVED THE SAME WAY, AND IS EXACT
//  FOR THE ONLY TIER THE WARNING ASKS ABOUT
// ===================================================================
//
// `state.rs` has a real `HARDWARE_POOL`, but no query reads it back (the
// same gap the Game Ledger's Trains column reports). The depot count here
// is reconstructed instead: TOTAL[tier] - (how many of that tier are owned).
//
// That subtraction is only sound while no train of the tier has left play,
// and for THE CURRENT TIER that is guaranteed: a tier's trains rust only
// when a higher tier is bought, and buying a higher tier is exactly what
// stops it being the current tier. So the figure the warning depends on is
// exact, even though the same arithmetic applied to an OBSOLETE tier would
// over-count. `depotRemaining` is therefore only ever computed for the
// current tier, and nothing here exposes a per-tier depot table that would
// invite the unsound use.
//
// ===================================================================
//  DESIGN NOTE 3: UNKNOWN IS A STATE, NOT A ZERO
// ===================================================================
//
// `owned_trains` is `string[] | null | undefined`, and `undefined` means "a
// contract predating the field" -- unknown, not empty (see
// `gameState.ts`'s own comment on it). If EVERY corporation reports
// `undefined`, this module returns `known: false` and the caller shows the
// era without a train number, rather than confidently announcing Phase 2 on
// a chain that simply is not telling us. One corporation reporting a real
// array is enough to trust the maximum, because a corporation with no
// trains legitimately reports `[]`.

import type { GameStateResponse } from "./gameState";

/** Phase tiers in ascending order. `"D"` sorts last deliberately. */
export type TrainTier = "2" | "3" | "4" | "5" | "6" | "D";

const TIER_ORDER: readonly TrainTier[] = ["2", "3", "4", "5", "6", "D"];

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
  /** The era this tier belongs to. 1830 HAS EXACTLY THREE ERAS -- Yellow,
   *  Green and Brown -- which is why Diesel is `Brown` here and not a
   *  fourth value. The era names a tile colour tier, and there is no
   *  diesel-coloured tile; Diesels arrive during the Brown era and do not
   *  start one. The badge still prints `(D-Train)` so the distinction that
   *  DOES matter -- which train is in play -- is not lost. */
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

/* ==================================================================
 *  DESIGN NOTE 5: ONE COUNTDOWN, NOT TWO
 * ==================================================================
 *
 * The phase badge and the train chips disagreed, and the badge was wrong.
 * In Phase 3 with one 3-train left, the badge read "Next buy (4-Train)
 * triggers Phase 4" while the chip read "rusts after 2 more purchases".
 * The chip had it right: the next depot purchase is the LAST 3-TRAIN, and
 * only the purchase after that can be a 4-train.
 *
 * The bug was structural, not arithmetic. The badge's text was a static
 * string per tier -- it could not count, so it defaulted to "next buy" and
 * was correct only when the depot happened to be empty. Both readouts now
 * derive from `purchasesUntilPhaseChange`, so they cannot drift again:
 *
 *   purchases = depotRemaining + 1   (empty the tier, then buy the next)
 *
 * The phase change and the rust are the SAME purchase -- buying the first
 * 4-train both starts Phase 4 and destroys the 2-trains -- which is why one
 * number serves both messages.
 */
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

/** Which tier RUSTS when the tier after the current one is first bought.
 *
 *  Read as "while Phase 3 is running, the arrival of the 4-train will rust
 *  every 2-train". Only three entries exist because only three rust events
 *  exist in 1830 -- Phase 2 and Phase 4 advance without destroying anything
 *  (Phase 5 closes privates instead, which is not a rust), and Diesel is
 *  the last phase, so nothing follows it. */
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
  /** How many more train purchases until `rustingTier` rusts, or `null`
   *  when nothing is due to rust.
   *
   *  Buying out the rest of the current tier does not itself rust anything
   *  -- the rust fires on the FIRST purchase of the next tier. So the count
   *  is "empty the depot, then buy one more": `depotRemaining + 1`. */
  purchasesUntilRust: number | null;
}

/* ==================================================================
 *  DESIGN NOTE 4: THE FULL DEPOT TABLE IS EXACT -- BUT NOT BY
 *  SUBTRACTION
 * ==================================================================
 *
 * Design note #2 warns that `TOTAL[tier] - owned` is only sound for the
 * CURRENT tier, because an obsolete tier's trains may have rusted out of
 * play and would be over-counted as still sitting in the depot. That
 * warning still stands, and `depotInventory` below does NOT violate it --
 * it never applies that subtraction to an obsolete tier.
 *
 * THE DEPOT IS A STRICT QUEUE. 1830 sells trains cheapest-first: a
 * corporation cannot buy a 4-train while any 3-train remains in the depot.
 * So reaching Phase 4 at all PROVES the 3-train depot is empty. Each tier
 * therefore has an exact answer with no subtraction guesswork:
 *
 *   below the current tier -> 0, by the queue rule
 *   the current tier       -> TOTAL - owned  (design note #2, exact here)
 *   above the current tier -> TOTAL, untouched -- none can have been sold
 *
 * RUSTED IS NOT THE SAME AS SOLD OUT, and conflating them would mislead.
 * A 3-train's depot stock is exhausted the moment Phase 4 begins, but every
 * 3-train already bought keeps running until the first 6-train arrives.
 * `soldOut` and `rusted` are separate flags for exactly that reason: one
 * says "you can no longer buy this", the other says "these no longer
 * exist".
 */
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
  /* ==================================================================
   *  DESIGN NOTE 8: A TIER'S FATE IS A PROPERTY OF THE TIER
   * ==================================================================
   *
   * REPORTED: sold-out depot tiers vanish or lack phase progression
   * context.
   *
   * `rustOutlook` already computes exactly this, and the depot cards did
   * not read it -- they showed stock and a "rusted" flag, so a tier that
   * had sold out but not yet rusted said nothing at all about what was
   * coming. That is the moment a player most needs to know: the last
   * 3-train has left the depot, every 3-train on the board dies when the
   * first 6 is bought, and the card was silent.
   *
   * Carried on `DepotTier` rather than looked up beside it so the card and
   * the countdown cannot disagree about which tier rusts when -- the same
   * argument design note #5 made for the phase-shift figure. */
  /** The tier whose first purchase destroys this one, or `null` when this
   *  tier is permanent. 5s, 6s and Diesels never rust. */
  rustedBy: TrainTier | null;
  /** The PHASE that arrives with that purchase -- "Rusts on Phase 4". The
   *  phase a tier triggers is named by the tier itself, so this is the
   *  trigger's own label rather than a second table. */
  rustPhaseLabel: string | null;
}

const DEPOT_COST: Readonly<Record<TrainTier, number>> = {
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

/* ==================================================================
 *  DESIGN NOTE 6: EVERY TIER CAN COUNT, NOT JUST THE CURRENT ONE
 * ==================================================================
 *
 * `GamePhase.purchasesUntilRust` only answers for the tier that is next in
 * line to rust. But a chip for a 2-train wants an answer during Phase 2 as
 * well, when the 4-train that will destroy it is still two whole depot
 * tiers away.
 *
 * The depot queue makes that countable exactly. To buy the first train of
 * the trigger tier you must first exhaust every cheaper tier still in the
 * depot, so:
 *
 *   purchases = (remaining in every tier from current up to trigger-1) + 1
 *
 * and `depotInventory` already supplies each of those remainders exactly
 * (design note #4). No estimation, and it degrades to
 * `purchasesUntilRust` when the trigger is the very next tier -- the two
 * agree by construction rather than by coincidence.
 */
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

/* ==================================================================
 *  DESIGN NOTE 7: ONE COUNTDOWN, ONE ESCALATION
 * ==================================================================
 *
 * Design note #5 made the phase-shift and rust readouts agree on the
 * NUMBER. They still disagreed on the URGENCY, because each derived its own
 * severity from a different expression:
 *
 *   the train chips  ->  depotRemaining === 0 ? red : === 1 ? amber : none
 *   the action bar   ->  shiftImminent (depotRemaining <= 1), one flat style
 *
 * Those happen to describe the same two thresholds, but only the chips
 * distinguished them. The action bar fired the identical badge at two
 * purchases and at one -- so the single most consequential moment in an
 * 1830 game, the last purchase before a rust, looked exactly like the
 * moment before it. A warning that does not escalate is not a warning; it
 * is a permanent fixture that players stop seeing.
 *
 * `phaseAlertLevel` is now the ONE place that decision is made, and it is
 * expressed in purchases rather than depot stock so it reads as the
 * question actually being asked. Every caller escalates in lockstep because
 * there is nothing left to keep in sync.
 */
export type PhaseAlertLevel = "warn" | "critical";

/** How loudly to warn about the coming phase shift, or `null` for "not
 *  yet / never".
 *
 *  `critical` is the LAST purchase before the shift, `warn` the one before
 *  that. Returns `null` for Diesel (nothing follows it) and on a chain that
 *  does not report train ownership, since `purchasesUntilPhaseChange` is
 *  already `null` in both cases -- an unknown countdown must not render as
 *  an urgent one. */
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

  for (const company of gameState.public_companies) {
    const trains = company.owned_trains;
    // `undefined`/`null` is "unknown" and contributes nothing -- not even
    // evidence that the field is supported. `[]` is a real answer.
    if (trains == null) continue;
    known = true;
    for (const model of trains) {
      const tier = trainTier(model);
      if (!tier) continue;
      ownedByTier.set(tier, (ownedByTier.get(tier) ?? 0) + 1);
      highest = Math.max(highest, TIER_ORDER.indexOf(tier));
    }
  }

  const tier = TIER_ORDER[highest];
  const total = DEPOT_TOTALS[tier];
  const depotRemaining = total === null ? null : Math.max(0, total - (ownedByTier.get(tier) ?? 0));
  const presentation = TIER_PRESENTATION[tier];
  const shiftImminent = known && depotRemaining !== null && depotRemaining <= 1;

  return {
    tier,
    /* ==================================================================
     *  DESIGN NOTE 612: 18XX PLAYERS SAY "PHASE 3", NOT "PHASE GREEN"
     * ==================================================================
     *
     * REPORTED: "our Phase marker probably is unhelpfully labeled. It's
     * currently 'Phase: [available tile color] ([current train])' but 18xx
     * players generally refer not to 'Phase Yellow' but 'Phase 2,' 'Phase
     * 3,' etc., based on which trains have been last sold."
     *
     * Correct, and the old order had the two facts exactly backwards. The
     * PHASE NUMBER is the name of the thing -- it is what the rulebook
     * indexes, what a player says out loud, and what every other 18xx tool
     * displays. The tile colour is a CONSEQUENCE of the phase, and a useful
     * reminder, but it is not what the phase is called.
     *
     * `Phase: 3 (Green)` reads as a name with a gloss. `Phase: Green
     * (3-Train)` read as a gloss with a name buried in it, and the "-Train"
     * suffix made the number look like a train count rather than the phase
     * -- which is the same collision `TrainBadges.tsx` already avoided by
     * writing `Phase ${phase.tier}` in its own tooltip. Two surfaces now
     * agree instead of one contradicting the other.
     *
     * THE UNKNOWN BRANCH STILL DROPS THE NUMBER, per design note #3. When no
     * corporation has reported `owned_trains`, `tier` falls back to the
     * bottom of the order rather than being measured -- printing "Phase: 2"
     * from that would state a fact this function does not have. The colour
     * survives because the board's tile colour is separately known. */
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
