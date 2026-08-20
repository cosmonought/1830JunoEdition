// Browser tab-title flash for active-player turn notifications. Its own small
// hook rather than inlined in `App.tsx`, since it is a self-contained side
// effect with its own cleanup/restore responsibility -- the same "one clear job
// per hook" convention `useGameStatePolling` established.
//
// 1. EXACT ALTERNATION CONTRACT. While `isMyTurn` is true, `document.title`
//    alternates every 1000ms, starting on the ALERT title immediately rather
//    than waiting a full second, so a glance at a background tab sees it. When
//    `isMyTurn` goes false the interval is cleared AND the title explicitly
//    restored in the same cleanup, so it can never stick mid-flash.
// 2. NO DEPENDENCY ON WHICH TAB IS FOCUSED. The title updates unconditionally,
//    matching a real tab-flash notification -- browsers only show the
//    alternating title while the tab is backgrounded anyway, which is the
//    situation this exists for.

import { useEffect } from "react";

// These two are the app's REAL title at runtime and they outrank
// `public/index.html`. The hook runs on every mount and assigns unconditionally,
// so whatever `index.html` sets is visible only for the instant before React
// mounts. Renaming the app means renaming BOTH -- missing this one leaves the
// old name flashing back a moment after load, which looks like a bug rather than
// an oversight.
export const TURN_ALERT_TITLE = "🚨 YOUR TURN! — Project 18XX";
export const TURN_NORMAL_TITLE = "Project 18XX";

const TURN_ALERT_INTERVAL_MS = 1000;

/** See the notes above. Call once, unconditionally, from the top-level app shell
 *  -- pass the already-computed `isMyTurn` boolean. This hook has no wallet or
 *  game-state knowledge of its own, matching this codebase's "presentational and
 *  effect hooks don't own address-resolution logic" split. */
export function useDocumentTitleFlash(isMyTurn: boolean): void {
  useEffect(() => {
    if (!isMyTurn) {
      document.title = TURN_NORMAL_TITLE;
      return;
    }
    let showingAlert = true;
    document.title = TURN_ALERT_TITLE;
    const intervalId = window.setInterval(() => {
      showingAlert = !showingAlert;
      document.title = showingAlert ? TURN_ALERT_TITLE : TURN_NORMAL_TITLE;
    }, TURN_ALERT_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
      document.title = TURN_NORMAL_TITLE;
    };
  }, [isMyTurn]);
}
