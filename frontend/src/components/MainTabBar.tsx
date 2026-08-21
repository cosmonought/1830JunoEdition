// The top-level tab strip and the tab-set rules behind it, moved out of
// `App.tsx` unchanged.
//
// The whole `MainTab` vocabulary travels together because design note #28's
// central point is that the tab set is COMPUTED rather than fixed, and a
// computed set is only coherent if the rule and the renderer cannot drift apart.
// `AppShell` imports `MainTab`, `isTabAvailable` and `surfaceTabFor`; the
// ordering function and the hover CSS stay private.

import React from "react";

import type { RoundType } from "../utils/gameState";
import { styles } from "../styles/appStyles";

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


const MAIN_TAB_HOVER_CSS = `
.nav-tab { transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease; }
.nav-tab:hover { color: #e2e8f0; border-color: #64748b; background-color: #1e2330; }
.nav-tab:focus-visible { outline: 2px solid #94a3b8; outline-offset: -2px; color: #e2e8f0; }
.nav-tab-active:hover { color: #ffffff; border-color: rgba(255,255,255,0.8); }
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
          }}
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
