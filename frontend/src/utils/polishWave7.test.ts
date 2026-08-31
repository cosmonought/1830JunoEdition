/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 956-958 (harness): A POSITIONING FIX I CANNOT DEMONSTRATE, AND TWO I CAN
// ==================================================================
//
// #958 IS A FUNCTION and is driven directly -- `roundStampFor` has a defined answer for every state, and its
// failure modes are all "wrong round, wrong step, or a suffix where there should be none".
//
// #957's arrow sizing is a source scan, because the size is a style literal.
//
// #956 IS THE AWKWARD ONE AND WORTH NAMING AS SUCH. The overlay already carried `position: fixed; inset: 0`
// and a `zIndex` far above the Action Bar's 50 -- the configuration that is meant to make the reported bug
// impossible -- and a search of the shell's styles found no ancestor with a `transform`, `filter` or
// stacking context to explain it. The fix is a PORTAL, which makes the symptom impossible whatever the cause
// was, and the cases below can only assert that the portal is there. They cannot prove it fixed the report,
// and this comment exists so nobody later reads them as if they had.

import { roundStampFor, roundLabelFor } from "./roundLabel";
import { describeGameplayAction } from "./actionLog";
import type { GameStateResponse } from "./gameState";
import { readStripped, sliceBetween } from "./sourceScan";

const operating = (subPhase?: string): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: 2,
    sub_round_index: 1,
    operating_sub_phase: subPhase,
    active_operating_order: [4],
    active_corporation_index: 0,
    player_addresses: ["p1"],
    active_player_index: 0,
    public_companies: [{ company_id: 4, ticker: "NNH", station_token_hexes: [] }],
  }) as unknown as GameStateResponse;

describe("the log stamp carries the step (design note #958)", () => {
  /* ==================================================================
      DESIGN NOTE 1071: THE SEPARATOR IS AN EM DASH NOW
     ==================================================================
     #958 CHOSE `--` "as specified" and defended it typographically: "an en dash and a hyphen are one pixel
     apart" in a monospaced column. RULED SINCE: "Please replace '--' with an em dash." And the typographic
     half does not carry over -- an em dash is twice a hyphen's width, so it is not the character that
     argument was about; it reads as a separator at a glance, which is what a scanning target needs.
     THE TABLE RULE IS UNTOUCHED and is what the second case below is actually for. */
  it("writes round and step, joined by an em dash", () => {
    expect(roundStampFor(operating("Hardware"))).toBe("OR 2.1\u2014Buy Trains");
  });

  it("uses the stepper's own labels", () => {
    /* #478'S RULE SURVIVES THE MOVE: one table, so the log and the strip cannot describe a step two ways.
       "Hardware" is the state's word and "Buy Trains" is the player's; a stamp inventing its own vocabulary
       would put a third name on one step. */
    expect(roundStampFor(operating("Track"))).toBe("OR 2.1\u2014Lay Track");
    expect(roundStampFor(operating("Routes"))).toBe("OR 2.1\u2014Run Routes");
    expect(roundStampFor(operating("BuyPrivate"))).toBe("OR 2.1\u2014Buy Private");
  });

  it("adds no suffix outside an Operating Round, even on a stale cursor", () => {
    /* ==================================================================
        THE FIXTURE HAD TO CARRY A STALE STEP, BECAUSE A CONTROL PASSED WITHOUT ONE
       ==================================================================
       MY FIRST VERSION built the Stock Round with no `operating_sub_phase` at all -- and a control that
       deleted the round-type guard entirely PASSED, because the `!step` guard below it caught the undefined.
       The case was describing the fixture rather than the function.
       AND THE GUARD IS NOT REDUNDANT IN REALITY. #656 has the sandbox reducer CLEAR the cursor outside an
       Operating Round -- but #232's rule is that a live chain reports whatever it reports, and a build that
       left the field populated would stamp "SR3--Buy Trains" on every Stock Round entry. That is precisely
       the log inventing structure a round does not have.
       SO THE FIXTURE CARRIES THE STALE STEP the guard exists to ignore. */
    const stock = {
      current_round_type: "StockRound",
      macro_round_number: 3,
      operating_sub_phase: "Hardware",
    } as unknown as GameStateResponse;
    expect(roundStampFor(stock)).toBe("SR3");
    const auction = {
      current_round_type: "WaterfallAuction",
      operating_sub_phase: "Track",
    } as unknown as GameStateResponse;
    expect(roundStampFor(auction)).toBe("Auction");
  });

  it("adds no suffix when the cursor is between steps", () => {
    /* `operating_sub_phase` is optional (#232) and absent between turns. `OR 2.1--undefined` is what a
       missing guard produces, and it would reach the screen as those exact letters. */
    expect(roundStampFor(operating(undefined))).toBe("OR 2.1");
  });

  it("survives an unknown step rather than printing undefined", () => {
    /* A step the label table does not know is a build mismatch, not a crash -- the round is still true and is
       the half worth keeping. */
    expect(roundStampFor(operating("NotAStep"))).toBe("OR 2.1");
  });

  it("is null before the first poll, like the label it wraps", () => {
    expect(roundStampFor(null)).toBeNull();
    expect(roundStampFor(undefined)).toBeNull();
  });

  it("leaves roundLabelFor alone for the announcements", () => {
    /* THE REASON THIS IS A SECOND FUNCTION. `roundLabelFor` also writes round-TRANSITION announcements, and a
       step name in "The next Stock Round begins" would be meaningless -- no corporation is on a step at the
       moment a round starts. Two callers, two questions. */
    expect(roundLabelFor(operating("Hardware"))).toBe("OR 2.1");
  });
});

describe("the pass line stopped repeating the step (design note #958)", () => {
  const line = (msg: unknown, subPhase: string | null) =>
    describeGameplayAction(msg as never, {
      gameState: operating(subPhase ?? undefined),
      mapGrid: { hexes: [] } as never,
      era: "yellow" as never,
      labelForAddress: (address: string) => address,
      orSubPhase: subPhase,
    } as never) ?? "";

  it("says only that the corporation passed", () => {
    /* THE DUPLICATION THIS PREVENTS: "[OR 2.1--Buy Trains] NNH passed Buy Trains." The tag is the copy that
       lands in one column down the feed, so the sentence gives it up. */
    /* Design note #1069: the two messages no longer read alike, and that is the correction rather than a
       regression -- `PassTurn` ends the turn and `AdvanceOperatingSubPhase` declines a step. What this case
       forbids is unchanged: neither names the step, because the tag does. */
    expect(line({ PassTurn: {} }, "Hardware")).toBe("NNH ended its turn.");
    expect(line({ AdvanceOperatingSubPhase: { protocol_id: 4 } }, "Hardware")).toBe("NNH passed.");
  });

  it("names no step in any Operating Round pass line", () => {
    /* Swept over every step, because one arm keeping the old wording is the plausible half-done state and
       reads perfectly well on its own. */
    for (const step of ["BuyPrivate", "Track", "Tokens", "Routes", "Dividends", "Hardware"]) {
      for (const msg of [{ PassTurn: {} }, { AdvanceOperatingSubPhase: { protocol_id: 4 } }]) {
        const text = line(msg, step);
        expect([step, text.includes("Buy Trains") || text.includes("Lay Track")]).toEqual([
          step,
          false,
        ]);
      }
    }
  });

  it("reads the same with no cursor on it", () => {
    /* Design note #1069: THE DISTINCTION IS GONE BECAUSE ITS SUBJECT IS. The two sentences differed on
       whether a step was known, which mattered while the sentence was about a step. A turn ending is not,
       so the cursor has nothing left to change. */
    expect(line({ PassTurn: {} }, null)).toBe("NNH ended its turn.");
  });

  it("keeps a Stock Round pass unchanged", () => {
    /* THE HALF THIS BATCH MUST NOT TOUCH. Outside an Operating Round a seat really is passing, and #745's
       wording there is about a different thing entirely. */
    const stock = describeGameplayAction({ PassTurn: {} } as never, {
      gameState: {
        current_round_type: "StockRound",
        macro_round_number: 3,
        player_addresses: ["alice"],
        active_player_index: 0,
        public_companies: [],
      } as unknown as GameStateResponse,
      mapGrid: { hexes: [] } as never,
      era: "yellow" as never,
      labelForAddress: (address: string) => address,
    } as never);
    expect(stock).not.toContain("passed.");
  });
});

describe("the overlay renders outside the app subtree (design note #956)", () => {
  const FLASH = readStripped("components/RevenueModifierFlash.tsx");

  it("portals to document.body", () => {
    /* THE STRUCTURAL GUARANTEE. A portal renders outside the App tree entirely, so no ancestor's containing
       block or stacking context can reach it -- which is what makes this a fix rather than a patch on a cause
       I could not identify. */
    expect(FLASH).toContain('import { createPortal } from "react-dom";');
    expect(FLASH).toContain("createPortal(overlay, document.body)");
  });

  it("guards the portal for an environment with no document", () => {
    /* Rendering in place is a worse position and a working component; throwing is neither. */
    expect(FLASH).toContain('typeof document === "undefined" || !document.body');
  });

  it("keeps the fixed full-viewport box", () => {
    /* THE PORTAL ALONE DOES NOT CENTRE ANYTHING -- it only changes where the node lives. The ruling names the
       box explicitly: "position: fixed; inset: 0; pointer-events: none" with the content centred. */
    expect(FLASH).toContain('position: "fixed"');
    expect(FLASH).toContain("inset: 0");
    expect(FLASH).toContain('alignItems: "center"');
    expect(FLASH).toContain('justifyContent: "center"');
  });

  it("sits above every z-index in the shell's sheet", () => {
    /* READ FROM BOTH FILES rather than asserting a literal. A new modal at 9500 would put the overlay back
       underneath something, and the number here would still look right on its own. */
    const declared = Number(FLASH.match(/REVENUE_FLASH_Z_INDEX = (\d+)/)?.[1]);
    const shell = readStripped("styles/appStyles.ts");
    const others = (shell.match(/zIndex: \d+/g) ?? []).map((entry) =>
      Number(entry.replace(/\D/g, "")),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) expect(declared).toBeGreaterThan(other);
  });

  it("still cannot swallow a click", () => {
    /* #940'S RULE, re-asked because a portal moves the node to `body` where it covers the whole document --
       if anything, the stakes went up. */
    expect(FLASH.match(/pointerEvents: "none"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("keeps the timer and its constant intact", () => {
    /* RULED: "ensure the animation and timer remain intact." A portal changes where a component renders, not
       what it does -- but the effect and the render moved in the same edit, which is where a timer gets lost. */
    expect(FLASH).toContain("setTimeout(() => setVisible(false), REVENUE_FLASH_MS)");
    /* #970: 850 on instruction, 900 since #999. The number is `polishWave6`'s to justify; what this case is
       about is that the portal did not eat the timer. */
    expect(FLASH).toContain("export const REVENUE_FLASH_MS = 900;");
  });
});

describe("arrow size follows the swing (design note #957)", () => {
  const FLASH = readStripped("components/RevenueModifierFlash.tsx");
  const ANIM = readStripped("styles/animations.ts");

  it("sizes critical swings larger than minor ones", () => {
    /* ==================================================================
        #957 SET ONE SIZE PER TIER; #959 MADE IT A SPREAD; #985 MADE IT A BAND
       ==================================================================
       THIS READ THE TWO ARMS OF A TERNARY, then the two bases of a spread. RULED SINCE: "The large/critical
       arrows must be 60-80% of the size of the number text, and the small/minor arrows must be 30-50%."
       SO THE TIERS ARE RANGES NOW and the comparison is between them rather than between two scalars. The
       property #957 was protecting is unchanged and is what is asserted: a critical arrow is bigger than a
       minor one, at every point of both spreads -- which is stronger than comparing their centres, and is
       the thing that makes size readable before the numeral is. */
    const band = (tier: string) => {
      const block = sliceBetween(FLASH, `${tier}: { low:`, "}");
      return {
        low: Number(block.match(/low: ([\d.]+)/)?.[1]),
        high: Number(block.match(/high: ([\d.]+)/)?.[1]),
      };
    };
    const critical = band("critical");
    const minor = band("minor");
    expect(critical.low).toBeGreaterThan(minor.high);
    expect(critical.high).toBeGreaterThan(critical.low);
    expect(minor.high).toBeGreaterThan(minor.low);
  });

  it("keeps both bands inside the ruled percentages", () => {
    /* THE RULING ITSELF, as numbers. Asserted against the FIGURES IN THE INSTRUCTION rather than against
       whatever the constants happen to say, so a later widening has to disagree with the ruling on purpose
       instead of drifting past it. */
    expect(FLASH).toContain("critical: { low: 0.6, high: 0.8 }");
    expect(FLASH).toContain("minor: { low: 0.3, high: 0.5 }");
  });

  it("gives the six arrows a genuine spread, not one size", () => {
    /* THE RULING'S OTHER HALF, and the one a tier comparison cannot see. Six equal positions would satisfy
       every other case here and put the uniform set straight back.
       THE RATIO ASSERTION MOVED FROM 1.5x TO THE SPREAD OF THE POSITIONS, and #985 records why: a band of
       60-80% has extremes only 1.33x apart, so the old assertion is arithmetically unsatisfiable inside the
       ruled range. The positions are 0..1 across the band, so what is checkable is that they genuinely use
       it -- ends included -- rather than clustering in the middle. */
    const scales = (FLASH.match(/scale: [\d.]+/g) ?? []).map((entry) =>
      Number(entry.replace(/[^\d.]/g, "")),
    );
    expect(scales.length).toBe(6);
    expect(new Set(scales).size).toBe(6);
    expect(Math.max(...scales)).toBeGreaterThanOrEqual(0.85);
    expect(Math.min(...scales)).toBeLessThanOrEqual(0.2);
  });

  it("keeps every arrow visible at both tiers", () => {
    /* THE FAILURE A SPREAD INTRODUCES: the smallest position on the minor band is the smallest glyph in the
       system. It is now floored by the band itself -- nothing can draw below `minor.low` -- so what this
       case checks is that the floor the ruling set is high enough to see, which is the same question one
       level up from where #959 asked it. */
    const minorLow = Number(FLASH.match(/minor: \{ low: ([\d.]+)/)?.[1]);
    expect(minorLow).toBeGreaterThan(0.25);
  });

  it("converts a drawn share into a font size rather than using it raw", () => {
    /* ==================================================================
        THE BUG #985 FOUND IN #972's OWN ARITHMETIC
       ==================================================================
       The ruling talks about the arrow's size RELATIVE TO THE NUMBER -- both drawn heights. #972 set a font
       SIZE and compared it to the numeral's font size, which are two different quantities: U+25B2 inks about
       seven tenths of its em, while the numeral is read by its cap height, `CAP_HEIGHT_RATIO` of its own.
       So every percentage in that note was about boxes nobody can see, and the arrows drew roughly a third
       smaller than the figures claimed -- which is what "still drastically too small" was measuring.
       BOTH CONVERSIONS ASSERTED, because either one alone still leaves the number wrong and neither is
       visible in the rendered output as anything but "a bit off". */
    expect(FLASH).toContain("CAP_HEIGHT_RATIO");
    expect(FLASH).toContain("ARROW_GLYPH_RATIO");
    expect(FLASH).toContain("const ARROW_GLYPH_RATIO = 0.7;");
  });

  it("keys on the magnitude rather than the bucket name", () => {
    /* `criticalBonus`/`criticalMalus` ARE the 20% buckets, so this is the same test one step closer to the
       thing that matters -- and it stays right if a face is ever re-tabled, where a name check would have to
       be found and updated. */
    expect(FLASH).toContain("Math.abs(shown.delta) >= CRITICAL_SWING_PERCENT");
    expect(FLASH).toContain("const CRITICAL_SWING_PERCENT = 20;");
  });

  it("scales from the figure's em, not from pixels", () => {
    /* A FIXED PX SIZE would make the tiers indistinguishable on a small screen and absurd on a large one --
       the failure the numeral's own `clamp` already exists to avoid. Design note #985: the em is now composed
       from a band and a position across it, so the anchor is the position and the unit rather than a
       multiplication. */
    expect(FLASH).toContain("offset.scale");
    expect(FLASH).toContain("}em`");
  });

  it("no longer sets one size in the stylesheet", () => {
    /* THE OVERRIDE HAZARD, as an absence. A surviving `font-size` on `.app-revenue-arrow` would not break the
       inline style -- inline wins -- but it would sit there reading as the arrow's size and be wrong, which is
       the note-describing-something-the-code-does-not-do fault in a stylesheet. */
    const arrow = sliceBetween(ANIM, ".app-revenue-arrow {", ".app-revenue-figure");
    expect(arrow).not.toContain("font-size:");
  });

  it("still animates every arrow in the ruled direction", () => {
    /* #953, re-asked because this batch touched the same element list. */
    expect(FLASH).toContain('animationName: bonus ? "app-revenue-arrow-up" : "app-revenue-arrow-down"');
  });
});
