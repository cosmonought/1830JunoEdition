/** @jest-environment jsdom */
// W3-H, AUD-15.01 (audit A-19): "background radio stays ducked."
//
// The haunting holds its deep duck until its clip's timer fires; a second haunting (or the Carcosa fog) clears
// that timer, so the first release was never called and the bed stayed at 20% for good. A hold taken in a
// named slot is now superseded by the next hold in that slot, and `releaseDuckSlot` frees a slot whose timer
// was lost. Holds without a slot -- the opening titles, the outro -- keep exactly their old semantics.

export {};

import {
  DUCK_FADE_MS,
  DUCK_FOR_CUE,
  DUCK_FOR_VIDEO,
  HAUNTING_DUCK_SLOT,
  duckRadio,
  registerDuckTarget,
  releaseDuckSlot,
} from "./audio";

let volumes: number[];
const level = () => volumes[volumes.length - 1];

beforeEach(() => {
  jest.useFakeTimers();
  volumes = [];
  registerDuckTarget(null); // resets the module's count and slots between cases
  registerDuckTarget({ setVolume: (value) => volumes.push(value) });
});

afterEach(() => {
  registerDuckTarget(null);
  jest.useRealTimers();
});

/** Let any release fade run to its end, then report where the bed settled. */
function settle(): number {
  jest.advanceTimersByTime(DUCK_FADE_MS + 200);
  return level();
}

describe("A-19: a lost haunting release no longer holds the bed down for good", () => {
  it("the reported sequence: a second haunting replaces the first, its timer clearing the first release", () => {
    // Haunting 1 ducks; its release lives only in a timer...
    const first = duckRadio(DUCK_FOR_VIDEO, HAUNTING_DUCK_SLOT);
    const full = volumes[0] / DUCK_FOR_VIDEO;
    // ...which haunting 2's dispatch clears (so `first` is never called), then takes its own duck.
    const second = duckRadio(DUCK_FOR_VIDEO, HAUNTING_DUCK_SLOT);
    expect(level()).toBeCloseTo(full * DUCK_FOR_VIDEO);
    // Haunting 2's timer fires and releases its own hold -- the only release anyone still has.
    second();
    expect(settle()).toBeCloseTo(full); // before W3-H: stuck at full * 0.2
    expect(first).toBeInstanceOf(Function);
  });

  it("supersession does not open a gap: the bed never rises between the old hold and the new one", () => {
    duckRadio(DUCK_FOR_VIDEO, HAUNTING_DUCK_SLOT);
    const ducked = level();
    const before = volumes.length;
    duckRadio(DUCK_FOR_VIDEO, HAUNTING_DUCK_SLOT);
    jest.advanceTimersByTime(DUCK_FADE_MS + 200);
    // Nothing above the ducked level was written after the second hold was taken.
    expect(Math.max(...volumes.slice(before))).toBeCloseTo(ducked);
  });

  it("releaseDuckSlot frees a slot whose timer was cleared without a new hold (the fog, or the table unmounting)", () => {
    duckRadio(DUCK_FOR_VIDEO, HAUNTING_DUCK_SLOT);
    const full = volumes[0] / DUCK_FOR_VIDEO;
    releaseDuckSlot(HAUNTING_DUCK_SLOT);
    expect(settle()).toBeCloseTo(full);
  });

  it("the slot's own release and releaseDuckSlot are the same hold: calling both does not over-release", () => {
    const titles = duckRadio(DUCK_FOR_VIDEO); // an unslotted hold that must survive
    const haunting = duckRadio(DUCK_FOR_VIDEO, HAUNTING_DUCK_SLOT);
    haunting();
    releaseDuckSlot(HAUNTING_DUCK_SLOT);
    haunting();
    jest.advanceTimersByTime(DUCK_FADE_MS + 200);
    expect(level()).toBeCloseTo((volumes[0] / DUCK_FOR_VIDEO) * DUCK_FOR_VIDEO); // titles still hold it down
    titles();
  });
});

describe("holds without a slot are untouched (the opening titles and the outro)", () => {
  it("a haunting started under the titles does not end the titles' hold when it finishes", () => {
    const titles = duckRadio(DUCK_FOR_VIDEO);
    const full = volumes[0] / DUCK_FOR_VIDEO;
    const haunting = duckRadio(DUCK_FOR_VIDEO, HAUNTING_DUCK_SLOT);
    haunting();
    expect(settle()).toBeCloseTo(full * DUCK_FOR_VIDEO); // still under the titles
    titles();
    expect(settle()).toBeCloseTo(full);
  });

  it("two unslotted holds never supersede each other", () => {
    const a = duckRadio(DUCK_FOR_CUE);
    const full = volumes[0] / DUCK_FOR_CUE;
    const b = duckRadio(DUCK_FOR_CUE);
    a();
    expect(settle()).toBeCloseTo(full * DUCK_FOR_CUE);
    b();
    expect(settle()).toBeCloseTo(full);
  });
});

describe("the shell's haunting takes its deep duck in the slot (W3-H, OD-12 RED R2: one argument)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readShell } = require("./sourceScan") as typeof import("./sourceScan");
  const SHELL = readShell();

  it("the haunting's duck names HAUNTING_DUCK_SLOT, so the next haunting supersedes it", () => {
    expect(SHELL).toMatch(/cue\.videoHasOwnAudio\s*\?\s*duckRadio\(DUCK_FOR_VIDEO,\s*HAUNTING_DUCK_SLOT\)/);
  });

  it("no shell hold of the deep duck is left without a slot", () => {
    expect(SHELL).not.toMatch(/duckRadio\(DUCK_FOR_VIDEO\)/);
  });

  it("and the shell frees the slot when the board's clip is gone and when the table unmounts", () => {
    expect(SHELL).toMatch(/if\s*\(haunting === null\)\s*releaseDuckSlot\(HAUNTING_DUCK_SLOT\)/);
    expect(SHELL).toMatch(/clearTimeout\(hauntingAudioRef\.current\.timer\);[\s\S]{0,200}?releaseDuckSlot\(HAUNTING_DUCK_SLOT\)/);
  });
});
