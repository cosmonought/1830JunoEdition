// The top-level tab strip and the tab-set rules behind it, moved out of
// `App.tsx` unchanged.
//
// The whole `MainTab` vocabulary travels together because design note #28's
// central point is that the tab set is COMPUTED rather than fixed, and a
// computed set is only coherent if the rule and the renderer cannot drift apart.
// `AppShell` imports `MainTab`, `isTabAvailable` and `surfaceTabFor`; the
// ordering function and the hover CSS stay private.

import React from "react";

import type { RoundType } from "../gameEngine/gameState";
import { styles } from "../styles/appStyles";
import { ROUND_ACCENT, UTILITY_ACCENT, type RoundAccentKey } from "../styles/palette";

export type MainTab = "phase" | "corps" | "map" | "stock" | "ledger" | "rules" | "tiles";

/** The tabs to show, in order, for the current round. The active phase always
 *  leads: a player's attention starts at the left edge, and the first tab should
 *  be the one they can act in, or every phase transition begins with a hunt. */
export function orderedMainTabs(roundType: RoundType | null): { id: MainTab; label: string }[] {
  /* Design note #677: `Tiles` joins the REFERENCE group, which is what decides
     its position without anyone choosing one -- reference tabs trail the
     surfaces a player acts in, in every round, by the rule this function
     already applies. It sits beside Rules Reference because it is the same kind
     of thing: a lookup you open mid-turn and close again.
     PRESENT IN EVERY ROUND, unlike the phase surfaces. A player plans a tile lay
     during a Stock Round at least as often as during their own Operating Round
     -- "can I still get a green city onto Erie" is a question about what to buy
     -- and a tab that vanished outside Lay Track would be missing exactly when
     the planning happens. */
  const reference: { id: MainTab; label: string }[] = [
    { id: "stock", label: "Stock Market" },
    { id: "ledger", label: "Game Ledger" },
    { id: "tiles", label: "Tiles" },
    { id: "rules", label: "Rules Reference" },
  ];
  const railMap = { id: "map" as MainTab, label: "Rail Map" };
  // Design note #41: present in every branch below, without exception.
  const stocks = { id: "corps" as MainTab, label: "Stocks" };

  switch (roundType) {
    case "WaterfallAuction":
      return [{ id: "phase", label: "Auction" }, stocks, railMap, ...reference];
    case "StockRound":
      // No separate phase tab: Stocks IS the Stock Round's surface, and a
      // duplicate tab rendering the identical panel would be a bug that
      // merely looked like a feature.
      return [stocks, railMap, ...reference];
    case "OperatingRound":
      // No phase tab: the rail map is the operating round's own surface.
      return [railMap, stocks, ...reference];
    default:
      // Round type not yet known (first paint, or offline). Rail map first
      // -- it is the one surface that renders without any chain data.
      return [railMap, stocks, ...reference];
  }
}

/** Whether `tab` exists for `roundType`. Used to redirect off a tab that
 *  has just disappeared under the player -- e.g. sitting on the Auction tab
 *  when the auction ends. */
export function isTabAvailable(tab: MainTab, roundType: RoundType | null): boolean {
  return orderedMainTabs(roundType).some((entry) => entry.id === tab);
}

/* Design note #213: both the transition effect and the availability guard now
   ask this one function, so whichever commits last they agree. Previously the
   guard carried its own hardcoded `"map"` and ran in the same commit still
   reading the pre-transition tab, so leaving the auction always landed on the
   Rail Map.

   Design note #390: `isPlayingSurface` excludes the REFERENCE tabs (`ledger`,
   `rules`, `stock`), because treating those as "the wrong tab" would make
   consulting the rules cost a player their controls.

   See docs/ai_architecture/ui_shell_layout.md, MainTabBar.tsx #213 / #390. */
export function isPlayingSurface(tab: MainTab): boolean {
  return tab === "phase" || tab === "corps" || tab === "map";
}

/** The tab the player should be on to act, when they are on the wrong
 *  PLAYING surface -- `null` when they are already in the right place or
 *  are on a reference tab (design note #390). */
export function misplacedSurfaceTab(
  activeTab: MainTab,
  roundType: RoundType | null,
): MainTab | null {
  /* Design note #404 REVERSES #390's exemption, which is left standing above
     rather than edited away: #390 assumed the alternative was leaving the FULL
     bar on a reference tab, and the full bar is the hazard -- a misclick on the
     Game Ledger could spend a turn. Reference tabs now carry the Return button and
     NOTHING ELSE (panel half in `ContextualActionBar.tsx`). `isPlayingSurface` is
     still exported for the bar's copy, but no longer gates the redirect. */
  const correct = surfaceTabFor(roundType);
  return activeTab === correct ? null : correct;
}

/** The human label for a tab, for the redirect button's copy. Reads the
 *  same table the strip renders, so "Return to Rail Map" can never name a
 *  tab differently from the tab itself. */
export function labelForTab(tab: MainTab, roundType: RoundType | null): string {
  return orderedMainTabs(roundType).find((entry) => entry.id === tab)?.label ?? "the board";
}

export function surfaceTabFor(roundType: RoundType | null): MainTab {
  switch (roundType) {
    case "WaterfallAuction":
      return "phase";
    case "StockRound":
      return "corps";
    case "OperatingRound":
      return "map";
    default:
      // Round type not yet known (first paint, or offline). The rail map is
      // the one surface that renders without any chain data.
      return "map";
  }
}


/** ==================================================================
 *   DESIGN NOTE 1627: WHICH PART OF PLAY THIS SURFACE BELONGS TO
 *  ==================================================================
 *
 * The Rules Reference dresses each round in one hue -- the auction violet, the Stock Round blue, the
 * Operating Round magenta (`palette.ts` #1626) -- and a player who has learned that vocabulary there gets no
 * use out of it in the room they actually play in. This carries it into the strip, and nothing more than
 * that: a 2px rule on the tab's inner top edge.
 *
 * IT IS NOT A SELECTION SIGNAL AND MUST NOT BECOME ONE. Selection is the white edge, the lift, the ink and
 * the weight (`styles.mainTabButtonActive`) plus `aria-current`; keyboard focus is its own outline; hover is
 * its own border and ground. The accent is CONSTANT across every one of those states, which is what makes it
 * read as a property of the surface rather than as a state of the control -- and it is constant across the
 * CURRENT ROUND too: the Rail Map belongs to the Operating Round whether or not one is running. Something
 * that changed with the live round would be a third meaning in a channel that already has one, and the live
 * round is told by the round label, the turn indicator and the reference's own live dot.
 *
 * THE MAPPING IS NOT A SECOND TABLE. `surfaceTabFor` already answers "which tab does this round act in", and
 * this is that function read backwards -- so a tab cannot acquire an affinity the app does not already
 * believe, and changing `surfaceTabFor` changes both at once. The three rounds own one tab each:
 *   Auction (`phase`) -> violet, Stocks (`corps`) -> blue, Rail Map (`map`) -> magenta.
 *
 * AND FOUR TABS TAKE NO ROUND HUE, WHICH IS THE PART THAT TOOK THE THINKING.
 *   `stock` (Stock Market) is the near miss. It is a workspace tab that owns a board (`App.tsx` #45), so it
 *   is not merely a lookup -- but it is nobody's acting surface (`surfaceTabFor` never returns it,
 *   `isPlayingSurface` excludes it, `orderedMainTabs` files it under `reference`), and its content is moved
 *   by BOTH rounds: sales and the end-of-round sold-out rise in a Stock Round, and every corporation's
 *   dividend in an Operating Round. A blue edge would claim the chart for the Stock Round and be wrong for
 *   half the game, so it gets no ROUND hue -- which is itself the signal the reference already uses for lookup
 *   material.
 *   `ledger`, `tiles` and `rules` are lookups in every round, and `rules` in particular must not tint the
 *   strip above a page whose whole job is to own these colours.
 * THE ROUNDS DO NOT OWN EQUAL SHARES, deliberately. One acting surface each is the honest count.
 *   -- #1627 SAID "STAY NEUTRAL" AND MEANT "GET NO ROUND HUE". Every word above still holds, and #1628 below
 *   corrects only the conclusion drawn from it: those four now share ONE accent of their own.
 *
 * See docs/ai_architecture/ui_shell_layout.md, MainTabBar.tsx #1627. */
const ROUND_ACCENT_KEY: Readonly<Record<Exclude<RoundType, "GameEnd">, RoundAccentKey>> = {
  WaterfallAuction: "auction",
  StockRound: "stock",
  OperatingRound: "operating",
};

/** The rounds a tab can belong to. `GameEnd` is excluded because it has no acting surface, and `null` (round
 *  not yet known) because `surfaceTabFor`'s answer there is a first-paint fallback rather than a claim about
 *  the game -- reading it would hand the Rail Map a second affinity by accident. */
const PLAYED_ROUNDS: readonly Exclude<RoundType, "GameEnd">[] = [
  "WaterfallAuction",
  "StockRound",
  "OperatingRound",
];

/** Which round's own surface `tab` is, or `null` for a tab that belongs to no single round. Presentation
 *  only: nothing about availability, ordering, selection or the live round is decided here. */
export function roundAffinityFor(tab: MainTab): RoundAccentKey | null {
  const owner = PLAYED_ROUNDS.find((round) => surfaceTabFor(round) === tab);
  return owner === undefined ? null : ROUND_ACCENT_KEY[owner];
}

/** ==================================================================
 *   DESIGN NOTE 1628: SEVEN TABS, TWO FAMILIES, ONE TREATMENT
 *  ==================================================================
 *
 * REPORTED, and correctly: the strip divided into "three decorated tabs and four unfinished ones". #1627's
 * reasoning for leaving four bare is sound and is left standing above -- none of them is a round's acting
 * surface, so none may wear a round's hue -- but an ABSENCE is not a category. A player reads a missing edge
 * as work not done, because every other difference in this strip means something.
 *
 * SO THE ANSWER IS A SECOND FAMILY RATHER THAN THREE MORE HUES. Stock Market, Game Ledger, Tiles and Rules
 * Reference share ONE muted warm neutral (`palette.ts` #1628), on the same 2px inset top rule and the same
 * geometry. Every tab now has an accent; only the three acting surfaces have a round-specific one.
 *
 * WHY ONE COLOUR FOR FOUR TABS AND NOT FOUR. Four would be a second vocabulary competing with the first, and
 * it would be a vocabulary about nothing -- these tabs have no shared question to answer the way the rounds
 * do. One shared accent says exactly what is true: same family, no round.
 *
 * THE MAPPING IS STILL NOT A SECOND TABLE. `tabAccentFamilyFor` is `roundAffinityFor` with its `null` given a
 * name, so the families are disjoint and exhaustive BY CONSTRUCTION rather than by a list anyone maintains. A
 * tab cannot be in both, or in neither, and `surfaceTabFor` still decides which is which.
 *
 * NO SECOND `data-` ATTRIBUTE, deliberately. `data-round-affinity` answers "which round", and adding a
 * `data-accent-family` beside it would put the same fact in the DOM twice, in two spellings that can drift.
 * The family is asserted through the exported function, which is where it is decided.
 *
 * IT IS STILL NOT A SELECTION SIGNAL, and the tan is held to the same rule as the hues: constant across
 * active, inactive, hover and focus. See docs/ai_architecture/ui_shell_layout.md, MainTabBar.tsx #1628. */
export type TabAccentFamily =
  | { kind: "round"; key: RoundAccentKey }
  | { kind: "utility" };

/** Which presentation family `tab` belongs to. TOTAL: every `MainTab` is in exactly one, because this is
 *  `roundAffinityFor`'s answer with its `null` branch named rather than a table beside it. */
export function tabAccentFamilyFor(tab: MainTab): TabAccentFamily {
  const key = roundAffinityFor(tab);
  return key === null ? { kind: "utility" } : { kind: "round", key };
}

/** The accent this tab wears. One lookup for both families, so the rule below cannot dress them differently
 *  by accident -- the family decides the colour and nothing else about the treatment. */
export function tabAccentInk(tab: MainTab): string {
  const family = tabAccentFamilyFor(tab);
  return family.kind === "round" ? ROUND_ACCENT[family.key].ink : UTILITY_ACCENT;
}

/** The rule's weight. 2px, the same as the Rules Reference nav's own accent rule, so the two strips are
 *  one treatment at two sizes of chrome rather than two ideas. #1628: shared by both families -- the tan is
 *  the same rule in a different ink, not a lighter or thinner version of it. */
export const TAB_ACCENT_RULE_PX = 2;

/** The accent edge as a style. #1628: every tab gets one; `roundAffinityStyle` was this function when only
 *  three did.
 *
 *  AN INSET SHADOW, WHICH IS THE WHOLE REASON THIS CHANGES NO GEOMETRY. It paints inside the padding box and
 *  takes part in no layout: no border grows, no padding moves, no tab gets wider and the strip wraps at
 *  exactly the widths it wrapped at before. A border, an extra element or a taller padding would each have
 *  moved the row. This is also why extending it to four more tabs is dimensionally free, and the measured
 *  before/after rectangles say so.
 *
 *  THE TOP EDGE RATHER THAN THE BOTTOM, and that is the one place this departs from the Rules Reference nav,
 *  for a structural reason. That nav's tabs are PILLS with four borders and nothing docked beneath them, so
 *  its 2px rule sits under the label. These are FOLDER TABS -- `borderBottomWidth: 0`, the active tab's
 *  bottom border painted in the panel's own colour so it docks seamlessly into the surface below
 *  (`mainTabButtonActive`). The bottom edge is that seam; putting a coloured rule in it would either break
 *  the dock or read as an underline of the selected tab. The top edge is free, and on a folder tab it reads
 *  as the tab's own roof.
 *
 *  THE ACTIVE TAB KEEPS ITS LIFT. The shadow is composed rather than replaced, and the lift is read off
 *  `mainTabButtonActive` rather than retyped, so the two cannot drift. */
export function tabAccentStyle(tab: MainTab, active: boolean): React.CSSProperties {
  const edge = `inset 0 ${TAB_ACCENT_RULE_PX}px 0 0 ${tabAccentInk(tab)}`;
  const lift = styles.mainTabButtonActive.boxShadow;
  return { boxShadow: active && lift ? `${edge}, ${String(lift)}` : edge };
}

const MAIN_TAB_HOVER_CSS = `
.nav-tab { transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease; }
.nav-tab:hover { color: #f2f0eb; border-color: #4a4a4a; background-color: #1c1c1c; }
.nav-tab:focus-visible { outline: 2px solid #8a8a86; outline-offset: -2px; color: #f2f0eb; }
.nav-tab-active:hover { color: #f2f0eb; border-color: rgba(255,255,255,0.8); }
/* Design note #1627: IN FORCED COLOURS THE AFFINITY GOES AND THE MEANING STAYS. High-contrast mode drops
   box-shadow anyway; saying so explicitly means the round hue cannot survive as a stray composite and leaves
   the two signals that carry meaning -- the selected tab's border and the focus outline, both of which the
   forced palette repaints -- as the only things on the tab. The outline is restated in currentColor because
   a fixed grey is not a colour that mode honours. NOTE: no backticks in here -- this block is a JS template
   literal and one would end it. */
@media (forced-colors: active) {
  .nav-tab { box-shadow: none !important; }
  .nav-tab:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
}
`;


export default function MainTabBar({
  activeTab,
  onSelect,
  roundType,
  onOpenTutorials,
}: {
  activeTab: MainTab;
  onSelect: (tab: MainTab) => void;
  /** Opens the on-demand tutorial library -- design note #158. */
  onOpenTutorials: () => void;
  /** Design note #28: decides both which tabs exist and their order.
   *  `null` before the first `GetGameState` resolves. */
  roundType: RoundType | null;
}) {
  // Design note #28: the tab set is computed, not a fixed array. Superseded
  // design note #26's single self-renaming tab, which conflated the phase
  // surface with the market chart -- see #28 for why that had to split.
  const tabs = orderedMainTabs(roundType);
  return (
    <div style={styles.mainTabBar}>
      {/* Design note #46: hover needs real CSS -- inline `React.CSSProperties` cannot
         express `:hover` (`Lobby.tsx #3`), and an unselected tab that never responds to
         the pointer is what made these read as disabled. Scoped to one class. */}
      <style>{MAIN_TAB_HOVER_CSS}</style>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={activeTab === tab.id ? "nav-tab nav-tab-active" : "nav-tab"}
          aria-current={activeTab === tab.id ? "page" : undefined}
          style={{
            ...styles.mainTabButton,
            ...(activeTab === tab.id ? styles.mainTabButtonActive : {}),
            /* Design note #1627: LAST, so the composed shadow is not overwritten by the active lift -- and
               presentation only. No `aria-*` describes it: a decorative edge that announced itself to a
               screen reader would be noise on every tab, in every round. #1628: now on every tab. */
            ...tabAccentStyle(tab.id, activeTab === tab.id),
          }}
          data-round-affinity={roundAffinityFor(tab.id) ?? undefined}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}

      {/* Design note #158: the Tutorials front door, pinned right past an auto margin
         and deliberately NOT a fifth tab -- it opens a reader over the current screen
         rather than navigating, and tab styling would imply a navigation it does not
         perform. */}
      <span style={{ marginLeft: "auto" }} />
      <button
        type="button"
        className="nav-tab"
        style={styles.tutorialsButton}
        onClick={onOpenTutorials}
        title="Read any tutorial at any time — the auction, the Stock Round, the Operating Round, or the stock market."
      >
        &#63; Tutorials
      </button>
    </div>
  );
}

/** Design note #46: the hover/focus half of the tab treatment. Only the states
 *  inline styles cannot reach live here; resting and active stay in
 *  `styles.mainTabButton`/`mainTabButtonActive`. `:focus-visible` mirrors hover
 *  because the browser default outline is nearly invisible on this dark chrome. */
