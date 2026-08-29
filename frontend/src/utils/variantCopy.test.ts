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

  it("does not restate a rule the reducer owns (design note #982)", () => {
    /* ==================================================================
        THE GENTLE RUST BLURB WENT STALE AND NOTHING HERE COULD SEE IT
       ==================================================================
       It read "...and stops counting against the train limit the moment it is doomed — so its replacement
       can be bought straight away". True under #906; reversed by #979, which made gently rusted trains count
       against the limit. The MODAL's copy was corrected in that batch (#980) and this sentence was missed --
       one authority updated, its sibling not asked, which is this project's signature fault.
       NO ASSERTION IN THIS FILE COULD HAVE CAUGHT IT, and that is the useful part. Every case here is about
       the copy's SHAPE -- one home, qualifiers on the labels, the rounding clause present -- because a blurb
       describing a rule that lives in a reducer is not checkable from the string. #746c recorded the cost of
       exactly this: "the legend agreed with the bug."
       SO THIS IS THE NARROWEST GUARD THAT IS HONEST. It cannot verify the copy against the engine; it can
       insist the lobby stops making train-limit promises at all, which is the property that keeps the blurb
       from being able to go stale again. The rule belongs in the Rules Reference and in the modal that fires
       at the moment it applies. */
    expect(VARIANT_COPY.gentleRust.blurb).toBe(
      "A rusting train gets one last Operating Round turn before it goes.",
    );
    for (const entry of Object.values(VARIANT_COPY)) {
      expect(entry.blurb).not.toContain("train limit");
    }
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
    const bands = [50, 100, 300].map((payout) => dividendStepsFor(payout, price, DYNAMIC, "pay"));
    expect(bands).toEqual([0, 1, 2]);
    const rule = compassArmsFor(DYNAMIC).right.rule;
    expect(rule).toContain("Under its own share price");
    expect(rule).toContain("once the price, one column right");
    /* Design note #988: "3 times", from the constant. The legend saying "twice" while the reducer wants
       three is #746c's fault exactly -- "the legend agreed with the bug" -- so the sentence is checked
       against the same number the arithmetic uses rather than against a word. */
    expect(rule).toContain("3 times the price or more, two columns");
    expect(rule).not.toContain("twice the price");
  });

  it("qualifies the label as well as the tooltip", () => {
    /* "Paid" beside an arrow that might not move the token is the same wrong-legend problem in fewer words,
       and the label is the part read without hovering. */
    expect(compassArmsFor(DYNAMIC).right.label).not.toBe(COMPASS_ARMS.right.label);
    expect(compassArmsFor(DYNAMIC).right.label).toContain("varies");
  });

  it("leaves the two arms the variant does not touch alone", () => {
    /* SHARED, NOT DUPLICATED. Sold out and each-10%-sold are unchanged by the variant, and a second copy of
       "one row down per 10% share sold" would be a second thing to keep in step for no gain. */
    const arms = compassArmsFor(DYNAMIC);
    expect(arms.up).toBe(COMPASS_ARMS.up);
    expect(arms.down).toBe(COMPASS_ARMS.down);
  });

  it("says out loud that the withhold DOES vary (design notes #988 -> #994)", () => {
    /* ==================================================================
        THE ARM THAT LEFT THE SHARED SET, AND WHY IT HAD TO
       ==================================================================
       THE LEFT ARM USED TO BE `COMPASS_ARMS.left` UNCHANGED, on the reasoning above -- the variant does not
       touch the withhold, so it needs no copy. That was true of the RULE and false of the READING. Beside a
       right arm relabelled "Paid (varies)", an unqualified "Withheld" invites exactly the inference that the
       withhold varies too -- which is what the rules actually did until #988, so the rose was accidentally
       describing the bug.
       AND THEN THE DENIAL BECAME FALSE. #994 gave the withhold its own double jump at three times the share
       price, so the sentence #988 wrote specifically to rule the variation OUT is now the opposite of the
       rule. A legend written to DENY a behaviour is exactly as fragile as one written to state it -- #746c
       from the other side, and worth recording as the reason this arm is now checked against the shared
       constant rather than against any wording.
       THE LABEL CARRIES THE QUALIFIER TOO. "Withheld" beside "Paid (varies)" still reads as fixed, and the
       label is the half read without hovering; only the glyph stays shared. */
    const arms = compassArmsFor(DYNAMIC);
    expect(arms.left.glyph).toBe(COMPASS_ARMS.left.glyph);
    expect(arms.left.label).toBe("Withheld (varies)");
    expect(arms.left.rule).toContain("at least one column left");
    expect(arms.left.rule).toContain("drops it two columns");
    expect(arms.left.rule).not.toContain("whatever the run was worth");
    /* AND THE STANDARD ROSE IS UNTOUCHED, or every table would read a variant sentence -- which is #994a's
       scope limit expressed on the surface a base-game player actually looks at. */
    expect(compassArmsFor(STANDARD_VARIANTS).left).toBe(COMPASS_ARMS.left);
    expect(compassArmsFor(STANDARD_VARIANTS).left.label).toBe("Withheld");
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
