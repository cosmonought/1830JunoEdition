/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 944 (harness): 120 LINES, AND THE THREE WAYS THEY COULD GO WRONG
// ==================================================================
//
// The payload is supplied verbatim, so nothing here checks the prose. What can break is the WIRING around it,
// and it can break in exactly three ways:
//
//   1. AN INDEX OFF THE END. The rules are `seed % 20` and `seed % 25`, which are the array lengths -- a
//      dropped comma during an edit shortens an array silently and puts `undefined` into the Activity Log.
//   2. THE WRONG BUCKET. "We must map it to the effective outcome", because the rounding can swallow a
//      modifier; a selector keyed on `percent` rather than on the rounded figures would explain a loss that
//      did not happen.
//   3. LINES THAT CAN NEVER APPEAR. The flavour index and the die face are drawn from the SAME hash. #907
//      hit this before and divided the hash by six to decorrelate; the specified rule does not, so whether
//      every line is reachable is a question to be MEASURED rather than assumed.

import { UNPREDICTABLE_REVENUE_FLAVOR } from "../constants/flavorText";
import {
  flavorBucketFor,
  REVENUE_MODIFIER_BY_FACE,
  revenueDeltaPercent,
  revenueFlavourClause,
  revenueSeedHash,
  rollTurnRevenue,
  turnRevenueSentence,
  type RevenueRoll,
} from "./gameVariants";

const seedAt = (companyId: number) => ({ macroRound: 3, subRound: 1, companyId });

describe("the payload's shape (design note #944)", () => {
  it("has the lengths the index rules assume", () => {
    /* HAZARD 1, ASKED DIRECTLY. `unchanged[seed % 20]` and `[seed % 25]` for the rest were specified against
       these counts; if an array is shorter the modulus reaches past its end. */
    expect([
      UNPREDICTABLE_REVENUE_FLAVOR.criticalMalus.length,
      UNPREDICTABLE_REVENUE_FLAVOR.minorMalus.length,
      UNPREDICTABLE_REVENUE_FLAVOR.unchanged.length,
      UNPREDICTABLE_REVENUE_FLAVOR.minorBonus.length,
      UNPREDICTABLE_REVENUE_FLAVOR.criticalBonus.length,
    ]).toEqual([25, 25, 20, 25, 25]);
  });

  it("holds 120 lines in total", () => {
    const all = Object.values(UNPREDICTABLE_REVENUE_FLAVOR).flat();
    expect(all).toHaveLength(120);
  });

  it("repeats no line, within a bucket or across them", () => {
    /* A duplicate would halve the variety of one bucket without shortening it, which no length check can see
       and which a player notices before any test does. */
    const all = Object.values(UNPREDICTABLE_REVENUE_FLAVOR).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("ends every line with a full stop", () => {
    /* THE SENTENCES ARE COMPOSED, NOT TEMPLATED: the four modifier buckets are joined after "because " and
       the `unchanged` lines are appended whole. Either way the payload supplies the terminator, so a line
       missing one produces a log entry that runs into nothing. */
    for (const line of Object.values(UNPREDICTABLE_REVENUE_FLAVOR).flat()) {
      expect([line.slice(-24), line.endsWith(".")]).toEqual([line.slice(-24), true]);
    }
  });

  it("starts the four clause buckets lower-case and the unchanged bucket upper-case", () => {
    /* WHICH IS WHAT MAKES THE TWO JOINS DIFFERENT. "because The railway enjoys..." would be wrong, and so
       would a bare sentence fragment appended after a full stop. The payload's own casing is what decides
       which branch each bucket belongs in, so it is asserted rather than trusted. */
    for (const bucket of ["criticalMalus", "minorMalus", "minorBonus", "criticalBonus"] as const) {
      for (const line of UNPREDICTABLE_REVENUE_FLAVOR[bucket]) {
        const first = line[0];
        /* Proper nouns are legitimately capitalised mid-clause -- "Wall Street was firmly advised..." -- so
           this asks that the line is not a SENTENCE, which is what a trailing full stop plus a capital would
           make it. Checked as "does not begin with a capitalised common word". */
        if (first !== first.toLowerCase()) {
          expect(["Wall", "Pinkertons", "Morse"]).toContain(line.split(" ")[0].replace(/[^A-Za-z]/g, ""));
        }
      }
    }
    for (const line of UNPREDICTABLE_REVENUE_FLAVOR.unchanged) {
      expect(line[0]).toBe(line[0].toUpperCase());
    }
  });
});

describe("the bucket follows the outcome, not the percentage (design note #944)", () => {
  it("sends a swallowed modifier to the unchanged bucket", () => {
    /* HAZARD 2, AND THE WHOLE REASON THE MAPPING IS OUTCOME-DRIVEN: "Because your base-10 rounding logic
       occasionally swallows a 10% modifier and returns the payout to 100%, we cannot map the flavor text
       strictly to the raw die face."
       A $50 turn at 90% pays $45, rounds back to $50, and must read as an ordinary day -- even though the die
       said 90 and the face was 2. A selector keyed on `percent` returns `minorMalus` here. */
    expect(flavorBucketFor({ face: 2, percent: 90, printed: 50, adjusted: 50 })).toBe("unchanged");
    expect(flavorBucketFor({ face: 5, percent: 110, printed: 50, adjusted: 50 })).toBe("unchanged");
  });

  it("maps each face that moved the figure to its specified bucket", () => {
    /* THE FIVE RULES, PINNED ONE BY ONE. Face 6 is the 20% bonus, 5 the 10%, 2 the 10% malus, 1 the 20%. */
    expect(flavorBucketFor({ face: 6, percent: 120, printed: 70, adjusted: 80 })).toBe("criticalBonus");
    expect(flavorBucketFor({ face: 5, percent: 110, printed: 70, adjusted: 80 })).toBe("minorBonus");
    expect(flavorBucketFor({ face: 2, percent: 90, printed: 70, adjusted: 60 })).toBe("minorMalus");
    expect(flavorBucketFor({ face: 1, percent: 80, printed: 70, adjusted: 60 })).toBe("criticalMalus");
  });

  it("sends the two neutral faces to unchanged", () => {
    expect(flavorBucketFor({ face: 3, percent: 100, printed: 70, adjusted: 70 })).toBe("unchanged");
    expect(flavorBucketFor({ face: 4, percent: 100, printed: 70, adjusted: 70 })).toBe("unchanged");
  });

  it("covers every face the modifier table can actually produce", () => {
    /* THE EXHAUSTIVENESS THE SELECTOR RELIES ON, checked against the table rather than assumed. The five
       specified cases are complete only because faces 5 and 6 are the only ones above 100 and 1 and 2 the
       only ones below. If the table ever changes, this fails here rather than in the log. */
    REVENUE_MODIFIER_BY_FACE.forEach((percent, index) => {
      const face = index + 1;
      if (percent > 100) expect([5, 6]).toContain(face);
      if (percent < 100) expect([1, 2]).toContain(face);
    });
  });

  it("names a swing that agrees with the bucket it chose", () => {
    /* THE TWO HALVES OF THE SENTENCE MUST NOT DRIFT. "It enjoyed a 20% bonus because <minorBonus line>" is
       the failure this prevents -- a hand-written percentage beside a face-selected bucket. Both are derived,
       and this asserts they agree for every face that moves the figure. */
    const pairs: [number, number, string][] = [
      [6, 20, "criticalBonus"],
      [5, 10, "minorBonus"],
      [2, 10, "minorMalus"],
      [1, 20, "criticalMalus"],
    ];
    for (const [face, swing, bucket] of pairs) {
      const percent = REVENUE_MODIFIER_BY_FACE[face - 1];
      const roll: RevenueRoll = {
        face,
        percent,
        printed: 100,
        adjusted: percent > 100 ? 120 : 80,
      };
      expect([face, Math.abs(revenueDeltaPercent(roll)), flavorBucketFor(roll)]).toEqual([
        face,
        swing,
        bucket,
      ]);
    }
  });
});

describe("the line is drawn by the turn's own seed (design note #944)", () => {
  it("indexes with seed % length", () => {
    /* THE SPECIFIED RULE, checked against the payload directly rather than against a second copy of the
       arithmetic in the module. */
    for (let companyId = 0; companyId < 30; companyId += 1) {
      const parts = seedAt(companyId);
      const roll = rollTurnRevenue(170, parts);
      const bucket = flavorBucketFor(roll);
      const lines = UNPREDICTABLE_REVENUE_FLAVOR[bucket];
      expect(revenueFlavourClause(roll, parts)).toBe(
        lines[revenueSeedHash(parts) % lines.length],
      );
    }
  });

  it("is stable under replay", () => {
    /* #903'S RULE, which the flavour has to obey as much as the figure: an Undo replays the log, and two
       players reading different explanations of one event is worse than no explanation (#907). */
    for (let companyId = 0; companyId < 10; companyId += 1) {
      const parts = seedAt(companyId);
      const roll = rollTurnRevenue(170, parts);
      expect(revenueFlavourClause(roll, parts)).toBe(revenueFlavourClause(roll, parts));
    }
  });

  it("never returns undefined, over a wide sweep of turns", () => {
    /* HAZARD 1 AGAIN, from the other side: an off-by-one modulus produces `undefined`, which stringifies into
       the log as the word "undefined" rather than throwing. */
    for (let macroRound = 1; macroRound <= 12; macroRound += 1) {
      for (let companyId = 0; companyId < 12; companyId += 1) {
        const parts = { macroRound, subRound: 1, companyId };
        const clause = revenueFlavourClause(rollTurnRevenue(170, parts), parts);
        expect(typeof clause).toBe("string");
        expect(clause.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("every line is reachable (design note #944)", () => {
  /* ==================================================================
      HAZARD 3, MEASURED RATHER THAN ASSUMED
     ==================================================================
     The face is `hash % 6` and the flavour index is `hash % 20` or `hash % 25`. Those are drawn from ONE
     number, so they are not independent -- and `gcd(20, 6) = 2`, which means for any FIXED face the
     `unchanged` index can only take one parity. #907 hit exactly this and decorrelated by dividing the hash
     by six first; the specified rule does not, so the question is whether the coupling actually costs any
     line its chance to appear.
     SWEPT OVER REAL TURNS rather than over raw hashes, because that is the population that matters: what a
     table would see across a long game is the set of (round, sub-round, corporation) triples the game
     actually visits. */
  const seen: Record<string, Set<number>> = {
    criticalMalus: new Set(),
    minorMalus: new Set(),
    unchanged: new Set(),
    minorBonus: new Set(),
    criticalBonus: new Set(),
  };
  for (let macroRound = 1; macroRound <= 60; macroRound += 1) {
    for (let subRound = 1; subRound <= 3; subRound += 1) {
      for (let companyId = 1; companyId <= 8; companyId += 1) {
        const parts = { macroRound, subRound, companyId };
        const roll = rollTurnRevenue(170, parts);
        const bucket = flavorBucketFor(roll);
        const lines = UNPREDICTABLE_REVENUE_FLAVOR[bucket];
        seen[bucket].add(revenueSeedHash(parts) % lines.length);
      }
    }
  }

  it("reaches every line of every bucket", () => {
    /* IF THIS FAILS, the coupling above is real and costing lines. It is stated per bucket so the report
       names which one, and with the count so a near-miss is legible rather than just red. */
    expect([
      seen.criticalMalus.size,
      seen.minorMalus.size,
      seen.unchanged.size,
      seen.minorBonus.size,
      seen.criticalBonus.size,
    ]).toEqual([25, 25, 20, 25, 25]);
  });
});

describe("the sentence the log actually prints (design note #944)", () => {
  const lines = Array.from({ length: 40 }, (_, companyId) =>
    turnRevenueSentence("B&O", rollTurnRevenue(170, seedAt(companyId)), seedAt(companyId)),
  );

  it("prints the unchanged form with no because-clause", () => {
    /* SPECIFIED: `"[Corp] ran for $X. " + unchanged[seed % 20]`. The `unchanged` lines are whole sentences,
       so this branch appends rather than completing a clause. */
    const normals = lines.filter((line) =>
      UNPREDICTABLE_REVENUE_FLAVOR.unchanged.some((flavour) => line.endsWith(flavour)),
    );
    expect(normals.length).toBeGreaterThan(0);
    for (const line of normals) {
      expect(line).toMatch(/^B&O ran for \$\d+\. [A-Z]/);
      expect(line).not.toContain("because");
      expect(line).not.toContain("bonus");
      expect(line).not.toContain("malus");
    }
  });

  it("prints the four modifier forms with their clause", () => {
    const modified = lines.filter((line) => line.includes("because"));
    expect(modified.length).toBeGreaterThan(0);
    for (const line of modified) {
      expect(line).toMatch(
        /^B&O ran for \$\d+\. It (enjoyed|suffered) a (10|20)% (bonus|malus) because .+\.$/,
      );
    }
  });

  it("pairs enjoyed with bonus and suffered with malus", () => {
    /* The two words are chosen from one `outcome`, so crossing them would take a deliberate edit -- pinned
       because it is the kind of edit that reads as a tidy-up. */
    for (const line of lines) {
      if (line.includes("enjoyed")) expect(line).toContain("bonus");
      if (line.includes("suffered")) expect(line).toContain("malus");
      expect(line.includes("bonus") && line.includes("malus")).toBe(false);
    }
  });

  it("draws its clause from the bucket the roll selected", () => {
    /* THE JOIN, END TO END: the sentence the player reads must contain the line the selector chose, for the
       same roll. This is what a mismatch between the two would break, and nothing above would catch it. */
    for (let companyId = 0; companyId < 30; companyId += 1) {
      const parts = seedAt(companyId);
      const roll = rollTurnRevenue(170, parts);
      expect(
        turnRevenueSentence("B&O", roll, parts).endsWith(revenueFlavourClause(roll, parts)),
      ).toBe(true);
    }
  });

  it("quotes the rounded figure", () => {
    /* #938: every amount reaching a player is a multiple of ten. */
    for (const line of lines) {
      expect(Number(line.match(/for \$(\d+)/)?.[1]) % 10).toBe(0);
    }
  });
});
