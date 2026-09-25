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
import {
  flavorBucketFor,
  legacyTurnSeed,
  resolveVariants,
  revenueFlavourClause,
  rollTurnRevenue,
  type FlavorBucket,
  type RevenueRoll,
  type RevenueSeedParts,
} from "./gameVariants";
import { DEPOT_COST, TIER_ORDER, derivePhase, openDepotTiers, trainTier, type TrainTier } from "./gamePhase";
import type { GameStateResponse, PublicCompanyState } from "./gameState";
// UR-3 (OD-GR-3): the Mark chooses among the copies no Gentle Rust mark covers -- the same multiset GR-2 asks.
import { unreprievedTrains } from "./gentleRustGrace";

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
/* ==================================================================
    DESIGN NOTE 1421: SIXTY, BECAUSE TWENTY WAS ANTI-CLIMACTIC
   ==================================================================
   RULED: "the Yellow Sign happening without the Carcosa Awaits follow-on is anti-climactic ... I think that
   needs to be bumped to 50-70%." And the twenty was never the whole story: the escalation also needs a
   critical bonus on the die (one face in six), so the marked corporation's chance PER RUN was one in thirty,
   and a corporation marked in phase 4 with six or seven runs left in phases 5-D saw it about one game in five.
   At sixty it is roughly one in ten per run and better than even over the same stretch -- the sign usually
   pays off, and still not on schedule. */
export const CARCOSA_CHANCE_IN_100 = 60;

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

/** The run this corporation just made, with the Mark's train taken out of it -- design note #1375.
 *
 *  THE TAKEN TRAIN'S ROUTE COMES OFF THE PRINTED TOTAL and the remainder is rolled again under the turn's own
 *  seed, so the bonus or malus the table saw still applies, to what is left. Which route was the taken
 *  train's is read from `last_run_breakdown` (#1031): by fleet slot first, since two trains may share a
 *  model, then by model. A run whose log named no trains has no breakdown and is left whole -- the only
 *  honest answer when the record cannot say which route vanished.
 *  ONE FUNCTION FOR BOTH READERS: the reducer applies it and the shell narrates it, so the sentence and the
 *  board cannot disagree about the figure. */
export function runWithoutTrain(
  company: Pick<PublicCompanyState, "owned_trains" | "printed_route_revenue" | "last_route_revenue" | "last_run_breakdown" | "routes_run_this_turn">,
  model: string,
  parts: RevenueSeedParts | null,
  /** UR-3 (OD-GR-3, UR-F5): the fleet AS IT RAN -- the one whose slots `last_run_breakdown` indexes -- when it differs
   *  from `company.owned_trains` because the Run -> Dividends settlement has since destroyed a Gentle Rust Final Run
   *  train. Absent: the breakdown indexes the current fleet (every caller before UR-3, and the legacy request path). */
  fleetAsRun?: readonly string[] | null,
): {
  printed: number;
  adjusted: number;
  roll: RevenueRoll | null;
  routes: number;
  breakdown: PublicCompanyState["last_run_breakdown"];
  /** UR-3: the breakdown entry whose route was nullified -- the taken train's own -- or `null` when none was. */
  nullified: NonNullable<PublicCompanyState["last_run_breakdown"]>[number] | null;
} {
  const printedBefore = Math.max(0, Number(company.printed_route_revenue ?? 0) || 0);
  const adjustedBefore = Math.max(0, Number(company.last_route_revenue ?? 0) || 0);
  const breakdown = company.last_run_breakdown ?? [];
  const current = company.owned_trains ?? [];
  /* ==================================================================
      UR-3 (OD-GR-3 = A2, UR-F5): THE SLOT IS THE TAKEN TRAIN'S SLOT IN THE FLEET THE BREAKDOWN DESCRIBES
     ==================================================================
     `last_run_breakdown` is written by the run and indexes the fleet AS IT RAN. The Mark now chooses AFTER the
     Run -> Dividends settlement, which may already have destroyed a Final Run train -- so "the taken copy's index in
     `owned_trains`" is an index into a DIFFERENT, shorter fleet, and P-C showed it landing on the destroyed train's
     route: the Mark nullified the Final Run 2's $50 and kept the taken 3's $60.
     SO THE SETTLED FLEET IS ALIGNED BACK ONTO THE FLEET AS IT RAN. The settlement only removes, and removes each
     spent model's EARLIEST copies (`expireReprieveFor`'s `indexOf`), so taking out the first k copies of every model
     it removed k times leaves the surviving slots in their original order: `surviving[i]` is where the settled
     fleet's i-th train stood when it ran. The taken copy is the settled fleet's first of its model (#1046's tie
     rule), so its slot is `surviving[current.indexOf(model)]`. The model fallback below (#1375: a slot that ran no
     route) is kept, and confined to SURVIVING slots so a destroyed train's route can never be taken for the
     Mark's. Without `fleetAsRun` both lists are the same fleet and this is exactly the old arithmetic. */
  const asRun = fleetAsRun ?? current;
  const removed = [...asRun];
  for (const survivor of current) {
    const at = removed.indexOf(survivor);
    if (at >= 0) removed.splice(at, 1);
  }
  const surviving: number[] = [];
  const spent = [...removed];
  asRun.forEach((entry, slot) => {
    const at = spent.indexOf(entry);
    if (at >= 0) spent.splice(at, 1);
    else surviving.push(slot);
  });
  const takenCopy = current.indexOf(model);
  const slot = takenCopy >= 0 ? (surviving[takenCopy] ?? -1) : -1;
  const takenAt = (() => {
    const bySlot = slot >= 0 ? breakdown.findIndex((entry) => entry.train_index === slot) : -1;
    if (bySlot >= 0) return bySlot;
    return breakdown.findIndex((entry) => entry.model === model && (fleetAsRun == null || surviving.includes(entry.train_index)));
  })();
  if (takenAt < 0) {
    return {
      printed: printedBefore,
      adjusted: adjustedBefore,
      roll: null,
      routes: breakdown.length || (company.routes_run_this_turn ?? 0),
      breakdown: company.last_run_breakdown,
      nullified: null,
    };
  }
  const takenPrinted = Math.max(0, Number(breakdown[takenAt].printed_revenue) || 0);
  const printed = Math.max(0, printedBefore - takenPrinted);
  const remaining = breakdown.filter((_entry, at) => at !== takenAt);
  const roll = parts ? rollTurnRevenue(printed, parts) : null;
  return {
    printed,
    adjusted: roll ? roll.adjusted : printed,
    roll,
    routes: remaining.length,
    breakdown: remaining,
    nullified: breakdown[takenAt],
  };
}

/** The tier the Escalation gifts, read off the PHASE.
 *
 *  Design note #1046: "a train matching the current phase's tier", read off the phase rather than off the
 *  depot -- the depot may have sold out of that tier, and the gift explicitly does not come from the bank.
 *
 *  SUPERSEDED FOR THE GIFT ITSELF BY #1672 (S9-2). The owner's rule names the depot, not the phase:
 *  `carcosaGiftModel` below is what the escalation now hands over. This stays as the phase reading, because
 *  it is still the honest fallback when the board cannot say what is on the shelf, and because deleting an
 *  exported answer that two readers still agree about would be churn. */
export function escalationTier(phaseTier: string): TrainTier | null {
  const at = (TIER_ORDER as readonly string[]).indexOf(phaseTier);
  return at < 0 ? null : TIER_ORDER[at];
}

/** ==================================================================
 *   DESIGN NOTE 1672 (S9-2): THE GIFT IS THE DEPOT'S LOWEST, NOT THE PHASE'S TIER
 *  ==================================================================
 *
 * OWNER RULING (2026-09-19): "Carcosa grants a synthetic train matching the LOWEST-VALUE TRAIN CURRENTLY
 * REPRESENTED BY THE AUTHORITATIVE BANK DEPOT RULE when the gift occurs. Do NOT simply infer the model from
 * phase if depot state can differ."
 *
 * AND THE TWO DO DIFFER, which is why #1046's shortcut has to go. The phase is "the highest tier anybody
 * owns"; the depot's lowest available tier is what the bank would actually sell next. They agree while a
 * phase's own tier is still on the shelf and part the moment it sells out -- a phase-5 game whose last 5 has
 * gone is selling 6s, and #1046 would have gifted a 5 that the depot no longer represents.
 *
 * REUSING THE AUTHORITATIVE MACHINERY RATHER THAN RESTATING IT. `openDepotTiers` is the depot rule -- the
 * first tier with stock, plus the open shelf where one is open -- and its head is the lowest-value train the
 * depot currently represents. The gift is still SYNTHETIC: it does not decrement that row, because
 * `depotInventory` subtracts `ghost_trains` from the tally (#1046, `gamePhase.ts`).
 *
 * THE PHASE IS THE FALLBACK, not the rule: a board with no readable depot (an unpinned fixture, a roster of
 * unreported fleets) still has a phase, and #232's "the log does not say" is answered by the old reading
 * rather than by refusing the gift. */
export function carcosaGiftModel(
  state: Parameters<typeof openDepotTiers>[0],
  phaseTier: string,
): TrainTier | null {
  return openDepotTiers(state)[0]?.tier ?? escalationTier(phaseTier);
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

/* ==================================================================
    DESIGN NOTE 1404: THE STATE KNOWS WHO IS MARKED; THE SENTENCE NO LONGER SAYS
   ==================================================================
   REPORTED (Phase D, debug armed): "instead it did the Yellow Sign to my corporation and took my D-train...
   Yellow Sign is only possible on phases 2-4 ... I was expecting that it would arm the event for the next
   legal step in the sequence."
   #1044 READ THE MARKED TICKER OFF THE LOG LINE -- "<TICKER> ran for $N. <the malus line>" -- and #1375 then
   split that line in two: the run's own mechanical line first, and the sign's clause on a SECOND line that
   opens with the clause itself. `tickerFrom` found no "ran for" on it and answered null, so every client
   read the game as unmarked. That is why the forced stage resolved to a second Mark rather than the Carcosa
   the arming was for, and why a natural second Mark had become possible too.
   THE REDUCER HAS HELD THE ANSWER SINCE #1046: `has_yellow_sign` is set by the Mark's own action and cleared
   by the escalation, which sets `is_carcosan`. Both replay from the log like everything else, so this reads
   them and the sentence parse survives only as the fallback for a state that carries neither flag. */
export function yellowSignStateFromCompanies(
  companies: ReadonlyArray<{ ticker: string; has_yellow_sign?: boolean; is_carcosan?: boolean }>,
): YellowSignState {
  const marked = companies.find((company) => company.has_yellow_sign === true);
  const carcosan = companies.find((company) => company.is_carcosan === true);
  return {
    markedTicker: marked?.ticker ?? carcosan?.ticker ?? null,
    carcosaSeen: carcosan !== undefined,
  };
}

/** The state's answer where it has one, the log's where it does not (#1404). */
export function yellowSignStateOf(
  companies: ReadonlyArray<{ ticker: string; has_yellow_sign?: boolean; is_carcosan?: boolean }>,
  logLabels: readonly string[],
): YellowSignState {
  const fromState = yellowSignStateFromCompanies(companies);
  if (fromState.markedTicker !== null) return fromState;
  return yellowSignStateFrom(logLabels);
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
 *      [UR-6 (audit Appendix B item 8): not a tenth -- `CARCOSA_CHANCE_IN_100`, 60 in 100 since #1421.]
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
   [UR-6 (audit Appendix B item 8): the roll is `CARCOSA_CHANCE_IN_100` -- 60 in 100 since #1421, not 1 in 5 -- and
   the Fog is no longer a run stage at all on the run path (OD-UR-2: `fogAtSetEnd`, at the end of the set).]
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

/* ==================================================================
    DESIGN NOTE 1404 (arming): THE SHORTCUT OFFERS THE STAGES THAT CAN STILL HAPPEN
   ==================================================================
   "I was expecting that it would arm the event for the next legal step in the sequence." #1128's cycle was
   fixed -- null, mark, carcosa, fog -- so in Phase D with a corporation already marked the first press
   armed a Mark: a stage the game had spent and whose window (phases 2-4) had closed. Now the cycle is built
   from the game: a Mark while nobody is marked and the window is open; the Carcosa while somebody is marked,
   unescalated, and the window (5-D) is open; the Fog while a Carcosan corporation exists. Off, then each in
   order, then off. The forced Mark also respects its window below (#1128 skipped it; the ruling here is that
   it is "only possible on phases 2-4"). */
export function forcedSignStagesAvailable(state: YellowSignState, phaseTier: string): ForcedSignStage[] {
  const stages: ForcedSignStage[] = [];
  if (state.markedTicker === null && markWindowOpen(phaseTier)) stages.push("mark");
  if (state.markedTicker !== null && !state.carcosaSeen && escalationWindowOpen(phaseTier)) stages.push("carcosa");
  if (state.carcosaSeen) stages.push("fog");
  return stages;
}

/** The next value for the debug chip: off -> first available -> ... -> off. A currently armed stage that is
 *  no longer available steps to the first one that is. */
export function nextForcedSign(
  current: ForcedSignStage | null,
  state: YellowSignState,
  phaseTier: string,
): ForcedSignStage | null {
  const order: (ForcedSignStage | null)[] = [null, ...forcedSignStagesAvailable(state, phaseTier)];
  const at = order.indexOf(current);
  return order[(at + 1) % order.length] ?? null;
}

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
     own line to be drawn, the escalation needs a critical bonus and a 1-in-5 roll [UR-6, Appendix B item 8: 60 in
     100 since #1421] -- and either could be asked on the same turn the fog is due. A debt that has come due does not
     wait for a better draw. [UR-3 / OD-UR-2: this branch is the unpinned legacy request's; the run path's fog falls
     at the end of the set.]
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
       and a 1-in-5 [UR-6: 60 in 100 since #1421]. The three conditions above are not gates in that sense; they are who the story is about,
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
  if (
    forced === "mark" &&
    state.markedTicker === null &&
    markWindowOpen(phaseTier) && // #1404: "only possible on phases 2-4", forced or not
    lowestValueTrain(owned) !== null
  ) {
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

/* ==================================================================
    DESIGN NOTE 1661 (S9-1): THE OUTCOME IS DERIVED, NOT SENT
   ==================================================================

   THE DEFECT. `YellowSignEvent` carried the answer: the client picked the stage, named the corporation's
   train, and quoted the Mark's cash award, and the authoritative reducer applied all three after a shape
   check. Trains, treasury cash, Carcosan status, the train-limit exemption and the doom clock were therefore
   whatever an ordinary hosted client said they were, and the one thing the variant is built on -- that the
   sign is a LOTTERY -- was the one thing the client got to choose.

   THE FIX IS NOT A PLAUSIBILITY CHECK. Asking whether a client-supplied stage/model/cash are individually
   believable still lets a client pick among the believable answers, and the whole point of a random event is
   that exactly one of them is the right one. So the outcome is DERIVED here, from the committed board, and
   the message becomes a request to resolve.

   WHY IT IS ALREADY REPLAY-DETERMINISTIC, WITH NO NEW RANDOM SOURCE. Every input this function reads is
   committed:
     - the turn's draw is `last_run_revenue_seed`, which is #1051's committed roll copied onto the board by
       the run that made it -- one draw, recorded in the log, replayed rather than re-rolled;
     - the printed total, the fleet, the treasury, `has_yellow_sign` / `is_carcosan` / `carcosan_trains` and
       the doom clock are all reducer-written board state;
     - the phase is `derivePhase`, a function of that same board.
   So the same pre-state replays to the same outcome on every client and on every rebuild, which is the
   property #1044 spent its whole note defending -- reached now for the MECHANICS as well as for the sentence.

   THE DEBUG FORCE SURVIVES AND STOPS BEING A CHOICE. #1128 asked for a playtest trigger and #1404 refined it
   to "the next legal step in the sequence"; `forcedSignStagesAvailable` already computes that sequence FROM
   THE BOARD, and at most one stage is ever available (a Mark needs nobody marked; the Carcosa needs somebody
   marked and unescalated; the Fog needs a Carcosan corporation -- the three predicates are mutually
   exclusive). So the request carries a BOOLEAN, not a stage: the caller may waive the chance and the window,
   and the board still says which stage that waiver lands on. A hand-crafted message cannot name one.

   ONE FUNCTION, BOTH READERS -- `runWithoutTrain`'s rule (#1375) applied to the whole event. The reducer
   derives the outcome it applies and the shell derives the sentence it prints, from this function, against
   the same post-run board. The Activity Log and the treasury cannot come apart. */

/** What the sign does to the board this turn, derived. `null` for "no stage fires". */
export interface YellowSignOutcome {
  stage: "mark" | "carcosa" | "fog";
  /** The train taken (mark / fog) or gifted (carcosa). Never empty -- a stage with no train does not fire. */
  model: string;
  /** The Mark's award, `0` for the other two stages. */
  cash: number;
  /** The committed draw this outcome was derived under, for the Mark's `runWithoutTrain`. */
  parts: RevenueSeedParts;
}

/** The board this resolution reads. Declared structurally rather than imported as `GameStateResponse` so this
 *  module keeps reading boards without depending on the whole state surface -- #1040's rule, one module one
 *  subject. */
export interface YellowSignBoard {
  macro_round_number?: number;
  sub_round_index?: number;
  public_companies: ReadonlyArray<
    Pick<
      PublicCompanyState,
      | "company_id"
      | "ticker"
      | "owned_trains"
      | "printed_route_revenue"
      | "last_route_revenue"
      | "last_run_breakdown"
      | "routes_run_this_turn"
      | "has_yellow_sign"
      | "is_carcosan"
      | "carcosan_trains"
      | "carcosan_doom_after_macro_round"
      | "last_run_revenue_seed"
    >
  >;
}

export interface YellowSignResolution {
  /** The flavour clause the turn ends on, and which stage (if any) fired. */
  resolution: FlavourResolution;
  /** The mechanical consequence, or `null` when no stage fires or the stage has no train to act on. */
  outcome: YellowSignOutcome | null;
}

const NO_RESOLUTION: YellowSignResolution = {
  resolution: { line: "", stage: null },
  outcome: null,
};

/** The authoritative Yellow Sign resolution for `protocolId`'s just-finished run.
 *
 *  `board` is the state the run has ALREADY been applied to -- the reducer's own output. Nothing the sign
 *  reads is changed by a run (the fleet, the flags, the doom clock, the phase), and the two figures that ARE
 *  changed by it (`printed_route_revenue`, `last_run_breakdown`) are exactly the ones this needs in their
 *  post-run form, which is why the post-run board is the one honest input for both readers.
 *
 *  `force` waives the CHANCE and the WINDOW, never the state (#1128). Which stage a waiver lands on is the
 *  board's answer, not the caller's. */
export function resolveYellowSign(
  /* #1672 (S9-2): the WHOLE board now, not the narrow structural slice. The gift's model is the depot's
     lowest-value train and the doom trigger asks whether a real Diesel has been bought, and neither question
     can be answered from a list of companies. `YellowSignBoard` stays exported as the documentation of what
     this function actually reads. */
  board: GameStateResponse,
  protocolId: number,
  phaseTier: string,
  /** `run` (UR-3): the resolution the authoritative RUN owes -- asked by the reducer on the board after the Run ->
   *  Dividends settlement, and by the narration on the same board. The fog is not a run stage there (OD-UR-2), no
   *  waiver exists (a pinned table has no playtests), and the Mark chooses among the copies no Gentle Rust mark
   *  covers (OD-GR-3). Absent: the legacy request's resolution, unchanged. */
  options?: { force?: boolean; run?: boolean },
): YellowSignResolution {
  const company = board.public_companies.find((entry) => entry.company_id === protocolId);
  if (!company) return NO_RESOLUTION;
  const run = options?.run === true;

  const macroRound = board.macro_round_number ?? 0;
  const subRound = board.sub_round_index ?? 0;
  /* #1051's committed draw, off the board. The fallback is the pre-#1051 hash, which is what the run arm and
     the shell both fall back to for a log written before the roll was recorded -- so all three agree about an
     old entry exactly as they agree about a new one. */
  const parts: RevenueSeedParts = {
    macroRound,
    subRound,
    companyId: protocolId,
    turnSeed:
      typeof company.last_run_revenue_seed === "number"
        ? company.last_run_revenue_seed
        : legacyTurnSeed(macroRound, subRound, protocolId),
  };

  const signState = yellowSignStateFromCompanies(board.public_companies);
  /* #1404's sequence, computed from the board. At most one stage is available at a time, so this IS the armed
     stage rather than a menu the caller chooses from. */
  const forced = !run && options?.force === true ? (forcedSignStagesAvailable(signState, phaseTier)[0] ?? null) : null;
  /* UR-3 (OD-GR-3 = A2): on the run's own resolution the candidates are the settled fleet's UNREPRIEVED copies. The
     settlement has already destroyed every Final Run train the turn owed, so this subtracts nothing in any board the
     game can reach -- it is the ruling written where the Mark chooses, so no copy a Gentle Rust mark covers can ever
     be taken, monetized or replaced by the Sign. */
  const candidates = run ? unreprievedTrains(company) : company.owned_trains;

  const printedTotal = Math.max(0, Number(company.printed_route_revenue ?? 0) || 0);
  const roll = rollTurnRevenue(printedTotal, parts);
  const resolution = resolveFlavourLine({
    naturalLine: revenueFlavourClause(roll, parts),
    bucket: flavorBucketFor(roll),
    ticker: company.ticker,
    parts,
    state: signState,
    phaseTier,
    owned: candidates,
    // UR-3 (OD-UR-2): the fog is an OR-set-boundary transition, never a stage of a run.
    fogDue: run ? false : fogIsDue(company, macroRound),
    forced,
  });

  const model = ((): string | null => {
    switch (resolution.stage) {
      case "mark":
        return lowestValueTrain(candidates);
      case "carcosa":
        // #1672 (S9-2): the depot's lowest-value train, not the phase's tier.
        return carcosaGiftModel(board, phaseTier);
      case "fog":
        return (company.carcosan_trains ?? [])[0] ?? null;
      default:
        return null;
    }
  })();

  if (resolution.stage === null || model === null || model === "") {
    return { resolution, outcome: null };
  }
  return {
    resolution,
    outcome: {
      stage: resolution.stage,
      model,
      cash: resolution.stage === "mark" ? markPayout(model) : 0,
      parts,
    },
  };
}

/** Which stage a `YellowSignEvent` actually applied, read off the board it moved.
 *
 *  Design note #1661: THE MESSAGE NO LONGER SAYS, so the readers that used to ask it (the timeline's Carcosan
 *  Railways accolade, #1421) ask the diff instead. One train gone and the sign newly out is a Mark; a train
 *  gained and the corporation newly Carcosan is the escalation; a `carcosan_trains` entry gone is the Fog.
 *  `null` when the arm refused and nothing moved, which is the answer those readers already wanted. */
export function yellowSignStageApplied(
  before: Pick<PublicCompanyState, "owned_trains" | "has_yellow_sign" | "is_carcosan" | "carcosan_trains"> | undefined,
  after: Pick<PublicCompanyState, "owned_trains" | "has_yellow_sign" | "is_carcosan" | "carcosan_trains"> | undefined,
): { stage: "mark" | "carcosa" | "fog"; model: string | null } | null {
  if (!before || !after) return null;
  const hadMarks = before.carcosan_trains ?? [];
  const hasMarks = after.carcosan_trains ?? [];
  const lostMark = hadMarks.find((model) => {
    const remaining = [...hasMarks];
    const at = remaining.indexOf(model);
    return at < 0;
  });
  if (hasMarks.length < hadMarks.length && lostMark !== undefined && after.is_carcosan === true) {
    return { stage: "fog", model: lostMark };
  }
  const had = before.owned_trains ?? [];
  const has = after.owned_trains ?? [];
  if (after.has_yellow_sign === true && before.has_yellow_sign !== true) {
    return { stage: "mark", model: missingFrom(had, has) };
  }
  if (after.is_carcosan === true && before.is_carcosan !== true) {
    return { stage: "carcosa", model: missingFrom(has, had) };
  }
  return null;
}

/** The one entry `from` holds that `to` does not, by multiset -- `null` when they agree. */
function missingFrom(from: readonly string[], to: readonly string[]): string | null {
  const remaining = [...to];
  for (const model of from) {
    const at = remaining.indexOf(model);
    if (at >= 0) remaining.splice(at, 1);
    else return model;
  }
  return null;
}

/* ==================================================================
    UR-3 (OD-UR-1 = 1-A, backlog D-37): THE STAGE IS THE RUN'S, AND THE RUN IS THE AUTHORITY'S
   ==================================================================
   OWNER RULING (2026-09-24): "A Yellow Sign stage is an automatic, derived consequence of the authoritative run,
   not a discretionary second player action. A player or client may not omit, delay, redirect or manufacture it. On
   pinned (authoritative) tables the game authority resolves the stage from the run and its committed seed and
   result. The client-sent request is removed as a source of authority -- it is not merely repaired."
   S9-1 (#1661 / #1662) had already made the OUTCOME the board's: the stage, the train, the award and the gift are
   derived from the committed board and the run's committed draw. What it left to the client was WHETHER, WHEN and
   FOR WHOM a request was sent (UR-F2) -- and the only client that sent it did so from inside its log drain, where
   #1407's catch-up guard refused every one, so on no hosted board did the Sign ever land (UR-F1).
   SO THE REQUEST IS NOT REPAIRED; IT IS RETIRED. The reducer resolves the stage as the last step of the run's own
   transition (`sandboxSession.ts`, `settleRunYellowSign`), on the board AFTER the Run -> Dividends settlement
   (OD-GR-3), with `resolveYellowSign(.., { run: true })` -- no new message, no new draw, nothing a client can omit,
   delay or aim elsewhere, and a replay reaches it from the committed run alone. On a pinned table the old request is
   refused at ingress and by the reducer; an UNPINNED board (the development corpus, a Firestore room) keeps the
   legacy request path byte for byte, because its stored entries must replay to the boards they were played on.
   AND THE FOG IS NOT A RUN STAGE ANY MORE (OD-UR-2): `fogAtSetEnd` below is an OR-set-boundary transition. */

/** Whether this board resolves the Sign from its runs (UR-3): a pinned table playing Unpredictable Revenue. */
export function automaticYellowSignInForce(state: Pick<GameStateResponse, "rules_engine_version" | "variants">): boolean {
  return typeof state.rules_engine_version === "number" && resolveVariants(state.variants).unpredictableRevenue;
}

/** Why a client's `YellowSignEvent` may not be applied to this board, or `null` on the unpinned legacy path.
 *  Asked by ingress (`turnRefusal`), the reducer's gate and the shell's refusal line, so the three agree. */
export function yellowSignRequestRefusal(state: Pick<GameStateResponse, "rules_engine_version" | "variants">): string | null {
  if (typeof state.rules_engine_version !== "number") return null;
  if (!resolveVariants(state.variants).unpredictableRevenue) {
    return "This table does not play Unpredictable Revenue, so there is no Yellow Sign to resolve.";
  }
  return "The Yellow Sign is resolved by the game itself, as part of the run that draws it; no player sends it.";
}

/** UR-7 (UR-N62): whether the host's playtest force -- #1128's "SIGN" chip and its Ctrl+Shift+Y shortcut -- can act on
 *  this board at all.
 *
 *  ONLY WHERE THE LEGACY REQUEST PATH STILL RUNS: a dealt, UNPINNED board playing Unpredictable Revenue (a Firestore
 *  sandbox room, S10-11's residual). There the narration arms `debug_force` on the request it sends (#1128, #1661). On
 *  a pinned table the waiver is dropped at ingress and refused by the reducer, the shell sends no request at all, and
 *  the Sign is the run's own consequence (OD-UR-1) -- so the chip there could change nothing, while its tooltips named
 *  the Sign's phase windows and whom it can visit next, which OD-UR-8 keeps hidden from players (D-42), and described
 *  the fog as a run stage, which OD-UR-2 retired. The shell renders the chip, and honours the shortcut, only where this
 *  answers true. A standard table has no Yellow Sign to force. */
export function forcedSignToolInForce(
  state: Pick<GameStateResponse, "rules_engine_version" | "variants"> | null | undefined,
): boolean {
  if (!state) return false;
  return yellowSignRequestRefusal(state) === null && resolveVariants(state.variants).unpredictableRevenue;
}

/** What the authority applied at this turn's run, as it wrote it on the corporation (`last_run_yellow_sign`). */
export type RunYellowSignRecord = NonNullable<PublicCompanyState["last_run_yellow_sign"]>;

/** The Sign's report for the Activity Log, read off the board the run produced -- UR-3 (UR-F6).
 *
 *  THE NARRATION DESCRIBES WHAT THE BOARD APPLIED, NEVER A SECOND DERIVATION OF IT. Before UR-3 the shell resolved the
 *  Sign itself on the fleet AS IT RAN while the reducer (had a request ever landed) judged the fleet after the
 *  settlement -- P-C: the narration named the Final Run 2 and $40, the board took the 3 and $90. Now:
 *    * a stage the authority applied is read off `last_run_yellow_sign` -- the train, the award, whether a route was
 *      nullified -- and the kept run off the corporation's own figures (the roll re-derived from the committed seed,
 *      the same function the reducer used, on the same kept total);
 *    * no stage applied: the run's own resolution (`resolveYellowSign(.., { run: true })`), asked of `after`, which IS
 *      the board the reducer resolved on (nothing after the settlement touches a field the Sign reads), so the flavour
 *      line -- including the skip that keeps the Mark's line in the pool when no train can be taken -- is the one the
 *      authority drew. The phase is `before`'s: a run never turns it. */
export interface RunYellowSignReport {
  resolution: FlavourResolution;
  /** The Mark's train, or `null`. */
  taken: string | null;
  /** The Mark's minted award (0 when no Mark). */
  award: number;
  /** The Mark's kept run: what the corporation ran without the vanished train. `roll` is `null` when no route was
   *  nullified (the taken train did not run), exactly as `runWithoutTrain` reports it. */
  kept: { routes: number; adjusted: number; roll: RevenueRoll | null } | null;
  /** Carcosa's gift, or `null`. */
  gifted: string | null;
}

export function narrateRunYellowSign(
  before: GameStateResponse,
  after: GameStateResponse,
  companyId: number,
  parts: RevenueSeedParts,
): RunYellowSignReport {
  const was = before.public_companies.find((entry) => entry.company_id === companyId);
  const now = after.public_companies.find((entry) => entry.company_id === companyId);
  const record = now?.last_run_yellow_sign;
  const applied = record !== undefined && record !== was?.last_run_yellow_sign ? record : null;
  if (applied?.stage === "mark" && now) {
    const keptPrinted = Math.max(0, Number(now.printed_route_revenue ?? 0) || 0);
    return {
      resolution: { line: YELLOW_SIGN_MALUS_LINE, stage: "mark" },
      taken: applied.model,
      award: Math.max(0, Number(applied.award) || 0),
      kept: {
        routes: now.routes_run_this_turn ?? 0,
        adjusted: Math.max(0, Number(now.last_route_revenue ?? 0) || 0),
        roll: applied.nullified ? rollTurnRevenue(keptPrinted, parts) : null,
      },
      gifted: null,
    };
  }
  if (applied?.stage === "carcosa") {
    return {
      resolution: { line: YELLOW_SIGN_BONUS_LINE, stage: "carcosa" },
      taken: null,
      award: 0,
      kept: null,
      gifted: applied.model,
    };
  }
  const phaseTier = derivePhase(before)?.tier ?? "2";
  const { resolution } = resolveYellowSign(after, companyId, phaseTier, { run: true });
  if (resolution.stage === null) return { resolution, taken: null, award: 0, kept: null, gifted: null };
  /* A stage the resolution names but the board did not apply cannot be narrated as having happened. By construction
     the two agree (the reducer applies exactly this resolution's outcome, and a stage with no train does not fire);
     this keeps the sentence honest if a gate ever declines it: the line is drawn as if every stage were spent, which
     is #1044's skip -- never the Sign's own line. */
  const roll = rollTurnRevenue(Math.max(0, Number(now?.printed_route_revenue ?? 0) || 0), parts);
  const spent = resolveFlavourLine({
    naturalLine: revenueFlavourClause(roll, parts),
    bucket: flavorBucketFor(roll),
    ticker: now?.ticker ?? "",
    parts,
    state: { markedTicker: "\u0000", carcosaSeen: true },
    phaseTier,
    owned: [],
    fogDue: false,
    forced: null,
  });
  return { resolution: { line: spent.line, stage: null }, taken: null, award: 0, kept: null, gifted: null };
}

/** The record `after`'s run wrote for `companyId` in THIS entry -- `null` when the run applied no stage (or the entry
 *  was not a run). Compared with `before`'s so a record left standing from earlier in the turn is not read twice. */
export function runYellowSignWritten(
  before: Pick<GameStateResponse, "public_companies"> | null | undefined,
  after: Pick<GameStateResponse, "public_companies"> | null | undefined,
  companyId: number,
): RunYellowSignRecord | null {
  const now = after?.public_companies?.find((entry) => entry.company_id === companyId)?.last_run_yellow_sign;
  if (now === undefined) return null;
  const was = before?.public_companies?.find((entry) => entry.company_id === companyId)?.last_run_yellow_sign;
  return was !== undefined && JSON.stringify(was) === JSON.stringify(now) ? null : now;
}

/** UR-3: the run AS IT WAS PRICED before the Sign's Mark nullified a route -- the full printed total and breakdown --
 *  for a corporation whose run just wrote `record`. With no Mark, or a Mark whose train ran no route, these are the
 *  corporation's own figures. The statistics read their run figures here (OD-UR-6 is open, so they keep the basis
 *  they have always had: the run's entry, priced in full), and the narration its roll.
 *  `routeOrder` is the run message's `train_indices` when it named them: the nullified entry goes back where it ran;
 *  without it, the entry is appended. */
export function runBeforeSign(
  company: Pick<PublicCompanyState, "printed_route_revenue" | "last_run_breakdown"> | null | undefined,
  record: RunYellowSignRecord | null,
  routeOrder?: readonly number[] | null,
): { printed: number; breakdown: NonNullable<PublicCompanyState["last_run_breakdown"]> } {
  const printed = Math.max(0, Number(company?.printed_route_revenue ?? 0) || 0);
  const breakdown = [...(company?.last_run_breakdown ?? [])];
  const nullified = record?.stage === "mark" ? record.nullified : null;
  if (!nullified) return { printed, breakdown };
  const at = routeOrder ? routeOrder.indexOf(nullified.train_index) : -1;
  if (at >= 0 && at <= breakdown.length) breakdown.splice(at, 0, nullified);
  else breakdown.push(nullified);
  return { printed: printed + Math.max(0, Number(nullified.printed_revenue) || 0), breakdown };
}

/* ==================================================================
    UR-3 (OD-UR-2 "N+1 + boundary", backlog D-38, UR-F18): THE FOG AT THE END OF SET N+1
   ==================================================================
   OWNER RULING (2026-09-24): a doom trigger in Operating-Round set N lets the gilded train survive through the whole
   next set, N+1; it disappears automatically at the END of N+1 -- "an authoritative OR-set-boundary transition, not a
   run stage and not a Yellow Sign client request". No extra post-deadline run, no indefinite survival because the
   corporation never operates again, no post-deadline window to sell it. #1092's collection on the corporation's
   first run after N+1 is superseded and must not be restored.
   THE DEADLINE ARITHMETIC IS #1089's, UNCHANGED: `carcosan_doom_after_macro_round` is N + 1. What moves is WHERE the
   debt is collected: `settleRoundTransitions` calls this on the transition that ends an Operating-Round set, while
   `macro_round_number` still names the set that just ended -- so a deadline of N + 1 is met exactly at the end of
   N + 1, and never earlier. `<=` rather than `===` so a board that somehow carried an overdue train (built before
   this rule) is settled at its next boundary instead of keeping the train forever.
   WHAT IT TAKES is #1675's removal, unchanged: each gilded copy once from `owned_trains` and once from `ghost_trains`
   (multiset -- a bought 6 beside the gilded 6 stays), the gilding emptied, the clock cleared; `is_carcosan` stays
   (#1089: the curse outlives the train). It is NOT a rust: nothing here is a phase change, and the narrators leave
   it out of their rust and limit sentences. It acts on the gilding that EXISTS: a train that already left by a Blood
   Price carries no gilding at the seller, and whatever the sale left gilded is what is due -- OD-UR-5 is not decided
   here. Pure; `null`-safe on a board that reports no fleets (#232). */
/** Whether `company`'s gilded train is due at the end of the set `setEnding` names (OD-UR-2). */
function gildingDue(company: PublicCompanyState, setEnding: number): boolean {
  const doom = company.carcosan_doom_after_macro_round;
  return (company.carcosan_trains ?? []).length > 0 && doom !== undefined && doom <= setEnding;
}

/** Whether the transition ending the current Operating-Round set owes the fog anything (OD-UR-2) -- asked by value, so
 *  the round machine never decides by object identity (S7-17). */
export function fogDueAtSetEnd(state: GameStateResponse): boolean {
  if (!resolveVariants(state.variants).unpredictableRevenue) return false;
  const setEnding = state.macro_round_number ?? 0;
  return (state.public_companies ?? []).some((company) => gildingDue(company, setEnding));
}

export function fogAtSetEnd(state: GameStateResponse): GameStateResponse {
  if (!fogDueAtSetEnd(state)) return state;
  const setEnding = state.macro_round_number ?? 0;
  const companies = (state.public_companies ?? []).map((company) => {
    if (!gildingDue(company, setEnding)) return company;
    const gilded = company.carcosan_trains ?? [];
    const survivors = company.owned_trains == null ? null : [...company.owned_trains];
    const ghosts = company.ghost_trains == null ? null : [...company.ghost_trains];
    for (const model of gilded) {
      const owned = survivors === null ? -1 : survivors.indexOf(model);
      if (owned >= 0) survivors!.splice(owned, 1);
      const ghost = ghosts === null ? -1 : ghosts.indexOf(model);
      if (ghost >= 0) ghosts!.splice(ghost, 1);
    }
    return {
      ...company,
      ...(survivors === null ? {} : { owned_trains: survivors }),
      ...(ghosts === null ? {} : { ghost_trains: ghosts }),
      carcosan_trains: [],
      carcosan_doom_after_macro_round: undefined,
    };
  });
  return { ...state, public_companies: companies };
}

/** UR-3 (OD-UR-2): the gilded models the set-boundary fog took from one corporation between two of its snapshots --
 *  the gilding gone WITH its doom clock, which is what `fogAtSetEnd` (and only a fog) does -- or `[]`. Read by the
 *  fleet-loss narrator, which must not call the departure a rust or a discard, and by the statistics. */
export function fogCollected(
  was: Pick<PublicCompanyState, "carcosan_trains" | "carcosan_doom_after_macro_round"> | null | undefined,
  now: Pick<PublicCompanyState, "carcosan_trains" | "carcosan_doom_after_macro_round"> | null | undefined,
): string[] {
  const gildingWas = was?.carcosan_trains ?? [];
  if (gildingWas.length === 0 || !now) return [];
  if ((now.carcosan_trains ?? []).length !== 0) return [];
  if (was?.carcosan_doom_after_macro_round === undefined || now.carcosan_doom_after_macro_round !== undefined) return [];
  return [...gildingWas];
}

/** UR-3 (OD-UR-2): what the fog took at the end of an Operating-Round set, per corporation -- the entry that left the
 *  Operating Round, and only the gilded copies `fogCollected` names. The legacy request's fog (an unpinned board's
 *  `YellowSignEvent`) lands mid-round and narrates itself, so it is never reported here. */
export function describeFogAtSetEnd(
  before: GameStateResponse | null | undefined,
  after: GameStateResponse | null | undefined,
): Array<{ companyId: number; ticker: string; models: string[] }> {
  if (!before || !after) return [];
  if (before.current_round_type !== "OperatingRound" || after.current_round_type === "OperatingRound") return [];
  const out: Array<{ companyId: number; ticker: string; models: string[] }> = [];
  for (const company of after.public_companies ?? []) {
    const was = (before.public_companies ?? []).find((entry) => entry.company_id === company.company_id);
    const models = fogCollected(was, company);
    if (models.length > 0) out.push({ companyId: company.company_id, ticker: company.ticker, models });
  }
  return out;
}
