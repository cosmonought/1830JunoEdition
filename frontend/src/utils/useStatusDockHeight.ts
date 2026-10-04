// frontend/src/utils/useStatusDockHeight.ts
//
// The status dock's measured height, for the shell's bottom padding.
//
// ==================================================================
//  PHASE 3 W1-I (AUD-01.04 / A-14): THE OBSERVER ATTACHES WHEN THE DOCK EXISTS
// ==================================================================
//
// THE MEASUREMENT IS #599/#605's, unchanged: a ResizeObserver reads the dock's real height, the shell reserves it as
// root padding, and a growth is scrolled by its delta in a layout effect so it does not cover content. Sub-pixel
// churn is ignored.
//
// WHAT WAS WRONG WAS WHEN IT RAN. The effect lived in `App.tsx` with `[]` dependencies and read a plain
// `useRef`. A room renders a gate page first (an early return), so on the shell's first commit the dock did not
// exist, the effect returned without observing anything, and it never ran again: the height stayed at its 96 px
// default for the whole game, and an expanded ticker or chat grew over the content the padding was meant to keep
// clear.
//
// SO THE REF IS A CALLBACK THAT STORES THE NODE IN STATE, and the observer effect depends on the node. The dock
// appearing (after the gate) attaches the observer; the dock going away disconnects it; a new dock attaches a new
// one. A newly attached dock's first reading is a baseline, not a growth, so it never scrolls the page.
//
// NO LAYOUT CHANGE: the same default, the same padding formula at the call site, the same scroll compensation.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** The height the shell assumes until the dock has been measured. */
export const STATUS_DOCK_DEFAULT_HEIGHT = 96;

export interface StatusDockMeasurement {
  /** Pass as the dock element's `ref`. Stable across renders. */
  dockRef: (node: HTMLDivElement | null) => void;
  /** The dock's last measured height in CSS px (`getBoundingClientRect`), or the default before any reading. */
  dockHeight: number;
}

export function useStatusDockHeight(initialHeight: number = STATUS_DOCK_DEFAULT_HEIGHT): StatusDockMeasurement {
  const [dockNode, setDockNode] = useState<HTMLDivElement | null>(null);
  const [dockHeight, setDockHeight] = useState(initialHeight);
  const measuredRef = useRef<number | null>(null);
  const pendingScrollRef = useRef(0);

  const dockRef = useCallback((node: HTMLDivElement | null) => setDockNode(node), []);

  useEffect(() => {
    if (!dockNode || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      const next = dockNode.getBoundingClientRect().height;
      const previous = measuredRef.current;
      // Sub-pixel churn from fractional layout is not a resize anyone asked
      // about, and compensating for it would fight the scroller.
      if (previous !== null && Math.abs(next - previous) < 1) return;
      if (previous !== null) pendingScrollRef.current += next - previous;
      measuredRef.current = next;
      setDockHeight(next);
    });
    observer.observe(dockNode);
    return () => {
      observer.disconnect();
      /* The next dock (if any) starts from a baseline: its first reading is not a delta against this one. */
      measuredRef.current = null;
      pendingScrollRef.current = 0;
    };
  }, [dockNode]);

  useLayoutEffect(() => {
    const delta = pendingScrollRef.current;
    if (delta === 0) return;
    pendingScrollRef.current = 0;
    // `scrollBy` clamps itself at both ends, so a collapse at the top of the
    // page is a no-op rather than a negative scroll.
    window.scrollBy(0, delta);
  }, [dockHeight]);

  return { dockRef, dockHeight };
}
