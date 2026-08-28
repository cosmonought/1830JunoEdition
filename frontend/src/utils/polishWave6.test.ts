/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 951-955 (harness): FOUR UX REFINEMENTS
// ==================================================================
//
// ONE OF THESE IS A FUNCTION AND THREE ARE MARKUP, and the split decides the shape of each block below.
//
//   #955's frame choice is a PURE DECISION with a defined answer for every input, so it is driven directly.
//   Its failure modes are orderings -- home before buildable, buildable before network -- and an ordering is
//   only testable by supplying two candidates at once and seeing which survives, which no source scan does.
//
//   #951 (the price row), #952 (the passed badge) and #953/#954 (the overlay) are structure and style
//   literals. What CAN break is a row rendered outside the block it was meant to join, a badge that kept a
//   background fill, an animation delay that outlives the window it plays in -- all readable in the source
//   and none observable in a node environment.

import { chooseFrameKeys } from "./frameHexes";
import { readStripped, sliceBetween } from "./sourceScan";

describe("the Lay Track jump goes home (design note #955)", () => {
  const NETWORK = new Set(["10,10", "11,11"]);
  const BUILDABLE = new Set(["5,5", "6,6"]);

  it("frames the home station when there is one", () => {
    /* REPORTED: "target the specific DOM node (or grid coordinate) of that corporation's Home Station hex,
       centering that hex in the viewport." Supplied ALONGSIDE the other two candidates, because the ruling is
       about which WINS -- a test passing only `home` would pass against an implementation that ignored the
       ordering entirely. */
    expect(
      chooseFrameKeys({
        home: "3,4",
        buildable: BUILDABLE,
        network: NETWORK,
        stations: ["9,9"],
      }),
    ).toEqual(["3,4"]);
  });

  it("frames exactly one hex, not a bounding box", () => {
    /* "CENTERING THAT HEX" IS A SINGLE POINT. Returning home plus the network would centre their midpoint,
       which is not the home station and would drift as track is laid. */
    expect(chooseFrameKeys({ home: "3,4", network: NETWORK })).toHaveLength(1);
  });

  it("falls back to #888's ordering when there is no home", () => {
    /* THE HALF OF #888 THAT SURVIVES. Its argument -- the buildable set is the decision the player is
       standing in front of -- is still the right answer when the board cannot say where home is. */
    expect(chooseFrameKeys({ home: null, buildable: BUILDABLE, network: NETWORK })).toEqual([
      "5,5",
      "6,6",
    ]);
    expect(chooseFrameKeys({ buildable: BUILDABLE, network: NETWORK })).toEqual(["5,5", "6,6"]);
  });

  it("keeps the rest of the ladder intact", () => {
    /* THE TWO LOWER RUNGS, unchanged: network when nothing is buildable, stations as the last resort -- the
       one that is non-empty from the moment a corporation floats. */
    expect(chooseFrameKeys({ network: NETWORK, stations: ["9,9"] })).toEqual(["10,10", "11,11"]);
    expect(chooseFrameKeys({ stations: ["9,9"] })).toEqual(["9,9"]);
    expect(chooseFrameKeys({})).toEqual([]);
  });

  it("treats an empty home string as absent", () => {
    /* `home_hex_label` is optional on the chain (#232), and `""` is what a partially-populated record looks
       like. An empty key would frame a hex that does not exist -- silently, since `frameHexes` would take the
       one-point path and centre on nothing. */
    expect(chooseFrameKeys({ home: "", buildable: BUILDABLE })).toEqual(["5,5", "6,6"]);
  });

  it("resolves the home label through the board's own table", () => {
    /* THE WIRING, because the function above cannot see whether the shell gives it a real key. A second
       label-to-coordinate map would be the fault this codebase keeps finding; `STATIC_BOARD_HEXES` is what
       every other lookup in that file uses. */
    const APP = readStripped("App.tsx");
    const block = sliceBetween(APP, "const homeKey = (() => {", "return chooseFrameKeys({");
    expect(block).toContain("corporation?.home_hex_label");
    expect(block).toContain("STATIC_BOARD_HEXES.find");
    expect(APP).toContain("home: homeKey,");
  });
});

describe("the sale's two consequences share one table (design note #951)", () => {
  const PANEL = readStripped("components/StockRoundPanel.tsx");

  it("renders the price row inside the projection block", () => {
    /* REPORTED: "Move this information directly into the single-row transaction table that currently shows
       the player's cash changes." The row must be INSIDE `TreasuryProjectionBlock`, not a sibling below it. */
    const block = sliceBetween(PANEL, "function TreasuryProjectionBlock({", "\n}\n");
    expect(block).toContain("marketMove &&");
    expect(block).toContain("Share Value");
  });

  it("uses the block's own label and figure styles", () => {
    /* THE FORMATTING COMPLAINT'S ACTUAL CAUSE -- "unformatted, lacks spacing, and renders in a default system
       font". The old row had its own `saleMarket*` styles and never picked up the block's treatment. Reusing
       `projectionLabel` and `projectionFigures` is what makes the font and spacing follow automatically. */
    const block = sliceBetween(PANEL, "function TreasuryProjectionBlock({", "\n}\n");
    expect(block).toContain("styles.projectionLabel");
    expect(block).toContain("styles.projectionFigures");
  });

  it("has retired the standalone row and its styles", () => {
    /* AS AN ABSENCE, on a comment-stripped copy (#490a) so #951's own note explaining the removal cannot
       satisfy the search. A surviving `saleMarketMove` div would render the price twice. */
    expect(PANEL).not.toContain("styles.saleMarketMove");
    expect(PANEL).not.toContain("saleMarketLabel");
    expect(PANEL).not.toContain("saleMarketArrow");
  });

  it("names the corporation on the price row", () => {
    /* SPECIFIED: "`[Corp] Share Value: $76 ↓ $71`". Two unlabelled rows in one block would be ambiguous about
       whose money each describes -- the cash row is the PLAYER's. */
    const block = sliceBetween(PANEL, "function TreasuryProjectionBlock({", "\n}\n");
    expect(block).toContain("{marketMove.ticker} Share Value");
  });

  it("keeps the zone tint by rendering ZonedPrice itself", () => {
    /* #713 ARGUED THE TINT CARRIES A RULE -- "a sale that drops a corporation INTO the Yellow zone says so".
       Passing a ready-made element in would have put the formatting back at the call site, which is the thing
       being fixed; passing DATA and rendering here keeps both. */
    const block = sliceBetween(PANEL, "function TreasuryProjectionBlock({", "\n}\n");
    expect(block.match(/<ZonedPrice price=\{marketMove\./g)?.length ?? 0).toBe(2);
  });

  it("still says so when the token cannot fall", () => {
    /* #743a'S RULE, WORD FOR WORD: "An absent row cannot be told from a missing feature." The floor case has
       to survive the move, and the call site is what normalises it -- `after === marketPrice` becomes `null`. */
    const block = sliceBetween(PANEL, "function TreasuryProjectionBlock({", "\n}\n");
    expect(block).toContain("already at the bottom of its column");
    expect(PANEL).toContain("after: after === marketPrice ? null : after,");
  });

  it("keeps the down arrow the sale earned", () => {
    /* #713: "DOWN, not right. The dividend line's arrow is horizontal because a declaration moves the token
       one column left or right; a sale moves it one row DOWN per certificate." */
    const block = sliceBetween(PANEL, "function TreasuryProjectionBlock({", "\n}\n");
    expect(block).toContain("↓");
    expect(block).toContain("→");
  });
});

describe("the passed badge sits at the end (design note #952)", () => {
  const TRAIL = readStripped("components/SeatOrderTrail.tsx");

  it("renders after the cash and escrow figures", () => {
    /* REPORTED: "`P1[PASSED]$176` ... formatting it as `P1 $176 [PASSED]`". Asserted as an ORDER, which is
       the whole of the fix -- the badge's own markup never changed. */
    const segment = sliceBetween(TRAIL, "{seat.label}", "</span>\n            </li>");
    expect(segment.indexOf("styles.cash")).toBeGreaterThan(-1);
    expect(segment.indexOf("styles.passedTag")).toBeGreaterThan(segment.indexOf("styles.cash"));
    expect(segment.indexOf("styles.passedTag")).toBeGreaterThan(segment.indexOf("styles.escrow"));
  });

  it("wears no background fill", () => {
    /* RULED: "Do not use background color changes to indicate passing, as that will conflict with the player
       text colors." #947 made that collision real rather than hypothetical -- every inactive seat now renders
       in its own colour, so a filled badge would sit behind six different palettes. */
    const badge = sliceBetween(TRAIL, "passedTag: {", "},");
    expect(badge).toContain('backgroundColor: "transparent"');
    expect(badge).toContain("border:");
  });

  it("is pushed to the end of the segment", () => {
    /* "ALIGNED TO THE END", mechanically. A passed seat may or may not carry an escrow figure, so anchoring
       to the END is what keeps the badge in one column down the row. */
    const badge = sliceBetween(TRAIL, "passedTag: {", "},");
    expect(badge).toContain('marginLeft: "auto"');
  });

  it("keeps the strike on the name", () => {
    /* #610'S OTHER HALF, which survives the reorder: the strike and the badge are two cues for one state, and
       moving the badge to the end does not remove the reason the name is struck. */
    expect(TRAIL).toContain("styles.seatNamePassed");
    expect(TRAIL).toContain("textDecoration: \"line-through\"");
  });
});

describe("the overlay is shorter, smaller and moves (design notes #953/#954)", () => {
  const FLASH = readStripped("components/RevenueModifierFlash.tsx");
  const ANIM = readStripped("styles/animations.ts");

  it("shows for 700ms", () => {
    /* RULED, after a revision: "reduce the display duration from 2000ms to 500ms", then "If you want to make
       it 700 or 800ms we can try that as well. I just think the rule of thumb is that a juice notification
       should be readable ~1.5x before it goes away." 700 with a 200ms fade leaves ~500ms fully legible. */
    expect(FLASH).toContain("export const REVENUE_FLASH_MS = 700;");
  });

  it("shrinks the fade with the window", () => {
    /* THE PART THAT WOULD HAVE BEEN MISSED. The fade was 400ms, set against a 2000ms window. Left alone at
       500ms it would have consumed four fifths of the display; even at 700 it would leave 300ms. Legible time
       is the window MINUS the fade, so the two constants have to move together. */
    expect(FLASH).toContain("export const REVENUE_FLASH_FADE_MS = 200;");
    const window = Number(FLASH.match(/REVENUE_FLASH_MS = (\d+)/)?.[1]);
    const fade = Number(FLASH.match(/REVENUE_FLASH_FADE_MS = (\d+)/)?.[1]);
    expect(window - fade).toBeGreaterThanOrEqual(450);
  });

  it("reduces the type ceiling", () => {
    expect(FLASH).toContain("clamp(40px, 10vw, 104px)");
    expect(FLASH).not.toContain("132px");
  });

  it("floats arrows the right way for each direction", () => {
    /* RULED: "For bonuses (green), include subtle up-arrows floating upward around the text. For maluses
       (red), include down-arrows floating downward." Both the GLYPH and the KEYFRAME have to follow the
       direction -- an up-arrow animated downward is the plausible half-done state. */
    expect(FLASH).toContain('animationName: bonus ? "app-revenue-arrow-up" : "app-revenue-arrow-down"');
    expect(FLASH).toContain('{bonus ? "\\u25B2" : "\\u25BC"}');
    expect(ANIM).toContain("@keyframes app-revenue-arrow-up");
    expect(ANIM).toContain("@keyframes app-revenue-arrow-down");
  });

  it("animates the two directions in opposite senses", () => {
    /* THE KEYFRAMES THEMSELVES, not just their names. Two identically-bodied keyframes with opposite names
       would satisfy the case above and drift both sets of arrows the same way. */
    /* SLICED TO THE NEXT BLOCK, not to the next `}`. A keyframe body nests braces, so `sliceBetween(..., "}")`
       returns only the `0%` rule -- which contains neither figure and made this case fail against correct
       code. Recorded because the same anchor reads as obviously right and is obviously wrong here. */
    const up = sliceBetween(ANIM, "@keyframes app-revenue-arrow-up {", "@keyframes app-revenue-arrow-down");
    const down = sliceBetween(ANIM, "@keyframes app-revenue-arrow-down {", "@keyframes app-revenue-figure-in");
    expect(up).toContain("translateY(-46px)");
    expect(down).toContain("translateY(46px)");
    /* AND EACH STARTS FROM THE OPPOSITE SIDE, or both would drift the same way from a shared origin. */
    expect(up).toContain("translateY(14px)");
    expect(down).toContain("translateY(-14px)");
  });

  it("starts every arrow inside the display window", () => {
    /* AN ARROW WHOSE DELAY OUTLIVES THE OVERLAY IS PAID FOR AND NEVER SEEN, and nothing on screen would say
       so -- it simply renders five arrows instead of six. Read from the same constant the component uses so
       shortening the window again cannot silently orphan one. */
    const window = Number(FLASH.match(/REVENUE_FLASH_MS = (\d+)/)?.[1]);
    /* `match(/g)` AND A SECOND PARSE, not `matchAll` spread into an array. This project targets ES5 without
       `downlevelIteration`, so spreading an iterator does not compile -- and Jest's transpile accepts it, so
       the failure appears only in `tsc`. The same constraint `frameHexes` and `hexCanvasPrimitives` both
       record for `Set`; it applies to `matchAll`'s iterator for the same reason. */
    const delays = (FLASH.match(/delay: \d+/g) ?? []).map((entry) =>
      Number(entry.replace(/\D/g, "")),
    );
    expect(delays.length).toBe(6);
    for (const delay of delays) expect(delay).toBeLessThan(window);
  });

  it("animates only compositor properties", () => {
    /* THIS FIRES IMMEDIATELY AFTER A DISPATCH LOOP that has just rewritten the board. `transform` and
       `opacity` animate off the main thread; `top`/`left`/`width` would force layout on the one frame where
       the app is busiest. The arrows' `left`/`top` are STATIC positions, set once and never animated. */
    const up = sliceBetween(ANIM, "@keyframes app-revenue-arrow-up {", "@keyframes app-revenue-arrow-down");
    const down = sliceBetween(ANIM, "@keyframes app-revenue-arrow-down {", "@keyframes app-revenue-figure-in");
    for (const frames of [up, down]) {
      expect(frames).not.toContain("width:");
      expect(frames).not.toContain("height:");
      expect(frames).not.toContain("margin");
    }
  });

  it("yields to prefers-reduced-motion", () => {
    /* THE ONE CASE WHERE MOTION IS THE FEATURE AND STILL HAS TO YIELD. The figure and its colour carry the
       fact without any of it. */
    expect(ANIM).toContain("@media (prefers-reduced-motion: reduce)");
    const reduced = sliceBetween(ANIM, "@media (prefers-reduced-motion: reduce) {", "\n}");
    expect(reduced).toContain("animation: none");
  });

  it("keeps the arrows decorative to a screen reader", () => {
    /* The figure beside them already carries the fact; six announced arrows would be strictly worse than one
       announced percentage. */
    expect(FLASH).toContain('aria-hidden="true"');
  });

  it("still refuses the pointer", () => {
    /* #940'S RULE, re-asked because this batch added elements to the overlay -- a new absolutely-positioned
       child is exactly the kind of thing that reintroduces a click target over the board. */
    const arrow = sliceBetween(ANIM, ".app-revenue-arrow {", ".app-revenue-figure");
    expect(arrow).toContain("pointer-events: none");
  });
});
