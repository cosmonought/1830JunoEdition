// frontend/src/utils/yellowSign.ts
//
// The two-stage Easter egg, and the three ways it could have desynced the table.
//
// ==================================================================
//  DESIGN NOTE 1044: A HIDDEN FLAG IN A GAME WITH NO HIDDEN STATE
// ==================================================================
//
// SPECIFIED as mutable game state: "Immediately and permanently tag that specific corporation's state/data
// object with a hidden flag (e.g. `hasYellowSign: true`). Permanently remove the Stage 1 string from the
// global Malus pool", plus "add a 10% RNG chance".
//
// THE FEATURE IS EXACTLY RIGHT AND ALL THREE MECHANISMS WOULD HAVE BROKEN THE TABLE, because this app has no
// server and no mutable game state: every client rebuilds the board by replaying one append-only log, and
// anything not derivable from that log is a fact one browser knows and the others do not. #1017 is the
// standing example -- variant flavour text that printed for the president alone, because it was raised in a
// click handler instead of the shared path.
//
//   A FLAG WRITTEN ONTO A CORPORATION would live in whichever client's memory happened to run the code. A
//   player who reloads loses it; a player who joins late never had it. So the mark is DERIVED from the log
//   instead -- `yellowSignStateFrom` reads the Activity Log every client already rebuilds identically, and
//   the answer is the same on every screen with nothing stored anywhere.
//
//   REMOVING A LINE FROM THE POOL is the dangerous one, and it is not obvious. `revenueFlavourClause` indexes
//   with `hash % lines.length` (#907). Splice one line out and `lines.length` drops by one, which re-points
//   EVERY index in that bucket -- so a client that had seen the sign would print a different sentence for the
//   same turn than a client that had not, for the rest of the game. The arrays are therefore never mutated;
//   "removed from the pool" is implemented as a SKIP at selection time, which leaves every other line exactly
//   where it was.
//
//   `Math.random()` FOR THE 10% would give every client a different answer to the same question on the same
//   turn. The chance is real and it is SEEDED -- from the same turn key the revenue die uses (#903), so it is
//   a genuine one-in-ten that every client agrees about and that an undo-and-replay reproduces.
//
// THE FEATURE IS UNCHANGED BY ANY OF THAT. Stage 1 fires once, marks its corporation, and never comes back;
// Stage 2 is available only to the marked corporation, only on a critical bonus, and only a tenth of the
// time. What changed is where the state lives, and it is the difference between an Easter egg and a
// desynchronised board.

import { UNPREDICTABLE_REVENUE_FLAVOR } from "../constants/flavorText";
// Design note #1051: `revenueSeedHash` is no longer imported here -- every draw this file makes comes out of
// the turn's own recorded roll now, so there is nothing left for it to hash.
import { type FlavorBucket, type RevenueSeedParts } from "./gameVariants";
import { DEPOT_COST, TIER_ORDER, trainTier, type TrainTier } from "./gamePhase";

/** The Stage 1 line, verbatim from `criticalMalus`. */
export const YELLOW_SIGN_MALUS_LINE =
  "A strange man made the passengers uncomfortable by asking whether they had seen a yellow sign.";

/** The Stage 2 line, verbatim from `criticalBonus`. */
export const YELLOW_SIGN_BONUS_LINE =
  "A strange man proclaimed that the Yellow Sign had brought him to the railway, then purchased the entire first-class carriage.";

/* ==================================================================
    DESIGN NOTE 1051: ONE IN FIVE, CHOSEN -- AND THE OLD NUMBER WAS NEVER THE REAL ONE
   ==================================================================

   THIS WAS `CARCOSA_CHANCE = 0.1`, "one chance in ten, per the ruling", and the code under it did not deliver
   ten percent. `carcosaRollHits` read `spun % 10`, and `revenueDieFace` read `hash % 6` -- both of which turn
   on the low bit of an FNV hash of two nearly identical short strings. Measured across every turn key a real
   game can produce: the roll fired 29% of the time at face 6, which is the ONLY face that can reach it, and
   between 1% and 3% at the odd faces. The decorrelation constant added 7919 to the macro round, changing the
   FRONT of the key, and FNV-1a's low bits are dominated by the characters it processes LAST -- which were
   identical. Salting the end instead measured WORSE: 0% at faces 2, 4 and 6.

   THAT WHOLE PROBLEM IS GONE WITH THE HASH (`gameVariants.ts` #1051). A uniform 32-bit draw has no low-bit
   structure to share, so the roll is whatever fraction it is written to be.

   TWENTY PERCENT, AS A DECISION. Told "I am also okay with a player who gets marked by the sign have a 29%
   chance for Carcosa on a 1 in 6 die roll" -- but 29% was an artifact, not a setting, and it varied with the
   key space rather than staying put. Offered 10%, 20% and 30% as real numbers and 20% was chosen. So the
   figure a player experiences is now roughly what it was during playtest, and it is in the code on purpose.

   AN INTEGER OUT OF A HUNDRED, not a float. `0.1` was never compared against anything -- the test was
   `% 10 === 0`, so the constant and the behaviour were two separate claims that happened to agree, which is
   #891's shape in a probability. This one IS the comparison. */
export const CARCOSA_CHANCE_IN_100 = 20;

/** The stride that puts the Carcosa roll on bits neither the die nor the flavour line can reach.
 *
 *  Design note #1051: THE THREE DRAWS COME OUT OF ONE NUMBER, so they have to be given disjoint slices of it
 *  or they are the same coin flip wearing three hats -- which is exactly the bug this batch removes.
 *  `revenueDieFace` consumes the low factor of six; `revenueFlavourClause` consumes `floor(/6) % length`,
 *  which at the widest bucket reaches this far and no further. Everything above is free.
 *
 *  MEASURED FROM THE PAYLOAD RATHER THAN WRITTEN DOWN. A bucket that grew past the hardcoded figure would
 *  silently start overlapping the line index, and nothing would fail -- the rate would just drift and no test
 *  would know why. Computed here, the stride cannot fall behind the thing it is protecting against. */
export const CARCOSA_SLICE = (() => {
  let widest = 0;
  for (const key of Object.keys(UNPREDICTABLE_REVENUE_FLAVOR)) {
    widest = Math.max(widest, UNPREDICTABLE_REVENUE_FLAVOR[key as FlavorBucket].length);
  }
  return 6 * widest;
})();

/** ==================================================================
 *   DESIGN NOTE 1046: EACH STAGE HAS A WINDOW
 *  ==================================================================
 *
 * RULED: "The Malus event is only possible during Phases 2, 3, and 4" and "The Escalation event is only
 * possible during Phase 5 through Phase D."
 *
 * THE TWO WINDOWS DO NOT OVERLAP, which is the shape worth naming: the Mark can only happen before Phase 5
 * and the Escalation only from Phase 5 -- so a corporation marked on the last turn of Phase 4 gets its
 * escalation window and one marked at any earlier point has longer to wait. The gap between them is where the
 * player carries the flag around wondering what it does.
 *
 * AND STAGE 1 EXPIRES RATHER THAN WAITING. "If Phase 5 begins and this event has not occurred naturally,
 * permanently remove the text from the global Malus pool" -- so a game that never rolled it simply never has
 * it, and the line stops being drawable rather than lurking into the late game. */
export const MARK_PHASES: readonly TrainTier[] = ["2", "3", "4"];
export const ESCALATION_PHASES: readonly TrainTier[] = ["5", "6", "D"];

export function markWindowOpen(phaseTier: string): boolean {
  return (MARK_PHASES as readonly string[]).includes(phaseTier);
}

export function escalationWindowOpen(phaseTier: string): boolean {
  return (ESCALATION_PHASES as readonly string[]).includes(phaseTier);
}

/** The train the Mark takes: the cheapest the corporation holds, by depot price.
 *
 *  Design note #1046: BY DEPOT VALUE, NOT BY TIER ORDER. They agree in 1830 -- the price table ascends with
 *  the tier -- and saying "cheapest" in the units the payout is computed in is what keeps the two from
 *  drifting if a variant ever re-prices a tier. Ties break on the FIRST held, so the choice is stable across
 *  clients rather than depending on sort stability.
 *
 *  `null` WHEN THERE IS NOTHING TO TAKE. Ruled that the event fires "even down to zero trains" -- which is
 *  one train becoming none. A corporation holding none already has no train to name in the log line and no
 *  value to halve, so the Mark cannot fire on it and the line stays in the pool. */
export function lowestValueTrain(owned: readonly string[] | null | undefined): string | null {
  if (!owned || owned.length === 0) return null;
  let best: string | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const model of owned) {
    const tier = trainTier(model);
    const cost = tier ? DEPOT_COST[tier] : Number.POSITIVE_INFINITY;
    if (cost < bestCost) {
      bestCost = cost;
      best = model;
    }
  }
  return best;
}

/** What the Mark pays: half the taken train's depot value.
 *
 *  Design note #1046: 0.5x, AND THE FIRST DRAFT OF THIS BATCH SAID 1.5x. Corrected on sight -- "I made a
 *  mistake here: it should be 0.5x" -- and the difference is the whole character of the event. At 1.5x losing
 *  your cheapest train is a windfall a president would hope for; at 0.5x it is a genuine loss with a
 *  consolation, which is what an ominous Easter egg should feel like.
 *
 *  ROUNDED DOWN TO A WHOLE VGP. Every figure in this game is an integer of virtual game points and half of an
 *  odd price is not one; flooring is the direction that never invents money. */
export function markPayout(model: string): number {
  const tier = trainTier(model);
  return tier ? Math.floor(DEPOT_COST[tier] / 2) : 0;
}

/** The tier the Escalation gifts: whatever phase the board is in.
 *
 *  Design note #1046: "a train matching the current phase's tier", read off the phase rather than off the
 *  depot -- the depot may have sold out of that tier, and the gift explicitly does not come from the bank. */
export function escalationTier(phaseTier: string): TrainTier | null {
  const at = (TIER_ORDER as readonly string[]).indexOf(phaseTier);
  return at < 0 ? null : TIER_ORDER[at];
}

export interface YellowSignState {
  /** The ticker Stage 1 marked, or `null` while the sign has not yet been seen. */
  markedTicker: string | null;
  /** Whether Stage 2 has already fired, after which neither line can ever be drawn again. */
  carcosaSeen: boolean;
}

export const NO_YELLOW_SIGN: YellowSignState = { markedTicker: null, carcosaSeen: false };

/** Read the game's Yellow Sign state out of the Activity Log.
 *
 *  ==================================================================
 *   DESIGN NOTE 1044: THE LOG IS THE STATE, BECAUSE THE LOG IS WHAT EVERY CLIENT SHARES
 *  ==================================================================
 *
 * THE MARKED CORPORATION IS READ FROM THE SENTENCE THAT MARKED IT. `turnRevenueSentence` opens every one of
 * these lines with "<TICKER> ran for $N." (#944), so the ticker is the first token of the entry that carries
 * the Stage 1 string -- which is why this reads the label rather than needing a field on the corporation.
 *
 * PARSING A SENTENCE IS NOT FREE and the alternative was worse. A `has_yellow_sign` field on the company
 * would have to be written by the REDUCER to be replayed, and the reducer never sees a flavour line: the
 * clause is composed in the shell from a roll the reducer already made. Adding an action to carry it would
 * put a purely cosmetic event into the log that Undo could then rewind -- the same objection #896 records
 * against an acknowledgement action for the fleet-loss modal.
 *
 * SO THE COUPLING IS ACKNOWLEDGED RATHER THAN HIDDEN: this function knows the shape of the opening clause,
 * and `yellowSign.test.ts` builds its fixtures with the real `turnRevenueSentence` so the two cannot drift
 * without something going red. */
export function yellowSignStateFrom(logLabels: readonly string[]): YellowSignState {
  let markedTicker: string | null = null;
  let carcosaSeen = false;
  for (const label of logLabels) {
    if (markedTicker === null && label.includes(YELLOW_SIGN_MALUS_LINE)) {
      markedTicker = tickerFrom(label);
    }
    if (label.includes(YELLOW_SIGN_BONUS_LINE)) carcosaSeen = true;
  }
  return { markedTicker, carcosaSeen };
}

/** "B&O ran for $170. ..." -> "B&O". `null` when the label is not one of these sentences. */
function tickerFrom(label: string): string | null {
  const match = /^(.+?) ran for \$/.exec(label);
  return match ? match[1] : null;
}

/** Whether this corporation, this turn, gets the escalation.
 *
 *  Design note #1044: SEEDED FROM THE TURN, not from `Math.random()`. The key is the one `rollTurnRevenue`
 *  already uses, put through a second hash so the chance is not correlated with the die face that produced
 *  the critical bonus in the first place -- the same decorrelation #907 had to add to the line index when it
 *  found `gcd(6, 50)` eating half of every bucket. */
export function carcosaRollHits(parts: RevenueSeedParts): boolean {
  /* Design note #1051: THE HIGH SLICE OF THE TURN'S OWN DRAW. The old body hashed the parts a second time
     with a salted macro round to decorrelate this from the die; it did the opposite, and the measurement is
     in `CARCOSA_CHANCE_IN_100`'s note above. Taking a slice the other two draws cannot reach is decorrelation
     by construction rather than by hoping a hash mixes well. */
  return Math.floor(parts.turnSeed / CARCOSA_SLICE) % 100 < CARCOSA_CHANCE_IN_100;
}

/** Ruled appendices, added to the flavour sentence when a stage fires. */
export const MARK_APPENDIX =
  "One train mysteriously disappeared, but a bag of strangely marked gold was found in some abandoned luggage.";
export const ESCALATION_APPENDIX = "The train that disappeared has returned with decadent gold trim.";

/** The third stage's clause, ruled verbatim. */
export const CARCOSA_FOG_LINE = "The gold-trimmed train disappeared back into the fog.";

/** Whether this corporation's doom clock has run out.
 *
 *  ==================================================================
 *   DESIGN NOTE 1092: A DUE DATE, NOT AN EXPIRY
 *  ==================================================================
 *
 * #1089 REMOVED THE TRAIN AT THE BOUNDARY. It cannot now, because the fog has to be NARRATED on a run and
 * there is no run at a Stock Round transition -- so the clock names a set, and the debt falls due once that
 * set has finished.
 *
 * `>` RATHER THAN `>=`, and the difference is the whole of the ruling "survive until the exact conclusion of
 * the next full set of Operating Rounds". `macro_round_number` is incremented as the Stock Round opens, so
 * once it has passed the deadline the named set is genuinely over and the train has had every run it was
 * promised. Its next run is the one the fog takes it on -- one last run, then nothing, which is the shape
 * Gentle Rust already uses for a doomed train.
 *
 * AND IT MUST STILL HOLD THE TRAIN. A corporation that sold it paid the Blood Price and owes nothing. */
export function fogIsDue(
  company: { carcosan_trains?: readonly string[]; carcosan_doom_after_macro_round?: number } | null | undefined,
  macroRound: number,
): boolean {
  if (!company) return false;
  if ((company.carcosan_trains?.length ?? 0) === 0) return false;
  const doom = company.carcosan_doom_after_macro_round;
  return doom !== undefined && macroRound > doom;
}

export interface FlavourResolution {
  /** The line to print, after the Easter egg has had its say. */
  line: string;
  /** Which stage fired, or `null` for an ordinary turn.
   *
   *  ==================================================================
   *   DESIGN NOTE 1092: "fog" IS THE THIRD STAGE, AND IT BELONGS HERE
   *  ==================================================================
   *
   * RULED: the corporation "receives the gold-trimmed train disappears into the fog variant text (the third
   * step of the Yellow Sign revenue sequence)", with its own sound.
   *
   * WHICH MOVES THE FOG OUT OF THE ROUND BOUNDARY AND INTO A RUN. #1089 built it as an event at the Stock
   * Round transition with a log line of its own -- correct for a rust, wrong for a NARRATED stage, because
   * the first two stages are clauses inside `turnRevenueSentence` and a third that printed its own sentence
   * somewhere else would be a different kind of thing wearing the same name.
   *
   * SO ALL THREE STAGES NOW LOOK ALIKE: a clause that replaces the drawn flavour, a `YellowSignEvent`
   * dispatch that moves the board, and a cue. The doom clock stops being an expiry and becomes a DUE DATE --
   * see `fogIsDue`. */
  stage: "mark" | "carcosa" | "fog" | null;
}

/** The final flavour line for a turn, with the Yellow Sign's rules applied.
 *
 *  ==================================================================
 *   DESIGN NOTE 1044: "REMOVED FROM THE POOL" IS A SKIP, NOT A SPLICE
 *  ==================================================================
 *
 * THE FOUR RULES, in the order they are asked:
 *   1. The natural draw IS the Stage 1 line and nobody is marked yet -> it fires, and marks its corporation.
 *   2. The natural draw IS the Stage 1 line and somebody is already marked -> skipped. This is the
 *      "permanently remove from the global Malus pool" half: no second corporation can ever draw it.
 *   3. The corporation IS the marked one, the bucket IS `criticalBonus`, Carcosa has not been seen, and the
 *      seeded tenth hits -> the Stage 2 line is forced in place of whatever was drawn.
 *   4. The natural draw IS the Stage 2 line by any other route -> skipped. It is reachable only through (3).
 *
 * THE SKIP WALKS FORWARD FROM THE NATURAL INDEX rather than splicing the array, and that is the whole of why
 * this is safe: `lines.length` never changes, so every OTHER line in that bucket keeps the index it always
 * had and two clients at different stages still agree about every ordinary turn. A splice would silently
 * re-point the entire bucket.
 *
 * AND IT IS THE CALLER'S NATURAL DRAW THAT COMES IN, not a bucket and a seed -- so this function cannot
 * disagree with `revenueFlavourClause` about what would have been drawn. One selector, one answer, and this
 * only ever replaces it. */
/* ==================================================================
    DESIGN NOTE 1128: A FORCED STAGE IS A PLAYTEST TOOL, AND IT GOES THROUGH THE LOG LIKE EVERYTHING ELSE
   ==================================================================
   ASKED FOR as "a hidden debug trigger ... set a state flag, the engine reads it at the next valid mechanical
   window, bypasses the normal RNG check, guarantees the event fires, and then resets the flag."
   THE SHAPE IS RIGHT AND ONE WORD IN IT WAS WRONG: "the RNG check", singular. There is no single check. The
   Mark fires when the natural line DRAW lands on it inside phases 2-4; Carcosa needs a critical bonus, the
   marked corporation acting, phases 5-D, and a 1-in-5 seeded roll; the Fog is a debt with no roll at all.
   Three stages, three sets of gates, and a single boolean cannot say which.
   SO THE FLAG NAMES ITS STAGE. `ForcedSignStage` is the same union `FlavourResolution.stage` already reports,
   which means the thing you ask for and the thing you get back are one vocabulary.
   WHAT A FORCE BYPASSES AND WHAT IT DOES NOT. It skips the CHANCE and the WINDOW -- the draw, the roll, the
   phase -- because those are what make a stage unreachable on demand. It does NOT skip the state that makes
   the line coherent: the Mark still needs an unmarked game and a train to take, because its sentence names
   the train it deletes; Carcosa still needs a marked corporation that has not already escalated, because it
   is that corporation's story. A forced stage whose prerequisites are unmet does not fire and does not clear
   -- it stays armed for "the next available window", which is what was asked for and is better than firing
   an incoherent line now.
   #1044 IS NOT VIOLATED BY THIS, and the distinction is worth writing down because it looks like it is. That
   note bans hidden state as the SOURCE OF TRUTH: the sign is derived from the Activity Log so every client
   agrees and a replay reproduces it. This flag is not a source of truth -- it is an input to one resolution,
   and the OUTCOME still goes into the log as text that every other client derives from. The log stays the
   record. What the flag changes is which line got written, once. */
export type ForcedSignStage = "mark" | "carcosa" | "fog";

export function resolveFlavourLine(input: {
  naturalLine: string;
  bucket: FlavorBucket;
  ticker: string;
  parts: RevenueSeedParts;
  state: YellowSignState;
  /** Design note #1046: the phase in force, for the two windows. */
  phaseTier: string;
  /** Design note #1046: the acting corporation's fleet, because the Mark needs a train to take. */
  owned?: readonly string[] | null;
  /** ==================================================================
   *   DESIGN NOTE 1092: THE FOG IS OWED, AND THIS RUN IS WHERE IT COLLECTS
   *  ==================================================================
   *
   * ASKED IN, NOT DERIVED, for the same reason `state` is (#1040): whether the doom clock has run out is a
   * fact about `macro_round_number` and one corporation's stored deadline, and this module reads lines
   * rather than boards. The caller answers it with `fogIsDue`. */
  fogDue?: boolean;
  /** Design note #1128: the armed debug stage, or nothing. Sandbox only -- the shell does not thread it
   *  anywhere else. */
  forced?: ForcedSignStage | null;
}): FlavourResolution {
  const { naturalLine, bucket, ticker, parts, state, phaseTier, owned, fogDue, forced } = input;

  /* ==================================================================
      DESIGN NOTE 1092: THE FOG OUTRANKS EVERY OTHER LINE, INCLUDING THE ESCALATION
     ==================================================================
     FIRST, AND UNCONDITIONALLY ON THE BUCKET. The other two stages are lottery tickets -- the Mark needs its
     own line to be drawn, the escalation needs a critical bonus and a 1-in-5 roll -- and either could be
     asked on the same turn the fog is due. A debt that has come due does not wait for a better draw.
     THE ROLL ITSELF IS UNTOUCHED, ruled explicitly: "you can actually give them whatever bonus/malus they
     roll -- it doesn't have to be 0%." So this replaces the CLAUSE and nothing else; the swing, the tint and
     the flash are whatever the die said. The train's last run is an ordinary run that happens to be its
     last, which is a better beat than a forced zero and one fewer special case in `turnRevenueSentence`. */
  if (fogDue === true || forced === "fog") {
    /* Design note #1128: the Fog has no roll to bypass, so forcing it is a straight override of the due-date
       arithmetic. It keeps its place at the top of the order for the same reason it had it -- a debt that has
       come due does not wait for a better draw, and a forced one is a debt somebody declared due. */
    return { line: CARCOSA_FOG_LINE, stage: "fog" };
  }

  // (3) The escalation, which REPLACES whatever the hash drew.
  if (
    state.markedTicker !== null &&
    state.markedTicker === ticker &&
    !state.carcosaSeen &&
    /* Design note #1128: the three CHANCE-AND-WINDOW gates, skipped together when forced. They are what make
       this stage unreachable on demand -- a critical bonus you cannot roll for, a phase you cannot skip to,
       and a 1-in-5. The three conditions above are not gates in that sense; they are who the story is about,
       and forcing past them would print another corporation's sentence. */
    (forced === "carcosa" ||
      (bucket === "criticalBonus" &&
        // Design note #1046: Phase 5 through D only.
        escalationWindowOpen(phaseTier) &&
        carcosaRollHits(parts)))
  ) {
    return { line: YELLOW_SIGN_BONUS_LINE, stage: "carcosa" };
  }

  /* Design note #1128: FORCED, THE DRAW AND THE WINDOW BOTH GO. The Mark's real gate is that the hash has to
     land on its line, which is a lottery no amount of playing can hurry; phases 2-4 is the other. What
     survives is an unmarked game and a train to take -- see the note on `ForcedSignStage`. */
  if (forced === "mark" && state.markedTicker === null && lowestValueTrain(owned) !== null) {
    return { line: YELLOW_SIGN_MALUS_LINE, stage: "mark" };
  }

  // (1) The mark, on its natural draw, once per game.
  if (naturalLine === YELLOW_SIGN_MALUS_LINE) {
    /* Design note #1046: THREE CONDITIONS, AND EACH SENDS IT TO THE SKIP. Phases 2-4 only ("if Phase 5 begins
       and this event has not occurred naturally, permanently remove the text"); nobody marked yet; and a
       train to take, because the Mark deletes one and the log line names it. A corporation holding none has
       nothing to lose, so the line stays in the pool for somebody who does. */
    if (
      state.markedTicker === null &&
      markWindowOpen(phaseTier) &&
      lowestValueTrain(owned) !== null
    ) {
      return { line: naturalLine, stage: "mark" };
    }
    // (2) Already spent. Skipped rather than spliced.
    return { line: skipFrom(bucket, parts, naturalLine), stage: null };
  }

  // (4) The Stage 2 line is unreachable except through (3).
  if (naturalLine === YELLOW_SIGN_BONUS_LINE) {
    return { line: skipFrom(bucket, parts, naturalLine), stage: null };
  }

  return { line: naturalLine, stage: null };
}

/** The next line in the bucket, deterministically, skipping both sign lines.
 *
 *  Design note #1044: FORWARD FROM THE NATURAL INDEX, wrapping, and bounded by the bucket's own length so a
 *  bucket that somehow contained nothing else returns what it was given rather than looping. */
function skipFrom(bucket: FlavorBucket, parts: RevenueSeedParts, fallback: string): string {
  const lines = UNPREDICTABLE_REVENUE_FLAVOR[bucket];
  // Design note #1051: the same index `revenueFlavourClause` computed, off the same draw, so the skip starts
  // where the natural draw landed rather than somewhere else in the bucket.
  const start = Math.floor(parts.turnSeed / 6) % lines.length;
  for (let step = 1; step <= lines.length; step += 1) {
    const candidate = lines[(start + step) % lines.length];
    if (candidate !== YELLOW_SIGN_MALUS_LINE && candidate !== YELLOW_SIGN_BONUS_LINE) return candidate;
  }
  return fallback;
}
