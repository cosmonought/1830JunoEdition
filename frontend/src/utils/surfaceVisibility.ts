// frontend/src/utils/surfaceVisibility.ts
//
// Whether a flourish's surface can be seen at all -- one predicate and two small hooks, shared by VF-1's
// transfer proxy, VF-3's float ceremony and VF-2's traveling route signal.
//
// ==================================================================
//  W3-H: OFF-SCREEN WORK IS NOT STARTED
// ==================================================================
//
// REPORTED (VISUAL_FLOURISH_BACKLOG.md C-7, E-6, F-5): each of the three flourishes ran its timers, its
// geometry and its frame clock whether or not anybody could see the surface it draws on -- a card scrolled
// out of the viewport, a board below the fold, a browser tab in the background. Harmless, and work for
// nothing. #1450's screen-space module had carried a viewport check; it went with the module.
//
// ONE FIX SHAPE, THREE SITES. "Visible" is: the document is not hidden, and the surface has a box that
// intersects the viewport. A zero-size box is NOT visible -- in a browser that is a `display: none` ancestor,
// which is exactly "an inactive tab that is still mounted". The rect and `window.innerWidth/innerHeight` are
// both viewport (visual) pixels, so there is no `uiScale` conversion here and none can go wrong (#1144).
//
// A ONE-SHOT SEQUENCE DECIDES ONCE, AT LAUNCH (`useVisibleLaunch`). A sequence whose surface is not visible
// at its first commit is DECLINED: it is never started, its timers are never left running, its geometry is
// never measured again, and the card renders the committed board -- A-3's fallback, because the
// authoritative holdings were already correct. It is not retried when the surface scrolls into view: design
// note 1453/1454 already ruled that a stage which cannot be measured must not be launched late, because a
// gesture arriving after the figures it was meant to deliver is the ordering fault #1452 removed. A late
// gesture is worse than none. A sequence that launched visibly runs to its end even if scrolled away -- the
// same "measure once, no retry" rule, in the other direction.
//
// ITS CUE GOES WITH IT. A declined sequence sounds no ceremonial cue: no presidency cue (design note 1457 --
// the sound rides the crown's own beat, and a crown that is never drawn has no beat) and no float stamp
// (VF-3's "NO SOUND FOR A CEREMONY THAT NEVER VISIBLY PLAYED", which already silences a full-motion float
// whose card could not be measured). Same reasoning as the gesture: a sound for a ceremony nobody saw is a
// sound with nothing behind it.
//
// A CONTINUOUS CLOCK PAUSES AND RESUMES (`useSurfaceVisible`). The route signal is not a ceremony but a
// standing animation, so it does not decline: it stops scheduling frames while the board is hidden and
// re-arms when the board comes back -- `visibilitychange` for the document, an IntersectionObserver for the
// board. The signal's phase is wall-clock, so it resumes where it would have been, with no catch-up.
//
// WHERE THE ENVIRONMENT CANNOT ANSWER, THE GATE STANDS ASIDE. With no layout engine at all (the document's
// own root has no box -- jsdom) every rect is zero and "is it visible" has no answer, so the surface counts
// as visible and the flourish behaves exactly as it did before this module. Likewise with no
// IntersectionObserver the board counts as on screen. A gate that guessed "hidden" there would switch off
// presentation that A-3 says must never be required -- and would silently change every existing harness.
//
// REDUCED MOTION IS OUTSIDE THE ONE-SHOT GATE, by brief ("reduced-motion paths unchanged"): its sequences draw
// nothing in flight and cost a few timers. Whether an off-screen reduced-motion sequence should also stay
// silent is left as an owner question in the ledger, not decided here.
//
// NO NEW VOCABULARY. Nothing here draws, animates, portals or registers anything; it answers one question.

import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/** `true` only when the browser says the page is in the background. */
export function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** `true` when there is no layout engine to ask: the root element itself has no box (jsdom). */
function layoutUnavailable(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return true;
  const root = document.documentElement.getBoundingClientRect();
  return root.width === 0 && root.height === 0;
}

/** Whether `node` has a box that intersects the viewport. One `getBoundingClientRect`. `null` -- the surface is
 *  not mounted -- is not on screen. */
export function isOnScreen(node: Element | null): boolean {
  if (!node) return false;
  if (layoutUnavailable()) return true;
  const rect = node.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
}

/** The shared predicate: the document is showing and `node` is on screen. */
export function isSurfaceVisible(node: Element | null): boolean {
  return !documentHidden() && isOnScreen(node);
}

/** A one-shot sequence, gated at launch. Returns `subject` when it may run and `null` once it was declined.
 *
 *  Decided ONCE per subject identity, in a layout effect -- after the commit that attached the surface and
 *  before paint. The first render is optimistic, so a visible launch renders exactly as it did before this
 *  gate; a declined one is replaced before anything is painted, and the timers its first commit scheduled
 *  are cleared before any of them can fire. `surface` is read at that moment (a getter, so the caller can
 *  name a ref or a node found by attribute). `exempt` skips the check (reduced motion; see the note above). */
export function useVisibleLaunch<T extends object>(
  subject: T | null,
  surface: () => Element | null,
  exempt: boolean,
): T | null {
  const [declined, setDeclined] = useState<T | null>(null);
  const decidedForRef = useRef<T | null>(null);
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  useLayoutEffect(() => {
    if (subject === null || decidedForRef.current === subject) return;
    decidedForRef.current = subject;
    if (exempt) return;
    if (!isSurfaceVisible(surfaceRef.current())) setDeclined(subject);
  }, [subject, exempt]);
  return subject !== null && declined !== subject ? subject : null;
}

/** A continuous clock's gate: whether the surface is visible now, kept current by `visibilitychange` and an
 *  IntersectionObserver. Subscribes only while `enabled`. Without an IntersectionObserver the surface counts
 *  as on screen. */
export function useSurfaceVisible(surfaceRef: RefObject<Element | null>, enabled: boolean): boolean {
  const [documentShown, setDocumentShown] = useState(() => !documentHidden());
  const [onScreen, setOnScreen] = useState(true);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return undefined;
    const sync = () => setDocumentShown(!documentHidden());
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const node = surfaceRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setOnScreen(true);
      return undefined;
    }
    // Seeded from the shared predicate so the first frames do not wait on the observer's first report.
    setOnScreen(isOnScreen(node));
    const observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (latest) setOnScreen(latest.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, surfaceRef]);

  return documentShown && onScreen;
}
