/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1619 (harness): WHAT THE BOARD DOES WITH A WHEEL, ASKED OF THE BOARD
// ==================================================================
//
// THE DEFECT AS REPORTED: "the map's wheel handler calls `preventDefault()` unconditionally, so Ctrl+wheel
// browser zoom is swallowed whenever the pointer is over the board." That is what the source said, and three
// design notes in a row (#67, #773, #1014, then #1618's record) reasoned about the line from the source.
//
// WHAT THE FRAMEWORK DOES, read from its own source: React registers its delegated `wheel` listener as
// PASSIVE -- `react-dom` 18.3.1, `addTrappedEventListener`, alongside `touchstart` and `touchmove` -- so
// `preventDefault()` from an `onWheel` prop cannot cancel anything, and had not since the React 17 upgrade.
//
// WHAT WAS MEASURED, IN ONE ENGINE, BEFORE THE CHANGE: Chromium 141 headless. The event reached the canvas
// `cancelable: false` and left `defaultPrevented: false`; an ordinary wheel over the canvas scrolled the page
// exactly as far as the same wheel over the header; Chrome logged "Unable to preventDefault inside passive
// event listener invocation." each time. One engine, one version -- not a claim about any other.
//
// So the handler was removed rather than guarded: a modifier check in front of an inert call is a fix that
// reads correctly and changes nothing.
//
// WHAT THIS APPLICATION GUARANTEES, which is the only thing this file tests:
//     the app does not intercept or cancel wheel gestures over the Rail Map.
// That is deliberately narrower than "browser zoom works over the board". What a browser DOES with a wheel
// event the app has left alone is the browser's policy, it differs by engine, platform and version, and it
// is not this repository's to promise or to pin. Nothing below asserts any of it.
//
// WHY THIS FILE IS BEHAVIOURAL AND WHAT IT CAN AND CANNOT CATCH, said plainly because it is the honest limit.
// jsdom 16.7 DOES enforce the passive rule -- measured: a `{ passive: true }` listener's `preventDefault()`
// leaves `defaultPrevented` false, a `{ passive: false }` one sets it true. So these cases reproduce the
// browser faithfully, which also means the required outcome below held BEFORE the removal as well as after.
// A behavioural case therefore cannot, by itself, catch the handler coming back.
//   -- So each case asserts TWO things: the OUTCOME a reader gets (the event is never cancelled, anywhere on
//      its path, and nothing on the board moves), and the ATTEMPT (`preventDefault` is never CALLED for a
//      wheel event). The second is what a restored handler would fail, and it is still behaviour rather than
//      a source string: it watches the call, not the text.
//   -- `viewportZoom.test.ts` #1619 holds the structural half: the Rail Map installs no cancel-only wheel
//      handler, and nothing global cancels one. It does NOT forbid wheel handlers elsewhere -- a component
//      that uses the wheel for a real local interaction is fine and always was.
//
// THE MODIFIER CASES ASSERT AN APPLICATION PROPERTY AND NOT A BROWSER ONE. The app reads no modifier state on
// a wheel event -- there is no `ctrlKey` branch, no `metaKey` branch, nothing to branch in -- so every wheel
// gets the same answer whatever is held down. That is what the combinations below pin, and it is the case a
// future modifier branch would fail. They say nothing about which modifier any browser zooms with; that
// question moved to the design note, where it can carry a platform and a version.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { HexGridRenderer } from "./HexGridRenderer";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

type Grid = import("./HexGridRenderer").MapGridResponse;

const GRID: Grid = { game_id: 1, tiles: [] };
const WIDTH = 900;
const HEIGHT = 700;

let container: HTMLDivElement;
let root: Root;
/** Every `preventDefault()` CALL that reaches the DOM, by event type -- the attempt, whether or not the
 *  passive rule then swallows it. */
let cancelAttempts: string[] = [];
/** What the end of the propagation path saw: a `window` bubble-phase listener runs after React's root
 *  container listener, so this is the state of the event once the app is finished with it. */
let endOfPath: Array<{ type: string; ctrlKey: boolean; metaKey: boolean; deltaY: number; defaultPrevented: boolean }> = [];
let hexClicks: unknown[] = [];
let hexQueries: unknown[] = [];
let originalFrame: typeof window.requestAnimationFrame;
let originalCancel: typeof window.cancelAnimationFrame;

function watchEndOfPath(event: Event) {
  const wheel = event as WheelEvent;
  endOfPath.push({
    type: wheel.type,
    ctrlKey: wheel.ctrlKey,
    metaKey: wheel.metaKey,
    deltaY: wheel.deltaY,
    defaultPrevented: wheel.defaultPrevented,
  });
}

beforeEach(() => {
  cancelAttempts = [];
  endOfPath = [];
  hexClicks = [];
  hexQueries = [];
  originalFrame = window.requestAnimationFrame;
  originalCancel = window.cancelAnimationFrame;
  /* Frames are collected and never run, so nothing animates between a before and an after snapshot. The draw
     itself returns at once -- jsdom has no 2d context (`tileTransitionAudio.test.tsx` #1474). */
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => undefined;
  jest.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
  /* No media stack in jsdom (`audio.test.ts` #1009). The board preloads its tile cues on mount, and an
     unstubbed `load()` prints a "Not implemented" stack per run that has nothing to do with the wheel. */
  jest.spyOn(window.HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  jest.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());

  const nativePreventDefault = Event.prototype.preventDefault;
  jest.spyOn(Event.prototype, "preventDefault").mockImplementation(function (this: Event) {
    cancelAttempts.push(this.type);
    nativePreventDefault.call(this);
  });

  window.addEventListener("wheel", watchEndOfPath, false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(HexGridRenderer, {
        mapGrid: GRID,
        width: WIDTH,
        height: HEIGHT,
        onHexClick: (info: unknown) => hexClicks.push(info),
        onHexClickQuery: (state: unknown) => hexQueries.push(state),
      }),
    );
  });
});

afterEach(() => {
  window.removeEventListener("wheel", watchEndOfPath, false);
  act(() => {
    root.unmount();
  });
  container.remove();
  window.requestAnimationFrame = originalFrame;
  window.cancelAnimationFrame = originalCancel;
  jest.restoreAllMocks();
});

const canvas = (): HTMLCanvasElement => {
  const found = container.querySelector("canvas");
  if (!found) throw new Error("no canvas: the board did not mount");
  return found as HTMLCanvasElement;
};

/** Everything about the board a wheel event could plausibly disturb, in one comparable value: the rendered
 *  tree (selection rings, tooltips, the picker anchor), the canvas's CSS box, and its BACKING STORE. */
function mapState() {
  const c = canvas();
  return JSON.stringify({
    html: container.innerHTML,
    backing: `${c.width}x${c.height}`,
    style: c.getAttribute("style"),
    clicks: hexClicks.length,
    queries: hexQueries.length,
  });
}

interface WheelSpec {
  deltaY: number;
  deltaX?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  clientX?: number;
  clientY?: number;
}

/** One real `WheelEvent` at the canvas, dispatched the way a browser dispatches one: bubbling, cancelable,
 *  and left for the app to do what it likes with. Returns the event so the case can read what came back. */
function wheelAtCanvas(spec: WheelSpec): WheelEvent {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: spec.deltaY,
    deltaX: spec.deltaX ?? 0,
    ctrlKey: spec.ctrlKey ?? false,
    metaKey: spec.metaKey ?? false,
    shiftKey: spec.shiftKey ?? false,
    altKey: spec.altKey ?? false,
    clientX: spec.clientX ?? WIDTH / 2,
    clientY: spec.clientY ?? HEIGHT / 2,
  });
  act(() => {
    canvas().dispatchEvent(event);
  });
  return event;
}

/** The whole contract for one wheel gesture, asserted the same way every time: nothing cancelled it, nobody
 *  tried to, the end of the path agrees, and the board did not move. */
function expectHandedBack(spec: WheelSpec, before: string) {
  const event = wheelAtCanvas(spec);
  expect(event.defaultPrevented).toBe(false);
  expect(endOfPath[endOfPath.length - 1]).toMatchObject({ type: "wheel", defaultPrevented: false });
  expect(cancelAttempts).not.toContain("wheel");
  expect(mapState()).toBe(before);
}

/* ------------------------------------------------------------------ */
/* 1 and 2 -- the ordinary wheel, and the browser's zoom gesture       */
/* ------------------------------------------------------------------ */

describe("the board takes the wheel the way every other element does", () => {
  it("mounts a canvas to aim at", () => {
    /* THE FLOOR UNDER EVERY ABSENCE BELOW. A board that failed to mount would satisfy "nothing was cancelled"
       and "nothing moved" perfectly. */
    expect(canvas()).toBeTruthy();
    expect(container.innerHTML.length).toBeGreaterThan(200);
  });

  it("leaves an ordinary wheel alone", () => {
    /* #67 CALLED THIS "SCROLL CONTAINMENT" AND IT NEVER WAS ANY. The measured behaviour, before and after the
       removal, is that the page scrolls -- so "preserve the existing behaviour exactly" and "stop cancelling"
       are the same instruction here, which is the whole reason the handler could go rather than be guarded. */
    const before = mapState();
    expectHandedBack({ deltaY: 200 }, before);
  });

  it("leaves a modified wheel alone in exactly the same way", () => {
    /* A wheel carrying `ctrlKey` is the shape of event a desktop browser-zoom gesture and a trackpad pinch
       both arrive as. What that browser then does with it is its own policy and is not asserted here -- what
       IS asserted is that the app treats it no differently from any other wheel, so nothing the app does can
       stand in the way of it. */
    const before = mapState();
    expectHandedBack({ deltaY: -120, ctrlKey: true }, before);
  });

  it("never attempts a cancellation it could not make anyway", () => {
    /* THE CASE THAT WOULD FAIL IF THE HANDLER CAME BACK. jsdom enforces the passive rule, so a restored
       `onWheel` + `preventDefault` would leave `defaultPrevented` false and every outcome case above would
       still pass -- the ATTEMPT is the only observable difference, and this watches the call itself. */
    wheelAtCanvas({ deltaY: 200 });
    wheelAtCanvas({ deltaY: -120, ctrlKey: true });
    expect(cancelAttempts).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 3 -- the zoom path mutates nothing                                  */
/* ------------------------------------------------------------------ */

describe("a zoom gesture moves nothing on the board", () => {
  it("leaves the view, the render and the backing store exactly as they were", () => {
    /* THE BACKING STORE IS NAMED SEPARATELY from the rendered tree because it is the one piece of map state
       that lives on the DOM node rather than in React, so an innerHTML comparison would not see it change. */
    const before = mapState();
    const c = canvas();
    const backingBefore = { w: c.width, h: c.height };
    for (let i = 0; i < 6; i += 1) wheelAtCanvas({ deltaY: i % 2 === 0 ? -240 : 240, ctrlKey: true });
    expect(mapState()).toBe(before);
    expect({ w: canvas().width, h: canvas().height }).toEqual(backingBefore);
  });

  it("never reports a selection or a query from a wheel", () => {
    /* A wheel is not a tap, and the click path must not be reachable from one -- a player zooming the page
       over the board must not lay a tile. */
    for (const ctrlKey of [true, false]) {
      wheelAtCanvas({ deltaY: -300, ctrlKey });
      wheelAtCanvas({ deltaY: 300, ctrlKey });
    }
    expect(hexClicks).toEqual([]);
    expect(hexQueries).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 4 -- both directions                                                */
/* ------------------------------------------------------------------ */

describe("both directions get the same answer", () => {
  const DELTAS = [-1200, -240, -120, -1, 1, 120, 240, 1200];

  it("hands back a zoom gesture whichever way it turns", () => {
    /* ZOOM IN AND ZOOM OUT ARE THE SAME EVENT WITH A SIGN, and a handler that reads the sign at all is a
       handler that has started implementing a map zoom (#67 removed one; #1014 removed the rest). The tiny
       and huge magnitudes are here because a threshold is the other way that asymmetry gets written. */
    const before = mapState();
    for (const deltaY of DELTAS) expectHandedBack({ deltaY, ctrlKey: true }, before);
  });

  it("hands back an ordinary wheel whichever way it turns", () => {
    const before = mapState();
    for (const deltaY of DELTAS) expectHandedBack({ deltaY }, before);
  });

  it("gives a horizontal wheel the same answer", () => {
    /* A trackpad's sideways scroll, and the axis a re-added `deltaX` pan would reach for first. */
    const before = mapState();
    expectHandedBack({ deltaY: 0, deltaX: -240 }, before);
    expectHandedBack({ deltaY: 0, deltaX: 240 }, before);
  });
});

/* ------------------------------------------------------------------ */
/* 5 -- position independence                                          */
/* ------------------------------------------------------------------ */

describe("the answer does not depend on where the pointer is", () => {
  const POINTS: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [WIDTH / 2, HEIGHT / 2],
    [WIDTH - 1, 1],
    [1, HEIGHT - 1],
    [WIDTH - 1, HEIGHT - 1],
    [WIDTH / 4, (HEIGHT * 3) / 4],
  ];

  it("hands back a zoom gesture from every corner and the middle", () => {
    /* THE HIT-TEST TRAP. The board's interior is not uniform -- hexes, gaps, the offboard margins -- and a
       handler that consulted `pixelToAxial` before deciding would answer differently over a hex than over a
       gap. Corners included deliberately: they are outside the hex grid but inside the canvas. */
    const before = mapState();
    for (const [clientX, clientY] of POINTS) {
      expectHandedBack({ deltaY: -120, ctrlKey: true, clientX, clientY }, before);
    }
  });

  it("hands back an ordinary wheel from every corner and the middle", () => {
    const before = mapState();
    for (const [clientX, clientY] of POINTS) {
      expectHandedBack({ deltaY: 180, clientX, clientY }, before);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Modifier invariance -- an app property, not a browser one           */
/* ------------------------------------------------------------------ */

describe("the app reads no modifier state on a wheel", () => {
  /** The modifier keys only: `deltaY` is supplied by the case, so a row cannot quietly change the gesture it
   *  is meant to be varying one flag of. */
  type Modifiers = Pick<WheelSpec, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

  const COMBINATIONS: Array<[string, Modifiers]> = [
    ["no modifier", {}],
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["ctrl+shift", { ctrlKey: true, shiftKey: true }],
    ["ctrl+meta", { ctrlKey: true, metaKey: true }],
    ["ctrl+alt", { ctrlKey: true, altKey: true }],
  ];

  it.each(COMBINATIONS)("gives the same answer with %s held", (_label, modifiers) => {
    /* ONE ANSWER FOR ALL EIGHT, and the claim is about THIS APP: it does not look at modifier state on a
       wheel event, so it cannot treat one gesture differently from another. A `ctrlKey` or `metaKey` branch
       arriving here later is what these rows fail.
       WHAT THEY DELIBERATELY DO NOT SAY: which modifier any browser zooms with. That varies by engine,
       platform and version, it is nobody's promise in this repository, and a test that pinned it would fail
       on a browser release rather than on a change to this code. The design note holds those findings, dated
       and attributed. */
    const before = mapState();
    expectHandedBack({ ...modifiers, deltaY: -120 }, before);
  });
});

/* ------------------------------------------------------------------ */
/* 7 -- nothing further up the path takes it either                    */
/* ------------------------------------------------------------------ */

describe("nothing intercepts the gesture after the board is done with it", () => {
  it("reaches the end of the propagation path uncancelled", () => {
    /* THE LISTENER IS ON `window`, IN THE BUBBLE PHASE, so it runs after React's root-container listener and
       after anything the shell might attach to `document`. What it sees is what the browser will act on. */
    wheelAtCanvas({ deltaY: -120, ctrlKey: true });
    expect(endOfPath).toHaveLength(1);
    expect(endOfPath[0]).toEqual({
      type: "wheel",
      ctrlKey: true,
      metaKey: false,
      deltaY: -120,
      defaultPrevented: false,
    });
  });

  it("still reaches it after a long stream of gestures", () => {
    /* A zoom is held, not tapped: a real Ctrl+wheel is a burst of events. A handler that started cancelling
       on the fifth -- a threshold, an accumulator, a debounce -- would pass a single-event case. */
    for (let i = 0; i < 30; i += 1) wheelAtCanvas({ deltaY: i % 2 === 0 ? -120 : 120, ctrlKey: true });
    expect(endOfPath).toHaveLength(30);
    expect(endOfPath.every((seen) => seen.defaultPrevented === false)).toBe(true);
    expect(cancelAttempts).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 6 -- the pointer path is untouched by all of this                   */
/* ------------------------------------------------------------------ */

describe("the pointer path still works around the wheel", () => {
  it("keeps handling hover after a stream of wheel events", () => {
    /* THE NEIGHBOURING PATH, checked in the SAME mounted component rather than by trusting that a file which
       changed in one place did not change in another. `handlePointerMove` does hover only (#1014: the pan is
       gone), so what this proves is that it still runs and still throws nothing after the wheel work.
       The pointer, selection and coordinate contracts themselves are covered by their own suites. */
    for (let i = 0; i < 5; i += 1) wheelAtCanvas({ deltaY: -120, ctrlKey: true });
    const move = new MouseEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      clientX: WIDTH / 2,
      clientY: HEIGHT / 2,
    });
    expect(() => {
      act(() => {
        canvas().dispatchEvent(move);
      });
    }).not.toThrow();
    expect(move.defaultPrevented).toBe(false);
    expect(cancelAttempts).not.toContain("wheel");
  });

  it("keeps the canvas mounted and sized throughout", () => {
    const backing = `${canvas().width}x${canvas().height}`;
    for (let i = 0; i < 20; i += 1) wheelAtCanvas({ deltaY: 120, ctrlKey: i % 3 === 0 });
    expect(container.querySelector("canvas")).toBeTruthy();
    expect(`${canvas().width}x${canvas().height}`).toBe(backing);
  });
});
