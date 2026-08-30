/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 902 / 903 (harness): THE HOUSE RULES, AND THE DIE THAT CANNOT BE RE-ROLLED
// ==================================================================
//
// REQUESTED: bank-size variants, and "every running train rolls a d6 modifying its printed route revenue"
// under "a deterministic RNG (e.g., seeded by the actionId or state hash) so the event ledger replays
// identically on Undo or Refresh."
//
// THE REQUEST'S OWN SEED SUGGESTION WOULD HAVE BEEN AN EXPLOIT, and the case that proves it is the first one
// in the die section below. Replaying identically is only half of what determinism has to buy here: a player
// who undoes a bad run and re-runs it produces a NEW action with a NEW index, so an action-seeded die hands
// them a fresh face. The ledger replays perfectly and the player rolls until they get a 6.
//
// SO THE SEED IS THE TURN, and these cases pin that: same turn, same corporation, same train ordinal, same
// face -- however many times the run is dispatched.
//
// AND THE TABLE IS MEAN-PRESERVING, which is pinned because it is the kind of property that gets broken while
// somebody is "tuning the feel" and nothing visibly fails for several games.

import {
  applyRevenuePercent,
  bankStartFor,
  BANK_SIZE_BY_LENGTH,
  hasAnyVariant,
  resolveVariants,
  REVENUE_MODIFIER_BY_FACE,
  revenueDieFace,
  rollTurnRevenue,
  roundToTen,
  STANDARD_VARIANTS,
  type GameVariants,
  legacyTurnSeed,
} from "./gameVariants";

/* ==================================================================
    DESIGN NOTE 1051 (harness): THESE FIXTURES ASK FOR THE OLD DIE ON PURPOSE
   ==================================================================
   THE TURN CARRIES ITS OWN DRAW NOW -- `turnSeed`, a real random integer recorded in the log -- and every
   assertion in this file was written against the FNV die: specific faces, specific lines, specific spreads.
   Handing them `legacyTurnSeed` keeps each one measuring exactly what it was written to measure.
   AND THAT PATH IS STILL LIVE, which is why this is a migration rather than a museum. A game logged before
   #1051 replays through `legacyTurnSeed` in the reducer, so everything below still guards a code path a real
   client reaches -- it has simply stopped being the path a NEW turn takes.
   THE NEW CLAIM IS `batch50.test.ts`'s: that the same extraction behaves over a uniform draw. Retrofitting it
   here would have meant rewriting cases whose subject is the hash. */
const seedFor = (macroRound: number, subRound: number, companyId: number) => ({
  macroRound,
  subRound,
  companyId,
  turnSeed: legacyTurnSeed(macroRound, subRound, companyId),
});

import { applySandboxAction } from "./sandboxSession";
import { dealSandboxGame } from "./gameSetup";
import type { GameStateResponse } from "./gameState";

describe("the config a game with no config reads as (design note #902)", () => {
  it("is the standard game", () => {
    /* THE PROPERTY EVERY OLD LOG DEPENDS ON. Every game logged before variants existed carries no config, and
       must still replay as 1830 -- not as a game with four `undefined` rules. */
    expect(resolveVariants(undefined)).toEqual(STANDARD_VARIANTS);
    expect(resolveVariants(null)).toEqual(STANDARD_VARIANTS);
    expect(resolveVariants({})).toEqual(STANDARD_VARIANTS);
  });

  it("fills gaps field by field rather than substituting the whole default", () => {
    /* THE CASE THAT DISTINGUISHES the two implementations, and the reason the source does not write
       `recorded ?? STANDARD_VARIANTS`. A log written by a build that had `length` but not `gentleRust` records
       a PARTIAL config; swapping the whole default in would throw away the length it did record. */
    const partial = { length: "short" } as Partial<GameVariants>;
    expect(resolveVariants(partial).length).toBe("short");
    expect(resolveVariants(partial).gentleRust).toBe(false);
  });

  it("falls back rather than throwing on a length it has never heard of", () => {
    /* AN OLDER CLIENT REPLAYING A NEWER LOG. It should price the bank wrongly -- which is visible on the
       ledger and diagnosable -- rather than fail to load, which from the table looks like the room is broken. */
    const future = { length: "epic" } as unknown as Partial<GameVariants>;
    expect(resolveVariants(future).length).toBe("standard");
  });

  it("knows when a table is playing something other than 1830", () => {
    expect(hasAnyVariant(STANDARD_VARIANTS)).toBe(false);
    expect(hasAnyVariant({ ...STANDARD_VARIANTS, length: "short" })).toBe(true);
    expect(hasAnyVariant({ ...STANDARD_VARIANTS, unpredictableRevenue: true })).toBe(true);
    // The two declared-but-inert flags still count: the badge is about what the table AGREED, not about what
    // this build has got round to implementing.
    expect(hasAnyVariant({ ...STANDARD_VARIANTS, gentleRust: true })).toBe(true);
    expect(hasAnyVariant({ ...STANDARD_VARIANTS, delayedAuction: true })).toBe(true);
  });
});

describe("the bank is the clock (design note #902)", () => {
  it("carries the three requested figures", () => {
    expect(BANK_SIZE_BY_LENGTH.short).toBe(4500);
    expect(BANK_SIZE_BY_LENGTH.standard).toBe(12000);
    expect(BANK_SIZE_BY_LENGTH.long).toBe(20000);
  });

  it("still covers the largest table's deal on the short bank", () => {
    /* THE ONE WAY A SHORT GAME COULD BE UNDEALABLE. Six players take $400 each; if the short bank could not
       cover $2,400 the game would open with a bank already broken, which #898 would then end at the first OR
       set boundary -- a two-minute game and no error anywhere explaining it. */
    expect(BANK_SIZE_BY_LENGTH.short).toBeGreaterThan(400 * 6);
  });

  it("prices a game from its own variant", () => {
    expect(bankStartFor({ ...STANDARD_VARIANTS, length: "short" })).toBe(4500);
    expect(bankStartFor(STANDARD_VARIANTS)).toBe(12000);
  });

  it("actually deals from the chosen bank", () => {
    /* ==================================================================
        THE INTEGRATION HALF, ADDED BECAUSE A CONTROL WALKED STRAIGHT PAST THE REST
       ==================================================================
       `bankStartFor` being correct proves nothing about `dealSandboxGame` calling it. A negative control that
       replaced the deal's `bankStartFor(variants)` with the standard constant left every case in this file
       passing -- the same shape as the revenue case further down, and missed here on the first pass.
       BOTH FIGURES, because they are two different claims: what the bank STARTED with (which the ledger's
       gauge measures against) and what is LEFT after four players are dealt $600 each. A fix that carried the
       variant into one and not the other would show a full gauge over an empty bank. */
    const players = ["a", "b", "c", "d"].map((id) => ({ id, nickname: id }));
    const short = dealSandboxGame({ players, variants: { length: "short" } });
    expect(short?.bankStart).toBe(4500);
    expect(short?.bankRemaining).toBe(4500 - 600 * 4);

    const standard = dealSandboxGame({ players });
    expect(standard?.bankStart).toBe(12000);

    /* AND THE DEAL ITSELF IS UNCHANGED. The length variant is the clock, not the opening -- cutting what
       players are dealt as well would be a second variant nobody asked for. */
    expect(short?.startingCash).toBe(standard?.startingCash);
    expect(short?.certLimit).toBe(standard?.certLimit);
  });
});

describe("the d6 cannot be re-rolled (design note #903)", () => {
  const turn = seedFor(3, 1, 6);

  it("gives the same face for the same turn, corporation and train", () => {
    /* ==================================================================
        THE ASSERTION THE WHOLE SEED DESIGN EXISTS FOR -- AND ITS FIRST DRAFT WAS ALMOST USELESS
       ==================================================================
       Undo the run and re-run it: the second dispatch must compute what the first one did. An action-seeded
       die -- the request's own suggestion -- fails this.
       IT DID NOT FAIL IT. The first version of this case was a SINGLE comparison,
       `expect(revenueDieFace(turn)).toBe(revenueDieFace({ ...turn }))`, and the negative control that replaced
       the seed with a per-call counter PASSED: two consecutive counter values landed on the same face by
       chance, which happens one time in six. A test of the most important property in this file that a broken
       implementation slips past 17% of the time is barely a test at all.
       SO IT IS ASSERTED OVER A SPREAD. Forty distinct turns, each rolled twice, every pair required to match:
       a counter-seeded die would have to collide forty times running, which is (1/6)^40. The cost is nothing
       and the difference is between a property and a coin flip. */
    const seeds = Array.from({ length: 40 }, (_, at) =>
      seedFor(1 + (at % 7), 1 + (at % 2), 1 + (at % 8)),
    );
    const firstPass = seeds.map(revenueDieFace);
    const secondPass = seeds.map(revenueDieFace);
    expect(secondPass).toEqual(firstPass);
    /* AND INTERLEAVED, because a counter advanced once per CALL and a seed read once per TURN also differ in
       whether an unrelated roll in between disturbs the answer -- which is what a real turn looks like, with
       other corporations rolling between this corporation's two runs. */
    expect(revenueDieFace(seeds[0])).toBe(firstPass[0]);
  });

  it("gives every train on a turn the SAME face (design note #941)", () => {
    /* ==================================================================
        SUPERSEDED BY #941, AND THE OLD CASE IS RECORDED RATHER THAN DELETED
       ==================================================================
       THIS USED TO ASSERT THE OPPOSITE -- "gives each train on a turn its own face to draw from" -- on #903's
       reasoning that "two 4-trains are two runs. Keying by train MODEL would hand both the same face, which
       is why the seed carries an ORDINAL." It checked that a spread of ordinals produced more than one face:
           const spread = new Set(Array.from({ length: 12 }, (_, at) =>
             revenueDieFace({ ...turn, trainOrdinal: at })));
           expect(spread.size).toBeGreaterThan(1);
       THE MECHANISM WAS CORRECT AND THE UNIT WAS WRONG. Reported: "a 4-train corporation forces the player to
       sit through 8 seconds of consecutive UI flashes (+10%, -20%, etc.), with no clear idea of which
       modifier applies to which train." Four independent faces is precisely what that describes. The die is
       now rolled once per TURN and applied to the aggregated printed revenue, so the ordinal has left the
       seed entirely.
       WHAT IS ASSERTED NOW is that the turn is the whole identity: nothing about how many trains ran, or in
       what order, can reach the hash. Driven through the public seed type, so a reintroduced ordinal field
       would fail to compile here rather than quietly re-splitting the roll. */
    const face = revenueDieFace(turn);
    expect([face, face >= 1 && face <= 6]).toEqual([face, true]);
    /* CALLED AS MANY TIMES AS A FOUR-TRAIN TURN WOULD, and every answer identical -- which is the whole of
       "exactly ONCE per corporation's operating turn" as the seed can express it. */
    const everyTrain = new Set(Array.from({ length: 8 }, () => revenueDieFace(turn)));
    expect(everyTrain.size).toBe(1);
  });

  it("separates corporations and turns", () => {
    /* Each of the four seed parts must reach the hash. A spread over each one, for the same reason as above:
       individual collisions are legal, a constant is not. */
    const overCompanies = new Set(
      Array.from({ length: 12 }, (_, at) => revenueDieFace(seedFor(3, 1, at + 1))),
    );
    const overRounds = new Set(
      Array.from({ length: 12 }, (_, at) => revenueDieFace(seedFor(at + 1, 1, 6))),
    );
    const overSubRounds = new Set(
      Array.from({ length: 12 }, (_, at) => revenueDieFace(seedFor(3, at + 1, 6))),
    );
    expect(overCompanies.size).toBeGreaterThan(1);
    expect(overRounds.size).toBeGreaterThan(1);
    expect(overSubRounds.size).toBeGreaterThan(1);
  });

  it("can actually roll all six faces", () => {
    /* ==================================================================
        THE ASSERTION THAT WAS MISSING, AND WHAT IT COST
       ==================================================================
       The first version of `revenueSeedHash` decomposed the FNV prime as 2^24+2^8+2^7+2^4+2^1 and dropped the
       2^0 term -- so the multiplier was EVEN, every hash was even, and `% 6` could only return 0, 2 or 4. The
       die rolled 1, 3 and 5 for the entire game and never 2, 4 or 6.
       EVERY OTHER CASE IN THIS FILE PASSED. The range check below is satisfied by {1,3,5}; the mean-preserving
       check tests the TABLE, which was right all along -- it was the SAMPLING that could not reach half of it.
       The real expected multiplier was (80+100+110)/3 = 96.7%: a silent 3% tax on every run in the game,
       invisible to a suite that only ever asked whether a face was between 1 and 6.
       SO THIS ASKS ABOUT THE DISTRIBUTION. Over a few hundred seeds every face must appear at least once -- a
       weak claim about a fair die and an impossible one for a die that cannot reach half its faces. */
    /* ES5 target, no `downlevelIteration`: a Set cannot be spread here (#codebase-wide). Counted into a
       plain array instead, which also makes a starved face visible rather than merely absent. */
    const counts = [0, 0, 0, 0, 0, 0];
    for (let macroRound = 1; macroRound <= 60; macroRound += 1) {
      for (let companyId = 1; companyId <= 8; companyId += 1) {
        counts[revenueDieFace(seedFor(macroRound, 1, companyId)) - 1] += 1;
      }
    }
    expect(counts.filter((n) => n === 0)).toEqual([]);
  });

  it("only ever rolls a real d6", () => {
    /* THE HASH IS UNSIGNED, and this is where that shows. JavaScript's bitwise operators produce SIGNED
       32-bit values, so a hash that forgot its `>>> 0` would go negative and `% 6` would return 0 or a
       negative face -- indexing off the end of the modifier table and yielding `undefined` revenue. */
    for (let macroRound = 1; macroRound <= 40; macroRound += 1) {
      /* Design note #941: swept over corporations rather than train ordinals -- the ordinal is no longer a
         seed part, and the sweep still has to cross enough distinct keys to catch a sign error. */
      for (let companyId = 0; companyId < 4; companyId += 1) {
        const face = revenueDieFace(seedFor(macroRound, 1, companyId));
        expect(Number.isInteger(face)).toBe(true);
        expect(face).toBeGreaterThanOrEqual(1);
        expect(face).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe("the modifier table and its arithmetic (design note #903)", () => {
  it("is the requested table", () => {
    expect(REVENUE_MODIFIER_BY_FACE).toEqual([80, 90, 100, 100, 110, 120]);
  });

  it("is mean-preserving, which is the point of that shape", () => {
    /* PINNED AS A SUM. This adds variance without inflating or deflating the economy over a game, so the bank
       still breaks on roughly the schedule the length variant chose. It is exactly the property somebody
       "tuning the feel" breaks first, and nothing else in the app would fail visibly if they did. */
    const total = REVENUE_MODIFIER_BY_FACE.reduce((sum, pct) => sum + pct, 0);
    expect(total).toBe(600);
    expect(total / REVENUE_MODIFIER_BY_FACE.length).toBe(100);
  });

  it("rounds half away from zero, in integers", () => {
    /* NO FLOATING POINT, per the project rule -- the arithmetic is `(revenue * pct + 50) / 100` truncated, and
       these are the cases where that differs from truncation alone. $250 at 90% is exactly $225; $255 at 90%
       is $229.5 and must land on $230, not $229. */
    expect(applyRevenuePercent(250, 90)).toBe(225);
    expect(applyRevenuePercent(255, 90)).toBe(230);
    expect(applyRevenuePercent(255, 110)).toBe(281); // 280.5 -> 281
    expect(applyRevenuePercent(0, 120)).toBe(0);
  });

  it("leaves a 100% roll exactly alone", () => {
    /* TWO OF SIX FACES DO NOTHING, and they must do nothing EXACTLY -- a rounding scheme that nudged an
       unmodified figure would show players a changed number with no modifier to explain it. */
    for (const revenue of [0, 7, 130, 255, 999, 1230]) {
      expect(applyRevenuePercent(revenue, 100)).toBe(revenue);
    }
  });

  it("is actually wired to the reducer, and gated by the toggle", () => {
    /* ==================================================================
        THE ASSERTION WITHOUT WHICH ALL THE OTHERS PROVE NOTHING
       ==================================================================
       Every case above tests a pure module that could be flawless and never called. This drives the real
       reducer arm -- `RunManualRoute` is where a run COMMITS a figure to state, and the only place the die may
       be rolled -- and checks both directions: the variant off leaves the printed figure exactly alone, and
       the variant on produces the face this turn's seed says it should.
       NO `mapGrid` IN THE CONTEXT, so `sandboxRouteRevenue` is not consulted and the arm falls back to
       `SANDBOX_NOMINAL_ROUTE_REVENUE`. That is the point rather than a shortcut: it makes the PRINTED figure a
       known constant, so what this measures is the modifier and not the board. */
    const base = {
      macro_round_number: 3,
      sub_round_index: 1,
      public_companies: [{ company_id: 6, ticker: "ERIE", last_route_revenue: "0" }],
      /* `applyOneAction` resolves an actor from the seat cursor before it reaches any arm, so a state with no
         roster throws on the way in. Two fields, not a whole fixture: what this case is about is the arm. */
      player_addresses: ["p1"],
      active_player_index: 0,
    } as unknown as GameStateResponse;
    const run = (state: GameStateResponse) =>
      applySandboxAction(state, { RunManualRoute: { protocol_id: 6, path: [] } } as never);

    const standard = run({ ...base, variants: STANDARD_VARIANTS });
    const printed = Number(standard.public_companies[0].last_route_revenue);
    expect(printed).toBeGreaterThan(0);

    const varied = run({
      ...base,
      variants: { ...STANDARD_VARIANTS, unpredictableRevenue: true },
    });
    const expected = rollTurnRevenue(printed, seedFor(3, 1, 6));
    expect(Number(varied.public_companies[0].last_route_revenue)).toBe(expected.adjusted);
    /* AND THE COUNTER MOVED, which is what gives the turn's SECOND train a different die. A modifier applied
       without advancing this would give every train on the turn one face. */
    expect(varied.public_companies[0].routes_run_this_turn).toBe(1);
  });

  it("reports what it did, not just the result", () => {
    /* The roll carries its face and percentage because the Activity Log has to explain the number -- a
       corporation that ran for $230 when the board says $255 needs the sentence, not just the figure. */
    const roll = rollTurnRevenue(255, seedFor(3, 1, 6));
    expect(roll.printed).toBe(255);
    expect(REVENUE_MODIFIER_BY_FACE[roll.face - 1]).toBe(roll.percent);
    /* Design note #938: AND THE ROUNDING IS PART OF THE ANSWER. This asserted `applyRevenuePercent` alone and
       failed at 306 against 310 once the roll started rounding to the nearest ten -- correctly, because
       `adjusted` is now the FINAL banked figure rather than the mid-calculation one. Composed from the two
       steps in order, so it cannot pass against an implementation that dropped either. */
    expect(roll.adjusted).toBe(roundToTen(applyRevenuePercent(255, roll.percent)));
  });
});
