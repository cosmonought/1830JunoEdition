// frontend/src/components/tileNumbering.test.ts
//
// ==================================================================
//  DESIGN NOTE 709 (harness): OUR TILE IDS ARE THE CANONICAL IDS
// ==================================================================
//
// REQUESTED: "make sure that the tile it's on is the correct one: we went back and forth on the tile manifest
// for a while, and I believe there shouldn't be any mismatch between our tile numbering and the canonical
// numbering."
//
// The prompt was a debug string claiming the yellow OO hexes require "DoubleCityHub artwork (tile 15, the real
// 1830 tile 59)" -- an equivalence between OUR 15 and CANONICAL 59, which would mean a renumbering. It is not
// one. Tile 15 in this catalog is the green MajorCityHub: ONE city, four connections, revenue 30 -- exactly
// the "ordinary MajorCityHub" the same sentence says is rejected on those hexes. The string was stale, not the
// manifest.
//
// WHAT THIS FILE PINS is the claim itself, because a stale sentence was the only thing that ever suggested
// otherwise and there was nothing to check it against.
//
// TWO KINDS OF ASSERTION, and the difference matters:
//
//   ASKED, not asserted -- the OO upgrade. `filterSandboxPlacements` is run for real, on the real board, and
//   the answer compared against 59. Nothing here restates the rule; the engine is the witness, so this cannot
//   drift from what a player actually gets offered.
//
//   A STATED TABLE -- the canonical shapes. There is no machine-readable rulebook in this repo, so the
//   canonical column below is a HUMAN CLAIM written down where it can be argued with, which is the honest
//   status of it. Every row is a tile whose identity in the standard numbering is unambiguous, and each is
//   checked against the two independent places this codebase describes a tile: `TILE_CATALOG` (colour, terrain
//   archetype, revenue) and `TILE_GRAPHICS_CATALOG` (the drawn markers). Those two agreeing on a wrong number
//   is possible; both drifting from canon without this failing is not.

import { TILE_CATALOG_BY_ID } from "./hexTileCatalog";
import { tileCitySlotCounts } from "./TileGraphics";
import { filterSandboxPlacements } from "./sandboxTileLegality";
import { STATIC_BOARD_HEXES, YELLOW_OO_HEXES } from "./hexBoardData";
import { TILE_CATALOG } from "./hexTileCatalog";
import type { MapGridResponse } from "./hexContractTypes";

describe("the preprinted double cities upgrade to 59, as the engine says", () => {
  /** Every tile at every facing, so the filter is choosing rather than being handed an answer. */
  const everyPlacement = TILE_CATALOG.flatMap((entry) =>
    [0, 1, 2, 3, 4, 5].map((orientation) => ({ tile_id: entry.tileId, orientation })),
  );
  const emptyBoard = { tiles: [] } as unknown as MapGridResponse;

  function legalOn(label: string, era: "Yellow" | "Green" | "Brown"): number[] {
    const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
    if (!hex) throw new Error(`${label} is not on the board`);
    const allowed = filterSandboxPlacements(everyPlacement, {
      mapGrid: emptyBoard,
      q: hex.q,
      r: hex.r,
      era,
      networkHexes: new Set([`${hex.q},${hex.r}`]),
    } as never);
    return Array.from(new Set(allowed.map((entry) => entry.tile_id))).sort((a, b) => a - b);
  }

  it("offers exactly tile 59 on every OO hex", () => {
    /* THE ANSWER THE STALE STRING GOT WRONG. Four hexes, and not one of them will take tile 15. */
    for (const label of Array.from(YELLOW_OO_HEXES)) {
      expect(legalOn(label, "Green")).toEqual([59]);
    }
  });

  it("never offers the green MajorCityHub there", () => {
    // Stated separately because it is the specific confusion #709 came from.
    for (const label of Array.from(YELLOW_OO_HEXES)) {
      for (const era of ["Yellow", "Green", "Brown"] as const) {
        expect(legalOn(label, era)).not.toContain(15);
        expect(legalOn(label, era)).not.toContain(14);
      }
    }
  });

  it("offers nothing at all in the yellow era", () => {
    /* These hexes are PREPRINTED yellow, so there is no yellow lay to make on them -- which is why the
       designation now says "upgrades to tile 59" rather than describing a placement rule. */
    for (const label of Array.from(YELLOW_OO_HEXES)) {
      expect(legalOn(label, "Yellow")).toEqual([]);
    }
  });
});

/** The canonical claim, written where it can be argued with. `cities`/`towns` are the drawn markers; `slots`
 *  is the per-city station count, `null` where the tile has no city. */
const CANONICAL: readonly {
  id: number;
  color: "Yellow" | "Green" | "Brown";
  cities: number;
  slots: readonly number[];
}[] = [
  // Yellow: the two double-town tiles, the three single cities, the plain track.
  { id: 1, color: "Yellow", cities: 0, slots: [] },
  { id: 2, color: "Yellow", cities: 0, slots: [] },
  { id: 7, color: "Yellow", cities: 0, slots: [] },
  { id: 8, color: "Yellow", cities: 0, slots: [] },
  { id: 9, color: "Yellow", cities: 0, slots: [] },
  { id: 57, color: "Yellow", cities: 1, slots: [1] },
  { id: 55, color: "Yellow", cities: 0, slots: [] },
  { id: 56, color: "Yellow", cities: 0, slots: [] },
  { id: 69, color: "Yellow", cities: 0, slots: [] },
  // Green: 14 and 15 are the two-station single cities; 54 and 59 are the double cities.
  { id: 14, color: "Green", cities: 1, slots: [2] },
  { id: 15, color: "Green", cities: 1, slots: [2] },
  { id: 54, color: "Green", cities: 2, slots: [1, 1] },
  { id: 59, color: "Green", cities: 2, slots: [1, 1] },
  // Brown: 62 is the two-station double city; 63 the six-spoke two-station hub; 64-68 the double cities.
  { id: 62, color: "Brown", cities: 2, slots: [2, 2] },
  { id: 63, color: "Brown", cities: 1, slots: [2] },
  { id: 64, color: "Brown", cities: 2, slots: [1, 1] },
  { id: 65, color: "Brown", cities: 2, slots: [1, 1] },
  { id: 66, color: "Brown", cities: 2, slots: [1, 1] },
  { id: 67, color: "Brown", cities: 2, slots: [1, 1] },
  { id: 68, color: "Brown", cities: 2, slots: [1, 1] },
];

describe("every numbered tile is the tile that number means", () => {
  it("agrees with the rules catalog on colour", () => {
    const wrong: string[] = [];
    for (const row of CANONICAL) {
      const entry = TILE_CATALOG_BY_ID.get(row.id);
      if (!entry) {
        wrong.push(`${row.id}: absent from TILE_CATALOG`);
      } else if (entry.color !== row.color) {
        wrong.push(`${row.id}: ${entry.color}, canonically ${row.color}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("agrees with the ARTWORK on how many cities and stations it draws", () => {
    /* The second, independent source. `TILE_CATALOG` is the mirror of the contract's own array and
       `TILE_GRAPHICS_CATALOG` is hand-drawn -- so a renumbering would have to be made twice, consistently, to
       pass both this and the colour check above. */
    const wrong: string[] = [];
    for (const row of CANONICAL) {
      const slots = tileCitySlotCounts(row.id);
      if (slots.length !== row.cities || slots.join(",") !== row.slots.join(",")) {
        wrong.push(`${row.id}: draws [${slots.join(",")}], canonically [${row.slots.join(",")}]`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps 15 and 59 distinct, which is the confusion this note came from", () => {
    /* One green city with two stations, versus two green cities with one each. Same tier, opposite shapes, and
       a debug string equated them for long enough to be reported. */
    expect(tileCitySlotCounts(15)).toEqual([2]);
    expect(tileCitySlotCounts(59)).toEqual([1, 1]);
    expect(TILE_CATALOG_BY_ID.get(15)?.terrain).toBe("MajorCityHub");
    expect(TILE_CATALOG_BY_ID.get(59)?.terrain).toBe("DoubleCityHub");
  });
});

describe("the description a developer reads is a description", () => {
  it("no longer carries internal symbols or a changelog", () => {
    /* #709: the string was "Preprinted YELLOW OO double-city (OO_DESIGNATED_HEXES) — Tile Selection Catalog
       verification pass: now strictly requires ... rejecting an ordinary MajorCityHub tile here". A reader
       cannot look up `OO_DESIGNATED_HEXES`, and a reader who can does not need to be told. */
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { describeHexDesignationForLog } = require("./hexGeometry");
    const oo = STATIC_BOARD_HEXES.find((hex) => YELLOW_OO_HEXES.has(hex.label))!;
    const described = describeHexDesignationForLog(oo.q, oo.r).designation as string;

    expect(described).toBe("Preprinted yellow double city — upgrades to tile 59");
    expect(described).not.toMatch(/_HEXES|verification pass|Catalog/);
  });
});
