/** @jest-environment node */
//
// Design note #1511 (audit): ONE CITY IDENTITY ACROSS THE LAYERS.
//
// A hex holds one or more cities (station circles); a city holds one or more slots. Four tables describe a
// city and each names it by INDEX: the tile catalog's `cityGroups` (which edges belong to which city -- the
// route walk, `cityForArrival`), `TileGraphics`' city markers (where the circle is drawn, how many slots it
// has -- the renderer, the click, the gate's slot counts), `station_tokens`' third element (which city a
// token sits in), and `LANDMARK_TRACKS` for the printed landmarks. Nothing checked that index `i` meant the
// same circle in every table. This does: for every tile with two cities, the marker drawn for city `i` is
// the one nearest the edges the catalog assigns to city `i`, and the count of cities agrees.

import { TILE_CATALOG } from "../components/hexTileCatalog";
import { TILE_GRAPHICS_CATALOG, tileCitySlotCounts, tileCitySlotPoints } from "../components/TileGraphics";
import { tileCityEdges, edgeAngleRad, pointOnCircle } from "../components/hexGeometry";
import { cityForArrival } from "../gameEngine/trackReach";
import { cityCountAt, citySlotCount, cityNodePoints } from "../gameEngine/stationTokens";
import type { MapGridResponse } from "../components/hexContractTypes";

const SIZE = 100;
const CENTRE = { x: 0, y: 0 };
const bare = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

type Pt = { x: number; y: number };
const centroid = (points: ReadonlyArray<Pt>): Pt => ({
  x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
  y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
});

/** Points along an authored track (`M`/`L`/`C`, absolute, unit-hex space), rotated like the artwork is. */
function sampleTrack(d: string, orientation: number): Pt[] {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const cmds = d.match(/[MLC]/g) ?? [];
  const out: Pt[] = [];
  let at = 0;
  let cursor: Pt = { x: 0, y: 0 };
  for (const cmd of cmds) {
    if (cmd === "M" || cmd === "L") {
      const next = { x: nums[at], y: nums[at + 1] };
      at += 2;
      if (cmd === "L") for (let t = 0; t <= 1; t += 0.05) out.push({ x: cursor.x + (next.x - cursor.x) * t, y: cursor.y + (next.y - cursor.y) * t });
      else out.push(next);
      cursor = next;
    } else {
      const [c1x, c1y, c2x, c2y, x, y] = nums.slice(at, at + 6);
      at += 6;
      for (let t = 0; t <= 1; t += 0.05) {
        const u = 1 - t;
        out.push({
          x: u * u * u * cursor.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
          y: u * u * u * cursor.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
        });
      }
      cursor = { x, y };
    }
  }
  const angle = (-60 * orientation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return out.map((p) => ({ x: SIZE * (p.x * cos - p.y * sin), y: SIZE * (p.x * sin + p.y * cos) }));
}

/** The edges a rotated track touches, read off its endpoints. */
function edgesOf(samples: Pt[]): number[] {
  const ends = [samples[0], samples[samples.length - 1]];
  const edges: number[] = [];
  for (const end of ends) {
    for (let edge = 0; edge < 6; edge += 1) {
      const mid = pointOnCircle(CENTRE, SIZE * 0.866025, edgeAngleRad(edge));
      if (Math.hypot(end.x - mid.x, end.y - mid.y) < SIZE * 0.08) edges.push(edge);
    }
  }
  return edges;
}

const distanceTo = (point: Pt, samples: Pt[]) => Math.min(...samples.map((p) => Math.hypot(p.x - point.x, p.y - point.y)));

const TWO_CITY = TILE_CATALOG.filter((entry) => (entry.cityGroups?.length ?? 0) >= 2);

describe("the catalog's city i is the artwork's city i, for every two-city tile", () => {
  it("has two-city tiles to check", () => {
    expect(TWO_CITY.length).toBeGreaterThan(5);
  });

  it("draws as many cities as the catalog groups", () => {
    for (const entry of TWO_CITY) {
      expect([entry.tileId, tileCitySlotCounts(entry.tileId).length]).toEqual([entry.tileId, entry.cityGroups!.length]);
    }
  });

  it("the circle drawn for city i lies on a rail whose edges the walk gives to city i, at every orientation", () => {
    /* THE CHECK: each city marker sits ON one of the authored rails (the artwork is drawn that way), and that
       rail's edge endpoints must be edges `tileCityEdges` assigns to the same index. A marker sitting on a
       rail of the other city would mean the renderer, the click and `station_tokens` call one circle "0"
       while the route walk calls it "1". Rotation is checked because the two tables rotate by two separate
       pieces of code (`ROTATION` in TileGraphics, `turn` in hexGeometry) that must agree in direction. */
    for (const entry of TWO_CITY) {
      const art = TILE_GRAPHICS_CATALOG[entry.tileId];
      for (let orientation = 0; orientation < 6; orientation += 1) {
        const rails = art.tracks.map((d) => sampleTrack(d, orientation));
        entry.cityGroups!.forEach((_, city) => {
          const drawn = centroid(tileCitySlotPoints(entry.tileId, city, orientation, CENTRE, SIZE));
          const nearest = rails.map((rail, index) => ({ index, d: distanceTo(drawn, rail) })).sort((a, b) => a.d - b.d)[0];
          expect([entry.tileId, orientation, city, nearest.d < SIZE * 0.05]).toEqual([entry.tileId, orientation, city, true]);
          const railEdges = edgesOf(rails[nearest.index]);
          expect([entry.tileId, orientation, city, railEdges.length > 0]).toEqual([entry.tileId, orientation, city, true]);
          const walkEdges = tileCityEdges(entry.tileId, orientation, city)!;
          expect([entry.tileId, orientation, city, railEdges.every((edge) => walkEdges.includes(edge))]).toEqual([
            entry.tileId,
            orientation,
            city,
            true,
          ]);
        });
      }
    }
  });
});

describe("printed New York: the walk's city is the drawn city", () => {
  it("edge 1 arrives at the first circle and edge 4 at the second, which is where they are drawn", () => {
    const nodes = cityNodePoints(bare, 6, 6, SIZE);
    expect(nodes).toHaveLength(2);
    expect(cityCountAt(bare, 6, 6)).toBe(2);
    expect(citySlotCount(bare, 6, 6, 0)).toBe(1);
    expect(citySlotCount(bare, 6, 6, 1)).toBe(1);
    for (const edge of [1, 4]) {
      const city = cityForArrival(bare, 6, 6, edge);
      expect(city).not.toBeNull();
      const centre = { x: 0, y: 0 };
      const mid = pointOnCircle(centre, SIZE * 0.866, edgeAngleRad(edge));
      const nearest = nodes
        .map((node, index) => ({ index, d: Math.hypot(node.x - mid.x, node.y - mid.y) }))
        .sort((a, b) => a.d - b.d)[0].index;
      expect([edge, city]).toEqual([edge, nearest]);
    }
  });
});

describe("a pill is one city with several slots, not several cities", () => {
  it("every multi-slot city counts once in the city table and its slots once in the slot table", () => {
    for (const entry of TILE_CATALOG) {
      const counts = tileCitySlotCounts(entry.tileId);
      const groups = entry.cityGroups?.length ?? (counts.length > 0 ? 1 : 0);
      if (counts.length === 0) continue;
      // Slot totals never turn into extra cities: a 4-slot New York (#883) is one city, not four.
      expect([entry.tileId, counts.length]).toEqual([entry.tileId, Math.max(1, groups)]);
    }
  });
});
