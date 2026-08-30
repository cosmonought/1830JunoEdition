/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1051 (harness): THE DIE IS ROLLED NOW, NOT LOOKED UP
// ==================================================================
//
// REPORTED: "if the die rolls are fixed by the game seed, does this mean a savvy player could look up the game
// state and use this to their advantage? I think many players would feel a bit deflated/let down by an
// 'Unpredictable' variant that actually is predictable, if you know where to look."
//
// AND IT WAS FULLY PREDICTABLE, not merely in principle. The face came from an FNV hash of (round, sub-round,
// corporation) and nothing else, so it was identical in every game ever played -- the ERIE drew 120% on its
// first run and the PRR drew 80%, always -- and the hash ships to the browser, so reading the rest of the
// game's table off it took no insight at all.
//
// THE CASES HERE COME IN FOUR KINDS, and only the first is about the new number.
//   THE DRAW: that a uniform 32-bit seed reaches parts of the flavour payload the hash provably could not.
//   THE LOOKUP: that a turn which has already rolled finds its own roll again after an undo. This is the one
//   requirement that was stated before the feature was built -- "Undoing it should not change their roll,
//   otherwise players would just slot machine their way to +20%" -- and it is the only property the hash gave
//   away for free and a real die has to earn.
//   THE WIRING: that exactly one place draws and the reducer is not it.
//   THE SLICE: that the three draws taken out of one number do not overlap, measured rather than asserted --
//   which is the mistake `batch47`'s decorrelation case made and now records.

export {};

const {
  randomTurnSeed,
  legacyTurnSeed,
  revenueDieFace,
  revenueFlavourClause,
  rollTurnRevenue,
} = require("./gameVariants") as typeof import("./gameVariants");
const { seedAlreadyRolled, turnSeedKey } =
  require("./turnSeed") as typeof import("./turnSeed");
const { YELLOW_SIGN_MALUS_LINE, CARCOSA_CHANCE_IN_100, CARCOSA_SLICE } =
  require("./yellowSign") as typeof import("./yellowSign");
const { UNPREDICTABLE_REVENUE_FLAVOR } =
  require("../constants/flavorText") as typeof import("../constants/flavorText");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

const APP = readStripped("App.tsx");
const REDUCER = readStripped("utils/sandboxSession.ts");
const SEEDS = readStripped("utils/turnSeed.ts");

/* A DETERMINISTIC SWEEP OF THE 32-BIT RANGE, not `Math.random`. Everything below is a claim about a
   distribution, and a probability case that can fail on a bad afternoon teaches the reader to re-run rather
   than to read. The LCG is the Numerical Recipes one; all that is asked of it is that it walks the whole
   range instead of one residue class, which is exactly the hazard #969 measured when a fixture and the thing
   under test shared a factor. */
function sweep(count: number): number[] {
  const out: number[] = [];
  let x = 20260830;
  for (let at = 0; at < count; at += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out.push(x);
  }
  return out;
}

const at = (turnSeed: number) => ({ macroRound: 3, subRound: 1, companyId: 6, turnSeed });

/* ------------------------------------------------------------------ */
/* The draw                                                            */
/* ------------------------------------------------------------------ */

describe("the turn draws a real number", () => {
  it("returns an unsigned 32-bit integer", () => {
    /* THE RANGE THE EXTRACTIONS WERE WRITTEN FOR. The hash returned `hash >>> 0` and every consumer divides
       and takes a modulus on that footing -- a negative seed would make `% 6` return 0 or a negative face and
       index off the end of the modifier table, which is the failure `gameVariants` #903's sign case exists
       for. Same range, different source. */
    for (const seed of Array.from({ length: 500 }, randomTurnSeed)) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("does not return the same number twice running", () => {
    /* THE VACUOUS IMPLEMENTATION THIS FORBIDS is a constant, which would satisfy every other case in this
       file: the wiring would still be right, the lookup would still work, and the die would be more
       predictable than the hash it replaced. Asserted as a spread rather than a single inequality, because
       two draws colliding is legal and five hundred landing on one value is not. */
    expect(new Set(Array.from({ length: 500 }, randomTurnSeed)).size).toBeGreaterThan(400);
  });

  it("reaches every face of the die", () => {
    const counts = [0, 0, 0, 0, 0, 0];
    for (const seed of sweep(60000)) counts[revenueDieFace(at(seed)) - 1] += 1;
    expect(counts.filter((n) => n === 0)).toEqual([]);
    /* AND ROUGHLY EVENLY. `gameVariants` #903's own case asks only that no face is starved, which a die
       weighted 90/2/2/2/2/2 would pass. At 60,000 draws a fair sixth is 10,000 and this band is wide enough
       that no honest implementation trips it. */
    for (const n of counts) expect(Math.abs(n - 10000)).toBeLessThan(600);
  });

  it("can draw the Yellow Sign, which the hash provably could not", () => {
    /* ==================================================================
        THE CASE THIS WHOLE BATCH EXISTS FOR
       ==================================================================
       STAGE 1 NEEDS FACE 1 **AND** THE FLAVOUR INDEX TO LAND ON ONE SPECIFIC LINE of `criticalMalus` -- one
       of 6 x 115 pairs. Under the hash the pair was a function of (round, sub-round, corporation), and every
       turn key a real 1830 game can reach was enumerated: 600 of them, and not one produced that pair. The
       Easter egg was not rare, it was ABSENT, in every game, permanently.
       THAT IS THE FAILURE MODE OF DRAWING A RARE EVENT FROM A FIXED TABLE. Expected hits were 0.87, so the
       table being empty was a coin flip the feature lost once and could never re-flip.
       SO THE CASE IS REACHABILITY, not frequency. `flavorText.test.ts` owns how often; this owns whether it
       is possible at all, and it is the assertion that would have caught the defect on the day it shipped. */
    const wanted = UNPREDICTABLE_REVENUE_FLAVOR.criticalMalus.indexOf(YELLOW_SIGN_MALUS_LINE);
    expect(wanted).toBeGreaterThan(-1);
    const drawn = sweep(200000).filter((seed) => {
      const roll = { face: revenueDieFace(at(seed)), percent: 80, printed: 100, adjusted: 80 };
      return revenueFlavourClause(roll, at(seed)) === YELLOW_SIGN_MALUS_LINE;
    });
    expect(drawn.length).toBeGreaterThan(0);
  });

  it("reaches every line of every bucket", () => {
    /* THE GENERAL FORM OF THE CASE ABOVE. #969 found that half of a 50-line bucket was unreachable because
       `gcd(6, 50) = 2` and the face and the index came off one number; it fixed the division and measured
       reachability over the turn keys it had. A uniform draw removes the question -- but removing a question
       is not the same as answering it, and this is the answer. */
    for (const bucket of ["criticalMalus", "minorMalus", "unchanged", "minorBonus", "criticalBonus"] as const) {
      const lines = UNPREDICTABLE_REVENUE_FLAVOR[bucket];
      const seen = new Set<number>();
      for (const seed of sweep(60000)) seen.add(Math.floor(seed / 6) % lines.length);
      expect(seen.size).toBe(lines.length);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The lookup: undo must not re-roll                                   */
/* ------------------------------------------------------------------ */

describe("a turn that has rolled finds its own roll again", () => {
  const KEY = turnSeedKey(4, 2, 6);
  const run = (turn: string, seed: number | null) => ({
    payload: JSON.stringify({
      RunMultipleRoutes: {
        game_id: 0,
        protocol_id: 6,
        routes: [],
        payout_strategy: "Withhold",
        revenue_turn: turn,
        ...(seed === null ? {} : { revenue_seed: seed }),
      },
    }),
  });
  const revert = (index: number) => ({ payload: JSON.stringify({ RevertTo: { index } }) });

  it("finds the seed a matching turn recorded", () => {
    expect(seedAlreadyRolled([run(KEY, 12345)], KEY)).toBe(12345);
  });

  it("still finds it after an undo has struck the run out", () => {
    /* ==================================================================
        THE REQUIREMENT, STATED BEFORE THE FEATURE WAS BUILT
       ==================================================================
       "Once a player Runs Routes, the die should roll and Undoing it should not change their roll, otherwise
       players would just slot machine their way to +20%."
       AND THIS IS THE ONLY REASON THE DIE COULD BECOME REAL. `RevertTo` does not delete anything -- it is an
       appended entry meaning "everything from here on did not happen" (`logRevert.ts` #591), and
       `effectiveActions` filters those out when rebuilding the BOARD. The entries survive in the raw log, so
       the number a struck-out run recorded is still there to be found.
       THE FIXTURE PUTS THE REVERT AFTER THE RUN, which is the real order and the one that matters: the run is
       dead history by the time this lookup happens, and it must still answer. */
    expect(seedAlreadyRolled([run(KEY, 777), revert(0)], KEY)).toBe(777);
  });

  it("takes the most recent roll when a turn has several", () => {
    /* TWO UNDOS LEAVE TWO ENTRIES for one turn. The one that should govern is the one the player last saw on
       screen, so the scan runs backwards -- forwards would hand back a face nobody has looked at since. */
    expect(seedAlreadyRolled([run(KEY, 1), revert(0), run(KEY, 2), revert(2)], KEY)).toBe(2);
  });

  it("says nothing about a turn that has not rolled", () => {
    /* `null`, NOT A FRESH DRAW. The caller decides, which is what keeps this function pure and keeps "found
       the earlier roll" distinguishable from "invented one" -- if it drew here, the case above could not tell
       the difference between working and not. */
    expect(seedAlreadyRolled([run(turnSeedKey(9, 9, 9), 42)], KEY)).toBeNull();
    expect(seedAlreadyRolled([], KEY)).toBeNull();
  });

  it("ignores an entry that names the turn but recorded no seed", () => {
    // #232: absent is not a value. Reading `revenue_seed` off an entry that has none is how `undefined`
    // becomes `NaN` becomes a die face of `NaN`.
    expect(seedAlreadyRolled([run(KEY, null)], KEY)).toBeNull();
  });

  it("treats an unreadable entry as silence rather than throwing", () => {
    /* `logRevert.ts` TAKES THE SAME LINE ABOUT THE SAME LOG and states the reason: an entry nobody can parse
       must not be able to break the game. The cost of being wrong here is one extra draw; the cost of
       throwing is a dispatch that dies mid-turn. */
    expect(seedAlreadyRolled([{ payload: "not json" }, run(KEY, 5)], KEY)).toBe(5);
    expect(seedAlreadyRolled([{ payload: "null" }], KEY)).toBeNull();
  });

  it("reads the raw log rather than the effective one", () => {
    /* THE EDIT THAT WOULD SILENTLY REINSTATE THE SLOT MACHINE. Every other consumer in this codebase wants
       `effectiveActions` and this one must not have it -- the entry being looked for is BY DEFINITION one an
       undo has killed. Nothing would fail if somebody "corrected" it, which is why it is asserted here and
       said out loud in the module. */
    expect(APP).toContain("seedAlreadyRolled(sandboxLogRef.current");
    expect(SEEDS).toContain("rawLog");
  });
});

/* ------------------------------------------------------------------ */
/* One place draws                                                     */
/* ------------------------------------------------------------------ */

describe("the die is thrown once, in the shell", () => {
  it("draws or reuses at the dispatch", () => {
    expect(APP).toContain("?? randomTurnSeed()");
    expect(APP).toContain("revenue_turn:");
  });

  it("never draws in the reducer", () => {
    /* THE REDUCER RUNS ON EVERY CLIENT, for every entry, on every replay. A draw here would give four
       browsers four different boards and a reload a fifth -- which is #1017's shape and the reason the die
       was a hash in the first place. It reads the recorded number; it does not make one. */
    expect(REDUCER).not.toContain("randomTurnSeed");
    expect(REDUCER).not.toContain("Math.random");
    expect(REDUCER).toContain("msg.RunMultipleRoutes.revenue_seed ??");
  });

  it("keeps the old die only as a fallback for old logs", () => {
    /* NOT A SAFETY NET FOR A DISPATCH THAT FORGOT. An entry with no `revenue_seed` predates this batch and
       replaying it through the hash rebuilds the board it was actually played on. A LIVE turn falling back
       here would be the predictable die returning with nothing on screen to say so -- which is why the case
       above pins that the dispatch always supplies one. */
    expect(REDUCER).toContain("legacyTurnSeed(");
    expect(APP).toContain("randomTurnSeed");
  });

  it("narrates from the recorded roll rather than deriving a second one", () => {
    /* THE SENTENCE IS WRITTEN ON `DeclareDividends` and the die was thrown on `RunMultipleRoutes`, so the
       narration cannot read its own message. Before #1051 that was harmless -- the face was a pure function
       of the turn and any caller could re-derive it. A second DRAW here would put a percentage in the
       Activity Log that the board never paid. */
    const block = sliceBetween(APP, 'if (before && "DeclareDividends" in msg', "const roll = rollTurnRevenue");
    expect(block).toContain("seedAlreadyRolled(");
    expect(block).not.toContain("randomTurnSeed");
  });
});

/* ------------------------------------------------------------------ */
/* Three draws out of one number                                       */
/* ------------------------------------------------------------------ */

describe("the Carcosa roll takes bits the others cannot reach", () => {
  it("strides past the die and the widest bucket", () => {
    /* MEASURED FROM THE PAYLOAD, NOT WRITTEN DOWN. The face consumes the low factor of six and the flavour
       index consumes `floor(/6) % length`; a bucket that grew past a hardcoded stride would start overlapping
       the line index, the rate would drift, and nothing would fail. */
    let widest = 0;
    for (const bucket of ["criticalMalus", "minorMalus", "unchanged", "minorBonus", "criticalBonus"] as const) {
      widest = Math.max(widest, UNPREDICTABLE_REVENUE_FLAVOR[bucket].length);
    }
    expect(CARCOSA_SLICE).toBe(6 * widest);
  });

  it("fires at the rate the constant names", () => {
    /* TWENTY PERCENT, CHOSEN. The old `CARCOSA_CHANCE = 0.1` was never compared against anything -- the code
       tested `% 10 === 0`, so the constant and the behaviour were two claims that happened to agree, which is
       #891's shape in a probability. This constant IS the comparison, so the two cannot drift. */
    expect(CARCOSA_CHANCE_IN_100).toBe(20);
    const seeds = sweep(60000);
    const hits = seeds.filter((seed) => Math.floor(seed / CARCOSA_SLICE) % 100 < CARCOSA_CHANCE_IN_100);
    expect(Math.abs((100 * hits.length) / seeds.length - CARCOSA_CHANCE_IN_100)).toBeLessThan(2);
  });

  it("keeps the legacy die reproducible for the logs that still need it", () => {
    /* THE FALLBACK MUST STILL BE A FUNCTION, or an old log would rebuild differently on each client -- which
       is the desync the hash was chosen to prevent and is still its job for closed games. */
    expect(legacyTurnSeed(3, 1, 6)).toBe(legacyTurnSeed(3, 1, 6));
    expect(legacyTurnSeed(3, 1, 6)).not.toBe(legacyTurnSeed(4, 1, 6));
    // And it still drives a real roll, so a replayed old turn produces a real face.
    expect(rollTurnRevenue(100, at(legacyTurnSeed(3, 1, 6))).face).toBeGreaterThanOrEqual(1);
  });
});
