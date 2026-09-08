// frontend/src/components/trackOutline.test.ts
//
// Design note #1330: every rail wears a white outline, junctions merge, crossings pass over.
//
// ASKED FOR: "all black tracks have a crisp white outline/border ... where tracks meet, the black fills merge
// seamlessly without white lines cutting through them ... for tiles where tracks cross without intersecting,
// we need a strict Z-order", and then, on the first cut: "tracks that merge (like the preprinted green H12)
// should not print the white border in the merged tracks ... tracks that are merged/merging share a border"
// -- with the crossings on #43-#47 and #70 still gapped.
//
// Three parts. WHICH RAILS SHARE A LAYER and WHERE THEY CROSS are derived from the artwork and pinned tile by
// tile below; WHAT THE CANVAS IS TOLD is recorded from a stub context, because the order of stroke calls IS
// the feature -- a white stroke after a black one on the same layer is the seam this removes.

import { TILE_GRAPHICS_CATALOG, tileArtworkDrawing, trackCrossingsFor, trackLayersFor } from "./TileGraphics";
import {
  TRACK_OUTLINE_EXTRA_PX,
  TRACK_OUTLINE_INK,
  drawHardcodedTileArtwork,
  drawOffboardTrack,
  drawPrintedTrack,
  trackPenWidth,
} from "./hexCanvasPrimitives";

/* jsdom has no `Path2D`. The renderer only ever hands one back to `ctx.stroke`, so a shell that remembers
   its `d` string is the whole of what the recording below needs. */
beforeAll(() => {
  if (typeof (globalThis as { Path2D?: unknown }).Path2D === "undefined") {
    (globalThis as { Path2D?: unknown }).Path2D = class {
      d?: string;
      constructor(d?: string) {
        this.d = d;
      }
      moveTo(): void {}
      lineTo(): void {}
      bezierCurveTo(): void {}
      closePath(): void {}
    };
  }
});

interface Stroke {
  fn: "stroke" | "fill";
  style: unknown;
  width: unknown;
  cap: unknown;
}

/** Records every `stroke`/`fill` with the pen state in force at that moment; every other call is swallowed. */
function recordingContext(): { ctx: CanvasRenderingContext2D; strokes: Stroke[]; calls: string[] } {
  const strokes: Stroke[] = [];
  const calls: string[] = [];
  const own: Record<string, unknown> = {
    measureText: (text: string) => ({ width: String(text).length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    font: "10px sans-serif",
  };
  const ctx = new Proxy(own, {
    get(target, prop) {
      const key = String(prop);
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push(key);
        if ((key === "stroke" || key === "fill") && args.length > 0) {
          strokes.push({ fn: key, style: target[key === "stroke" ? "strokeStyle" : "fillStyle"], width: target.lineWidth, cap: target.lineCap });
        }
        return undefined;
      };
    },
    set(target, prop, value) {
      target[String(prop)] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, calls };
}

const CENTRE = { x: 50, y: 50 };
const SIZE = 40;
const INK = "#101010";

describe("which rails share a layer (derived from the artwork)", () => {
  const indices = (tileId: number) => trackLayersFor(TILE_GRAPHICS_CATALOG[tileId].tracks);

  it("puts rails that touch in one layer, so a merge shares one outline", () => {
    expect(indices(23)).toEqual([[0, 1]]); // straight + curve leaving the same edge
    expect(indices(24)).toEqual([[0, 1]]); // H12's printed tile on the expanded board
    expect(indices(14)).toEqual([[0, 1, 2, 3]]); // four spokes, one station
    expect(indices(57)).toEqual([[0]]);
    expect(indices(63)).toEqual([[0, 1, 2, 3, 4, 5]]);
    expect(indices(513)).toEqual([[0, 1, 2, 3, 4, 5]]);
    for (const tileId of [43, 44, 45, 46, 47, 70]) expect(indices(tileId)).toEqual([[0, 1, 2, 3]]);
  });

  it("gives a rail that touches nothing its own layer, so a crossing between layers is an overpass", () => {
    expect(indices(17)).toEqual([[0], [1]]);
    expect(indices(35)).toEqual([[0], [1]]);
    expect(indices(36)).toEqual([[0], [1]]);
    expect(indices(1)).toEqual([[0], [1]]);
    expect(indices(19)).toEqual([[0], [1]]);
    expect(indices(59)).toEqual([[0], [1]]); // two spurs: two layers, though they never cross
  });

  it("draws each of #167's cities with its three spokes as one shape, one city over the other", () => {
    expect(indices(167)).toEqual([[0, 1, 2], [3, 4, 5]]);
    expect(indices(810)).toEqual([[0, 1, 2], [3, 4, 5]]);
    expect(indices(882)).toEqual([[0, 1, 2], [3, 4, 5]]);
  });

  it("honours an authored z-order over the derived one", () => {
    expect(trackLayersFor(TILE_GRAPHICS_CATALOG[17].tracks, [[1], [0]])).toEqual([[1], [0]]);
  });

  it("never loses or repeats a rail, on any tile", () => {
    for (const [id, art] of Object.entries(TILE_GRAPHICS_CATALOG)) {
      const flat = trackLayersFor(art.tracks).flat().sort((a, b) => a - b);
      expect({ id, flat }).toEqual({ id, flat: art.tracks.map((_, index) => index) });
      expect(tileArtworkDrawing(Number(id))!.layers.flat()).toHaveLength(art.tracks.length);
    }
  });
});

describe("where rails of one layer cross (derived from the artwork)", () => {
  const crossings = (tileId: number) => {
    const tracks = TILE_GRAPHICS_CATALOG[tileId].tracks;
    return trackCrossingsFor(tracks, trackLayersFor(tracks));
  };

  it("finds the one overpass on each brown four-rail tile, the higher-numbered rail on top", () => {
    expect(crossings(43).map((c) => [c.over, c.under])).toEqual([[3, 0]]);
    expect(crossings(44).map((c) => [c.over, c.under])).toEqual([[2, 1]]); // two straights, at the centre
    expect(crossings(45).map((c) => [c.over, c.under])).toEqual([[3, 0]]);
    expect(crossings(46).map((c) => [c.over, c.under])).toEqual([[2, 1]]);
    expect(crossings(47).map((c) => [c.over, c.under])).toEqual([[3, 0]]);
    expect(crossings(70).map((c) => [c.over, c.under])).toEqual([[2, 1]]);
    const centre = crossings(44)[0];
    expect(Math.hypot(centre.x, centre.y)).toBeLessThan(0.01);
    expect(centre.sinAngle).toBeCloseTo(Math.sin(Math.PI / 3), 2);
  });

  it("finds none where rails only fork or only hub", () => {
    for (const tileId of [23, 24, 14, 63, 57, 513, 167]) expect(crossings(tileId)).toEqual([]);
  });

  it("finds none between layers: those cross by draw order already", () => {
    for (const tileId of [17, 35, 19, 1]) expect(crossings(tileId)).toEqual([]);
  });
});

describe("what the canvas is told", () => {
  const pen = trackPenWidth(SIZE) / SIZE;
  const outline = (TRACK_OUTLINE_EXTRA_PX + trackPenWidth(SIZE)) / SIZE;

  it("strokes a fork white-white then black-black -- one shared outline, no white inside the merge", () => {
    const { ctx, strokes } = recordingContext();
    drawHardcodedTileArtwork(ctx, CENTRE, SIZE, 24, 0, INK); // H12's printed tile
    const rails = strokes.filter((s) => s.fn === "stroke");
    expect(rails.map((s) => [s.style, s.cap])).toEqual([
      [TRACK_OUTLINE_INK, "butt"],
      [TRACK_OUTLINE_INK, "butt"],
      [INK, "butt"],
      [INK, "butt"],
    ]);
    expect(rails[0].width).toBeCloseTo(outline);
    expect(rails[2].width).toBeCloseTo(pen);
  });

  it("strokes a two-layer tile one rail at a time, each white then black, so the upper rail gaps the lower", () => {
    const { ctx, strokes } = recordingContext();
    drawHardcodedTileArtwork(ctx, CENTRE, SIZE, 17, 0, INK);
    expect(strokes.filter((s) => s.fn === "stroke").map((s) => s.style)).toEqual([
      TRACK_OUTLINE_INK,
      INK,
      TRACK_OUTLINE_INK,
      INK,
    ]);
  });

  it("draws #167 as two complete cities, the second over the first", () => {
    const { ctx, strokes } = recordingContext();
    drawHardcodedTileArtwork(ctx, CENTRE, SIZE, 167, 0, INK);
    const styles = strokes.filter((s) => s.fn === "stroke").map((s) => s.style);
    const W = TRACK_OUTLINE_INK;
    expect(styles).toEqual([W, W, W, INK, INK, INK, W, W, W, INK, INK, INK]);
  });

  it("draws #45 merged, then its one crossing as a clipped overpass of the upper rail", () => {
    const { ctx, strokes, calls } = recordingContext();
    drawHardcodedTileArtwork(ctx, CENTRE, SIZE, 45, 0, INK);
    const W = TRACK_OUTLINE_INK;
    // Four rails outlined, four inked, then the overpass: white and ink of ONE rail.
    expect(strokes.filter((s) => s.fn === "stroke").map((s) => s.style)).toEqual([W, W, W, W, INK, INK, INK, INK, W, INK]);
    // And the overpass is clipped: the clip is set after the eighth stroke and before the ninth.
    const strokeIndices = calls.map((fn, index) => (fn === "stroke" ? index : -1)).filter((index) => index >= 0);
    const clipAt = calls.indexOf("clip");
    expect(clipAt).toBeGreaterThan(strokeIndices[7]);
    expect(clipAt).toBeLessThan(strokeIndices[8]);
    expect(calls.filter((fn) => fn === "clip")).toHaveLength(1);
  });

  it("draws the stations and towns after the last rail", () => {
    // #1's two towns are `arc`s; nothing may stroke a rail once a dit has been drawn.
    const { ctx, calls } = recordingContext();
    drawHardcodedTileArtwork(ctx, CENTRE, SIZE, 1, 0, INK);
    const lastRail = calls.lastIndexOf("stroke");
    const firstMarker = calls.indexOf("arc");
    expect(firstMarker).toBeGreaterThan(-1);
    expect(lastRail).toBeLessThan(firstMarker);
  });

  it("outlines a printed hex's rail the same way", () => {
    const { ctx, strokes } = recordingContext();
    expect(drawPrintedTrack(ctx, CENTRE, SIZE, "F6")).toBe(true); // Cleveland
    const rails = strokes.filter((s) => s.fn === "stroke");
    expect(rails.map((s) => s.style)).toEqual([TRACK_OUTLINE_INK, expect.any(String)]);
    expect(rails[1].style).not.toBe(TRACK_OUTLINE_INK);
  });

  it("outlines the off-board arrows: white shafts and heads under the black ones", () => {
    const { ctx, strokes } = recordingContext();
    drawOffboardTrack(ctx, CENTRE, SIZE, [0, 1]);
    const styles = strokes.map((s) => `${s.fn}:${s.style === TRACK_OUTLINE_INK ? "white" : "ink"}`);
    // Two shafts white, two heads white (stroked then filled), then two shafts and two heads in ink.
    expect(styles).toEqual([
      "stroke:white", "stroke:white",
      "stroke:white", "fill:white", "stroke:white", "fill:white",
      "stroke:ink", "stroke:ink",
      "fill:ink", "fill:ink",
    ]);
    expect(strokes[0].width).toBe(trackPenWidth(SIZE) + TRACK_OUTLINE_EXTRA_PX);
    expect(strokes[6].width).toBe(trackPenWidth(SIZE));
  });
});
