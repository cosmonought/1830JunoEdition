/** @jest-environment node */
//
// ==================================================================
//  CROSS-APP CONSISTENCY: THREE FINDINGS FROM THE STATIC EXPORT REVIEW
// ==================================================================
//
// An independent review of `_game-tabs-export/` compared the six game-room tabs against the Rules Reference
// and found three places where the live surfaces and the explanatory page disagreed about something neither
// of them meant to decide locally: a gold ink below the small-text contrast floor, a phase called two names,
// and two screens whose headings were spans. Each fix is asserted here against the thing that was actually
// wrong, not against the new value alone.

import fs from "fs";
import path from "path";

import { CARD_CAPTION_GOLD, CARD_CAPTION_GOLD_WASH, CARD_SURFACE, CARD_INK_FAINT, ROUND_ACCENT } from "../styles/palette";
import { DEPOT_SCHEDULE } from "../gameEngine/depotSchedule";
import { phaseLabel, phaseName, TIER_ORDER, LPF_TIER_ORDER } from "../gameEngine/gamePhase";

const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/* WCAG relative luminance and contrast, written out rather than imported: the point of the test is that the
   number is computed here from the shipped hex, not quoted from a comment. That is exactly how #1171's
   "5.9:1" survived being wrong. */
function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const channel = (pair: string) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(v.slice(0, 2)) + 0.7152 * channel(v.slice(2, 4)) + 0.0722 * channel(v.slice(4, 6));
}
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("the auction caption gold clears the small-text floor", () => {
  it("reaches 4.5:1 on the ground it is actually printed on", () => {
    /* Every one of the eighteen occurrences in the auction dashboard computes against `CARD_SURFACE`,
       including the sold cards. `#8a7332` was 4.03:1 there, not the 5.9:1 the old note claimed. */
    expect(contrast(CARD_CAPTION_GOLD, CARD_SURFACE)).toBeGreaterThanOrEqual(4.5);
    /* With a margin, rather than a value that merely rounds to the floor. */
    expect(contrast(CARD_CAPTION_GOLD, CARD_SURFACE)).toBeGreaterThan(4.8);
  });

  it("is still the quieter ink on the card", () => {
    /* Legible, not promoted: the neutral caption ink elsewhere on these cards is darker still, so the gold
       caption has not become the loudest thing on a card it only labels. */
    expect(contrast(CARD_CAPTION_GOLD, CARD_SURFACE)).toBeLessThan(contrast(CARD_INK_FAINT, CARD_SURFACE));
  });

  it("stays gold rather than drifting to olive or to brown", () => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(CARD_CAPTION_GOLD.slice(i, i + 2), 16));
    /* Hue held at ~44 degrees, the same gold; only the value moved. */
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const hue = (60 * ((g - b) / (max - min))) % 360;
    expect(max).toBe(r);
    expect(hue).toBeGreaterThan(40);
    expect(hue).toBeLessThan(50);
  });

  it("keeps the wash the same colour as the ink it is named after", () => {
    /* The constant's own comment calls it "the caption gold at 9%", so the two cannot be allowed to part. */
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(CARD_CAPTION_GOLD.slice(i, i + 2), 16));
    expect(CARD_CAPTION_GOLD_WASH).toBe(`rgba(${r}, ${g}, ${b}, 0.09)`);
  });

  it("covers the interactive disclosure as well as the caption, because they are one ink", () => {
    const block = src("components/SpecialPowerBlock.tsx");
    expect(block).toContain("color: captionInk }}>Special power<");
    expect(block).toContain("style={{ ...styles.disclosure, color: captionInk }}");
  });

  it("does not repaint the live auction violet, and now says so by name", () => {
    /* The Rules Reference marks its auction PROCEDURE in violet; the live auction's own identity is gold.
       This pass darkened one ink and touched neither.

       THE EVIDENCE CHANGED SHAPE, AND THE CLAIM DID NOT. This case used to prove the separation by checking
       that `#c08ae8` was ABSENT from `palette.ts`, which held for as long as the violet lived only inside
       `RulesReference.tsx`. Design note #1626 moved the three round hues into the palette deliberately, so
       the game-room tab strip could spend the same violet (#1627) rather than retype it -- and absence
       stopped being available as evidence.
       WHAT THE CASE WAS ALWAYS ABOUT is that the ROUND hue and the LIVE AUCTION's ink are two different
       things, so that is what it asserts now, in a form a colour sweep cannot satisfy by accident: the
       violet is a named round token, the gold is not it, the violet is spelled exactly once in the whole
       palette, and the auction dashboard -- the live auction's own surface -- still wears no round hue. */
    const palette = src("styles/palette.ts");
    expect(ROUND_ACCENT.auction.ink).toBe("#c08ae8");
    expect(CARD_CAPTION_GOLD).not.toBe(ROUND_ACCENT.auction.ink);
    expect(palette.match(/#c08ae8/g)).toHaveLength(1);
    expect(src("components/WaterfallAuctionDashboard.tsx")).not.toContain("#c08ae8");
  });
});

describe("one place decides what a phase is called", () => {
  it("names every printed tier the way the badge names it", () => {
    expect(TIER_ORDER.map(phaseLabel)).toEqual(["Phase 2", "Phase 3", "Phase 4", "Phase 5", "Phase 6", "Phase D"]);
  });

  it("gives the Level Playing Field's 7-train no phase of its own", () => {
    /* #1326: the 7-train has no effect, so it wears the 6's number -- and `phaseLabel` gets that for free
       from `phaseNumber`, which is the whole reason the caller does not decide. */
    expect(phaseLabel("7")).toBe("Phase 6");
    expect(LPF_TIER_ORDER.map(phaseLabel)).toContain("Phase D");
  });

  it("makes the Game Ledger's depot row agree with the badge", () => {
    /* WAS "Diesel Era", while the badge and the Rules Reference both said Phase D -- and while the app's own
       phase-shift warning already said "Phase D (Diesel)". THREE spellings of one phase, so the fix is the
       spelling the app already used, not a fourth. */
    expect(DEPOT_SCHEDULE.D.phase).toBe("Phase D (Diesel)");
    expect(DEPOT_SCHEDULE.D.phase).toBe(phaseName("D"));
    expect(Object.values(DEPOT_SCHEDULE).map((row) => row.phase)).not.toContain("Diesel Era");
  });

  it("leaves the other five rows exactly as they read before", () => {
    expect(["2", "3", "4", "5", "6"].map((tier) => DEPOT_SCHEDULE[tier].phase)).toEqual([
      "Phase 2",
      "Phase 3",
      "Phase 4",
      "Phase 5",
      "Phase 6",
    ]);
  });

  it("keeps the gloss the note defends, on the one phase that has one", () => {
    /* `THE PHASE IS NOT THE TRAIN` (gamePhase.ts) says "Diesel" may appear in a PHASE label. It still does --
       in one place now instead of two, which is the boundary held and the drift removed. */
    expect(phaseName("D")).toBe("Phase D (Diesel)");
    expect(TIER_ORDER.filter((tier) => phaseName(tier) !== phaseLabel(tier))).toEqual(["D"]);
  });

  it("derives the cell rather than keeping a second list", () => {
    const depot = src("gameEngine/depotSchedule.ts");
    expect(depot).toContain('import { phaseName, type TrainTier } from "./gamePhase"');
    /* No hand-written phase strings left in the schedule, nor in the phase-shift warning beside it. */
    expect(depot).not.toMatch(/phase: "Phase \d"/);
    expect(depot).not.toContain('phase: "Diesel Era"');
    expect(src("gameEngine/gamePhase.ts")).not.toMatch(/phase: "Phase [^"]*"/);
  });

  it("changes no tier key, transition or variant", () => {
    const phase = src("gameEngine/gamePhase.ts");
    expect(TIER_ORDER).toEqual(["2", "3", "4", "5", "6", "D"]);
    expect(LPF_TIER_ORDER).toEqual(["2", "3", "4", "5", "6", "7", "D"]);
    /* `phaseLabel` reads the presentation table; it does not own a second one. */
    expect(phase).toContain("return `Phase ${TIER_PRESENTATION[tier].phaseNumber ?? tier}`;");
  });
});

describe("Stocks and Stock Market expose headings, at the same levels the other tabs use", () => {
  it("makes the Stocks roster heading a heading", () => {
    const panel = src("components/StockRoundPanel.tsx");
    expect(panel).toContain("<h2 style={styles.sectionLabel}>Corporations</h2>");
    expect(panel).not.toContain("<span style={styles.sectionLabel}>Corporations</span>");
  });

  it("makes the Stock Market page heading a heading, with its section under it", () => {
    const market = src("components/StockMarketRenderer.tsx");
    expect(market).toContain("<h2 style={styles.headerTitle}>Stock Market</h2>");
    expect(market).toContain("<h3 style={styles.parTrayTitle}>Par / IPO Tray</h3>");
    expect(market).not.toContain("<span style={styles.headerTitle}>");
    expect(market).not.toContain("<span style={styles.parTrayTitle}>");
  });

  it("zeroes the margin on each promoted style, so nothing moves", () => {
    /* A heading brings a user-agent margin a span never had. Font size, weight, tracking and colour are all
       already set by these objects and are untouched; only the margin is added. */
    const panel = src("components/StockRoundPanel.tsx");
    const market = src("components/StockMarketRenderer.tsx");
    expect(panel).toMatch(/sectionLabel: \{[^}]*margin: 0,/s);
    expect(market).toMatch(/headerTitle: \{[^}]*margin: 0,/s);
    expect(market).toMatch(/parTrayTitle: \{[^}]*margin: 0,/s);
  });

  it("promotes only the two labels named, not every caption on the screens", () => {
    /* The compass legend, the par-tray hint and the card metrics stay spans: they label a control or a
       figure, not a section of the page. */
    const market = src("components/StockMarketRenderer.tsx");
    expect(market).toContain("<span style={styles.compassTitle}>Which way a token moves</span>");
    expect((market.match(/<h[1-6] /g) ?? []).length).toBe(2);
    const panel = src("components/StockRoundPanel.tsx");
    expect((panel.match(/<h[1-6] /g) ?? []).length).toBe(2); // the same heading in both roster branches
  });
});
