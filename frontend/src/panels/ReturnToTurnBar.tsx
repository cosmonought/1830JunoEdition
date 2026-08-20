// Design note #427: a way back from the reference tabs.
//
// The Ledger and the Rules carry no controls, so `ContextualActionBar` simply
// vanished there -- and with it the only persistent thing on screen saying a
// turn was in progress. A player checks the Ledger, gets absorbed, and has to
// remember both that they were mid-turn and which tab they came from.
//
// NOT the real action bar: every control on it acts on the acting corporation
// or seat, and skipping the Track step from inside the Rules tab dispatches a
// real message while showing the player a rulebook. ONLY during the player's
// turn, which is what stops this becoming a permanent banner that means nothing.
// The destination is DERIVED from `surfaceTabFor`, the same lookup the round
// transitions use.
//
// See docs/ai_architecture/ui_shell_layout.md, ReturnToTurnBar.tsx #427.

import React from "react";

import { styles } from "../styles/appStyles";
import { orderedMainTabs, surfaceTabFor, type MainTab } from "../components/MainTabBar";
import type { RoundType } from "../utils/gameState";

export interface ReturnToTurnBarProps {
  /** Whether the viewer is the one who may act right now. `false` renders
   *  nothing at all -- see the note above on why this is not permanent. */
  isMyTurn: boolean;
  /** The round in play, which decides where "back" is. */
  roundType: RoundType | null;
  /** Navigates. The caller owns the tab cursor. */
  onReturn: (tab: MainTab) => void;
}

export function ReturnToTurnBar({ isMyTurn, roundType, onReturn }: ReturnToTurnBarProps) {
  if (!isMyTurn) return null;

  const destination = surfaceTabFor(roundType);
  /* The tab's own label, read from the same list the tab bar renders, so
     the button names the destination exactly as the tab a player is about
     to look at does. Hardcoding "Rail Map" here would be a second name for
     one surface -- and this round's home tab is not always the map. */
  const label =
    orderedMainTabs(roundType).find((tab) => tab.id === destination)?.label ?? "the board";

  return (
    <div style={styles.actionBar} role="region" aria-label="Return to your turn">
      {/* The same `1fr auto 1fr` grid the other bars use, so the single
          button lands in the same place a player's eye already expects the
          controls to be -- design note #426's whole point about muscle
          memory carrying between surfaces. */}
      <div style={styles.actionBarButtons}>
        <span />
        <span style={styles.actionBarButtonsCentre}>
          {/* Says WHOSE turn as well as where to go. "Return to Rail Map"
              alone is a navigation hint; the player needs the reason they
              are being offered it, and that reason is the only thing that
              makes this bar appear. */}
          <span style={styles.returnBarNotice}>It&rsquo;s your turn.</span>
          <button
            type="button"
            style={styles.actionBarButton}
            onClick={() => onReturn(destination)}
            title={`Go back to ${label}, where this round's controls are.`}
          >
            Return to {label} &#8250;
          </button>
        </span>
        {/* Design note #654: was `actionBarRailRight`, renamed with the phase
            badge's move to the lead. This bar has always used it the way that
            note now describes -- an empty third grid track, present so the
            centred column is centred on the panel. */}
        <span style={styles.actionBarRailTrail} />
      </div>
    </div>
  );
}

export default ReturnToTurnBar;
