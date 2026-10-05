/** @jest-environment node */
//
// ==================================================================
//  VF D-35 (harness): AN OO HOME'S RESERVATION KEEPS ITS OWN CITY
// ==================================================================
//
// OWNER RULE (2026-10-05, Phase-3 lane B): a reservation marker moves WITH its city's geometry through a tile
// transition and resolves to that city's final place at commit; an OO tile has two city identities, and the marker
// keeps its own. Owner ruling (2026-10-05): a laid OO home is reserved in BOTH of its cities, as #1283 drew it on
// both printed circles.
//
// Everything here runs on real plans: real boards, real trays, every facing the sandbox placement filter accepts,
// and the board's own place functions (`twoNodePositions` for the printed circles, `tileCityAnchors` for a laid
// tile -- exactly what `homeReservationPoints` draws from). The correspondence asserted is the plan's
// (`plan.cities[*].sources`), the one the frame animates every city by; nothing here matches cities a second way.

export {};

const {
  planTileTransition,
  reservationPlaceFor,
  reservationPositionAt,
  sampleTileTransition,
  isAnimatableChange,
} = require("./tileTransition") as typeof import("./tileTransition");
const { filterSandboxPlacements } = require("./sandboxTileLegality") as typeof import("./sandboxTileLegality");
const { TILE_CATALOG_BY_ID } = require("./hexTileCatalog") as typeof import("./hexTileCatalog");
const HEX_BOARD = require("./hexBoardData") as typeof import("./hexBoardData");
const { EXPANDED_BOARD } = require("./hexBoardDataPlus") as typeof import("./hexBoardDataPlus");
const { LPF_BOARD } = require("./hexBoardDataLpf") as typeof import("./hexBoardDataLpf");
const { STANDARD_TRAY, withTray } = require("./tileTray") as typeof import("./tileTray");
const { PLUS_TRAY } = require("./tileTrayPlus") as typeof import("./tileTrayPlus");
const { LPF_TRAY } = require("./tileTrayLpf") as typeof import("./tileTrayLpf");
const { tileCityAnchors } = require("./TileGraphics") as typeof import("./TileGraphics");
const { twoNodePositions } = require("./hexGeometry") as typeof import("./hexGeometry");
const { stationHomeHexes } = require("./hexContractTypes") as typeof import("./hexContractTypes");

type Plan = NonNullable<ReturnType<typeof planTileTransition>>;
type Vec = { x: number; y: number };
type Laid = { tileId: number; orientation: number };
type Board = typeof HEX_BOARD.STANDARD_BOARD;
type Tray = typeof STANDARD_TRAY;

const RULES: Array<[string, Board, Tray]> = [
  ["standard", HEX_BOARD.STANDARD_BOARD, STANDARD_TRAY],
  ["plus", EXPANDED_BOARD, PLUS_TRAY],
  ["lpf", LPF_BOARD, LPF_TRAY],
];
const under = <T,>(board: Board, tray: Tray, fn: () => T): T => HEX_BOARD.withBoard(board, () => withTray(tray, fn));
const standard = <T,>(fn: () => T): T => under(HEX_BOARD.STANDARD_BOARD, STANDARD_TRAY, fn);

const EVERY_FACING = Array.from(TILE_CATALOG_BY_ID.keys()).flatMap((tileId) =>
  [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id: tileId, orientation })),
);
const TIERS = ["Yellow", "Green", "Brown", "Gray"] as const;
const ORIGIN = { x: 0, y: 0 };
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

const hexAt = (label: string) => {
  const hex = HEX_BOARD.STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no hex ${label}`);
  return hex;
};

/** Every facing of every tile the placement filter accepts on `label` over `from` (null: the printed hex). */
function acceptedOver(label: string, from: Laid | null): Laid[] {
  const { q, r } = hexAt(label);
  const tiles = from ? [{ q, r, tile_id: from.tileId, orientation: from.orientation, landmark: null }] : [];
  const seen = new Set<string>();
  const out: Laid[] = [];
  for (const era of TIERS) {
    for (const placement of filterSandboxPlacements(EVERY_FACING, { mapGrid: { game_id: 1, tiles }, q, r, era })) {
      const next = { tileId: placement.tile_id, orientation: placement.orientation };
      if (from && !isAnimatableChange(from, next)) continue;
      const key = `${next.tileId}@${next.orientation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(next);
    }
  }
  return out;
}

/** Where the board draws an OO home's reservations, unit hex: both printed circles, or every city of a laid tile. */
const homePlaces = (laid: Laid | null): Vec[] =>
  laid ? tileCityAnchors(laid.tileId, laid.orientation, ORIGIN, 1) : twoNodePositions(ORIGIN, 1);

/** Every accepted transition on an OO home hex, walked from the printed hex through every reachable facing. */
function ooHomeTransitions(label: string): Array<{ from: Laid | null; to: Laid; plan: Plan }> {
  const out: Array<{ from: Laid | null; to: Laid; plan: Plan }> = [];
  const visited = new Set<string>();
  let frontier: Array<Laid | null> = [null];
  while (frontier.length > 0) {
    const next: Laid[] = [];
    for (const from of frontier) {
      for (const to of acceptedOver(label, from)) {
        const plan = planTileTransition({
          from: from ? { kind: "tile", tileId: from.tileId, orientation: from.orientation } : { kind: "printed", label },
          to,
        });
        if (!plan) continue;
        out.push({ from, to, plan });
        const key = `${to.tileId}@${to.orientation}`;
        if (!visited.has(key)) {
          visited.add(key);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/** The art marker index a place is drawn on (its centre or a slot), or -1. */
const cityAt = (markers: Plan["fromArt"]["markers"], at: Vec) =>
  markers.findIndex((marker) => marker.kind === "city" && dist(marker.at, at) < 1e-3);

/** The plan city (by destination marker) that `fromMarker` becomes. */
const successorOf = (plan: Plan, fromMarker: number) => plan.cities.findIndex((city) => city.sources.includes(fromMarker));

/** The frame's drawing of plan city `dest`: frame cities are pushed in plan order, a city at a time (towns apart). */
function frameCityFor(plan: Plan, t: number, dest: number) {
  const frame = sampleTileTransition(plan, t);
  const rank = plan.cities.slice(0, dest).filter((city) => city.kind === "city").length;
  return frame.cities[rank];
}

/** How far outside a frame city's drawn station shapes `point` is: at most 0 when it is inside them. */
function outsideStation(point: Vec, city: { blobs: ReadonlyArray<{ points: Vec[]; closed: boolean; radius: number; alpha?: number }> }) {
  const toSegment = (a: Vec, b: Vec) => {
    const lengthSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const u = lengthSq < 1e-18 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSq));
    return dist(point, { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  };
  let best = Infinity;
  for (const blob of city.blobs) {
    if ((blob.alpha ?? 1) <= 0 || blob.points.length === 0) continue;
    let skeleton = dist(point, blob.points[0]);
    blob.points.forEach((p, k) => {
      const next = blob.points[k + 1] ?? (blob.closed ? blob.points[0] : undefined);
      if (next) skeleton = Math.min(skeleton, toSegment(p, next));
    });
    best = Math.min(best, skeleton - blob.radius);
  }
  return best;
}

/** Sampled instants of a plan, every 8 ms, the ends included. */
const instants = (plan: Plan) => {
  const steps = Math.ceil(plan.durationMs / 8);
  return Array.from({ length: steps + 1 }, (_, k) => k / steps);
};

/** One marker's pairing and ride, as the renderer makes it. */
function rideOf(plan: Plan, from: Vec, places: Vec[]) {
  const index = reservationPlaceFor(plan, from, places);
  const to = places[index];
  return { index, to, at: (t: number) => reservationPositionAt(plan, t, { from, to }) };
}

/* ------------------------------------------------------------------ */

describe("VF D-35: an OO home's reservation markers each ride their own city", () => {
  it("every accepted transition on ERIE's and PMQ's homes, every board and facing: own city, one-to-one, inside it every frame, exact at both ends", () => {
    let markers = 0;
    let swapped = 0;
    for (const [name, board, tray] of RULES) {
      under(board, tray, () => {
        const homes = stationHomeHexes().filter((home) => HEX_BOARD.YELLOW_OO_HEXES.has(home.label) && home.enforced !== false);
        expect(homes.length).toBeGreaterThan(0);
        for (const home of homes) {
          const transitions = ooHomeTransitions(home.label);
          expect(transitions.length).toBeGreaterThan(30);
          for (const { from, to, plan } of transitions) {
            const where = `${name} ${home.label} ${from ? `#${from.tileId}@${from.orientation}` : "printed"} -> #${to.tileId}@${to.orientation}`;
            const before = homePlaces(from);
            const after = homePlaces(to);
            expect([where, before.length, after.length]).toEqual([where, 2, 2]);
            const claimed = new Set<number>();
            before.forEach((start) => {
              const fromMarker = cityAt(plan.fromArt.markers, start);
              expect([where, fromMarker >= 0]).toEqual([where, true]);
              const ride = rideOf(plan, start, after);
              const toMarker = cityAt(plan.toArt.markers, ride.to);
              // The place it settles into is the city its own city BECOMES -- by the plan's correspondence.
              expect([where, successorOf(plan, fromMarker)]).toEqual([where, toMarker]);
              // The other city cannot take it: no two markers settle into one place.
              expect([where, claimed.has(ride.index)]).toEqual([where, false]);
              claimed.add(ride.index);
              const fromCityRank = plan.fromArt.markers.slice(0, fromMarker).filter((m) => m.kind === "city").length;
              const toCityRank = plan.toArt.markers.slice(0, toMarker).filter((m) => m.kind === "city").length;
              if (fromCityRank !== toCityRank) swapped += 1;
              // Exact at both ends.
              expect(ride.at(0)).toEqual(start);
              expect(ride.at(1)).toEqual(ride.to);
              // Inside its own city's drawn station shapes in every sampled frame.
              for (const t of instants(plan)) {
                const own = frameCityFor(plan, t, toMarker);
                expect([where, t, outsideStation(ride.at(t), own) <= 1e-9]).toEqual([where, t, true]);
              }
              markers += 1;
            });
          }
        }
      });
    }
    // Every marker of every transition rode; the ones whose city changes artwork index (the D-35 cases) included.
    // 480 transitions over the four OO homes (standard E11; Plus E11; LPF E11 and E5), two markers each; 546 of the
    // 960 change artwork city index across the lay -- each still rides its own city.
    expect(markers).toBe(960);
    expect(swapped).toBe(546);
  });

  it("#59 -> #64 on E11: the marker in city A stays in A, the marker in city B stays in B, though the artwork renumbers them", () => {
    standard(() => {
      const from = { tileId: 59, orientation: 0 };
      const to = { tileId: 64, orientation: 2 };
      expect(acceptedOver("E11", from)).toContainEqual(to);
      const plan = planTileTransition({ from: { kind: "tile", ...from }, to })!;
      const before = homePlaces(from);
      const after = homePlaces(to);
      // #59's second city becomes #64's FIRST city at this facing, and its first city #64's second: the case D-35 named.
      const [a, b] = before.map((start) => cityAt(plan.fromArt.markers, start));
      const [a2, b2] = after.map((place) => cityAt(plan.toArt.markers, place));
      expect(successorOf(plan, b)).toBe(a2);
      expect(successorOf(plan, a)).toBe(b2);
      // The cities' place on the hex really moves.
      expect(dist(before[1], after[0])).toBeGreaterThan(0.05);

      const markerA = rideOf(plan, before[0], after);
      const markerB = rideOf(plan, before[1], after);
      expect(markerA.to).toEqual(after[1]);
      expect(markerB.to).toEqual(after[0]);
      for (const t of instants(plan)) {
        // Each on its own city...
        expect(outsideStation(markerA.at(t), frameCityFor(plan, t, b2))).toBeLessThanOrEqual(1e-9);
        expect(outsideStation(markerB.at(t), frameCityFor(plan, t, a2))).toBeLessThanOrEqual(1e-9);
        // ...and never on the other.
        expect(outsideStation(markerA.at(t), frameCityFor(plan, t, a2))).toBeGreaterThan(0);
        expect(outsideStation(markerB.at(t), frameCityFor(plan, t, b2))).toBeGreaterThan(0);
      }

      // b8d5246's pairing, for the record: B's marker went to the tile's artwork second city -- the OTHER city --
      // across the hex, leaving its own city mid-transition.
      const old = { from: before[1], to: after[1] };
      const mid = plan.durationMs > 0 ? 600 / plan.durationMs : 0.5;
      expect(outsideStation(reservationPositionAt(plan, mid, old), frameCityFor(plan, mid, a2))).toBeGreaterThan(0);
    });
  });

  it("rotation never decides identity: one green facing reached from two #59 facings pairs each marker by its own city", () => {
    under(EXPANDED_BOARD, PLUS_TRAY, () => {
      // #59@0 and #59@1 both upgrade to #66@0, with opposite artwork correspondences (the finding behind the ruling).
      const to = { tileId: 66, orientation: 0 };
      const results = [0, 1].map((orientation) => {
        const from = { tileId: 59, orientation };
        expect(acceptedOver("E11", from)).toContainEqual(to);
        const plan = planTileTransition({ from: { kind: "tile", ...from }, to })!;
        const before = homePlaces(from);
        const after = homePlaces(to);
        return before.map((start) => {
          const ride = rideOf(plan, start, after);
          expect(cityAt(plan.toArt.markers, ride.to)).toBe(successorOf(plan, cityAt(plan.fromArt.markers, start)));
          expect(ride.at(1)).toEqual(ride.to);
          return ride.index;
        });
      });
      // Artwork city 1 of #59 lands in a different #66 city at the two facings: the index is not the identity.
      expect(results[0][1]).not.toBe(results[1][1]);
    });
  });

  it("printed circles -> #59: each circle's marker rides the city its circle becomes, so two markers stay two", () => {
    standard(() => {
      for (const to of acceptedOver("E11", null).filter((laid) => laid.tileId === 59)) {
        const plan = planTileTransition({ from: { kind: "printed", label: "E11" }, to })!;
        const after = homePlaces(to);
        const indices = twoNodePositions(ORIGIN, 1).map((circle) => {
          const ride = rideOf(plan, circle, after);
          expect(cityAt(plan.toArt.markers, ride.to)).toBe(successorOf(plan, cityAt(plan.fromArt.markers, circle)));
          return ride.index;
        });
        expect(new Set(indices).size).toBe(2);
      }
    });
  });

  it("is pure: pairing and riding change nothing in the plan they read", () => {
    standard(() => {
      const plan = planTileTransition({ from: { kind: "tile", tileId: 59, orientation: 0 }, to: { tileId: 64, orientation: 2 } })!;
      const snapshot = JSON.stringify(plan);
      const after = homePlaces({ tileId: 64, orientation: 2 });
      for (const start of homePlaces({ tileId: 59, orientation: 0 })) {
        const ride = rideOf(plan, start, after);
        for (const t of instants(plan)) ride.at(t);
      }
      expect(JSON.stringify(plan)).toBe(snapshot);
    });
  });
});

describe("VF D-35 leaves every other home's reservation as it was", () => {
  it("a non-OO home -- one place on the new tile, as the board draws it -- settles where it always did", () => {
    let checked = 0;
    for (const [, board, tray] of RULES) {
      under(board, tray, () => {
        for (const home of stationHomeHexes()) {
          if (HEX_BOARD.YELLOW_OO_HEXES.has(home.label)) continue;
          for (const to of acceptedOver(home.label, null)) {
            const plan = planTileTransition({ from: { kind: "printed", label: home.label }, to });
            if (!plan) continue;
            const cities = plan.toArt.markers.filter((marker) => marker.kind === "city");
            if (cities.length !== 1) continue;
            for (const start of plan.fromArt.markers.filter((marker) => marker.kind === "city").map((marker) => marker.at)) {
              // b8d5246 sent the marker to the nearest of the places; with one place that is the place.
              expect(reservationPlaceFor(plan, start, [cities[0].at])).toBe(0);
              checked += 1;
            }
          }
        }
      });
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("falls back to the nearest place where no city can be read", () => {
    standard(() => {
      const plan = planTileTransition({ from: { kind: "tile", tileId: 59, orientation: 0 }, to: { tileId: 64, orientation: 2 } })!;
      const places = [
        { x: 0.6, y: 0.6 },
        { x: -0.6, y: -0.6 },
      ];
      // The hex centre stands in no city of #59: nothing to correspond, so the nearer place answers.
      expect(reservationPlaceFor(plan, { x: 0.5, y: 0.5 }, places)).toBe(0);
      expect(reservationPlaceFor(plan, { x: -0.5, y: -0.5 }, places)).toBe(1);
      expect(reservationPlaceFor(plan, { x: 0, y: 0 }, [])).toBe(-1);
    });
  });
});
