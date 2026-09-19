/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 1460-1473 (harness): THE CLASSIFICATION IS THE PART WITH LOGIC
// ==================================================================
//
// Canvas aesthetics are not unit-tested here; they wait for a visual playtest (VISUAL_FLOURISH_BACKLOG.md,
// VF-5). What IS deterministic is the description every frame is drawn from, and that is what these cases pin:
//
//   WHICH RAIL IS WHICH. Persistent rail is never rebuilt, reconfigured rail keeps its identity while its city
//   moves, and only genuinely added rail constructs (#1461).
//   HOW NEW RAIL IS BUILT. From its origin, by a front that travels the rail's own geometry: portions erupt and
//   settle behind it, branches from standing anchors build together, and a piece continuing from a built node
//   starts when the wave arrives there. Never the whole path at once (#1467, #1469).
//   WHICH CITY IS WHICH. A slot count is never a city count: a city gaining a slot is still one city, and a
//   genuine merge is named as one (#1462).
//   HOW SLOTS CHANGE. One slot divides; several gather and reorganise without one of them being chosen as the
//   parent; merging cities keep every slot they had (#1463).
//   THE COMMIT. Geometry dominates, and a narrow front commits the tile last, while the geometry's last tenth
//   settles (#1464, #1471).
//   THE CLOCK. A 1600 ms span of spacing between the major events, while each local beat -- the shake, a slot's pulse
//   and split, one rail portion's eruption, the reveal -- keeps its own absolute length (#1464). A transition without
//   some of the parts takes only the time its own parts need, and its semantic beats say when they happen (#1470).
//   THE PROPOSAL. The tile being chosen is the whole destination, washed; a confirm starts from it and draws only what
//   the lay changes over it, each change in its own class (#1471).
//   TOKENS. A token is a piece seated in its station: it rides its slot through the city's own choreography between
//   its two authoritative places, and is never split, merged, duplicated or placed (#1466, #1472). A home reservation
//   marker rides the same seat; a token the lay moves has a planned place until it settles there (#1473).
//   MERGES. Merging cities reach for each other as bodies: a neck is never thinner than a city (#1473).
//   SOUNDS. Three cues, each on the plan's beat for the change it names -- new rail, a gained slot, the commit -- once
//   per transition, whatever a frame loop asks; a lay nobody proposed here has no planned places (#1474).
//
// Every pair below is found through the sandbox placement filter rather than typed as an orientation, so a case
// cannot quietly describe a lay the filter would refuse. What that filter CURRENTLY ACCEPTS is not claimed to be
// rules-legal -- which facings the rules allow is the rules-hardening backlog's question -- and no case here
// rests on a facing that question has open. A case built without the filter says so, and why, where it is.

export {};

const {
  BEAT_MS,
  CONSTRUCTION_WAVE,
  PROPOSED_BADGE,
  PROVISIONAL,
  REVEAL_SLANT,
  REVEAL_SPAN,
  revealFront,
  badgePresentationAt,
  constructionPortions,
  describeTransition,
  eruption,
  hexArtForPrinted,
  isAnimatableChange,
  outlineOf,
  pieceMoves,
  pieceTargetPresence,
  piecesOf,
  planTileTransition,
  proposedTileFrame,
  reservationPositionAt,
  ringCoveredArcs,
  ringUnionArcs,
  sampleTileTransition,
  slicePolyline,
  slotCentres,
  tokenPositionAt,
  transitionEasings,
  TIMELINE,
  TIMELINE_SPAN_MS,
  TILE_TRANSITION_MS,
  TILE_TRANSITION_REDUCED_MS,
  RECONFIGURE_ESTABLISHED,
  TILE_TRANSITION_SFX,
  cuesReached,
  tileTransitionCues,
} = require("./tileTransition") as typeof import("./tileTransition");
const { filterSandboxPlacements } = require("./sandboxTileLegality") as typeof import("./sandboxTileLegality");
const { TILE_CATALOG_BY_ID } = require("./hexTileCatalog") as typeof import("./hexTileCatalog");
const { COLOR_TIER_STROKE, ERA_TILE_FILL, STANDARD_BOARD, STATIC_BOARD_HEXES, withBoard } = require("./hexBoardData") as typeof import("./hexBoardData");
const { EXPANDED_BOARD } = require("./hexBoardDataPlus") as typeof import("./hexBoardDataPlus");
const { LPF_BOARD } = require("./hexBoardDataLpf") as typeof import("./hexBoardDataLpf");
const { STANDARD_TRAY, withTray } = require("./tileTray") as typeof import("./tileTray");
const { PLUS_TRAY } = require("./tileTrayPlus") as typeof import("./tileTrayPlus");
const { LPF_TRAY } = require("./tileTrayLpf") as typeof import("./tileTrayLpf");
const { tileCitySlotPoints, tileCityTokenRadius } = require("./TileGraphics") as typeof import("./TileGraphics");

type Board = typeof STANDARD_BOARD;
type Tray = typeof STANDARD_TRAY;
type Plan = NonNullable<ReturnType<typeof planTileTransition>>;
type From = { kind: "tile"; tileId: number; orientation: number } | { kind: "printed"; label: string };
type Vec = { x: number; y: number };

const RULES: Record<"standard" | "plus" | "lpf", [Board, Tray]> = {
  standard: [STANDARD_BOARD, STANDARD_TRAY],
  plus: [EXPANDED_BOARD, PLUS_TRAY],
  lpf: [LPF_BOARD, LPF_TRAY],
};
const under = <T,>(rules: keyof typeof RULES, fn: () => T): T =>
  withBoard(RULES[rules][0], () => withTray(RULES[rules][1], fn));

const EVERY_FACING = Array.from(TILE_CATALOG_BY_ID.keys()).flatMap((tileId) =>
  [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id: tileId, orientation })),
);
const TIERS = ["Yellow", "Green", "Brown", "Gray"] as const;

/** Every facing of `toId` on `label`, over `from`, that the game's placement filter currently accepts. */
function acceptedFacings(label: string, from: From, toId: number): number[] {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no hex ${label}`);
  const tiles = from.kind === "tile" ? [{ q: hex.q, r: hex.r, tile_id: from.tileId, orientation: from.orientation, landmark: null }] : [];
  const era = TILE_CATALOG_BY_ID.get(toId)?.color ?? "Yellow";
  return filterSandboxPlacements(EVERY_FACING, { mapGrid: { game_id: 1, tiles }, q: hex.q, r: hex.r, era })
    .filter((placement) => placement.tile_id === toId)
    .map((placement) => placement.orientation);
}

/** A plan for `toId` over `from` on `label`: the first accepted facing, or the first satisfying `pick`. */
function acceptedPlan(label: string, from: From, toId: number, pick: (plan: Plan) => boolean = () => true): Plan {
  for (const orientation of acceptedFacings(label, from, toId)) {
    const plan = planTileTransition({ from, to: { tileId: toId, orientation } });
    if (plan && pick(plan)) return plan;
  }
  throw new Error(`no accepted facing of #${toId} on ${label}`);
}

const firstFacing = (label: string, from: From, toId: number) => {
  const facing = acceptedFacings(label, from, toId)[0];
  if (facing === undefined) throw new Error(`no accepted facing of #${toId} on ${label}`);
  return facing;
};

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
/** A frame at wall-clock `ms` into `plan`. */
const frameAt = (plan: Plan, ms: number) => sampleTileTransition(plan, ms / plan.durationMs);
/** A macro placement of the table, in milliseconds. */
const spanMs = (fraction: number) => fraction * TIMELINE_SPAN_MS;
const samePolyline = (a: readonly Vec[], b: readonly Vec[], tolerance = 1e-6) =>
  a.length === b.length &&
  (a.every((point, k) => dist(point, b[k]) < tolerance) || a.every((point, k) => dist(point, b[b.length - 1 - k]) < tolerance));

/* ------------------------------------------------------------------ */

describe("track: only genuinely new rail constructs (#1461)", () => {
  it("keeps #57's straight through the city as persistent spokes and builds only #14's two new ones", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      expect(describeTransition(plan)).toMatchObject({ persistent: 2, reconfigured: 0, added: 2, removed: 0 });
      // The two added pieces are the two spokes #57 never had, and each grows out of the city.
      const added = plan.tracks.filter((track) => track.cls === "added");
      for (const track of added) {
        const piece = track.to!;
        const growNode = track.growsFromEnd ? piece.to : piece.from;
        expect(growNode.kind).toBe("marker");
      }
    });
  });

  it("builds a plain upgrade's new rail out of the edge it shares with the rail already there", () => {
    under("standard", () => {
      const o8 = firstFacing("G11", { kind: "printed", label: "G11" }, 8);
      const plan = acceptedPlan("G11", { kind: "tile", tileId: 8, orientation: o8 }, 24);
      expect(describeTransition(plan)).toMatchObject({ persistent: 1, added: 1, reconfigured: 0 });
      const persistentEdges = new Set(
        plan.tracks
          .filter((track) => track.cls === "persistent")
          .flatMap((track) => [track.to!.from, track.to!.to])
          .flatMap((node) => (node.kind === "edge" ? [node.edge] : [])),
      );
      const added = plan.tracks.find((track) => track.cls === "added")!;
      const growNode = added.growsFromEnd ? added.to!.to : added.to!.from;
      expect(growNode.kind).toBe("edge");
      expect(persistentEdges.has((growNode as { edge: number }).edge)).toBe(true);
    });
  });

  it("builds a new lay from the edge a neighbour's rail arrives at", () => {
    under("standard", () => {
      const o8 = firstFacing("G11", { kind: "printed", label: "G11" }, 8);
      const plan = planTileTransition({ from: { kind: "printed", label: "G11" }, to: { tileId: 8, orientation: o8 }, externalEdges: [(2 + o8) % 6] })!;
      const [added] = plan.tracks;
      expect(added.cls).toBe("added");
      const growNode = added.growsFromEnd ? added.to!.to : added.to!.from;
      expect(growNode).toEqual({ kind: "edge", edge: (2 + o8) % 6 });
    });
  });

  it("reconfigures Baltimore's printed curve into #53's spokes instead of rebuilding it (moved city)", () => {
    under("standard", () => {
      const plan = acceptedPlan("I15", { kind: "printed", label: "I15" }, 53);
      expect(describeTransition(plan)).toMatchObject({ persistent: 0, reconfigured: 2, added: 1, removed: 0 });
      expect(plan.cities).toEqual([expect.objectContaining({ kind: "city", event: "migrate", migrates: true, sources: [0] })]);
    });
  });

  it("gives every accepted city and town upgrade on all three tables a transition that starts and ends on the real art", () => {
    (["standard", "plus", "lpf"] as const).forEach((rules) =>
      under(rules, () => {
        const seen = new Set<string>();
        let checked = 0;
        const walk = (label: string, from: From, tierIndex: number, depth: number) => {
          const next = TIERS[tierIndex + 1];
          if (!next || depth > 3) return;
          const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
          const tiles = from.kind === "tile" ? [{ q: hex.q, r: hex.r, tile_id: from.tileId, orientation: from.orientation, landmark: null }] : [];
          const allowed = filterSandboxPlacements(EVERY_FACING, { mapGrid: { game_id: 1, tiles }, q: hex.q, r: hex.r, era: next });
          for (const placement of allowed) {
            if (TILE_CATALOG_BY_ID.get(placement.tile_id)?.color !== next) continue;
            const fromKey = from.kind === "tile" ? `${from.tileId}` : `printed:${label}`;
            const key = `${fromKey}->${placement.tile_id}`;
            if (seen.has(key)) continue; // one accepted facing per distinct pair keeps the sweep quick
            seen.add(key);
            const plan = planTileTransition({ from, to: { tileId: placement.tile_id, orientation: placement.orientation } });
            expect({ key, plan: plan !== null }).toEqual({ key, plan: true });
            if (!plan) continue;
            const start = sampleTileTransition(plan, 0);
            const end = sampleTileTransition(plan, 1);
            for (const piece of piecesOf(plan.fromArt)) {
              expect({ key, start: start.tracks.some((track) => track.alpha >= 1 && samePolyline(track.points, piece.points, 0.02)) }).toEqual({ key, start: true });
            }
            for (const piece of piecesOf(plan.toArt)) {
              expect({ key, end: end.tracks.some((track) => track.alpha >= 1 && samePolyline(track.points, piece.points)) }).toEqual({ key, end: true });
            }
            checked += 1;
            walk(label, { kind: "tile", tileId: placement.tile_id, orientation: placement.orientation }, TIERS.indexOf(next), depth + 1);
          }
        };
        const labels = ["H10", "I15", "E23", "G19", "E11", "G7", "E7", "D10", "B20", "F20"];
        for (const label of labels) {
          const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
          if (!hex) continue;
          walk(label, { kind: "printed", label }, hex.printedColor === "Yellow" ? 0 : -1, 0);
        }
        expect(checked).toBeGreaterThan(10);
      }),
    );
  });
});

describe("cities: a slot is not a city, and a merge is named as one (#1462)", () => {
  it("1 -> 2: one city gaining a slot, circle to pill, the pill's own axis", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      expect(describeTransition(plan).cities).toEqual([
        { kind: "city", event: "capacity", fromSlots: [1], toSlots: 2, migrates: false },
      ]);
      const dest = plan.toArt.markers[0];
      // The outline ends on the destination's pill -- two end slots, not a horizontal guess.
      const end = sampleTileTransition(plan, 1).cities[0];
      expect(end.blobs[0].points).toEqual(outlineOf(dest).points);
      expect(end.rings.map((ring) => ring.at)).toEqual(slotCentres(dest));
    });
  });

  it("1 -> 2: the city begins extending before the slot divides, and both settle together", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const at = (ms: number) => frameAt(plan, ms).cities[0];
      const spread = (points: readonly Vec[]) => (points.length < 2 ? 0 : dist(points[0], points[points.length - 1]));
      const ms = spanMs(TIMELINE.pulse[0]) + 32; // the outline is under way; the slot has only just begun to pulse
      expect(spread(at(ms).blobs[0].points)).toBeGreaterThan(0.01);
      const rings = at(ms).rings;
      expect(dist(rings[0].at, rings[1].at)).toBeLessThan(1e-6); // still one slot, pulsing
      // Mitosis: afterwards the two rings separate toward their final places.
      const later = at(930).rings;
      expect(dist(later[0].at, later[1].at)).toBeGreaterThan(0.2);
    });
  });

  it("2 -> 3: gathers toward the centre, then a gained slot emerges from the centre rather than from either slot", () => {
    under("plus", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const o63 = firstFacing("H10", { kind: "tile", tileId: 14, orientation: o14 }, 63);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 63, orientation: o63 }, 513);
      expect(describeTransition(plan).cities).toEqual([
        { kind: "city", event: "capacity", fromSlots: [2], toSlots: 3, migrates: false },
      ]);
      const anchor = plan.toArt.markers[0].at;
      const source = slotCentres(plan.fromArt.markers[0]);
      const gathered = frameAt(plan, spanMs(TIMELINE.gather[1])).cities[0].rings;
      const meanStart = source.reduce((sum, point) => sum + dist(point, anchor), 0) / source.length;
      const meanGathered = gathered.reduce((sum, ring) => sum + dist(ring.at, anchor), 0) / gathered.length;
      expect(meanGathered).toBeLessThan(meanStart * 0.5);
      // The ring that is new starts at the city's centre: no existing slot is designated as its parent.
      const divideStart = frameAt(plan, spanMs(TIMELINE.divide[0])).cities[0].rings;
      const nearCentre = divideStart.filter((ring) => dist(ring.at, anchor) < 1e-6);
      expect(nearCentre.length).toBeGreaterThanOrEqual(1);
      // The destination is the triangle the catalog prints, closed.
      const end = sampleTileTransition(plan, 1).cities[0];
      expect(outlineOf(plan.toArt.markers[0]).closed).toBe(true);
      expect(end.blobs[0].points).toEqual(outlineOf(plan.toArt.markers[0]).points);
    });
  });

  it("1 -> 3 on the Level Playing Field's B: one city, a circle becoming the triangle", () => {
    under("lpf", () => {
      const o53 = firstFacing("E23", { kind: "printed", label: "E23" }, 53);
      const plan = acceptedPlan("E23", { kind: "tile", tileId: 53, orientation: o53 }, 884);
      expect(describeTransition(plan).cities).toEqual([
        { kind: "city", event: "capacity", fromSlots: [1], toSlots: 3, migrates: false },
      ]);
    });
  });

  it("LPF New York: printed stations migrate onto #54, each #54 city gains a slot on #62, and #883 is a genuine merge", () => {
    under("lpf", () => {
      const printed = acceptedPlan("G19", { kind: "printed", label: "G19" }, 54);
      expect(describeTransition(printed)).toMatchObject({ reconfigured: 2, added: 2, removed: 0 });
      expect(describeTransition(printed).cities.map((city) => city.event)).toEqual(["migrate", "migrate"]);

      const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      const sixtyTwo = acceptedPlan("G19", { kind: "tile", tileId: 54, orientation: o54 }, 62);
      expect(describeTransition(sixtyTwo)).toMatchObject({ persistent: 4, reconfigured: 0, added: 0 });
      expect(describeTransition(sixtyTwo).cities).toEqual([
        { kind: "city", event: "capacity", fromSlots: [1], toSlots: 2, migrates: false },
        { kind: "city", event: "capacity", fromSlots: [1], toSlots: 2, migrates: false },
      ]);

      const merge = acceptedPlan("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      expect(describeTransition(merge)).toMatchObject({ persistent: 0, reconfigured: 4, added: 0, removed: 0 });
      expect(describeTransition(merge).cities).toEqual([
        { kind: "city", event: "merge", fromSlots: [1, 1], toSlots: 4, migrates: false },
      ]);
      // Both cities are drawn at the start, and one four-slot city at the end.
      const start = sampleTileTransition(merge, 0).cities[0];
      expect(start.blobs.length).toBe(2);
      const end = sampleTileTransition(merge, 1).cities[0];
      expect(end.rings.filter((ring) => ring.alpha >= 1).map((ring) => ring.at)).toEqual(slotCentres(merge.toArt.markers[0]));
    });
  });

  it("the brief's New York -- two two-slot cities into one four-slot city, #62 -> #883 -- is the same genuine merge", () => {
    /* #883 is Brown, and the sandbox filter offers it over the green #54, whose cities hold one slot each; the brown
       #62 -- #1315's case, two cities of two -- is offered no same-tier replacement by that filter. Which is legal is
       a rules question for the hardening backlog, not answered here, and the transition does not depend on it: #62
       shares #54's rails, so at #54's facing, into #883 at the facing the filter accepts over #54, it is still one
       merge, every rail reconfigured, four rings travelling to four slots and none emerging. */
    under("lpf", () => {
      const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      const o883 = firstFacing("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      expect(isAnimatableChange({ tileId: 62, orientation: o54 }, { tileId: 883, orientation: o883 })).toBe(true);
      const plan = planTileTransition({ from: { kind: "tile", tileId: 62, orientation: o54 }, to: { tileId: 883, orientation: o883 } })!;
      expect(describeTransition(plan)).toMatchObject({ persistent: 0, reconfigured: 4, added: 0, removed: 0 });
      expect(describeTransition(plan).cities).toEqual([
        { kind: "city", event: "merge", fromSlots: [2, 2], toSlots: 4, migrates: false },
      ]);
      const start = sampleTileTransition(plan, 0).cities[0];
      expect(start.blobs).toHaveLength(2);
      expect(start.rings.filter((ring) => ring.alpha >= 1)).toHaveLength(4);
      for (const t of [0.25, 0.5, 0.75]) {
        // Four slots the whole way: nothing emerges and nothing is doubled.
        expect(sampleTileTransition(plan, t).cities[0].rings.filter((ring) => ring.alpha > 0)).toHaveLength(4);
      }
      expect(sampleTileTransition(plan, 1).cities[0].rings.map((ring) => ring.at)).toEqual(slotCentres(plan.toArt.markers[0]));
    });
  });

  it("LPF two small towns on separate rails fuse into one, and every rail between them is reconfigured, not rebuilt", () => {
    under("lpf", () => {
      const pairs: Array<[number, number]> = [[1, 88], [2, 87], [55, 88], [56, 87], [69, 204], [630, 204], [631, 204], [632, 87], [633, 88]];
      for (const [yellow, green] of pairs) {
        const facing = firstFacing("G7", { kind: "printed", label: "G7" }, yellow);
        const plan = acceptedPlan("G7", { kind: "tile", tileId: yellow, orientation: facing }, green);
        expect({ yellow, green, ...describeTransition(plan) }).toMatchObject({
          yellow,
          green,
          persistent: 0,
          added: 0,
          removed: 0,
          cities: [{ kind: "town", event: "merge", fromSlots: [1, 1], toSlots: 1 }],
        });
        // The two dits meet at the destination.
        const end = sampleTileTransition(plan, 1).towns.filter((town) => town.role !== "target");
        expect(end.length).toBe(2);
        expect(dist(end[0].at, end[1].at)).toBeLessThan(1e-9);
      }
    });
  });

  it("the OO circles, which own no rail, pair with the nearest station and migrate onto #59's spurs", () => {
    under("standard", () => {
      const plan = acceptedPlan("E11", { kind: "printed", label: "E11" }, 59);
      expect(describeTransition(plan)).toMatchObject({ added: 2, persistent: 0, reconfigured: 0 });
      expect(plan.cities.map((city) => [city.event, city.sources.length])).toEqual([["migrate", 1], ["migrate", 1]]);
      expect(new Set(plan.cities.map((city) => city.sources[0])).size).toBe(2); // one to one, never a merge
    });
  });

  it("describes an unlaid hex exactly as the printed passes paint it", () => {
    under("standard", () => {
      expect(hexArtForPrinted("E11")!.markers.map((marker) => marker.kind)).toEqual(["city", "city"]); // OO pair
      expect(hexArtForPrinted("F20")!.markers.map((marker) => [marker.kind, marker.scale])).toEqual([["town", 0.85], ["town", 0.85]]);
      expect(hexArtForPrinted("H10")!.markers.map((marker) => marker.kind)).toEqual(["city"]); // designation
      expect(hexArtForPrinted("G19")!.tracks.length).toBe(2); // New York's two stubs
      expect(hexArtForPrinted("G11")!.markers).toEqual([]); // bare ground
    });
  });
});

describe("the clock: macro spacing, micro snap (#1464)", () => {
  const ms = (fraction: number) => Math.round(fraction * TIMELINE_SPAN_MS);

  it("spaces the major events over a 1600 ms span and keeps every local beat at its own length", () => {
    expect(TIMELINE_SPAN_MS).toBe(1600);
    expect(TILE_TRANSITION_REDUCED_MS).toBe(240);
    // Micro: absolute, whatever the transition's length.
    expect(ms(TIMELINE.tension[1] - TIMELINE.tension[0])).toBe(BEAT_MS.tension);
    expect(ms(TIMELINE.pulse[1] - TIMELINE.pulse[0])).toBe(BEAT_MS.pulse);
    expect(ms(TIMELINE.divide[0] - TIMELINE.pulse[0])).toBe(BEAT_MS.split);
    expect(ms(TIMELINE.gather[1] - TIMELINE.pulse[0])).toBe(BEAT_MS.gathered);
    expect(ms(TIMELINE.fuse[0] - TIMELINE.pulse[0])).toBe(BEAT_MS.gainedSlot);
    expect(ms(TIMELINE.constructSettle)).toBe(BEAT_MS.portionSettle);
    // Macro: the hex still reads as it did while the city tenses; construction about 200 ms in; the slots change
    // while rail is being built; the commit last, from where the wash began, about 1050-1200 ms.
    expect(ms(TIMELINE.tension[1])).toBeLessThanOrEqual(200);
    expect(ms(TIMELINE.construct[0])).toBe(200);
    expect(TIMELINE.pulse[0]).toBeGreaterThan(TIMELINE.construct[0]);
    expect(TIMELINE.divide[0]).toBeLessThan(TIMELINE.construct[0] + TIMELINE.constructTravel);
    expect(TIMELINE.construct[1]).toBeLessThanOrEqual(TIMELINE.reveal);
    expect(ms(TIMELINE.reveal)).toBeGreaterThanOrEqual(1050);
    expect(ms(TIMELINE.reveal)).toBeLessThanOrEqual(1200);
    // The reveal is a micro beat of 200-300 ms, and the full sequence ends when it does (#1471).
    expect(BEAT_MS.reveal).toBeGreaterThanOrEqual(200);
    expect(BEAT_MS.reveal).toBeLessThanOrEqual(300);
    expect(TILE_TRANSITION_MS).toBe(ms(TIMELINE.reveal) + BEAT_MS.reveal);
    expect(TILE_TRANSITION_MS).toBeLessThanOrEqual(TIMELINE_SPAN_MS);
    for (const span of [TIMELINE.geometry, TIMELINE.outline, TIMELINE.divide, TIMELINE.fuse]) {
      expect(span[1]).toBe(1);
    }
  });

  it("plays #57 -> #14 on that clock: nothing yet, rail at 200 ms, the split inside construction, the commit last", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      expect(plan.durationMs).toBe(1328);
      const at = (wallMs: number) => wallMs / plan.durationMs;
      const built = (wallMs: number) => sampleTileTransition(plan, at(wallMs)).tracks.some((track) => track.widthScale !== undefined);
      const rings = (wallMs: number) => sampleTileTransition(plan, at(wallMs)).cities[0].rings;
      // Nothing has moved to speak of, and no rail is building, until construction starts.
      expect(transitionEasings(plan, at(190)).geometry).toBeLessThan(0.01);
      expect(built(199)).toBe(false);
      expect(built(210)).toBe(true);
      // The lone slot's rings appear with its pulse and have not split before the split beat.
      expect(rings(300).every((ring) => ring.alpha === 0)).toBe(true);
      expect(rings(400).every((ring) => ring.alpha > 0)).toBe(true);
      expect(dist(rings(438)[0].at, rings(438)[1].at)).toBeLessThan(1e-9);
      expect(dist(rings(700)[0].at, rings(700)[1].at)).toBeGreaterThan(0.05);
      // The spokes have settled long before the commit comes.
      expect(built(800)).toBe(true);
      expect(built(820)).toBe(false);
      expect(transitionEasings(plan, at(1080)).reveal).toBe(0);
      expect(transitionEasings(plan, at(1100)).reveal).toBeGreaterThan(0);
      expect(sampleTileTransition(plan, at(1327))).not.toEqual(sampleTileTransition(plan, 1));
    });
  });
});

describe("a transition takes the time its own changes need (#1470)", () => {
  const wallClock = (plan: Plan) => (ms: number) => ms / plan.durationMs;

  it("keeps the full sequence -- new rail, a station mutation and the commit -- with its approved beats", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      expect(plan.components).toEqual({ construction: true, stationMutation: true, geometry: false, trackWork: false, reconfiguration: false });
      expect(plan.durationMs).toBe(TILE_TRANSITION_MS);
      expect(plan.clock).toEqual({ revealStart: 1088, end: 1328 });
      expect(plan.beats).toEqual({ railroadWorkStart: 200, constructionStart: 200, stationEmergence: 439, revealStart: 1088 });
    });
  });

  it("starts the reveal as a rail-only lay's last portion settles, with no time kept for a mutation it lacks", () => {
    under("standard", () => {
      const plan = acceptedPlan("B12", { kind: "tile", tileId: 7, orientation: 2 }, 26, (candidate) => candidate.toArt.turnDeg === -180);
      expect(plan.components).toEqual({ construction: true, stationMutation: false, geometry: false, trackWork: false, reconfiguration: false });
      expect(plan.durationMs).toBe(1052);
      expect(plan.beats).toEqual({ railroadWorkStart: 200, constructionStart: 200, stationEmergence: null, revealStart: 812 });
      const at = wallClock(plan);
      const building = (ms: number) => sampleTileTransition(plan, at(ms)).tracks.some((track) => track.widthScale !== undefined);
      // The rail builds on the approved clock: from 200 ms, the front travelling 544 ms, each portion settling in 68.
      expect(building(199)).toBe(false);
      expect(building(210)).toBe(true);
      expect(building(805)).toBe(true);
      expect(building(815)).toBe(false);
      // The commit follows at once, and the lay ends the reveal's 240 ms later.
      expect(transitionEasings(plan, at(811)).reveal).toBe(0);
      expect(transitionEasings(plan, at(830)).reveal).toBeGreaterThan(0);
      expect(transitionEasings(plan, at(1051)).reveal).toBeLessThan(1);
    });
  });

  it("gives a mutation without new rail its full breath, and marks a 2 -> 3 city's gained slot as the emergence", () => {
    under("plus", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const o63 = firstFacing("H10", { kind: "tile", tileId: 14, orientation: o14 }, 63);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 63, orientation: o63 }, 513);
      expect(plan.components).toEqual({ construction: false, stationMutation: true, geometry: false, trackWork: false, reconfiguration: false });
      expect(plan.durationMs).toBe(1328);
      expect(plan.beats).toEqual({ railroadWorkStart: null, constructionStart: null, stationEmergence: 388, revealStart: 1088 });
      const rings = (ms: number) => sampleTileTransition(plan, wallClock(plan)(ms)).cities[0].rings;
      expect(rings(380).some((ring) => ring.alpha === 0)).toBe(true);
      expect(rings(400).every((ring) => ring.alpha > 0)).toBe(true);
    });
  });

  it("gives a geometry change -- two towns fusing -- its full settle before the commit", () => {
    under("lpf", () => {
      const facing = firstFacing("G7", { kind: "printed", label: "G7" }, 1);
      const plan = acceptedPlan("G7", { kind: "tile", tileId: 1, orientation: facing }, 88);
      expect(plan.components).toEqual({ construction: false, stationMutation: false, geometry: true, trackWork: true, reconfiguration: true });
      expect(plan.durationMs).toBe(1328);
      // Every rail reforms into the hub, so the railroad work starts with the geometry itself (#1475).
      expect(plan.beats).toEqual({ railroadWorkStart: 128, constructionStart: null, stationEmergence: null, revealStart: 1088 });
    });
  });

  it("commits a change with nothing else to play promptly: a brief hold, the reveal, done", () => {
    under("plus", () => {
      const plan = acceptedPlan("B20", { kind: "tile", tileId: 88, orientation: 2 }, 145);
      expect(plan.components).toEqual({ construction: false, stationMutation: false, geometry: false, trackWork: false, reconfiguration: false });
      expect(plan.durationMs).toBe(BEAT_MS.lead + BEAT_MS.reveal);
      expect(plan.beats).toEqual({ railroadWorkStart: null, constructionStart: null, stationEmergence: null, revealStart: BEAT_MS.lead });
      const at = wallClock(plan);
      expect(transitionEasings(plan, at(BEAT_MS.lead - 1)).reveal).toBe(0);
      expect(transitionEasings(plan, at(BEAT_MS.lead + 20)).reveal).toBeGreaterThan(0);
      expect(sampleTileTransition(plan, at(plan.durationMs - 1))).not.toEqual(sampleTileTransition(plan, 1));
      // Nothing but the commit moves.
      const first = sampleTileTransition(plan, 0);
      const middle = sampleTileTransition(plan, 0.5);
      const drawn = (frame: typeof first) => JSON.stringify([frame.tracks, frame.cities, frame.towns]);
      expect(drawn(middle)).toBe(drawn(first));
    });
  });

  it("leaves reduced motion its own short fade", () => {
    under("standard", () => {
      const plan = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: 0 }, to: { tileId: 14, orientation: 0 }, reducedMotion: true })!;
      expect(plan.durationMs).toBe(TILE_TRANSITION_REDUCED_MS);
      expect(plan.beats).toEqual({ railroadWorkStart: null, constructionStart: null, stationEmergence: null, revealStart: 0 });
    });
  });
});

describe("the commit comes last (#1464, #1471)", () => {
  it("commits nothing while the geometry moves, and finishes the geometry's last tenth under the reveal", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const { revealStart, end } = plan.clock;
      const at = (ms: number) => ms / plan.durationMs;
      expect(transitionEasings(plan, at(revealStart)).reveal).toBe(0);
      expect(transitionEasings(plan, at(revealStart)).geometry).toBeGreaterThan(0.85);
      expect(transitionEasings(plan, at(600)).reveal).toBe(0);
      expect(transitionEasings(plan, 1).reveal).toBe(1);
      expect(transitionEasings(plan, 1).geometry).toBe(1);
      expect(transitionEasings(plan, 1).slots).toBe(1);
      expect(end - revealStart).toBe(BEAT_MS.reveal);
      // No rail is still being laid once the commit begins.
      const lastConstruction = Math.max(...plan.tracks.filter((track) => track.cls === "added").map((track) => track.startMs + track.durationMs));
      expect(lastConstruction).toBeLessThanOrEqual(revealStart);
      // The front stands off the hex to the west until the reveal, crosses it once, and leaves it to the east.
      let before = -Infinity;
      for (let ms = 0; ms <= end; ms += 8) {
        const front = frameAt(plan, ms).present!.front;
        if (ms <= revealStart) expect(front).toBe(-REVEAL_SPAN);
        expect(front).toBeGreaterThanOrEqual(before);
        before = front;
      }
      expect(frameAt(plan, end).present!.front).toBe(REVEAL_SPAN);
      // An upgrade nobody proposed here: the old tier stays underneath, under the proposal.
      const fills = frameAt(plan, 900).fills;
      expect(fills).toEqual([
        { color: ERA_TILE_FILL.Yellow, alpha: 1 },
        { color: expect.any(String), alpha: 1 },
      ]);
    });
  });

  it("shows a new lay's proposal over bare ground before anything is built, never the committed colour first", () => {
    under("standard", () => {
      const o8 = firstFacing("G11", { kind: "printed", label: "G11" }, 8);
      const plan = planTileTransition({ from: { kind: "printed", label: "G11" }, to: { tileId: 8, orientation: o8 } })!;
      expect(frameAt(plan, 0).fills.every((fill) => fill.alpha === 0)).toBe(true);
      const proposed = frameAt(plan, 200).fills;
      expect(proposed).toHaveLength(1);
      expect(proposed[0].alpha).toBe(1);
      expect(proposed[0].color).not.toBe(ERA_TILE_FILL.Yellow);
      expect(frameAt(plan, 200).present!.committedFill).toBe(ERA_TILE_FILL.Yellow);
    });
  });

  it("classifies identically whatever the clock says -- the commit is a presentation, not an input", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const a = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const orientation = a.toArt.turnDeg / -60;
      const reduced = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation }, reducedMotion: true })!;
      const proposed = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation }, provisional: true })!;
      expect(describeTransition(reduced)).toEqual(describeTransition(a));
      expect(describeTransition(proposed)).toEqual(describeTransition(a));
      expect(a.durationMs).toBe(TILE_TRANSITION_MS);
      expect(proposed.durationMs).toBe(TILE_TRANSITION_MS);
      expect(reduced.durationMs).toBe(TILE_TRANSITION_REDUCED_MS);
    });
  });
});

describe("the hand-over is not a visible event (#1464)", () => {
  /* The tile pass takes the hex back from the frame, so what ends a transition must already be what that pass
     strokes -- every line once. A shape stroked twice over itself antialiases heavier, and the hand-over would thin
     it. How that looks is a playtest's to judge; that each thing is stroked once is structure, and pinned here. */
  it("ends a merge as one outline and one dit", () => {
    under("lpf", () => {
      const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      const merge = acceptedPlan("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      const opaque = (t: number) => sampleTileTransition(merge, t).cities[0].blobs.filter((blob) => (blob.alpha ?? 1) > 0);
      expect(opaque(0.5).length).toBeGreaterThan(1); // both cities and the neck growing between them
      expect(opaque(1)).toHaveLength(1);
      expect(opaque(1)[0].points).toEqual(outlineOf(merge.toArt.markers[0]).points);

      const facing = firstFacing("G7", { kind: "printed", label: "G7" }, 1);
      const towns = acceptedPlan("G7", { kind: "tile", tileId: 1, orientation: facing }, 88);
      const drawnTowns = (t: number) => sampleTileTransition(towns, t).towns.filter((town) => town.alpha > 0 && town.role !== "target");
      expect(drawnTowns(0.5)).toHaveLength(2);
      expect(drawnTowns(1)).toHaveLength(1);
    });
  });

  it("keeps a city's rings whole at both ends, and strokes no arc twice in between", () => {
    under("plus", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const o63 = firstFacing("H10", { kind: "tile", tileId: 14, orientation: o14 }, 63);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 63, orientation: o63 }, 513);
      expect(sampleTileTransition(plan, 0).cities[0].ringsWhole).toBe(1); // #63's own circles, crossings and all
      expect(sampleTileTransition(plan, 0.5).cities[0].ringsWhole).toBe(0); // one gathering system
      expect(sampleTileTransition(plan, 1).cities[0].ringsWhole).toBe(1); // #513's
      for (const t of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
        const { rings } = sampleTileTransition(plan, t).cities[0];
        const union = ringUnionArcs(rings);
        const covered = ringCoveredArcs(rings, union);
        rings.forEach((ring, index) => {
          if (ring.alpha <= 0 || ring.radius <= 0) return;
          const arcs = [...union, ...covered].filter((arc) => arc.ring === index).sort((a, b) => a.start - b.start);
          // End to end, once round: no gap, and no arc over another.
          let cursor = 0;
          for (const arc of arcs) {
            expect(arc.start).toBeCloseTo(cursor, 5);
            cursor = arc.end;
          }
          expect(cursor).toBeCloseTo(Math.PI * 2, 5);
        });
      }
    });
  });

  it("strokes one rim: the old tier's, carried to the proposal's, and the destination's once committed", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const upgrade = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      expect(sampleTileTransition(upgrade, 0).rim).toEqual({ color: COLOR_TIER_STROKE.Yellow, alpha: 1 });
      expect(frameAt(upgrade, BEAT_MS.lead + 1).rim).toEqual(proposedTileFrame(14, upgrade.toArt.turnDeg / -60)!.rim);
      expect(sampleTileTransition(upgrade, 1).present!.committedRim).toBe(COLOR_TIER_STROKE.Green);

      const o8 = firstFacing("G11", { kind: "printed", label: "G11" }, 8);
      const lay = planTileTransition({ from: { kind: "printed", label: "G11" }, to: { tileId: 8, orientation: o8 } })!;
      expect(sampleTileTransition(lay, 0).rim.alpha).toBe(0);
      expect(sampleTileTransition(lay, 1).present).toEqual(expect.objectContaining({ committedRim: COLOR_TIER_STROKE.Yellow, front: REVEAL_SPAN }));
    });
  });
});

describe("new rail is built by a travelling construction wave (#1467, #1469)", () => {
  type Track = Plan["tracks"][number];
  /** What the sampler draws for one piece on its own at wall-clock `ms` -- its planned copy aside (#1471). */
  const pieceFrames = (plan: Plan, track: Track, ms: number) =>
    frameAt({ ...plan, tracks: [track] }, ms).tracks.filter((frame) => frame.role !== "target");
  const lengthOf = (points: readonly Vec[]) => points.slice(1).reduce((sum, point, k) => sum + dist(points[k], point), 0);
  const originOf = (track: Track) => (track.growsFromEnd ? track.to!.to : track.to!.from);
  /** The piece's polyline from its origin -- the order construction draws it in. */
  const fromOrigin = (track: Track) => (track.growsFromEnd ? track.to!.points.slice().reverse() : track.to!.points);

  it("reveals new rail from its origin along the rail itself, erupting behind the front, never the whole path at once", () => {
    under("standard", () => {
      const o8 = firstFacing("G11", { kind: "printed", label: "G11" }, 8);
      const edge = (2 + o8) % 6;
      const plan = planTileTransition({ from: { kind: "printed", label: "G11" }, to: { tileId: 8, orientation: o8 }, externalEdges: [edge] })!;
      const [track] = plan.tracks;
      expect(originOf(track)).toEqual({ kind: "edge", edge });
      const path = fromOrigin(track);
      const total = lengthOf(path);
      const travelEnds = track.startMs + track.durationMs - BEAT_MS.portionSettle;
      expect(pieceFrames(plan, track, track.startMs)).toEqual([]);
      let revealedBefore = 0;
      for (let step = 1; step < 48; step += 1) {
        const t = track.startMs + (track.durationMs * step) / 48;
        const frames = pieceFrames(plan, track, t);
        // One unbroken run from the origin: each portion begins where the last one ended.
        expect(dist(frames[0].points[0], path[0])).toBeLessThan(1e-9);
        frames.slice(1).forEach((frame, k) => {
          const previous = frames[k].points;
          expect(dist(frame.points[0], previous[previous.length - 1])).toBeLessThan(1e-9);
        });
        // Only the leading run is plain, opaque rail -- what has settled; everything after it is erupting.
        frames.forEach((frame, k) => {
          if (frame.widthScale === undefined) expect([k, frame.alpha]).toEqual([0, 1]);
          else expect(frame.widthScale).toBeLessThanOrEqual(1 + CONSTRUCTION_WAVE.overshoot + 1e-12);
        });
        const revealed = frames.reduce((sum, frame) => sum + lengthOf(frame.points), 0);
        expect(revealed).toBeGreaterThanOrEqual(revealedBefore - 1e-9);
        revealedBefore = revealed;
        if (t < travelEnds) {
          expect(revealed).toBeLessThan(total - 1e-9);
          expect(frames.some((frame) => frame.widthScale !== undefined)).toBe(true);
        }
      }
      // Settled: the destination's own polyline, once, at the board's pen.
      expect(pieceFrames(plan, track, track.startMs + track.durationMs)).toEqual([{ points: path, alpha: 1, destTrack: track.to!.track }]);
    });
  });

  it("cuts portions out of the rail's own geometry, and swells only the pen", () => {
    under("standard", () => {
      const o8 = firstFacing("G11", { kind: "printed", label: "G11" }, 8);
      const curve = planTileTransition({ from: { kind: "printed", label: "G11" }, to: { tileId: 8, orientation: o8 } })!.tracks[0].to!.points;
      const total = lengthOf(curve);
      const count = constructionPortions(total);
      const joined: Vec[] = [];
      for (let i = 0; i < count; i += 1) {
        const portion = slicePolyline(curve, (total * i) / count, (total * (i + 1)) / count);
        expect(lengthOf(portion)).toBeCloseTo(total / count, 9);
        // Between its cuts a portion is the curve's own vertices, and each cut lies on one of the curve's segments.
        portion.slice(1, -1).forEach((point) => expect(curve.some((vertex) => dist(vertex, point) === 0)).toBe(true));
        joined.push(...(i === 0 ? portion : portion.slice(1)));
      }
      expect(curve.every((vertex) => joined.some((point) => dist(point, vertex) < 1e-12))).toBe(true);
      expect(lengthOf(joined)).toBeCloseTo(total, 9);
    });
    // Hidden, then quickly opaque; wider than the rail only while erupting, and exactly the rail once settled.
    expect(eruption(0)).toEqual({ alpha: 0, widthScale: 1 });
    expect(eruption(1)).toEqual({ alpha: 1, widthScale: 1 });
    let widest = 1;
    let alphaBefore = 0;
    for (let age = 0.01; age < 1; age += 0.01) {
      const look = eruption(age);
      expect(look.alpha).toBeGreaterThanOrEqual(alphaBefore);
      expect(look.widthScale).toBeGreaterThanOrEqual(1);
      alphaBefore = look.alpha;
      widest = Math.max(widest, look.widthScale);
    }
    expect(widest).toBeCloseTo(1 + CONSTRUCTION_WAVE.overshoot, 2);
    // The count belongs to the rail, not to the clock: about one portion per rail width, and a short spur keeps the
    // grain it was approved at rather than being cut finer to fill a longer travel.
    expect(constructionPortions(0.3)).toBe(CONSTRUCTION_WAVE.minPortions);
    expect(constructionPortions(Math.sqrt(3))).toBe(14);
  });

  it("keeps each portion's eruption to its own 68 ms while the front travels the longer clock", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const [track] = plan.tracks.filter((candidate) => candidate.cls === "added");
      const after = (wallMs: number) => pieceFrames(plan, track, track.startMs + wallMs);
      expect(track.durationMs - BEAT_MS.portionSettle).toBeCloseTo(0.34 * 1600, 6);
      // 34 ms in, the first portion is erupting and nothing has settled; 69 ms in, it has settled.
      expect(after(34)[0].widthScale).toBeGreaterThan(1);
      expect(after(69)[0]).toEqual(expect.objectContaining({ alpha: 1 }));
      expect(after(69)[0].widthScale).toBeUndefined();
    });
  });

  it("builds branches from their own anchors at the same time, and leaves the rail already there alone", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const added = plan.tracks.filter((track) => track.cls === "added");
      expect(added).toHaveLength(2);
      expect(added.map((track) => [track.startMs, track.durationMs])).toEqual([
        [spanMs(TIMELINE.construct[0]), added[0].durationMs],
        [spanMs(TIMELINE.construct[0]), added[0].durationMs],
      ]);
      const persistent = plan.tracks.filter((track) => track.cls === "persistent");
      const revealed = (track: Track, t: number) =>
        pieceFrames(plan, track, t).reduce((sum, frame) => sum + lengthOf(frame.points), 0) / lengthOf(track.to!.points);
      let bothErupting = false;
      for (let t = spanMs(TIMELINE.construct[0]); t <= 880; t += 16) {
        // Both spokes are built together, each exactly as far along itself as the other...
        expect(revealed(added[0], t)).toBeCloseTo(revealed(added[1], t), 9);
        if (added.every((track) => pieceFrames(plan, track, t).some((frame) => frame.widthScale !== undefined))) bothErupting = true;
        // ...while #57's rails stay whole, opaque, at the board's pen, and the proposal's own (#1471).
        for (const track of persistent) {
          expect(pieceFrames(plan, track, t)).toEqual([{ points: track.to!.points, alpha: 1, destTrack: track.to!.track, role: "static" }]);
        }
      }
      expect(bothErupting).toBe(true);
    });
  });

  it("continues a piece from where, and when, the wave arrived", () => {
    /* NOT A RULES CASE: a town tile on bare ground, so the town has no predecessor and the only anchor that stands
       from the start is a neighbour's edge. The planner describes whatever pair it is handed; this pins the chain
       -- the second piece leaves the town the moment the first one reaches it -- and says nothing about a lay. */
    under("standard", () => {
      const probe = planTileTransition({ from: { kind: "printed", label: "G11" }, to: { tileId: 3, orientation: 0 } })!;
      const edgeNode = probe.tracks.flatMap((track) => [track.to!.from, track.to!.to]).find((node) => node.kind === "edge")!;
      const edge = (edgeNode as { edge: number }).edge;
      const plan = planTileTransition({ from: { kind: "printed", label: "G11" }, to: { tileId: 3, orientation: 0 }, externalEdges: [edge] })!;
      const [first, second] = plan.tracks.filter((track) => track.cls === "added").sort((a, b) => a.startMs - b.startMs);
      expect(originOf(first)).toEqual({ kind: "edge", edge });
      const reached = first.growsFromEnd ? first.to!.from : first.to!.to;
      expect(reached.kind).toBe("marker");
      expect(originOf(second)).toEqual(reached);
      expect(first.startMs).toBe(spanMs(TIMELINE.construct[0]));
      expect(second.startMs).toBeCloseTo(first.startMs + first.durationMs - BEAT_MS.portionSettle, 9);
      expect(second.startMs + second.durationMs).toBeLessThanOrEqual(spanMs(TIMELINE.construct[1]) + 1e-9);
    });
  });
});

describe("a token is a piece seated in its station, and a reservation marker rides the same seat (#1466, #1472, #1473)", () => {
  const ORIGIN = { x: 0, y: 0 };
  type Seat = { from: Vec; to: Vec; fromCity?: number; toCity?: number };
  const motionOf = (token: Seat) => ({ from: token.from, fromRadius: 0.16, to: token.to, toRadius: 0.16, fromCity: token.fromCity, toCity: token.toCity });
  const seatAt = (plan: Plan, token: Seat, ms: number) => tokenPositionAt(plan, ms / plan.durationMs, motionOf(token)).at;
  const activeCity = (plan: Plan, ms: number, index = 0) => frameAt(plan, ms).cities.filter((city) => city.role !== "target")[index];
  const nearestRing = (point: Vec, rings: ReadonlyArray<{ at: Vec; alpha: number }>) =>
    Math.min(...rings.filter((ring) => ring.alpha > 0).map((ring) => dist(point, ring.at)));
  const facingOf = (plan: Plan) => ((plan.toArt.turnDeg / -60) % 6 + 6) % 6;
  /** How far outside a frame city's drawn station shapes a point is: at most 0 when it is inside them. */
  const outsideStation = (point: Vec, city: { blobs: ReadonlyArray<{ points: Vec[]; closed: boolean; radius: number; alpha?: number }> }) => {
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
  };
  const sweep = (end: number, step = 8) => [...Array.from({ length: Math.floor(end / step) }, (_, k) => k * step), end];

  it("1 -> 2: sits in the lone slot through the shake and pulse, and leaves with the split along its own branch", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const probe = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const o14 = facingOf(probe);
      const lone = tileCitySlotPoints(57, 0, o57, ORIGIN, 1)[0];
      const slots = tileCitySlotPoints(14, 0, o14, ORIGIN, 1);
      for (const provisional of [false, true]) {
        const plan = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 }, provisional })!;
        for (const final of [0, 1]) {
          const token = { from: lone, to: slots[final], fromCity: 0, toCity: 0 };
          expect(seatAt(plan, token, 0)).toEqual(lone);
          // One slot until the split: the token only shakes with the city.
          for (const ms of [40, 100, 200, 320, 400, 438]) expect(dist(seatAt(plan, token, ms), lone)).toBeLessThan(0.02);
          // From the split it is on the ring that ends in its own slot, and on no other branch.
          for (const ms of [480, 600, 800, 1000, 1200]) {
            const rings = activeCity(plan, ms).rings;
            expect(dist(seatAt(plan, token, ms), rings[final].at)).toBeLessThan(1e-6);
            if (ms >= 700) expect(dist(seatAt(plan, token, ms), rings[1 - final].at)).toBeGreaterThan(0.05);
          }
          expect(tokenPositionAt(plan, 1, motionOf(token)).at).toEqual(slots[final]);
        }
      }
    });
  });

  it("2 -> 3, both slots taken: the tokens gather with their slots, overlap, and part for their own slots", () => {
    under("plus", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const o63 = firstFacing("H10", { kind: "tile", tileId: 14, orientation: o14 }, 63);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 63, orientation: o63 }, 513);
      const o513 = facingOf(plan);
      const before = tileCitySlotPoints(63, 0, o63, ORIGIN, 1);
      const after = tileCitySlotPoints(513, 0, o513, ORIGIN, 1);
      const radius = tileCityTokenRadius(513, 1, 0)!;
      const a = { from: before[0], to: after[0], fromCity: 0, toCity: 0 };
      const b = { from: before[1], to: after[1], fromCity: 0, toCity: 0 };
      // Each is in a slot of the gathering system -- its own -- until the slots part at the split.
      for (const ms of [0, 240, 320, 388, 430]) {
        for (const token of [a, b]) expect(nearestRing(seatAt(plan, token, ms), activeCity(plan, ms).rings)).toBeLessThan(1e-6);
      }
      // Gathered, the two pieces overlap: they are never pushed apart to avoid it.
      let closest = Infinity;
      let when = 0;
      for (let ms = 224; ms <= 700; ms += 4) {
        const gap = dist(seatAt(plan, a, ms), seatAt(plan, b, ms));
        if (gap < closest) [closest, when] = [gap, ms];
      }
      expect(closest).toBeLessThan(radius);
      // The overlap comes around the gained slot's emergence (the beat audio keeps), and the parting follows the split.
      expect(when).toBeGreaterThanOrEqual(plan.beats.stationEmergence! - 100);
      expect(when).toBeLessThanOrEqual(TIMELINE.divide[0] * TIMELINE_SPAN_MS + 150);
      expect(dist(seatAt(plan, a, 1000), seatAt(plan, b, 1000))).toBeGreaterThan(radius);
      // Each piece ends exactly where authoritative state puts it, and its identity is its ends, not the rings' pairing.
      expect(tokenPositionAt(plan, 1, motionOf(a)).at).toEqual(after[0]);
      expect(tokenPositionAt(plan, 1, motionOf(b)).at).toEqual(after[1]);
      const traded = { ...a, to: after[1] };
      expect(tokenPositionAt(plan, 1, motionOf(traded)).at).toEqual(after[1]);
      expect(dist(seatAt(plan, traded, 900), after[1])).toBeLessThan(dist(seatAt(plan, traded, 900), after[0]));
    });
  });

  it("2 -> 3, one slot taken: the token gathers and parts alone, and the city's other slots stay empty", () => {
    under("plus", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const o63 = firstFacing("H10", { kind: "tile", tileId: 14, orientation: o14 }, 63);
      const plan = acceptedPlan("H10", { kind: "tile", tileId: 63, orientation: o63 }, 513);
      const before = tileCitySlotPoints(63, 0, o63, ORIGIN, 1);
      const after = tileCitySlotPoints(513, 0, facingOf(plan), ORIGIN, 1);
      const token = { from: before[1], to: after[0], fromCity: 0, toCity: 0 };
      const anchor = plan.toArt.markers[0].at;
      expect(dist(seatAt(plan, token, 480), anchor)).toBeLessThan(dist(token.from, anchor) * 0.5); // gathered inward
      const end = tokenPositionAt(plan, 1, motionOf(token)).at;
      expect(end).toEqual(after[0]);
      expect(dist(end, after[1])).toBeGreaterThan(0.1);
      expect(dist(end, after[2])).toBeGreaterThan(0.1);
    });
  });

  it("moves with a migrating city, and is never at the city's destination before the city arrives", () => {
    under("standard", () => {
      const probe = acceptedPlan("I15", { kind: "printed", label: "I15" }, 53);
      const o53 = facingOf(probe);
      for (const provisional of [false, true]) {
        const plan = planTileTransition({ from: { kind: "printed", label: "I15" }, to: { tileId: 53, orientation: o53 }, provisional })!;
        const printed = plan.fromArt.markers[0].at;
        const token = { from: printed, to: tileCitySlotPoints(53, 0, o53, ORIGIN, 1)[0], toCity: 0 }; // a printed hex records no city
        expect(seatAt(plan, token, 0)).toEqual(printed);
        for (const ms of [100, 250, 400, 600, 900, 1200, 1300]) {
          const circle = activeCity(plan, ms).blobs[0].points[0];
          expect(dist(seatAt(plan, token, ms), circle)).toBeLessThan(1e-6);
        }
        expect(dist(seatAt(plan, token, 300), token.to)).toBeGreaterThan(0.05);
        expect(tokenPositionAt(plan, 1, motionOf(token)).at).toEqual(token.to);
      }
    });
  });

  it("keeps merging cities' tokens distinct pieces, each travelling with its own city's slot into its own final slot", () => {
    under("lpf", () => {
      const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      const plan = acceptedPlan("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      const after = tileCitySlotPoints(883, 0, facingOf(plan), ORIGIN, 1);
      // Both cities' tokens land in the merged city, in company order -- slots 0 and 1, which is not the rings' pairing.
      const a = { from: tileCitySlotPoints(54, 0, o54, ORIGIN, 1)[0], to: after[0], fromCity: 0, toCity: 0 };
      const b = { from: tileCitySlotPoints(54, 1, o54, ORIGIN, 1)[0], to: after[1], fromCity: 1, toCity: 0 };
      expect(describeTransition(plan).cities[0].event).toBe("merge");
      for (const token of [a, b]) {
        expect(seatAt(plan, token, 0)).toEqual(token.from);
        // In its own city until the slots travel.
        for (const ms of [100, 300, 430]) expect(dist(seatAt(plan, token, ms), token.from)).toBeLessThan(0.02);
        // Then inside the city forming around it, travelling at the slots' own pace, all the way to its slot.
        for (const ms of sweep(plan.durationMs, 16)) expect(outsideStation(seatAt(plan, token, ms), activeCity(plan, ms))).toBeLessThanOrEqual(1e-9);
        expect(tokenPositionAt(plan, 1, motionOf(token)).at).toEqual(token.to);
      }
      for (const ms of sweep(plan.durationMs)) expect(dist(seatAt(plan, a, ms), seatAt(plan, b, ms))).toBeGreaterThan(0.2);
    });
  });

  it("reseats a token in a city that does not change only where the board orders its slots differently, before the commit", () => {
    under("standard", () => {
      expect(acceptedFacings("E19", { kind: "tile", tileId: 15, orientation: 3 }, 63)).toContain(5);
      const [old0] = tileCitySlotPoints(15, 0, 3, ORIGIN, 1);
      const [new0] = tileCitySlotPoints(63, 0, 5, ORIGIN, 1);
      expect(dist(old0, new0)).toBeGreaterThan(0.2); // the same two slots, numbered the other way round
      const token = { from: old0, to: new0, fromCity: 0, toCity: 0 };
      const remote = planTileTransition({ from: { kind: "tile", tileId: 15, orientation: 3 }, to: { tileId: 63, orientation: 5 } })!;
      expect(describeTransition(remote).cities[0].event).toBe("static");
      expect(seatAt(remote, token, 0)).toEqual(old0);
      expect(dist(seatAt(remote, token, 400), remote.toArt.markers[0].at)).toBeGreaterThan(0.1); // round the centre, not through it
      expect(seatAt(remote, token, remote.clock.revealStart)).toEqual(new0); // in place before the commit
      const proposed = planTileTransition({ from: { kind: "tile", tileId: 15, orientation: 3 }, to: { tileId: 63, orientation: 5 }, provisional: true })!;
      for (const ms of [0, 300, 900]) expect(seatAt(proposed, token, ms)).toEqual(new0); // already drawn there
    });
  });

  it("moves a token whose seat cannot be read with its two cities' anchors, as before", () => {
    under("standard", () => {
      const facing = firstFacing("E11", { kind: "printed", label: "E11" }, 59);
      const plan = planTileTransition({ from: { kind: "printed", label: "E11" }, to: { tileId: 59, orientation: facing } })!;
      const from = plan.fromArt.markers[0].at;
      const to = tileCitySlotPoints(59, 1, facing, ORIGIN, 1)[0];
      const motion = { from, fromRadius: 0.2, fromAnchor: from, to, toRadius: 0.16, toAnchor: to }; // two printed circles, no city index
      expect(tokenPositionAt(plan, 0, motion).at).toEqual(from);
      expect(tokenPositionAt(plan, 1, motion).at).toEqual(to);
      const mid = tokenPositionAt(plan, 0.5, motion).at;
      expect(dist(mid, from) + dist(mid, to)).toBeGreaterThan(0);
    });
    under("standard", () => {
      // Printed New York draws every token in its first circle (#221), whatever city the chain names. A token the chain
      // puts in the second is not standing in that city's slot, so there is no seat to read and none is guessed.
      const facing = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      const plan = planTileTransition({ from: { kind: "printed", label: "G19" }, to: { tileId: 54, orientation: facing } })!;
      const drawn = plan.fromArt.markers[0].at;
      const to = tileCitySlotPoints(54, 1, facing, ORIGIN, 1)[0];
      const named = { from: drawn, fromRadius: 0.2, to, toRadius: 0.16, fromCity: 1, toCity: 1 };
      const unnamed = { from: drawn, fromRadius: 0.2, to, toRadius: 0.16 };
      for (const ms of sweep(plan.durationMs, 64)) {
        const t = ms / plan.durationMs;
        expect(tokenPositionAt(plan, t, named).at).toEqual(tokenPositionAt(plan, t, unnamed).at);
      }
      // The same city index with the token in that city's own slot is seated: it rides the circle.
      const seated = { ...named, from: plan.fromArt.markers[1].at };
      expect(dist(tokenPositionAt(plan, 0.3, seated).at, tokenPositionAt(plan, 0.3, { ...unnamed, from: seated.from }).at)).toBeGreaterThan(1e-3);
    });
  });

  it("rides nothing under reduced motion: an unproposed lay swaps at the midpoint, a confirmed proposal's tokens stay put", () => {
    under("standard", () => {
      const token = { from: { x: 0, y: 0 }, to: tileCitySlotPoints(14, 0, 0, ORIGIN, 1)[1], fromCity: 0, toCity: 0 };
      const swap = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: 0 }, to: { tileId: 14, orientation: 0 }, reducedMotion: true })!;
      expect(tokenPositionAt(swap, 0.2, motionOf(token)).at).toEqual(token.from);
      expect(tokenPositionAt(swap, 0.8, motionOf(token)).at).toEqual(token.to);
      // And the stations swap at the midpoint too, never two see-through cities.
      expect(sampleTileTransition(swap, 0.3).cities.filter((city) => city.alpha > 0)).toHaveLength(1);
      const kept = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: 0 }, to: { tileId: 14, orientation: 0 }, reducedMotion: true, provisional: true })!;
      for (const t of [0, 0.3, 0.7, 1]) expect(tokenPositionAt(kept, t, motionOf(token)).at).toEqual(token.to);
    });
  });

  it("is one position per token per frame, and exactly its authoritative place at the end, for every seated case above", () => {
    under("plus", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const probe = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const slots = tileCitySlotPoints(14, 0, facingOf(probe), ORIGIN, 1);
      const token = { from: tileCitySlotPoints(57, 0, o57, ORIGIN, 1)[0], to: slots[1], fromCity: 0, toCity: 0 };
      let previous = seatAt(probe, token, 0);
      for (const ms of sweep(probe.durationMs, 4)) {
        const now = seatAt(probe, token, ms);
        expect(dist(now, previous)).toBeLessThan(0.02); // no jump between frames
        previous = now;
      }
      expect(previous).toEqual(slots[1]);
    });
  });

  it("rides a home reservation marker on a migrating city's circle, never at the destination before the circle (#1473)", () => {
    under("standard", () => {
      const facing = facingOf(acceptedPlan("E23", { kind: "printed", label: "E23" }, 53));
      for (const provisional of [false, true]) {
        const plan = planTileTransition({ from: { kind: "printed", label: "E23" }, to: { tileId: 53, orientation: facing }, provisional })!;
        expect(describeTransition(plan).cities[0].event).toBe("migrate");
        // Where the board draws B&M's reservation on each tile: on the printed circle, then on #53's city.
        const marker = { from: plan.fromArt.markers[0].at, to: plan.toArt.markers[0].at };
        expect(reservationPositionAt(plan, 0, marker)).toEqual(marker.from);
        for (const ms of [100, 250, 400, 600, 900, 1200, 1300]) {
          expect(dist(reservationPositionAt(plan, ms / plan.durationMs, marker), activeCity(plan, ms).blobs[0].points[0])).toBeLessThan(1e-6);
        }
        expect(dist(reservationPositionAt(plan, 300 / plan.durationMs, marker), marker.to)).toBeGreaterThan(0.05);
        expect(reservationPositionAt(plan, 1, marker)).toEqual(marker.to);
        expect(pieceMoves(plan, marker.to, (t) => reservationPositionAt(plan, t, marker))).toBe(true);
      }
    });
  });

  it("keeps a reservation marker on its city's centre while the city gains a slot: it follows no branch and never splits (#1473)", () => {
    under("plus", () => {
      const facing = facingOf(acceptedPlan("E23", { kind: "printed", label: "E23" }, 592));
      for (const provisional of [false, true]) {
        const plan = planTileTransition({ from: { kind: "printed", label: "E23" }, to: { tileId: 592, orientation: facing }, provisional })!;
        expect(describeTransition(plan).cities[0]).toMatchObject({ event: "capacity", fromSlots: [1], toSlots: 2 });
        const destination = plan.toArt.markers[0];
        const marker = { from: plan.fromArt.markers[0].at, to: destination.at };
        const [one, other] = slotCentres(destination);
        expect(dist(marker.from, marker.to)).toBeGreaterThan(0.1); // the city moves as it divides
        for (const ms of sweep(plan.durationMs, 16)) {
          const at = reservationPositionAt(plan, ms / plan.durationMs, marker);
          expect(outsideStation(at, activeCity(plan, ms))).toBeLessThanOrEqual(1e-9);
          // Once the slots have spread it stands between them, gone with neither.
          if (ms >= 900) expect(Math.abs(dist(at, one) - dist(at, other))).toBeLessThan(0.05);
        }
        expect(reservationPositionAt(plan, 1, marker)).toEqual(marker.to);
        expect(pieceMoves(plan, marker.to, (t) => reservationPositionAt(plan, t, marker))).toBe(true);
      }
    });
  });

  it("carries a reservation marker with its own city into a merged city (#1473)", () => {
    under("lpf", () => {
      const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      const plan = acceptedPlan("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      // NNH's reservation where the board draws it: #54's first city, then #883's centre.
      const marker = { from: plan.fromArt.markers[0].at, to: plan.toArt.markers[0].at };
      for (const ms of [100, 300]) expect(dist(reservationPositionAt(plan, ms / plan.durationMs, marker), marker.from)).toBeLessThan(0.02);
      for (const ms of sweep(plan.durationMs, 16)) {
        expect(outsideStation(reservationPositionAt(plan, ms / plan.durationMs, marker), activeCity(plan, ms))).toBeLessThanOrEqual(1e-9);
      }
      expect(reservationPositionAt(plan, 1, marker)).toEqual(marker.to);
    });
  });

  it("converges an OO home's two markers on the one city a tile gives them: the one whose circle becomes it rides, the other goes straight (#1473)", () => {
    under("standard", () => {
      const plan = acceptedPlan("E11", { kind: "printed", label: "E11" }, 59);
      const cities = plan.toArt.markers.flatMap((marker, index) => (marker.kind === "city" ? [index] : []));
      // The board draws an OO home's reservation in a tile's second city, and on both printed circles before that.
      const to = plan.toArt.markers[cities[1]].at;
      const successors = plan.cities[cities[1]].sources;
      expect(successors).toHaveLength(1);
      plan.fromArt.markers.forEach((circle, index) => {
        const marker = { from: circle.at, to };
        expect(reservationPositionAt(plan, 0, marker)).toEqual(marker.from);
        expect(reservationPositionAt(plan, 1, marker)).toEqual(to);
        for (const ms of [200, 500, 900]) {
          const at = reservationPositionAt(plan, ms / plan.durationMs, marker);
          if (successors.includes(index)) {
            expect(outsideStation(at, activeCity(plan, ms, 1))).toBeLessThanOrEqual(1e-9);
          } else {
            const along = transitionEasings(plan, ms / plan.durationMs).geometry;
            expect(dist(at, { x: circle.at.x + (to.x - circle.at.x) * along, y: circle.at.y + (to.y - circle.at.y) * along })).toBeLessThan(1e-9);
          }
        }
      });
    });
  });

  it("counts a piece as moved only when its ride leaves its place, and shows a moving token's planned place until the commit settles it (#1473, #1474)", () => {
    under("standard", () => {
      // A city the lay does not change: its reservation stays put, and has nothing to plan.
      const still = acceptedPlan("E19", { kind: "printed", label: "E19" }, 57);
      expect(describeTransition(still).cities[0].event).toBe("static");
      const staying = { from: still.fromArt.markers[0].at, to: still.toArt.markers[0].at };
      expect(pieceMoves(still, staying.to, (t) => reservationPositionAt(still, t, staying))).toBe(false);
      // A token the board numbers into the other slot of an unchanged city: a lay nobody proposed swings it there; a
      // confirmed proposal already drew it there, so it does not move and has no planned place.
      const reseated = { from: tileCitySlotPoints(15, 0, 3, ORIGIN, 1)[0], to: tileCitySlotPoints(63, 0, 5, ORIGIN, 1)[0], fromCity: 0, toCity: 0 };
      const swap = { from: { kind: "tile" as const, tileId: 15, orientation: 3 }, to: { tileId: 63, orientation: 5 } };
      const remote = planTileTransition(swap)!;
      const confirmed = planTileTransition({ ...swap, provisional: true })!;
      expect(pieceMoves(remote, reseated.to, (t) => tokenPositionAt(remote, t, motionOf(reseated)).at)).toBe(true);
      expect(pieceMoves(confirmed, reseated.to, (t) => tokenPositionAt(confirmed, t, motionOf(reseated)).at)).toBe(false);

      // A token on a dividing city moves; its planned place shows from a confirm's first frame, through the commit's
      // start, and is gone exactly as the token arrives.
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = facingOf(acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14));
      const split = { from: tileCitySlotPoints(57, 0, o57, ORIGIN, 1)[0], to: tileCitySlotPoints(14, 0, o14, ORIGIN, 1)[1], fromCity: 0, toCity: 0 };
      const lay = { from: { kind: "tile" as const, tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 } };
      const plan = planTileTransition({ ...lay, provisional: true })!;
      expect(pieceMoves(plan, split.to, (t) => tokenPositionAt(plan, t, motionOf(split)).at)).toBe(true);
      const revealStart = plan.clock.revealStart / plan.durationMs;
      expect(pieceTargetPresence(plan, 0)).toBe(1);
      expect(pieceTargetPresence(plan, revealStart)).toBe(1);
      expect(pieceTargetPresence(plan, (revealStart + 1) / 2)).toBeGreaterThan(0);
      expect(pieceTargetPresence(plan, (revealStart + 1) / 2)).toBeLessThan(1);
      expect(pieceTargetPresence(plan, 1)).toBe(0);
      expect(tokenPositionAt(plan, 1, motionOf(split)).at).toEqual(split.to);
      // A lay nobody proposed here has none at any moment (#1474), though its token rides the same way; reduced motion
      // rides nothing and plans nothing.
      const unproposed = planTileTransition(lay)!;
      for (let ms = 0; ms <= unproposed.durationMs; ms += 8) expect(pieceTargetPresence(unproposed, ms / unproposed.durationMs)).toBe(0);
      expect(pieceMoves(unproposed, split.to, (t) => tokenPositionAt(unproposed, t, motionOf(split)).at)).toBe(true);
      const reduced = planTileTransition({ ...lay, provisional: true, reducedMotion: true })!;
      expect(pieceMoves(reduced, split.to, (t) => tokenPositionAt(reduced, t, motionOf(split)).at)).toBe(false);
      for (const t of [0, 0.5, 1]) expect(pieceTargetPresence(reduced, t)).toBe(0);
    });
  });

  it("plans a token's place only on a lay this board proposed: another seat's lay rides its tokens in from their seats with no target (#1474)", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = facingOf(acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14));
      const lay = { from: { kind: "tile" as const, tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 } };
      const split = { from: tileCitySlotPoints(57, 0, o57, ORIGIN, 1)[0], to: tileCitySlotPoints(14, 0, o14, ORIGIN, 1)[1], fromCity: 0, toCity: 0 };
      const local = planTileTransition({ ...lay, provisional: true })!;
      const remote = planTileTransition(lay)!;
      const frames = (plan: Plan) => sweep(plan.durationMs).map((ms) => ms / plan.durationMs);
      // The local proposal is unchanged: its planned place whole until the commit, gone as its token arrives.
      expect(pieceMoves(local, split.to, (t) => tokenPositionAt(local, t, motionOf(split)).at)).toBe(true);
      expect(pieceTargetPresence(local, 0)).toBe(1);
      expect(pieceTargetPresence(local, local.clock.revealStart / local.durationMs)).toBe(1);
      expect(pieceTargetPresence(local, 1)).toBe(0);
      // The remote lay moves the same token, from its seat on the old tile to its place, and shows nothing waiting there.
      expect(pieceMoves(remote, split.to, (t) => tokenPositionAt(remote, t, motionOf(split)).at)).toBe(true);
      for (const t of frames(remote)) expect(pieceTargetPresence(remote, t)).toBe(0);
      expect(dist(tokenPositionAt(remote, 0, motionOf(split)).at, split.from)).toBeLessThan(1e-9);
      expect(tokenPositionAt(remote, 1, motionOf(split)).at).toEqual(split.to);
      expect(tokenPositionAt(local, 1, motionOf(split)).at).toEqual(split.to);
      // A reservation marker has no planned place on either: nothing here gives it one.
      const marker = { from: remote.fromArt.markers[0].at, to: remote.toArt.markers[0].at };
      expect(reservationPositionAt(remote, 1, marker)).toEqual(marker.to);
      expect(reservationPositionAt(local, 1, marker)).toEqual(marker.to);
    });
  });
});

describe("merging cities reach for each other as bodies (#1473)", () => {
  /* A city is drawn as an ink band with white inside, so a stroke thinner than the band is all ink -- a rail-wide black
     line. That is what the neck used to be while it formed: the merged outline, from one city to the other, at a
     fraction of a city's width. Every merging outline is now a city's full width, so the cities read as bodies meeting,
     and nothing between them is built as rail. */
  const newYork = () => {
    const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
    const o883 = firstFacing("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
    return {
      accepted: acceptedPlan("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883),
      // Built without the filter, as in #1462's case above: two two-slot cities into #883.
      direct: planTileTransition({ from: { kind: "tile", tileId: 62, orientation: o54 }, to: { tileId: 883, orientation: o883 } })!,
    };
  };
  const drawnBodies = (plan: Plan, ms: number) =>
    frameAt(plan, ms).cities.filter((city) => city.role !== "target")[0].blobs.filter((blob) => (blob.alpha ?? 1) > 0 && blob.radius > 0);
  const segmentGap = (a: Vec, b: Vec, c: Vec, d: Vec) => {
    const toSegment = (p: Vec, u: Vec, v: Vec) => {
      const lengthSq = (v.x - u.x) ** 2 + (v.y - u.y) ** 2;
      const k = lengthSq < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - u.x) * (v.x - u.x) + (p.y - u.y) * (v.y - u.y)) / lengthSq));
      return dist(p, { x: u.x + (v.x - u.x) * k, y: u.y + (v.y - u.y) * k });
    };
    return Math.min(toSegment(a, c, d), toSegment(b, c, d), toSegment(c, a, b), toSegment(d, a, b));
  };
  const segmentsOf = (points: readonly Vec[], closed: boolean) =>
    points.length === 1 ? [[points[0], points[0]]] : [...points.slice(1).map((p, k) => [points[k], p]), ...(closed && points.length >= 3 ? [[points[points.length - 1], points[0]]] : [])];

  it("never draws a neck thinner than a city: every merging outline is a city's width in every frame", () => {
    under("lpf", () => {
      const { accepted, direct } = newYork();
      for (const plan of [accepted, direct]) {
        for (let ms = 8; ms < plan.durationMs; ms += 8) {
          const bodies = drawnBodies(plan, ms);
          const width = Math.max(...bodies.map((blob) => blob.radius));
          for (const blob of bodies) expect(blob.radius).toBeGreaterThanOrEqual(width - 1e-12);
        }
      }
    });
  });

  it("joins the cities into one body before the slots the merged city adds are drawn at any strength", () => {
    under("lpf", () => {
      const { accepted: plan } = newYork();
      // A slot the merged city adds grows out of its centre; the cities' own slots are drawn at full size throughout.
      const emerging = (ms: number) => {
        const rings = frameAt(plan, ms).cities.filter((city) => city.role !== "target")[0].rings;
        const full = Math.max(...rings.map((ring) => ring.radius));
        return Math.max(0, ...rings.filter((ring) => ring.radius < 0.9 * full).map((ring) => ring.alpha));
      };
      let ms = 0;
      while (emerging(ms) < 0.25) ms += 8;
      expect(ms).toBeLessThan(plan.clock.revealStart);
      const bodies = drawnBodies(plan, ms);
      // One connected body: every drawn outline reaches the first through outlines that overlap.
      const joined = new Set<number>([0]);
      const overlaps = (i: number, k: number) =>
        segmentsOf(bodies[i].points, bodies[i].closed).some(([a, b]) =>
          segmentsOf(bodies[k].points, bodies[k].closed).some(([c, d]) => segmentGap(a, b, c, d) <= bodies[i].radius + bodies[k].radius),
        );
      for (let round = 0; round < bodies.length; round += 1) {
        bodies.forEach((_, k) => {
          if (!joined.has(k) && Array.from(joined).some((j) => overlaps(j, k))) joined.add(k);
        });
      }
      expect(joined.size).toBe(bodies.length);
    });
  });

  it("builds no rail between merging cities: New York's rails are reconfigured to the hex edges, and nothing erupts", () => {
    under("lpf", () => {
      const { accepted: plan } = newYork();
      expect(describeTransition(plan)).toMatchObject({ added: 0, removed: 0 });
      for (const track of plan.tracks) {
        expect(track.cls).toBe("reconfigured");
        expect([track.to!.from.kind, track.to!.to.kind]).toContain("edge");
      }
      for (let ms = 0; ms <= plan.durationMs; ms += 8) {
        expect(frameAt(plan, ms).tracks.every((track) => track.widthScale === undefined)).toBe(true);
      }
    });
  });

  it("leaves every city that does not merge one outline, as before", () => {
    under("plus", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const o63 = firstFacing("H10", { kind: "tile", tileId: 14, orientation: o14 }, 63);
      const plans = [
        acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14),
        acceptedPlan("H10", { kind: "tile", tileId: 63, orientation: o63 }, 513),
        acceptedPlan("E23", { kind: "printed", label: "E23" }, 592),
      ];
      for (const plan of plans) {
        for (const ms of [0, 200, 400, 600, 800, 1000, 1200, plan.durationMs]) {
          for (const city of frameAt(plan, ms).cities.filter((entry) => entry.role !== "target")) expect(city.blobs).toHaveLength(1);
        }
      }
    });
  });
});

describe("which changes play (#1465)", () => {
  it("plays a lay and an upgrade, and snaps a removal, a downgrade and a re-facing", () => {
    expect(isAnimatableChange(null, { tileId: 8, orientation: 0 })).toBe(true);
    expect(isAnimatableChange({ tileId: 8, orientation: 0 }, { tileId: 24, orientation: 0 })).toBe(true);
    expect(isAnimatableChange({ tileId: 8, orientation: 0 }, null)).toBe(false);
    expect(isAnimatableChange({ tileId: 24, orientation: 0 }, { tileId: 8, orientation: 0 })).toBe(false);
    expect(isAnimatableChange({ tileId: 8, orientation: 0 }, { tileId: 8, orientation: 3 })).toBe(false);
  });

  it("lands a legal re-pairing of track on the destination with no orphaned stroke", () => {
    /* WAS A PAIR THE RULES NO LONGER OFFER. This case used to pick a facing by `removed > 0`: the expanded board's
       filter accepted #53 on Baltimore at facings that severed the printed rail, and the flourish had to end
       cleanly anyway. Stage 9.2 made the board's own printed topology authoritative and refuses them, and the
       rules-side sweep that followed found the deeper fact: of 28,438 legal transitions across the three tables,
       1,405 re-pair track and NOT ONE deletes a source piece. A legal lay preserves, re-pairs or adds rail, so
       `removed > 0` is not a legal transition's shape at all (backlog D-19); asking the legality engine for one
       would be the wrong direction of dependency. The claim this case makes is the same one, over the strongest
       legal shape there is: a genuine re-pairing -- Baltimore's printed curve becoming #53's spokes at a facing
       that keeps its printed exits -- ends on the authoritative tile with every drawn rail the destination's.
       The renderer's own `removed` arm is exercised synthetically in the next case. */
    under("plus", () => {
      const plan = acceptedPlan("I15", { kind: "printed", label: "I15" }, 53, (candidate) => {
        const classes = describeTransition(candidate);
        return classes.reconfigured > 0 && classes.removed === 0;
      });
      expect(describeTransition(plan)).toMatchObject({ persistent: 0, reconfigured: 2, added: 1, removed: 0 });
      const end = sampleTileTransition(plan, 1);
      expect(end.tracks.every((track) => track.destTrack !== null)).toBe(true);
    });
  });

  it("resolves an unexpected pair to the destination with no orphaned stroke (synthetic, renderer-only)", () => {
    /* SYNTHETIC, RENDERER-ONLY, NOT A LAY THE GAME CAN MAKE. The plan is built by hand rather than taken from the
       placement filter: a curve replaced by a straight on the same hex deletes the curve, which no legal
       transition does (D-19's sweep: 0 of 28,438). It is here only to hold the renderer's `removed` arm to its
       promise -- handed a pair whose source rail has no counterpart, the old rail fades while the destination is
       built, and the last frame draws nothing but the destination's own rails. */
    under("standard", () => {
      const plan = planTileTransition({ from: { kind: "tile", tileId: 8, orientation: 0 }, to: { tileId: 9, orientation: 0 } })!;
      expect(describeTransition(plan)).toMatchObject({ persistent: 0, reconfigured: 0, added: 1, removed: 1 });
      const fading = frameAt(plan, plan.durationMs / 2).tracks.filter((track) => track.destTrack === null);
      expect(fading).toHaveLength(1);
      expect(fading[0].alpha).toBeGreaterThan(0);
      expect(fading[0].alpha).toBeLessThan(1);
      const end = sampleTileTransition(plan, 1);
      expect(end.tracks.every((track) => track.destTrack !== null)).toBe(true);
    });
  });
});

describe("the tile being chosen is a proposal, and the confirm builds into it (#1471)", () => {
  const polylineKey = (points: readonly Vec[]) => points.map((point) => `${point.x.toFixed(9)},${point.y.toFixed(9)}`).join(" ");
  const railKeys = (tracks: ReadonlyArray<{ points: Vec[]; destTrack: number | null }>) =>
    tracks.map((track) => `${track.destTrack}:${polylineKey(track.points)}`).sort();

  it("draws the whole destination tile at its facing, washed, and nothing of the tile beneath it", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const proposal = proposedTileFrame(14, o14)!;
      expect(proposedTileFrame(14, o14)).toBe(proposal); // one frame per facing, shared
      expect(proposedTileFrame(999999, 0)).toBeNull();
      // Every colour the tile prints, washed one amount toward one neutral; opaque (#167).
      expect(proposal.fills).toHaveLength(1);
      expect(proposal.fills[0].alpha).toBe(1);
      expect(proposal.fills[0].color).not.toBe(ERA_TILE_FILL.Green);
      expect(proposal.rim.alpha).toBe(1);
      expect(proposal.present).toEqual(expect.objectContaining({ wash: PROVISIONAL.wash, front: -REVEAL_SPAN, committedFill: ERA_TILE_FILL.Green }));
      // All of #14's rail and its two-slot city, where #14 prints them -- none of #57.
      const art = planTileTransition({ from: { kind: "tile", tileId: 14, orientation: o14 }, to: { tileId: 14, orientation: o14 } })!.toArt;
      expect(railKeys(proposal.tracks)).toEqual(railKeys(piecesOf(art).map((piece) => ({ points: piece.points, destTrack: piece.track }))));
      expect(proposal.tracks.every((track) => track.role === "static" && track.alpha === 1 && track.widthScale === undefined)).toBe(true);
      expect(proposal.cities).toHaveLength(1);
      expect(proposal.cities[0].rings.map((ring) => ring.at)).toEqual(slotCentres(art.markers[0]));
    });
  });

  it("starts a confirmed lay on the proposal, and draws only what the lay changes over it", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const plan = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 }, provisional: true })!;
      const proposal = proposedTileFrame(14, o14)!;
      const first = sampleTileTransition(plan, 0);
      // Never the old tile: the proposal's fill, rim and presentation...
      expect(first.fills).toEqual(proposal.fills);
      expect(first.rim).toEqual(proposal.rim);
      expect(first.present).toEqual(proposal.present);
      // ...its rail, as the proposal's own and planned rail...
      expect(railKeys(first.tracks.filter((track) => track.role !== undefined))).toEqual(railKeys(proposal.tracks));
      // ...and, over it, only the city that changes, as it stood.
      expect(first.tracks.filter((track) => track.role === undefined)).toEqual([]);
      const active = first.cities.filter((city) => city.role === undefined);
      expect(active).toHaveLength(1);
      expect(active[0].blobs[0].points.every((point) => dist(point, plan.fromArt.markers[0].at) < 1e-12)).toBe(true); // #57's circle
      const planned = first.cities.filter((city) => city.role === "target");
      expect(planned.map((city) => city.alpha)).toEqual([1]);
    });
  });

  it("keeps every rail in its class: persistent still, added built over its planned copy, reconfigured morphing into it", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const spokes = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 }, provisional: true })!;
      expect(describeTransition(spokes)).toMatchObject({ persistent: 2, added: 2, reconfigured: 0 });
      for (let ms = 0; ms <= spokes.durationMs; ms += 16) {
        const frame = frameAt(spokes, ms);
        // #57's rail is the proposal's own the whole way: never rebuilt, never moved.
        const own = frame.tracks.filter((track) => track.role === "static");
        expect(own.map((track) => track.points)).toEqual(spokes.tracks.filter((track) => track.cls === "persistent").map((track) => track.to!.points));
        // Each new spoke keeps its planned copy while its wave erupts over it.
        expect(frame.tracks.filter((track) => track.role === "target")).toHaveLength(2);
        if (frame.tracks.some((track) => track.widthScale !== undefined)) {
          expect(frame.tracks.filter((track) => track.widthScale !== undefined).every((track) => track.role === undefined)).toBe(true);
        }
      }
      const baltimore = acceptedPlan("I15", { kind: "printed", label: "I15" }, 53);
      const moving = planTileTransition({ from: { kind: "printed", label: "I15" }, to: { tileId: 53, orientation: baltimore.toArt.turnDeg / -60 }, provisional: true });
      expect(moving).not.toBeNull();
      expect(describeTransition(moving!)).toMatchObject({ reconfigured: 2, added: 1 });
      const midway = frameAt(moving!, 500);
      const reconfigured = moving!.tracks.filter((track) => track.cls === "reconfigured");
      for (const track of reconfigured) {
        const planned = midway.tracks.find((candidate) => candidate.role === "target" && candidate.points === track.to!.points);
        expect(planned).toBeDefined();
        // The moving rail is its own stroke, part way between the printed curve and the planned spoke.
        const drawn = midway.tracks.find((candidate) => candidate.role === undefined && candidate.destTrack === track.to!.track && candidate.points.length === track.to!.points.length);
        expect(drawn).toBeDefined();
        expect(samePolyline(drawn!.points, track.to!.points)).toBe(false);
      }
      const settled = frameAt(moving!, moving!.durationMs).tracks.filter((candidate) => candidate.role === undefined);
      for (const track of reconfigured) expect(settled.some((candidate) => samePolyline(candidate.points, track.to!.points))).toBe(true);
    });
  });

  it("never reads a 1 -> 2 split as three rings: the planned city recedes behind the one dividing", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const plan = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 }, provisional: true })!;
      for (const ms of [BEAT_MS.lead, 439, 700, 1000]) {
        const frame = frameAt(plan, ms);
        const planned = frame.cities.filter((city) => city.role === "target");
        expect(planned.map((city) => city.alpha)).toEqual([PROVISIONAL.targetCentreAlpha]);
        const dividing = frame.cities.filter((city) => city.role === undefined);
        expect(dividing).toHaveLength(1);
        expect(dividing[0].rings.length).toBeLessThanOrEqual(2);
      }
    });
  });

  it("migrates a moving city into its planned place rather than standing two cities at once", () => {
    under("standard", () => {
      const probe = acceptedPlan("I15", { kind: "printed", label: "I15" }, 53);
      const plan = planTileTransition({ from: { kind: "printed", label: "I15" }, to: { tileId: 53, orientation: probe.toArt.turnDeg / -60 }, provisional: true })!;
      const planned = plan.toArt.markers[0].at;
      let distance = Infinity;
      for (const ms of [...Array.from({ length: 38 }, (_, k) => BEAT_MS.lead + 32 * k), plan.durationMs]) {
        const frame = frameAt(plan, ms);
        // One city at full strength, and its planned place drawn faintly under it.
        expect(frame.cities.filter((city) => city.role !== "target" && city.alpha >= 1)).toHaveLength(1);
        expect(frame.cities.filter((city) => city.role === "target").map((city) => city.alpha)).toEqual([PROVISIONAL.targetCentreAlpha]);
        const city = frame.cities.find((candidate) => candidate.role === undefined)!;
        const now = dist(city.blobs[0].points[0], planned);
        expect(now).toBeLessThanOrEqual(distance + 1e-12);
        distance = now;
      }
      expect(distance).toBeLessThan(1e-9);
    });
  });

  it("commits a new lay and a same-tier replacement alike, behind one front", () => {
    under("standard", () => {
      const o8 = firstFacing("G11", { kind: "printed", label: "G11" }, 8);
      const lay = planTileTransition({ from: { kind: "printed", label: "G11" }, to: { tileId: 8, orientation: o8 }, provisional: true })!;
      expect(frameAt(lay, lay.clock.revealStart).present!.front).toBe(-REVEAL_SPAN);
      const crossing = frameAt(lay, lay.clock.revealStart + BEAT_MS.reveal / 2).present!;
      expect(crossing.front).toBeGreaterThan(-REVEAL_SPAN);
      expect(crossing.front).toBeLessThan(REVEAL_SPAN);
      expect(crossing.committedFill).toBe(ERA_TILE_FILL.Yellow);
    });
    under("lpf", () => {
      const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      const o883 = firstFacing("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      const same = planTileTransition({ from: { kind: "tile", tileId: 62, orientation: o54 }, to: { tileId: 883, orientation: o883 }, provisional: true })!;
      expect(same.fromTier).toBe(same.toTier);
      const { revealStart, end } = same.clock;
      expect(frameAt(same, revealStart).present!.front).toBe(-REVEAL_SPAN);
      expect(frameAt(same, (revealStart + end) / 2).present!.front).toBeGreaterThan(-REVEAL_SPAN);
      expect(frameAt(same, end).present!.front).toBe(REVEAL_SPAN);
    });
  });

  it("leans the front so the commit sweeps left to right and top to bottom, and crosses the whole hex in its 240 ms (#1473)", () => {
    // Its top ahead of its bottom, 15 to 25 degrees off vertical: a little, not a wipe.
    expect(REVEAL_SLANT).toBeLessThan(0);
    const degrees = (Math.abs(Math.atan(REVEAL_SLANT)) * 180) / Math.PI;
    expect(degrees).toBeGreaterThanOrEqual(15);
    expect(degrees).toBeLessThanOrEqual(25);
    // West of the leaning line is committed: the line stands `REVEAL_SLANT` further east for every unit down.
    const committedAt = (point: Vec, reveal: number) => point.x < revealFront(reveal) + point.y * REVEAL_SLANT;
    const firstCommitted = (point: Vec) => {
      let reveal = 0;
      while (!committedAt(point, reveal)) reveal += 0.001;
      return reveal;
    };
    const corners = [0, 1, 2, 3, 4, 5].map((k) => ({ x: Math.cos((Math.PI / 3) * k - Math.PI / 2), y: Math.sin((Math.PI / 3) * k - Math.PI / 2) }));
    // Nothing on the hex is committed before the front starts, and everything is once it has crossed.
    for (const corner of corners) {
      expect(committedAt(corner, 0)).toBe(false);
      expect(committedAt(corner, 1)).toBe(true);
    }
    const top = corners[0];
    const bottom = corners[3];
    expect(top.y).toBeLessThan(bottom.y);
    expect(firstCommitted(top)).toBeLessThan(firstCommitted(bottom)); // top to bottom
    expect(firstCommitted({ x: -0.5, y: 0 })).toBeLessThan(firstCommitted({ x: 0.5, y: 0 })); // left to right
  });

  it("shows a lay nobody proposed here its proposal first: the old tile, then the proposal over the lead", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const plan = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 } })!;
      expect(plan.provisional).toBe(false);
      const first = sampleTileTransition(plan, 0);
      expect(first.present!.wash).toBe(0);
      expect(first.tracks.some((track) => track.role === "target")).toBe(false);
      expect(first.cities.some((city) => city.role === "target")).toBe(false);
      const proposed = frameAt(plan, BEAT_MS.lead + 1);
      expect(proposed.present!.wash).toBe(PROVISIONAL.wash);
      expect(proposed.tracks.filter((track) => track.role === "target").every((track) => track.alpha === 1)).toBe(true);
      expect(proposed.cities.filter((city) => city.role === "target").map((city) => city.alpha)).toEqual([PROVISIONAL.targetCentreAlpha]);
    });
  });

  it("fades a confirmed proposal to committed under reduced motion, moving nothing and sweeping nothing", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const plan = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 }, provisional: true, reducedMotion: true })!;
      let wash = Infinity;
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const frame = sampleTileTransition(plan, t);
        expect(frame.present!.front).toBe(-REVEAL_SPAN);
        expect(frame.present!.wash).toBeLessThanOrEqual(wash);
        wash = frame.present!.wash;
        expect(railKeys(frame.tracks)).toEqual(railKeys(proposedTileFrame(14, o14)!.tracks));
      }
      expect(sampleTileTransition(plan, 0).present!.wash).toBe(PROVISIONAL.wash);
      expect(wash).toBe(0);
      expect(sampleTileTransition(plan, 1).fills).toEqual([{ color: ERA_TILE_FILL.Green, alpha: 1 }]);
    });
  });

  it("prints a proposal's value washed, and commits it with its tile", () => {
    under("standard", () => {
      expect(PROPOSED_BADGE).toEqual({ outgoingAlpha: 0, provisionalAlpha: PROVISIONAL.badgeAlpha, front: -REVEAL_SPAN });
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const plan = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 }, provisional: true })!;
      expect(badgePresentationAt(plan, 0)).toEqual(PROPOSED_BADGE);
      expect(badgePresentationAt(plan, 1)).toEqual({ outgoingAlpha: 0, provisionalAlpha: PROVISIONAL.badgeAlpha, front: REVEAL_SPAN });
      const t = (plan.clock.revealStart + BEAT_MS.reveal / 2) / plan.durationMs;
      expect(badgePresentationAt(plan, t).front).toBe(sampleTileTransition(plan, t).present!.front);
      const unproposed = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 } })!;
      expect(badgePresentationAt(unproposed, 0)).toEqual({ outgoingAlpha: 1, provisionalAlpha: 0, front: -REVEAL_SPAN });
    });
  });
});

describe("the existing railroad moves first, and new rail grows out of it (#1475)", () => {
  /** The furthest any reconfigured piece's own points travel -- the morph the frame draws, point for point. */
  const reconfiguredMove = (plan: Plan) =>
    Math.max(
      0,
      ...plan.tracks
        .filter((track) => track.cls === "reconfigured" && track.from && track.to)
        .map((track) => Math.max(...track.to!.points.map((point, k) => dist(point, track.from!.points[k])))),
    );
  /** How far the long settle has carried the existing geometry at `ms` -- what the migration and the morph are drawn on. */
  const reconfigurationAt = (plan: Plan, ms: number) => transitionEasings(plan, ms / plan.durationMs).geometry;
  /** Where the first city's body stands at `ms`, from the frame itself. */
  const cityAt = (plan: Plan, ms: number) => {
    const points = frameAt(plan, ms).cities[0].blobs.flatMap((blob) => blob.points);
    return points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
  };
  const baltimore = () => acceptedPlan("I15", { kind: "printed", label: "I15" }, 53);

  it("holds a B-style upgrade's new rail until its reconfiguration has established itself", () => {
    under("standard", () => {
      const plan = baltimore();
      expect(describeTransition(plan)).toMatchObject({ reconfigured: 2, added: 1 });
      expect(describeTransition(plan).cities[0]).toMatchObject({ event: "migrate", migrates: true });
      expect(plan.components).toMatchObject({ construction: true, trackWork: true, reconfiguration: true });
      // Railroad work starts where the existing geometry starts: the table's own geometry window.
      expect(plan.beats.railroadWorkStart).toBe(spanMs(TIMELINE.geometry[0]));
      const construction = plan.beats.constructionStart as number;
      // A head start the eye has time to read -- longer than the commit's own sweep -- and no longer than it needs.
      expect(construction - (plan.beats.railroadWorkStart as number)).toBeGreaterThan(BEAT_MS.reveal);
      expect(construction).toBeLessThan(plan.clock.revealStart / 2);
      // ESTABLISHED, NOT FINISHED: a quarter of the settle travelled when the first rail erupts.
      expect(reconfigurationAt(plan, construction)).toBeCloseTo(RECONFIGURE_ESTABLISHED, 2);
    });
  });

  it("keeps the reconfiguration and the construction overlapping, never one after the other", () => {
    under("standard", () => {
      const plan = baltimore();
      const construction = plan.beats.constructionStart as number;
      const settled = Math.max(...plan.tracks.filter((track) => track.cls === "added").map((track) => track.startMs + track.durationMs));
      // Three quarters of the movement is still to come when building starts, and the city is still short of its place.
      expect(reconfigurationAt(plan, construction)).toBeLessThan(0.5);
      const travel = dist(cityAt(plan, 0), cityAt(plan, plan.durationMs));
      expect(dist(cityAt(plan, construction), cityAt(plan, plan.durationMs))).toBeGreaterThan(travel / 2);
      // The rail is still being built while the city is most of the way through its move, and settles before the commit.
      expect(reconfigurationAt(plan, settled)).toBeGreaterThan(0.8);
      expect(settled).toBeLessThanOrEqual(plan.clock.revealStart);
      // And the transition is no longer for it: the full sequence, as before.
      expect(plan.durationMs).toBe(TILE_TRANSITION_MS);
    });
  });

  it("makes an ordinary lay wait for nothing: the table's own construction start, and its own length", () => {
    under("standard", () => {
      // Rail out of a city that stands still, and rail out of an edge: unchanged, both of them.
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const split = acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const o8 = firstFacing("G11", { kind: "printed", label: "G11" }, 8);
      const plain = acceptedPlan("G11", { kind: "tile", tileId: 8, orientation: o8 }, 24);
      for (const plan of [split, plain]) {
        expect(plan.components.reconfiguration).toBe(false);
        expect(plan.beats.constructionStart).toBe(spanMs(TIMELINE.construct[0]));
        expect(plan.beats.railroadWorkStart).toBe(plan.beats.constructionStart);
      }
      expect(split.durationMs).toBe(TILE_TRANSITION_MS);
      expect(plain.durationMs).toBe(plain.clock.revealStart + BEAT_MS.reveal);
      // A city re-laid in its own place moves nothing, whatever its event is called, and stages nothing.
      const relaid = acceptedPlan("E19", { kind: "tile", tileId: 14, orientation: 0 }, 63);
      expect(describeTransition(relaid).cities[0]).toMatchObject({ event: "reshape" });
      expect(relaid.components.reconfiguration).toBe(false);
      expect(relaid.beats.constructionStart).toBe(spanMs(TIMELINE.construct[0]));
    });
  });

  it("stages a moved city that brought no rail with it, and still builds out of it", () => {
    under("standard", () => {
      // The printed OO circles carry no track: what reconfigures is the cities, and the spurs are the railroad work.
      const oo = acceptedPlan("E11", { kind: "printed", label: "E11" }, 59);
      expect(describeTransition(oo)).toMatchObject({ reconfigured: 0, added: 2 });
      expect(oo.components).toMatchObject({ trackWork: false, reconfiguration: true });
      expect(oo.beats.constructionStart).toBeGreaterThan(spanMs(TIMELINE.construct[0]));
      expect(oo.beats.railroadWorkStart).toBe(oo.beats.constructionStart);
      expect(oo.durationMs).toBe(TILE_TRANSITION_MS);
    });
  });

  it("counts a rail that reforms, and not one that is redrawn where it lay", () => {
    under("standard", () => {
      const o59 = firstFacing("E11", { kind: "printed", label: "E11" }, 59);
      const brownFacings = [67, 68].flatMap((brown) =>
        acceptedFacings("E11", { kind: "tile", tileId: 59, orientation: o59 }, brown).map((orientation) =>
          planTileTransition({ from: { kind: "tile", tileId: 59, orientation: o59 }, to: { tileId: brown, orientation } }),
        ),
      );
      const reconfiguring = brownFacings.filter((plan): plan is Plan => plan !== null && describeTransition(plan).reconfigured > 0);
      expect(reconfiguring.length).toBeGreaterThan(1);
      // One threshold, and it is the rail's own width: half of it is a reform, less is the same rail redrawn.
      for (const plan of reconfiguring) {
        expect(plan.components.trackWork).toBe(reconfiguredMove(plan) >= CONSTRUCTION_WAVE.portion / 2);
      }
      // Both readings occur among these facings, so the case is testing the threshold and not one side of it.
      expect(new Set(reconfiguring.map((plan) => plan.components.trackWork))).toEqual(new Set([true, false]));
    });
  });
});

describe("three sounds, each on the beat it names (#1474, #1475)", () => {
  type Cues = ReturnType<typeof tileTransitionCues>;
  const names = (plan: Plan) => tileTransitionCues(plan).map((entry) => entry.cue);
  /** Everything a frame loop sounds, frame by frame, asking `asks` times per frame -- a repaint, a replayed effect. */
  const heardThrough = (cues: Cues, endMs: number, stepMs = 16, asks = 3) => {
    const heard: Array<{ cue: string; frameMs: number }> = [];
    let dealt = 0;
    for (let ms = 0; ms <= endMs + stepMs; ms += stepMs) {
      for (let ask = 0; ask < asks; ask += 1) {
        const reached = cuesReached(cues, dealt, ms);
        dealt = reached.dealt;
        reached.due.forEach((cue) => heard.push({ cue, frameMs: ms }));
      }
    }
    return heard;
  };
  const h10Split = () => {
    const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
    return acceptedPlan("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
  };

  it("names its three clips once, with their owner", () => {
    expect(TILE_TRANSITION_SFX).toEqual({ track: "track.mp3", mutation: "mutation.mp3", upgrade: "upgrade.mp3" });
  });

  it("sounds railroad work once, at railroadWorkStart -- building, or existing rail reforming (#1475)", () => {
    under("standard", () => {
      // An ordinary lay: the work is the eruption, where the cue always was.
      const split = h10Split();
      expect(describeTransition(split).added).toBe(2);
      expect(tileTransitionCues(split).filter((entry) => entry.cue === "track")).toEqual([{ cue: "track", at: split.beats.constructionStart }]);
      // Four rails out of two towns: one cue.
      const towns = acceptedPlan("F20", { kind: "printed", label: "F20" }, 1);
      expect(describeTransition(towns).added).toBe(4);
      expect(names(towns)).toEqual(["track", "upgrade"]);
      /* A B-style upgrade: the work starts as the existing track begins to reform, and the eruption that follows it
         adds no second cue. */
      const baltimore = acceptedPlan("I15", { kind: "printed", label: "I15" }, 53);
      expect(names(baltimore)).toEqual(["track", "upgrade"]);
      expect(tileTransitionCues(baltimore).filter((entry) => entry.cue === "track")).toEqual([
        { cue: "track", at: baltimore.beats.railroadWorkStart },
      ]);
      expect(baltimore.beats.railroadWorkStart).toBeLessThan(baltimore.beats.constructionStart as number);
    });
    under("lpf", () => {
      const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      // Persistent rail only: #54 -> #62 builds nothing and reforms nothing.
      const persistent = acceptedPlan("G19", { kind: "tile", tileId: 54, orientation: o54 }, 62);
      expect(describeTransition(persistent)).toMatchObject({ added: 0, persistent: 4 });
      expect(persistent.components).toMatchObject({ construction: false, trackWork: false });
      expect(persistent.beats.railroadWorkStart).toBeNull();
      expect(names(persistent)).not.toContain("track");
      /* New York's merge builds nothing, and its four rails reform 0.5 of the hex into the merged city: railroad
         work, by the same question asked of every transition (#1475). */
      const merge = acceptedPlan("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      expect(describeTransition(merge)).toMatchObject({ added: 0, reconfigured: 4 });
      expect(merge.components).toMatchObject({ construction: false, trackWork: true });
      expect(names(merge)).toEqual(["track", "mutation", "upgrade"]);
      expect(merge.beats.railroadWorkStart).toBe(spanMs(TIMELINE.geometry[0]));
      const o883 = firstFacing("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      const brief = planTileTransition({ from: { kind: "tile", tileId: 62, orientation: o54 }, to: { tileId: 883, orientation: o883 } })!;
      expect(names(brief)).toEqual(["track", "upgrade"]);
      // Two towns fusing: every rail reconfigured -- the track cue, and no gloop for two urban markers meeting.
      const facing = firstFacing("G7", { kind: "printed", label: "G7" }, 1);
      const fuse = acceptedPlan("G7", { kind: "tile", tileId: 1, orientation: facing }, 88);
      expect(describeTransition(fuse)).toMatchObject({ added: 0, reconfigured: 4 });
      expect(names(fuse)).toEqual(["track", "upgrade"]);
      expect(fuse.beats.railroadWorkStart).toBe(spanMs(TIMELINE.geometry[0]));
    });
  });

  it("does not call a station's own change, a token's ride or the commit railroad work (#1475)", () => {
    under("plus", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const o63 = firstFacing("H10", { kind: "tile", tileId: 14, orientation: o14 }, 63);
      // A city gaining a slot on rail that does not move: the mutation and the commit, and no track.
      const gained = acceptedPlan("H10", { kind: "tile", tileId: 63, orientation: o63 }, 513);
      expect(describeTransition(gained)).toMatchObject({ added: 0, reconfigured: 0, removed: 0 });
      expect(gained.components).toMatchObject({ stationMutation: true, trackWork: false, reconfiguration: false });
      expect(gained.beats.railroadWorkStart).toBeNull();
      expect(names(gained)).toEqual(["mutation", "upgrade"]);
    });
    under("lpf", () => {
      // A city re-laid where it stood, its slots the same: the commit alone.
      const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      const persistent = acceptedPlan("G19", { kind: "tile", tileId: 54, orientation: o54 }, 62);
      expect(persistent.components.reconfiguration).toBe(false);
    });
  });

  it("sounds a station mutation at stationEmergence for a 1 -> 2 split and a 2 -> 3 gained slot, and never for a migration or a re-laid city", () => {
    under("standard", () => {
      const split = h10Split();
      expect(tileTransitionCues(split).filter((entry) => entry.cue === "mutation")).toEqual([{ cue: "mutation", at: split.beats.stationEmergence }]);
      const baltimore = acceptedPlan("I15", { kind: "printed", label: "I15" }, 53);
      expect(describeTransition(baltimore).cities.map((city) => city.event)).toContain("migrate");
      expect(names(baltimore)).not.toContain("mutation");
      const relaid = acceptedPlan("E19", { kind: "tile", tileId: 14, orientation: 0 }, 63);
      expect(describeTransition(relaid).cities[0]).toMatchObject({ event: "reshape", fromSlots: [2], toSlots: 2 });
      expect(names(relaid)).not.toContain("mutation");
    });
    under("plus", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const o63 = firstFacing("H10", { kind: "tile", tileId: 14, orientation: o14 }, 63);
      const gained = acceptedPlan("H10", { kind: "tile", tileId: 63, orientation: o63 }, 513);
      expect(tileTransitionCues(gained)).toEqual([
        { cue: "mutation", at: gained.beats.stationEmergence },
        { cue: "upgrade", at: gained.beats.revealStart },
      ]);
      // A city losing a slot is a station mutation with no emergence, and the plan names no other moment for it: silent.
      const lost = acceptedPlan("E23", { kind: "tile", tileId: 592, orientation: 1 }, 61);
      expect(describeTransition(lost).cities[0]).toMatchObject({ event: "capacity", fromSlots: [2], toSlots: 1 });
      expect(lost.components.stationMutation).toBe(true);
      expect(lost.beats.stationEmergence).toBeNull();
      expect(names(lost)).not.toContain("mutation");
    });
    under("lpf", () => {
      /* A merge that gains slots carries its emergence; one that only brings its slots together does not. Both
         reform their rails, so both sound the railroad work first (#1475) -- the mutation is the station's alone. */
      const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      const merge = acceptedPlan("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      expect(names(merge)).toEqual(["track", "mutation", "upgrade"]);
      expect(tileTransitionCues(merge).filter((entry) => entry.cue === "mutation")).toEqual([
        { cue: "mutation", at: merge.beats.stationEmergence },
      ]);
      const o883 = firstFacing("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      const brief = planTileTransition({ from: { kind: "tile", tileId: 62, orientation: o54 }, to: { tileId: 883, orientation: o883 } })!;
      expect(names(brief)).toEqual(["track", "upgrade"]);
      expect(names(brief)).not.toContain("mutation");
    });
  });

  it("sounds the commit at revealStart on every kind of lay, and a commit alone sounds nothing else", () => {
    under("standard", () => {
      const o8 = firstFacing("G11", { kind: "printed", label: "G11" }, 8);
      const lay = planTileTransition({ from: { kind: "printed", label: "G11" }, to: { tileId: 8, orientation: o8 } })!;
      const railAlone = acceptedPlan("B12", { kind: "tile", tileId: 7, orientation: 2 }, 26, (candidate) => candidate.toArt.turnDeg === -180);
      for (const plan of [lay, railAlone, h10Split()]) {
        const cues = tileTransitionCues(plan);
        expect(cues[cues.length - 1]).toEqual({ cue: "upgrade", at: plan.beats.revealStart });
        expect(cues.filter((entry) => entry.cue === "upgrade")).toHaveLength(1);
      }
    });
    under("plus", () => {
      const commit = acceptedPlan("B20", { kind: "tile", tileId: 88, orientation: 2 }, 145);
      expect(tileTransitionCues(commit)).toEqual([{ cue: "upgrade", at: commit.beats.revealStart }]);
    });
    under("lpf", () => {
      // A same-tier replacement commits behind the same front; its reforming rail sounds first (#1475).
      const o54 = firstFacing("G19", { kind: "printed", label: "G19" }, 54);
      const o883 = firstFacing("G19", { kind: "tile", tileId: 54, orientation: o54 }, 883);
      const same = planTileTransition({ from: { kind: "tile", tileId: 62, orientation: o54 }, to: { tileId: 883, orientation: o883 } })!;
      expect(same.fromTier).toBe(same.toTier);
      expect(tileTransitionCues(same)).toEqual([
        { cue: "track", at: same.beats.railroadWorkStart },
        { cue: "upgrade", at: same.beats.revealStart },
      ]);
    });
  });

  it("sounds a full transition's cues once each, in the order their beats fall, however often a frame loop asks", () => {
    under("standard", () => {
      const plan = h10Split();
      const cues = tileTransitionCues(plan);
      expect(cues).toEqual([
        { cue: "track", at: plan.beats.constructionStart },
        { cue: "mutation", at: plan.beats.stationEmergence },
        { cue: "upgrade", at: plan.beats.revealStart },
      ]);
      const heard = heardThrough(cues, plan.durationMs);
      expect(heard.map((entry) => entry.cue)).toEqual(["track", "mutation", "upgrade"]);
      // Each on the first frame at or past its own beat.
      heard.forEach((entry, k) => {
        expect(entry.frameMs).toBeGreaterThanOrEqual(cues[k].at);
        expect(entry.frameMs - cues[k].at).toBeLessThan(16);
      });
      // Nothing before the first beat; a playhead held past a beat, or sent back before it, never deals it again.
      expect(cuesReached(cues, 0, cues[0].at - 1)).toEqual({ due: [], dealt: 0 });
      const first = cuesReached(cues, 0, cues[1].at);
      expect(first).toEqual({ due: ["track", "mutation"], dealt: 2 });
      expect(cuesReached(cues, first.dealt, cues[1].at).due).toEqual([]);
      expect(cuesReached(cues, first.dealt, 0).due).toEqual([]);
      // A frame arriving late deals everything it reached at once, in order, and a count past the end deals nothing.
      expect(cuesReached(cues, 0, plan.durationMs * 4)).toEqual({ due: ["track", "mutation", "upgrade"], dealt: 3 });
      expect(cuesReached(cues, 3, plan.durationMs * 4)).toEqual({ due: [], dealt: 3 });
    });
  });

  it("gives a confirmed proposal and a lay nobody proposed here the same cues: the proposal is a picture, not a beat", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      const lay = { from: { kind: "tile" as const, tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 } };
      expect(tileTransitionCues(planTileTransition({ ...lay, provisional: true })!)).toEqual(tileTransitionCues(planTileTransition(lay)!));
    });
  });

  it("under reduced motion sounds only the commit, from its first frame: nothing is built or split to hear", () => {
    under("standard", () => {
      const o57 = firstFacing("H10", { kind: "printed", label: "H10" }, 57);
      const o14 = firstFacing("H10", { kind: "tile", tileId: 57, orientation: o57 }, 14);
      for (const provisional of [false, true]) {
        const plan = planTileTransition({ from: { kind: "tile", tileId: 57, orientation: o57 }, to: { tileId: 14, orientation: o14 }, reducedMotion: true, provisional })!;
        expect(tileTransitionCues(plan)).toEqual([{ cue: "upgrade", at: 0 }]);
        expect(heardThrough(tileTransitionCues(plan), plan.durationMs)).toEqual([{ cue: "upgrade", frameMs: 0 }]);
      }
    });
  });
});
