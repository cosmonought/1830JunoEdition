// frontend/src/utils/offboardTerminality.test.ts
//
// ==================================================================
//  DESIGN NOTE 484 (harness): A RED AREA IS A WALL, NOT A DOORWAY
// ==================================================================
//
// The reported bug: the network calculator treats red off-board areas as
// traversable, so a network that enters one is granted legal tile placement
// on every other hex touching it.
//
// THE SHAPE OF THE BUG IS A WORMHOLE, and that is what makes it worse than
// the crossover bug `trackContinuity.test.ts` covers. A crossover reports
// reach across track that exists but is not joined. A red off-board hex
// reports reach across track no train may ever run on, joining two networks
// that 1830 says are separate -- so a corporation could be offered a build
// in Ontario because its rail reached Chicago from Indiana.
//
// EVERY EXPECTATION THAT MATTERS IS A NEGATIVE ONE. The old walk got the
// positive half right: it reached the red hex, and it should. What it also
// did was keep going. So the assertions below are mostly "not a port", "not
// reached", "not a candidate", plus the one positive that stops them being
// vacuous -- the far hexes would take a tile perfectly happily, and only
// connectivity keeps them out.
//
// THE COORDINATES ARE DERIVED, NOT TYPED, for the reason the sibling
// harness gives: a hardcoded triple starts failing when board data is edited
// for unrelated reasons. The property under test is about what a red zone
// is, not about Chicago specifically -- so the test finds a red hex with the
// junction shape rather than naming one, and asserts across ALL of them.

import {
  HEX_NEIGHBOR_OFFSETS,
  evaluateHexForTileLaying,
  liveEdgesForHex,
} from "../components/hexGeometry";
import { OFFBOARD_TRACKS, STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { MapGridResponse, MapTileEntry } from "../components/hexContractTypes";
import { hexKey, layableHexes, portKey, reachableTrack } from "./trackReach";
import {
  isOffboardTerminal,
  segmentsTouchingEdge,
  traversalSegments,
  traversalsFrom,
} from "./trackSegments";

const BOARD = new Set(STATIC_BOARD_HEXES.map((hex) => hexKey(hex.q, hex.r)));
const BARE: MapGridResponse = { game_id: 1, tiles: [] };

function neighbour(q: number, r: number, edge: number): { q: number; r: number } {
  const [dq, dr] = HEX_NEIGHBOR_OFFSETS[edge];
  return { q: q + dq, r: r + dr };
}

function tile(q: number, r: number, tileId: number, orientation: number): MapTileEntry {
  // `landmark` is required on the contract shape and irrelevant here. Spelled
  // out rather than cast, for the reason the sibling harness records: Jest
  // compiles through Babel and would not notice it missing.
  return { q, r, tile_id: tileId, orientation, landmark: null };
}

/** The red hexes that are actually capable of the reported bug: two or more
 *  printed stubs, each pointing at a real board hex that could take a tile.
 *  A red hex with one stub is a dead end already and proves nothing. */
interface RedJunction {
  label: string;
  q: number;
  r: number;
  /** The stub edges of the red hex, in board-edge terms. */
  stubs: number[];
  /** Neighbours across those stubs, same order. */
  arms: Array<{ q: number; r: number }>;
}

const RED_JUNCTIONS: RedJunction[] = STATIC_BOARD_HEXES.filter(
  (hex) => hex.type === "RedOffboard",
)
  .map((hex) => {
    const stubs = [...(OFFBOARD_TRACKS[hex.label] ?? [])].filter((edge) => {
      const n = neighbour(hex.q, hex.r, edge);
      return BOARD.has(hexKey(n.q, n.r)) && evaluateHexForTileLaying(n.q, n.r, BARE).eligible;
    });
    return {
      label: hex.label,
      q: hex.q,
      r: hex.r,
      stubs,
      arms: stubs.map((edge) => neighbour(hex.q, hex.r, edge)),
    };
  })
  .filter((entry) => entry.stubs.length >= 2);

/** Tile #9 is a plain straight. Rather than assume how `orientation` maps to
 *  edges -- the sort of assumption that makes a green test meaningless -- the
 *  orientation is SEARCHED for: lay it, ask `liveEdgesForHex` what came out,
 *  keep the rotation whose live edges actually include the one facing the red
 *  hex. Returns `null` when no rotation does, so a caller can skip rather
 *  than assert against a board it failed to build. */
function straightFacing(q: number, r: number, edge: number): MapTileEntry | null {
  for (let orientation = 0; orientation < 6; orientation += 1) {
    const candidate = tile(q, r, 9, orientation);
    const grid: MapGridResponse = { game_id: 1, tiles: [candidate] };
    if (liveEdgesForHex(grid, q, r).includes(edge)) return candidate;
  }
  return null;
}

describe("the red off-board hexes themselves", () => {
  it("finds at least one red zone with the junction shape", () => {
    // If this ever hits zero the whole file silently stops testing anything.
    expect(RED_JUNCTIONS.length).toBeGreaterThan(0);
  });

  it("classifies every RedOffboard board hex as terminal", () => {
    for (const hex of STATIC_BOARD_HEXES) {
      expect(isOffboardTerminal(hex.q, hex.r)).toBe(hex.type === "RedOffboard");
    }
  });

  it("offers no traversal between any pair of its printed stubs", () => {
    // The fix, at the primitive. Stated over every pair rather than the one
    // the walk happens to use, because `routeAutoTrace` asks different pairs.
    for (const red of RED_JUNCTIONS) {
      const grid: MapGridResponse = { game_id: 1, tiles: [] };
      for (const entry of red.stubs) {
        for (const exit of red.stubs) {
          if (entry === exit) continue;
          expect(traversalSegments(grid, red.q, red.r, entry, exit)).toBeNull();
        }
        expect(traversalsFrom(grid, red.q, red.r, entry)).toEqual([]);
      }
    }
  });

  it("still reports an occupied segment for a train that STOPS there", () => {
    /* Terminal is not the same as absent. A route ending in a red zone
       occupies rail there, and `routeAutoTrace`'s duplicate-track rule needs
       an identity for it -- if this returned nothing, two trains could both
       claim the same terminus for free. */
    for (const red of RED_JUNCTIONS) {
      const grid: MapGridResponse = { game_id: 1, tiles: [] };
      for (const entry of red.stubs) {
        expect(segmentsTouchingEdge(grid, red.q, red.r, entry).length).toBeGreaterThan(0);
      }
    }
  });

  it("can never be built on, so it is never a lay target", () => {
    for (const red of RED_JUNCTIONS) {
      expect(evaluateHexForTileLaying(red.q, red.r, BARE).eligible).toBe(false);
    }
  });
});

describe("a network that runs into a red off-board area", () => {
  for (const red of RED_JUNCTIONS) {
    describe(`${red.label}`, () => {
      /** The arm the corporation actually builds from. */
      const NEAR = red.arms[0];
      /** Every other hex touching the same red zone -- the far side of the
       *  wormhole, and the whole point of the exercise. */
      const FAR = red.arms.slice(1);
      /** `NEAR`'s edge facing the red hex is the opposite of the red hex's
       *  own stub edge. */
      const facing = (red.stubs[0] + 3) % 6;
      const laid = straightFacing(NEAR.q, NEAR.r, facing);

      if (!laid) {
        it.skip(`no #9 rotation reaches ${red.label} from its first arm`, () => undefined);
        return;
      }

      const GRID: MapGridResponse = { game_id: 1, tiles: [laid] };
      const TOKENS: ReadonlyArray<readonly [number, number]> = [[NEAR.q, NEAR.r]];
      const { hexes, ports } = reachableTrack(GRID, TOKENS);
      const result = layableHexes({ mapGrid: GRID, stationHexes: TOKENS });

      it("reaches the red area itself", () => {
        // The positive half, which the buggy walk also got right. A red zone
        // IS a destination -- terminality is about passing through, not
        // about arriving.
        expect(hexes.has(hexKey(NEAR.q, NEAR.r))).toBe(true);
        expect(hexes.has(hexKey(red.q, red.r))).toBe(true);
      });

      it("records NO port on the red area", () => {
        // A port means "the corporation's track can leave here". Nothing
        // leaves a terminus, so the red hex contributes none at all -- which
        // is what starves the extension step below.
        for (let edge = 0; edge < 6; edge += 1) {
          expect(ports.has(portKey(red.q, red.r, edge))).toBe(false);
        }
      });

      it("does NOT reach the hexes on the far side of it", () => {
        // THE BUG, stated as the thing that must not happen.
        for (const far of FAR) {
          expect(hexes.has(hexKey(far.q, far.r))).toBe(false);
        }
      });

      it("does NOT offer tile lays on the far side of it", () => {
        expect(result.unconstrained).toBe(false);
        for (const far of FAR) {
          expect(result.hexes.has(hexKey(far.q, far.r))).toBe(false);
        }
      });

      it("excludes them for CONNECTIVITY, not because they are unbuildable", () => {
        /* The assertion that stops the one above being vacuous. Every far arm
           would take a tile happily; the only thing keeping it out of the set
           is that no train can cross the red zone to get there. Against the
           old fallback all of them were offered. */
        for (const far of FAR) {
          expect(evaluateHexForTileLaying(far.q, far.r, GRID).eligible).toBe(true);
          expect(result.hexes.has(hexKey(far.q, far.r))).toBe(false);
        }
      });

      it("never offers the red hex itself as a lay target", () => {
        expect(result.hexes.has(hexKey(red.q, red.r))).toBe(false);
      });

      it("keeps the walk and the veil agreeing about where the network ends", () => {
        // Two halves of one picture (design note #4). A fix applied to one
        // and not the other is how they drift.
        expect(Array.from(result.network).sort()).toEqual(Array.from(hexes).sort());
        expect(Array.from(result.ports).sort()).toEqual(Array.from(ports).sort());
      });
    });
  }
});
