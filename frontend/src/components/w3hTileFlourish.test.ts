/** @jest-environment jsdom */
//
// ==================================================================
//  W3-H (harness): THE TILE FLOURISH, DRAWN -- WHAT THE BOARD PAINTS FRAME BY FRAME
// ==================================================================
//
// `tileTransitionAudio.test.tsx` mounts the board with no canvas, so its draw returns at once. These cases need the
// draw itself, so the board gets a RECORDING context: every call any 2d context receives is logged with the alpha
// and the transform it was made under (save/restore keep a real state stack), and the board's printed-element
// primitives are wrapped so each records the hex it was asked about and the alpha it was painted at. Path2D is a
// no-op stand-in; nothing here rasterises. Frames are handed to the board at chosen instants, as in the audio harness.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { HexGridRenderer } from "./HexGridRenderer";
import { STATIC_BOARD_HEXES } from "./hexBoardData";
import { axialToPixel } from "./hexGeometry";
import { TILE_CATALOG_BY_ID } from "./hexTileCatalog";
import { filterSandboxPlacements } from "./sandboxTileLegality";
import { BEAT_MS, smoothstep, windowProgress } from "./tileTransition";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/* ---- the board's printed-element primitives, wrapped to record what each was asked to paint ---- */
type PrimitiveCall = { name: string; args: unknown[]; alpha: number };
const mockPrimitiveCalls: PrimitiveCall[] = [];
jest.mock("./hexCanvasPrimitives", () => {
  const actual = jest.requireActual("./hexCanvasPrimitives");
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of [
    "drawTerrainIcon",
    "drawTerrainCompoundBadge",
    "drawLabelWithBackground",
    "drawSingleNodeNameplate",
    "drawStackedNameLabel",
    "drawHexNameLabel",
    "drawValueBadge",
  ]) {
    wrapped[name] = (...args: unknown[]) => {
      mockPrimitiveCalls.push({ name, args, alpha: (args[0] as { globalAlpha: number }).globalAlpha });
      return (actual[name] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return wrapped;
});

/* ---- a recording 2d context ---- */
class StubPath2D {
  moveTo() {}
  lineTo() {}
  closePath() {}
  arc() {}
  arcTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  rect() {}
  ellipse() {}
  addPath() {}
}
(global as unknown as { Path2D: unknown }).Path2D = StubPath2D;

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };
type CtxCall = { ctx: number; name: string; args: unknown[]; alpha: number; transform: Matrix; clipped: number };
let ctxCalls: CtxCall[] = [];
const contexts = new WeakMap<HTMLCanvasElement, unknown>();
let nextContext = 0;
const multiply = (m: Matrix, n: Matrix): Matrix => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});

function recordingContext(canvas: HTMLCanvasElement): unknown {
  const id = (nextContext += 1);
  type State = { props: Record<string, unknown>; transform: Matrix; clipped: number };
  let state: State = { props: { globalAlpha: 1, lineWidth: 1, font: "10px sans-serif" }, transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, clipped: 0 };
  const stack: State[] = [];
  const record = (name: string, args: unknown[]) =>
    ctxCalls.push({ ctx: id, name, args, alpha: state.props.globalAlpha as number, transform: { ...state.transform }, clipped: state.clipped });
  const methods: Record<string, (...args: never[]) => unknown> = {
    save: () => {
      stack.push({ props: { ...state.props }, transform: { ...state.transform }, clipped: state.clipped });
    },
    restore: () => {
      const popped = stack.pop();
      if (popped) state = popped;
    },
    clip: () => {
      state.clipped += 1;
    },
    measureText: (text: string) => ({ width: String(text).length * 6, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 }),
    getTransform: () => ({ ...state.transform }),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      state.transform = { a, b, c, d, e, f };
    },
    resetTransform: () => {
      state.transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    },
    translate: (x: number, y: number) => {
      state.transform = multiply(state.transform, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
    },
    scale: (x: number, y: number) => {
      state.transform = multiply(state.transform, { a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
    },
    rotate: (angle: number) => {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      state.transform = multiply(state.transform, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getLineDash: () => [],
    isPointInPath: () => false,
    isPointInStroke: () => false,
  };
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "canvas") return canvas;
        if (prop in methods) {
          return (...args: never[]) => {
            record(prop, args);
            return methods[prop](...args);
          };
        }
        if (prop in state.props) return state.props[prop];
        return (...args: unknown[]) => {
          record(prop, args);
        };
      },
      set(_target, prop: string, value: unknown) {
        state.props[prop] = value;
        return true;
      },
    },
  );
}

/* ---- the board, driven render by render and frame by frame ---- */
type Grid = import("./HexGridRenderer").MapGridResponse;
type Preview = { q: number; r: number; tileId: number; orientation: number; committed?: boolean } | null;
type From = { kind: "tile"; tileId: number; orientation: number } | { kind: "printed"; label: string };

const HEX = 40;
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

let container: HTMLDivElement;
let root: Root;
let clock = 0;
let frames: Array<{ id: number; run: FrameRequestCallback }> = [];
let originalFrame: typeof window.requestAnimationFrame;
let originalCancel: typeof window.cancelAnimationFrame;

beforeEach(() => {
  clock = 10_000;
  frames = [];
  ctxCalls = [];
  mockPrimitiveCalls.length = 0;
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
  jest.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let context = contexts.get(this);
    if (!context) {
      context = recordingContext(this);
      contexts.set(this, context);
    }
    return context as RenderingContext;
  } as unknown as HTMLCanvasElement["getContext"]);
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

type BoardProps = { previewTile?: Preview; terrainFeesPaid?: string[] };
/** One render of the board, as the shell would make it, at `clock`. */
function board(mapGrid: Grid, props: BoardProps = {}) {
  act(() => {
    root.render(
      createElement(HexGridRenderer, { mapGrid, previewTile: props.previewTile ?? null, terrainFeesPaid: props.terrainFeesPaid, width: 900, height: 700, hexSize: HEX }),
    );
  });
}

/** Hands the board every frame from `fromMs` to `toMs` after `startedAt`, 16 ms apart. */
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

/** What the board drew in the one frame `ms` after `startedAt`: the flourish reads only the clock. */
function frameAt(startedAt: number, ms: number) {
  ctxCalls = [];
  mockPrimitiveCalls.length = 0;
  framesBetween(startedAt, ms, ms);
  return { primitives: [...mockPrimitiveCalls], calls: [...ctxCalls] };
}

const near = (point: unknown, at: { x: number; y: number }, within: number) => {
  const p = point as { x: number; y: number };
  return Math.hypot(p.x - at.x, p.y - at.y) <= within;
};
/** The printed value's own fade on a lay nobody proposed here: out as the proposal arrives over the lead (#1471). */
const valueFadeAt = (ms: number) => 1 - smoothstep(windowProgress(ms, 0, BEAT_MS.lead));

/* ==================================================================
    VF D-12: A PRINTED HEX'S ICON, NAME AND COST FADE WITH ITS VALUE
   ================================================================== */
describe("W3-H (VF D-12): on a lay nobody proposed here the printed icon, name and cost fade with the value", () => {
  const C17 = hexAt("C17"); // a plain mountain: terrain icon + the red cost box
  const F16 = hexAt("F16"); // Scranton, a mountain city: its name + the compound [icon+cost] badge
  const c17 = axialToPixel(C17.q, C17.r, HEX);
  const f16 = axialToPixel(F16.q, F16.r, HEX);
  const iconAt = (primitives: PrimitiveCall[]) =>
    primitives.filter((call) => call.name === "drawTerrainIcon" && near(call.args[2], c17, 0.01));
  const costAt = (primitives: PrimitiveCall[]) =>
    primitives.filter((call) => call.name === "drawLabelWithBackground" && call.args[1] === "120" && near(call.args[2], c17, HEX));

  it("keeps the icon under the arriving proposal and fades the cost box on the value's clock; a confirmed proposal shows neither", () => {
    const o8 = facing("C17", { kind: "printed", label: "C17" }, 8);
    const key = `${C17.q},${C17.r}`;
    board(grid(), { terrainFeesPaid: [] });
    // A render may draw more than once; every draw of the settled board is the same picture.
    const before = { icon: iconAt(mockPrimitiveCalls), cost: costAt(mockPrimitiveCalls) };
    expect(before.icon.length).toBeGreaterThan(0);
    expect(before.cost.length).toBeGreaterThan(0);

    const startedAt = (clock += 5_000);
    board(grid(["C17", 8, o8]), { terrainFeesPaid: [key] });
    const mid = frameAt(startedAt, 64);
    // The icon sits under the tile, whose proposal fill rises on the value's curve: drawn whole, it shows the fade.
    expect(iconAt(mid.primitives)).toHaveLength(1);
    expect(iconAt(mid.primitives)[0].alpha).toBe(1);
    // The cost box is over the tile, so it is painted at the fade itself -- in the slot it had before the lay.
    const cost = costAt(mid.primitives);
    expect(cost).toHaveLength(1);
    expect(cost[0].alpha).toBeCloseTo(valueFadeAt(64), 6);
    expect(cost[0].alpha).toBeGreaterThan(0.2);
    expect(cost[0].alpha).toBeLessThan(0.8);
    expect(near(cost[0].args[2], before.cost[0].args[2] as { x: number; y: number }, 1e-9)).toBe(true);
    // Once the proposal has arrived they are gone, as the value is.
    const after = frameAt(startedAt, BEAT_MS.lead + 3 * FRAME_MS);
    expect(iconAt(after.primitives)).toHaveLength(0);
    expect(costAt(after.primitives)).toHaveLength(0);

    // A confirmed proposal: nothing printed was shown over the proposal, and nothing reappears with its flourish.
    act(() => root.unmount());
    root = createRoot(container);
    board(grid(), { terrainFeesPaid: [] });
    mockPrimitiveCalls.length = 0;
    board(grid(), { terrainFeesPaid: [], previewTile: { q: C17.q, r: C17.r, tileId: 8, orientation: o8 } });
    expect(iconAt(mockPrimitiveCalls)).toHaveLength(0);
    expect(costAt(mockPrimitiveCalls)).toHaveLength(0);
    const confirmedAt = (clock += 5_000);
    board(grid(["C17", 8, o8]), { terrainFeesPaid: [key], previewTile: { q: C17.q, r: C17.r, tileId: 8, orientation: o8, committed: true } });
    const confirmed = frameAt(confirmedAt, 64);
    expect(iconAt(confirmed.primitives)).toHaveLength(0);
    expect(costAt(confirmed.primitives)).toHaveLength(0);
  });

  it("fades a city's name and its compound cost badge at the value's alpha, where the printed hex laid them out", () => {
    const o57 = facing("F16", { kind: "printed", label: "F16" }, 57);
    const key = `${F16.q},${F16.r}`;
    const nameAt = (primitives: PrimitiveCall[]) =>
      primitives.filter((call) => call.name === "drawSingleNodeNameplate" && call.args[1] === "Scranton");
    const compoundAt = (primitives: PrimitiveCall[]) =>
      primitives.filter((call) => call.name === "drawTerrainCompoundBadge" && near(call.args[3], f16, HEX));
    board(grid(), { terrainFeesPaid: [] });
    const name0 = nameAt(mockPrimitiveCalls);
    const compound0 = compoundAt(mockPrimitiveCalls);
    expect(name0.length).toBeGreaterThan(0);
    expect(compound0.length).toBeGreaterThan(0);

    const startedAt = (clock += 5_000);
    board(grid(["F16", 57, o57]), { terrainFeesPaid: [key] });
    for (const ms of [16, 64, 112]) {
      const frame = frameAt(startedAt, ms);
      const name = nameAt(frame.primitives);
      const compound = compoundAt(frame.primitives);
      expect(name).toHaveLength(1);
      expect(compound).toHaveLength(1);
      expect(name[0].alpha).toBeCloseTo(valueFadeAt(ms), 6);
      expect(compound[0].alpha).toBeCloseTo(valueFadeAt(ms), 6);
      // Laid out as the printed hex laid them out: nothing jumps as it fades.
      expect(near(name[0].args[2], name0[0].args[2] as { x: number; y: number }, 1e-9)).toBe(true);
      expect(near(compound[0].args[3], compound0[0].args[3] as { x: number; y: number }, 1e-9)).toBe(true);
    }
    const settled = frameAt(startedAt, BEAT_MS.lead + 3 * FRAME_MS);
    expect(nameAt(settled.primitives)).toHaveLength(0);
    expect(compoundAt(settled.primitives)).toHaveLength(0);
  });
});
