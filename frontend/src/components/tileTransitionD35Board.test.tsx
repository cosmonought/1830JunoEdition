/** @jest-environment jsdom */
//
// ==================================================================
//  VF D-35 (harness): THE BOARD ITSELF, FRAME BY FRAME
// ==================================================================
//
// `tileTransitionD35.test.ts` pins the pairing and the ride on real plans. This mounts `HexGridRenderer` and drives a
// real lay on ERIE's E11 -- #59 at facing 0 upgraded to #64 at facing 2, the facing where #59's second city becomes
// #64's FIRST city -- and records every ERIE reservation marker the board actually paints, frame by frame, through a
// recording 2D context (jsdom has no canvas). Against b8d5246 it fails: the board painted ONE marker, in the tile's
// artwork second city, and mid-transition that marker had left its own city for the other one.
//
// Owner rule (2026-10-05): the marker rides its own city's geometry and resolves to that city's final place at commit;
// owner ruling: a laid OO home is reserved in both its cities. Positions are compared in the hex's own unit space,
// calibrated from the settled board (two markers on two known city anchors), so nothing here assumes a zoom or pan.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { HexGridRenderer } from "./HexGridRenderer";
import { STATIC_BOARD_HEXES } from "./hexBoardData";
import { stationHomeHexes, stationTickerLabel } from "./hexContractTypes";
import { TILE_CATALOG_BY_ID } from "./hexTileCatalog";
import { filterSandboxPlacements } from "./sandboxTileLegality";
import { planTileTransition, reservationPositionAt, sampleTileTransition } from "./tileTransition";
import { tileCityAnchors } from "./TileGraphics";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

type Grid = import("./HexGridRenderer").MapGridResponse;
type Vec = { x: number; y: number };

const FRAME_MS = 16;
const EVERY_FACING = Array.from(TILE_CATALOG_BY_ID.keys()).flatMap((tileId) =>
  [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id: tileId, orientation })),
);
const ERIE = 6;
const ERIE_TICKER = stationTickerLabel(ERIE);
const E11 = (() => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === "E11");
  if (!hex) throw new Error("no E11");
  return hex;
})();
const FROM = { tileId: 59, orientation: 0 };
const TO = { tileId: 64, orientation: 2 };

/** A grid that cannot be mutated: the board must read the authority and never write it. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
const gridWith = (laid: { tileId: number; orientation: number }): Grid =>
  deepFreeze({ game_id: 1, tiles: [{ q: E11.q, r: E11.r, tile_id: laid.tileId, orientation: laid.orientation, landmark: null }] });

/* ---- a 2D context that records where reservation tickers are painted ------------------------------------------- */

let painted: Vec[] = [];
/** The ticker whose reservation markers are recorded. */
let watched = ERIE_TICKER;

/* jsdom has no Path2D either; the artwork builds paths it then hands to the context, which ignores them. */
class Path2DStub {
  addPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  arc() {}
  arcTo() {}
  ellipse() {}
  rect() {}
}
if (typeof (globalThis as { Path2D?: unknown }).Path2D === "undefined") {
  (globalThis as { Path2D?: unknown }).Path2D = Path2DStub;
}

function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { canvas, globalAlpha: 1, lineWidth: 1, font: "10px sans-serif" };
  const gradient = { addColorStop: () => {} };
  const special: Record<string, (...args: unknown[]) => unknown> = {
    measureText: (text: unknown) => ({
      width: String(text).length * 6,
      actualBoundingBoxAscent: 5,
      actualBoundingBoxDescent: 2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: String(text).length * 6,
    }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => ({ setTransform: () => {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    isPointInPath: () => false,
    isPointInStroke: () => false,
    getLineDash: () => [],
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    // Every draw of the board starts by clearing it, so what `painted` holds is always the latest whole board.
    clearRect: () => {
      painted = [];
    },
    fillText: (text: unknown, x: unknown, y: unknown) => {
      // Reservation markers are muted (`drawStationTokenMarker` at 0.45); ERIE has no token on the board.
      if (text === watched) painted.push({ x: Number(x), y: Number(y) });
    },
  };
  return new Proxy(state, {
    get(target, key) {
      if (typeof key === "string" && key in special) return special[key];
      if (key in target) return target[key];
      return () => undefined;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/* ---- the clock and the frames, as the audio harness drives them (#1474) ---------------------------------------- */

let container: HTMLDivElement;
let root: Root;
let clock = 0;
let frames: Array<{ id: number; run: FrameRequestCallback }> = [];
let originalFrame: typeof window.requestAnimationFrame;
let originalCancel: typeof window.cancelAnimationFrame;

beforeEach(() => {
  clock = 10_000;
  frames = [];
  painted = [];
  watched = ERIE_TICKER;
  jest.spyOn(performance, "now").mockImplementation(() => clock);
  originalFrame = window.requestAnimationFrame;
  originalCancel = window.cancelAnimationFrame;
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
  jest.spyOn(window.HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  jest.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  jest.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) contexts.set(this, recordingContext(this));
    return contexts.get(this) as never;
  });
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
  jest.restoreAllMocks();
});

function board(mapGrid: Grid) {
  act(() => {
    root.render(createElement(HexGridRenderer, { mapGrid, previewTile: null, width: 900, height: 700 }));
  });
}

/** The ERIE markers one frame at `at` paints. */
function frameAt(at: number): Vec[] {
  clock = at;
  const waiting = frames;
  frames = [];
  act(() => {
    waiting.forEach((frame) => frame.run(at));
  });
  return painted.slice();
}

/** What a fresh render of `mapGrid`, at rest, paints: the latest whole board once nothing is waiting for a frame. */
function settled(mapGrid: Grid): Vec[] {
  board(mapGrid);
  for (let guard = 0; frames.length > 0 && guard < 10; guard++) frameAt(clock);
  return painted.slice();
}

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

describe("VF D-35 on the mounted board: ERIE's reservation markers ride their own cities from #59 to #64", () => {
  it("paints one marker per city at rest, each marker rides its own city through every frame, and the commit lands it exactly there", () => {
    const fromGrid = gridWith(FROM);
    const toGrid = gridWith(TO);
    const fromSnapshot = JSON.stringify(fromGrid);
    const toSnapshot = JSON.stringify(toGrid);

    // At rest on #64: one marker on each city (b8d5246 painted one, in the artwork second city).
    const unitAfter = tileCityAnchors(TO.tileId, TO.orientation, { x: 0, y: 0 }, 1);
    const atRestAfter = settled(toGrid);
    expect(atRestAfter).toHaveLength(2);
    // Calibrate board pixels <-> unit hex from the two settled markers on their two known anchors.
    const scale = dist(atRestAfter[0], atRestAfter[1]) / dist(unitAfter[0], unitAfter[1]);
    const centre = { x: atRestAfter[0].x - unitAfter[0].x * scale, y: atRestAfter[0].y - unitAfter[0].y * scale };
    const toUnit = (p: Vec): Vec => ({ x: (p.x - centre.x) / scale, y: (p.y - centre.y) / scale });
    atRestAfter.forEach((p, k) => expect(dist(toUnit(p), unitAfter[k])).toBeLessThan(1e-6));

    // At rest on #59: one marker on each of its cities.
    act(() => root.unmount());
    root = createRoot(container);
    const unitBefore = tileCityAnchors(FROM.tileId, FROM.orientation, { x: 0, y: 0 }, 1);
    const atRestBefore = settled(fromGrid).map(toUnit);
    expect(atRestBefore).toHaveLength(2);
    atRestBefore.forEach((p, k) => expect(dist(p, unitBefore[k])).toBeLessThan(1e-6));

    // The lay arrives. The plan the board plays is the plan for this change.
    const plan = planTileTransition({ from: { kind: "tile", ...FROM }, to: TO })!;
    const startedAt = (clock += 5_000);
    board(toGrid);
    // #59's city k becomes the #64 city this pairs it with -- here, each the OTHER artwork index.
    // Read straight off the plan's correspondence, not through the code under test.
    const cityAt = (markers: typeof plan.toArt.markers, p: Vec) => markers.findIndex((m) => m.kind === "city" && dist(m.at, p) < 1e-3);
    const ownCity = unitBefore.map((start) => plan.cities.findIndex((city) => city.sources.includes(cityAt(plan.fromArt.markers, start))));
    const ownPlace = ownCity.map((dest) => unitAfter.findIndex((place) => cityAt(plan.toArt.markers, place) === dest));
    expect(ownPlace).toEqual([1, 0]);
    const frameCity = (t: number, dest: number) =>
      sampleTileTransition(plan, t).cities[plan.cities.slice(0, dest).filter((city) => city.kind === "city").length];
    const inside = (point: Vec, city: ReturnType<typeof frameCity>) =>
      city.blobs.some((blob) => {
        if ((blob.alpha ?? 1) <= 0) return false;
        const pts = blob.points;
        let best = dist(point, pts[0]);
        for (let k = 0; k + 1 < pts.length; k++) {
          const a = pts[k];
          const b = pts[k + 1];
          const lsq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
          const u = lsq < 1e-18 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lsq));
          best = Math.min(best, dist(point, { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }));
        }
        return best <= blob.radius + 1e-6;
      });

    let sampled = 0;
    let last: Vec[] = [];
    for (let ms = FRAME_MS; ms < plan.durationMs; ms += FRAME_MS) {
      const markers = frameAt(startedAt + ms).map(toUnit);
      last = markers;
      const t = ms / plan.durationMs;
      // Two markers in every frame of the transition -- never one, never a third.
      expect([ms, markers.length]).toEqual([ms, 2]);
      markers.forEach((at, k) => {
        // Where the pure ride puts it, on the board...
        const ride = reservationPositionAt(plan, t, { from: unitBefore[k], to: unitAfter[ownPlace[k]] });
        expect([ms, k, dist(at, ride) < 1e-6]).toEqual([ms, k, true]);
        // ...which is inside its own city's drawn station, and not inside the other city's.
        expect([ms, k, inside(at, frameCity(t, ownCity[k]))]).toEqual([ms, k, true]);
        expect([ms, k, inside(at, frameCity(t, ownCity[1 - k]))]).toEqual([ms, k, false]);
      });
      sampled += 1;
    }
    expect(sampled).toBeGreaterThan(60);

    // After the commit: the board at rest -- one marker exactly on each city -- and nothing left waiting. The rest
    // draws in the tile's city order, so each marker is found by its own city's place: the frame before the commit
    // ends had it within a hair of that place and of no other (no hand-over, no jump).
    const done = frameAt(startedAt + plan.durationMs + FRAME_MS).map(toUnit);
    expect(done).toHaveLength(2);
    done.forEach((at, k) => expect(dist(at, unitAfter[k])).toBeLessThan(1e-6));
    expect(frames).toHaveLength(0);
    last.forEach((at, k) => {
      expect(dist(at, unitAfter[ownPlace[k]])).toBeLessThan(0.02);
      expect(dist(at, unitAfter[1 - ownPlace[k]])).toBeGreaterThan(0.3);
    });

    // The authority was read, never written.
    expect(JSON.stringify(fromGrid)).toBe(fromSnapshot);
    expect(JSON.stringify(toGrid)).toBe(toSnapshot);
  });

  it("leaves a non-OO home's single reservation as it was: B&O's one marker before, through and after its home's first lay", () => {
    const BO = 4;
    const ticker = stationTickerLabel(BO);
    const home = stationHomeHexes().find((entry) => entry.companyId === BO)!;
    const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === home.label)!;
    const lay = (["Yellow", "Green", "Brown"] as const)
      .flatMap((era) => filterSandboxPlacements(EVERY_FACING, { mapGrid: { game_id: 1, tiles: [] }, q: hex.q, r: hex.r, era }))
      .find((placement) => planTileTransition({ from: { kind: "printed", label: home.label }, to: { tileId: placement.tile_id, orientation: placement.orientation } }));
    expect(lay).toBeDefined();
    const at: Vec[][] = [];
    const tracked = (fn: () => void) => {
      watched = ticker;
      fn();
      at.push(painted.slice());
    };
    const empty: Grid = deepFreeze({ game_id: 1, tiles: [] });
    const laid: Grid = deepFreeze({ game_id: 1, tiles: [{ q: hex.q, r: hex.r, tile_id: lay!.tile_id, orientation: lay!.orientation, landmark: null }] });
    tracked(() => settled(empty));
    const startedAt = (clock += 5_000);
    board(laid);
    const plan = planTileTransition({ from: { kind: "printed", label: home.label }, to: { tileId: lay!.tile_id, orientation: lay!.orientation } })!;
    for (let ms = FRAME_MS; ms < plan.durationMs; ms += 4 * FRAME_MS) tracked(() => frameAt(startedAt + ms));
    tracked(() => frameAt(startedAt + plan.durationMs + FRAME_MS));
    // One marker in every frame, as on b8d5246 -- D-35 adds a marker only to an OO home.
    expect(at.length).toBeGreaterThan(10);
    at.forEach((frame) => expect(frame).toHaveLength(1));
    watched = ERIE_TICKER;
  });
});
