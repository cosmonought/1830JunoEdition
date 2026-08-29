//
// ==================================================================
//  DESIGN NOTE 1008 (harness): THE FIRST TEST IN THIS REPO THAT ACTUALLY MOUNTS SOMETHING
// ==================================================================
//
// REPORTED, two attention states that would not clear:
//   1. "The document.title flashing ... must immediately stop (and reset to the default site title) the
//      moment the tab regains focus. Bind the termination of this interval/animation to the window focus
//      event (or check document.hasFocus())."
//   2. "The white glowing animation around the screen edges and on the Action Bar must stop as soon as the
//      player clicks anywhere on the page."
//
// A SOURCE SCAN CANNOT TEST THIS AND IT IS WORTH SAYING WHY, because 100 of this repo's suites are source
// scans and reaching for one here would have been the path of least resistance. The claim being made is that
// an event listener FIRES and that an interval STOPS -- neither of which is visible in the text of the file
// that registers them. `expect(SRC).toContain('addEventListener("focus"')` passes just as happily against a
// listener registered on the wrong target, in an effect that never runs, or one whose cleanup tears it down a
// microsecond later. That is #788's unreachable arm with a green tick beside it.
//
// SO THIS ONE RENDERS. `react-dom/client` and `react-dom/test-utils` are already in the tree (React 18.3),
// there is no `@testing-library/react` to reach for, and `createRoot` + `act` is enough for a hook probe:
// mount a component that does nothing but call the hook, drive real events at the real window, and read the
// real `document.title`. No JSX, so this stays a `.ts` file.
//
// AND IT NEEDS JSDOM, so there is deliberately no `@jest-environment node` pragma at the top -- the one thing
// that would make every assertion below throw.

/* `act` FROM `react`, NOT FROM `react-dom/test-utils`. React 18.3 deprecated the test-utils export and warns
   on every call -- fourteen cases' worth of `console.error` in the run, which is exactly the noise that
   teaches a reader to skim past real warnings. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  TURN_ALERT_TITLE,
  TURN_NORMAL_TITLE,
  useDocumentFocused,
  useDocumentTitleFlash,
  useTurnGlowActive,
} from "./turnAlert";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let hasFocus: jest.SpyInstance<boolean, []>;

/** The value `useTurnGlowActive` last returned, captured out of the probe. */
let glow: boolean | null = null;

/** EVERY value `useDocumentFocused` returned, in order -- `[0]` is the first render, before any effect. */
let focusReadings: boolean[] = [];

function FocusProbe() {
  focusReadings.push(useDocumentFocused());
  return null;
}

function TitleProbe({ isMyTurn }: { isMyTurn: boolean }) {
  useDocumentTitleFlash(isMyTurn);
  return null;
}

/** EVERY value `useTurnGlowActive` returned, in order. `glow` is only the last of these; the sequence is what
 *  catches a glow that is briefly wrong and then corrects itself, which `act` hides from a bare read. */
let glowReadings: boolean[] = [];

function GlowProbe({ isMyTurn }: { isMyTurn: boolean }) {
  glow = useTurnGlowActive(isMyTurn);
  glowReadings.push(glow);
  return null;
}

/* NAMED `mount` RATHER THAN `render`, for two reasons. It re-renders as often as it first renders -- every
   case that changes `isMyTurn` calls it again -- so "render" was the narrower half of what it does. And CRA's
   optional `react-app/jest` config carries `testing-library/no-unnecessary-act`, whose heuristic fires on a
   local helper called `render` even in a project with no Testing Library in it; the project lints with plain
   `react-app` today, and a name that is simply more accurate is a better answer than a suppression waiting to
   be needed. */
function mount(element: React.ReactElement) {
  act(() => {
    root.render(element);
  });
}

/** A real event at the real window, which is the only kind these listeners can see. */
function fireWindow(type: "focus" | "blur") {
  act(() => {
    window.dispatchEvent(new Event(type));
  });
}

/** A click on a node INSIDE the page, so it travels the capture path down from `window`. */
function clickOn(target: EventTarget) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function tick(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  glow = null;
  glowReadings = [];
  focusReadings = [];
  /* THE FOCUS STATE IS MOCKED, NOT SIMULATED. jsdom has no window manager, so `document.hasFocus()` answers a
     constant and no real focus change ever happens -- driving the seed means controlling the reading. Default
     to UNFOCUSED here, because that is the state the flash exists for; the focused cases set it explicitly. */
  hasFocus = jest.spyOn(document, "hasFocus").mockReturnValue(false);
  document.title = TURN_NORMAL_TITLE;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  hasFocus.mockRestore();
  jest.useRealTimers();
});

describe("the focus reading is right on the very first render", () => {
  /* ==================================================================
     A NEGATIVE CONTROL THAT PASSED, AND WHAT IT EXPOSED
     ==================================================================
     Replacing the `document.hasFocus()` seed with a bare `false` -- the whole of a focus-event-only
     implementation -- left every case in this file green. The reason is the `setFocused(document.hasFocus())`
     re-read inside the mount effect, which corrects a wrong seed before `act` returns, so nothing downstream
     could tell the two apart.

     THE DIFFERENCE IS REAL AND IT IS ONE COMMIT WIDE. With a `false` seed, the FIRST render of a focused tab
     reports "unfocused", the title effect for that commit sets the alert string and starts an interval, and
     the correction tears both down on the next render. A frame of "YOUR TURN" in the tab strip of a tab the
     player is looking at -- the exact symptom reported, at 1/60th the duration.

     SO THE ASSERTION MOVES TO WHERE THE DIFFERENCE LIVES: the first value the hook ever returns, captured
     during render rather than after effects. Both the seed and the re-read are kept -- the seed for the first
     commit, the re-read for a focus change that lands in the gap between render and effect -- and each now
     has a case that fails without it. */
  it("reports a focused window before any effect has run", () => {
    hasFocus.mockReturnValue(true);
    mount(createElement(FocusProbe));
    expect(focusReadings[0]).toBe(true);
  });

  it("reports an unfocused window before any effect has run", () => {
    // The other half, so the case above cannot be satisfied by a hook that hard-codes `true`.
    hasFocus.mockReturnValue(false);
    mount(createElement(FocusProbe));
    expect(focusReadings[0]).toBe(false);
  });

  it("still corrects itself when focus changes between render and effect", () => {
    /* THE RE-READ'S OWN CASE, and the first draft of it did not work. That version flipped the mock inside
       `act` before calling `root.render` -- but the seed is read DURING render, which happens after that
       flip, so both reads saw the same value and dropping the re-read left the test green. A test whose two
       halves cannot disagree is a test of nothing.
       `mockImplementationOnce` puts the change in the right gap: the FIRST call is the render-time seed and
       returns unfocused, every call after it is the effect's re-read and returns focused. That is exactly
       what a `focus` event landing between render and effect looks like from inside the hook -- fired with
       no listener attached yet, so only a re-read can notice it happened. */
    hasFocus.mockReturnValue(true);
    hasFocus.mockImplementationOnce(() => false);

    mount(createElement(FocusProbe));
    expect(focusReadings[0]).toBe(false);
    expect(focusReadings[focusReadings.length - 1]).toBe(true);
  });
});

describe("the tab title flashes only while nobody is looking at the tab", () => {
  it("starts on the alert title the instant the turn arrives", () => {
    /* THE ORIGINAL CONTRACT, unchanged by this batch and asserted so the fix cannot quietly cost it: the flash
       begins on the ALERT title rather than waiting a full second, so a glance at a background tab sees it. */
    mount(createElement(TitleProbe, { isMyTurn: true }));
    expect(document.title).toBe(TURN_ALERT_TITLE);
    tick(1000);
    expect(document.title).toBe(TURN_NORMAL_TITLE);
    tick(1000);
    expect(document.title).toBe(TURN_ALERT_TITLE);
  });

  it("stops and resets the moment the window regains focus", () => {
    // The report, item 1.
    mount(createElement(TitleProbe, { isMyTurn: true }));
    expect(document.title).toBe(TURN_ALERT_TITLE);

    hasFocus.mockReturnValue(true);
    fireWindow("focus");
    expect(document.title).toBe(TURN_NORMAL_TITLE);
  });

  it("stays reset afterwards, because the interval is really cleared", () => {
    /* THE DISCRIMINATING HALF. A fix that only ASSIGNED the normal title on focus -- without clearing the
       interval -- passes the assertion above and then flashes again 1000ms later. Two full cycles, because a
       single tick could be satisfied by an interval that happened to be mid-normal. */
    mount(createElement(TitleProbe, { isMyTurn: true }));
    hasFocus.mockReturnValue(true);
    fireWindow("focus");

    tick(1000);
    expect(document.title).toBe(TURN_NORMAL_TITLE);
    tick(1000);
    expect(document.title).toBe(TURN_NORMAL_TITLE);
    tick(5000);
    expect(document.title).toBe(TURN_NORMAL_TITLE);
  });

  it("never flashes at a player who was already looking", () => {
    /* THE CASE A `focus`-EVENT-ONLY FIX MISSES ENTIRELY, and the ordinary one: the turn arrives while the tab
       is already in front of the player. A window that already has focus never fires `focus` again, so there
       is no event to stop anything -- the flash would run for the whole turn at exactly the player who needed
       it least. `document.hasFocus()` at mount is the only thing that answers this. */
    hasFocus.mockReturnValue(true);
    mount(createElement(TitleProbe, { isMyTurn: true }));

    expect(document.title).toBe(TURN_NORMAL_TITLE);
    tick(1000);
    expect(document.title).toBe(TURN_NORMAL_TITLE);
    tick(3000);
    expect(document.title).toBe(TURN_NORMAL_TITLE);
  });

  it("flashes again if the player looks away with their turn still open", () => {
    /* DELIBERATE, AND THE REPORT DOES NOT CONTRADICT IT. "Too persistent" is about an alert that will not
       clear while the player is present; a player who looks, does not act, and leaves is the exact situation
       the feature was built for. Stopping permanently on the first focus would fire the alert at most once
       per session. */
    hasFocus.mockReturnValue(true);
    mount(createElement(TitleProbe, { isMyTurn: true }));
    expect(document.title).toBe(TURN_NORMAL_TITLE);

    hasFocus.mockReturnValue(false);
    fireWindow("blur");
    expect(document.title).toBe(TURN_ALERT_TITLE);
  });

  it("says nothing at all when it is not your turn", () => {
    mount(createElement(TitleProbe, { isMyTurn: false }));
    expect(document.title).toBe(TURN_NORMAL_TITLE);
    tick(3000);
    expect(document.title).toBe(TURN_NORMAL_TITLE);
  });

  it("restores the title when the turn ends mid-flash", () => {
    // The original note's point 1: the title can never stick on the alert string.
    mount(createElement(TitleProbe, { isMyTurn: true }));
    expect(document.title).toBe(TURN_ALERT_TITLE);
    mount(createElement(TitleProbe, { isMyTurn: false }));
    expect(document.title).toBe(TURN_NORMAL_TITLE);
  });
});

describe("the screen and action-bar glow clears on the first click", () => {
  it("lights up when the turn arrives", () => {
    mount(createElement(GlowProbe, { isMyTurn: true }));
    expect(glow).toBe(true);
  });

  it("clears on a click anywhere on the page", () => {
    // The report, item 2.
    mount(createElement(GlowProbe, { isMyTurn: true }));
    clickOn(document.body);
    expect(glow).toBe(false);
  });

  it("clears even when the thing clicked stops propagation", () => {
    /* WHY THE LISTENER IS REGISTERED IN THE CAPTURE PHASE. A bubble-phase listener on `window` never sees a
       click that a control swallows -- and the control the player is most likely to click is the one the glow
       is pointing at. Capture runs window-first, on the way DOWN, so the acknowledgement lands before the
       target's own handler can stop anything. */
    const swallow = document.createElement("button");
    swallow.addEventListener("click", (event) => event.stopPropagation());
    document.body.appendChild(swallow);

    mount(createElement(GlowProbe, { isMyTurn: true }));
    clickOn(swallow);
    expect(glow).toBe(false);

    swallow.remove();
  });

  it("is NOT cleared by focus", () => {
    /* THE SIMPLIFICATION THE REPORT OFFERED AND THIS DECLINES -- "or tie it into the focus event as well".
       Two reasons, and the second is the stronger. In a hotseat game the document never blurs, so a
       focus-driven glow would never clear at all. And for the player who does alt-tab back, focus lands
       before their eyes have found the bar, which is the one moment the glow is earning its place. */
    mount(createElement(GlowProbe, { isMyTurn: true }));
    fireWindow("focus");
    expect(glow).toBe(true);
    fireWindow("blur");
    expect(glow).toBe(true);
  });

  it("lights up again on the next turn", () => {
    /* THE HALF A BARE `dismissed` FLAG GETS WRONG. Acknowledging turn four must not silence turn five, and
       the failure would be invisible: a player who never sees the glow again has no way to tell that from a
       feature that was removed. */
    mount(createElement(GlowProbe, { isMyTurn: true }));
    clickOn(document.body);
    expect(glow).toBe(false);

    mount(createElement(GlowProbe, { isMyTurn: false }));
    mount(createElement(GlowProbe, { isMyTurn: true }));
    expect(glow).toBe(true);
  });

  it("is not poisoned by clicks made while waiting for the turn", () => {
    /* A PLAYER CLICKS ALL THROUGH SOMEBODY ELSE'S TURN -- reading the ledger, checking a tile, panning the
       map. If any of those counted, the glow would be dismissed before it ever appeared, every single time,
       and the feature would be dead on arrival for anyone who does not sit perfectly still.

       A CONTROL CAUGHT THIS ASSERTION BEING TOO WEAK. Dropping `!isMyTurn` from the listener's guard -- so
       every click anywhere, at any time, marks the turn acknowledged -- left the version of this case that
       only read the FINAL value green, because the reset effect clears the stale flag on the next commit and
       `act` had already flushed it by the time the test looked.

       WHAT IT COSTS IS A FRAME, and one at the worst moment: the glow would fail to appear for the first
       commit of every turn, for exactly the player who has been clicking. So the assertion reads the whole
       SEQUENCE of values from the turn's arrival onward, where the corrected frame is still visible. */
    mount(createElement(GlowProbe, { isMyTurn: false }));
    clickOn(document.body);
    clickOn(document.body);
    expect(glow).toBe(false);

    const beforeTurn = glowReadings.length;
    mount(createElement(GlowProbe, { isMyTurn: true }));
    expect(glow).toBe(true);
    expect(glowReadings.slice(beforeTurn)).not.toContain(false);
  });

  it("stays clear once acknowledged, through re-renders of the same turn", () => {
    /* The glow must not come back on the next poll. `isMyTurn` is recomputed from game state every tick, so a
       naive implementation that re-armed on any render would flicker back on roughly once a second. */
    mount(createElement(GlowProbe, { isMyTurn: true }));
    clickOn(document.body);
    mount(createElement(GlowProbe, { isMyTurn: true }));
    mount(createElement(GlowProbe, { isMyTurn: true }));
    expect(glow).toBe(false);
  });
});
