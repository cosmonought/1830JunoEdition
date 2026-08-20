// frontend/src/panels/ReturnToTurnBar.tsx
//
// ==================================================================
//  DESIGN NOTE 427: A WAY BACK FROM THE REFERENCE TABS
// ==================================================================
//
// REPORTED: add an action bar to the Game Ledger and Rules tabs containing
// only a "Return to [relevant tab]" button, during a player's active turn.
//
// The Ledger and the Rules are the app's two REFERENCE surfaces: a player
// opens them mid-turn to check a holding or look up a rule, and neither
// carries a single control. Every other tab renders `ContextualActionBar`
// at the top, so on these two the bar simply vanished -- and with it the
// only persistent thing on screen that said a turn was in progress.
//
// The failure that produces is small and repeated: a player checks the
// Ledger, gets absorbed in the numbers, and has to remember both that they
// were mid-turn and which tab they came from. The tab bar can take them
// back, but it does not tell them they need to go.
//
// ==================================================================
//  WHY IT IS NOT `ContextualActionBar`
// ==================================================================
//
// The obvious implementation is to render the real bar here too. It is the
// wrong one, and the requirement is right to say "containing only" a return
// button.
//
// Every control on that bar acts on the ACTING corporation or seat -- Pass
// Turn, Skip, Undo, Buy Train. Those actions belong to the surface where
// their consequences are visible: skipping the Track step from inside the
// Rules tab dispatches a real message and shows the player a rulebook. So
// the reference tabs get the one control that is honestly available on
// them, which is the way out.
//
// ONLY DURING THE PLAYER'S TURN, per the requirement, and the restriction
// is what stops this becoming chrome. A player browsing the rules between
// turns is not being kept from anything and needs no prompt; a bar that
// rendered always would be a permanent banner that means nothing, which is
// how persistent UI stops being read at all.
//
// THE DESTINATION IS DERIVED, NOT NAMED. `surfaceTabFor` is the same lookup
// the round transitions use, so "the relevant tab" is the round's own home
// surface and cannot drift from where the game actually sends a player when
// the round changes.

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
