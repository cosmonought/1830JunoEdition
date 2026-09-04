/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1105 (harness): THE CONTROLS HAVE TO REACH THE SOUND
//
// Renamed from `sfxVolumeReach` by #1115, which added the station cases below: the file is now about every
// control that has to reach a live element, not the volume alone.
// ==================================================================
//
// REPORTED: "the SFX are absolutely crazy loud. I don't think the volume slider is actually adjusting their
// volume: at 5% it sounds just as loud as 100%."
//
// AND ONLY ONE OF THE TWO PATHS WAS BROKEN, which is why it read as "the slider does nothing" rather than as
// one wrong sound. `playVariantCue` builds a fresh element per call and had always set the level on it;
// `useSoundEffect` builds its element ONCE and set the level there, so the whistle -- the sound a player
// hears most, once per turn for a whole game -- kept the `SFX_VOLUME` default of 1 forever.
//
// SO THE CASE IS ABOUT THE ORDER OF EVENTS, not about a number. It mounts LOUD, turns the slider DOWN, and
// only then plays: the old code passes any test that sets the volume before mounting, which is exactly why
// this went unnoticed. The second case pins the path that was already correct, so a future fix to one cannot
// quietly regress the other.

export {};

const built: HTMLAudioElement[] = [];
class FakeAudio {
  volume = 1;
  src = "";
  preload = "";
  currentTime = 0;
  constructor(src?: string) {
    this.src = src ?? "";
    built.push(this as unknown as HTMLAudioElement);
  }
  play() { return Promise.resolve(); }
  pause() {}
  load() {}
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
}
(global as unknown as { Audio: unknown }).Audio = FakeAudio;
/* React 18 asks the environment to opt in before it will treat `act` as supported; without this every call
   logs "the current testing environment is not configured to support act(...)". Set before React loads. */
(global as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = require("react") as typeof import("react");
/* `React.act`, not `react-dom/test-utils`'s -- the latter warns on every call in React 18.3+, and a harness
   that prints a deprecation notice each run teaches everyone to ignore its output. */
const act = (React as unknown as { act: (cb: () => void) => void }).act;
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
const { useSoundEffect, setSfxVolume, playVariantCue, SFX_VOLUME } =
  require("./audio") as typeof import("./audio");

describe("the SFX volume reaches every sound, not just the new ones", () => {
  it("applies the live level to the whistle at play time, not at mount", () => {
    setSfxVolume(1);
    let play: (() => void) | null = null;
    function Probe() {
      play = useSoundEffect("/audio/whistle.mp3", true);
      return null;
    }
    const host = document.createElement("div");
    act(() => {
      createRoot(host).render(React.createElement(Probe));
    });
    const whistle = built[built.length - 1];
    expect(whistle.volume).toBe(1);

    // The player turns it down AFTER the element exists -- the case that was broken.
    setSfxVolume(0.05);
    act(() => {
      (play as unknown as () => void)();
    });
    expect(whistle.volume).toBeCloseTo(0.05);
  });

  it("keeps applying it to the per-call cues, which were never wrong", () => {
    setSfxVolume(0.05);
    built.length = 0;
    playVariantCue("cha-ching.mp3", true);
    expect(built).toHaveLength(1);
    expect(built[0].volume).toBeCloseTo(0.05);
    setSfxVolume(SFX_VOLUME);
  });
});

/* ==================================================================
    DESIGN NOTE 1115 (harness): CHANGING STATION WHILE IT IS PLAYING
   ==================================================================
   THE BUG THIS GUARDS is the one `toggle` cannot see: it attaches the url it closed over, so a url that
   changes underneath a running stream reaches nothing until the next stop and start. On screen that is a
   picker which appears to do nothing, which is why the case drives the hook through a real change rather
   than asserting the effect exists. */
describe("the station picker reaches the stream", () => {
  const { useRadioStream } = require("./audio") as typeof import("./audio");

  function mount(url: string) {
    let api: { playing: boolean; toggle: () => void } | null = null;
    function Probe({ src }: { src: string }) {
      api = useRadioStream(src);
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => { root.render(React.createElement(Probe, { src: url })); });
    return {
      api: () => api as unknown as { playing: boolean; toggle: () => void },
      rerender: (next: string) => act(() => { root.render(React.createElement(Probe, { src: next })); }),
    };
  }

  it("moves to the new station when it changes mid-play", () => {
    /* ==================================================================
        DESIGN NOTE 1139 SUPERSEDES THE MECHANISM, NOT THE CLAIM
       ==================================================================
       THIS ASSERTED THAT THE SAME ELEMENT TOOK THE NEW `src`, which was the mechanism #1115 used: rewind the
       one shared element in place. That is the mechanism the buffering race turned out to be about -- `load()`
       aborts a fetch without waiting for the abort to finish, so the old stream could still be heard under
       the new one.
       THE ELEMENT IS REPLACED NOW, so the old one ends up with NO src rather than the new one. The claim the
       case exists for is untouched and is what it checks: after picking a station, the radio is playing that
       station. Asserted against whichever element is live, rather than against the one that happened to be
       live before the change. */
    built.length = 0;
    const probe = mount("https://example.test/one");
    act(() => { probe.api().toggle(); });          // start
    expect(built[built.length - 1].src).toBe("https://example.test/one");
    probe.rerender("https://example.test/two");     // pick another station
    expect(built[built.length - 1].src).toBe("https://example.test/two");
    /* WHAT THIS FILE CANNOT CHECK, said out loud so the next reader does not add it and watch it pass
       vacuously: that the retired element was actually flushed. `FakeAudio.removeAttribute` here is a no-op
       and there is no `getAttribute` at all, so an assertion about the outgoing element would be testing the
       stub. `audioRaceGuard.test.ts` makes that claim against real elements instead. */
  });

  it("leaves a stopped radio stopped when the station changes", () => {
    built.length = 0;
    const probe = mount("https://example.test/one");
    const element = built[built.length - 1];
    probe.rerender("https://example.test/two");     // never started
    expect(element.src).toBe("");
    expect(probe.api().playing).toBe(false);
  });
});
