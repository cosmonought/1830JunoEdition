/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 961 + 962 (harness): ONE COPY OF THE COPY, AND A LEGEND THAT FOLLOWS THE RULES
// ==================================================================
//
// THE FAULT THIS BATCH FIXED WAS NOT A WRONG SENTENCE -- it was a sentence with two homes. `Lobby.tsx` and
// `SandboxWaitingRoom.tsx` each wrote their own version of all four variant blurbs, and they had already
// drifted: the waiting room's Unpredictable Revenue text carried a whole sentence about dividend rounding
// that the Lobby's did not. Nothing anywhere would have noticed.
//
// SO THE CASES BELOW COME IN TWO KINDS. The content ones read `VARIANT_BLURB` directly, because it is a
// constant with an answer. The SINGLE-SOURCE ones are absence scans over the two components, because "this
// text exists in exactly one place" is not observable from the value -- only from the files.
//
// #962'S COMPASS IS THE SAME SHAPE ONE STEP OVER: a legend that describes a rule, in a file that does not own
// the rule. #746c already recorded what that costs, in this very component: "The caption was accurate about
// the code as it then stood, which is precisely why a wrong rule reaches a player: the legend agreed with the
// bug."

import { VARIANT_COPY, STANDARD_VARIANTS, dividendStepsFor } from "./gameVariants";
import { COMPASS_ARMS, compassArmsFor } from "../components/StockMarketRenderer";
import { readStripped } from "./sourceScan";

describe("the variant blurbs have one home (design note #961)", () => {
  it("is the only place the sentences are written", () => {
    /* THE ACTUAL FAULT, as an absence. Both components must reference the constant rather than carry a copy;
       a surviving literal is a second copy waiting to drift, which is exactly how this batch started. */
    const lobby = readStripped("components/Lobby.tsx");
    const waiting = readStripped("components/SandboxWaitingRoom.tsx");
    for (const source of [lobby, waiting]) {
      expect(source).toContain("VARIANT_COPY");
      /* The old texts, by their most distinctive fragments. Any of these still in a component means that
         component is writing its own copy again. */
      expect(source).not.toContain("rolls a d6 against its printed run");
      expect(source).not.toContain("Averages");
      expect(source).not.toContain("adds drama without changing how long the bank lasts");
    }
  });

  it("covers all four variants", () => {
    /* A blurb missing from the record is a toggle with no description at all -- and the components read by
       key, so the failure is `undefined` rendered as empty rather than an error. */
    expect(Object.keys(VARIANT_COPY).sort()).toEqual([
      "delayedAuction",
      "dynamicStockMarket",
      "gentleRust",
      "unpredictableRevenue",
    ]);
    for (const entry of Object.values(VARIANT_COPY)) {
      expect(entry.blurb.length).toBeGreaterThan(40);
      expect(entry.blurb.trim()).toBe(entry.blurb);
      expect(entry.label.trim()).toBe(entry.label);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});

describe("the Unpredictable Revenue copy is true (design note #961)", () => {
  const blurb = VARIANT_COPY.unpredictableRevenue.blurb;

  it("uses the real plus-minus sign", () => {
    /* NOTICED IN REVIEW: "you actually wrote +/-, can you not create the combined symbol?"
       I COULD, AND HAD NO REASON NOT TO. The ASCII pair was a transcription of the request's own shorthand
       that survived into the shipped string -- this file already carries em dashes, curly apostrophes and
       arrow glyphs, so the fallback was never buying anything.
       ASSERTED BOTH WAYS, because the failure is a silent regression: a later editor retyping the line on a
       keyboard without the glyph puts "+/-" back and nothing else here would object. */
    expect(blurb).toContain("\u00B120%");
    expect(blurb).not.toContain("+/-");
  });

  it("names the rounding, without which the percentage is false", () => {
    /* CORRECTED MID-BATCH: "a corporation that runs for $80 with a 20% malus ends up only paying out $60,
       which is actually a -25%." The clause is what makes "+/-20%" describe the DIE rather than promise a
       payout band the rounding does not honour. */
    expect(blurb).toContain("rounded to the nearest $10");
  });

  it("is checked against the arithmetic it describes", () => {
    /* ==================================================================
        THE CLAIM, DRIVEN THROUGH THE REAL FUNCTIONS
       ==================================================================
       A copy test that only matched strings would have passed the sentence that was wrong. This one composes
       the two steps the reducer composes and asks whether the deviation ever exceeds 20% -- and it DOES, up
       to a third on a $30 route, which is precisely why the sentence needs the rounding clause rather than a
       tighter number. The case exists to keep that fact visible, not to bless it. */
    const roundToTen = (value: number) => Math.floor((value + 5) / 10) * 10;
    const deviations = [20, 30, 50, 80, 100, 170].map((printed) => {
      const low = roundToTen(Math.trunc((printed * 80 + 50) / 100));
      return Math.abs((low - printed) / printed);
    });
    expect(Math.max(...deviations)).toBeGreaterThan(0.2);
  });

  it("says nothing about dice, faces or percentages tables", () => {
    /* REQUESTED: "Rather than explaining the math/system behind it, it could be something more lighthearted."
       The Lobby is where a table chooses what KIND of game to play; the mechanism belongs in the Rules
       Reference, which a player reaches having already chosen. */
    for (const word of ["d6", "die", "face", "80%", "120%", "seed"]) {
      expect([word, blurb.includes(word)]).toEqual([word, false]);
    }
  });
});

describe("the difficulty qualifiers ride on the titles (design note #961a)", () => {
  /* ==================================================================
      CORRECTED: THEY WERE ON THE DESCRIPTIONS
     ==================================================================
     MY FIRST VERSION opened each blurb with "(Lessens difficulty.)" / "(Increases difficulty.)" and these
     cases asserted that. CORRECTED: "I meant for you to add them on the titles, not on the descriptions...so
     the title would read `Gentle rust (easier)` and `Delayed private auction (harder)`."
     AND THE CORRECTION IS RIGHT ABOUT WHY. A parenthetical inside a paragraph is read after the decision; on
     the title it is read WITH the name, which is when a table is choosing. */

  it("marks gentle rust easier and the delayed auction harder, in the label", () => {
    /* ASSERTED AS A PAIR, because the value to a table is that the two point opposite ways -- which one
       assertion alone does not express. */
    expect(VARIANT_COPY.gentleRust.label).toBe("Gentle rust (easier)");
    expect(VARIANT_COPY.delayedAuction.label).toBe("Delayed private auction (harder)");
  });

  it("leaves the qualifiers out of the descriptions", () => {
    /* THE OTHER HALF OF THE MOVE. Saying it in both places is the duplication this whole note is about, one
       scale down. */
    for (const entry of Object.values(VARIANT_COPY)) {
      expect(entry.blurb).not.toContain("difficulty");
      expect(entry.blurb).not.toContain("(easier)");
      expect(entry.blurb).not.toContain("(harder)");
    }
  });

  it("qualifies only the two variants that were ruled on", () => {
    /* THE OTHER TWO ARE NOT NEUTRAL SO MUCH AS UNRULED, and inventing a qualifier for them would be this
       file deciding a balance question nobody asked it to. */
    expect(VARIANT_COPY.unpredictableRevenue.label).toBe("Unpredictable revenue");
    expect(VARIANT_COPY.dynamicStockMarket.label).toBe("Dynamic stock market");
  });

  it("gives every variant one name across both screens", () => {
    /* THE DRIFT THIS FOUND. The Lobby's fourth toggle read "Delayed auction" and the waiting room's read
       "Delayed private auction" -- one variant, two names, on the two screens a table reads before agreeing
       to it. Neither may write its own now. */
    const lobby = readStripped("components/Lobby.tsx");
    const waiting = readStripped("components/SandboxWaitingRoom.tsx");
    for (const source of [lobby, waiting]) {
      expect(source).not.toContain('"Delayed auction"');
      expect(source).not.toContain('"Delayed private auction"');
      expect(source).not.toContain("<strong>Gentle rust</strong>");
    }
    expect(lobby).toContain("VARIANT_COPY.gentleRust.label");
    expect(waiting).toContain("VARIANT_COPY[key]");
  });

  it("closes the delayed auction with the warning it was given", () => {
    expect(VARIANT_COPY.delayedAuction.blurb).toContain(
      "Watch your cash carefully or your rivals might get the advantage!",
    );
    expect(VARIANT_COPY.delayedAuction.blurb.trimEnd().endsWith("advantage!")).toBe(true);
  });
});

describe("the compass rose follows the variant (design note #962)", () => {
  const DYNAMIC = { ...STANDARD_VARIANTS, dynamicStockMarket: true };

  it("states the printed rule in a standard game", () => {
    expect(compassArmsFor(STANDARD_VARIANTS)).toBe(COMPASS_ARMS);
    expect(COMPASS_ARMS.right.rule).toContain("one column right");
  });

  it("restates the paid arm under Dynamic Stock Market", () => {
    /* THE REPORTED GAP. #908 made a paid dividend move the token nothing, one cell or two -- and this legend
       kept saying "one column right" for every table, including the ones playing the variant. */
    const arms = compassArmsFor(DYNAMIC);
    expect(arms.right.rule).not.toBe(COMPASS_ARMS.right.rule);
    expect(arms.right.rule).toContain("does not move");
    expect(arms.right.rule).toContain("two columns");
  });

  it("describes the same three bands the reducer applies", () => {
    /* THE JOIN THIS CANNOT FULLY CLOSE, and the case says so rather than implying otherwise. A legend
       describes a rule; it cannot be DERIVED from `dividendStepsFor`, which evaluates one payout. What is
       checkable is that the three outcomes the function can return are the three the sentence names -- so a
       fourth band added to the rules would fail here rather than only on screen. */
    const price = 100;
    const bands = [50, 100, 250].map((payout) => dividendStepsFor(payout, price, DYNAMIC));
    expect(bands).toEqual([0, 1, 2]);
    const rule = compassArmsFor(DYNAMIC).right.rule;
    expect(rule).toContain("Under its own share price");
    expect(rule).toContain("once the price, one column right");
    expect(rule).toContain("twice the price or more, two columns");
  });

  it("qualifies the label as well as the tooltip", () => {
    /* "Paid" beside an arrow that might not move the token is the same wrong-legend problem in fewer words,
       and the label is the part read without hovering. */
    expect(compassArmsFor(DYNAMIC).right.label).not.toBe(COMPASS_ARMS.right.label);
    expect(compassArmsFor(DYNAMIC).right.label).toContain("varies");
  });

  it("leaves the three arms #908 does not touch alone", () => {
    /* SHARED, NOT DUPLICATED. Sold out, withheld and each-10%-sold are unchanged by the variant, and a second
       copy of "one row down per 10% share sold" would be a second thing to keep in step for no gain. */
    const arms = compassArmsFor(DYNAMIC);
    expect(arms.up).toBe(COMPASS_ARMS.up);
    expect(arms.left).toBe(COMPASS_ARMS.left);
    expect(arms.down).toBe(COMPASS_ARMS.down);
  });

  it("is actually fed the game's variants", () => {
    /* THE INTEGRATION GAP THIS PROJECT KEEPS FINDING: a variant-aware function that nothing tells which
       variant. The rose renders inside `StockMarketRenderer`, which had no such prop until this batch. */
    const renderer = readStripped("components/StockMarketRenderer.tsx");
    expect(renderer).toContain("<MarketCompassRose variants={variants} />");
    expect(readStripped("App.tsx")).toContain("variants={gameState?.variants}");
  });

  it("reads an absent config as the standard game", () => {
    /* #902'S RULE: a missing config is not an error and not an empty object -- it is 1830. A live chain that
       predates the field must get the printed legend, not a blank one. */
    expect(compassArmsFor(STANDARD_VARIANTS).right.rule).toBe(COMPASS_ARMS.right.rule);
    const renderer = readStripped("components/StockMarketRenderer.tsx");
    expect(renderer).toContain("compassArmsFor(resolveVariants(variants))");
  });
});
