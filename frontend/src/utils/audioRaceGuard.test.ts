//
// ==================================================================
//  DESIGN NOTE 1139 (harness): THE LATE STREAM THAT ARRIVED AFTER ITS TURN
// ==================================================================
//
// REPORTED: "old streams that were delayed in buffering are occasionally resolving late and hijacking the
// current stream for a few seconds."
//
// THE THREE FIXES ASKED FOR WERE NOT THREE. The flush -- `removeAttribute("src")` then `load()` -- was
// ALREADY THERE: #1009 wrote it for the stop and #1115 reused it on every station change. The bug survived
// it, which is the clue that mattered rather than a step to repeat.
//
// SO THIS FILE IS ABOUT THE TWO THINGS THAT ARE ACTUALLY NEW -- a per-station element, so a discarded stream
// has nothing left to bleed into, and a generation token, so a `play()` that succeeds LATE cannot stand.
//
// MOUNTED, NOT READ. A race is a behaviour, and `expect(SRC).toContain("token")` would pass against a token
// that is never compared. The harness follows `audio.test.ts` next door: real elements, with the four
// methods that need a device stubbed, and `play()` resolved BY HAND so a test can choose when the buffering
// finishes relative to the next station change.
//
// NEEDS JSDOM -- deliberately no `@jest-environment node` pragma.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useRadioStream, playQuietly, type RadioStream } from "./audio";

let container: HTMLDivElement;
let root: Root;
let pause: jest.SpyInstance;
let load: jest.SpyInstance;
let built: HTMLAudioElement[] = [];
let originalAudio: typeof Audio;
let radio: RadioStream | null = null;

/** Every pending `play()`, in the order it was issued, with the resolver that finishes its buffering. */
let pending: Array<{ element: HTMLAudioElement; resolve: () => void }> = [];

function RadioProbe({ url }: { url: string }) {
  radio = useRadioStream(url);
  return null;
}

function mount(element: React.ReactElement) {
  act(() => {
    root.render(element);
  });
}

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  built = [];
  pending = [];
  radio = null;

  /* HELD OPEN RATHER THAN RESOLVED. Every other audio test wants `play()` to settle immediately; this one is
     entirely about the window between the call and the settle, so the promise is parked until a test says
     otherwise. */
  jest.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLAudioElement,
  ) {
    return new Promise<void>((resolve) => {
      pending.push({ element: this, resolve });
    });
  });
  pause = jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  load = jest.spyOn(window.HTMLMediaElement.prototype, "load").mockImplementation(() => {});

  originalAudio = window.Audio;
  window.Audio = function AudioSpy(this: unknown, src?: string) {
    const element = new originalAudio(src);
    built.push(element);
    return element;
  } as unknown as typeof Audio;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.Audio = originalAudio;
  jest.restoreAllMocks();
});

/** Finish the buffering for one element's outstanding `play()`. */
async function settle(element: HTMLAudioElement) {
  const mine = pending.filter((entry) => entry.element === element);
  pending = pending.filter((entry) => entry.element !== element);
  await act(async () => {
    mine.forEach((entry) => entry.resolve());
  });
}

const A = "https://example.test/a";
const B = "https://example.test/b";

describe("a station change cannot be undone by the station it replaced", () => {
  it("builds a NEW element rather than rewinding the old one", () => {
    /* THE FLUSH WAS ALREADY THERE AND THE BUG SURVIVED IT, because `load()` aborts a fetch without waiting
       for the abort to finish -- so the next `src` starts a second resource selection while the first is
       still unwinding. A discarded element takes its buffer, its socket and its pending play request with
       it, which is the only version of this that a late resolve cannot reach.
       COUNTED, because "it called load() again" is exactly what the old code already did. */
    mount(createElement(RadioProbe, { url: A }));
    act(() => radio!.toggle());
    const afterStart = built.length;

    mount(createElement(RadioProbe, { url: B }));
    expect(built.length).toBe(afterStart + 1);
    expect(built[built.length - 1].src).toBe(B);
  });

  it("retires the outgoing element on the way out", () => {
    mount(createElement(RadioProbe, { url: A }));
    act(() => radio!.toggle());
    const outgoing = built[built.length - 1];
    const loadsBefore = load.mock.calls.length;

    mount(createElement(RadioProbe, { url: B }));
    expect(outgoing.getAttribute("src")).toBeNull();
    expect(load.mock.calls.length).toBeGreaterThan(loadsBefore);
    expect(pause).toHaveBeenCalled();
  });

  it("silences a play that succeeds after the player has moved on", async () => {
    /* ==================================================================
        DESIGN NOTE 1139: THE CASE THE WHOLE BATCH IS ABOUT
       ==================================================================
       Station A is still buffering when the player picks B. A's `play()` then RESOLVES -- it did not fail, it
       arrived late, which is why catching rejections was never going to be enough on its own. A resolved
       `play()` has ALREADY started the sound, so the stale branch has to stop it rather than merely decline
       to act. */
    mount(createElement(RadioProbe, { url: A }));
    act(() => radio!.toggle());
    const first = built[built.length - 1];

    mount(createElement(RadioProbe, { url: B }));
    const second = built[built.length - 1];
    const pausesBefore = pause.mock.calls.length;

    await settle(first);
    /* The stale element is stopped AND unhooked -- a paused element with a live `src` is still holding the
       socket #1009 exists to close. */
    expect(pause.mock.calls.length).toBeGreaterThan(pausesBefore);
    expect(first.getAttribute("src")).toBeNull();
    // And the station the player actually chose is untouched by the other one's late arrival.
    expect(second.src).toBe(B);
  });

  it("leaves a play that is still the current one alone", async () => {
    /* THE OTHER HALF, and the one a guard this blunt could most easily break: an ordinary successful start
       must not be torn down by its own success handler. */
    mount(createElement(RadioProbe, { url: A }));
    act(() => radio!.toggle());
    const only = built[built.length - 1];

    await settle(only);
    expect(only.src).toBe(A);
    expect(only.getAttribute("src")).not.toBeNull();
    expect(radio!.playing).toBe(true);
  });

  it("stops a play that lands after the radio was switched off", async () => {
    /* A STOP INVALIDATES IN-FLIGHT WORK TOO. Without the token bump in `toggle`'s stop branch, a play issued
       a moment earlier could resolve afterwards and quietly restart a radio the player had just switched
       off -- the same fault as the station race, one control over. */
    mount(createElement(RadioProbe, { url: A }));
    act(() => radio!.toggle());
    const only = built[built.length - 1];
    act(() => radio!.toggle());

    await settle(only);
    expect(only.getAttribute("src")).toBeNull();
    expect(radio!.playing).toBe(false);
  });

  it("does not swap the element for a station picked while the radio is off", () => {
    /* #1115's GUARD, still standing: choosing a station with nothing playing is choosing what will start
       next, and rebuilding the element for it would be work with no sound attached to it. */
    mount(createElement(RadioProbe, { url: A }));
    const beforeSwitch = built.length;
    mount(createElement(RadioProbe, { url: B }));
    expect(built.length).toBe(beforeSwitch);
  });
});

describe("playQuietly keeps the contract it already had", () => {
  it("survives an engine whose play() returns undefined", () => {
    /* Design note #1009: jsdom's media stack is unimplemented and `play()` returns `undefined` there, so the
       result is checked before it is chained. #1139 moved from `.catch` to `.then(ok, fail)`, and that guard
       had to survive the move -- `undefined.then` fails exactly as loudly as `undefined.catch` did. */
    const bare = { play: () => undefined, pause: () => undefined } as unknown as HTMLAudioElement;
    expect(() => playQuietly(bare)).not.toThrow();
    expect(() => playQuietly(bare, () => false)).not.toThrow();
  });

  it("still swallows a rejection", async () => {
    const rejecting = {
      play: () => Promise.reject(new Error("NotAllowedError")),
      pause: () => undefined,
    } as unknown as HTMLAudioElement;
    expect(() => playQuietly(rejecting, () => true)).not.toThrow();
    await act(async () => {
      await Promise.resolve();
    });
  });
});
