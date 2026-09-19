/** @jest-environment jsdom */
//
// ==================================================================
//  DESIGN NOTE 1474 (harness): WHAT A PLAYER HEARS, RENDER BY RENDER AND FRAME BY FRAME
// ==================================================================
//
// `tileTransition.test.ts` pins which cues a plan names and on which beats; `tileTransitionStaging.test.ts` pins where
// the renderer sounds them. Neither can say what a player HEARS across a real sequence -- a proposal turned and
// cancelled, a confirm, the room's grid landing after it, a hex changed again mid-flourish, the switch turned off.
// So this mounts the board and drives it: the renders are the shell's, every frame is handed to it at a chosen
// instant, and every clip the shared helper starts is recorded with the level it starts at. jsdom has no canvas, so
// the draw returns at once; what is left is exactly the part under test -- the layout effect that starts a
// transition, the frame clock that sounds it, and `playVariantCue` doing for these cues what it does for every cue.
//
// Nothing here names a beat's milliseconds: each case asks the plan for them, as the renderer does.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AudioControls } from "./AudioControls";
import { HexGridRenderer } from "./HexGridRenderer";
import { STATIC_BOARD_HEXES } from "./hexBoardData";
import { TILE_CATALOG_BY_ID } from "./hexTileCatalog";
import { filterSandboxPlacements } from "./sandboxTileLegality";
import { planTileTransition, tileTransitionCues, type TileTransitionCue } from "./tileTransition";
import { currentSfxEnabled, mirrorSfxEnabled, setSfxVolume } from "../utils/audio";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

type Grid = import("./HexGridRenderer").MapGridResponse;
type Preview = { q: number; r: number; tileId: number; orientation: number; committed?: boolean } | null;
type From = { kind: "tile"; tileId: number; orientation: number } | { kind: "printed"; label: string };

const FRAME_MS = 16;
const EVERY_FACING = Array.from(TILE_CATALOG_BY_ID.keys()).flatMap((tileId) =>
  [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id: tileId, orientation })),
);

const hexAt = (label: string) => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no hex ${label}`);
  return hex;
};

/** The first facing of `toId` the placement filter accepts on `label` over `from`. */
function facing(label: string, from: From, toId: number): number {
  const { q, r } = hexAt(label);
  const tiles = from.kind === "tile" ? [{ q, r, tile_id: from.tileId, orientation: from.orientation, landmark: null }] : [];
  const era = TILE_CATALOG_BY_ID.get(toId)?.color ?? "Yellow";
  const accepted = filterSandboxPlacements(EVERY_FACING, { mapGrid: { game_id: 1, tiles }, q, r, era })
    .filter((placement) => placement.tile_id === toId)
    .map((placement) => placement.orientation);
  if (accepted.length === 0) throw new Error(`no accepted facing of #${toId} on ${label}`);
  return accepted[0];
}

const grid = (...tiles: Array<[string, number, number]>): Grid => ({
  game_id: 1,
  tiles: tiles.map(([label, tileId, orientation]) => {
    const { q, r } = hexAt(label);
    return { q, r, tile_id: tileId, orientation, landmark: null };
  }),
});

/** The cues, and their beats, the plan for this change names -- what the player should hear, in order. */
const expected = (from: From, to: { tileId: number; orientation: number }, reducedMotion = false) =>
  tileTransitionCues(planTileTransition({ from, to, reducedMotion })!);

const FILE: Record<TileTransitionCue, string> = { track: "track.mp3", mutation: "mutation.mp3", upgrade: "upgrade.mp3" };

let container: HTMLDivElement;
let root: Root;
let clock = 0;
let frames: Array<{ id: number; run: FrameRequestCallback }> = [];
let heard: Array<{ file: string; at: number; volume: number }> = [];
let originalFrame: typeof window.requestAnimationFrame;
let originalCancel: typeof window.cancelAnimationFrame;
let originalMatchMedia: typeof window.matchMedia | undefined;

beforeEach(() => {
  clock = 10_000;
  frames = [];
  heard = [];
  jest.spyOn(performance, "now").mockImplementation(() => clock);
  originalFrame = window.requestAnimationFrame;
  originalCancel = window.cancelAnimationFrame;
  originalMatchMedia = window.matchMedia;
  let nextFrame = 1;
  window.requestAnimationFrame = (run: FrameRequestCallback) => {
    const id = nextFrame;
    nextFrame += 1;
    frames.push({ id, run });
    return id;
  };
  window.cancelAnimationFrame = (id: number) => {
    frames = frames.filter((frame) => frame.id !== id);
  };
  /* No media stack in jsdom (audio.test.ts #1009): the element is real, and only what needs a device is faked. A clip
     ends the moment it starts, so the helper's concurrency count never fills from one case to the next. */
  jest.spyOn(window.HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  jest.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    heard.push({ file: this.src.split("/").pop() ?? "", at: clock, volume: this.volume });
    this.dispatchEvent(new Event("ended"));
    return Promise.resolve();
  });
  jest.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
  mirrorSfxEnabled(true);
  setSfxVolume(1);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  window.requestAnimationFrame = originalFrame;
  window.cancelAnimationFrame = originalCancel;
  window.matchMedia = originalMatchMedia as typeof window.matchMedia;
  jest.restoreAllMocks();
  mirrorSfxEnabled(true);
  setSfxVolume(1);
});

/** One render of the board, as the shell would make it, at `clock`. */
function board(mapGrid: Grid, previewTile: Preview = null) {
  act(() => {
    root.render(createElement(HexGridRenderer, { mapGrid, previewTile, width: 900, height: 700 }));
  });
}

/** Frames every 16 ms from `fromMs` to `toMs` after `startedAt`, each handed to whatever is waiting for one. */
function framesBetween(startedAt: number, fromMs: number, toMs: number) {
  for (let ms = fromMs; ms <= toMs; ms += FRAME_MS) {
    const at = startedAt + ms;
    clock = at;
    const waiting = frames;
    frames = [];
    act(() => {
      waiting.forEach((frame) => frame.run(at));
    });
  }
}

/** What was heard, as cue files and milliseconds after `startedAt`. */
const heardSince = (startedAt: number) => heard.map((entry) => ({ file: entry.file, ms: entry.at - startedAt }));

/** Each expected cue heard once, in order, on the first frame at or past its beat. */
function expectHeardOnBeats(startedAt: number, cues: ReturnType<typeof tileTransitionCues>) {
  const got = heardSince(startedAt);
  expect(got.map((entry) => entry.file)).toEqual(cues.map((entry) => FILE[entry.cue]));
  got.forEach((entry, k) => {
    expect(entry.ms).toBeGreaterThanOrEqual(cues[k].at);
    expect(entry.ms - cues[k].at).toBeLessThan(FRAME_MS);
  });
}

const G11 = () => {
  const o8 = facing("G11", { kind: "printed", label: "G11" }, 8);
  return { o8, lay: { from: { kind: "printed" as const, label: "G11" }, to: { tileId: 8, orientation: o8 } } };
};
const H10 = () => {
  const o57 = facing("H10", { kind: "printed", label: "H10" }, 57);
  const o14 = facing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
  const o63 = facing("H10", { kind: "tile", tileId: 14, orientation: o14 }, 63);
  return { o57, o14, o63 };
};

describe("another seat's lay, heard (#1474)", () => {
  it("sounds new rail and then the commit, each once on its own beat, and nothing more however many frames follow", () => {
    const { o8, lay } = G11();
    const cues = expected(lay.from, lay.to);
    expect(cues.map((entry) => entry.cue)).toEqual(["track", "upgrade"]);
    board(grid());
    const startedAt = (clock += 5_000);
    board(grid(["G11", 8, o8]));
    framesBetween(startedAt, 0, cues[1].at + 400);
    expectHeardOnBeats(startedAt, cues);
    // The flourish is over and its clock has stopped: nothing is waiting for a frame.
    expect(frames).toHaveLength(0);
    // The same board arriving again -- a poll, a re-render -- is not a new lay.
    board(grid(["G11", 8, o8]));
    framesBetween(clock, 0, 400);
    expect(heard).toHaveLength(cues.length);
  });

  it("sounds a split's three cues once each, in the order their beats fall", () => {
    const { o57, o14 } = H10();
    const cues = expected({ kind: "tile", tileId: 57, orientation: o57 }, { tileId: 14, orientation: o14 });
    expect(cues.map((entry) => entry.cue)).toEqual(["track", "mutation", "upgrade"]);
    board(grid(["H10", 57, o57]));
    const startedAt = (clock += 5_000);
    board(grid(["H10", 14, o14]));
    framesBetween(startedAt, 0, cues[2].at + 400);
    expectHeardOnBeats(startedAt, cues);
  });
});

describe("railroad work on a B-style upgrade, heard (#1475)", () => {
  it("sounds the track cue as the existing rail starts to reform, and adds nothing when the new rail erupts", () => {
    const o53 = facing("I15", { kind: "printed", label: "I15" }, 53);
    const from = { kind: "printed" as const, label: "I15" };
    const to = { tileId: 53, orientation: o53 };
    const plan = planTileTransition({ from, to })!;
    const cues = expected(from, to);
    expect(cues.map((entry) => entry.cue)).toEqual(["track", "upgrade"]);
    const work = plan.beats.railroadWorkStart as number;
    const construction = plan.beats.constructionStart as number;
    // The migration and the morph open the transition; the eruption follows them, and the cue belongs to both.
    expect(work).toBeLessThan(construction);
    board(grid());
    const startedAt = (clock += 5_000);
    board(grid(["I15", 53, o53]));
    // Up to and past the moment the new rail erupts: the railroad-work cue, once, on its own beat.
    framesBetween(startedAt, 0, construction + FRAME_MS * 2);
    const early = heardSince(startedAt);
    expect(early.map((entry) => entry.file)).toEqual(["track.mp3"]);
    expect(early[0].ms).toBeGreaterThanOrEqual(work);
    expect(early[0].ms - work).toBeLessThan(FRAME_MS);
    // And on to the end: the commit, and nothing else -- the eruption does not restart the clip.
    framesBetween(startedAt, construction + FRAME_MS * 3, cues[1].at + 400);
    expectHeardOnBeats(startedAt, cues);
  });
});

describe("a frame that comes late (#1474)", () => {
  it("sounds what a late frame reached while the flourish still plays, at once and in order, and nothing once it has ended", () => {
    const { o57, o14 } = H10();
    const from = { kind: "tile" as const, tileId: 57, orientation: o57 };
    const to = { tileId: 14, orientation: o14 };
    const cues = expected(from, to);
    const plan = planTileTransition({ from, to })!;
    board(grid(["H10", 57, o57]));
    let startedAt = (clock += 5_000);
    board(grid(["H10", 14, o14]));
    // The browser grants one frame at the start, and the next only after the commit has begun.
    framesBetween(startedAt, 0, 0);
    const late = Math.round((cues[2].at + plan.durationMs) / 2);
    framesBetween(startedAt, late, late);
    expect(heardSince(startedAt)).toEqual(cues.map((entry) => ({ file: FILE[entry.cue], ms: late })));

    // A hidden tab: the next frame after a lay comes after its last one, and nothing it missed is played then.
    heard = [];
    board(grid(["H10", 57, o57]));
    startedAt = (clock += 5_000);
    board(grid(["H10", 14, o14]));
    framesBetween(startedAt, plan.durationMs + 2_000, plan.durationMs + 2_000);
    expect(heard).toEqual([]);
    expect(frames).toHaveLength(0);
  });
});

describe("the local player's lay, heard (#1474)", () => {
  it("is silent while a tile is chosen, turned and cancelled; sounds once from the confirm; and not again when the room's grid lands", () => {
    const { o8, lay } = G11();
    const { q, r } = hexAt("G11");
    const cues = expected(lay.from, lay.to);
    board(grid());
    board(grid(), { q, r, tileId: 8, orientation: (o8 + 1) % 6 });
    framesBetween(clock, 0, 1_500);
    board(grid(), { q, r, tileId: 8, orientation: o8 });
    framesBetween(clock, 0, 1_500);
    board(grid(), null);
    framesBetween(clock, 0, 1_500);
    board(grid(), { q, r, tileId: 8, orientation: o8 });
    framesBetween(clock, 0, 1_500);
    expect(heard).toEqual([]);

    // The confirm: the held ghost is presented, and the flourish starts from the proposal.
    const startedAt = (clock += 1_000);
    board(grid(), { q, r, tileId: 8, orientation: o8, committed: true });
    framesBetween(startedAt, 0, cues[0].at + FRAME_MS);
    // The room acknowledges mid-flourish: the grid lands the same tile, then the ghost is released.
    board(grid(["G11", 8, o8]), { q, r, tileId: 8, orientation: o8, committed: true });
    board(grid(["G11", 8, o8]), null);
    const resumeAt = clock - startedAt + FRAME_MS;
    framesBetween(startedAt, resumeAt, cues[1].at + 400);
    expectHeardOnBeats(startedAt, cues);
  });

  it("does not sound a second time when the ghost was dropped before the grid landed the lay (#1468)", () => {
    const { o8, lay } = G11();
    const { q, r } = hexAt("G11");
    const cues = expected(lay.from, lay.to);
    board(grid(), { q, r, tileId: 8, orientation: o8 });
    const startedAt = (clock += 1_000);
    board(grid(), { q, r, tileId: 8, orientation: o8, committed: true });
    framesBetween(startedAt, 0, cues[1].at + 400);
    expectHeardOnBeats(startedAt, cues);
    // The ghost's clock releases it before the round trip returns; the lay lands late.
    board(grid(), null);
    framesBetween(clock, 0, 400);
    board(grid(["G11", 8, o8]), null);
    framesBetween(clock, 0, 1_500);
    expect(heard).toHaveLength(cues.length);
  });
});

describe("an obsolete transition is never heard again (#1474)", () => {
  it("drops a superseded transition's future cues, and lets the change that replaced it sound its own", () => {
    const { o57, o14, o63 } = H10();
    const first = expected({ kind: "tile", tileId: 57, orientation: o57 }, { tileId: 14, orientation: o14 });
    const second = expected({ kind: "tile", tileId: 14, orientation: o14 }, { tileId: 63, orientation: o63 });
    board(grid(["H10", 57, o57]));
    const startedAt = (clock += 5_000);
    board(grid(["H10", 14, o14]));
    // Past the first cue, short of the second.
    framesBetween(startedAt, 0, first[0].at + FRAME_MS);
    expect(heardSince(startedAt).map((entry) => entry.file)).toEqual(["track.mp3"]);
    // The hex changes again: #14's mutation and commit belong to a transition that no longer exists.
    const secondAt = (clock += FRAME_MS);
    board(grid(["H10", 63, o63]));
    framesBetween(secondAt, 0, second[second.length - 1].at + 400);
    const later = heardSince(secondAt).slice(1);
    expect(later.map((entry) => entry.file)).toEqual(second.map((entry) => FILE[entry.cue]));
    later.forEach((entry, k) => expect(entry.ms - second[k].at).toBeLessThan(FRAME_MS));
    expect(heard.filter((entry) => entry.file === "mutation.mp3")).toHaveLength(second.filter((entry) => entry.cue === "mutation").length);
  });

  it("sounds nothing more after a hex resolves to the authority mid-flourish, a board change, or an unmount", () => {
    const { o57, o14 } = H10();
    const cues = expected({ kind: "tile", tileId: 57, orientation: o57 }, { tileId: 14, orientation: o14 });
    // Two hexes change at once: a snap, and the running flourish is dropped with it.
    board(grid(["H10", 57, o57]));
    let startedAt = (clock += 5_000);
    board(grid(["H10", 14, o14]));
    framesBetween(startedAt, 0, cues[0].at + FRAME_MS);
    board(grid(["H10", 57, o57], ["G11", 8, facing("G11", { kind: "printed", label: "G11" }, 8)]));
    framesBetween(startedAt, cues[0].at + 2 * FRAME_MS, cues[2].at + 400);
    expect(heard.map((entry) => entry.file)).toEqual(["track.mp3"]);

    // An unmount mid-flourish: the clock is cancelled with the component.
    heard = [];
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    board(grid(["H10", 57, o57]));
    startedAt = (clock += 5_000);
    board(grid(["H10", 14, o14]));
    framesBetween(startedAt, 0, cues[0].at + FRAME_MS);
    act(() => {
      root.unmount();
    });
    expect(frames).toHaveLength(0);
    root = createRoot(container);
    board(grid(["H10", 14, o14]));
    framesBetween(startedAt, cues[0].at + 2 * FRAME_MS, cues[2].at + 400);
    expect(heard.map((entry) => entry.file)).toEqual(["track.mp3"]);
  });

  it("passes over a transition's cues while a proposal on its hex hides it, and sounds those still to come once it shows", () => {
    const { o57, o14 } = H10();
    const { q, r } = hexAt("H10");
    const cues = expected({ kind: "tile", tileId: 57, orientation: o57 }, { tileId: 14, orientation: o14 });
    const proposal = { q, r, tileId: 15, orientation: 0 };
    board(grid(["H10", 57, o57]), proposal);
    const startedAt = (clock += 5_000);
    // Another seat's upgrade lands under the tile this player is still choosing there.
    board(grid(["H10", 14, o14]), proposal);
    framesBetween(startedAt, 0, cues[1].at + FRAME_MS);
    expect(heard).toEqual([]);
    // The proposal is cancelled: the flourish shows again, and only its commit is still ahead of it.
    board(grid(["H10", 14, o14]), null);
    framesBetween(startedAt, cues[1].at + 2 * FRAME_MS, cues[2].at + 400);
    expectHeardOnBeats(startedAt, cues.slice(2));
  });
});

describe("the player's audio settings, through the shared helper (#1474)", () => {
  it("is silent with the master switch off, and plays at the shared level once it is on", () => {
    const { o8 } = G11();
    const { o57, o14 } = H10();
    mirrorSfxEnabled(false);
    board(grid(["H10", 57, o57]));
    let startedAt = (clock += 5_000);
    board(grid(["H10", 14, o14]));
    framesBetween(startedAt, 0, 1_800);
    expect(heard).toEqual([]);

    mirrorSfxEnabled(true);
    setSfxVolume(0.3);
    startedAt = (clock += 5_000);
    board(grid(["H10", 14, o14], ["G11", 8, o8]));
    framesBetween(startedAt, 0, 1_800);
    expect(heard.map((entry) => entry.file)).toEqual(["track.mp3", "upgrade.mp3"]);
    heard.forEach((entry) => expect(entry.volume).toBeCloseTo(0.3, 6));
  });

  it("reads the switch the audio control shows: the control mirrors it on every change", () => {
    const controls = document.createElement("div");
    document.body.appendChild(controls);
    const controlsRoot = createRoot(controls);
    const render = (sfxEnabled: boolean) =>
      act(() => {
        controlsRoot.render(
          createElement(AudioControls, {
            audio: { musicPlaying: false, onToggleMusic: () => {}, sfxEnabled, onToggleSfx: () => {} },
          }),
        );
      });
    render(false);
    expect(currentSfxEnabled()).toBe(false);
    render(true);
    expect(currentSfxEnabled()).toBe(true);
    act(() => {
      controlsRoot.unmount();
    });
    controls.remove();
  });

  it("under reduced motion sounds only the commit, on the first frame of its fade", () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion: reduce"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const { o57, o14 } = H10();
    const cues = expected({ kind: "tile", tileId: 57, orientation: o57 }, { tileId: 14, orientation: o14 }, true);
    expect(cues.map((entry) => entry.cue)).toEqual(["upgrade"]);
    board(grid(["H10", 57, o57]));
    const startedAt = (clock += 5_000);
    board(grid(["H10", 14, o14]));
    framesBetween(startedAt, 0, 1_000);
    expectHeardOnBeats(startedAt, cues);
  });
});
