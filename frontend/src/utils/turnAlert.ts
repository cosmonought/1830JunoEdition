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
//
//    ==================================================================
//     DESIGN NOTE 1008: SUPERSEDED -- AND ITS PREMISE WAS SIMPLY FALSE
//    ==================================================================
//
//    REPORTED: "The document.title flashing between the site name and 'YOUR TURN' must immediately stop (and
//    reset to the default site title) the moment the tab regains focus."
//
//    "BROWSERS ONLY SHOW THE ALTERNATING TITLE WHILE THE TAB IS BACKGROUNDED ANYWAY" IS NOT TRUE. The title
//    is drawn in the tab strip of the focused window too, so a player looking straight at the game watched
//    their own tab blink "YOUR TURN" at them once a second for the whole of their turn -- with the answer
//    already on screen in front of them. The rule above was written from the feature's PURPOSE (alert a
//    backgrounded tab) and then implemented as if the purpose were self-enforcing.
//
//    THE FLASH NOW RUNS ONLY WHILE THE DOCUMENT IS UNFOCUSED, which is that purpose stated as a condition
//    rather than as an intention. `focus` stops it, `blur` starts it again, and `document.hasFocus()` seeds
//    the answer at mount.
//
//    THE SEED IS NOT OPTIONAL, AND A `focus`-ONLY BINDING WOULD BE THE BUG. The common case is a turn
//    arriving while the tab is ALREADY focused -- and a window that is already focused never fires `focus`.
//    Bound to the event alone, exactly the player the report is about would flash forever, having done the
//    one thing that was supposed to stop it.
//
//    AND `blur` RE-ARMS IT DELIBERATELY. A player who looks, does not act, and leaves is in precisely the
//    state this feature exists for. Stopping permanently on the first focus would make the alert fire at most
//    once per session, which is a different bug wearing the same fix.
//
// 3. Design note #1008: this hook answers "is anybody looking at the tab", NOT "has the player acknowledged
//    their turn". The second question belongs to the on-screen glow and is answered by
//    `useTurnAcknowledgement` below -- see its note for why one flag could not serve both.

import { useEffect, useState } from "react";

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
/** Whether this document currently has focus, tracked live.
 *
 *  Design note #1008: SEEDED FROM `document.hasFocus()`, NOT FROM `false`. A hook that assumed "unfocused
 *  until told otherwise" would flash for the ordinary case -- a turn arriving at a player who is already
 *  looking -- because there is no event to correct it: `focus` fires on a TRANSITION, and a window already
 *  focused has no transition left to make.
 *  Exported for the harness, which cannot dispatch a real focus change into jsdom's window and needs to drive
 *  the same state a browser would. */
export function useDocumentFocused(): boolean {
  const [focused, setFocused] = useState<boolean>(() =>
    typeof document === "undefined" ? true : document.hasFocus(),
  );
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    /* RE-READ ON MOUNT. Between this component rendering and this effect running, the window may already have
       gained or lost focus -- an event fired in that gap has nobody listening for it, and the seeded value
       would then be stale for the rest of the session. Cheap, and it closes the one hole in the seed. */
    setFocused(document.hasFocus());
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return focused;
}

export function useDocumentTitleFlash(isMyTurn: boolean): void {
  const focused = useDocumentFocused();
  useEffect(() => {
    /* Design note #1008: `focused` joins `isMyTurn` in the SAME guard, so the restore below is reached by
       both routes. Written as one condition rather than two effects because there is exactly one thing to
       undo -- an interval and a title -- and two effects racing to restore the same string is how a title
       sticks mid-flash, which is the failure the original note point 1 was written to prevent. */
    if (!isMyTurn || focused) {
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
  }, [isMyTurn, focused]);
}

/** Whether the on-screen "your turn" glow should still be showing.
 *
 *  ==================================================================
 *   DESIGN NOTE 1008: A CLICK IS AN ACKNOWLEDGEMENT; FOCUS IS NOT
 *  ==================================================================
 *
 *  REPORTED: "The white glowing animation around the screen edges and on the Action Bar must stop as soon as
 *  the player clicks anywhere on the page ... (or tie it into the focus event as well, but a click is a
 *  definitive acknowledgment)."
 *
 *  TWO SIGNALS FOR TWO QUESTIONS, and the offered simplification is declined for a reason worth stating. The
 *  title flash asks "is anybody looking at this tab", and focus answers it exactly. The glow asks something
 *  else -- "has the player noticed it is their turn" -- and focus cannot answer that at all: in a hotseat
 *  game, or any session played in one window, the document never blurs, so a focus-driven glow would either
 *  never start or never stop. Worse, for the player who DOES alt-tab back, focus arrives before their eyes
 *  have found the bar, which is the exact moment the glow is doing its job.
 *
 *  SO FOCUS DOES NOT DISMISS THE GLOW AND A CLICK DOES NOT RE-ARM IT. The report's own instinct, kept.
 *
 *  RESET BY THE NEXT TURN, which is the half a bare `dismissed` flag would get wrong: acknowledging turn four
 *  must not silence turn five. `isMyTurn` going false and true again IS a new turn -- the same fact the flash
 *  keys on -- so the reset needs no separate notion of turn identity to disagree with.
 *
 *  CAPTURE PHASE, deliberately. A click on a control that calls `stopPropagation` never reaches a bubble-phase
 *  listener on `window`, and this app's canvas and modals both stop propagation in places. A player clicking
 *  the one control the glow is pointing at is the LEAST acceptable click to miss. */
export function useTurnAcknowledgement(isMyTurn: boolean): boolean {
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    // A new turn is a new alert. Runs on `isMyTurn` in either direction; the false case costs nothing.
    setAcknowledged(false);
  }, [isMyTurn]);

  useEffect(() => {
    if (!isMyTurn || acknowledged) return;
    const acknowledge = () => setAcknowledged(true);
    window.addEventListener("click", acknowledge, true);
    return () => window.removeEventListener("click", acknowledge, true);
  }, [isMyTurn, acknowledged]);

  return acknowledged;
}

/** The glow's own condition: it is your turn AND you have not yet acknowledged it.
 *
 *  Design note #1008: A SECOND BOOLEAN RATHER THAN A NARROWER `isMyTurn`. `isMyTurn` is a RULES fact -- it
 *  gates dispatch, the Undo control, the route drafts a player may edit and the return-to-turn bar -- and
 *  folding "have they clicked yet" into it would silently disable half the interface the moment the player
 *  touched anything. The two travel separately for the same reason #1006's blocker is bound to the placing
 *  corporation: a value that answers one question must not be reused for a second one it merely resembles. */
export function useTurnGlowActive(isMyTurn: boolean): boolean {
  const acknowledged = useTurnAcknowledgement(isMyTurn);
  return isMyTurn && !acknowledged;
}
