/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 938 + 939 (harness): THE VARIANT PAYS IN TENS, AND SAYS SO IN WORDS
// ==================================================================
//
// RULED, resolving the overpayment I raised in Batch 13: "round the total modified route revenue to the
// nearest $10 before any dividend math or log output occurs. This forces the variant's output back into a
// clean multiple of 10, resolving all per-share fractional issues natively."
//
// THE CLAIM WORTH TESTING IS "NATIVELY". It is not enough that the totals look tidier -- the reason this
// resolves #922's $3 is arithmetic, and if the arithmetic is only approximately right the exploit shrinks
// instead of closing. So the first block below drives the ACTUAL split function over the ACTUAL rounded
// figures and asserts the certificates sum to exactly what the corporation earned.

import {
  applyRevenuePercent,
  REVENUE_MODIFIER_BY_FACE,
  revenueDeltaPercent,
  revenueDieFace,
  revenueOutcome,
  rollTurnRevenue,
  roundToTen,
  STANDARD_VARIANTS,
  turnRevenueSentence,
} from "./gameVariants";
import { dividendSplit } from "./dividendSplit";
import { describeGameplayAction } from "./actionLog";
import type { GameStateResponse } from "./gameState";

describe("rounding to the nearest ten (design note #938)", () => {
  it("matches the ruled examples exactly", () => {
    /* THE THREE FIGURES IN THE INSTRUCTION, pinned verbatim. `Math.floor((v + 5) / 10) * 10` rounds halves
       UP, which is what makes 54 -> 50 and 27 -> 30 rather than the other way about. */
    expect([roundToTen(97), roundToTen(54), roundToTen(27)]).toEqual([100, 50, 30]);
  });

  it("rounds a half up", () => {
    /* THE BOUNDARY, stated on its own because it is the only place the `+ 5` is doing visible work. */
    expect([roundToTen(45), roundToTen(44), roundToTen(55)]).toEqual([50, 40, 60]);
  });

  it("leaves a multiple of ten alone and keeps zero at zero", () => {
    expect([roundToTen(0), roundToTen(10), roundToTen(150)]).toEqual([0, 10, 150]);
  });

  it("uses no floating-point anywhere in the result", () => {
    /* THE PROJECT'S STANDING RULE, asked of the output across the whole range a route can produce. An
       implementation that divided before flooring would return fractions here and nowhere else. */
    for (let value = 0; value <= 400; value += 1) {
      const rounded = roundToTen(value);
      expect(Number.isInteger(rounded)).toBe(true);
      expect(rounded % 10).toBe(0);
    }
  });

  it("never moves a figure by more than five", () => {
    /* THE PROPERTY THAT MAKES THIS A ROUNDING rather than a redistribution. A variant that could shift a
       payout by more than half a step would be changing the economy, not tidying it. */
    for (let value = 0; value <= 400; value += 1) {
      expect(Math.abs(roundToTen(value) - value)).toBeLessThanOrEqual(5);
    }
  });
});

describe("the roll is rounded before anyone reads it (design note #938)", () => {
  const seed = { macroRound: 3, subRound: 1, companyId: 4 };

  it("hands out only multiples of ten", () => {
    /* ROUNDED IN `rollTurnRevenue` RATHER THAN AT THE CALL SITES, which is the whole reason the reducer and
       the log cannot disagree: there is one `adjusted` and everything reads it. Driven across every face and
       a spread of printed values, because a rounding applied on only some branches is the failure mode. */
    for (let printed = 0; printed <= 300; printed += 10) {
      for (let ordinal = 0; ordinal < 6; ordinal += 1) {
        /* Design note #941: a sweep over CORPORATIONS now. The ordinal left the seed when the die became a
           once-per-turn roll; what these cases need is many distinct seeds, which any varying part supplies. */
        const roll = rollTurnRevenue(printed, { ...seed, companyId: ordinal });
        expect([printed, ordinal, roll.adjusted % 10]).toEqual([printed, ordinal, 0]);
      }
    }
  });

  it("still applies the percentage before rounding, not instead of it", () => {
    /* THE DEGENERATE IMPLEMENTATION THIS RULES OUT: `adjusted = roundToTen(printed)` would satisfy every
       "multiple of ten" case above and apply no modifier at all. Checked against the two steps composed in
       the right order, from the same table the roll uses. */
    for (let printed = 20; printed <= 300; printed += 10) {
      for (let ordinal = 0; ordinal < 6; ordinal += 1) {
        /* Design note #941: a sweep over CORPORATIONS now. The ordinal left the seed when the die became a
           once-per-turn roll; what these cases need is many distinct seeds, which any varying part supplies. */
        const parts = { ...seed, companyId: ordinal };
        const percent = REVENUE_MODIFIER_BY_FACE[revenueDieFace(parts) - 1];
        expect(rollTurnRevenue(printed, parts).adjusted).toBe(
          roundToTen(applyRevenuePercent(printed, percent)),
        );
      }
    }
  });

  it("is still stable under replay", () => {
    /* #903'S RULE, re-asked after the change: an Undo replays the log, and a rounding that depended on
       anything but the seed would move money between two identical replays. */
    for (let ordinal = 0; ordinal < 6; ordinal += 1) {
        /* Design note #941: a sweep over CORPORATIONS now. The ordinal left the seed when the die became a
           once-per-turn roll; what these cases need is many distinct seeds, which any varying part supplies. */
      const parts = { ...seed, companyId: ordinal };
      expect(rollTurnRevenue(170, parts).adjusted).toBe(rollTurnRevenue(170, parts).adjusted);
    }
  });
});

describe("the overpayment this was ruled to close (design notes #922 -> #938)", () => {
  /* ==================================================================
      THE FIXTURE HAD TO BE CORRECTED, AND SO DID WHAT I REPORTED
     ==================================================================
     A SOLD-OUT CORPORATION with all ten certificates in players' hands and nothing in the treasury or pool --
     the configuration #922's rounding broke on, because there is no corporate slice left to absorb a
     remainder.
     THE FIRST VERSION OF THIS FIXTURE USED FOUR HOLDERS (40/30/20/10) AND ITS OWN CONTROL FAILED. At $97 those
     four are paid 39 + 29 + 19 + 10, which is exactly 97: the blocks that round down offset the ones that
     round up, and the overpayment vanishes.
     SO THE EXPLOIT IS NARROWER THAN I REPORTED IN BATCH 13. I said "ten shares at $10 is $100 against a $97
     run" and left it sounding general. It is not: it needs the certificates SPLIT, ten separate 10% holdings,
     each of which rounds 9.7 up to 10 with nothing rounding down to compensate. Concentrated ownership hides
     it entirely, which is also why no existing test had ever caught it.
     TEN HOLDERS HERE, deliberately -- the worst case is the one a fix has to be proved against, and a fixture
     that cannot exhibit the bug cannot demonstrate the repair. */
  const soldOut = {
    public_companies: [
      {
        company_id: 4,
        ticker: "B&O",
        bank_pool_percentage: 0,
        player_holdings: Array.from({ length: 10 }, (_, index) => ({
          player: `p${index}`,
          percentage: 10,
        })),
      },
    ],
  } as unknown as GameStateResponse;

  it("pays out exactly what was earned, at every rounded figure", () => {
    /* THE HEADLINE. $97 used to pay $10 a certificate against a $97 run -- $100 out for $97 in. Every figure
       reaching the dividend is now a multiple of ten, and over the whole range the holders' shares sum to the
       revenue with nothing created and nothing lost. */
    for (let raw = 0; raw <= 400; raw += 1) {
      const revenue = roundToTen(raw);
      const split = dividendSplit(soldOut, 4, String(revenue), true);
      if (!split) continue;
      const paid = split.players.reduce((sum, entry) => sum + entry.amount, 0);
      expect([revenue, paid]).toEqual([revenue, revenue]);
    }
  });

  it("gives a 10% certificate exactly a tenth", () => {
    /* WHY IT WORKS, rather than that it works: with `revenue = 10k` and a holding that is a multiple of 10%,
       `floor((revenue * pct + 50) / 100)` is an integer before the rounding term can matter. */
    for (let revenue = 0; revenue <= 400; revenue += 10) {
      const split = dividendSplit(soldOut, 4, String(revenue), true);
      if (!split) continue;
      expect([revenue, split.perShare * 10]).toEqual([revenue, revenue]);
    }
  });

  it("would NOT balance on an unrounded figure", () => {
    /* THE CONTROL BUILT IN, and it earned its place by failing first against a four-holder fixture -- see the
       note above. If this passed, the cases before it would be describing `dividendSplit` rather than proving
       anything about the rounding. $97 is the reported figure, and $100 is what ten split certificates take
       out of a bank that only received $97. */
    const split = dividendSplit(soldOut, 4, "97", true);
    const paid = split!.players.reduce((sum, entry) => sum + entry.amount, 0);
    expect(paid).toBe(100);
    expect(paid).toBeGreaterThan(97);
  });

  it("closes it at the rounded figure the variant now produces", () => {
    /* THE SAME BOARD, ONE STEP LATER. $97 never reaches the dividend now -- #938 rounds it to $100 first --
       and at $100 the ten certificates take exactly $100. The gap is not smaller; there is no gap. */
    const split = dividendSplit(soldOut, 4, String(roundToTen(97)), true);
    const paid = split!.players.reduce((sum, entry) => sum + entry.amount, 0);
    expect([roundToTen(97), paid]).toEqual([100, 100]);
  });
});

describe("what counts as a real change (design note #938)", () => {
  it("calls a swallowed modifier normal", () => {
    /* THE PREDICATE BOTH SURFACES ASK. A $50 run at 90% is $45, which rounds back to $50: the die fired and
       the corporation received the printed figure. `percent !== 100` is the tempting test and would put a
       "-10% malus" on a run that lost nothing. */
    expect(revenueOutcome({ face: 2, percent: 90, printed: 50, adjusted: 50 })).toBe("normal");
    expect(revenueOutcome({ face: 5, percent: 110, printed: 50, adjusted: 50 })).toBe("normal");
  });

  it("names the direction when the figure did move", () => {
    expect(revenueOutcome({ face: 6, percent: 120, printed: 70, adjusted: 80 })).toBe("bonus");
    expect(revenueOutcome({ face: 1, percent: 80, printed: 70, adjusted: 60 })).toBe("malus");
  });

  it("reports the die's nominal swing, not the effective one", () => {
    /* #938'S REASONING, pinned: 70 -> 80 is an effective +14.3%, and a fraction is exactly what this batch
       removed from the variant. The die's own figure is round and is what the flavour explains. */
    expect(revenueDeltaPercent({ face: 5, percent: 110, printed: 70, adjusted: 80 })).toBe(10);
    expect(revenueDeltaPercent({ face: 1, percent: 80, printed: 70, adjusted: 60 })).toBe(-20);
  });

  it("is zero-delta exactly on the faces that do nothing", () => {
    expect(revenueDeltaPercent({ face: 3, percent: 100, printed: 70, adjusted: 70 })).toBe(0);
  });
});

// ==================================================================

const BO = 4;

/* Design note #941: THE SENTENCES MOVED, SO THESE CASES FOLLOWED THEM. #939 built the three strings on the
   PER-ROUTE log line, which was right while the die was per route. The die is now one roll per turn, so a
   four-train corporation would have printed four bonus sentences about one roll -- the reported complaint in
   a second currency. `turnRevenueSentence` is where they live now, and it is what these drive. */
const turnSeed = { macroRound: 3, subRound: 1, companyId: BO };

const turnLine = (printedTotal: number, companyId = BO) =>
  turnRevenueSentence(
    "B&O",
    rollTurnRevenue(printedTotal, { ...turnSeed, companyId }),
    { ...turnSeed, companyId },
  );

describe("the turn's one line reads as prose (design notes #939 -> #941)", () => {
  /* Swept over corporations rather than train ordinals -- the ordinal has left the seed, and what these cases
     need is enough distinct turns to reach all three outcomes. A fixture that only reached one branch would
     leave the other two unasserted while looking green. */
  const lines = Array.from({ length: 14 }, (_, companyId) => turnLine(70, companyId));

  it("has retired the debug parenthetical", () => {
    /* REPORTED at #939: "The '(Printed $X)' notation reads like developer debug text." */
    for (const line of lines) {
      expect(line).not.toContain("printed $");
      expect(line).not.toContain("(printed");
    }
  });

  it("says something ordinary happened when the rounding swallowed the die", () => {
    /* ==================================================================
        THE WORDING CHANGED WITH #944; THE RULE DID NOT
       ==================================================================
       THIS USED TO ASSERT `/^B&O had a normal run for \$\d+\.$/`, which was #941's single sentence for the
       swallowed-modifier case. #944's specified format replaces it with `"[Corp] ran for $X. " +
       unchanged[seed % 20]` -- twenty different ways of saying an ordinary day, rather than one.
       WHAT IS STILL BEING ASKED is the half that matters and has never changed: a turn whose modifier the
       rounding swallowed must claim NO modifier. "completely ignoring the die if the rounding swallowed the
       modifier" is the ruling, and it is about what the line must not say. */
    const normals = lines.filter((line) => !line.includes("because"));
    expect(normals.length).toBeGreaterThan(0);
    for (const line of normals) {
      expect(line).toMatch(/^B&O ran for \$\d+\. [A-Z]/);
      expect(line).not.toContain("bonus");
      expect(line).not.toContain("malus");
    }
  });

  it("names a bonus with its swing and its reason", () => {
    const bonuses = lines.filter((line) => line.includes("bonus"));
    expect(bonuses.length).toBeGreaterThan(0);
    for (const line of bonuses) {
      expect(line).toMatch(/^B&O ran for \$\d+\. It enjoyed a \d+% bonus because .+\.$/);
      expect(line).not.toContain("malus");
    }
  });

  it("names a malus with its swing and its reason", () => {
    const maluses = lines.filter((line) => line.includes("malus"));
    expect(maluses.length).toBeGreaterThan(0);
    for (const line of maluses) {
      expect(line).toMatch(/^B&O ran for \$\d+\. It suffered a \d+% malus because .+\.$/);
      expect(line).not.toContain("bonus");
    }
  });

  it("quotes only figures the corporation could actually have banked", () => {
    /* EVERY AMOUNT IS A MULTIPLE OF TEN, which is the log half of "update the Dividends reducer and the
       Activity Log to strictly use this rounded base-10 total". */
    for (const line of lines) {
      const amount = Number(line.match(/for \$(\d+)/)?.[1]);
      expect([line.slice(0, 20), amount % 10]).toEqual([line.slice(0, 20), 0]);
    }
  });

  it("never says bonus and malus in one sentence", () => {
    for (const line of lines) {
      expect(line.includes("bonus") && line.includes("malus")).toBe(false);
    }
  });

  it("is one sentence about the turn, not one per train", () => {
    /* THE REPORTED BUG, as a property of the output. A four-train turn produces exactly one of these, and it
       names the aggregate -- there is no train in it to name. */
    const line = turnLine(280);
    expect(line.match(/B&O/g)?.length ?? 0).toBe(1);
    expect(line).not.toContain("-train");
    expect(line).not.toContain("route");
  });
});

describe("the per-route line went back to being factual (design note #941)", () => {
  const routeLine = (variants: typeof STANDARD_VARIANTS) =>
    describeGameplayAction(
      { RunManualRoute: { protocol_id: BO, path: [{ hex: "F2" }, { hex: "A9" }] } } as never,
      {
        gameState: {
          macro_round_number: 3,
          sub_round_index: 1,
          current_round_type: "OperatingRound",
          active_operating_order: [BO],
          active_corporation_index: 0,
          player_addresses: ["p1"],
          active_player_index: 0,
          variants,
          public_companies: [
            { company_id: BO, ticker: "B&O", owned_trains: ["4"], station_token_hexes: [] },
          ],
        } as unknown as GameStateResponse,
        mapGrid: { hexes: [] } as never,
        era: "yellow" as never,
        labelForAddress: (address: string) => address,
      } as never,
    ) ?? "";

  it("names the track and the printed figure, with no die in it", () => {
    /* THE DIVISION #941 DRAWS: this line says which track ran, the turn's line says what the money did. It
       reads identically with the variant on and off, because a route's printed value is a fact about the
       board that no die touches. */
    const withVariant = routeLine({ ...STANDARD_VARIANTS, unpredictableRevenue: true });
    const without = routeLine(STANDARD_VARIANTS);
    expect(withVariant).toBe(without);
    expect(withVariant).toMatch(/^B&O ran a \$\d+ route with a 4-train through F2 -> A9\.$/);
  });

  it("carries no modifier language at all", () => {
    for (const line of [routeLine(STANDARD_VARIANTS), routeLine({ ...STANDARD_VARIANTS, unpredictableRevenue: true })]) {
      expect(line).not.toContain("bonus");
      expect(line).not.toContain("malus");
      expect(line).not.toContain("normal run");
      expect(line).not.toContain("because");
    }
  });
});
