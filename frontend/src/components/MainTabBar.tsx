// frontend/src/components/MainTabBar.tsx
//
// THE TOP-LEVEL TAB STRIP and the tab-set rules behind it, moved out of
// `App.tsx` unchanged.
//
// The whole `MainTab` vocabulary travels together: the union, the function
// that decides which tabs exist for a round type, the availability check, the
// default-surface picker and the strip that renders them. These are one
// concept in five declarations -- design note #28's central point is that the
// tab set is COMPUTED rather than fixed, and a computed set is only coherent
// if the rule and the renderer cannot drift apart. Splitting them across
// files would be the first step towards exactly that drift.
//
// `AppShell` imports `MainTab`, `isTabAvailable` and `surfaceTabFor` from
// here; nothing else outside this file uses `orderedMainTabs` or the hover
// CSS, so those stay private to it.

import React from "react";

import type { RoundType } from "../utils/gameState";
import { styles } from "../styles/appStyles";

export type MainTab = "phase" | "corps" | "map" | "stock" | "ledger" | "rules";

/** The tabs to show, in order, for the current round.
 *
 *  The active phase always leads. A player's attention starts at the left
 *  edge, and in a game where the legal action changes completely between
 *  rounds, the first tab should be the one they can actually act in --
 *  otherwise every phase transition begins with a hunt. */
export function orderedMainTabs(roundType: RoundType | null): { id: MainTab; label: string }[] {
  const reference: { id: MainTab; label: string }[] = [
    { id: "stock", label: "Stock Market" },
    { id: "ledger", label: "Game Ledger" },
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

/* ==================================================================
 *  DESIGN NOTE 213: ONE ANSWER TO "WHICH TAB IS THIS ROUND PLAYED ON"
 * ==================================================================
 *
 * REPORTED BUG: leaving the auction for a Stock Round dumped the player on
 * the Rail Map instead of the Stock & Auction surface.
 *
 * The cause was two effects disagreeing, and the loser winning. The
 * transition effect correctly sent a new Stock Round to `"corps"`. The
 * availability guard right below it -- which exists because the tab SET
 * changes shape by phase, so the active tab can cease to exist under the
 * player -- then ran in the same commit, still reading `activeMainTab` as
 * `"phase"` (React has not re-rendered, so the value the first effect set is
 * not visible yet), found that `"phase"` is not in a Stock Round's tab list,
 * and redirected to a hardcoded `"map"`. Declared second, so it landed
 * second, so the Rail Map won every time.
 *
 * Reordering the effects would "fix" it by luck and break again the moment
 * anything else set a tab. The real defect is that the guard had its own
 * opinion about where to land, and that opinion was a constant. Both callers
 * now ask this one function, so whichever runs last, they agree.
 *
 * The mapping is design note #28's own split, stated once: the auction has a
 * dedicated phase surface; a Stock Round's surface IS the Stocks roster
 * (design note #41 -- there is no `"phase"` entry that round to land on);
 * an Operating Round is played on the rail map.
 */
/**
 * Is the player looking at the surface this round is played on?
 *
 * ==================================================================
 *  DESIGN NOTE 390: THE TABS THAT ARE NOT A PLACE TO ACT
 * ==================================================================
 *
 * REPORTED: players get confused viewing the map during a Stock Round, or
 * the stock market during an Operating Round, and should be offered a way
 * back to where the action is.
 *
 * The naive check is `activeTab !== surfaceTabFor(roundType)`, and it is
 * wrong for three of the six tabs. `ledger` and `rules` are REFERENCE
 * surfaces -- a player opens the Game Ledger mid-turn precisely to check
 * something before acting, and `stock` is the market chart, which is read
 * during every round. Treating those as "the wrong tab" would replace the
 * action panel with a redirect the moment a player consulted anything,
 * which is a worse trap than the one being fixed: it makes the reference
 * material cost you your controls.
 *
 * So the redirect fires only when the player is on ANOTHER ROUND'S PLAYING
 * SURFACE -- the map during a Stock Round, the corporations during an
 * Operating Round. Those are the two cases in the report, and they are the
 * ones where a player is plausibly waiting for something to happen on a
 * screen where nothing will.
 *
 * REFERENCE TABS KEEP THE ACTION PANEL as it was. Nothing is taken away
 * from a player who is deliberately reading.
 */
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
  if (!isPlayingSurface(activeTab)) return null;
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
      {/* Design note #46: hover states need real CSS.
          Inline `React.CSSProperties` cannot express `:hover` (Lobby.tsx
          design note #3), and an unselected tab that never responds to the
          pointer is the specific thing that made these read as disabled.
          Same `<style>`-tag escape hatch the turn pulse and the auction
          glow already use, scoped to one class so it cannot leak. */}
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

      {/* Design note #158: the Tutorials front door.
          Pinned right, past an auto margin, and deliberately NOT styled as a
          fifth tab -- it does not change which screen you are on, it opens a
          reader over whichever screen you are already on. Giving it the tab
          treatment would have implied a navigation it does not perform, and
          put a permanently-unselected tab next to four that highlight. */}
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

/** Design note #46: the hover/focus half of the tab treatment.
 *
 *  Only the states inline styles cannot reach live here -- the resting and
 *  active looks stay in `styles.mainTabButton`/`mainTabButtonActive`, so
 *  there is one place to read a tab's normal appearance rather than two
 *  that have to be kept in agreement.
 *
 *  `:focus-visible` mirrors hover because a keyboard user needs the same
 *  affordance a mouse user gets, and the browser default outline is nearly
 *  invisible against this dark chrome. */
