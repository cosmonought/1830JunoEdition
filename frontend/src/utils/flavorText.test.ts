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
    ]).toEqual([50, 50, 45, 50, 50]);
  });

  it("holds 245 lines in total", () => {
    /* ==================================================================
        THE COUNTS MOVED, AND THE MODULO DID NOT HAVE TO
       ==================================================================
       125 lines were added -- 25 to each bucket -- taking `unchanged` from 20 to 45 and the other four from
       25 to 50. ASKED: "You will need to adjust your modulo arithmetic since this expand the number of
       possible variants."
       NO ARITHMETIC CHANGED, and that is #944's doing rather than luck: `revenueFlavourClause` indexes with
       `revenueSeedHash(parts) % lines.length`, taken from the array itself. That note recorded the reason at
       the time -- "so the modulus cannot come apart from the payload the way a hard-coded 25 would the first
       time a line is added or removed" -- and this is the first time it was tested.
       THESE COUNT CASES ARE THE PART THAT HAD TO MOVE, which is the right split: the payload's shape is a
       fact worth pinning, and the code reads that shape rather than repeating it. */
    const all = Object.values(UNPREDICTABLE_REVENUE_FLAVOR).flat();
    expect(all).toHaveLength(245);
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

  it("sentence-cases every line in every bucket", () => {
    /* ==================================================================
        SUPERSEDED BY #949, AND THE OLD RULE IS RECORDED RATHER THAN DELETED
       ==================================================================
       THIS USED TO ASSERT THE OPPOSITE for four of the five buckets -- "starts the four clause buckets
       lower-case and the unchanged bucket upper-case" -- because those four were joined to the sentence with
       "because" and a capital mid-clause would have read as a typo. It even carried an allow-list for the
       three lines that legitimately open on a proper noun.
       REPORTED: "a bit too clunky as a single run-on sentence. We need to separate the mechanical result from
       the flavor text." The join is a full stop now, so every line is a standalone sentence and the casing
       rule inverts with it.
       ONE RULE FOR ALL FIVE BUCKETS NOW, which is simpler than what it replaces AND is the thing that would
       break if a future line were added in the old style -- a lower-case sentence after a full stop reads as
       a mistake in exactly the way the old capital did. */
    for (const [bucket, lines] of Object.entries(UNPREDICTABLE_REVENUE_FLAVOR)) {
      for (const line of lines) {
        expect([bucket, line.slice(0, 18), line[0]]).toEqual([
          bucket,
          line.slice(0, 18),
          line[0].toUpperCase(),
        ]);
      }
    }
  });

  it("shows no sign of a botched bulk edit", () => {
    /* ==================================================================
        WRITTEN AFTER A CONTROL EXPOSED THE FIRST VERSION AS DECORATIVE
       ==================================================================
       #949 re-cased 100 strings in one pass, which is exactly where a script clips or doubles a character.
       MY FIRST VERSION OF THIS CASE asserted `line.length > 20` and `line[1]` is lower-case, and a control
       that clipped a first letter -- "The accountants" to "he accountants" -- was caught by the CASING case
       beside it, not by this one. It was describing nothing the other cases did not already cover.
       SO IT ASKS FOR THE ACTUAL SLIPS a first-character edit produces, none of which any other case here can
       see: a doubled initial ("TThe"), a leading or doubled space, or a line that lost enough to stop being a
       sentence. A clip that leaves a plausible capital -- "The" to "Xhe" -- remains undetectable by anything
       short of the original text, and saying so is more useful than a case that pretends otherwise. */
    for (const [bucket, lines] of Object.entries(UNPREDICTABLE_REVENUE_FLAVOR)) {
      for (const line of lines) {
        const label = [bucket, line.slice(0, 18)];
        expect([...label, line.startsWith(" ")]).toEqual([...label, false]);
        expect([...label, line.includes("  ")]).toEqual([...label, false]);
        /* A doubled initial is the other half of the same slip -- upper-casing by PREPENDING rather than
           replacing. Two identical letters can open a real word ("llama"), so it is asked as
           "capital followed by the same letter in lower case", which no English word does. */
        expect([...label, line[0] === line[1]?.toUpperCase()]).toEqual([...label, false]);
        expect([...label, line.trim().split(/\s+/).length >= 4]).toEqual([...label, true]);
      }
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
        lines[Math.floor(revenueSeedHash(parts) / 6) % lines.length],
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
  /* ==================================================================
      MEASURED THROUGH THE FUNCTION, BECAUSE THE FIRST VERSION MEASURED ITSELF
     ==================================================================
     THIS USED TO RECOMPUTE THE INDEX -- `seen[bucket].add(revenueSeedHash(parts) % lines.length)` -- which is
     the implementation's formula copied into the test. A control that removed #969's decorrelation from the
     REAL function did not fail here, because this block was still dividing (or not dividing) by six on its
     own account. It was describing its own arithmetic and calling it coverage.
     SO IT COLLECTS THE RETURNED LINES. `revenueFlavourClause` is called with the same roll the reducer would
     produce, and the distinct STRINGS are counted -- which cannot be satisfied by a formula the test happens
     to agree with, and is the thing the case was always meant to be about. */
  const seen: Record<string, Set<string>> = {
    criticalMalus: new Set(),
    minorMalus: new Set(),
    unchanged: new Set(),
    minorBonus: new Set(),
    criticalBonus: new Set(),
  };
  for (let macroRound = 1; macroRound <= 200; macroRound += 1) {
    for (let subRound = 1; subRound <= 3; subRound += 1) {
      for (let companyId = 1; companyId <= 8; companyId += 1) {
        const parts = { macroRound, subRound, companyId };
        const roll = rollTurnRevenue(170, parts);
        seen[flavorBucketFor(roll)].add(revenueFlavourClause(roll, parts));
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
    ]).toEqual([50, 50, 45, 50, 50]);
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
      /* Design note #949: "because" is gone from every branch now, so its absence no longer distinguishes
         this one -- the mechanical clause does. RULED: "The `unchanged` array mapping remains exactly as it
         is", and what that means concretely is that no modifier is ever announced here. */
      expect(line).not.toContain("bonus");
      expect(line).not.toContain("malus");
    }
  });

  it("prints the four modifier forms as two sentences", () => {
    /* #949'S SHAPE, pinned exactly: `"[Corp] ran for $X. It [suffered/enjoyed] a [Y]% [malus/bonus]. " +
       <line>`. The regex asserts the FULL STOP between the mechanical half and the flavour, which is the
       whole of the change -- "because" here would still read plausibly and be the reported bug. */
    const modified = lines.filter((line) => /(bonus|malus)/.test(line));
    expect(modified.length).toBeGreaterThan(0);
    for (const line of modified) {
      expect(line).toMatch(
        /^B&O ran for \$\d+\. It (enjoyed|suffered) a (10|20)% (bonus|malus)\. [A-Z].+\.$/,
      );
      expect(line).not.toContain("because");
    }
  });

  it("pairs enjoyed with bonus and suffered with malus", () => {
    /* ==================================================================
        ANCHORED ON THE CLAUSE, BECAUSE THE BARE WORD IS THE PAYLOAD'S TOO
       ==================================================================
       The two words are chosen from one `outcome`, so crossing them would take a deliberate edit -- pinned
       because it is the kind of edit that reads as a tidy-up.
       THIS FAILED THE MOMENT #950 PUT THE `unchanged` LINES INTO PAST TENSE. "The railway enjoyed the rare
       luxury of normality" contains "enjoyed" and no "bonus", and the first version of this case searched for
       the bare word -- so it flagged a correct sentence.
       THE FLAVOUR AND THE MECHANICAL CLAUSE SHARE A VOCABULARY, inevitably: both are about a railway having a
       good or bad day. So the assertion has to name the CLAUSE it is about rather than a word that appears in
       it, which is also what makes it a test of the pairing rather than of the prose. */
    for (const line of lines) {
      if (/It enjoyed a \d+%/.test(line)) expect(line).toMatch(/It enjoyed a \d+% bonus\./);
      if (/It suffered a \d+%/.test(line)) expect(line).toMatch(/It suffered a \d+% malus\./);
      expect(/% bonus\./.test(line) && /% malus\./.test(line)).toBe(false);
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
