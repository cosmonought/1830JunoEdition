// frontend/src/utils/gameVariants.ts
//
// The house rules a table agrees before it deals.
//
/* ==================================================================
 *  DESIGN NOTE 902: THE VARIANT SET IS A SCHEMA BEFORE IT IS A FEATURE
 * ==================================================================
 *
 * REQUESTED: "We need to lock in the game variants before sealing the frontend, otherwise our Phase 5 smart
 * contracts will strictly assume the standard ruleset."
 *
 * AND THAT REASON IS WHY THIS FILE EXISTS SEPARATELY FROM THE RULES IT NAMES. What Phase 5 is blocked on is the
 * SHAPE -- which flags exist, what values they take, where they travel, what a game that predates them reads
 * as. None of that is affected by whether the frontend has implemented a given variant yet. So the whole set
 * is declared here now, and two of the four are deliberately inert: a config the contract can rely on today is
 * worth more than four half-built rules forks.
 *
 * ALL FOUR ARE DECLARED, INCLUDING THE TWO THAT DO NOTHING. `delayedAuction` and `gentleRust` are real fields
 * with real defaults that travel in the log and land on state; they simply have no reader yet. The alternative
 * -- adding them when they are implemented -- would change the message shape after the contract had been
 * written against it, which is the exact failure the request is trying to avoid.
 *
 * DEFAULTS ARE THE STANDARD GAME, ALWAYS. A missing config is not an error and not an empty object: it is
 * 1830, which is what every game logged before today was. `resolveVariants` is the one place that decides
 * that, so a replay of an old log produces the same game it produced when it was played.
 *
 * See docs/ai_architecture/sandbox_reducer.md, gameVariants.ts #902. */

/** How long the table wants the game to run, expressed as the only thing that actually decides it: the bank.
 *
 *  THE BANK IS THE CLOCK IN 1830, which is what makes this the right knob rather than a round limit. The game
 *  ends when the bank cannot pay (#898), so a smaller bank is a shorter game by the rules already in play --
 *  no new ending condition, no second thing that can stop a game. */
export type GameLength = "short" | "standard" | "long";

/** Requested figures. `standard` is 1830's printed $12,000 and is not a variant at all -- it is the game. */
export const BANK_SIZE_BY_LENGTH: Readonly<Record<GameLength, number>> = {
  short: 4500,
  standard: 12000,
  long: 20000,
};

/** What each option costs a table, in the words a player choosing one needs. */
export const GAME_LENGTH_BLURB: Readonly<Record<GameLength, string>> = {
  short:
    "$4,500 bank. The bank breaks early, often before the 5-trains arrive — a sharp game about the opening.",
  standard: "$12,000 bank. 1830 as printed.",
  long:
    "$20,000 bank. Runs well past the Diesels, with time for late corporations to matter.",
};

export interface GameVariants {
  /** Design note #902: the bank, and therefore the length. */
  length: GameLength;
  /* ==================================================================
      DESIGN NOTE 904: THE B&O LOCK, WRITTEN DOWN BEFORE THE VARIANT EXISTS
     ==================================================================
     IMPLEMENTED -- #905. The game opens on Stock Round 1 with no privates in play, and the auction runs at the
     END OF THE OPERATING ROUND SET IN WHICH THE FIRST 3-TRAIN IS BOUGHT. That trigger was corrected mid-build
     from "immediately before Stock Round 3"; the lock below did not have to change with it, which is the
     entire argument for asking the auction rather than the calendar.
     WHAT IS RECORDED HERE IS THE EDGE CASE, because it is the kind that is found once and then lost. Reported:
     "the B&O President's certificate is awarded to the winner of the B&O private company. Because this auction
     is delayed until before SR3, allowing players to buy B&O stock in SR1 or SR2 would create a fatal state
     collision with that presidency share."

     IT IS WORSE THAN A COLLISION -- IT IS A SILENT ONE, and that is the part worth keeping. `grantBOPresidency`
     opens `if (!bo || bo.president !== null) return state;` and `App.tsx`'s #550 handler bails on
     `if (granted === base) return;` BEFORE it logs. So a player who won the delayed auction, paid for the B&O
     private and chose a par would receive nothing at all: no certificate, no par, no error, and not even an
     Activity Log line saying it did not happen. There are three collisions behind that one silent return:
       THE PRESIDENCY, refused because somebody bought their way into it in SR1.
       THE PAR, which an ordinary SR1 purchase must already have set -- shares cannot be bought off an unparred
       company -- so the auction winner's chosen par has nowhere to go.
       THE SHARES, and this is the quiet one: the grant does
       `ipo_pool_percentage - SANDBOX_PRESIDENT_PERCENTAGE` under a `Math.max(0, ...)`. With the IPO already
       drawn down by two Stock Rounds of buying, that clamp under-removes from the pool while still adding 20%
       to the winner -- inventing shares, with the clamp hiding it.

     BOTH REFINEMENTS WERE TAKEN, and the first one paid for itself within a day: the auction's timing became
     dynamic and `boIsLocked` needed no edit at all.
       GATE ON THE AUCTION, NOT ON THE ROUND NUMBER. "Stock Rounds 1 and 2" is a PROXY for "the auction has not
       happened yet", and this codebase's fifth recurring bug shape is a proxy that stopped standing for its
       subject. A `RevertTo` that rewinds into SR2, an auction that fails to conclude, or a later variant that
       moves it again all break the round-number test and none of them break "has the auction concluded".
       LOCK THE COMPANY, NOT THE PURCHASE. The request says "disable all stock purchases", and purchases are
       only one of the three surfaces above -- par-setting is another, and the bank pool a third. The honest
       rule is that the B&O is not a tradeable company until the auction concludes, which is one condition
       instead of three and cannot be half-applied.
     AND MAKE THE REFUSAL LOUD WHILE YOU ARE THERE. Whatever gate is built, `grantBOPresidency`'s silent
     `return state` should say why it refused -- a gate with a bug should produce a visible complaint rather
     than a certificate that quietly evaporates. */
  delayedAuction: boolean;
  /** IMPLEMENTED -- #906. A rusting train is moved to `pending_rust_trains` rather than destroyed: it runs
   *  once more and is scrapped at the end of that corporation's turn. Because it leaves `owned_trains`, every
   *  surface that counts trains stops counting it, which is how "no train-limit slot" is implemented without
   *  any of those surfaces learning a rule. */
  gentleRust: boolean;
  /** Every running train rolls a d6 against its printed revenue -- design note #903. */
  unpredictableRevenue: boolean;
  /** The share price moves by how MUCH was paid rather than by the fact of paying -- design note #908. */
  dynamicStockMarket: boolean;
}

/* ==================================================================
 *  DESIGN NOTE 908: THE MARKET REWARDS THE SIZE OF THE DIVIDEND
 * ==================================================================
 *
 * REQUESTED: "If a corporation's total payout is less than its current share price: the token does not move.
 * Between 1x and 2x: one cell. Between 2x and 3x (or higher): two cells."
 *
 * SO THE VARIANT CHANGES A COUNT, NOT A DIRECTION, and that is what makes it cheap to implement correctly.
 * 1830 already moves the token one cell along the row on any payout and turns it up at a ledge (#891); this
 * changes only how many times that step is taken. Nothing about ledges, zones or the withhold direction is
 * touched, so none of those rules had to be restated in a variant-shaped copy.
 *
 * NO DIVISION. `Math.floor(payout / price)` would be the obvious spelling and it introduces a float, a
 * division-by-zero on an unparred company, and a rounding question at the boundaries. Two comparisons against
 * multiples answer it exactly, in integers, with the thresholds visible: `>= 2x` is two, `>= 1x` is one, and
 * anything under par-value-for-one-share does not move at all.
 *
 * THE BOUNDARIES ARE INCLUSIVE UPWARD, which the request's wording settles: a payout EQUAL to the share price
 * is not "less than" it, so it moves one; a payout of exactly twice moves two. Stated because "between 1x and
 * 2x" is the one phrase in the rule that could be read either way, and a table arguing about a $100 payout on
 * a $100 share is a bad afternoon.
 *
 * A NON-POSITIVE PRICE MOVES ONE CELL, not two. An unparred or zero-priced company has no meaningful multiple
 * -- every payout is infinitely many times nothing -- and answering "two" there would hand the biggest reward
 * in the variant to the company with the weakest claim on it. One cell is the standard-rules answer, which is
 * the right fallback for a question this rule cannot pose. */

/** How many cells a payout moves the token under Dynamic Stock Market. `0`, `1` or `2`. */
export function dividendStepsFor(
  payout: number,
  sharePrice: number | null | undefined,
  variants: GameVariants,
): number {
  // Standard rules: any payout moves exactly one cell, whatever it was worth.
  if (!variants.dynamicStockMarket) return 1;
  if (!Number.isFinite(payout) || payout <= 0) return 0;
  if (sharePrice == null || !Number.isFinite(sharePrice) || sharePrice <= 0) return 1;
  if (payout >= sharePrice * 2) return 2;
  if (payout >= sharePrice) return 1;
  return 0;
}

/** The sentence for the action bar, so a player can see WHY the token is about to move two cells -- or none. */
export function dividendStepsExplanation(
  payout: number,
  sharePrice: number | null | undefined,
  variants: GameVariants,
): string | null {
  if (!variants.dynamicStockMarket) return null;
  const steps = dividendStepsFor(payout, sharePrice, variants);
  const price = sharePrice == null || !Number.isFinite(sharePrice) ? null : sharePrice;
  if (steps === 0) {
    return price === null
      ? "Dynamic Stock Market: this payout is too small to move the token."
      : `Dynamic Stock Market: $${payout} is less than the $${price} share price, so the token does not move.`;
  }
  if (steps >= 2) {
    return `Dynamic Stock Market: $${payout} is at least twice the $${price} share price, so the token moves two cells.`;
  }
  return `Dynamic Stock Market: $${payout} covers the $${price} share price once, so the token moves one cell.`;
}

/** 1830 as printed. The shape a game with no config recorded reads as. */
export const STANDARD_VARIANTS: GameVariants = {
  length: "standard",
  delayedAuction: false,
  gentleRust: false,
  unpredictableRevenue: false,
  dynamicStockMarket: false,
};

/** Whether a table is playing anything other than the printed game -- for the badge that says so. */
export function hasAnyVariant(variants: GameVariants): boolean {
  return (
    variants.length !== "standard" ||
    variants.delayedAuction ||
    variants.gentleRust ||
    variants.unpredictableRevenue ||
    variants.dynamicStockMarket
  );
}

/** The variants in force, from whatever the log recorded.
 *
 *  FIELD BY FIELD RATHER THAN `?? STANDARD_VARIANTS`, and the difference matters on exactly the log this is
 *  written for: a game recorded before a later flag existed carries a config with some of these keys and not
 *  others. Spreading a default over it fills the gaps; substituting a default for the whole object would throw
 *  away the fields it DID record. #232's rule at the level of the object rather than the field.
 *  AN UNKNOWN LENGTH FALLS BACK rather than throwing, because a client running an older build must be able to
 *  replay a log written by a newer one without crashing -- it will price the bank wrongly, which is visible,
 *  rather than failing to load, which is not diagnosable from the table. */
export function resolveVariants(recorded: Partial<GameVariants> | null | undefined): GameVariants {
  const length =
    recorded?.length !== undefined && recorded.length in BANK_SIZE_BY_LENGTH
      ? recorded.length
      : STANDARD_VARIANTS.length;
  return {
    length,
    delayedAuction: recorded?.delayedAuction ?? STANDARD_VARIANTS.delayedAuction,
    gentleRust: recorded?.gentleRust ?? STANDARD_VARIANTS.gentleRust,
    unpredictableRevenue:
      recorded?.unpredictableRevenue ?? STANDARD_VARIANTS.unpredictableRevenue,
    dynamicStockMarket:
      recorded?.dynamicStockMarket ?? STANDARD_VARIANTS.dynamicStockMarket,
  };
}

/** Design note #905: the train whose arrival calls the delayed auction.
 *
 *  CORRECTED FROM A ROUND NUMBER. This was `DELAYED_AUCTION_BEFORE_STOCK_ROUND = 3` -- the auction sat
 *  immediately before Stock Round 3 -- and the rule is now "at the exact end of the Operating Round set in
 *  which the first 3-train is purchased". The two coincide in a fast game and diverge in every slow one.
 *  A TIER RATHER THAN A LITERAL "3", so the comparison is against `TIER_ORDER` and reads as a phase question
 *  rather than as arithmetic on a round counter. */
export const DELAYED_AUCTION_TRIGGER_TIER = "3";

/** The bank this table starts with. */
export function bankStartFor(variants: GameVariants): number {
  return BANK_SIZE_BY_LENGTH[variants.length];
}

/* ==================================================================
 *  DESIGN NOTE 904a: THE B&O IS NOT A COMPANY YET
 * ==================================================================
 *
 * The lock #904 called for, stated as ONE predicate rather than as a rule repeated at three surfaces.
 *
 * ASKED OF THE AUCTION, NOT OF THE ROUND NUMBER. The request said "during Stock Rounds 1 and 2", and that is
 * a proxy for "before the auction has happened" -- true today and false the moment a `RevertTo` rewinds into
 * SR2, or an auction fails to conclude, or a later variant moves it again. `private_auction_complete` is the
 * subject itself, so the two cannot come apart.
 * IT IS ALSO WHY THIS WORKS FOR THE STANDARD GAME UNCHANGED: there the auction concludes before Stock Round 1
 * exists, so the flag is already true by the time anybody can buy anything and this function never bites.
 *
 * "NOT TRADEABLE" RATHER THAN "NOT BUYABLE", which is the second refinement #904 asked for. A purchase is one
 * of three ways into the collision -- the par is a second and the bank pool a third -- and one condition that
 * every surface asks is what stops a half-applied gate. */
export function boIsLocked(
  variants: GameVariants,
  privateAuctionComplete: boolean | undefined,
): boolean {
  if (!variants.delayedAuction) return false;
  /* `undefined` READS AS COMPLETE, and the direction is deliberate. An absent flag means a log written before
     this field existed -- which is a standard game, whose auction did happen. Reading it as "incomplete" would
     lock the B&O for the whole of every historical game on replay. */
  return privateAuctionComplete === false;
}

/** The sentence every surface gives for that lock. One string, so the panel, the reducer and the log cannot
 *  come to explain the same refusal three ways. */
export const BO_LOCKED_REASON =
  "The B&O is not available yet. Its President's Certificate is the prize in the private company auction, which this table has delayed until the end of the Operating Round set in which the first 3-train is bought — the B&O cannot be parred, bought or sold until that auction concludes.";

/* ------------------------------------------------------------------ */
/* Unpredictable revenue -- design note #903                           */
/* ------------------------------------------------------------------ */

/* ==================================================================
 *  DESIGN NOTE 903: A DIE THAT CANNOT BE RE-ROLLED
 * ==================================================================
 *
 * REQUESTED: "every running train rolls a d6 modifying its printed route revenue: 1 (80%), 2 (90%), 3-4
 * (100%), 5 (110%), 6 (120%)" with "a deterministic RNG (e.g., seeded by the actionId or state hash) so the
 * event ledger replays identically on Undo or Refresh."
 *
 * THE `actionId` SEED WOULD HAVE BEEN AN EXPLOIT, and this is the substantive change from the request. Replay
 * is only half the requirement. A player who rolls a 1, presses Undo and runs the same train again produces a
 * NEW action with a NEW index -- so an action-seeded die hands them a fresh roll, and they can sit there
 * undoing until they get a 6. The ledger would replay identically and the game would still be broken.
 * SO THE SEED IS THE TURN, NOT THE ACTION: macro round, sub round, corporation, and the train's ordinal within
 * that turn. Undo and re-run the same train and the modifier is the one you already had. Re-route it through
 * different cities and the multiplier still stands -- which is correct, because the die is about the RAILWAY'S
 * luck that round, not about which hexes were chosen.
 * THE SAME KEY #653 AND #896 ALREADY USE, for the same reason both of them give: it is derived from game
 * state, so a rebuild reproduces it and a parallel local tally cannot drift from the log.
 *
 * THE TABLE IS MEAN-PRESERVING and that is worth stating because it is easy to break while "tuning":
 *   (80 + 90 + 100 + 100 + 110 + 120) / 6 = 100.
 * So this adds variance without inflating or deflating the economy over a game, and the bank still breaks on
 * roughly the schedule the length variant chose. A test pins the sum.
 *
 * NO FLOATING POINT ANYWHERE, per the project rule. The multiplier is an integer percentage and the arithmetic
 * is `(revenue * pct + 50) / 100` under integer division -- standard rounding, half away from zero, with no
 * `Math.round` on a float in sight. Revenue is non-negative here, so half-up and half-away-from-zero agree.
 *
 * See docs/ai_architecture/contract_economy.md, gameVariants.ts #903. */

/** The d6 face-to-percentage table, exactly as requested. Index 0 is face 1. */
export const REVENUE_MODIFIER_BY_FACE: readonly number[] = [80, 90, 100, 100, 110, 120];

/** What one train's die decided. */
export interface RevenueRoll {
  /** 1-6. */
  face: number;
  /** The integer percentage applied. */
  percent: number;
  /** Revenue before the die. */
  printed: number;
  /** Revenue after it. */
  adjusted: number;
}

/** Names one train's one roll. Everything in it is read off game state, so a rebuild reproduces it.
 *
 *  `trainOrdinal` IS THE TRAIN'S POSITION IN THIS TURN'S RUNS, not its model: a corporation running two
 *  4-trains must roll twice and may roll differently, and keying by model would give both the same face. */
export interface RevenueSeedParts {
  macroRound: number;
  subRound: number;
  companyId: number;
  trainOrdinal: number;
}

/** A 32-bit FNV-1a hash of the seed parts.
 *
 *  FNV-1a RATHER THAN A LIBRARY, and rather than anything clever: it is eight lines, it is exactly reproducible
 *  in Rust for Phase 5, and it has no state to carry between calls. A seeded PRNG object would be the usual
 *  reach here and would be wrong -- it would need to be advanced in a defined order across trains and
 *  corporations, which is a sequencing dependency the log does not have and replay would have to recreate.
 *  Hashing a coordinate instead means every roll is independent of every other one's timing.
 *  `>>> 0` AFTER EVERY STEP because JavaScript's bitwise operators produce SIGNED 32-bit values, and a
 *  negative accumulator would make the modulo below negative too. Phase 5's Rust version gets this for free
 *  with `u32`, which is the shape this is written to match. */
export function revenueSeedHash(parts: RevenueSeedParts): number {
  const key = `${parts.macroRound}.${parts.subRound}.${parts.companyId}.${parts.trainOrdinal}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    /* The FNV prime, 16777619, by shifts -- `hash * 16777619` overflows the 53-bit float mantissa and would
       silently lose the low bits, which is the one way this could differ from a Rust `wrapping_mul`.
       ==================================================================
        THE `+ hash` TERM IS NOT OPTIONAL, AND LEAVING IT OUT COST TWO FACES OF THE DIE
       ==================================================================
       16777619 is 0x01000193 = 2^24 + 2^8 + 2^7 + 2^4 + 2^1 + 2^0, and the first draft of this line had every
       term but the last. That makes the multiplier 16777618 -- an EVEN number -- so every product was even,
       every hash was even, and `hash % 6` could only ever return 0, 2 or 4. The die rolled 1, 3 and 5 and
       never 2, 4 or 6.
       NOTHING IN THE DIE'S OWN TESTS FAILED. "Only ever rolls a real d6" checks the range and 1/3/5 are in it;
       "mean-preserving" checks the TABLE, which was correct all along -- it was the sampling that could not
       reach half of it. The actual expected multiplier was (80+100+110)/3 = 96.7%, a silent 3% tax on every
       run in the game. It surfaced through an unrelated assertion about flavour text drawing on more than two
       lines, which is the argument for asserting distributions rather than ranges. */
    hash =
      (hash +
        ((hash << 1) >>> 0) +
        ((hash << 4) >>> 0) +
        ((hash << 7) >>> 0) +
        ((hash << 8) >>> 0) +
        ((hash << 24) >>> 0)) >>>
      0;
  }
  return hash >>> 0;
}

/** The face this train rolls, 1-6. */
export function revenueDieFace(parts: RevenueSeedParts): number {
  return (revenueSeedHash(parts) % 6) + 1;
}

/** `revenue * percent`, rounded half away from zero, in integers only -- see #903. */
export function applyRevenuePercent(revenue: number, percent: number): number {
  const scaled = revenue * percent;
  /* `Math.trunc` on an already-integer quotient, not `Math.round` on a float: `scaled` and the `+ 50` are both
     integers, so this division is the only place a fraction could appear and truncating it after adding half
     of the divisor IS the rounding. */
  return Math.trunc((scaled + 50) / 100);
}

/* ==================================================================
 *  DESIGN NOTE 907: WHAT THE DIE DID, IN WORDS
 * ==================================================================
 *
 * REQUESTED: "a battery of humorous ActivityLog lines to explain the modifiers (e.g., derailments for 80%,
 * making excellent time for 120%)."
 *
 * THE JOKE HAS A JOB, which is what keeps this from being decoration. A corporation that ran a $255 route and
 * banked $230 has a discrepancy on its chips, and without a sentence the player's first thought is that the
 * route tracer is broken -- this project has had that exact report twice (#702, #704). So every line names
 * the direction before it is funny, and the figures travel beside it.
 *
 * PICKED DETERMINISTICALLY, from the same seed as the face. A line chosen with `Math.random` would differ
 * between clients replaying one log and change under Undo -- the Activity Log is a shared record, and two
 * players reading different explanations of one event is worse than no explanation. The hash is already
 * computed; dividing it by six lifts a second independent choice out of the same number.
 *
 * NOTHING FOR A 100% FACE, deliberately. Two of the six faces change nothing, and a line saying "the trains
 * ran normally" on a third of all runs would train players to stop reading the log. */

const RUST_FREE_FLAVOUR: Readonly<Record<number, readonly string[]>> = {
  80: [
    "a derailment outside the yard limits ate most of the morning",
    "a washout on the mainline forced a long detour",
    "an axle failure stranded half the consist at a passing siding",
    "the dispatcher lost the timetable and nobody admitted it for hours",
  ],
  90: [
    "signal trouble held them at every junction",
    "a coal shortage meant slow running all day",
    "livestock on the line, twice",
    "the brakeman's brother-in-law rode free and told everyone",
  ],
  110: [
    "a clean run with a following wind",
    "the freight made its connection for once",
    "an unexpected excursion party filled the rear carriages",
    "the new fireman turned out to be worth every cent",
  ],
  120: [
    "making excellent time on every division",
    "a record run — the papers sent a photographer",
    "every signal green from end to end",
    "the timetable was rewritten that evening to match",
  ],
};

/** The sentence for one roll, or `null` when the die changed nothing. */
export function revenueFlavour(roll: RevenueRoll, parts: RevenueSeedParts): string | null {
  const lines = RUST_FREE_FLAVOUR[roll.percent];
  if (!lines || lines.length === 0) return null;
  /* A SECOND DRAW FROM THE SAME HASH. `% 6` chose the face; integer-dividing by 6 first discards those low
     bits so the line is not correlated with the face it is explaining -- which would show up as the same
     joke every time a corporation rolled a 1. */
  const line = lines[Math.floor(revenueSeedHash(parts) / 6) % lines.length];
  const direction = roll.percent < 100 ? "down" : "up";
  return `${roll.printed} → ${roll.adjusted} (${roll.percent}%, ${direction} on a ${roll.face}) — ${line}.`;
}

/** One train's roll, resolved. */
export function rollRouteRevenue(printed: number, parts: RevenueSeedParts): RevenueRoll {
  const face = revenueDieFace(parts);
  const percent = REVENUE_MODIFIER_BY_FACE[face - 1];
  return { face, percent, printed, adjusted: applyRevenuePercent(printed, percent) };
}
