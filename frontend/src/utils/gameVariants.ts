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

import { UNPREDICTABLE_REVENUE_FLAVOR } from "../constants/flavorText";

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
  /* Design note #977: "as printed" WITHOUT the number. `appNaming` #706's rule is that no player-facing
     string names 1830 -- this app is Project 18XX -- and the lobby copy batch put it back in two places
     while the case that forbids it was already red for an unrelated reason and so said nothing. The phrase
     still points at the same thing: "as printed" is what a player choosing a bank size needs, and the
     rulebook it refers to is named in the Rules Reference where the citation belongs. */
  standard: "$12,000 bank. The standard game, as printed.",
  long:
    "$20,000 bank. Runs well past the Diesels, with time for late corporations to matter.",
};

/* ==================================================================
 *  DESIGN NOTE 961: THE BLURBS LIVE WITH THE RULES, IN ONE COPY
 * ==================================================================
 *
 * ASKED: "we altered the way Unpredictable Revenue works, so our text description on the Lobby page likely
 * still needs updating."
 *
 * AND THERE WERE TWO DESCRIPTIONS TO UPDATE, WHICH HAD ALREADY DRIFTED. `Lobby.tsx` wrote them inline as JSX
 * and `SandboxWaitingRoom.tsx` kept its own `VARIANT_TOGGLES` table -- and the waiting room's Unpredictable
 * Revenue text carried a whole extra sentence about dividend rounding that the Lobby's did not. Two surfaces
 * describing one rule, already disagreeing, and nothing pointing that out.
 * SO THEY MOVE HERE, beside the rules they describe and beside `GAME_LENGTH_BLURB`, which has been doing
 * exactly this since #902. It is also #848's standing rule -- a component "writes no rules and no copy" --
 * applied to the one place in this feature that had escaped it.
 * AND THE STALENESS WAS INEVITABLE UNDER THE OLD ARRANGEMENT. Every batch since #903 has changed how this
 * variant works: per-train to per-turn (#941), the $10 rounding (#938), the flavour buckets (#944). A
 * description sitting two files away from the rule cannot survive that, and did not.
 *
 * THE NEW COPY IS DELIBERATELY NOT A SPECIFICATION. Requested: "Rather than explaining the math/system behind
 * it, it could be something more lighthearted." The Lobby is where a table decides what KIND of game to play,
 * which is a question about feel; the mechanism belongs in the Rules Reference, where a player goes having
 * already chosen. The two difficulty parentheticals do the work the old paragraphs were failing at. */
/* ==================================================================
 *  DESIGN NOTE 995: THE TWO THRESHOLDS ARE DELIBERATELY DIFFERENT
 * ==================================================================
 *
 * RULED: "The current symmetric 3x threshold is too forgiving for withholding. Introduce a deliberate
 * asymmetry strictly for the Dynamic Stock Market variant. Pay Out: keep 3x. Withhold: 2x."
 *
 * TWO CONSTANTS, TWO NAMES, AND THE RENAME IS THE POINT. There was one `DOUBLE_JUMP_MULTIPLE` serving both
 * arms, which was honest while the numbers agreed and becomes a trap the moment they do not: a name that
 * says "the threshold" invites the next reader to unify two figures that are different ON PURPOSE. Named for
 * their arms, neither can be mistaken for the other, and a diff that changes one shows exactly which.
 *
 * WHY THE ASYMMETRY IS THE WHOLE VARIANT AND NOT A TUNING KNOB. Dynamic Stock Market rewards a big payout by
 * moving the token further; #988 then found that withholding was free below the share price, and #994 gave
 * the withhold a matching ceiling. A SYMMETRIC pair leaves the two decisions balanced against each other,
 * which is what "too forgiving for withholding" names: a president banking a large run pays the same
 * marginal price as one banking a small one until the run is enormous. Dropping the withhold's bar to 2x
 * makes hoarding a large revenue bite sooner than paying it out rewards.
 *
 * NO THIRD RUNG. "There are no 3-cell drops; cap the maximum penalty at a 2-cell drop", ruled explicitly --
 * so both arms top out at two and the ladder has three rungs at most on the pay side (0, 1, 2) and two on
 * the withhold side (1, 2). */
export const PAY_DOUBLE_JUMP_MULTIPLE = 3;
export const WITHHOLD_DOUBLE_DROP_MULTIPLE = 2;

/* Design note #996: DECLARED ABOVE `VARIANT_COPY`, WHICH IS NOT TIDINESS. That record interpolates both
   figures into the Dynamic Stock Market blurb and is evaluated at module load -- so with these below it the
   two constants are in their temporal dead zone and the import throws a `ReferenceError` before the app
   renders anything at all. Caught by moving the copy, not by a test: every suite that imports this module
   would have failed at once, which is the loud kind of failure, but the ordering is a real constraint and is
   worth stating rather than leaving to look arbitrary. */

export type VariantCopyKey =
  | "unpredictableRevenue"
  | "dynamicStockMarket"
  | "gentleRust"
  | "delayedAuction";

/* ==================================================================
 *  DESIGN NOTE 961a: THE TITLES HAD DRIFTED TOO
 * ==================================================================
 *
 * CORRECTED: "for the parentheticals, I meant for you to add them on the titles, not on the descriptions...
 * so the title would read `Gentle rust (easier)` and `Delayed private auction (harder)`."
 *
 * AND GOING LOOKING FOR THE TITLES FOUND THE SAME FAULT ONE LEVEL UP. The Lobby's fourth toggle read "Delayed
 * auction" and the waiting room's read "Delayed private auction" -- one variant, two names, on the two screens
 * a table looks at before agreeing to it. #961 had just consolidated the blurbs and left the labels in the two
 * places they had always been, which is half a fix.
 * SO LABEL AND BLURB TRAVEL TOGETHER, in one record keyed by flag. They are one piece of copy about one rule
 * and there was never a reason to separate them; keeping them apart is exactly what let them disagree.
 *
 * THE QUALIFIER BELONGS ON THE TITLE, and the correction is right about why. A parenthetical mid-paragraph is
 * read after the decision; on the title it is read WITH the name, which is when a table is choosing. It also
 * shortens the blurbs back to describing the rule, which is all they were ever for. */
export const VARIANT_COPY: Readonly<Record<VariantCopyKey, { label: string; blurb: string }>> = {
  /* NO DIE AND NO PERCENTAGES TABLE -- and "up to" rather than a promise, because the roll can also land on
     no change at all, which the old text's "1 pays 80%, 6 pays 120%" implied was impossible.
     ==================================================================
      THE ROUNDING CLAUSE IS NOT DECORATION -- WITHOUT IT THE SENTENCE IS FALSE
     ==================================================================
     CORRECTED: "a corporation that runs for $80 with a 20% malus ends up only paying out $60, which is
     actually a -25%." Exactly so: $80 x 0.8 is $64, and #938 rounds that to $60.
     AND IT GOES FURTHER THAN THE ONE EXAMPLE, which is worth recording so nobody later trims the clause as
     redundant. The rounding moves a figure by up to $5 either way, so the smaller the printed run the larger
     the proportional swing: a $30 route at 80% pays $20, a full third less. It can also cancel the modifier
     outright -- a $20 route at 80% is $16, which rounds back to $20.
     THE SYMBOL IS U+00B1, not "+/-". The ASCII pair was a transcription of the request's own shorthand and
     survived into the shipped string; this file already carries em dashes, curly apostrophes and arrow
     glyphs, so there was never a reason for the fallback.
     SO THE CLAUSE IS DOING THE WORK OF THE MISSING PARAGRAPH. "±20%" describes the DIE; the payout is the
     die and then the rounding, and naming the second step is what stops the first from reading as a
     guarantee. It is also the honest short version: it says the mechanism exists without spending the
     Lobby's four lines on the arithmetic. */
  unpredictableRevenue: {
    label: "Unpredictable revenue",
    blurb:
      "Running railways is risky. In this variant, runs can produce up to ±20% their standard revenue, rounded to the nearest $10.",
  },
  /* ==================================================================
      DESIGN NOTE 996: THE LOBBY BLURB HAD GONE STALE TWICE OVER
     ==================================================================
     SUPPLIED: "Markets are volatile. Paying out 3x the share price triggers a double jump increase, but
     withholding 2x the share price will cause a double jump decrease."
     THE SENTENCE IT REPLACES WAS WRONG IN THREE PLACES, all of them acquired rather than original. "Twice the
     price moves it two cells" was true until #988 raised the pay's bar to three. It said nothing at all about
     the withhold, which #994 gave a threshold and #995 gave a lower one. And "punishes token payouts" is the
     old rule's flavour: under the current numbers a small payout does not move the token, which is not a
     punishment so much as a non-event.
     WHICH IS #982 HAPPENING AGAIN, IN THE SAME FILE, three batches later. That note is about the Gentle Rust
     blurb going stale when #979 reversed the rule under it, and it added a guard -- no blurb may say
     "train limit" -- narrow to that one rule because "a blurb describing a rule that lives in a reducer is
     not checkable from the string". The same is true here, and the same guard is now extended: the numbers in
     this sentence are checked against the two exported constants, which is the strongest join available
     short of generating the copy.
     THE SUPPLIED WORDING IS KEPT VERBATIM apart from the figures being interpolated. "Markets are volatile"
     is the feel a table is choosing (#961's rule for these blurbs: this is not a specification), and the two
     thresholds are the one mechanical fact a player cannot infer from the name. */
  dynamicStockMarket: {
    label: "Dynamic stock market",
    blurb:
      `Markets are volatile. Paying out ${PAY_DOUBLE_JUMP_MULTIPLE}x the share price triggers a double jump increase, but withholding ${WITHHOLD_DOUBLE_DROP_MULTIPLE}x the share price will cause a double jump decrease.`,
  },
  /* Design note #961a: the difficulty qualifiers moved to the LABELS above. A table choosing variants wants
     to know which way each one pushes as it reads the name, not three lines into the description. */
  /* ==================================================================
      DESIGN NOTE 982: THE LOBBY WAS STILL PROMISING #906's RULE
     ==================================================================
     RULED: "Just remove everything after 'before it goes.'"
     AND THE CLAUSE THAT GOES IS THE ONE #979 REVERSED -- "stops counting against the train limit the moment
     it is doomed, so its replacement can be bought straight away". That was true when this was written and
     has not been true since the train-limit correction; the modal's copy was fixed in the same batch (#980)
     and this sentence was missed, which is this project's signature fault in miniature: one authority
     updated, its sibling not asked.
     WORTH NAMING WHERE IT SURVIVED. `variantCopy.test.ts` asserts a great deal about these blurbs -- that
     they have one home, that the qualifiers ride on the labels, that Unpredictable Revenue's percentage is
     honest about its rounding -- and none of it could catch a sentence that describes a RULE, because the
     rule lives in a reducer this file cannot see. #746c already recorded the cost of exactly that: "The
     caption was accurate about the code as it then stood, which is precisely why a wrong rule reaches a
     player: the legend agreed with the bug."
     WHAT IS LEFT IS THE HALF THAT IS STILL TRUE, and it is also the half a table choosing variants needs:
     the train gets one more turn. How it interacts with the limit is a rule for the Rules Reference, and the
     modal says it at the moment it applies. */
  gentleRust: {
    label: "Gentle rust (easier)",
    blurb: "A rusting train gets one last Operating Round turn before it goes.",
  },
  delayedAuction: {
    label: "Delayed private auction (harder)",
    blurb:
      "The game opens on Stock Round 1 with no private companies; they are auctioned at the end of the Operating Round set in which the first 3-train is bought. Corporations must float on share capital alone until then, and the B&O cannot be traded until the auction concludes. Watch your cash carefully or your rivals might get the advantage!",
  },
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


/** How many cells the token moves on a dividend decision.
 *
 *  ==================================================================
 *   DESIGN NOTE 988: THE DECISION IS AN INPUT, AND LEAVING IT OUT WAS A REAL BUG
 *  ==================================================================
 *
 *  RULED: "Withholding revenue must now actively penalize the stock price. It should move the share price one
 *  space to the left (or down, if at a wall), perfectly mirroring the standard one-space right/up movement of
 *  a Pay Out."
 *
 *  IT ALREADY MOVED LEFT. `dividendStepFrom` has walked left-then-down on a withhold since #891. What it did
 *  not do was move ONE: this function had no idea which decision it was being asked about, and the shell
 *  handed its answer to BOTH projections. So under Dynamic Stock Market a withhold moved by the multiple the
 *  PAYOUT would have earned -- zero cells when the revenue was under the share price, and TWO when it was
 *  double. A corporation could withhold a small run and be punished not at all, or withhold a large one and
 *  be punished twice over.
 *
 *  AND THE TWO SURFACES ALREADY DISAGREED ABOUT IT, which is the part worth recording. `App.tsx`'s readout
 *  computed the withhold projection with a hard-coded one cell and said so in a comment -- "A WITHHOLD IS
 *  ALWAYS ONE CELL" -- while the reducer's `projectDividend` passed the pay-derived count to whichever choice
 *  arrived. The bar promised a one-cell drop and the board moved zero or two. That is #891 exactly, the note
 *  this function exists because of: "the bar promising a rise the board does not perform." A rule stated in a
 *  comment at one call site is not a rule.
 *
 *  SO THE CHOICE IS A REQUIRED ARGUMENT rather than a defaulted one. A default would let a caller keep
 *  forgetting to say which decision it means, which is the entire bug -- and there is no answer that is safe
 *  to assume, since the two arms differ in exactly the case the variant is about. */
export function dividendStepsFor(
  payout: number,
  sharePrice: number | null | undefined,
  variants: GameVariants,
  choice: "pay" | "withhold",
): number {
  // Standard rules: any dividend decision moves exactly one cell, whatever it was worth.
  if (!variants.dynamicStockMarket) return 1;

  /* Read once, so the two arms cannot come to disagree about what an unreadable price or a zero payout is.
     `null` is "the chain did not say", which #232 keeps distinct from zero -- and a price of zero is treated
     as unreadable rather than as a divisor, because every payout is infinitely many times nothing. */
  const price =
    sharePrice == null || !Number.isFinite(sharePrice) || sharePrice <= 0 ? null : sharePrice;
  const earned = Number.isFinite(payout) && payout > 0 ? payout : 0;

  /* ==================================================================
      DESIGN NOTE 994: THE WITHHOLD SCALES TOO, AND ITS FLOOR IS WHAT KEEPS IT A PENALTY
     ==================================================================
     RULED: "Implement a dynamic Withholding penalty that mirrors the new Pay Out double-jump. If a
     corporation Withholds revenue that is >= 3x the current share price, the stock must drop by 2 cells."
     THIS IS NOT #988's BUG COMING BACK, and the difference is the FLOOR rather than the ceiling. Before #988
     a withhold took the pay's whole ladder, including its bottom rung -- so a run under the share price moved
     the token NOTHING and withholding a small revenue was free. The rule now has two rungs and no zero: one
     cell always, two when the run is large. A corporation can never withhold without paying for it.
     AND THE ASYMMETRY WITH THE PAY ARM IS THE POINT OF THE VARIANT. A pay can move zero cells (the run did
     not cover the price); a withhold cannot. Written as two arms rather than one shared ladder with a
     `Math.max(1, ...)`, because the arms differ in their floor AND in what a missing price means, and one
     expression covering both is how #988's bug was possible in the first place.
     AN UNREADABLE PRICE FALLS TO ONE, not two: the same direction the pay arm falls, and the conservative
     answer when the board cannot say what a multiple would even be. */
  if (choice === "withhold") {
    /* Design note #995: TWO TIMES, not three. The withhold's bar is deliberately lower than the pay's -- see
       the constants for why the asymmetry is the variant rather than a tuning choice -- and it is capped
       here at two cells because the ruling says so in as many words: "There are no 3-cell drops." */
    if (price !== null && earned >= price * WITHHOLD_DOUBLE_DROP_MULTIPLE) return 2;
    return 1;
  }

  if (earned <= 0) return 0;
  if (price === null) return 1;
  if (earned >= price * PAY_DOUBLE_JUMP_MULTIPLE) return 2;
  if (earned >= price) return 1;
  return 0;
}

/* ==================================================================
 *  DESIGN NOTE 998: `dividendStepsExplanation` IS DELETED
 * ==================================================================
 *
 * #908 BUILT IT AS "the sentence for the action bar, so a player can see WHY the token is about to move two
 * cells -- or none", and no caller was ever written. #997 finally wired it, on instruction, into a footer
 * beneath the two dividend columns. ASKED IMMEDIATELY AFTER: "can we actually just indicate this on the
 * Market Move line? ... Maybe we replace both with (double move)?"
 *
 * SO IT LASTED ONE BATCH AS RENDERED CODE, and the marker is better for the reason #509a already gives about
 * this panel: "SHOW THE MONEY MOVING, DO NOT DESCRIBE IT." The figures on the Market Move line state the
 * outcome; a paragraph underneath explaining the arithmetic behind them is one layer of prose too many, and
 * the one fact it carried that the figures do not -- "this move is twice the usual" -- is two words.
 *
 * DELETED RATHER THAN LEFT EXPORTED AND UNCALLED, which is the state it spent its whole life in and the
 * reason nobody noticed: it had a passing suite, so it read as a working feature with a caller somewhere.
 * That is #990's rule for `noticeConsequence`, applied to the function I had just finished defending -- and
 * it would be inconsistent to knowingly recreate the exact fault I flagged two batches ago.
 *
 * WHAT IT WOULD BE GOOD FOR, if it is ever wanted back: the Rules Reference, where a player goes to read a
 * rule rather than to make a decision. `git` has the sentences. */


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

/** The footer a locked corporation card carries.
 *
 *  ==================================================================
 *   DESIGN NOTE 948: THE CARD SAYS WHY, INSTEAD OF A BUTTON REFUSING
 *  ==================================================================
 *
 *  REPORTED: "Currently, the B&O corporation card is clickable/expandable, but the 'Buy' button is greyed out
 *  with a tooltip. This is a false affordance."
 *
 *  SHORTER THAN `BO_LOCKED_REASON`, DELIBERATELY, and both survive. That one is a refusal sentence: it fires
 *  when a player has tried something and is owed the whole rule. This is a standing label on a card nobody has
 *  touched yet, read at a glance beside seven cards that are live -- and the full paragraph at that size is a
 *  wall a player skips.
 *  WRITTEN HERE RATHER THAN IN THE PANEL, per #848: the component "writes no rules and no copy". The rule that
 *  makes the card dead and the sentence explaining it belong in one file, or they drift.
 *  "BO" WITHOUT THE AMPERSAND, exactly as specified -- and #364's own note records the same choice for the map
 *  badges, so the two surfaces agree by accident rather than by coordination. Worth stating so a later tidy-up
 *  does not "fix" one of them. */
export const BO_LOCKED_CARD_NOTE =
  "Inactive until the BO private company is purchased in the Auction Round.";

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
  /* ==================================================================
      DESIGN NOTE 941: `trainOrdinal` IS GONE, AND THE SEED IS THE TURN
     ==================================================================
     REPORTED: "Your logic for applying the modifier per run has created a UX nightmare where a 4-train
     corporation forces the player to sit through 8 seconds of consecutive UI flashes (+10%, -20%, etc.), with
     no clear idea of which modifier applies to which train."
     RULED: "The Unpredictable Revenue die must be rolled exactly ONCE per corporation's operating turn,
     applied to the total aggregated printed revenue of all trains combined ... scope the RNG seed to the turn
     identity (e.g., Round, Sub-round, Corp)."
     WHAT #903 GOT WRONG, STATED PLAINLY. That note argued the ordinal in on solid grounds -- "a corporation
     running two 4-trains rolls twice and may roll differently, and keying by model would give both the same
     face" -- and every word of it is correct about the mechanism it was building. It was answering the wrong
     question: whether two trains should share a face, rather than whether two trains should produce two
     events at all. The right unit is the TURN, because that is the unit the player experiences and the unit
     the dividend is paid on.
     REMOVING THE FIELD RATHER THAN PASSING ZERO. A seed part that every caller sets to the same value is a
     parameter that has stopped meaning anything, and leaving it would let a future caller reintroduce
     per-train rolls without touching a line of rules code. The turn is the identity now, and the type says so.
     THE HASH IS UNCHANGED, so a given turn's face is whatever the FNV of those three parts always was. Games
     logged before this batch replay to different figures than they were played at -- unavoidable when the
     seeding unit changes, and worth stating rather than discovering. */
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
  /* Design note #941: THREE PARTS, NOT FOUR. The train ordinal left the seed when the die became a
     once-per-turn roll -- see `RevenueSeedParts`. The key's SHAPE changed with it, so a turn's face today is
     not the face the same turn produced before this batch; that is inherent in re-scoping the seed and is
     recorded rather than papered over with a padding field. */
  const key = `${parts.macroRound}.${parts.subRound}.${parts.companyId}`;
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
 *  DESIGN NOTE 944: WHAT THE DIE DID, IN WORDS -- 120 OF THEM
 * ==================================================================
 *
 * #907 BUILT THIS WITH FOUR LINES PER PERCENTAGE, keyed by `percent` (80/90/110/120) and returning `null` on
 * a 100 face. That table is gone; the supplied 120-line payload replaces it, and the keying changed with it.
 *
 * KEYED BY OUTCOME, NOT BY PERCENTAGE, and the author's reason is the one that matters: "Because your base-10
 * rounding logic occasionally swallows a 10% modifier and returns the payout to 100%, we cannot map the flavor
 * text strictly to the raw die face. We must map it to the effective outcome." A $50 turn at 90% pays $45,
 * rounds back to $50, and a line about evaporating fares would be explaining a loss that did not happen.
 * #938'S `revenueOutcome` IS THAT PREDICATE and is asked here rather than re-derived.
 *
 * THE FACE STILL CHOOSES BETWEEN THE TWO BUCKETS ON EACH SIDE, because "minor" and "critical" are about
 * MAGNITUDE and the outcome only carries direction. Faces 5 and 6 are the two bonuses, 2 and 1 the two
 * maluses -- exactly as specified.
 *
 * AND THERE IS NO LONGER A `null` CASE. #907 deliberately said nothing on a 100 face, reasoning that a line
 * on a third of all runs "would train players to stop reading the log". The `unchanged` bucket overrules that:
 * twenty distinct lines about an ordinary day are not the same thing as one repeated one, and the variant
 * having said SOMETHING every turn is what stops a swallowed modifier reading as a broken feature -- which is
 * the report that started this whole thread.
 *
 * PICKED DETERMINISTICALLY, from the same hash as the face, which #907 argued and this keeps: a line chosen
 * with `Math.random` would differ between clients replaying one log and change under Undo. */

/** Which bucket of the payload a resolved roll draws from.
 *
 *  THE FIVE CASES ARE THE FIVE THAT WERE SPECIFIED, and they are exhaustive against today's modifier table --
 *  only faces 5 and 6 exceed 100, only 1 and 2 fall below it. That exhaustiveness is a fact about
 *  `REVENUE_MODIFIER_BY_FACE`, not a guarantee of this function, so a face that moved the figure without being
 *  one of those four falls back to `unchanged` rather than indexing `undefined` into the Activity Log. If that
 *  fallback ever fires, the table and this selector have come apart, and the case named for it will say so. */
export type FlavorBucket = keyof typeof UNPREDICTABLE_REVENUE_FLAVOR;

export function flavorBucketFor(roll: RevenueRoll): FlavorBucket {
  const outcome = revenueOutcome(roll);
  if (outcome === "bonus") {
    if (roll.face === 6) return "criticalBonus";
    if (roll.face === 5) return "minorBonus";
    return "unchanged";
  }
  if (outcome === "malus") {
    if (roll.face === 1) return "criticalMalus";
    if (roll.face === 2) return "minorMalus";
    return "unchanged";
  }
  return "unchanged";
}

/** The line itself, drawn from the bucket by the turn's own seed.
 *
 *  ==================================================================
 *   DESIGN NOTE 969: THE HASH IS DIVIDED BY SIX BEFORE IT PICKS A LINE
 *  ==================================================================
 *
 *  #944 SPECIFIED `seed % length` AND FLAGGED THE HAZARD IN THE SAME BREATH: the face is `hash % 6` and the
 *  index came off the same number, so the two are not independent. That note's reachability case measured it
 *  rather than assuming, found all 120 lines reachable, and left the rule as written.
 *  AT 245 LINES IT BITES. `gcd(6, 50) = 2`, so a fixed die face pins `hash % 50` to a single parity class and
 *  exactly HALF of each 50-line bucket becomes unreachable -- measured at 25 of 50 on every modifier bucket
 *  and 30 of 45 on `unchanged`. At 25 it happened not to bite, because `gcd(6, 25) = 1`. The rule was correct
 *  for one payload size and silently wrong for the next.
 *
 *  DIVIDING BY SIX FIRST IS #907'S OWN FIX, restored. Its words: "integer-dividing by 6 first discards those
 *  low bits so the line is not correlated with the face it is explaining." #944 dropped it in favour of the
 *  specified `% 25`, which was right about the modulus and wrong about which number to take it of. Measured
 *  at 50/50, 50/50, 45/45, 50/50, 50/50.
 *
 *  THE MODULUS IS STILL THE ARRAY'S OWN LENGTH, which is the half of #944 that held up: adding these 125
 *  lines needed no arithmetic change, only this decorrelation.
 *
 *  A GIVEN TURN NOW DRAWS A DIFFERENT LINE than it did before this change -- cosmetic only, and it does not
 *  touch a figure. Replay stability within a build is what #903 requires, and that is unaffected. */
export function revenueFlavourClause(roll: RevenueRoll, parts: RevenueSeedParts): string {
  const bucket = flavorBucketFor(roll);
  const lines = UNPREDICTABLE_REVENUE_FLAVOR[bucket];
  return lines[Math.floor(revenueSeedHash(parts) / 6) % lines.length];
}

/* ==================================================================
 *  DESIGN NOTE 938: THE VARIANT PAYS IN TENS
 * ==================================================================
 *
 * RULED: "Instead of rounding the per-player share, round the total modified route revenue to the nearest $10
 * before any dividend math or log output occurs. This forces the variant's output back into a clean multiple
 * of 10, resolving all per-share fractional issues natively."
 *
 * AND IT RESOLVES THEM COMPLETELY, not approximately, which is worth showing rather than asserting. 1830's
 * holdings are all multiples of 10%, and `dividendSplit` pays `floor((revenue * pct + 50) / 100)`. With
 * `revenue = 10k` and `pct = 10m`, that quotient is `k * m` exactly -- an integer before the rounding term
 * ever matters. So every split becomes exact, the ten certificates of a sold-out corporation sum to precisely
 * what it earned, and #922's $3 overpayment cannot arise at all rather than being made smaller.
 *
 * ROUNDED PER RUN, NOT PER TURN, AND THAT IS A CHOICE WORTH NAMING. "The total modified route revenue" admits
 * two readings: round each train's figure as it is banked, or bank the raw figures and round the turn's sum.
 * Both make the DIVIDEND a multiple of ten. Only the first makes the Activity Log's per-train lines add up to
 * it -- under the second, a turn of three runs would print three unrounded figures beside a rounded total,
 * which is the "two surfaces answering one question two ways" fault this project keeps finding. The per-run
 * reading also makes the ROUNDING deterministic per train, so an Undo that replays the log reaches the same
 * figures; a turn-level round would depend on how many trains had been replayed so far.
 *
 * AND IT IS WHAT ITEMS 2 AND 3 REQUIRE ANYWAY: both the new log sentence and the floating modifier ask
 * "did THIS run's payout actually change", which is a question about one run.
 *
 * INTEGERS THROUGHOUT. `value + 5` and the division are the whole of it; `Math.floor` on the quotient is the
 * rounding, exactly as `applyRevenuePercent` does it one step earlier. */
export function roundToTen(value: number): number {
  return Math.floor((value + 5) / 10) * 10;
}

/** Whether a roll's payout ended up above, below, or exactly at the printed figure.
 *
 *  ==================================================================
 *   DESIGN NOTE 938: THE ONE ANSWER TO "DID THE DIE ACTUALLY MATTER"
 *  ==================================================================
 *
 *  RULED, for the log: "completely ignoring the die if the rounding swallowed the modifier". And for the
 *  overlay: "Do not show it if a 110% or 90% roll was mathematically rounded away."
 *
 *  THAT IS ONE PREDICATE SERVING TWO SURFACES, so it is written once. A $50 run at 90% is $45, which rounds
 *  back to $50 -- the die fired, the percentage was real, and the corporation received exactly what the board
 *  printed. Both surfaces must agree that nothing happened, and the only way they cannot drift is to ask the
 *  same function.
 *
 *  ASKED OF THE FIGURES, NOT OF THE PERCENT. `percent !== 100` is the tempting test and it is the bug: it is
 *  true for a swallowed 90% and would put a "-10% malus" on a run that lost nothing. */
export type RevenueOutcome = "bonus" | "malus" | "normal";

export function revenueOutcome(roll: RevenueRoll): RevenueOutcome {
  if (roll.adjusted > roll.printed) return "bonus";
  if (roll.adjusted < roll.printed) return "malus";
  return "normal";
}

/** The die's nominal swing, as a signed whole percentage -- `+20`, `-10`, `0`.
 *
 *  THE NOMINAL SWING, NOT THE EFFECTIVE ONE. After rounding, a 110% roll on $70 pays $80, an effective
 *  +14.3% -- a fraction, on a variant whose entire point is to avoid them, and a number no player could
 *  reconcile with anything. The die's own figure is round, is what the flavour line explains, and is what the
 *  overlay was specified to flash. */
export function revenueDeltaPercent(roll: RevenueRoll): number {
  return roll.percent - 100;
}

/** The Activity Log's one sentence for a corporation's whole turn of running.
 *
 *  ==================================================================
 *   DESIGN NOTE 941: ONE LINE FOR ONE TURN, AND #939'S STRINGS MOVED INTO IT
 *  ==================================================================
 *
 *  RULED: "The Activity Log should likewise produce a single consolidated line for the total payout."
 *
 *  #939 PUT THESE THREE SENTENCES ON THE PER-ROUTE LINE, which was right when the die was per-route and is
 *  wrong now that it is per turn: a four-train corporation would have printed four bonus sentences about one
 *  roll. The strings are unchanged and their location is not -- they describe a TURN, so they belong on a
 *  sentence about the turn.
 *
 *  AND THE PER-ROUTE LINE GOES BACK TO BEING FACTUAL: "B&O ran a $70 route through F2 -> A9." It names which
 *  track was run, which is the thing only it can say, and makes no claim about the die.
 *
 *  BUILT HERE RATHER THAN IN `actionLog`, because the shell raises this line (the reducer cannot see the end
 *  of the dispatch loop) and `actionLog` describes single messages. One implementation either way.
 *
 *  THE PERCENTAGE NAMED IS THE DIE'S NOMINAL SWING -- #938 records why: after rounding, a 110% roll on a $70
 *  turn is an effective +14.3%, and a fraction is what this variant exists not to produce. */
export function turnRevenueSentence(
  ticker: string,
  roll: RevenueRoll,
  parts: RevenueSeedParts,
): string {
  const clause = revenueFlavourClause(roll, parts);
  const opening = `${ticker} ran for $${roll.adjusted}.`;
  const outcome = revenueOutcome(roll);
  /* ==================================================================
      DESIGN NOTE 944: THE FIVE SENTENCES, EXACTLY AS SPECIFIED
     ==================================================================
     THE `unchanged` LINES ARE WHOLE SENTENCES of their own -- "Nothing unexpected happens. The accountants are
     suspicious." -- so that branch appends rather than completing a clause. The other four are subordinate
     clauses beginning lower-case, which is why they are joined with "because".
     #941'S "had a normal run for $X" IS SUPERSEDED. It was one sentence saying nothing twenty different ways
     could now say, and the specified format drops it.
     THE PERCENTAGE IS DERIVED, NOT TYPED. The spec pairs face 5 with "10%" and face 6 with "20%", which is
     exactly `|percent - 100|` on today's table -- so it is computed from the roll rather than written beside
     each branch, and a case in `flavorText.test.ts` asserts the derived figure matches the bucket the same
     face selects. Two hand-written constants that must agree is how a 20% bonus comes to be announced as 10%. */
  if (outcome === "normal") return `${opening} ${clause}`;
  const swing = Math.abs(revenueDeltaPercent(roll));
  const verb = outcome === "bonus" ? "enjoyed" : "suffered";
  const noun = outcome === "bonus" ? "bonus" : "malus";
  /* ==================================================================
      DESIGN NOTE 949: THE RESULT AND THE JOKE ARE TWO SENTENCES
     ==================================================================
     REPORTED: "a bit too clunky as a single run-on sentence. We need to separate the mechanical result from
     the flavor text."
     AND THE TWO HALVES ANSWER DIFFERENT QUESTIONS, which is why splitting them reads better rather than just
     shorter. "It suffered a 10% malus" is the fact a player needs to reconcile the figure on their chips;
     the line after it is colour. Subordinating the first to the second with "because" made the mechanical
     half read as a preamble to a joke -- and #907's whole argument for having flavour at all was that the
     joke has a JOB, which it cannot do while it is grammatically the point of the sentence.
     THE PAYLOAD MOVED WITH THE JOIN. All 100 lines in the four modifier buckets are capitalised now, because
     they are standalone sentences rather than clauses. `unchanged` was already sentence-cased and is
     untouched -- its branch never used "because" and did not change. */
  return `${opening} It ${verb} a ${swing}% ${noun}. ${clause}`;
}

/** The turn's one roll, resolved against the aggregated printed revenue of every train that ran.
 *
 *  Design note #938: `adjusted` is the FINAL figure -- percentage applied, then rounded to the nearest ten.
 *  Rounding here rather than at the call sites is what makes it impossible for the reducer to bank one number
 *  while the log reports another: there is only one `adjusted`, and everything reads it.
 *
 *  Design note #941: `printed` IS NOW A TURN TOTAL, not one train's route. The function is unchanged --
 *  a percentage and a rounding do not care what they are given -- but every caller had to move, and the name
 *  kept saying "route". Callers pass the sum; the reducer keeps the sum so it can re-apply on each train. */
export function rollTurnRevenue(printed: number, parts: RevenueSeedParts): RevenueRoll {
  const face = revenueDieFace(parts);
  const percent = REVENUE_MODIFIER_BY_FACE[face - 1];
  return {
    face,
    percent,
    printed,
    adjusted: roundToTen(applyRevenuePercent(printed, percent)),
  };
}
