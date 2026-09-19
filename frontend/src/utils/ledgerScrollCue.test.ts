/** @jest-environment node */
//
// ==================================================================
//  MOBILE PASS: THE LEDGER'S HIDDEN COLUMNS, AND THE TILE CATALOG'S HEIGHT
// ==================================================================
//
// Two narrow-width faults, measured in the live app before anything was written:
//   1. at 430 the Game Ledger's three tables are 480, 986 and 1265 CSS px inside a 309px pane, putting their
//      last columns 171, 677 and 956px past the right edge with nothing on screen saying so;
//   2. the Tiles grid fell to ONE column at 430 -- a 306px track holding an 84px tile -- for a page 8,902px
//      tall, because two 152px tracks plus a 12px gap wanted 316px and the pane is 306.
// These are source-level claims about the fixes. The pixel measurements are in the pass report; what a test
// can hold is that the rules which produce them are still the rules.

import fs from "fs";
import path from "path";

import { SIDEWAYS_CUE } from "../components/SidewaysScroller";

const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

describe("a table that scrolls says so", () => {
  it("uses the words the Rules Reference already uses for this", () => {
    /* A player who has met this line on the Rules Reference tab should not have to learn a second
       vocabulary for the same fact. */
    expect(SIDEWAYS_CUE).toBe("Scroll sideways for the rest of the table →");
    expect(src("components/RulesReference.tsx")).toContain("Scroll sideways for the rest of the table");
  });

  it("measures rather than guessing at a width", () => {
    /* A breakpoint would be a guess about when a table is wider than its pane, and the answer moves with the
       chrome's zoom, the column set and the tab. */
    const scroller = src("components/SidewaysScroller.tsx");
    expect(scroller).toContain("node.scrollWidth > node.clientWidth + 1");
    expect(scroller).toContain("ResizeObserver");
    expect(scroller).not.toContain("@media");
    expect(scroller).not.toMatch(/innerWidth\s*[<>]/);
  });

  it("wraps all four of the Ledger's tables, and keeps none of the old bare wrapper", () => {
    const ledger = src("components/FinancialLedger.tsx");
    expect(ledger.split("<SidewaysScroller label=").length - 1).toBe(4);
    expect(ledger.split("</SidewaysScroller>").length - 1).toBe(4);
    for (const label of ["Bank Treasury", "Bank Depot Train Inventory", "Player Assets", "Corporation Assets"]) {
      expect(ledger).toContain(`<SidewaysScroller label="${label}">`);
    }
    /* The old `<div style={styles.tableScroll}>` is gone from the call sites. */
    expect(ledger).not.toContain("<div style={styles.tableScroll}>");
  });

  it("is reachable by keyboard, and only when there is somewhere to go", () => {
    /* An `overflow-x: auto` div is not a tab stop in every engine, so a keyboard-only player could see the
       cue and have no way to act on it. And a tab stop on a table that fits is a stop that does nothing. */
    const scroller = src("components/SidewaysScroller.tsx");
    expect(scroller).toContain("tabIndex={scrolls ? 0 : undefined}");
    expect(scroller).toContain('role={scrolls ? "region" : undefined}');
    expect(scroller).toContain("aria-label={scrolls ? `${label} — scrolls sideways` : undefined}");
  });

  it("keeps the data and the column order untouched", () => {
    /* The fix is a cue and a scroll region, not a narrower table: no column was dropped, reordered or
       squeezed, so the table's own minimum still stands. */
    const ledger = src("components/FinancialLedger.tsx");
    expect(ledger).toContain('minWidth: "480px"');
    expect(ledger).toContain("<th style={styles.thB}>Metric</th>");
    expect(ledger).toContain("<th style={styles.thCenterB}>Tier</th>");
  });
});

describe("a clipped table does not widen the page", () => {
  it("contains the region's layout, which is what the viewport was counting", () => {
    /* MEASURED at 430 before the fix: `documentElement.scrollWidth` 583 against a 430 viewport and
       `window.scrollX` reaching 153 -- on a page where no element has an unclipped right edge past 430 and
       where the 153px strip, probed with `elementsFromPoint`, is empty. A clipped scroller's descendants were
       still contributing their intrinsic width to the initial containing block's scrollable overflow.
       AFTER: 430 / 430, `scrollX` 0, with all three scrollers unchanged at 309/480, 309/986 and 309/1265. */
    const scroller = src("components/SidewaysScroller.tsx");
    expect(scroller).toMatch(/region: \{[^}]*contain: "layout",/s);
  });

  it("contains layout and not paint, because these cells are allowed to overhang", () => {
    /* Both fix the number. `paint` would additionally clip everything drawn inside the box, and the
       Corporation Assets cells carry train chips and private-company pills. */
    const scroller = src("components/SidewaysScroller.tsx");
    expect(scroller).not.toContain('contain: "paint"');
    expect(scroller).not.toContain('contain: "strict"');
    expect(scroller).not.toContain('contain: "content"');
  });

  it("fixes it on the region rather than by hiding it on the document or the shell", () => {
    /* A blanket `overflow-x: hidden` up there would hide the symptom for every tab -- including the Rail Map,
       whose panning depends on that overflow -- and would hide legitimate content with it. */
    const scroller = src("components/SidewaysScroller.tsx");
    const ledger = src("components/FinancialLedger.tsx");
    expect(scroller).not.toContain("document.documentElement.style");
    expect(scroller).not.toContain("document.body.style");
    expect(ledger).not.toMatch(/root: \{[^}]*overflowX: "hidden"/s);
    expect(ledger).not.toMatch(/root: \{[^}]*overflow: "hidden"/s);
  });

  it("leaves the tables their own width, which is the thing being scrolled", () => {
    /* The fix is containment, not a narrower table: the 480px minimum and every column survive it. */
    const ledger = src("components/FinancialLedger.tsx");
    expect(ledger).toContain('minWidth: "480px"');
    const scroller = src("components/SidewaysScroller.tsx");
    expect(scroller).toContain('overflowX: "auto"');
    expect(scroller).toContain("minWidth: 0");
  });
});

describe("the tile catalog fits two columns on a phone", () => {
  it("caps the column minimum at half a row rather than at a breakpoint", () => {
    /* `(100% - 12px) / 2` binds only while half a row is narrower than the desktop minimum -- any pane under
       316px. At 900 it resolves to 444 and at 1476 to 732, so `min()` returns the desktop figure and every
       wider layout is unchanged. */
    const tiles = src("components/TileReference.tsx");
    expect(tiles).toContain("minmax(min(${TRAY_TILE_PX + 68}px, calc((100% - 12px) / 2)), 1fr)");
    expect(tiles).not.toContain("@media");
  });

  it("does not shrink the artwork to buy the second column", () => {
    /* `TRAY_TILE_PX` is 84 at every width; the column minimum is label room, not tile size. */
    const tiles = src("components/TileReference.tsx");
    expect(tiles).toContain("const TRAY_TILE_PX = 84;");
    expect(tiles).toContain("<TilePreviewThumbnail tileId={tileId} orientation={0} size={TRAY_TILE_PX} />");
  });

  it("gives every section an anchor and the directory a generated entry for each", () => {
    const tiles = src("components/TileReference.tsx");
    expect(tiles).toContain('id="tiles-section-printed"');
    expect(tiles).toContain("id={`tiles-section-${tier.toLowerCase()}`}");
    /* Generated from the trays this game actually deals, so a link cannot point at a tray that is not there
       -- Gray appears only under the 18XX+ tile set, and appears in the directory only then. */
    expect(tiles).toContain("TIERS.filter((tier) => byTier.has(tier)).map((tier) => ({");
    expect(tiles).toContain('data-testid="tiles-directory"');
  });

  it("is a row of names, not another panel", () => {
    const tiles = src("components/TileReference.tsx");
    expect(tiles).toMatch(/directory: \{[^}]*borderTop: "1px solid #2a2a2a",/s);
    expect(tiles).not.toMatch(/directory: \{[^}]*backgroundColor/s);
    /* Buttons rather than `#id` links, because the shell scrolls its own pane and a hash jump would move the
       wrong box. */
    expect(tiles).toContain('target.scrollIntoView({ block: "start", behavior: "smooth" })');
  });

  it("keeps the tray identity and the quantities the catalog is for", () => {
    const tiles = src("components/TileReference.tsx");
    expect(tiles).toContain("color: TIER_INK[tier]");
    expect(tiles).toContain("const TIERS: readonly TileColorTier[] = [\"Yellow\", \"Green\", \"Brown\", \"Gray\"]");
  });
});
