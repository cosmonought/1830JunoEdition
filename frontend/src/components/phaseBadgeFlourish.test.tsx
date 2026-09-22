/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE (VF-4 harness): WHAT THE BADGE ACTUALLY HOLDS, FRAME BY FRAME
// ==================================================================
//
// `phaseBadgeFlip.test.ts` owns the trigger and the schedule. This owns the four things only a rendered
// badge can answer:
//
//   1. A-2: the badge prints the OLD phase before the hidden midpoint, even though the authoritative
//      label and tint it is holding are already the new one -- the animation causes the change.
//   2. THE MIDPOINT IS ONE INSTANT. Old label and fold before it, new label and unfold after it; never a
//      frame with both and never a frame with neither.
//   3. THE LAST FRAME IS THE ORDINARY BADGE. No class, no transform, no animation property, no leftover
//      wrapper -- pixel-equivalent to the badge that renders with no event at all, asserted by comparing
//      the two rendered spans attribute for attribute rather than by eye.
//   4. REDUCED MOTION swaps the same way with no rotation anywhere near it.
//
// AND NOTHING LEAVES THE BADGE (A-1): `document.body` gains no child beyond this suite's own mount host in
// any case below -- no portal, no flight layer, no second plate.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PhaseBadge } from "./PhaseBadge";
import {
  PHASE_BADGE_FOLD_MS,
  PHASE_BADGE_MIDPOINT_AT_MS,
  PHASE_BADGE_REDUCED_MIDPOINT_AT_MS,
  PHASE_BADGE_REDUCED_TOTAL_MS,
  PHASE_BADGE_SETTLE_AT_MS,
  PHASE_BADGE_TOTAL_MS,
  PHASE_BADGE_UNFOLD_MS,
  type PhaseBadgeFlipEvent,
} from "./phaseBadgeFlip";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* The `window.matchMedia` mock the other flourish suites use -- jsdom has none, and every reader of the
   preference in this tree is optional-chained twice for exactly that reason. */
let reducedMotion = false;

const flip = (label: string, tint: "yellow" | "green" | "brown", token = 1): PhaseBadgeFlipEvent => ({
  label,
  tint,
  token,
});

describe("the phase badge's mechanical flip", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = (
    label: string,
    tint: "yellow" | "green" | "brown",
    event: PhaseBadgeFlipEvent | null,
  ) => {
    act(() => {
      root.render(<PhaseBadge label={label} tint={tint} flip={event} />);
    });
  };
  const tick = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });

  const badge = () => host.querySelector("span") as HTMLSpanElement;
  const text = () => badge().textContent ?? "";
  const classes = () => badge().className;

  beforeEach(() => {
    jest.useFakeTimers();
    reducedMotion = false;
    (window as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia = (
      query: string,
    ) => ({ matches: reducedMotion, media: query } as unknown as { matches: boolean });
    host = document.createElement("div");
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    jest.useRealTimers();
  });

  describe("no event", () => {
    it("is the ordinary persistent badge", () => {
      render("Phase: 4 (Green)", "green", null);
      expect(text()).toBe("Phase: 4 (Green)");
      expect(classes()).toBe("");
      expect(badge().style.animationDuration).toBe("");
      expect(badge().style.transform).toBe("");
      expect(document.body.children).toHaveLength(1);
    });
  });

  describe("a displayed phase change (full motion)", () => {
    /* The shell has already handed the badge Phase 3 -- authoritative state committed the instant the
       reducer settled (A-3). Everything below is about what the badge SHOWS while it catches up. */
    const play = () => render("Phase: 3 (Green)", "green", flip("Phase: 2 (Yellow)", "yellow"));

    it("opens on the staged OLD face, folding", () => {
      play();
      expect(text()).toBe("Phase: 2 (Yellow)");
      expect(classes()).toBe("app-phase-badge-fold");
      expect(badge().style.animationDuration).toBe(`${PHASE_BADGE_FOLD_MS}ms`);
      expect(document.body.children).toHaveLength(1);
    });

    it("still holds the old face one tick short of the midpoint", () => {
      play();
      tick(PHASE_BADGE_MIDPOINT_AT_MS - 1);
      expect(text()).toBe("Phase: 2 (Yellow)");
      expect(classes()).toBe("app-phase-badge-fold");
    });

    it("swaps label and tint at the hidden midpoint, in one instant", () => {
      play();
      tick(PHASE_BADGE_MIDPOINT_AT_MS);
      expect(text()).toBe("Phase: 3 (Green)");
      expect(classes()).toBe("app-phase-badge-unfold");
      expect(badge().style.animationDuration).toBe(`${PHASE_BADGE_UNFOLD_MS}ms`);
    });

    it("settles into a badge indistinguishable from the ordinary one", () => {
      play();
      tick(PHASE_BADGE_SETTLE_AT_MS);
      const settled = badge().outerHTML;
      /* THE COMPARISON IS AGAINST THE REAL THING, not against a list of properties somebody remembered to
         check: the same component, same props, no event -- which is what the badge renders for all but
         half a second of the game. */
      act(() => {
        root.render(<PhaseBadge label="Phase: 3 (Green)" tint="green" flip={null} />);
      });
      expect(settled).toBe(badge().outerHTML);
    });

    it("keeps that final frame after the event is withdrawn", () => {
      play();
      tick(PHASE_BADGE_TOTAL_MS);
      // The shell clears the event on its own clock; the badge must not twitch when it does.
      const before = badge().outerHTML;
      render("Phase: 3 (Green)", "green", null);
      expect(badge().outerHTML).toBe(before);
      expect(text()).toBe("Phase: 3 (Green)");
      expect(classes()).toBe("");
    });
  });

  describe("supersession", () => {
    it("restarts on a new token and leaves nothing of the first sequence behind", () => {
      render("Phase: 3 (Green)", "green", flip("Phase: 2 (Yellow)", "yellow", 1));
      tick(PHASE_BADGE_MIDPOINT_AT_MS - 10);
      // An Undo and a re-dispatch: a second displayed change lands mid-flip.
      render("Phase: 4 (Green)", "green", flip("Phase: 3 (Green)", "green", 2));
      expect(text()).toBe("Phase: 3 (Green)");
      expect(classes()).toBe("app-phase-badge-fold");
      // The first sequence's own midpoint timer must not swap anything now.
      tick(PHASE_BADGE_MIDPOINT_AT_MS - 1);
      expect(text()).toBe("Phase: 3 (Green)");
      tick(1);
      expect(text()).toBe("Phase: 4 (Green)");
      tick(PHASE_BADGE_TOTAL_MS);
      expect(classes()).toBe("");
    });
  });

  describe("reduced motion", () => {
    beforeEach(() => {
      reducedMotion = true;
    });

    it("crossfades instead of folding, and never rotates", () => {
      render("Phase: 6 (Brown)", "brown", flip("Phase: 5 (Brown)", "brown"));
      expect(text()).toBe("Phase: 5 (Brown)");
      expect(classes()).toBe("app-phase-badge-crossfade-out");
      expect(classes()).not.toContain("fold");
      expect(badge().style.transform).toBe("");
      tick(PHASE_BADGE_REDUCED_MIDPOINT_AT_MS);
      expect(text()).toBe("Phase: 6 (Brown)");
      expect(classes()).toBe("app-phase-badge-crossfade-in");
      expect(badge().style.transform).toBe("");
    });

    it("reaches the same ordinary badge, sooner", () => {
      render("Phase: 6 (Brown)", "brown", flip("Phase: 5 (Brown)", "brown"));
      tick(PHASE_BADGE_REDUCED_TOTAL_MS);
      expect(text()).toBe("Phase: 6 (Brown)");
      expect(classes()).toBe("");
      expect(PHASE_BADGE_REDUCED_TOTAL_MS).toBeLessThan(PHASE_BADGE_TOTAL_MS);
      expect(document.body.children).toHaveLength(1);
    });

    it("never attaches a rotation class even mid-sequence", () => {
      render("Phase: D (Brown)", "brown", flip("Phase: 6 (Brown)", "brown"));
      for (let elapsed = 0; elapsed <= PHASE_BADGE_REDUCED_TOTAL_MS; elapsed += 10) {
        expect(classes()).not.toContain("app-phase-badge-fold");
        expect(classes()).not.toContain("app-phase-badge-unfold");
        tick(10);
      }
    });
  });
});
