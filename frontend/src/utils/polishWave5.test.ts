/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 945-948 (harness): FOUR LAYOUT AND COLOUR RULINGS
// ==================================================================
//
// THREE OF THESE FOUR ARE SOURCE SCANS, and one is arithmetic. The split is not arbitrary:
//
//   #945's DESATURATION IS A CALCULATION with an answer, and every way it can be wrong is a number -- a blend
//   that returns the livery unchanged, one that returns the neutral, one that rounds a channel past 255. That
//   is exactly the class #888 argues belongs in a pure module with real assertions over it.
//
//   #946 (one line), #947 (seat ink) and #948 (the dead card) are FACTS ABOUT MARKUP AND STYLE LITERALS.
//   "These three elements share a row" and "this card takes no clicks" are not things a node-environment test
//   can observe by running anything, and the standing instruction is not to render React here. What CAN be
//   checked is that the structure and the properties are present, which is the half that keeps regressing.
//
// TWO OF THESE PARTLY REVERSE EARLIER NOTES -- #930 took the livery OFF the inactive chips and #599 took the
// colour dot off the seats. Both reversals are narrower than they look, and the cases below say which half of
// each old note still stands, so a future reader does not "restore" the thing that was deliberately changed.

import {
  desaturatedLiveryInk,
  mixHex,
  TURN_ORDER_DESATURATION_PERCENT,
  TURN_ORDER_NEUTRAL_INK,
  corporationLiveryColor,
  CORPORATION_LIVERY_COLORS,
} from "../styles/corporationLivery";
import { BO_LOCKED_CARD_NOTE, BO_LOCKED_REASON } from "./gameVariants";
import { readStripped, sliceBetween } from "./sourceScan";

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

describe("the desaturation blend (design note #945)", () => {
  it("returns the original at 0 and the target at 100", () => {
    /* THE TWO ENDS, because a blend factor is ambiguous by nature -- "how much of the target survives" and
       "how much of the source survives" are indistinguishable at the midpoint, which is where a careless
       test would check. */
    expect(mixHex("#12408f", "#8a90a0", 0)).toBe("#12408f");
    expect(mixHex("#12408f", "#8a90a0", 100)).toBe("#8a90a0");
  });

  it("lands each channel between the two inputs", () => {
    /* THE PROPERTY THAT MAKES IT A BLEND rather than an arbitrary transform, checked per channel across the
       whole live palette -- a formula that overshot would still look plausible on one colour. */
    for (const livery of Object.values(CORPORATION_LIVERY_COLORS)) {
      const mixed = channels(mixHex(livery, TURN_ORDER_NEUTRAL_INK, TURN_ORDER_DESATURATION_PERCENT));
      const from = channels(livery);
      const to = channels(TURN_ORDER_NEUTRAL_INK);
      mixed.forEach((value, index) => {
        const low = Math.min(from[index], to[index]);
        const high = Math.max(from[index], to[index]);
        expect([livery, index, value >= low && value <= high]).toEqual([livery, index, true]);
      });
    }
  });

  it("always produces a valid six-digit hex", () => {
    /* THE FAILURE THAT WOULD REACH THE SCREEN AS NOTHING AT ALL: a channel serialised without padding gives
       `#f4a5` and CSS silently ignores it, leaving the chip at its inherited colour and the change invisible.
       Swept over every percent so a rounding that only bites at one blend cannot hide. */
    for (const livery of Object.values(CORPORATION_LIVERY_COLORS)) {
      for (let percent = 0; percent <= 100; percent += 1) {
        const mixed = mixHex(livery, TURN_ORDER_NEUTRAL_INK, percent);
        expect([livery, percent, /^#[0-9a-f]{6}$/.test(mixed)]).toEqual([livery, percent, true]);
      }
    }
    /* ==================================================================
        AND AGAINST BLACK, BECAUSE THE PALETTE SWEEP ABOVE PASSED THE CONTROL
       ==================================================================
       A negative control that removed `padStart(2, "0")` did NOT fail the loop above -- every channel of
       every corporation blended toward `#8a90a0` happens to land at or above 16, so every one serialises to
       two digits anyway. The sweep was describing the palette, not the function.
       BLENDING TOWARD BLACK IS WHAT FORCES A LOW CHANNEL, and a one-digit channel gives `#f4a5` -- which CSS
       silently ignores, leaving the chip its inherited colour and the whole change invisible. */
    for (let percent = 90; percent <= 100; percent += 1) {
      const mixed = mixHex("#12408f", "#000000", percent);
      expect([percent, /^#[0-9a-f]{6}$/.test(mixed)]).toEqual([percent, true]);
    }
  });

  it("keeps every channel in range", () => {
    for (const livery of Object.values(CORPORATION_LIVERY_COLORS)) {
      for (const value of channels(mixHex(livery, "#ffffff", 50))) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(255);
      }
    }
  });

  it("returns the input unchanged when a colour cannot be parsed", () => {
    /* A malformed livery must not become `#NaNNaNNaN`, which renders as nothing. Falling back to the input
       is visible and wrong; falling back to garbage is invisible and wrong. */
    expect(mixHex("not-a-colour", "#8a90a0", 50)).toBe("not-a-colour");
  });

  it("accepts three-digit hex", () => {
    expect(mixHex("#fff", "#000", 100)).toBe("#000000");
  });

  it("moves every corporation off both the neutral and its own livery", () => {
    /* THE TWO DEGENERATE OUTCOMES, ASKED OF THE ACTUAL FUNCTION THE CHIP CALLS. Equal to the neutral means
       the ruling was not implemented at all -- the chips would look exactly as #930 left them. Equal to the
       livery means "desaturated so they don't compete" was dropped. Both would pass a test that only checked
       the string was a colour. */
    for (const companyId of Object.keys(CORPORATION_LIVERY_COLORS).map(Number)) {
      const ink = desaturatedLiveryInk(companyId);
      expect([companyId, ink === TURN_ORDER_NEUTRAL_INK]).toEqual([companyId, false]);
      expect([companyId, ink === corporationLiveryColor(companyId)]).toEqual([companyId, false]);
    }
  });

  it("gives distinguishable inks to distinguishable liveries", () => {
    /* THE POINT OF THE FEATURE: "improve at-a-glance scanning". A blend so heavy that eight corporations
       collapse onto three inks would satisfy every case above and defeat the purpose. */
    const inks = new Set(
      Object.keys(CORPORATION_LIVERY_COLORS).map((id) => desaturatedLiveryInk(Number(id))),
    );
    expect(inks.size).toBe(Object.keys(CORPORATION_LIVERY_COLORS).length);
  });
});

describe("the OR header is one row (design note #946)", () => {
  const BAR = readStripped("panels/ContextualActionBar.tsx");
  const STYLES = readStripped("styles/appStyles.ts");

  it("puts the round label inside the progress row", () => {
    /* REPORTED: "'Operating Round 1.1' sits on its own line, with the subphase sequence and corporation turn
       order on a separate line below it." The label was a bare span BESIDE a block div, which is the whole
       bug -- so the assertion is that it is now inside it. */
    const row = sliceBetween(BAR, "<div style={styles.orProgressRow}>", "</div>");
    expect(row).toContain("styles.actionBarRoundLabel");
    expect(row).toContain("styles.subPhaseTrail");
    expect(row).toContain("styles.orTurnOrder");
  });

  it("opens exactly one progress row", () => {
    /* The old markup opened the row inside a condition and closed it after two more; a botched consolidation
       leaves two openings and React renders two lines again. */
    expect(BAR.match(/<div style=\{styles\.orProgressRow\}>/g)?.length ?? 0).toBe(1);
  });

  it("does not let the row wrap back onto a second line", () => {
    /* THE RULING IS "the exact same horizontal line", and `flexWrap: "wrap"` is the one property that can
       silently give the second line back at a narrow width. Both the row and the trail inside it must agree,
       or the inner one grows the outer one's height. */
    const row = sliceBetween(STYLES, "orProgressRow: {", "},");
    expect(row).toContain('flexWrap: "nowrap"');
    const trail = sliceBetween(STYLES, "subPhaseTrail: {", "},");
    expect(trail).toContain('flexWrap: "nowrap"');
  });

  it("keeps every fact reachable rather than clipping it", () => {
    /* #590'S RULE -- "wrapping or a smaller type scale, not deciding for the player which facts they may
       keep" -- honoured by the mechanism #930 already chose for the turn order: the row scrolls. Dropping
       the overflow would satisfy "one line" by hiding corporations. */
    const row = sliceBetween(STYLES, "orProgressRow: {", "},");
    expect(row).toContain('overflowX: "auto"');
  });
});

describe("inactive seats wear their own colour (design note #947)", () => {
  const TRAIL = readStripped("components/SeatOrderTrail.tsx");

  it("inks the name and the cash for a seat that is not acting", () => {
    /* RULED: "their names and cash amounts are rendered in their specific player colors". Two assertions
       because the ruling names two elements and colouring one is the likelier half-done state. */
    expect(TRAIL.match(/isCurrent \? \{\} : \{ color: seat\.color \}/g)?.length ?? 0).toBe(2);
  });

  it("leaves the acting seat's computed contrast ink alone", () => {
    /* THE HALF THAT MUST NOT CHANGE. The acting seat is FILLED with its colour and its ink comes from
       `bestContrastTextColor` against that fill -- writing the livery over it would be unreadable on half the
       palette, which is #389's lesson stated in this file's own terms. The guard is the `isCurrent ? {}`
       above; this pins the thing it is protecting. */
    expect(TRAIL).toContain("color: bestContrastTextColor(seat.color)");
  });
});

describe("inactive corporation chips wear a damped livery (design note #945)", () => {
  const BAR = readStripped("panels/ContextualActionBar.tsx");

  it("inks the chip from the shared blend", () => {
    expect(BAR).toContain("color: desaturatedLiveryInk(entry.companyId)");
  });

  it("applies it only to chips that are not operating", () => {
    /* THE ACTING CHIP IS FILLED and takes computed contrast ink; a livery ink written over that fill is the
       same unreadable pairing #389 warns about. */
    expect(BAR).toContain(
      "entry.companyId === activeCorporation?.companyId\n                      ? {}\n                      : { color: desaturatedLiveryInk(entry.companyId) }",
    );
  });

  it("keeps #930's uniform border and fill", () => {
    /* THE HALF OF #930 THAT STILL STANDS, and the reason this reversal is safe. That note stripped the livery
       because "eight unrelated objects" left no way to scan the row -- its evidence was about BORDER AND
       FILL, which stay uniform. Only the ink carries identity, so the strip still reads as one control. */
    const chip = sliceBetween(readStripped("styles/appStyles.ts"), "orTurnOrderChip: {", "},");
    /* Design note #1092 retoned the hairline; #930's claim is about the border being UNIFORM across the
       eight chips, not about its hue, so the assertion is the same one in a new colour. */
    expect(chip).toContain('border: "1px solid #2a2a2a"');
    expect(chip).toContain('backgroundColor: "#141414"');
  });
});

describe("a locked corporation card is dead, not merely refusing (design note #948)", () => {
  const PANEL = readStripped("components/StockRoundPanel.tsx");
  const APP = readStripped("App.tsx");

  it("carries the specified footer, verbatim", () => {
    expect(BO_LOCKED_CARD_NOTE).toBe(
      "Inactive until the BO private company is purchased in the Auction Round.",
    );
  });

  it("keeps the long refusal sentence as a separate string", () => {
    /* TWO AUDIENCES, TWO SENTENCES. `BO_LOCKED_REASON` answers a player who TRIED something and is owed the
       whole rule; the card note is a standing label read at a glance beside seven live cards. Collapsing them
       would put a paragraph on the card or a fragment in the refusal. */
    expect(BO_LOCKED_REASON).not.toBe(BO_LOCKED_CARD_NOTE);
    expect(BO_LOCKED_REASON.length).toBeGreaterThan(BO_LOCKED_CARD_NOTE.length);
  });

  it("renders the note on the card", () => {
    expect(PANEL).toContain("{BO_LOCKED_CARD_NOTE}");
    expect(PANEL).toContain("styles.rosterCardLockedNote");
  });

  it("makes the whole card refuse the pointer AND the keyboard", () => {
    /* BOTH, because neither alone is enough. `pointerEvents` on the card kills the mouse but leaves a
       tab-and-enter working; `disabled` on the button kills the keyboard but leaves the padding around it
       live, since the whole face is the toggle (#16/#26). */
    const locked = sliceBetween(PANEL, "rosterCardLocked: {", "},");
    expect(locked).toContain('pointerEvents: "none"');
    expect(PANEL).toContain("disabled={lockedCompanyIds.includes(company.company_id)}");
  });

  it("desaturates the whole card, not just the button", () => {
    /* RULED: "the entire card is desaturated". */
    const locked = sliceBetween(PANEL, "rosterCardLocked: {", "},");
    expect(locked).toContain("grayscale");
  });

  it("refuses to expand even if something else marked it active", () => {
    /* A `RevertTo` that rewinds into a round where this card was open would otherwise restore controls the
       lock has since taken away -- the state is not the shell's to trust here. */
    expect(PANEL).toContain("{isActive && !locked && cardActions}");
  });

  it("resolves the lock from boIsLocked rather than re-deriving it", () => {
    /* ONE AUTHORITY (#904). A card that asked `variants` and `private_auction_complete` itself would be the
       second implementation of a rule, which is this codebase's recurring fault -- and the two would drift
       the first time the auction's trigger moved, which has already happened once. */
    expect(APP).toContain("boIsLocked(");
    expect(APP).toContain("lockedCompanyIds={");
    expect(PANEL).not.toContain("boIsLocked");
    expect(PANEL).not.toContain("private_auction_complete");
  });

  it("is empty in a standard game", () => {
    /* The gate is the variant, so a table that did not choose the delayed auction sees eight live cards. The
       ternary's else-branch is what guarantees it. */
    const wiring = sliceBetween(APP, "lockedCompanyIds={", "publicCompanies={");
    expect(wiring).toContain(": []");
  });
});
