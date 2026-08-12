// frontend/src/utils/turnAlert.ts
//
// Browser Tab Title Flash for Active Player Turn Notifications -- see
// App.tsx's own design note #18 for the dashboard-refactor pass this
// belongs to. Split into its own small hook (rather than inlined in
// App.tsx) since it's a self-contained side effect with its own
// cleanup/restore responsibility -- the same "one clear job per hook"
// convention `utils/gameState.ts`'s own `useGameStatePolling` already
// established for this codebase's other effectful hooks.
//
// Design notes:
// 1. **Exact alternation contract.** While `isMyTurn` is true, alternates
//    `document.title` every 1000ms between `TURN_ALERT_TITLE` and
//    `TURN_NORMAL_TITLE` -- starting on `TURN_ALERT_TITLE` immediately (not
//    waiting a full second for the first flash) so a player who glances at
//    a background tab sees the alert state right away. The moment
//    `isMyTurn` goes false (the effect re-runs with a new `false`
//    dependency, or this hook's owner unmounts entirely), the interval is
//    cleared AND the title is explicitly restored to `TURN_NORMAL_TITLE` in
//    that same cleanup -- so the tab title can never get stuck mid-flash on
//    the alert string after a turn ends.
// 2. **No dependency on which tab/page is focused.** `document.title`
//    updates unconditionally while `isMyTurn` is true, matching a real
//    "flash the browser tab" notification -- most browsers only actually
//    show the alternating title to the user while the tab is unfocused/in
//    the background (a focused tab's title isn't usually what a player is
//    staring at anyway), which is exactly the situation this feature exists
//    for.

import { useEffect } from "react";

export const TURN_ALERT_TITLE = "🚨 YOUR TURN! - 18Cosmos";
export const TURN_NORMAL_TITLE = "18Cosmos - Juno Edition";

const TURN_ALERT_INTERVAL_MS = 1000;

/** See design notes above. Call once, unconditionally, from the top-level
 *  app shell -- pass the already-computed `isMyTurn` boolean (this hook has
 *  no wallet/game-state knowledge of its own, matching this codebase's
 *  established "presentational/effect hooks don't own address-resolution
 *  logic" split, e.g. Chatbox.tsx's own design note #3). */
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
