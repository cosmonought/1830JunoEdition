// frontend/src/components/hexBoardDataPlus.ts
//
// The Project 18XX+ expansion board -- design note #1300.
//
// ==================================================================
//  DESIGN NOTE 1301: THE EXPANSION IS A DELTA, WRITTEN IN THE SPEC'S OWN EDGE NUMBERS
// ==================================================================
//
// REQUESTED, verbatim: "The 1830 map stays the same except as indicated below." So this file is exactly
// that sentence as code: it starts from `STANDARD_BOARD` and applies the listed changes, and nothing else. A
// hex the spec does not name is the standard board's hex, by construction rather than by copying.
//
// TWO EDGE CONVENTIONS MEET HERE, and the seam is explicit. The spec numbers edges clockwise from the
// north-east -- 0 NE, 1 E, 2 SE, 3 SW, 4 W, 5 NW. The board's own tables (`hexBoardData.ts` design note #1)
// number them counter-clockwise from the east -- 0 E, 1 NE, 2 NW, 3 W, 4 SW, 5 SE. The two are mirror
// images: `code = (1 - spec) mod 6`. Every edge below is written in the SPEC's numbers and passed through
// `edge()`, so each entry can be read against the request line by line, and the translation exists in one
// place with one test (`expandedBoard.test.ts`) that checks it against a hand-derived neighbour.
//
// THE AXIAL COORDINATE IS DERIVED, NOT TYPED. `q = (column - 1 - row) / 2`, `r = row` (A = 0) -- the same
// relation every existing entry satisfies (A9 -> (4, 0), D2 -> (-1, 3), K13 -> (1, 10)). Deriving it is
// what makes rows L and M certain to sit where the geometry expects them.
//
// WHAT IS DELIBERATELY NOT HERE:
//   PRR's herald at H12 ($10, PRR only, never blocks) is a RULE about a corporation, not a property of a
//   hex, and lives with the route rules. The hex itself carries the printed green tile.
//   The tile tray is unchanged -- the request specified no tray changes.

import {
  STANDARD_BOARD,
  type BoardDefinition,
  type BoardHex,
  type GrayHexTrack,
} from "./hexBoardData";
import type { PrintedArtwork } from "./TileGraphics";

/** A spec-convention edge (0 NE, clockwise) as the board's own edge index (0 E, counter-clockwise). */
export function edge(spec: number): number {
  return (((1 - spec) % 6) + 6) % 6;
}

/** Axial coordinate of a board label such as `"L16"`. */
export function axialOf(label: string): { q: number; r: number } {
  const r = label.charCodeAt(0) - "A".charCodeAt(0);
  const column = Number(label.slice(1));
  const twiceQ = column - 1 - r;
  if (twiceQ % 2 !== 0) throw new Error(`${label} is not a hex on this grid`);
  return { q: twiceQ / 2, r };
}

export function hex(label: string, rest: Omit<BoardHex, "label" | "q" | "r">): BoardHex {
  return { label, ...axialOf(label), ...rest };
}

/* ---- the hex list ---------------------------------------------------- */

/** Labels the expansion removes outright. I1 is the only one: the Gulf moves down to K1/L2 as Chattanooga. */
const REMOVED: readonly string[] = ["I1"];

/** Hexes the expansion changes or adds, keyed by label; an entry REPLACES the standard hex of that label. */
const CHANGED: readonly BoardHex[] = [
  // A19 Montreal: still gray, now a two-slot city -- see `GRAY` and the artwork below.
  // B20: Plattsburgh and Burlington, a double town. CSL's power is keyed on the hex and is unchanged.
  hex("B20", { type: "Plain", townDesignation: "double" }),
  // H12: a printed GREEN tile #24 (W to E, W to SE) that later phases may upgrade. Not a city. PRR's herald
  // sits above the track at $10 -- design note #1302 for what that means to PRR and to nobody else.
  hex("H12", { type: "Plain", printedTile: { tileId: 24, orientation: 3 }, herald: { companyId: 1, revenue: 10 } }),
  hex("I9", { type: "River" }),
  hex("J2", { type: "River" }),
  hex("J4", { type: "River" }),
  hex("J6", { type: "River" }),
  hex("J8", { type: "River" }),
  hex("J16", { type: "River" }),
  hex("J18", { type: "River" }),
  hex("K1", { type: "RedOffboard" }), // Chattanooga (1/2)
  hex("K3", { type: "Plain", cityDesignation: true }), // Lexington
  hex("K5", { type: "Plain" }),
  hex("K7", { type: "Mountain", cityDesignation: true, feeOverride: 80 }), // Huntington
  hex("K9", { type: "Mountain" }),
  hex("K11", { type: "Mountain" }),
  hex("K13", { type: "Plain", cityDesignation: true }), // Richmond (was the Deep South red area)
  hex("K15", { type: "River" }), // was gray Richmond
  hex("K17", { type: "River" }),
  hex("L2", { type: "RedOffboard" }), // Chattanooga (2/2)
  hex("L4", { type: "Plain" }),
  hex("L6", { type: "Mountain" }),
  hex("L8", { type: "Mountain" }),
  hex("L10", { type: "Mountain" }),
  hex("L12", { type: "Plain" }),
  hex("L14", { type: "Plain" }),
  hex("L16", { type: "Plain", printedColor: "Gray" }), // Norfolk
  // Row M (design note #1313, the corrections pass): two more hexes west of the Deep South.
  hex("M9", { type: "Mountain" }),
  hex("M11", { type: "Plain" }),
  hex("M13", { type: "RedOffboard" }), // Deep South
];

const EXPANDED_HEXES: readonly BoardHex[] = (() => {
  const byLabel = new Map(STANDARD_BOARD.hexes.map((entry) => [entry.label, entry] as const));
  REMOVED.forEach((label) => byLabel.delete(label));
  CHANGED.forEach((entry) => byLabel.set(entry.label, entry));
  // Row-major, then by column -- the order the standard list is written in, so a diff of the two reads.
  return Array.from(byLabel.values()).sort((a, b) => a.r - b.r || a.q - b.q);
})();

/* ---- gray track -------------------------------------------------------- */

const PLUS_GRAY: Readonly<Record<string, GrayHexTrack>> = (() => {
  const { H12: _altoona, K15: _richmond, ...kept } = STANDARD_BOARD.grayHexes;
  return {
    ...kept,
    // Tile-39 connectivity: E, SE and SW, each pair joined.
    A17: { edges: [edge(1), edge(2), edge(3)], marker: "none" },
    // Montreal: ONE station (#1401, with Norfolk: "a preprinted gray single-station city"), SE, SW and W.
    A19: { edges: [edge(2), edge(3), edge(4)], marker: "city" },
    // Atlantic City: a town with track to NW, W and SW (SW is new: J18 now exists).
    I19: { edges: [edge(5), edge(4), edge(3)], marker: "town" },
    // Norfolk: ONE station (#1401: "It is a single-station city"), track to W, NW and NE.
    L16: { edges: [edge(4), edge(5), edge(0)], marker: "city" },
  };
})();

/* ---- red off-board areas ----------------------------------------------- */

const PLUS_OFFBOARD_LABELS: Readonly<Record<string, string>> = (() => {
  const { I1: _i1, J2: _j2, K13: _k13, ...kept } = STANDARD_BOARD.offboardLabels;
  return { ...kept, K1: "Chattanooga", L2: "Chattanooga", M13: "Deep South" };
})();

const PLUS_OFFBOARD_TRACKS: Readonly<Record<string, readonly number[]>> = (() => {
  const { I1: _i1, J2: _j2, K13: _k13, ...kept } = STANDARD_BOARD.offboardTracks;
  return {
    ...kept,
    // "same track connections" as the Gulf it replaces: I1 [E] -> K1 [E] (K3); J2 [E, NE] -> L2 [E, NE] (L4, K3).
    K1: [edge(1)],
    L2: [edge(1), edge(0)],
    // Deep South: separate stubs to NW (L12), NE (L14) and -- #1313 -- W (M11).
    M13: [edge(5), edge(0), edge(4)],
  };
})();

const PLUS_OFFBOARD_HIDDEN_EDGES: Readonly<Record<string, number>> = (() => {
  const { I1: _i1, J2: _j2, ...kept } = STANDARD_BOARD.offboardHiddenEdges;
  // K1 (-5, 10) and L2 (-5, 11) share K1's SE edge / L2's NW edge, exactly as I1/J2 did.
  return { ...kept, K1: edge(2), L2: edge(5) };
})();

const PLUS_OFFBOARD_REVENUE = (() => {
  const { Gulf: gulf, ...kept } = STANDARD_BOARD.offboardRevenue;
  return { ...kept, Chattanooga: gulf }; // "same revenue values"
})();

/* ---- names and printed values ------------------------------------------ */

const PLUS_NAMED_HEX_LABELS: Readonly<Record<string, string>> = (() => {
  const { H12: _altoona, K15: _richmond, ...kept } = STANDARD_BOARD.namedHexLabels;
  return {
    ...kept,
    H16: "Reading",
    // #1313: Reading moved to H16, so the double town beside Allentown takes its other name.
    G17: "Bethlehem & Allentown",
    B20: "Plattsburgh & Burlington",
    K3: "Lexington",
    K7: "Huntington",
    K13: "Richmond",
    L16: "Norfolk",
  };
})();

const PLUS_START_VALUE_OVERRIDE: Readonly<Record<string, number>> = (() => {
  // H12's $10 is PRR's alone now (route rules); K15 is water. The new blank cities are $0 like every other.
  const { H12: _altoona, K15: _richmond, ...kept } = STANDARD_BOARD.startValueOverride;
  return { ...kept, K3: 0, K7: 0, K13: 0 };
})();

/* ---- printed artwork ----------------------------------------------------- */

/* The six edge midpoints of the unit hex, indexed by the board's own edge numbers -- the same six numbers
   `TileGraphics.UNIT_EDGE_POINTS` is authored against (it is not exported, and this file must not grow a
   runtime import of the renderer). */
const P: ReadonlyArray<readonly [number, number]> = [
  [0.866025, 0], // 0 E
  [0.433013, -0.75], // 1 NE
  [-0.433013, -0.75], // 2 NW
  [-0.866025, 0], // 3 W
  [-0.433013, 0.75], // 4 SW
  [0.433013, 0.75], // 5 SE
];
const f = (n: number) => Number(n.toFixed(6));
const pt = (x: number, y: number) => `${f(x)} ${f(y)}`;

/** A curve between two edges, in the catalog's own shape: control points are the endpoints scaled toward
 *  the centre -- 0.5556 for a sharp (60 degree) curve, 0.3812 for a gentle (120 degree) one. Straight across
 *  is a line. The constants are those every hand-authored entry in `BASE_PRINTED_ARTWORK` uses. */
export function curve(a: number, b: number): string {
  const [ax, ay] = P[a];
  const [bx, by] = P[b];
  const separation = ((b - a) % 6 + 6) % 6;
  if (separation === 3) return `M ${pt(ax, ay)} L ${pt(bx, by)}`;
  const k = separation === 1 || separation === 5 ? 0.5556 : 0.3812;
  return `M ${pt(ax, ay)} C ${pt(ax * k, ay * k)} ${pt(bx * k, by * k)} ${pt(bx, by)}`;
}

/** A straight spoke from an edge to the centre, where a station sits. */
export function spoke(a: number): string {
  const [ax, ay] = P[a];
  return `M ${pt(ax, ay)} L 0 0`;
}

const PLUS_PRINTED_ARTWORK: Readonly<Record<string, PrintedArtwork>> = {
  A17: {
    tracks: [curve(edge(1), edge(2)), curve(edge(2), edge(3)), curve(edge(1), edge(3))],
  },
  A19: {
    tracks: [spoke(edge(2)), spoke(edge(3)), spoke(edge(4))],
    // #1401: a single station, like Norfolk -- the pill and its angle are gone with the second slot.
    marker: { kind: "city", at: { x: 0, y: 0 } },
  },
  I19: {
    tracks: [spoke(edge(5)), spoke(edge(4)), spoke(edge(3))],
    marker: { kind: "town", at: { x: 0, y: 0 } },
  },
  L16: {
    tracks: [spoke(edge(4)), spoke(edge(5)), spoke(edge(0))],
    // #1401: a single station, so N&W's home token seats in the one circle rather than a pill's first cap.
    marker: { kind: "city", at: { x: 0, y: 0 } },
  },
};

export const EXPANDED_BOARD: BoardDefinition = {
  ...STANDARD_BOARD,
  id: "expanded",
  hexes: EXPANDED_HEXES,
  grayHexes: PLUS_GRAY,
  offboardLabels: PLUS_OFFBOARD_LABELS,
  offboardTracks: PLUS_OFFBOARD_TRACKS,
  offboardHiddenEdges: PLUS_OFFBOARD_HIDDEN_EDGES,
  offboardRevenue: PLUS_OFFBOARD_REVENUE,
  namedHexLabels: PLUS_NAMED_HEX_LABELS,
  // Design note #1317: Toronto (D10) is printed TO and takes only the TO tiles (#810, #882).
  torontoHexes: new Set(["D10"]),
  startValueOverride: PLUS_START_VALUE_OVERRIDE,
  printedArtwork: PLUS_PRINTED_ARTWORK,
};
