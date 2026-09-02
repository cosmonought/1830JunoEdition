/** @jest-environment jsdom */
export {};
const built: any[] = [];
class FakeAudio {
  volume = 1; src = ""; preload = ""; currentTime = 0;
  constructor(src?: string) { this.src = src ?? ""; built.push(this); }
  play() { return Promise.resolve(); }
  pause() {} load() {} removeAttribute() {}
  addEventListener() {} removeEventListener() {}
}
(global as any).Audio = FakeAudio as any;
const React = require("react");
const { act } = require("react-dom/test-utils");
const { createRoot } = require("react-dom/client");
const { useSoundEffect, setSfxVolume, playVariantCue } = require("./audio") as any;

describe("design note #1105: the slider reaches every sound", () => {
  it("the whistle takes the level at PLAY time, not at mount", () => {
    setSfxVolume(1);                       // mount while loud
    let play: any = null;
    function Probe() { play = useSoundEffect("/audio/whistle.mp3", true); return null; }
    const host = document.createElement("div");
    act(() => { createRoot(host).render(React.createElement(Probe)); });
    const whistle = built[built.length - 1];
    expect(whistle.volume).toBe(1);
    setSfxVolume(0.05);                    // then turn it down
    act(() => { play(); });
    expect(whistle.volume).toBeCloseTo(0.05);   // <- the bug: was still 1
  });

  it("a variant cue already did, and still does", () => {
    setSfxVolume(0.05);
    built.length = 0;
    playVariantCue("cha-ching.mp3", true);
    expect(built[0].volume).toBeCloseTo(0.05);
  });
});
