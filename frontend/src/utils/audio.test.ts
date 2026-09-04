//
// ==================================================================
//  DESIGN NOTE 1009 (harness): NOTHING HERE CAN BE PROVED BY READING THE FILE
// ==================================================================
//
// REQUESTED, three claims and every one of them behavioural:
//   1. "fire exactly once when the game state changes to 'Your Turn'"  -- an edge, over time.
//   2. "The music stream should default to paused until the user clicks the music toggle."
//   3. "Ensure the .play() promise is wrapped in a catch() block to fail silently."
//
// (3) IS THE ONE A SOURCE SCAN WOULD GET MOST WRONG. `expect(SRC).toContain(".catch(")` passes against a
// catch on the wrong promise, a catch in a branch that never runs, and a catch after a `play()` that already
// threw synchronously. The only assertion worth making is that a REJECTING `play()` does not take anything
// down with it -- so this file mounts the hooks against a stubbed media element and rejects on purpose.
//
// JSDOM HAS NO MEDIA STACK AT ALL. `HTMLMediaElement.prototype.play` throws "Not implemented", which is
// itself worth knowing: an implementation that called `play()` unguarded would fail in this environment for
// the same reason it fails in a browser that blocks autoplay. The stub replaces `play`/`pause`/`load` on the
// prototype rather than mocking the `Audio` constructor, so the hooks build real elements and only the four
// methods that need a device are faked.
//
// NEEDS JSDOM -- deliberately no `@jest-environment node` pragma, since `Audio` and `HTMLMediaElement` are
// what this whole file is about.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RADIO_STREAM_URL,
  WHISTLE_SRC,
  playQuietly,
  useRadioStream,
  useTurnWhistle,
  type RadioStream,
} from "./audio";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let play: jest.SpyInstance;
let pause: jest.SpyInstance;
let load: jest.SpyInstance;

/** Every element the hooks constructed, so a test can ask what was done to which. */
let built: HTMLAudioElement[] = [];
let originalAudio: typeof Audio;

let radio: RadioStream | null = null;

function WhistleProbe({ isMyTurn, enabled }: { isMyTurn: boolean; enabled: boolean }) {
  useTurnWhistle(isMyTurn, enabled);
  return null;
}

function RadioProbe() {
  radio = useRadioStream(RADIO_STREAM_URL);
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
  radio = null;

  /* RESOLVED BY DEFAULT. A browser that allows the sound returns a promise that settles; the rejecting case
     is opted into by the tests that are about it, so a rejection anywhere else would be a real failure. */
  play = jest
    .spyOn(window.HTMLMediaElement.prototype, "play")
    .mockImplementation(() => Promise.resolve());
  pause = jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  load = jest.spyOn(window.HTMLMediaElement.prototype, "load").mockImplementation(() => {});

  /* The constructor is wrapped rather than replaced -- the elements are real, this only records them. */
  originalAudio = window.Audio;
  window.Audio = function AudioSpy(this: unknown, src?: string) {
    const element = new originalAudio(src);
    built.push(element);
    return element;
  } as unknown as typeof Audio;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  window.Audio = originalAudio;
  play.mockRestore();
  pause.mockRestore();
  load.mockRestore();
});

describe("playQuietly swallows everything play() can do wrong", () => {
  it("attaches a handler to the promise play() returns", () => {
    /* ==================================================================
       THE REPORT'S ITEM 3, ASSERTED DIRECTLY
       ==================================================================
       "Ensure the .play() promise is wrapped in a catch() block to fail silently."

       THE FIRST DRAFT OF THIS CASE COULD NOT FAIL. It created a real rejected promise, called `playQuietly`,
       then asserted `rejection.catch(() => "handled")` resolved -- which attaches a catch of the test's own
       and is therefore true whether or not the code under test attached one. An assertion that supplies the
       thing it is checking for.

       A PROMISE-SHAPED SPY IS THE HONEST FORM: hand `play()` back an object whose only job is to record
       whether `.catch` was called on it. This fails the moment the handler is dropped, which is what the
       requirement is about. The three cases below then cover what happens when the promise is not a promise
       at all. */
    /* ==================================================================
        DESIGN NOTE 1139: `.catch` BECAME `.then(ok, fail)`, AND THE SPY HAD TO FOLLOW
       ==================================================================
       THIS SPIED ON `.catch` SPECIFICALLY, which was exactly right while the failure path was the only one
       that mattered. #1139 gave the success path work to do -- a `play()` that resolves LATE, after the
       player has changed station, has already started the sound and has to be stopped -- so the handler
       moved to the two-argument `then`.
       THE CLAIM IS UNCHANGED AND IS WHAT IS ASSERTED: whatever `play()` hands back, a rejection handler is
       attached to it. Spying on `then` and checking its SECOND argument is that same requirement, stated
       against the shape the code now uses. */
    const thenSpy = jest.fn();
    play.mockReturnValue({ then: thenSpy } as unknown as Promise<void>);

    playQuietly(new Audio(WHISTLE_SRC));
    expect(thenSpy).toHaveBeenCalledTimes(1);
    expect(typeof thenSpy.mock.calls[0][1]).toBe("function");
  });

  it("survives a rejected promise", async () => {
    /* THE AUTOPLAY CASE, which is the ordinary one before the player's first click -- not an error, and
       nothing a player could act on if it were reported. Kept alongside the spy above because that one
       proves a handler was ATTACHED and this one proves the whole call is safe end to end. */
    const rejection = Promise.reject(new Error("NotAllowedError"));
    play.mockReturnValue(rejection);

    expect(() => playQuietly(new Audio(WHISTLE_SRC))).not.toThrow();
    await Promise.resolve();

    /* ITS FAILURE MODE IS LOUD, and worth recording since it does not look like a normal red test. Nothing
       here attaches a handler to `rejection` -- that is the code under test's job -- so if the handler is
       ever removed, Node sees a genuinely unhandled rejection and kills the worker rather than failing an
       assertion. Confirmed by mutating the catch away: the suite does not report "1 failed", it crashes. That
       is a real signal, just an ugly one, and a reader who meets it should look here first. */
  });

  it("survives play() returning undefined", () => {
    /* OLDER ENGINES AND JSDOM RETURN NOTHING. `element.play().catch(...)` -- the literal shape the report
       asked for -- would throw on `.catch` of `undefined` and take the render with it, which is why the
       result is checked before it is chained. */
    play.mockReturnValue(undefined as unknown as Promise<void>);
    expect(() => playQuietly(new Audio(WHISTLE_SRC))).not.toThrow();
  });

  it("survives play() throwing synchronously", () => {
    // Some engines throw rather than rejecting. Same answer, and a `.catch` alone would not cover it.
    play.mockImplementation(() => {
      throw new Error("Not implemented");
    });
    expect(() => playQuietly(new Audio(WHISTLE_SRC))).not.toThrow();
  });
});

describe("the whistle sounds on the edge into your turn", () => {
  it("does not sound while you are waiting", () => {
    mount(createElement(WhistleProbe, { isMyTurn: false, enabled: true }));
    expect(play).not.toHaveBeenCalled();
  });

  it("sounds once when the turn arrives", () => {
    mount(createElement(WhistleProbe, { isMyTurn: false, enabled: true }));
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not sound again on every poll of the same turn", () => {
    /* ==================================================================
       A CONTROL PASSED HERE, AND THE HONEST ANSWER IS THAT THE REF IS BELT AND BRACES
       ==================================================================
       This case was written as "the assertion the whole `useRef` exists for". Replacing the edge check with a
       bare `if (isMyTurn) play()` left it green, so that was not true.

       THE DEP ARRAY WAS ALREADY DOING IT. The effect is keyed `[isMyTurn, play]`, `play` is a `useCallback`
       with no dependencies, and `isMyTurn` is a boolean -- so React does not re-run the effect on a poll that
       changes nothing, and a level check inside an effect that only runs on transitions IS an edge check.
       There is no board state on which the two differ.

       THE REF STAYS, and this is the argument for it rather than a claim that it is load-bearing today. What
       it buys is that the rule is written down instead of being an emergent property of a dependency list --
       and dependency lists are edited by people fixing other things. The day `play` stops being referentially
       stable, or `enabled` joins the deps, the difference becomes a whistle on every mute toggle. A guard
       that costs one ref and states the requirement in the same words the report used is worth keeping even
       while it is redundant; what is NOT worth keeping is a test claiming to prove it.

       SO THIS CASE IS DEMOTED TO WHAT IT ACTUALLY CHECKS: repeated identical renders produce one sound. That
       is a real regression guard -- it fails the moment somebody adds a per-poll value to the deps -- it is
       just not a test of the ref. */
    mount(createElement(WhistleProbe, { isMyTurn: false, enabled: true }));
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
    for (let i = 0; i < 5; i += 1) {
      mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
    }
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("sounds again on the next turn", () => {
    mount(createElement(WhistleProbe, { isMyTurn: false, enabled: true }));
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
    mount(createElement(WhistleProbe, { isMyTurn: false, enabled: true }));
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("sounds for a page opened during your own turn", () => {
    /* THE SEED IS `false` AND THIS IS WHY. The first resolved poll takes `isMyTurn` from false to true, which
       is a real edge for a player who has just arrived. Seeding the ref from the first observed value would
       silence exactly the player who has been told nothing. */
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("stays silent when sound effects are muted", () => {
    mount(createElement(WhistleProbe, { isMyTurn: false, enabled: false }));
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: false }));
    expect(play).not.toHaveBeenCalled();
  });

  it("does not replay the turn's whistle when sound is unmuted mid-turn", () => {
    /* THE MUTE IS NOT AN EDGE. A player who unmutes halfway through their own turn is asking to hear the
       NEXT one, not to be told again about the one they are already taking. Checking `enabled` inside the
       play callback rather than in the effect's condition is what keeps that true. */
    mount(createElement(WhistleProbe, { isMyTurn: false, enabled: false }));
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: false }));
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
    expect(play).not.toHaveBeenCalled();
  });

  it("still counts the turn as heard, so the next edge is the next turn", () => {
    // The other half of the case above: muting must not desynchronise the edge detector.
    mount(createElement(WhistleProbe, { isMyTurn: false, enabled: false }));
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: false }));
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
    mount(createElement(WhistleProbe, { isMyTurn: false, enabled: true }));
    mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("rewinds before sounding, so a second turn is not swallowed", () => {
    /* ==================================================================
       THIS ASSERTION WAS VACUOUS AND A CONTROL SAID SO
       ==================================================================
       It read `expect(whistle.currentTime).toBe(0)`. jsdom never plays anything, so `currentTime` is 0 on
       every element whether or not anybody assigned it -- deleting the rewind entirely left the test green.
       #886's family of vacuities with a different mechanism: not an empty slice, a value that is already the
       expected one.

       WHAT IS OBSERVABLE IS THE WRITE, so the setter is instrumented on the prototype and the assertion is
       that the hook performed it. `play()` ON AN ALREADY-PLAYING ELEMENT IS A NO-OP, so without this the
       notification that gets swallowed is the SECOND one -- the event a player most needs to hear. */
    const rewinds: number[] = [];
    const original = Object.getOwnPropertyDescriptor(
      window.HTMLMediaElement.prototype,
      "currentTime",
    );
    Object.defineProperty(window.HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get: () => 0,
      set: (value: number) => {
        rewinds.push(value);
      },
    });

    try {
      mount(createElement(WhistleProbe, { isMyTurn: false, enabled: true }));
      mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
      expect(rewinds).toContain(0);
      expect(play).toHaveBeenCalledTimes(1);
    } finally {
      if (original) {
        Object.defineProperty(window.HTMLMediaElement.prototype, "currentTime", original);
      }
    }
  });

  it("builds the whistle from the supplied public path", () => {
    // The element the rewind above is about is the one pointed at the file that was placed in `public/`.
    mount(createElement(WhistleProbe, { isMyTurn: false, enabled: true }));
    const whistle = built.find((element) => element.src.endsWith(WHISTLE_SRC));
    expect(whistle).toBeDefined();
    expect(whistle!.preload).toBe("auto");
  });

  it("survives the browser refusing to play it", () => {
    /* END TO END: a blocked whistle must not break the turn. This is the report's item 3 asked of the caller
       rather than of `playQuietly` -- a `catch` on the helper is worth nothing if the hook re-throws. */
    play.mockReturnValue(Promise.reject(new Error("NotAllowedError")));
    expect(() => {
      mount(createElement(WhistleProbe, { isMyTurn: false, enabled: true }));
      mount(createElement(WhistleProbe, { isMyTurn: true, enabled: true }));
    }).not.toThrow();
  });
});

describe("the radio stream waits for a click", () => {
  it("starts paused and touches nothing", () => {
    /* THE AUTOPLAY RULE, and asserted as three separate absences because "paused" is not enough on its own:
       an element that fetched its source on mount is already using the network and already buffering, which
       is the half of autoplay policy that is about data rather than about noise. */
    mount(createElement(RadioProbe));
    expect(radio!.playing).toBe(false);
    expect(play).not.toHaveBeenCalled();
    const stream = built[built.length - 1];
    expect(stream.getAttribute("src")).toBeNull();
    expect(stream.preload).toBe("none");
  });

  it("attaches the station and plays on the first toggle", () => {
    mount(createElement(RadioProbe));
    act(() => radio!.toggle());
    expect(radio!.playing).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(built[built.length - 1].src).toBe(RADIO_STREAM_URL);
  });

  it("stops by dropping the connection, not merely pausing it", () => {
    /* A LIVE STREAM HAS NO USEFUL PAUSE. `pause()` alone leaves the socket open and the buffer filling, so a
       player who stops for ten minutes resumes ten minutes behind the broadcast, having downloaded all of it.
       Clearing `src` and calling `load()` is what actually closes it. */
    mount(createElement(RadioProbe));
    act(() => radio!.toggle());
    act(() => radio!.toggle());

    expect(radio!.playing).toBe(false);
    expect(pause).toHaveBeenCalled();
    expect(load).toHaveBeenCalled();
    expect(built[built.length - 1].getAttribute("src")).toBeNull();
  });

  it("re-attaches the station when started again", () => {
    mount(createElement(RadioProbe));
    act(() => radio!.toggle());
    act(() => radio!.toggle());
    act(() => radio!.toggle());
    expect(radio!.playing).toBe(true);
    expect(built[built.length - 1].src).toBe(RADIO_STREAM_URL);
  });

  it("reuses one element rather than building one per click", () => {
    /* An `Audio` per toggle is an element per click handed to the browser to keep alive. Counted rather than
       described, because "it does not leak" is the kind of claim a note makes and a test has to check. */
    mount(createElement(RadioProbe));
    const afterMount = built.length;
    act(() => radio!.toggle());
    act(() => radio!.toggle());
    act(() => radio!.toggle());
    expect(built.length).toBe(afterMount);
  });

  it("survives the browser refusing the stream", () => {
    play.mockReturnValue(Promise.reject(new Error("NotAllowedError")));
    mount(createElement(RadioProbe));
    expect(() => act(() => radio!.toggle())).not.toThrow();
    /* STILL REPORTS ITSELF AS PLAYING, which is the honest answer rather than a convenient one: the toggle
       records what the PLAYER asked for, and the element's own `playing` state is not observable to a
       rejected promise handler that deliberately knows nothing. A toggle that flipped back would leave the
       button fighting the player on a slow connection, where the promise resolves late rather than never. */
    expect(radio!.playing).toBe(true);
  });

  it("stops the stream when the app unmounts", () => {
    mount(createElement(RadioProbe));
    act(() => radio!.toggle());
    const stream = built[built.length - 1];
    pause.mockClear();

    act(() => root.render(createElement("div")));
    expect(pause).toHaveBeenCalled();
    expect(stream.getAttribute("src")).toBeNull();
  });
});
