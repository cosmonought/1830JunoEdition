/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1627 (harness): THE STRIP LEARNS THE REFERENCE'S VOCABULARY
// ==================================================================
//
// The Rules Reference teaches a player that the auction is violet, the Stock Round blue and the Operating
// Round magenta, and until this slice that vocabulary stopped at the reference's own door. The game-room tab
// strip now carries it as a 2px rule on the inner top edge of the three tabs that are those rounds' own
// surfaces.
//
// FOUR THINGS COULD GO WRONG HERE AND EACH HAS ITS OWN CASE.
// (1) THE MAPPING COULD BE ASSIGNED FROM LABELS. "Stock Market" contains the word Stock; it is not the Stock
//     Round's surface. So the mapping is asserted as an INVERSION of `surfaceTabFor` -- the function that
//     already decides which tab each round acts in -- rather than against a list typed out here, and a case
//     below proves the two cannot disagree.
// (2) THE COLOURS COULD BE RETYPED. Three near-matching purples is the failure this repo has already paid
//     for twice (`palette.ts` #1092's five near-white cards, #1184's two definitions). The hues live in
//     `palette.ts` as `ROUND_ACCENT` and a case scans both consumers for the literals.
// (3) THE ACCENT COULD START MEANING "SELECTED" or "current round". It is constant across active, inactive
//     and every round, which is asserted directly, and `roundAffinityFor` takes no round argument at all.
// (4) IT COULD MOVE THE STRIP. The treatment is an inset box-shadow and nothing else, which is why the
//     measured before/after tab rectangles are identical at 360, 390, 430, 1024 and 1440
//     (`_round-affinity-capture/00-SHOTS.md`). The code half of that claim is here: the style function
//     returns exactly one property, and it is not a layout one.
//
// This repo has no component renderer (`depotTierHeading.test.ts` says why), so the wiring half is a source
// scan and the decisions are tested as the pure functions they are.
//
// ==================================================================
//  DESIGN NOTE 1628 (harness): THE OTHER FOUR ARE A FAMILY, NOT AN ABSENCE
// ==================================================================
//
// REPORTED: the strip read as "three decorated tabs and four unfinished ones". Every case above about the
// three round hues still holds unchanged -- what changed is that the remaining four now share ONE muted warm
// accent of their own (`palette.ts` #1628), on the same 2px inset top rule.
//
// THE FIFTH THING THAT COULD GO WRONG, and the reason for the new section below:
// (5) A TAB COULD FALL BETWEEN THE FAMILIES, OR INTO BOTH. With two treatments instead of one-and-nothing,
//     "neutral" stops being a safe default -- a new tab, or a `surfaceTabFor` change, could leave something
//     with no accent or with two. So the families are asserted to PARTITION the tab set: disjoint, exhaustive,
//     and derived from one function rather than from two lists that can disagree.

import {
  TAB_ACCENT_RULE_PX,
  isPlayingSurface,
  orderedMainTabs,
  roundAffinityFor,
  tabAccentFamilyFor,
  tabAccentInk,
  tabAccentStyle,
  surfaceTabFor,
  type MainTab,
} from "../components/MainTabBar";
import { ROUND_ACCENT, UTILITY_ACCENT } from "../styles/palette";
import type { RoundType } from "../gameEngine/gameState";
import { readStripped } from "./sourceScan";

const ROUNDS: readonly RoundType[] = ["WaterfallAuction", "StockRound", "OperatingRound"];
const EVERY_TAB: readonly MainTab[] = ["phase", "corps", "map", "stock", "ledger", "rules", "tiles"];
/** The three acting surfaces, which wear a ROUND-specific hue. */
const ACCENTED: readonly MainTab[] = ["phase", "corps", "map"];
/** #1628: the supporting surfaces, which share one accent. Not "neutral" any more -- they are accented, just
 *  not by a round. The name matters because "neutral" is what made the absence look like an omission. */
const UTILITY: readonly MainTab[] = ["stock", "ledger", "rules", "tiles"];

describe("1. the semantic mapping: one round, one acting surface", () => {
  it("gives the Auction tab the auction's violet, Stocks the blue and the Rail Map the magenta", () => {
    expect(roundAffinityFor("phase")).toBe("auction");
    expect(roundAffinityFor("corps")).toBe("stock");
    expect(roundAffinityFor("map")).toBe("operating");
  });

  it("gives the Stock Market, the Game Ledger, the Tiles and the Rules Reference no ROUND affinity", () => {
    /* The Stock Market is the near miss and the one worth naming: it owns a board, so it is not merely a
       lookup, but it is nobody's ACTING surface and its chart is moved by both rounds -- sales and the
       sold-out rise in a Stock Round, every dividend in an Operating Round. A blue edge would claim it for
       one round and be wrong for half the game.
       #1628 DID NOT CHANGE THIS. Those four now share a utility accent, but `roundAffinityFor` still answers
       `null` for every one of them -- the tan is not a fourth round and is not reachable from this function. */
    for (const tab of UTILITY) expect(roundAffinityFor(tab)).toBeNull();
  });

  it("is the inversion of `surfaceTabFor` and not a second table", () => {
    /* THE CASE THAT STOPS THE TWO DRIFTING. Whatever `surfaceTabFor` says a round acts in is the tab that
       wears that round's hue, and nothing else does. Change `surfaceTabFor` and this moves with it. */
    expect(roundAffinityFor(surfaceTabFor("WaterfallAuction"))).toBe("auction");
    expect(roundAffinityFor(surfaceTabFor("StockRound"))).toBe("stock");
    expect(roundAffinityFor(surfaceTabFor("OperatingRound"))).toBe("operating");
    const surfaces = ROUNDS.map((round) => surfaceTabFor(round));
    for (const tab of EVERY_TAB) {
      expect(roundAffinityFor(tab) === null).toBe(!surfaces.includes(tab));
    }
  });

  it("accents only playing surfaces, and exactly the three of them", () => {
    /* A sanity fence from the other direction: the accented set is a subset of the tabs a player ACTS in
       (`isPlayingSurface`), and the three rounds own one tab each rather than an equal share of seven. */
    for (const tab of ACCENTED) expect(isPlayingSurface(tab)).toBe(true);
    expect(EVERY_TAB.filter((tab) => roundAffinityFor(tab) !== null)).toEqual([...ACCENTED]);
    expect(new Set(ACCENTED.map((tab) => roundAffinityFor(tab))).size).toBe(3);
  });

  it("says nothing about the live round: the affinity function cannot even see one", () => {
    /* #1627's rule. The Rail Map belongs to the Operating Round whether or not one is running, so the
       function takes a tab and nothing else -- there is no round argument to pass it. */
    expect(roundAffinityFor.length).toBe(1);
  });
});

describe("1b. every tab belongs to exactly one presentation family (#1628)", () => {
  it("puts every tab in a family, and never in two", () => {
    /* THE PARTITION, ASSERTED AS ONE. A `switch` that fell through, a new tab added to `MainTab` without a
       thought, or a `surfaceTabFor` edit could each leave a tab unaccented or doubly accented -- and an
       unaccented tab is exactly the defect #1628 was opened to fix. Counted rather than spot-checked. */
    const rounds = EVERY_TAB.filter((tab) => tabAccentFamilyFor(tab).kind === "round");
    const utility = EVERY_TAB.filter((tab) => tabAccentFamilyFor(tab).kind === "utility");
    expect(rounds).toEqual([...ACCENTED]);
    expect(utility).toEqual([...UTILITY]);
    expect(rounds.length + utility.length).toBe(EVERY_TAB.length);
    expect(rounds.filter((tab) => utility.includes(tab))).toEqual([]);
  });

  it("derives the family from the round mapping rather than from a second list", () => {
    /* #1627's rule, extended: the utility family is `roundAffinityFor`'s `null` with a name, so the two can
       no more disagree than a value can differ from itself. Change `surfaceTabFor` and BOTH move. */
    for (const tab of EVERY_TAB) {
      const family = tabAccentFamilyFor(tab);
      const key = roundAffinityFor(tab);
      expect(family.kind === "round").toBe(key !== null);
      if (family.kind === "round") expect(family.key).toBe(key);
    }
  });

  it("gives the four supporting surfaces one accent between them, not four", () => {
    /* A second vocabulary of four near-tans would be a vocabulary about nothing: these tabs share no question
       the way the rounds do. One value, asserted as a set of size one. */
    expect(new Set(UTILITY.map((tab) => tabAccentInk(tab))).size).toBe(1);
    expect(tabAccentInk("stock")).toBe(UTILITY_ACCENT);
  });

  it("keeps the three round inks distinct from each other and from the utility accent", () => {
    const inks = EVERY_TAB.map((tab) => tabAccentInk(tab));
    expect(new Set(inks).size).toBe(4); // three rounds + one shared utility
    for (const tab of ACCENTED) expect(tabAccentInk(tab)).not.toBe(UTILITY_ACCENT);
  });

  it("still sees no live round from either family", () => {
    /* #1627 (3) extended to the new function: the family is a property of the SURFACE. Neither takes a round. */
    expect(tabAccentFamilyFor.length).toBe(1);
    expect(tabAccentInk.length).toBe(1);
  });
});

describe("2. one colour vocabulary, spent rather than retyped", () => {
  const HUES = ["#c08ae8", "#6fa3f7", "#e879b0", "#a89577"];

  it("keeps the three round hues in `palette.ts`, named for the game", () => {
    expect(ROUND_ACCENT.auction.ink).toBe("#c08ae8");
    expect(ROUND_ACCENT.stock.ink).toBe("#6fa3f7");
    expect(ROUND_ACCENT.operating.ink).toBe("#e879b0");
    // The LINE token exists because that is what a 2px rule is dressed in, and it is the same hue.
    expect(ROUND_ACCENT.operating.rule).toContain("232, 121, 176");
  });

  it("is not duplicated in either consumer", () => {
    /* THE ASSERTION THAT WOULD HAVE CAUGHT #1092's five near-whites. Neither the strip nor the reference may
       carry the literals; both have to reach the token. */
    const strip = readStripped("components/MainTabBar.tsx");
    const reference = readStripped("components/RulesReference.tsx");
    for (const hue of HUES) {
      expect(strip).not.toContain(hue);
      expect(reference).not.toContain(hue);
    }
    expect(strip).toContain("ROUND_ACCENT");
    expect(strip).toContain("UTILITY_ACCENT");
    expect(reference).toContain("ROUND_ACCENT");
    const palette = readStripped("styles/palette.ts");
    expect(palette).toContain("#c08ae8");
    expect(palette).toContain("#a89577");
  });

  it("names the token for the game and not for the page that first used it", () => {
    const palette = readStripped("styles/palette.ts");
    expect(palette).toContain("ROUND_ACCENT");
    expect(palette).not.toMatch(/rulesReference[A-Z]/);
  });

  it("names the utility accent for the navigation family and not as a fourth round", () => {
    /* #1628. The token had to stay OUT of `ROUND_ACCENT`: a member there would answer "which part of play",
       and this answers "what kind of surface". A future reader reaching for a fifth round key should find
       nothing. Asserted both ways -- the name exists, and the round record still has exactly four members. */
    const palette = readStripped("styles/palette.ts");
    expect(palette).toContain("export const UTILITY_ACCENT");
    expect(Object.keys(ROUND_ACCENT)).toEqual(["auction", "stock", "operating", "end"]);
    expect(Object.values(ROUND_ACCENT).map((accent) => accent.ink)).not.toContain(UTILITY_ACCENT);
  });

  it("keeps the utility accent clear of tile, gold, status and current-turn colour", () => {
    /* #1626's two collisions, re-checked in the warm band where they actually bite. Asserted as INEQUALITY
       against the specific values the brief named, so a future edit toward any of them fails here and not in
       a playtest. The measured CIE76 distances are in `palette.ts` #1628; this is the cheap fence. */
    const FORBIDDEN = [
      "#c08a5a", // ERA_INK.brown -- the train tier's brown
      "#bf8156", // ERA_TILE_FILL.Brown -- a laid brown tile
      "#8a6242", // ERA_HEX_FILL.Brown
      "#ffe600", // ERA_TILE_FILL.Yellow -- tile availability
      "#d9c05a", // ERA_INK.yellow
      "#7a6529", // CARD_CAPTION_GOLD -- the auction dashboard's gold
      "#fb923c", // ALERT_WARN_INK -- warning
      "#f2f0eb", // TURN_PULSE_INK -- current turn
    ];
    for (const value of FORBIDDEN) expect(UTILITY_ACCENT).not.toBe(value);
  });

  it("does not reach corporation, seat, tile, status or current-turn colour", () => {
    /* Scoped, and the scope is asserted: the strip imports the round tokens and nothing else colour-shaped. */
    const strip = readStripped("components/MainTabBar.tsx");
    expect(strip).not.toContain("playerLabels");
    expect(strip).not.toContain("LIVE_INK");
    expect(strip).not.toContain("CARD_");
  });
});

describe("3. the treatment: a 2px inset rule, and no geometry at all", () => {
  it("is 2px, the same weight as the Rules Reference nav's own accent rule", () => {
    expect(TAB_ACCENT_RULE_PX).toBe(2);
    expect(readStripped("components/RulesReference.tsx")).toContain("inset 0 -2px 0");
  });

  it("sets exactly one property, and it is not a layout one", () => {
    /* THE CODE HALF OF "NO TAB GEOMETRY CHANGES". Nothing here can move a border, a padding or a width, so
       the strip wraps where it wrapped before -- measured at five widths in the capture folder. */
    for (const tab of EVERY_TAB) {
      for (const active of [false, true]) {
        expect(Object.keys(tabAccentStyle(tab, active))).toEqual(["boxShadow"]);
      }
    }
  });

  it("paints the round's hue on the tab's inner TOP edge", () => {
    expect(tabAccentStyle("phase", false).boxShadow).toBe(`inset 0 2px 0 0 ${ROUND_ACCENT.auction.ink}`);
    expect(tabAccentStyle("corps", false).boxShadow).toBe(`inset 0 2px 0 0 ${ROUND_ACCENT.stock.ink}`);
    expect(tabAccentStyle("map", false).boxShadow).toBe(`inset 0 2px 0 0 ${ROUND_ACCENT.operating.ink}`);
  });

  it("paints the utility accent on the other four, in the same place at the same weight", () => {
    /* WAS `it("adds nothing whatsoever to a neutral tab")`, asserting `toEqual({})`. #1628: the absence was
       the defect. Asserted as the SAME STRING SHAPE as the three above rather than merely "not empty" -- the
       whole claim is that this is one treatment in two inks, so a thinner rule, a bottom edge or an offset
       would be a different treatment wearing the same name. */
    for (const tab of UTILITY) {
      expect(tabAccentStyle(tab, false).boxShadow).toBe(`inset 0 2px 0 0 ${UTILITY_ACCENT}`);
    }
  });

  it("uses one geometry for both families, derived from one constant", () => {
    /* The two families differ in EXACTLY one substring -- the ink. Everything before it is byte-identical, so
       the tan cannot acquire its own offset, spread or edge without this failing. */
    const shapes = EVERY_TAB.map((tab) => String(tabAccentStyle(tab, false).boxShadow).replace(/#[0-9a-f]{6}$/i, ""));
    expect(new Set(shapes).size).toBe(1);
    expect(shapes[0]).toBe(`inset 0 ${TAB_ACCENT_RULE_PX}px 0 0 `);
  });
});

describe("4. selection, hover and focus stay independent of the affinity", () => {
  it("keeps the same accent on the selected tab as on the unselected one", () => {
    /* THE ONE THAT STOPS THE HUE BECOMING A SELECTION SIGNAL. Identical edge in both states: a player cannot
       read "selected" off the colour, because the colour does not change. */
    for (const tab of EVERY_TAB) {
      const inactive = String(tabAccentStyle(tab, false).boxShadow);
      const active = String(tabAccentStyle(tab, true).boxShadow);
      expect(active.startsWith(inactive)).toBe(true);
      expect(active).not.toBe(inactive); // the selected tab also keeps its own lift
    }
  });

  it("composes with the selected tab's lift rather than replacing it", () => {
    const active = String(tabAccentStyle("map", true).boxShadow);
    expect(active).toContain("inset 0 2px 0 0");
    expect(active).toContain("rgba(0, 0, 0, 0.35)"); // `mainTabButtonActive`'s lift, read not retyped
    const strip = readStripped("components/MainTabBar.tsx");
    expect(strip).toContain("styles.mainTabButtonActive.boxShadow");
  });

  it("leaves the selected tab recognisable without colour at all", () => {
    /* Selection is a white edge, a brighter ink, a heavier weight, a lift and `aria-current` -- five signals,
       none of them a hue. Asserted on the style the strip actually spreads. */
    const appStyles = readStripped("styles/appStyles.ts");
    expect(appStyles).toContain("mainTabButtonActive");
    const strip = readStripped("components/MainTabBar.tsx");
    expect(strip).toContain('aria-current={activeTab === tab.id ? "page" : undefined}');
    expect(strip).toContain("styles.mainTabButtonActive");
  });

  it("leaves hover and focus-visible exactly as they were, in their own channels", () => {
    const strip = readStripped("components/MainTabBar.tsx");
    expect(strip).toContain(".nav-tab:hover { color: #f2f0eb; border-color: #4a4a4a; background-color: #1c1c1c; }");
    expect(strip).toContain(".nav-tab:focus-visible { outline: 2px solid #8a8a86; outline-offset: -2px; color: #f2f0eb; }");
    expect(strip).toContain(".nav-tab-active:hover { color: #f2f0eb; border-color: rgba(255,255,255,0.8); }");
  });

  it("drops the decoration and keeps the meaning under forced colours", () => {
    const strip = readStripped("components/MainTabBar.tsx");
    expect(strip).toContain("@media (forced-colors: active)");
    expect(strip).toContain("box-shadow: none !important");
    expect(strip).toContain("outline: 2px solid currentColor");
  });
});

describe("5. the tab system itself is untouched", () => {
  it("renders the same tabs, in the same order, in every round", () => {
    expect(orderedMainTabs("WaterfallAuction").map((t) => t.label)).toEqual([
      "Auction", "Stocks", "Rail Map", "Stock Market", "Game Ledger", "Tiles", "Rules Reference",
    ]);
    expect(orderedMainTabs("StockRound").map((t) => t.label)).toEqual([
      "Stocks", "Rail Map", "Stock Market", "Game Ledger", "Tiles", "Rules Reference",
    ]);
    expect(orderedMainTabs("OperatingRound").map((t) => t.label)).toEqual([
      "Rail Map", "Stocks", "Stock Market", "Game Ledger", "Tiles", "Rules Reference",
    ]);
    expect(orderedMainTabs(null).map((t) => t.label)).toEqual(orderedMainTabs("OperatingRound").map((t) => t.label));
  });

  it("decides nothing about availability or ordering from the affinity", () => {
    /* The affinity is presentation. If `orderedMainTabs` or `isTabAvailable` ever consulted it, an unavailable
       tab could become a colour question -- so the two functions must not mention it. */
    const strip = readStripped("components/MainTabBar.tsx");
    const ordering = strip.slice(strip.indexOf("export function orderedMainTabs"), strip.indexOf("export function isPlayingSurface"));
    expect(ordering).not.toContain("roundAffinity");
    expect(ordering).not.toContain("ROUND_ACCENT");
  });

  it("adds no ARIA and no tooltip to describe a decorative edge", () => {
    /* An accent that announced itself would be read out on every tab in every round. The one attribute added
       is a `data-` hook, which is inert to assistive technology and exists so the mapping is assertable in
       the DOM and in the capture. */
    const strip = readStripped("components/MainTabBar.tsx");
    expect(strip).toContain("data-round-affinity");
    /* #1628: and still ONE hook. The family is derivable from this attribute plus its absence, so a second
       `data-accent-family` beside it would put the same fact in the DOM twice in two spellings. */
    expect(strip).not.toContain("data-accent-family");
    expect(strip).not.toMatch(/aria-label=\{[^}]*roundAffinity/);
    expect(strip).not.toMatch(/title=\{[^}]*roundAffinity/);
    expect(strip).not.toMatch(/aria-describedby/);
  });

  it("has no disabled state to confuse with a dim accent, because unavailability is removal", () => {
    /* The strip has never disabled a tab: a tab that does not apply to this round is absent from
       `orderedMainTabs` entirely. Pinned so a future "grey it out instead" lands beside this note. */
    const strip = readStripped("components/MainTabBar.tsx");
    expect(strip).not.toContain("disabled");
    expect(orderedMainTabs("StockRound").some((t) => t.id === "phase")).toBe(false);
  });

  it("leaves the Tutorials control out of the vocabulary", () => {
    const strip = readStripped("components/MainTabBar.tsx");
    const tutorials = strip.slice(strip.indexOf("styles.tutorialsButton"));
    expect(tutorials).not.toContain("tabAccentStyle");
    expect(tutorials).not.toContain("UTILITY_ACCENT");
  });
});
