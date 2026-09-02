/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1105 (harness): THE SLIDER HAS TO REACH THE SOUND
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
